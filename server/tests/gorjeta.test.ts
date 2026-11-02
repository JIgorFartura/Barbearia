import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-gorjeta-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { all, nowIso, run } = await import('../db.js');
const { barberStatement, cancelSale, commissionBalances, createPayout, createSale } = await import('../finance.js');
const { localNow } = await import('../time.js');

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
const barber = (name: string) => run('INSERT INTO barbers (barbershop_id, name, service_commission, created_at) VALUES (?, ?, 50, ?)', [shopId, name, nowIso()]).lastInsertRowid;
const paulo = barber('Paulo');
const marcos = barber('Marcos');
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]).lastInsertRowid;
const today = localNow().date;

describe('gorjeta na comanda', () => {
  test('vai inteira para quem fez o serviço, entra no caixa à parte e fica fora do total da venda', () => {
    const { sale } = createSale({ shopId, userId: null, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo }], tipCents: 1000, method: 'pix' });
    assert.deepEqual([sale.total_cents, sale.tip_cents, sale.tip_barber_name], [5000, 1000, 'Paulo']);
    assert.deepEqual(
      all<{ category: string; amount_cents: number }>('SELECT category, amount_cents FROM cash_entries WHERE sale_id = ? ORDER BY id', [sale.id]).map((e) => [e.category, e.amount_cents]),
      [
        ['Atendimentos', 5000],
        ['Gorjetas', 1000],
      ],
    );
    const p = commissionBalances(shopId).find((b) => b.barber_id === paulo)!;
    // 50% de R$ 50 (comissão) + R$ 10 de gorjeta.
    assert.deepEqual([p.unpaid_cents, p.tips_cents], [3500, 1000]);
    const st = barberStatement(shopId, paulo, today, today);
    assert.deepEqual(st.items.map((i) => `${i.kind}:${i.commission_cents}`).sort(), ['gorjeta:1000', 'service:2500']);
    assert.equal(st.revenue, 5000, 'gorjeta não conta como faturamento');
  });

  test('com dois barbeiros na comanda, escolhe-se quem recebe', () => {
    const { sale } = createSale({
      shopId,
      userId: null,
      items: [
        { catalog_item_id: corte, qty: 1, barber_id: paulo },
        { catalog_item_id: corte, qty: 1, barber_id: marcos },
      ],
      tipCents: 500,
      tipBarberId: marcos,
      method: 'dinheiro',
    });
    assert.equal(sale.tip_barber_name, 'Marcos');
    assert.equal(commissionBalances(shopId).find((b) => b.barber_id === marcos)!.tips_cents, 500);
  });

  test('o pagamento ao barbeiro leva as gorjetas; depois disso a venda não cancela mais', () => {
    const payout = createPayout({ shopId, barberId: paulo, until: today, method: 'pix', notes: null, userId: null });
    assert.equal(payout.amount_cents, 3500 + 2500, 'as duas comissões de R$ 25 e a gorjeta de R$ 10');
    assert.equal(commissionBalances(shopId).find((b) => b.barber_id === paulo)!.unpaid_cents, 0);
    const first = all<{ id: number }>('SELECT id FROM sales ORDER BY id LIMIT 1')[0].id;
    assert.throws(() => cancelSale(shopId, first), /já foi paga/);
  });

  test('venda cancelada leva a gorjeta junto', () => {
    const { sale } = createSale({ shopId, userId: null, items: [{ catalog_item_id: corte, qty: 1, barber_id: marcos }], tipCents: 700, method: 'pix' });
    const before = commissionBalances(shopId).find((b) => b.barber_id === marcos)!.tips_cents;
    cancelSale(shopId, sale.id);
    assert.equal(commissionBalances(shopId).find((b) => b.barber_id === marcos)!.tips_cents, before - 700);
    assert.equal(all('SELECT 1 FROM cash_entries WHERE sale_id = ?', [sale.id]).length, 0);
  });
});
