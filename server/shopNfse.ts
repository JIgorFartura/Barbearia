import { AsaasError } from './asaas.js';
import { shopNow } from './clock.js';
import { all, get, run } from './db.js';
import { HttpError } from './http.js';
import { ensureCustomer, saveCustomerCpf, shopAsaasCall, shopAsaasOn } from './shopAsaas.js';

/**
 * Nota fiscal de serviço (NFS-e) para o cliente, emitida pela conta Asaas da própria barbearia (o
 * cadastro fiscal da prefeitura e o certificado ficam no Asaas dela). Vale para os serviços (corte,
 * barba...), não para os produtos. Manual: o dono pede a nota de cada venda; automática: toda venda com
 * serviço de um cliente com CPF e cada mensalidade do clube paga.
 */

export type NfseMode = 'off' | 'manual' | 'auto';

export interface NfseSettings {
  mode: NfseMode;
  serviceName: string;
  serviceCode: string;
  iss: number;
  observations: string;
}

export function nfseSettings(shopId: number): NfseSettings {
  const s = get<{ nfse_mode: string; nfse_service_name: string | null; nfse_service_code: string | null; nfse_iss: number; nfse_observations: string | null }>(
    'SELECT nfse_mode, nfse_service_name, nfse_service_code, nfse_iss, nfse_observations FROM barbershops WHERE id = ?',
    [shopId],
  )!;
  return {
    mode: (['manual', 'auto'].includes(s.nfse_mode) ? s.nfse_mode : 'off') as NfseMode,
    serviceName: s.nfse_service_name ?? 'Serviços de barbearia',
    serviceCode: s.nfse_service_code ?? '',
    iss: s.nfse_iss,
    observations: s.nfse_observations ?? '',
  };
}

export function saveNfseSettings(shopId: number, s: NfseSettings): void {
  if (s.mode !== 'off' && !shopAsaasOn(shopId)) throw new HttpError(409, 'Ligue antes a sua conta Asaas (PIX com baixa automática): é ela que emite a nota.');
  run('UPDATE barbershops SET nfse_mode = ?, nfse_service_name = ?, nfse_service_code = ?, nfse_iss = ?, nfse_observations = ? WHERE id = ?', [
    s.mode,
    s.serviceName.trim() || 'Serviços de barbearia',
    s.serviceCode.trim() || null,
    s.iss,
    s.observations.trim() || null,
    shopId,
  ]);
}

/** O valor dos serviços da venda (o desconto dividido entre os itens; pelo clube ou pacote é R$ 0). */
export function saleServices(saleId: number): { value: number; names: string } {
  const sale = get<{ subtotal_cents: number; total_cents: number }>('SELECT subtotal_cents, total_cents FROM sales WHERE id = ?', [saleId])!;
  const items = all<{ name: string; qty: number; total_cents: number }>("SELECT name, qty, total_cents FROM sale_items WHERE sale_id = ? AND kind = 'service' AND total_cents > 0", [saleId]);
  const gross = items.reduce((s, i) => s + i.total_cents, 0);
  const value = sale.subtotal_cents ? Math.round((gross * sale.total_cents) / sale.subtotal_cents) : 0;
  return { value, names: items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(', ') };
}

function invoiceBody(shopId: number, target: Record<string, string>, description: string, valueCents: number) {
  const s = nfseSettings(shopId);
  return {
    ...target,
    serviceDescription: description,
    observations: s.observations || undefined,
    value: valueCents / 100,
    deductions: 0,
    effectiveDate: shopNow(shopId).date,
    municipalServiceCode: s.serviceCode || undefined,
    municipalServiceName: s.serviceName,
    taxes: { retainIss: false, iss: s.iss, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 },
  };
}

/** Pede a nota da venda (com o CPF informado agora, se o cliente ainda não tinha). Erros ficam na venda. */
export async function issueSaleNfse(shopId: number, saleId: number, opts: { cpf?: string | null } = {}): Promise<{ ok: boolean; error?: string; status?: number }> {
  const sale = get<{ id: number; status: string; customer_id: number | null; nfse_id: string | null }>(
    'SELECT id, status, customer_id, nfse_id FROM sales WHERE id = ? AND barbershop_id = ?',
    [saleId, shopId],
  );
  if (!sale) throw new HttpError(404, 'Venda não encontrada.');
  if (nfseSettings(shopId).mode === 'off' || !shopAsaasOn(shopId)) throw new HttpError(409, 'A nota fiscal está desligada (Clube de assinatura → PIX com baixa automática).');
  if (sale.status !== 'closed') throw new HttpError(409, 'Venda cancelada não tem nota.');
  if (sale.nfse_id) return { ok: true };
  const { value, names } = saleServices(saleId);
  if (value <= 0) throw new HttpError(409, 'Essa venda não tem serviço cobrado (produto não entra na nota de serviço).');
  if (!sale.customer_id) throw new HttpError(409, 'A nota precisa do cliente: registre a venda com o cliente.');
  if (opts.cpf) saveCustomerCpf(shopId, sale.customer_id, opts.cpf);
  try {
    const customer = await ensureCustomer(shopId, sale.customer_id);
    if (!customer) throw new HttpError(409, 'Falta o CPF do cliente para a nota.');
    const nf = await shopAsaasCall<{ id: string; status: string }>(shopId, 'POST', '/invoices', invoiceBody(shopId, { customer }, names, value));
    run('UPDATE sales SET nfse_id = ?, nfse_status = ?, nfse_error = NULL WHERE id = ?', [nf.id, nf.status, saleId]);
    return { ok: true };
  } catch (err) {
    const message = err instanceof AsaasError || err instanceof HttpError ? err.message : 'Erro ao pedir a nota.';
    run('UPDATE sales SET nfse_error = ? WHERE id = ?', [message.slice(0, 300), saleId]);
    if (!(err instanceof AsaasError) && !(err instanceof HttpError)) console.error('[nota fiscal]', err);
    // Falta algo do lado da barbearia (409); o Asaas recusou (502).
    return { ok: false, error: message, status: err instanceof HttpError ? err.status : 502 };
  }
}

/** Nota automática da venda (sem travar a venda). */
export function autoSaleNfse(shopId: number, saleId: number): void {
  if (nfseSettings(shopId).mode !== 'auto' || !shopAsaasOn(shopId)) return;
  const sale = get<{ customer_id: number | null }>('SELECT customer_id FROM sales WHERE id = ?', [saleId]);
  const cpf = sale?.customer_id ? get<{ cpf: string | null }>('SELECT cpf FROM customers WHERE id = ?', [sale.customer_id])?.cpf : null;
  if (!cpf || saleServices(saleId).value <= 0) return;
  void issueSaleNfse(shopId, saleId).catch((err) => console.error('[nota fiscal]', err));
}

/** Nota da mensalidade do clube paga (automática): ligada à cobrança do Asaas, se foi por lá. */
export async function issueChargeNfse(chargeId: number): Promise<boolean> {
  const c = get<{ id: number; barbershop_id: number; customer_id: number; status: string; description: string; amount_cents: number; asaas_payment_id: string | null; nfse_id: string | null }>(
    'SELECT id, barbershop_id, customer_id, status, description, amount_cents, asaas_payment_id, nfse_id FROM charges WHERE id = ?',
    [chargeId],
  );
  if (!c || c.status !== 'paid' || c.nfse_id || nfseSettings(c.barbershop_id).mode !== 'auto' || !shopAsaasOn(c.barbershop_id)) return false;
  try {
    const target = c.asaas_payment_id ? { payment: c.asaas_payment_id } : await ensureCustomer(c.barbershop_id, c.customer_id).then((id) => (id ? { customer: id } : null));
    if (!target) return false;
    const nf = await shopAsaasCall<{ id: string; status: string }>(c.barbershop_id, 'POST', '/invoices', invoiceBody(c.barbershop_id, target, c.description, c.amount_cents));
    run('UPDATE charges SET nfse_id = ?, nfse_status = ?, nfse_error = NULL WHERE id = ?', [nf.id, nf.status, c.id]);
    return true;
  } catch (err) {
    run('UPDATE charges SET nfse_error = ? WHERE id = ?', [(err as Error).message.slice(0, 300), c.id]);
    return false;
  }
}

/** Aviso do Asaas sobre a nota (autorizada, com erro...): guarda a situação e o PDF. */
export function nfseEvent(shopId: number, invoice: { id?: string; status?: string; pdfUrl?: string | null }, event: string): void {
  if (!invoice.id) return;
  for (const table of ['sales', 'charges']) {
    run(`UPDATE ${table} SET nfse_status = ?, nfse_url = COALESCE(?, nfse_url) WHERE barbershop_id = ? AND nfse_id = ?`, [invoice.status ?? event, invoice.pdfUrl ?? null, shopId, invoice.id]);
  }
}
