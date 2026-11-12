import { shopTz } from './clock.js';
import { all } from './db.js';
import { receiptInfo } from './receipts.js';
import { addDays, isoToLocal } from './time.js';

/**
 * Pagamentos dos clientes à barbearia: compras (balcão e atendimentos) e mensalidades do clube (PIX ou
 * cartão). O cliente vê só os dele, na área dele; o dono vê os de todos, no Financeiro. O master não
 * vê nenhum: o dinheiro é da barbearia.
 */

export interface PaymentView {
  kind: 'compra' | 'clube';
  id: number;
  /** Dia (AAAA-MM-DD, no relógio da barbearia): da compra, do pagamento ou do vencimento (em aberto). */
  date: string;
  description: string;
  amount_cents: number;
  method: string | null;
  /** Em aberto, avisado pelo cliente (PIX a conferir) ou pago. */
  status: 'open' | 'claimed' | 'paid';
  /** Pago no cartão pela Cielo (baixa automática). */
  card: boolean;
  receipt: { type: string; at: string } | null;
  /** PDF da nota fiscal de serviço (quando a barbearia emite). */
  nfse_url: string | null;
  customer?: string | null;
}

// Itens da venda na ordem em que foram lançados: "2× Cerveja, Corte".
const ITEMS = `(SELECT group_concat(label, ', ') FROM (SELECT CASE WHEN i.qty > 1 THEN i.qty || '× ' ELSE '' END || i.name AS label
                  FROM sale_items i WHERE i.sale_id = s.id ORDER BY i.id))`;

interface SaleRow {
  id: number;
  date: string;
  total_cents: number;
  method: string;
  items: string | null;
  nfse_url: string | null;
  customer?: string | null;
}

interface ChargeRow {
  id: number;
  description: string;
  amount_cents: number;
  method: string | null;
  status: 'open' | 'paid';
  claimed_at: string | null;
  paid_at: string | null;
  due_date: string | null;
  created_at: string;
  receipt_file: string | null;
  receipt_type: string | null;
  receipt_at: string | null;
  card: number;
  nfse_url: string | null;
  customer?: string | null;
}

const CHARGE_FIELDS = `ch.id, ch.description, ch.amount_cents, ch.method, ch.status, ch.claimed_at, ch.paid_at, ch.due_date, ch.created_at,
  ch.receipt_file, ch.receipt_type, ch.receipt_at, ch.nfse_url,
  EXISTS (SELECT 1 FROM gateway_payments g WHERE g.charge_id = ch.id AND g.applied = 1) AS card`;

const fromSale = (s: SaleRow): PaymentView => ({
  kind: 'compra',
  id: s.id,
  date: s.date,
  description: s.items ?? 'Compra',
  amount_cents: s.total_cents,
  method: s.method,
  status: 'paid',
  card: false,
  receipt: null,
  nfse_url: s.nfse_url,
  ...(s.customer !== undefined ? { customer: s.customer } : {}),
});

const fromCharge = (c: ChargeRow, tz: string): PaymentView => ({
  kind: 'clube',
  id: c.id,
  date: c.status === 'paid' && c.paid_at ? isoToLocal(c.paid_at, tz).slice(0, 10) : (c.due_date ?? isoToLocal(c.created_at, tz).slice(0, 10)),
  description: c.description,
  amount_cents: c.amount_cents,
  method: c.status === 'paid' ? c.method : null,
  status: c.status === 'paid' ? 'paid' : c.claimed_at ? 'claimed' : 'open',
  card: Boolean(c.card),
  receipt: receiptInfo(c),
  nfse_url: c.nfse_url,
  ...(c.customer !== undefined ? { customer: c.customer } : {}),
});

const newestFirst = (a: PaymentView, b: PaymentView) => b.date.localeCompare(a.date) || (a.kind === b.kind ? b.id - a.id : a.kind === 'clube' ? -1 : 1);

/** "Meus pagamentos" na área do cliente: só o que ele pagou (ou tem para pagar) à barbearia. */
export function customerPayments(shopId: number, customerId: number, limit = 20): PaymentView[] {
  const tz = shopTz(shopId);
  const sales = all<SaleRow>(
    `SELECT s.id, s.date, s.total_cents, s.method, s.nfse_url, ${ITEMS} AS items FROM sales s
      WHERE s.barbershop_id = ? AND s.customer_id = ? AND s.status = 'closed' AND s.total_cents > 0 ORDER BY s.date DESC, s.id DESC LIMIT ?`,
    [shopId, customerId, limit],
  );
  const charges = all<ChargeRow>(
    `SELECT ${CHARGE_FIELDS} FROM charges ch
      WHERE ch.barbershop_id = ? AND ch.customer_id = ? AND ch.kind = 'clube' AND ch.status <> 'cancelled' ORDER BY ch.id DESC LIMIT ?`,
    [shopId, customerId, limit],
  );
  return [...sales.map(fromSale), ...charges.map((c) => fromCharge(c, tz))].sort(newestFirst).slice(0, limit);
}

/** Financeiro → Recebimentos: o que os clientes pagaram à barbearia no período (balcão e clube), com os comprovantes. */
export function receivedFromCustomers(shopId: number, from: string, to: string) {
  const tz = shopTz(shopId);
  const sales = all<SaleRow>(
    `SELECT s.id, s.date, s.total_cents, s.method, s.nfse_url, ${ITEMS} AS items, c.name AS customer FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.barbershop_id = ? AND s.status = 'closed' AND s.total_cents > 0 AND s.date >= ? AND s.date <= ?`,
    [shopId, from, to],
  ).map(fromSale);
  // paid_at é UTC: pega uma folga de um dia de cada lado e confere a data no relógio da barbearia.
  const club = all<ChargeRow>(
    `SELECT ${CHARGE_FIELDS}, c.name AS customer FROM charges ch JOIN customers c ON c.id = ch.customer_id
      WHERE ch.barbershop_id = ? AND ch.kind = 'clube' AND ch.status = 'paid' AND ch.paid_at >= ? AND ch.paid_at < ?`,
    [shopId, addDays(from, -1), addDays(to, 2)],
  )
    .map((c) => fromCharge(c, tz))
    .filter((p) => p.date >= from && p.date <= to);
  const items = [...sales, ...club].sort(newestFirst);
  const sum = (list: PaymentView[]) => list.reduce((t, p) => t + p.amount_cents, 0);
  return {
    items: items.slice(0, 500),
    totals: {
      total: sum(items),
      count: items.length,
      counter: sum(sales),
      club: sum(club),
      receipts: club.filter((p) => p.receipt).length,
    },
  };
}
