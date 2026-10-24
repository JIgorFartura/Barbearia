import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { addStamps, isRunning, type Campaign } from './loyalty.js';
import { shopNow } from './clock.js';
import { addDays, daysBetween } from './time.js';

/**
 * Financeiro da barbearia. Uma venda (comanda) fecha o atendimento: lança a entrada no caixa,
 * calcula a comissão de cada barbeiro e dá os carimbos das campanhas ligadas aos itens.
 */

export const METHODS = ['dinheiro', 'pix', 'debito', 'credito', 'outro'] as const;
export type Method = (typeof METHODS)[number];
export const IN_CATEGORIES = ['Atendimentos', 'Anúncios e parcerias', 'Outras entradas'];
export const OUT_CATEGORIES = [
  'Comissões',
  'Salários',
  'Aluguel',
  'Contas (água, luz, internet)',
  'Produtos e estoque',
  'Marketing',
  'Manutenção',
  'Impostos e taxas',
  'Mensalidade do sistema',
  'Outras saídas',
];

// ---------- comissão

interface BarberRates {
  service_commission: number;
  product_commission: number;
}

/**
 * Comissão de um item, em centavos. `netCents` é o valor do item já com a parte dele no desconto.
 * Serviço: valor fixo ou % definido para aquele serviço; senão o % padrão do barbeiro.
 * Produto: % de produtos do barbeiro.
 */
export function commissionFor(barberId: number | null, kind: 'service' | 'product', serviceId: number | null, qty: number, netCents: number): number {
  if (!barberId) return 0;
  const b = get<BarberRates>('SELECT service_commission, product_commission FROM barbers WHERE id = ?', [barberId]);
  if (!b) return 0;
  if (kind === 'product') return Math.round((netCents * b.product_commission) / 100);
  const rate = serviceId
    ? get<{ mode: 'percent' | 'fixed'; value: number }>('SELECT mode, value FROM barber_service_rates WHERE barber_id = ? AND service_id = ?', [barberId, serviceId])
    : undefined;
  if (rate?.mode === 'fixed') return Math.round(rate.value) * qty;
  const pct = rate?.mode === 'percent' ? rate.value : b.service_commission;
  return Math.round((netCents * pct) / 100);
}

// ---------- vendas

export interface SaleItemInput {
  catalog_item_id?: number | null;
  /** Item avulso (sem cadastro): nome e tipo obrigatórios. */
  name?: string | null;
  kind?: 'service' | 'product' | null;
  qty: number;
  /** Preço unitário (padrão: preço do catálogo). */
  unit_price_cents?: number | null;
  barber_id?: number | null;
}

export interface SaleInput {
  shopId: number;
  userId: number | null;
  customerId?: number | null;
  appointmentId?: number | null;
  items: SaleItemInput[];
  discountCents?: number;
  method: Method;
  notes?: string | null;
  now?: Date;
}

export interface SaleView {
  id: number;
  date: string;
  customer_id: number | null;
  customer_name: string | null;
  appointment_id: number | null;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  method: Method;
  notes: string | null;
  status: 'closed' | 'cancelled';
  created_at: string;
  items: {
    id: number;
    catalog_item_id: number | null;
    kind: 'service' | 'product';
    name: string;
    qty: number;
    unit_price_cents: number;
    total_cents: number;
    barber_id: number | null;
    barber_name: string | null;
    commission_cents: number;
    paid: boolean;
  }[];
}

export function saleView(id: number): SaleView {
  const sale = get<Omit<SaleView, 'items'>>(
    `SELECT s.id, s.date, s.customer_id, c.name AS customer_name, s.appointment_id, s.subtotal_cents, s.discount_cents, s.total_cents,
            s.method, s.notes, s.status, s.created_at
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
    [id],
  );
  if (!sale) throw new HttpError(404, 'Venda não encontrada.');
  const items = all<SaleView['items'][number] & { payout_id: number | null }>(
    `SELECT i.id, i.catalog_item_id, i.kind, i.name, i.qty, i.unit_price_cents, i.total_cents, i.barber_id, b.name AS barber_name,
            i.commission_cents, i.payout_id
       FROM sale_items i LEFT JOIN barbers b ON b.id = i.barber_id WHERE i.sale_id = ? ORDER BY i.id`,
    [id],
  ).map(({ payout_id, ...i }) => ({ ...i, paid: payout_id != null }));
  return { ...sale, items };
}

export interface SaleResult {
  sale: SaleView;
  /** Carimbos dados automaticamente (ex.: cerveja ligada ao Clube da Cerveja). */
  stamps: { campaign: string; qty: number; unit: string; available: number }[];
}

export function createSale(input: SaleInput): SaleResult {
  return tx(() => {
    const shop = input.shopId;
    let customerId = input.customerId ?? null;
    let defaultBarber: number | null = null;
    if (input.appointmentId) {
      const a = get<{ customer_id: number; barber_id: number; status: string }>('SELECT customer_id, barber_id, status FROM appointments WHERE id = ? AND barbershop_id = ?', [
        input.appointmentId,
        shop,
      ]);
      if (!a) throw new HttpError(404, 'Horário não encontrado.');
      if (a.status === 'cancelled') throw new HttpError(409, 'Esse horário foi cancelado.');
      if (get("SELECT 1 AS ok FROM sales WHERE appointment_id = ? AND status = 'closed'", [input.appointmentId])) {
        throw new HttpError(409, 'Esse atendimento já foi fechado.');
      }
      customerId = a.customer_id;
      defaultBarber = a.barber_id;
    }
    if (customerId && !get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ?', [customerId, shop])) throw new HttpError(404, 'Cliente não encontrado.');
    if (!input.items.length) throw new HttpError(400, 'Inclua pelo menos um item.');

    const items = input.items.map((i) => {
      const barberId = i.barber_id ?? defaultBarber;
      if (barberId && !get('SELECT 1 AS ok FROM barbers WHERE id = ? AND barbershop_id = ?', [barberId, shop])) throw new HttpError(404, 'Barbeiro não encontrado.');
      if (i.catalog_item_id) {
        const c = get<{ id: number; kind: 'service' | 'product'; name: string; price_cents: number }>(
          'SELECT id, kind, name, price_cents FROM catalog_items WHERE id = ? AND barbershop_id = ?',
          [i.catalog_item_id, shop],
        );
        if (!c) throw new HttpError(404, 'Item do catálogo não encontrado.');
        return { catalogId: c.id, kind: c.kind, name: c.name, unit: i.unit_price_cents ?? c.price_cents, qty: i.qty, barberId };
      }
      if (!i.name?.trim() || !i.kind) throw new HttpError(400, 'Item avulso precisa de nome e tipo.');
      return { catalogId: null, kind: i.kind, name: i.name.trim(), unit: i.unit_price_cents ?? 0, qty: i.qty, barberId };
    });

    const subtotal = items.reduce((s, i) => s + i.unit * i.qty, 0);
    const discount = Math.min(Math.max(0, input.discountCents ?? 0), subtotal);
    const total = subtotal - discount;
    const date = shopNow(shop, input.now).date;
    const saleId = run(
      `INSERT INTO sales (barbershop_id, customer_id, appointment_id, date, subtotal_cents, discount_cents, total_cents, method, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [shop, customerId, input.appointmentId ?? null, date, subtotal, discount, total, input.method, input.notes ?? null, input.userId, nowIso()],
    ).lastInsertRowid;

    for (const i of items) {
      const gross = i.unit * i.qty;
      // A comissão em % incide sobre o valor cobrado: o desconto é dividido entre os itens.
      const net = subtotal ? Math.round((gross * total) / subtotal) : 0;
      run(
        `INSERT INTO sale_items (sale_id, catalog_item_id, kind, name, qty, unit_price_cents, total_cents, barber_id, commission_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [saleId, i.catalogId, i.kind, i.name, i.qty, i.unit, gross, i.barberId, commissionFor(i.barberId, i.kind, i.catalogId, i.qty, net)],
      );
    }

    const customerName = customerId ? get<{ name: string }>('SELECT name FROM customers WHERE id = ?', [customerId])?.name : null;
    if (total > 0) {
      run(
        `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, sale_id, created_by, created_at)
         VALUES (?, 'in', 'Atendimentos', ?, ?, ?, ?, 'paid', ?, ?, ?)`,
        [shop, `Venda #${saleId}${customerName ? ` · ${customerName}` : ''}`, total, input.method, date, saleId, input.userId, nowIso()],
      );
    }

    // Item ligado a uma campanha valendo (ex.: cerveja → Clube da Cerveja) vira carimbo automático.
    const stamps: SaleResult['stamps'] = [];
    if (customerId) {
      const campaigns = all<Campaign & { catalog_item_id: number | null }>('SELECT * FROM campaigns WHERE barbershop_id = ? AND catalog_item_id IS NOT NULL', [shop]);
      for (const c of campaigns.filter((x) => isRunning(x, date))) {
        const qty = items.filter((i) => i.catalogId === c.catalog_item_id).reduce((s, i) => s + i.qty, 0);
        if (!qty) continue;
        const p = addStamps(shop, c.id, customerId, qty, input.userId, saleId);
        stamps.push({ campaign: c.name, qty, unit: c.unit_label, available: p.available });
      }
    }
    return { sale: saleView(saleId), stamps };
  });
}

/** Cancela a venda: tira a entrada do caixa e os carimbos que ela deu. */
export function cancelSale(shopId: number, saleId: number): SaleView {
  return tx(() => {
    const sale = get<{ status: string }>('SELECT status FROM sales WHERE id = ? AND barbershop_id = ?', [saleId, shopId]);
    if (!sale) throw new HttpError(404, 'Venda não encontrada.');
    if (sale.status === 'cancelled') throw new HttpError(409, 'Essa venda já foi cancelada.');
    if (get('SELECT 1 AS ok FROM sale_items WHERE sale_id = ? AND payout_id IS NOT NULL', [saleId])) {
      throw new HttpError(409, 'A comissão desta venda já foi paga ao barbeiro. Lance um ajuste no caixa.');
    }
    run("UPDATE sales SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [nowIso(), saleId]);
    run('DELETE FROM cash_entries WHERE sale_id = ?', [saleId]);
    run('DELETE FROM loyalty_events WHERE sale_id = ?', [saleId]);
    return saleView(saleId);
  });
}

export function listSales(shopId: number, from: string, to: string): SaleView[] {
  return all<{ id: number }>('SELECT id FROM sales WHERE barbershop_id = ? AND date >= ? AND date <= ? ORDER BY id DESC LIMIT 500', [shopId, from, to]).map((s) =>
    saleView(s.id),
  );
}

// ---------- caixa

export interface EntryInput {
  type: 'in' | 'out';
  category: string;
  description: string | null;
  amount_cents: number;
  method: string | null;
  date: string;
  status: 'paid' | 'pending';
}

export interface EntryView extends EntryInput {
  id: number;
  sale_id: number | null;
  payout_id: number | null;
  invoice_id: number | null;
  /** Lançado à mão (pode editar/excluir); os automáticos saem pela venda, comissão ou mensalidade. */
  manual: boolean;
}

export function listEntries(shopId: number, from: string, to: string): EntryView[] {
  return all<Omit<EntryView, 'manual'>>(
    `SELECT id, type, category, description, amount_cents, method, date, status, sale_id, payout_id, invoice_id
       FROM cash_entries WHERE barbershop_id = ? AND date >= ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1000`,
    [shopId, from, to],
  ).map((e) => ({ ...e, manual: e.sale_id == null && e.payout_id == null && e.invoice_id == null }));
}

export function addEntry(shopId: number, e: EntryInput, userId: number | null): number {
  return run(
    `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [shopId, e.type, e.category, e.description, e.amount_cents, e.method, e.date, e.status, userId, nowIso()],
  ).lastInsertRowid;
}

function manualEntry(shopId: number, id: number): void {
  const e = get<{ sale_id: number | null; payout_id: number | null; invoice_id: number | null }>(
    'SELECT sale_id, payout_id, invoice_id FROM cash_entries WHERE id = ? AND barbershop_id = ?',
    [id, shopId],
  );
  if (!e) throw new HttpError(404, 'Lançamento não encontrado.');
  if (e.sale_id || e.payout_id || e.invoice_id) throw new HttpError(409, 'Lançamento automático: altere pela venda, comissão ou mensalidade.');
}

export function updateEntry(shopId: number, id: number, e: EntryInput): void {
  manualEntry(shopId, id);
  run('UPDATE cash_entries SET type = ?, category = ?, description = ?, amount_cents = ?, method = ?, date = ?, status = ? WHERE id = ?', [
    e.type,
    e.category,
    e.description,
    e.amount_cents,
    e.method,
    e.date,
    e.status,
    id,
  ]);
}

export function deleteEntry(shopId: number, id: number): void {
  manualEntry(shopId, id);
  run('DELETE FROM cash_entries WHERE id = ?', [id]);
}

/** Conta a pagar/receber que foi quitada. */
export function payEntry(shopId: number, id: number, date: string, method: string | null): void {
  const { changes } = run("UPDATE cash_entries SET status = 'paid', date = ?, method = COALESCE(?, method) WHERE id = ? AND barbershop_id = ? AND status = 'pending'", [
    date,
    method,
    id,
    shopId,
  ]);
  if (!changes) throw new HttpError(404, 'Conta pendente não encontrada.');
}

// ---------- relatórios

export function financeSummary(shopId: number, from: string, to: string, now?: Date) {
  const today = shopNow(shopId, now).date;
  const sum = (sql: string, params: unknown[]) => get<{ v: number }>(sql, params)?.v ?? 0;
  const income = sum("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM cash_entries WHERE barbershop_id = ? AND type = 'in' AND status = 'paid' AND date >= ? AND date <= ?", [
    shopId,
    from,
    to,
  ]);
  const expenses = sum("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM cash_entries WHERE barbershop_id = ? AND type = 'out' AND status = 'paid' AND date >= ? AND date <= ?", [
    shopId,
    from,
    to,
  ]);
  const sales = get<{ n: number; total: number; discount: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total, COALESCE(SUM(discount_cents), 0) AS discount FROM sales WHERE barbershop_id = ? AND status = 'closed' AND date >= ? AND date <= ?",
    [shopId, from, to],
  )!;
  const days = Math.min(Math.max(daysBetween(from, to) + 1, 1), 92);
  const byDay = new Map<string, { date: string; in: number; out: number }>();
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    byDay.set(d, { date: d, in: 0, out: 0 });
  }
  for (const r of all<{ date: string; type: 'in' | 'out'; v: number }>(
    "SELECT date, type, SUM(amount_cents) AS v FROM cash_entries WHERE barbershop_id = ? AND status = 'paid' AND date >= ? AND date <= ? GROUP BY date, type",
    [shopId, from, to],
  )) {
    const d = byDay.get(r.date);
    if (d) d[r.type] = r.v;
  }
  return {
    from,
    to,
    income,
    expenses,
    result: income - expenses,
    salesCount: sales.n,
    salesTotal: sales.total,
    discounts: sales.discount,
    averageTicket: sales.n ? Math.round(sales.total / sales.n) : 0,
    pendingOut: sum("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM cash_entries WHERE barbershop_id = ? AND type = 'out' AND status = 'pending'", [shopId]),
    overdueOut: sum("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM cash_entries WHERE barbershop_id = ? AND type = 'out' AND status = 'pending' AND date < ?", [
      shopId,
      today,
    ]),
    byMethod: all<{ method: Method; total: number; count: number }>(
      "SELECT method, SUM(total_cents) AS total, COUNT(*) AS count FROM sales WHERE barbershop_id = ? AND status = 'closed' AND date >= ? AND date <= ? GROUP BY method ORDER BY total DESC",
      [shopId, from, to],
    ),
    byBarber: all<{ barber_id: number; name: string; services: number; products: number; revenue: number; commission: number }>(
      `SELECT b.id AS barber_id, b.name,
              SUM(CASE WHEN i.kind = 'service' THEN i.qty ELSE 0 END) AS services,
              SUM(CASE WHEN i.kind = 'product' THEN i.qty ELSE 0 END) AS products,
              SUM(i.total_cents) AS revenue, SUM(i.commission_cents) AS commission
         FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN barbers b ON b.id = i.barber_id
        WHERE s.barbershop_id = ? AND s.status = 'closed' AND s.date >= ? AND s.date <= ?
        GROUP BY b.id ORDER BY revenue DESC`,
      [shopId, from, to],
    ),
    topItems: all<{ name: string; kind: string; qty: number; total: number }>(
      `SELECT i.name, i.kind, SUM(i.qty) AS qty, SUM(i.total_cents) AS total
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.barbershop_id = ? AND s.status = 'closed' AND s.date >= ? AND s.date <= ?
        GROUP BY i.name, i.kind ORDER BY total DESC LIMIT 8`,
      [shopId, from, to],
    ),
    expensesByCategory: all<{ category: string; total: number }>(
      "SELECT category, SUM(amount_cents) AS total FROM cash_entries WHERE barbershop_id = ? AND type = 'out' AND status = 'paid' AND date >= ? AND date <= ? GROUP BY category ORDER BY total DESC",
      [shopId, from, to],
    ),
    byDay: [...byDay.values()],
  };
}

// ---------- comissões e pagamento dos barbeiros

export function commissionBalances(shopId: number) {
  return all<{ barber_id: number; name: string; active: number; unpaid_cents: number; unpaid_items: number; since: string | null }>(
    `SELECT b.id AS barber_id, b.name, b.active,
            COALESCE(SUM(CASE WHEN s.status = 'closed' AND i.payout_id IS NULL THEN i.commission_cents END), 0) AS unpaid_cents,
            COUNT(CASE WHEN s.status = 'closed' AND i.payout_id IS NULL AND i.commission_cents > 0 THEN 1 END) AS unpaid_items,
            MIN(CASE WHEN s.status = 'closed' AND i.payout_id IS NULL AND i.commission_cents > 0 THEN s.date END) AS since
       FROM barbers b
       LEFT JOIN sale_items i ON i.barber_id = b.id
       LEFT JOIN sales s ON s.id = i.sale_id
      WHERE b.barbershop_id = ?
      GROUP BY b.id ORDER BY b.active DESC, b.name COLLATE NOCASE`,
    [shopId],
  ).map((b) => ({
    ...b,
    lastPayout: get<{ date: string; amount_cents: number }>('SELECT date, amount_cents FROM barber_payouts WHERE barber_id = ? ORDER BY id DESC LIMIT 1', [b.barber_id]) ?? null,
  }));
}

export function barberStatement(shopId: number, barberId: number, from: string, to: string) {
  if (!get('SELECT 1 AS ok FROM barbers WHERE id = ? AND barbershop_id = ?', [barberId, shopId])) throw new HttpError(404, 'Barbeiro não encontrado.');
  const items = all<{ date: string; sale_id: number; customer: string | null; name: string; kind: string; qty: number; total_cents: number; commission_cents: number; payout_id: number | null }>(
    `SELECT s.date, s.id AS sale_id, c.name AS customer, i.name, i.kind, i.qty, i.total_cents, i.commission_cents, i.payout_id
       FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.barbershop_id = ? AND i.barber_id = ? AND s.status = 'closed' AND s.date >= ? AND s.date <= ?
      ORDER BY s.date DESC, i.id DESC`,
    [shopId, barberId, from, to],
  );
  return {
    items: items.map(({ payout_id, ...i }) => ({ ...i, paid: payout_id != null })),
    revenue: items.reduce((s, i) => s + i.total_cents, 0),
    commission: items.reduce((s, i) => s + i.commission_cents, 0),
    payouts: all('SELECT id, date, amount_cents, items, until_date, method FROM barber_payouts WHERE barber_id = ? ORDER BY id DESC LIMIT 20', [barberId]),
  };
}

/** Paga ao barbeiro as comissões em aberto até a data: sai do caixa como "Comissões". */
export function createPayout(input: { shopId: number; barberId: number; until: string; method: string | null; notes: string | null; userId: number | null; now?: Date }) {
  return tx(() => {
    const barber = get<{ name: string }>('SELECT name FROM barbers WHERE id = ? AND barbershop_id = ?', [input.barberId, input.shopId]);
    if (!barber) throw new HttpError(404, 'Barbeiro não encontrado.');
    const open = all<{ id: number; commission_cents: number }>(
      `SELECT i.id, i.commission_cents FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.barbershop_id = ? AND s.status = 'closed' AND i.barber_id = ? AND i.payout_id IS NULL AND i.commission_cents > 0 AND s.date <= ?`,
      [input.shopId, input.barberId, input.until],
    );
    const amount = open.reduce((s, i) => s + i.commission_cents, 0);
    if (!amount) throw new HttpError(400, 'Não há comissão em aberto até essa data.');
    const date = shopNow(input.shopId, input.now).date;
    const payoutId = run(
      'INSERT INTO barber_payouts (barbershop_id, barber_id, amount_cents, items, until_date, date, method, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [input.shopId, input.barberId, amount, open.length, input.until, date, input.method, input.notes, input.userId, nowIso()],
    ).lastInsertRowid;
    for (const i of open) run('UPDATE sale_items SET payout_id = ? WHERE id = ?', [payoutId, i.id]);
    run(
      `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, payout_id, created_by, created_at)
       VALUES (?, 'out', 'Comissões', ?, ?, ?, ?, 'paid', ?, ?, ?)`,
      [input.shopId, `Comissão de ${barber.name} até ${input.until.split('-').reverse().join('/')}`, amount, input.method, date, payoutId, input.userId, nowIso()],
    );
    return { id: payoutId, amount_cents: amount, items: open.length };
  });
}
