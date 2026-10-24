import { AsaasError, asaasCall, asaasEnabled, asaasSettings, type AsaasPayment } from './asaas.js';
import { validTaxId } from './billing.js';
import { charge, confirmCharge } from './charges.js';
import { shopNow } from './clock.js';
import { all, get, nowIso, run, tx } from './db.js';
import type { Method } from './finance.js';
import { gatewayPayment, recordGatewayPayment, splitOf, type GatewayPaymentRow } from './gatewayPayments.js';
import { HttpError } from './http.js';

/**
 * Pagamento online dos clientes das barbearias (cartão de crédito e, no clube, também boleto ou PIX)
 * pelo Asaas da plataforma. O valor é repassado na hora do pagamento para a conta Asaas da barbearia
 * (split), descontada a taxa da plataforma, se houver. A confirmação é automática (aviso do Asaas):
 * o dono não precisa conferir nada. O PIX direto na chave da barbearia continua valendo.
 */

/** Carteira do Asaas (walletId) é um UUID. */
const WALLET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OnlineStatus {
  available: boolean;
  /** A plataforma liberou os pagamentos online (Asaas configurado e ligado pelo master). */
  platform: boolean;
  feePct: number;
  reason: string | null;
}

export function onlineStatus(shopId: number): OnlineStatus {
  const s = asaasSettings();
  const platform = asaasEnabled() && s.online.enabled;
  const shop = get<{ online_payments: number; asaas_wallet_id: string | null }>('SELECT online_payments, asaas_wallet_id FROM barbershops WHERE id = ?', [shopId]);
  const reason = !platform
    ? 'A plataforma ainda não liberou os pagamentos online.'
    : !shop?.asaas_wallet_id
      ? 'Falta a carteira Asaas da barbearia.'
      : !shop.online_payments
        ? 'A barbearia não ligou o pagamento com cartão.'
        : null;
  return { available: !reason, platform, feePct: s.online.feePct, reason };
}

/** Configuração da barbearia: carteira Asaas (recebe o repasse) e se oferece cartão aos clientes. */
export function shopOnlineSettings(shopId: number) {
  const shop = get<{ online_payments: number; asaas_wallet_id: string | null }>('SELECT online_payments, asaas_wallet_id FROM barbershops WHERE id = ?', [shopId])!;
  return { enabled: Boolean(shop.online_payments), walletId: shop.asaas_wallet_id, status: onlineStatus(shopId) };
}

export function saveShopOnlineSettings(shopId: number, s: { enabled: boolean; walletId: string | null }) {
  const wallet = s.walletId?.trim() || null;
  if (wallet && !WALLET.test(wallet)) throw new HttpError(400, 'Identificador da carteira (Wallet ID) inválido: são 36 caracteres, como 1a2b3c4d-....');
  if (s.enabled && !wallet) throw new HttpError(400, 'Informe a carteira Asaas da barbearia para receber os pagamentos.');
  run('UPDATE barbershops SET online_payments = ?, asaas_wallet_id = ? WHERE id = ?', [s.enabled ? 1 : 0, wallet, shopId]);
  return shopOnlineSettings(shopId);
}

/** Cadastro do cliente no Asaas da plataforma (o CPF vai só para o Asaas, não fica no sistema). */
async function ensureEndCustomer(customerId: number, cpf: string | null | undefined): Promise<string> {
  const c = get<{ id: number; name: string; phone: string; asaas_customer_id: string | null }>('SELECT id, name, phone, asaas_customer_id FROM customers WHERE id = ?', [
    customerId,
  ])!;
  if (c.asaas_customer_id) return c.asaas_customer_id;
  const digits = (cpf ?? '').replace(/\D/g, '');
  if (!digits) throw new HttpError(400, 'Informe o seu CPF para pagar online (o banco pede).');
  if (!validTaxId(digits)) throw new HttpError(400, 'CPF inválido.');
  const created = await asaasCall<{ id: string }>('POST', '/customers', {
    name: c.name,
    cpfCnpj: digits,
    mobilePhone: c.phone,
    externalReference: `cliente:${c.id}`,
    notificationDisabled: true,
  });
  run('UPDATE customers SET asaas_customer_id = ? WHERE id = ?', [created.id, c.id]);
  return created.id;
}

const inFlight = new Set<number>();

/**
 * O cliente quer pagar a cobrança (mensalidade do clube ou sinal) online. Devolve o link da página do
 * Asaas (cartão; no clube também boleto ou PIX). Um link por cobrança: pedir de novo devolve o mesmo.
 */
export async function payChargeOnline(shopId: number, customerId: number, chargeId: number, cpf?: string | null): Promise<{ url: string }> {
  const status = onlineStatus(shopId);
  if (!status.available) throw new HttpError(409, status.reason ?? 'Pagamento online indisponível.');
  const c = charge(chargeId, shopId);
  if (c.customer_id !== customerId) throw new HttpError(404, 'Cobrança não encontrada.');
  if (c.status !== 'open') throw new HttpError(409, 'Essa cobrança não está mais em aberto.');
  const pending = get<{ invoice_url: string | null }>(
    "SELECT invoice_url FROM gateway_payments WHERE charge_id = ? AND status IN ('PENDING', 'OVERDUE') AND invoice_url IS NOT NULL ORDER BY id DESC LIMIT 1",
    [chargeId],
  );
  if (pending?.invoice_url) return { url: pending.invoice_url };
  if (inFlight.has(chargeId)) throw new HttpError(409, 'Já estamos gerando o pagamento. Tente de novo em alguns segundos.');
  inFlight.add(chargeId);
  try {
    const customer = await ensureEndCustomer(customerId, cpf);
    const shop = get<{ name: string; asaas_wallet_id: string }>('SELECT name, asaas_wallet_id FROM barbershops WHERE id = ?', [shopId])!;
    const today = shopNow(shopId).date;
    const billingType = c.kind === 'sinal' ? 'CREDIT_CARD' : 'UNDEFINED';
    const p = await asaasCall<{ id: string; invoiceUrl: string }>('POST', '/payments', {
      customer,
      // Sinal: só cartão (o boleto demora dias e o horário fica segurado por pouco tempo).
      billingType,
      value: c.amount_cents / 100,
      dueDate: c.due_date && c.due_date > today ? c.due_date : today,
      description: `${shop.name}: ${c.description}`.slice(0, 500),
      externalReference: `cobranca:${c.id}`,
      // Repasse para a conta Asaas da barbearia (o resto, se houver, fica com a plataforma).
      split: [{ walletId: shop.asaas_wallet_id, percentualValue: 100 - status.feePct }],
    });
    recordGatewayPayment({
      externalId: p.id,
      shopId,
      kind: c.kind,
      chargeId: c.id,
      valueCents: c.amount_cents,
      feePct: status.feePct,
      method: billingType,
      invoiceUrl: p.invoiceUrl,
    });
    return { url: p.invoiceUrl };
  } catch (err) {
    if (err instanceof AsaasError) throw new HttpError(502, `Não deu para gerar o pagamento agora: ${err.message}`);
    throw err;
  } finally {
    inFlight.delete(chargeId);
  }
}

const METHOD: Record<string, Method> = { CREDIT_CARD: 'credito', DEBIT_CARD: 'debito', PIX: 'pix' };

/**
 * O Asaas avisou que o cliente pagou online: confirma a cobrança sozinha e lança no caixa da barbearia
 * as taxas (do Asaas e da plataforma), para o saldo bater com o que cai na conta.
 */
export function chargePaidOnline(gp: GatewayPaymentRow, p: AsaasPayment): { ok: true; chargeId: number; note?: string } {
  const c = charge(gp.charge_id!);
  // Os avisos de "confirmado" e "recebido" chegam os dois: só o primeiro baixa a cobrança.
  if (gp.applied) return { ok: true, chargeId: c.id, note: 'já aplicado' };
  if (c.status === 'paid') {
    // Já tinha sido paga de outro jeito (ex.: PIX direto): a barbearia devolve pelo Asaas.
    run('UPDATE gateway_payments SET duplicate = 1 WHERE id = ?', [gp.id]);
    return { ok: true, chargeId: c.id, note: 'pago em duplicidade' };
  }
  const method = METHOD[p.billingType ?? ''] ?? 'outro';
  tx(() => {
    if (c.status === 'cancelled') {
      // Pagou depois de a cobrança ser cancelada: o sinal vira crédito para o próximo horário;
      // a mensalidade do clube vale o mês pago.
      run("UPDATE charges SET status = 'open', expires_at = NULL, appointment_id = CASE WHEN kind = 'sinal' THEN NULL ELSE appointment_id END WHERE id = ?", [c.id]);
    }
    confirmCharge(c.barbershop_id, c.id, { method, userId: null });
    run('UPDATE gateway_payments SET applied = 1 WHERE id = ?', [gp.id]);
    const net = typeof p.netValue === 'number' ? Math.round(p.netValue * 100) : null;
    if (net != null) {
      const toShop = Math.round((net * (100 - gp.platform_fee_pct)) / 100);
      const fees = c.amount_cents - toShop;
      if (fees > 0) {
        run(
          `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, charge_id, created_at)
           VALUES (?, 'out', 'Impostos e taxas', ?, ?, NULL, ?, 'paid', ?, ?)`,
          [c.barbershop_id, `Taxas do pagamento online · ${c.description}`, fees, shopNow(c.barbershop_id).date, c.id, nowIso()],
        );
      }
    }
  });
  return { ok: true, chargeId: c.id };
}

/**
 * O pagamento online foi estornado no Asaas depois de baixado: o repasse volta da conta da barbearia,
 * então sai do caixa dela. Sinal estornado deixa de valer como crédito.
 */
export function chargeRefundedOnline(gp: GatewayPaymentRow): { ok: true; chargeId?: number; note: string } {
  if (!gp.charge_id || !gp.applied || gp.refunded) return { ok: true, note: 'nada a desfazer' };
  const c = charge(gp.charge_id);
  // O que entrou no caixa: o valor menos as taxas (lançadas quando o Asaas mandou o valor líquido).
  const kept = gp.net_cents != null ? splitOf(gp).toShop : gp.value_cents;
  tx(() => {
    run(
      `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, charge_id, created_at)
       VALUES (?, 'out', 'Outras saídas', ?, ?, ?, ?, 'paid', ?, ?)`,
      [c.barbershop_id, `Estorno do pagamento online · ${c.description}`, kept, METHOD[gp.method ?? ''] ?? 'outro', shopNow(c.barbershop_id).date, c.id, nowIso()],
    );
    if (c.kind === 'sinal' && !c.sale_id && !c.refunded_at) run('UPDATE charges SET refunded_at = ?, appointment_id = NULL WHERE id = ?', [nowIso(), c.id]);
    run('UPDATE gateway_payments SET refunded = 1 WHERE id = ?', [gp.id]);
  });
  return { ok: true, chargeId: c.id, note: 'estornado' };
}

/** Cobrança que deixou de estar em aberto (paga por PIX direto, cancelada, sinal vencido): apaga o link no Asaas. */
export async function sweepStaleOnlinePayments(): Promise<number> {
  if (!asaasEnabled()) return 0;
  const stale = all<{ id: number; external_id: string }>(
    `SELECT g.id, g.external_id FROM gateway_payments g JOIN charges c ON c.id = g.charge_id
      WHERE g.status IN ('PENDING', 'OVERDUE') AND c.status <> 'open' LIMIT 50`,
  );
  let removed = 0;
  for (const g of stale) {
    try {
      await asaasCall('DELETE', `/payments/${g.external_id}`);
      run("UPDATE gateway_payments SET status = 'DELETED', updated_at = ? WHERE id = ?", [nowIso(), g.id]);
      removed++;
    } catch (err) {
      if (err instanceof AsaasError && err.status === 404) run("UPDATE gateway_payments SET status = 'DELETED', updated_at = ? WHERE id = ?", [nowIso(), g.id]);
      else console.warn('[asaas] apagar link de pagamento:', (err as Error).message);
    }
  }
  return removed;
}

export { gatewayPayment };
