import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-estoque-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book } = await import('../scheduling.js');
const { createSale, cancelSale } = await import('../finance.js');
const { reserveItems, suggestionFor } = await import('../consumption.js');
const { buildContext } = await import('../bot/brain.js');
const { shopBot } = await import('../messaging.js');
const { availableQty } = await import('../stock.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [paulo, d]);
run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]);
const beer = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, 'product', 'Cerveja', 1200, ?)", [shopId, nowIso()]).lastInsertRowid;
const joao = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'João Pereira', '11999990000', ?)", [shopId, nowIso()]).lastInsertRowid;
const stock = () => get<{ stock_qty: number; track_stock: number }>('SELECT stock_qty, track_stock FROM catalog_items WHERE id = ?', [beer])!;


describe('estoque', () => {
  test('entrada de mercadoria liga o controle, soma o estoque e lança a compra no caixa', async () => {
    const r = await owner('POST', '/api/shop/stock/entries', {
      items: [{ catalog_item_id: beer, qty: 12, unit_cost_cents: 450 }],
      supplier: 'Distribuidora Sul',
      cash: { status: 'pending', date: '2026-11-10', method: null },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.total_cents, 5400);
    assert.deepEqual(stock(), { stock_qty: 12, track_stock: 1 });
    const cash = get<{ category: string; amount_cents: number; status: string; description: string }>('SELECT category, amount_cents, status, description FROM cash_entries WHERE id = ?', [
      r.data.cash_entry_id,
    ])!;
    assert.equal(cash.category, 'Produtos e estoque');
    assert.equal(cash.amount_cents, 5400);
    assert.equal(cash.status, 'pending');
    assert.match(cash.description, /Distribuidora Sul.*12 Cerveja/);
  });

  test('a venda dá baixa e o cancelamento devolve', () => {
    const { sale } = createSale({ shopId, userId: null, customerId: joao, items: [{ catalog_item_id: beer, qty: 3 }], method: 'pix' });
    assert.equal(stock().stock_qty, 9);
    cancelSale(shopId, sale.id);
    assert.equal(stock().stock_qty, 12);
  });

  test('contagem e perda ajustam o estoque com histórico', async () => {
    assert.equal((await owner('POST', `/api/shop/stock/${beer}/adjust`, { kind: 'ajuste', qty: 10, notes: 'contagem de sexta' })).data.stock_qty, 10);
    assert.equal((await owner('POST', `/api/shop/stock/${beer}/adjust`, { kind: 'perda', qty: 1, notes: 'garrafa quebrou' })).data.stock_qty, 9);
    const moves = (await owner('GET', `/api/shop/stock/${beer}/moves`)).data as { kind: string; qty: number }[];
    assert.deepEqual(
      moves.slice(0, 2).map((m) => [m.kind, m.qty]),
      [
        ['perda', -1],
        ['ajuste', -2],
      ],
    );
  });

  test('o que está separado para um horário conta como reservado; o robô não oferece o que acabou', async () => {
    const now = new Date('2026-11-02T12:00:00Z');
    // João costuma tomar 2 cervejas.
    for (const day of ['2026-10-02', '2026-10-09']) createSale({ shopId, userId: null, customerId: joao, items: [{ catalog_item_id: beer, qty: 2 }], method: 'pix', now: new Date(`${day}T15:00:00Z`) });
    run('UPDATE catalog_items SET stock_qty = 3 WHERE id = ?', [beer]);
    const first = book({ shopId, customerId: joao, barberId: paulo, date: '2026-11-03', time: '10:00', source: 'painel', now });
    assert.ok(suggestionFor(shopId, first.id, now), 'tem 3, ele costuma tomar 2: oferece');
    await reserveItems(shopId, first.id, [{ productId: beer, qty: 2 }], 'cliente', { now, dryRun: true });
    assert.equal(availableQty(shopId, beer, { now }), 1);

    const second = book({ shopId, customerId: joao, barberId: paulo, date: '2026-11-04', time: '10:00', source: 'painel', now });
    assert.equal(suggestionFor(shopId, second.id, now), null, 'só sobrou 1: não oferece 2');
    await assert.rejects(reserveItems(shopId, second.id, [{ productId: beer, qty: 2 }], 'whatsapp', { now, dryRun: true }), /Só tem 1 cerveja disponível/);
    await reserveItems(shopId, second.id, [{ productId: beer, qty: 2 }], 'painel', { now, dryRun: true });
    assert.equal(availableQty(shopId, beer, { now }), -1);
    assert.match(buildContext({ shop: shopBot(shopId), phone: '11999990000', waId: null, customer: null, profileName: null, now, dryRun: true }), /Cerveja \(produto_id \d+, R\$\s12,00, ESGOTADO/);
  });

  test('estoque baixo aparece no resumo; editar o produto mantém o controle', async () => {
    run('UPDATE catalog_items SET stock_qty = 2, stock_min = 6 WHERE id = ?', [beer]);
    const summary = (await owner('GET', '/api/shop/summary')).data;
    assert.deepEqual(
      summary.lowStock.map((p: { name: string; stock_qty: number }) => [p.name, p.stock_qty]),
      [['Cerveja', 2]],
    );
    const saved = await owner('PUT', `/api/shop/catalog/${beer}`, {
      kind: 'product',
      name: 'Cerveja long neck',
      price_cents: 1300,
      description: null,
      image_url: null,
      active: true,
      track_stock: true,
      stock_min: 6,
      cost_cents: 450,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.track_stock, 1);
    assert.equal(saved.data.stock_qty, 2, 'a quantidade não muda pelo cadastro');
    const checkout = (await owner('GET', '/api/shop/finance/checkout')).data.catalog as { id: number; available: number | null }[];
    assert.equal(checkout.find((c) => c.id === beer)!.available, 2 - 4, 'desconta o que está separado');
  });
});
