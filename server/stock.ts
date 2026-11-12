import { shopNow } from './clock.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';

/**
 * Estoque dos produtos marcados com "controlar estoque". A venda dá baixa sozinha, o cancelamento
 * devolve, e o dono lança as entradas de mercadoria e os ajustes (perda, uso interno, contagem).
 * O que um cliente pediu para deixar separado num horário futuro conta como reservado.
 */

export type MoveKind = 'venda' | 'cancelamento' | 'compra' | 'ajuste' | 'perda' | 'uso';

interface Tracked {
  id: number;
  name: string;
  track_stock: number;
  stock_qty: number;
  stock_min: number | null;
}

function product(shopId: number, itemId: number): Tracked {
  const p = get<Tracked>("SELECT id, name, track_stock, stock_qty, stock_min FROM catalog_items WHERE id = ? AND barbershop_id = ? AND kind = 'product'", [
    itemId,
    shopId,
  ]);
  if (!p) throw new HttpError(404, 'Produto não encontrado.');
  return p;
}

/** Movimenta o estoque (só para produtos com controle ligado). */
function move(shopId: number, itemId: number, qty: number, kind: MoveKind, opts: { saleId?: number | null; unitCost?: number | null; notes?: string | null; userId?: number | null } = {}) {
  if (!qty) return;
  run('UPDATE catalog_items SET stock_qty = stock_qty + ? WHERE id = ?', [qty, itemId]);
  run('INSERT INTO stock_moves (barbershop_id, catalog_item_id, qty, kind, sale_id, unit_cost_cents, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    shopId,
    itemId,
    qty,
    kind,
    opts.saleId ?? null,
    opts.unitCost ?? null,
    opts.notes ?? null,
    opts.userId ?? null,
    nowIso(),
  ]);
}

/** Baixa da venda: cada produto controlado sai do estoque (pode ficar negativo; o painel avisa). */
export function stockOutForSale(shopId: number, saleId: number, items: { catalogId: number | null; kind: string; qty: number }[], userId: number | null): void {
  for (const i of items) {
    if (i.kind !== 'product' || !i.catalogId) continue;
    const p = get<{ track_stock: number }>('SELECT track_stock FROM catalog_items WHERE id = ?', [i.catalogId]);
    if (p?.track_stock) move(shopId, i.catalogId, -i.qty, 'venda', { saleId, userId });
  }
}

/** Venda cancelada: o que saiu volta para o estoque. */
export function stockBackForSale(shopId: number, saleId: number, userId: number | null): void {
  for (const m of all<{ catalog_item_id: number; qty: number }>("SELECT catalog_item_id, SUM(qty) AS qty FROM stock_moves WHERE sale_id = ? AND kind = 'venda' GROUP BY catalog_item_id", [
    saleId,
  ])) {
    move(shopId, m.catalog_item_id, -m.qty, 'cancelamento', { saleId, userId });
  }
}

/** Separado para clientes em horários que ainda vão acontecer (e não foram fechados). */
export function reservedQty(shopId: number, itemId: number, opts: { exceptAppointmentId?: number; now?: Date } = {}): number {
  return (
    get<{ n: number }>(
      `SELECT COALESCE(SUM(i.qty), 0) AS n FROM appointment_items i JOIN appointments a ON a.id = i.appointment_id
        WHERE i.catalog_item_id = ? AND a.status = 'scheduled' AND a.starts_at >= ? AND a.id <> ?
          AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.appointment_id = a.id AND s.status = 'closed')`,
      [itemId, `${shopNow(shopId, opts.now).date} 00:00`, opts.exceptAppointmentId ?? 0],
    )?.n ?? 0
  );
}

/** Quanto ainda dá para vender/separar: null quando o produto não controla estoque. */
export function availableQty(shopId: number, itemId: number, opts: { exceptAppointmentId?: number; now?: Date } = {}): number | null {
  const p = get<{ track_stock: number; stock_qty: number }>('SELECT track_stock, stock_qty FROM catalog_items WHERE id = ? AND barbershop_id = ?', [itemId, shopId]);
  if (!p?.track_stock) return null;
  return p.stock_qty - reservedQty(shopId, itemId, opts);
}

export interface StockRow {
  id: number;
  name: string;
  price_cents: number;
  cost_cents: number | null;
  active: number;
  track_stock: number;
  stock_qty: number;
  stock_min: number | null;
  reserved: number;
  available: number;
  low: boolean;
}

export function stockList(shopId: number, now?: Date): StockRow[] {
  return all<Omit<StockRow, 'reserved' | 'available' | 'low'>>(
    "SELECT id, name, price_cents, cost_cents, active, track_stock, stock_qty, stock_min FROM catalog_items WHERE barbershop_id = ? AND kind = 'product' ORDER BY track_stock DESC, name COLLATE NOCASE",
    [shopId],
  ).map((p) => {
    const reserved = p.track_stock ? reservedQty(shopId, p.id, { now }) : 0;
    return { ...p, reserved, available: p.stock_qty - reserved, low: Boolean(p.track_stock) && p.stock_qty <= (p.stock_min ?? 0) };
  });
}

/** Produtos acabando (estoque no mínimo ou abaixo). */
export const lowStock = (shopId: number) =>
  all<{ id: number; name: string; stock_qty: number; stock_min: number | null }>(
    "SELECT id, name, stock_qty, stock_min FROM catalog_items WHERE barbershop_id = ? AND kind = 'product' AND track_stock = 1 AND active = 1 AND stock_qty <= COALESCE(stock_min, 0) ORDER BY stock_qty",
    [shopId],
  );

export interface EntryItem {
  catalog_item_id: number;
  qty: number;
  unit_cost_cents?: number | null;
}

/**
 * Entrada de mercadoria (compra). Liga o controle de estoque do produto se ainda não estava e,
 * se pedido, lança a compra no caixa como "Produtos e estoque" (paga ou a pagar).
 */
export function stockEntry(
  shopId: number,
  items: EntryItem[],
  opts: { supplier?: string | null; cash?: { status: 'paid' | 'pending'; date: string; method: string | null } | null; userId: number | null; now?: Date },
): { total_cents: number; cash_entry_id: number | null } {
  if (!items.length) throw new HttpError(400, 'Inclua pelo menos um produto.');
  return tx(() => {
    let total = 0;
    const names: string[] = [];
    for (const i of items) {
      const p = product(shopId, i.catalog_item_id);
      if (!p.track_stock) run('UPDATE catalog_items SET track_stock = 1 WHERE id = ?', [p.id]);
      if (i.unit_cost_cents != null) run('UPDATE catalog_items SET cost_cents = ? WHERE id = ?', [i.unit_cost_cents, p.id]);
      move(shopId, p.id, i.qty, 'compra', { unitCost: i.unit_cost_cents ?? null, notes: opts.supplier ?? null, userId: opts.userId });
      total += (i.unit_cost_cents ?? 0) * i.qty;
      names.push(`${i.qty} ${p.name}`);
    }
    let cashId: number | null = null;
    if (opts.cash && total > 0) {
      cashId = run(
        `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, created_by, created_at)
         VALUES (?, 'out', 'Produtos e estoque', ?, ?, ?, ?, ?, ?, ?)`,
        [shopId, `Compra${opts.supplier ? ` (${opts.supplier})` : ''}: ${names.join(', ')}`.slice(0, 200), total, opts.cash.method, opts.cash.date, opts.cash.status, opts.userId, nowIso()],
      ).lastInsertRowid;
    }
    return { total_cents: total, cash_entry_id: cashId };
  });
}

/** Ajuste: contagem (nova quantidade) ou saída por perda/uso interno. */
export function adjustStock(shopId: number, itemId: number, input: { kind: 'ajuste' | 'perda' | 'uso'; qty: number; notes?: string | null; userId: number | null }): StockRow {
  return tx(() => {
    const p = product(shopId, itemId);
    if (!p.track_stock) run('UPDATE catalog_items SET track_stock = 1 WHERE id = ?', [p.id]);
    // Contagem: qty é a quantidade que tem na prateleira; perda e uso: quanto saiu.
    const delta = input.kind === 'ajuste' ? input.qty - p.stock_qty : -Math.abs(input.qty);
    move(shopId, p.id, delta, input.kind, { notes: input.notes ?? null, userId: input.userId });
    return stockList(shopId).find((r) => r.id === p.id)!;
  });
}

export function stockMoves(shopId: number, itemId?: number) {
  return all(
    `SELECT m.id, m.catalog_item_id, c.name, m.qty, m.kind, m.sale_id, m.unit_cost_cents, m.notes, m.created_at
       FROM stock_moves m JOIN catalog_items c ON c.id = m.catalog_item_id
      WHERE m.barbershop_id = ? ${itemId ? 'AND m.catalog_item_id = ?' : ''} ORDER BY m.id DESC LIMIT 100`,
    itemId ? [shopId, itemId] : [shopId],
  );
}
