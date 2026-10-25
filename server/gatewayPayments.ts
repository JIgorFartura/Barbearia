import { all, get, nowIso, run } from './db.js';

/**
 * Registro dos pagamentos online: mensalidades das barbearias (cartão pela Cielo; PIX ou boleto pelo
 * Asaas) e pagamentos dos clientes no cartão (clube, pela Cielo de cada barbearia). É daqui que saem
 * a lista do master (só as mensalidades) e os recebimentos online de cada barbearia.
 */

export type GatewayKind = 'mensalidade' | 'clube';

export interface GatewayPaymentRow {
  id: number;
  provider: 'asaas' | 'cielo';
  external_id: string;
  barbershop_id: number | null;
  kind: GatewayKind;
  invoice_id: number | null;
  charge_id: number | null;
  value_cents: number;
  net_cents: number | null;
  method: string | null;
  status: string;
  applied: number;
  duplicate: number;
  refunded: number;
  card_link_id: number | null;
  invoice_url: string | null;
  created_at: string;
  paid_at: string | null;
}

export function recordGatewayPayment(p: {
  externalId: string;
  shopId: number;
  kind: GatewayKind;
  invoiceId?: number | null;
  chargeId?: number | null;
  valueCents: number;
  method: string;
  invoiceUrl: string | null;
}): number {
  return run(
    `INSERT INTO gateway_payments (external_id, barbershop_id, kind, invoice_id, charge_id, value_cents, method, invoice_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) DO UPDATE SET invoice_url = excluded.invoice_url`,
    [p.externalId, p.shopId, p.kind, p.invoiceId ?? null, p.chargeId ?? null, p.valueCents, p.method, p.invoiceUrl, nowIso()],
  ).lastInsertRowid;
}

export const gatewayPayment = (externalId: string) => get<GatewayPaymentRow>('SELECT * FROM gateway_payments WHERE external_id = ?', [externalId]);

/**
 * Pagamento no cartão pela Cielo, registrado quando a Cielo avisa (e conferido nela). O valor líquido
 * é estimado pela taxa informada por quem recebe (a Cielo não manda no aviso).
 */
export function upsertCardPayment(p: {
  externalId: string;
  shopId: number;
  kind: GatewayKind;
  cardLinkId: number;
  invoiceId?: number | null;
  chargeId?: number | null;
  valueCents: number;
  netCents: number;
  method: string | null;
  status: string;
  applied?: boolean;
  duplicate?: boolean;
  paidAt?: string | null;
}): GatewayPaymentRow {
  run(
    `INSERT INTO gateway_payments (provider, external_id, barbershop_id, kind, invoice_id, charge_id, card_link_id, value_cents, net_cents, method, status, applied, duplicate, created_at, paid_at, updated_at)
     VALUES ('cielo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) DO UPDATE SET status = excluded.status, method = COALESCE(excluded.method, method), invoice_id = COALESCE(excluded.invoice_id, invoice_id),
       charge_id = COALESCE(excluded.charge_id, charge_id), applied = MAX(applied, excluded.applied), duplicate = MAX(duplicate, excluded.duplicate),
       paid_at = COALESCE(paid_at, excluded.paid_at), updated_at = excluded.updated_at`,
    [
      p.externalId,
      p.shopId,
      p.kind,
      p.invoiceId ?? null,
      p.chargeId ?? null,
      p.cardLinkId,
      p.valueCents,
      p.netCents,
      p.method,
      p.status,
      p.applied ? 1 : 0,
      p.duplicate ? 1 : 0,
      nowIso(),
      p.paidAt ?? null,
      nowIso(),
    ],
  );
  return gatewayPayment(p.externalId)!;
}

const EVENT_STATUS: Record<string, string> = {
  PAYMENT_CREATED: 'PENDING',
  PAYMENT_CONFIRMED: 'CONFIRMED',
  PAYMENT_RECEIVED: 'RECEIVED',
  PAYMENT_OVERDUE: 'OVERDUE',
  PAYMENT_DELETED: 'DELETED',
  PAYMENT_REFUNDED: 'REFUNDED',
  PAYMENT_PARTIALLY_REFUNDED: 'REFUNDED',
  PAYMENT_CHARGEBACK_REQUESTED: 'CHARGEBACK',
  PAYMENT_CHARGEBACK_DISPUTE: 'CHARGEBACK',
  PAYMENT_RECEIVED_IN_CASH_UNDONE: 'PENDING',
};

/** Aviso do Asaas sobre um pagamento: atualiza situação, forma usada, valor líquido e data. */
export function updateGatewayPayment(
  externalId: string,
  event: string,
  p: { status?: string; billingType?: string; netValue?: number | null; confirmedDate?: string | null; paymentDate?: string | null; clientPaymentDate?: string | null },
): GatewayPaymentRow | undefined {
  const row = gatewayPayment(externalId);
  if (!row) return undefined;
  const status = p.status || EVENT_STATUS[event] || row.status;
  const paidAt = p.confirmedDate ?? p.paymentDate ?? p.clientPaymentDate ?? null;
  run(
    `UPDATE gateway_payments SET status = ?, method = COALESCE(?, method), net_cents = COALESCE(?, net_cents),
            paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ?`,
    [
      status,
      p.billingType && p.billingType !== 'UNDEFINED' ? p.billingType : null,
      typeof p.netValue === 'number' ? Math.round(p.netValue * 100) : null,
      ['CONFIRMED', 'RECEIVED'].includes(status) ? (paidAt ?? nowIso().slice(0, 10)) : null,
      nowIso(),
      row.id,
    ],
  );
  return gatewayPayment(externalId);
}

/** Pago pelo Asaas (RECEIVED_IN_CASH é a baixa manual repassada ao Asaas: o dinheiro não passou por lá). */
export const PAID_STATUSES = ['CONFIRMED', 'RECEIVED'];

/** O que vai para a tela: sem os códigos internos, com o líquido (depois da taxa do meio de pagamento). */
const view = ({ external_id: _id, invoice_url: _url, ...r }: GatewayPaymentRow) => ({ ...r, net: r.net_cents ?? r.value_cents, paid: PAID_STATUSES.includes(r.status) });

/**
 * Lista para o master: só as mensalidades que as barbearias pagam à plataforma (barbearia, forma,
 * valores e situação). O que os clientes pagam às barbearias não passa pela plataforma e não aparece aqui.
 */
export function platformPayments(filter: { from: string; to: string }) {
  const rows = all<GatewayPaymentRow & { shop: string | null }>(
    `SELECT g.*, b.name AS shop FROM gateway_payments g LEFT JOIN barbershops b ON b.id = g.barbershop_id
      WHERE g.kind = 'mensalidade' AND substr(g.created_at, 1, 10) >= ? AND substr(g.created_at, 1, 10) <= ?
      ORDER BY g.id DESC LIMIT 500`,
    [filter.from, filter.to],
  );
  const items = rows.map(({ shop, ...r }) => ({ ...view(r), shop }));
  const paid = items.filter((i) => i.paid);
  return {
    items,
    totals: {
      /** Mensalidades pagas online no período. */
      processed: paid.reduce((t, i) => t + i.value_cents, 0),
      fees: paid.reduce((t, i) => t + (i.value_cents - i.net), 0),
      net: paid.reduce((t, i) => t + i.net, 0),
      count: paid.length,
      byMethod: Object.entries(
        paid.reduce<Record<string, number>>((m, i) => ({ ...m, [i.method ?? 'UNDEFINED']: (m[i.method ?? 'UNDEFINED'] ?? 0) + i.value_cents }), {}),
      ).map(([method, total]) => ({ method, total })),
    },
  };
}

/** Recebimentos online de uma barbearia (o dono vê os clientes dele). */
export function shopOnlinePayments(shopId: number, limit = 30) {
  return all<GatewayPaymentRow & { customer: string | null; description: string | null }>(
    `SELECT g.*, c.name AS customer, ch.description FROM gateway_payments g
       LEFT JOIN charges ch ON ch.id = g.charge_id LEFT JOIN customers c ON c.id = ch.customer_id
      WHERE g.barbershop_id = ? AND g.kind <> 'mensalidade' ORDER BY g.id DESC LIMIT ?`,
    [shopId, limit],
  ).map(({ customer, description, ...r }) => ({ ...view(r), customer, description }));
}
