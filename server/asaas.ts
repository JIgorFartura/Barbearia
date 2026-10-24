import crypto from 'node:crypto';
import { cancelInvoice, invoice, markInvoicePaid, type InvoiceView } from './billing.js';
import { all, get, run, tx } from './db.js';
import { platformCardReady } from './cardSettings.js';
import { recordGatewayPayment } from './gatewayPayments.js';
import { HttpError } from './http.js';
import { localNow } from './time.js';

/**
 * Asaas da plataforma (opcional). Cada mensalidade vira uma cobrança que a barbearia paga com PIX
 * (QR Code na tela), cartão ou boleto; quando o pagamento cai, o Asaas avisa (webhook) e a fatura é
 * baixada sozinha, liberando o acesso. Com a nota fiscal ligada, o Asaas emite a NFS-e de cada
 * mensalidade paga. Com o cartão pela Cielo ligado (taxa menor e cobrança automática todo mês), o
 * Asaas fica só com o PIX.
 * Sem Asaas configurado, continua o PIX estático do master com confirmação manual.
 */

export type AsaasEnv = 'sandbox' | 'production';

export interface AsaasSettings {
  env: AsaasEnv;
  apiKey: string;
  /** Token que o Asaas manda no cabeçalho asaas-access-token de cada aviso (webhook). */
  webhookToken: string;
  nfse: { enabled: boolean; serviceName: string; serviceCode: string; iss: number; observations: string };
  /** Quando chegou o último aviso válido do Asaas (mostra que o webhook está ligado). */
  webhookAt: string | null;
}

const BASE: Record<AsaasEnv, string> = { sandbox: 'https://api-sandbox.asaas.com/v3', production: 'https://api.asaas.com/v3' };

/** Nos testes, troca-se a função que fala com o Asaas. */
export const asaasHttp = { fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch };

const KEYS = [
  'asaas_env',
  'asaas_api_key',
  'asaas_webhook_token',
  'nfse_enabled',
  'nfse_service_name',
  'nfse_service_code',
  'nfse_iss',
  'nfse_observations',
  'asaas_webhook_at',
];

export function asaasSettings(): AsaasSettings {
  const rows = all<{ key: string; value: string }>(`SELECT key, value FROM platform_settings WHERE key IN (${KEYS.map(() => '?').join(', ')})`, KEYS);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    env: m.asaas_env === 'production' ? 'production' : 'sandbox',
    apiKey: m.asaas_api_key ?? '',
    webhookToken: m.asaas_webhook_token ?? '',
    nfse: {
      enabled: m.nfse_enabled === '1',
      serviceName: m.nfse_service_name ?? '',
      serviceCode: m.nfse_service_code ?? '',
      iss: Number(m.nfse_iss ?? 0),
      observations: m.nfse_observations ?? '',
    },
    webhookAt: m.asaas_webhook_at ?? null,
  };
}

const setKey = (key: string, value: string) =>
  run('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);

export function saveAsaasSettings(s: { env: AsaasEnv; apiKey?: string | null; nfse: AsaasSettings['nfse'] }): AsaasSettings {
  tx(() => {
    setKey('asaas_env', s.env);
    // Chave em branco = mantém a atual (a tela nunca recebe a chave de volta).
    if (s.apiKey != null) setKey('asaas_api_key', s.apiKey.trim());
    if (!asaasSettings().webhookToken) setKey('asaas_webhook_token', crypto.randomBytes(24).toString('base64url'));
    setKey('nfse_enabled', s.nfse.enabled ? '1' : '0');
    setKey('nfse_service_name', s.nfse.serviceName);
    setKey('nfse_service_code', s.nfse.serviceCode);
    setKey('nfse_iss', String(s.nfse.iss));
    setKey('nfse_observations', s.nfse.observations);
  });
  return asaasSettings();
}

export const asaasEnabled = () => Boolean(asaasSettings().apiKey);

/** Chegou um aviso válido do Asaas. */
export const markWebhookSeen = () => setKey('asaas_webhook_at', new Date().toISOString());

/** Novo token do webhook (o master atualiza no Asaas). */
export function rotateWebhookToken(): string {
  const token = crypto.randomBytes(24).toString('base64url');
  setKey('asaas_webhook_token', token);
  return token;
}

export class AsaasError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function asaasCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const s = asaasSettings();
  if (!s.apiKey) throw new AsaasError('Asaas não configurado.', 0);
  let res: Response;
  try {
    // ASAAS_BASE_URL aponta para um servidor de testes (ex.: um simulador local).
    res = await asaasHttp.fetch(`${process.env.ASAAS_BASE_URL || BASE[s.env]}${path}`, {
      method,
      headers: { 'content-type': 'application/json', access_token: s.apiKey, 'user-agent': 'SistemaBarbearia/1.0' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AsaasError(`Sem resposta do Asaas: ${(err as Error).message}`, 0);
  }
  const text = await res.text();
  let data: { errors?: { description?: string }[] } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* resposta sem JSON */
  }
  if (!res.ok) {
    const detail = data?.errors?.map((e) => e.description).filter(Boolean).join(' ');
    throw new AsaasError(detail || (res.status === 401 ? 'Chave de API do Asaas recusada.' : `Asaas respondeu ${res.status}.`), res.status);
  }
  return data as T;
}

/** Confere a chave (lista um cliente qualquer). */
export async function testAsaas(): Promise<void> {
  await asaasCall('GET', '/customers?limit=1');
}

// ---------- cobrança de cada fatura

interface ShopFiscal {
  id: number;
  name: string;
  billing_document: string | null;
  billing_name: string | null;
  billing_email: string | null;
  asaas_customer_id: string | null;
}

/** Cliente da barbearia no Asaas (criado na primeira cobrança). */
async function ensureCustomer(shopId: number): Promise<string> {
  const s = get<ShopFiscal>('SELECT id, name, billing_document, billing_name, billing_email, asaas_customer_id FROM barbershops WHERE id = ?', [shopId]);
  if (!s) throw new HttpError(404, 'Barbearia não encontrada.');
  if (s.asaas_customer_id) return s.asaas_customer_id;
  if (!s.billing_document) throw new AsaasError('Falta o CPF ou CNPJ da barbearia (o dono informa na tela Mensalidade).', 0);
  const owner = get<{ email: string | null; phone: string | null }>("SELECT email, phone FROM users WHERE barbershop_id = ? AND role = 'owner' ORDER BY id LIMIT 1", [shopId]);
  const c = await asaasCall<{ id: string }>('POST', '/customers', {
    name: s.billing_name || s.name,
    cpfCnpj: s.billing_document,
    email: s.billing_email || owner?.email || undefined,
    mobilePhone: owner?.phone || undefined,
    externalReference: `barbearia:${shopId}`,
    // Os avisos vão pelo WhatsApp da plataforma (e-mail/SMS do Asaas podem ter custo).
    notificationDisabled: true,
  });
  run('UPDATE barbershops SET asaas_customer_id = ? WHERE id = ?', [c.id, shopId]);
  return c.id;
}

const inFlight = new Set<number>();

/**
 * Cria no Asaas a cobrança da fatura (uma vez) e guarda o QR Code do PIX. A barbearia escolhe como
 * pagar na página do Asaas: PIX, cartão de crédito ou boleto. Erros ficam na fatura.
 */
export async function chargeInvoice(invoiceId: number): Promise<boolean> {
  if (!asaasEnabled() || inFlight.has(invoiceId)) return false;
  const inv = get<{ id: number; barbershop_id: number; status: string; amount_cents: number; due_date: string; description: string; asaas_payment_id: string | null }>(
    'SELECT id, barbershop_id, status, amount_cents, due_date, description, asaas_payment_id FROM invoices WHERE id = ?',
    [invoiceId],
  );
  if (!inv || inv.status !== 'open') return false;
  inFlight.add(invoiceId);
  try {
    let paymentId = inv.asaas_payment_id;
    if (!paymentId) {
      const customer = await ensureCustomer(inv.barbershop_id);
      const today = localNow().date;
      const p = await asaasCall<{ id: string; invoiceUrl: string | null }>('POST', '/payments', {
        customer,
        // Indefinida: na página do Asaas a barbearia escolhe PIX, cartão ou boleto. Com o cartão pela
        // Cielo (mais barato e automático), o Asaas fica só com o PIX.
        billingType: platformCardReady() ? 'PIX' : 'UNDEFINED',
        value: inv.amount_cents / 100,
        // O Asaas não aceita vencimento no passado (fatura já vencida vence hoje).
        dueDate: inv.due_date < today ? today : inv.due_date,
        description: inv.description,
        externalReference: `fatura:${inv.id}`,
      });
      paymentId = p.id;
      run('UPDATE invoices SET asaas_payment_id = ?, asaas_invoice_url = ?, asaas_error = NULL WHERE id = ?', [p.id, p.invoiceUrl ?? null, inv.id]);
      recordGatewayPayment({
        externalId: p.id,
        shopId: inv.barbershop_id,
        kind: 'mensalidade',
        invoiceId: inv.id,
        valueCents: inv.amount_cents,
        method: 'UNDEFINED',
        invoiceUrl: p.invoiceUrl ?? null,
      });
    }
    const qr = await asaasCall<{ encodedImage: string; payload: string }>('GET', `/payments/${paymentId}/pixQrCode`);
    run('UPDATE invoices SET asaas_pix_payload = ?, asaas_pix_qr = ?, asaas_error = NULL WHERE id = ?', [qr.payload, `data:image/png;base64,${qr.encodedImage}`, inv.id]);
    return true;
  } catch (err) {
    run('UPDATE invoices SET asaas_error = ? WHERE id = ?', [(err as Error).message.slice(0, 300), inv.id]);
    if (!(err instanceof AsaasError)) console.error('[asaas]', err);
    return false;
  } finally {
    inFlight.delete(invoiceId);
  }
}

/** Faturas em aberto ainda sem cobrança no Asaas (roda de hora em hora). */
export async function syncAsaasCharges(limit = 20): Promise<number> {
  if (!asaasEnabled()) return 0;
  const pending = all<{ id: number }>(
    `SELECT i.id FROM invoices i JOIN barbershops b ON b.id = i.barbershop_id
      WHERE i.status = 'open' AND (i.asaas_payment_id IS NULL OR i.asaas_pix_payload IS NULL) AND b.billing_document IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM card_links l WHERE l.receiver = 'platform' AND l.barbershop_id = i.barbershop_id AND l.kind = 'mensalidade' AND l.status = 'active')
      ORDER BY i.due_date LIMIT ?`,
    [limit],
  );
  let created = 0;
  for (const { id } of pending) if (await chargeInvoice(id)) created++;
  return created;
}

/**
 * Cobrança do Asaas para a tela da mensalidade (cria na hora, se ainda não existe): o QR Code do PIX
 * e o link da página do Asaas, onde a barbearia também pode pagar com cartão ou boleto.
 */
export async function asaasPix(
  inv: InvoiceView,
): Promise<{ payload: string | null; qr: string | null; url: string | null } | { error: string } | null> {
  if (!asaasEnabled() || inv.status !== 'open') return null;
  const read = () =>
    get<{ asaas_pix_payload: string | null; asaas_pix_qr: string | null; asaas_invoice_url: string | null; asaas_error: string | null }>(
      'SELECT asaas_pix_payload, asaas_pix_qr, asaas_invoice_url, asaas_error FROM invoices WHERE id = ?',
      [inv.id],
    )!;
  let r = read();
  if (!r.asaas_pix_payload) {
    await chargeInvoice(inv.id);
    r = read();
  }
  if (r.asaas_pix_payload || r.asaas_invoice_url) return { payload: r.asaas_pix_payload, qr: r.asaas_pix_qr, url: r.asaas_invoice_url };
  return { error: r.asaas_error ?? 'Cobrança ainda não disponível.' };
}

// ---------- baixa automática (webhook) e nota fiscal

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export interface AsaasPayment {
  id?: string;
  status?: string;
  billingType?: string;
  value?: number;
  netValue?: number | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
}

const PAID_METHOD: Record<string, string> = { BOLETO: 'boleto', CREDIT_CARD: 'cartao', DEBIT_CARD: 'cartao', PIX: 'pix' };

/** Mensalidade paga pelo Asaas: baixa a fatura (e pede a nota fiscal, se ligada). */
export function invoicePaidByAsaas(invoiceId: number, p: AsaasPayment): { ok: true; invoiceId: number; note?: string } {
  const inv = get<{ id: number; status: string }>('SELECT id, status FROM invoices WHERE id = ?', [invoiceId])!;
  if (inv.status !== 'open') return { ok: true, invoiceId: inv.id, note: `fatura ${inv.status}` };
  const paidAt = (p.confirmedDate ?? p.paymentDate ?? p.clientPaymentDate ?? localNow().date).slice(0, 10);
  markInvoicePaid(inv.id, { paid_at: paidAt, method: PAID_METHOD[p.billingType ?? ''] ?? 'pix', notes: 'Baixa automática pelo Asaas.' });
  if (asaasSettings().nfse.enabled) void issueNfse(inv.id);
  return { ok: true, invoiceId: inv.id };
}

/** Pede ao Asaas a nota fiscal (NFS-e) da mensalidade paga. Erros ficam na fatura para o master ver. */
export async function issueNfse(invoiceId: number): Promise<boolean> {
  const s = asaasSettings();
  const inv = get<{ id: number; barbershop_id: number; description: string; amount_cents: number; asaas_payment_id: string | null; nfse_id: string | null; status: string }>(
    'SELECT id, barbershop_id, description, amount_cents, asaas_payment_id, nfse_id, status FROM invoices WHERE id = ?',
    [invoiceId],
  );
  if (!s.nfse.enabled || !asaasEnabled() || !inv || inv.status !== 'paid' || inv.nfse_id) return false;
  try {
    // Paga pelo Asaas: a nota fica ligada à cobrança. Paga de outro jeito (cartão pela Cielo, PIX do
    // master): nota avulsa no cadastro da barbearia no Asaas.
    const target = inv.asaas_payment_id ? { payment: inv.asaas_payment_id } : { customer: await ensureCustomer(inv.barbershop_id) };
    const nf = await asaasCall<{ id: string; status: string }>('POST', '/invoices', {
      ...target,
      serviceDescription: inv.description,
      observations: s.nfse.observations || 'Mensalidade do sistema de gestão para barbearias.',
      value: inv.amount_cents / 100,
      deductions: 0,
      effectiveDate: localNow().date,
      municipalServiceCode: s.nfse.serviceCode || undefined,
      municipalServiceName: s.nfse.serviceName,
      taxes: { retainIss: false, iss: s.nfse.iss, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 },
    });
    run('UPDATE invoices SET nfse_id = ?, nfse_status = ?, nfse_error = NULL WHERE id = ?', [nf.id, nf.status, invoiceId]);
    return true;
  } catch (err) {
    run('UPDATE invoices SET nfse_error = ? WHERE id = ?', [(err as Error).message.slice(0, 300), invoiceId]);
    return false;
  }
}

/** Master baixou à mão (pagou por outro meio): dá baixa também no Asaas, para o cliente não pagar duas vezes. */
export async function syncManualPayment(invoiceId: number): Promise<void> {
  const inv = get<{ asaas_payment_id: string | null; amount_cents: number; paid_at: string | null }>('SELECT asaas_payment_id, amount_cents, paid_at FROM invoices WHERE id = ?', [
    invoiceId,
  ]);
  if (!inv || !asaasEnabled()) return;
  if (inv.asaas_payment_id) {
    try {
      await asaasCall('POST', `/payments/${inv.asaas_payment_id}/receiveInCash`, { paymentDate: inv.paid_at ?? localNow().date, value: inv.amount_cents / 100, notifyCustomer: false });
    } catch (err) {
      run('UPDATE invoices SET asaas_error = ? WHERE id = ?', [`Baixa no Asaas: ${(err as Error).message}`.slice(0, 300), invoiceId]);
    }
  }
  if (asaasSettings().nfse.enabled) await issueNfse(invoiceId);
}

/** Fatura cancelada (ou paga no cartão pela Cielo): remove a cobrança no Asaas. Devolve se removeu. */
export async function cancelAsaasCharge(invoiceId: number): Promise<boolean> {
  const inv = get<{ asaas_payment_id: string | null }>('SELECT asaas_payment_id FROM invoices WHERE id = ?', [invoiceId]);
  if (!inv?.asaas_payment_id || !asaasEnabled()) return false;
  try {
    await asaasCall('DELETE', `/payments/${inv.asaas_payment_id}`);
    run("UPDATE gateway_payments SET status = 'DELETED', updated_at = ? WHERE external_id = ? AND status IN ('PENDING', 'OVERDUE')", [
      new Date().toISOString(),
      inv.asaas_payment_id,
    ]);
    return true;
  } catch (err) {
    run('UPDATE invoices SET asaas_error = ? WHERE id = ?', [`Cancelar no Asaas: ${(err as Error).message}`.slice(0, 300), invoiceId]);
    return false;
  }
}

/** Cancela a fatura aqui e no Asaas. */
export async function cancelInvoiceEverywhere(invoiceId: number): Promise<InvoiceView> {
  const inv = cancelInvoice(invoiceId);
  await cancelAsaasCharge(invoiceId);
  return invoice(inv.id);
}
