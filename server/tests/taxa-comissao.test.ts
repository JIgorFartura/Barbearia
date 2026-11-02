import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-taxa-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { nowIso, run } = await import('../db.js');
const { createSale, saveCommissionFees } = await import('../finance.js');

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
const paulo = run("INSERT INTO barbers (barbershop_id, name, service_commission, product_commission, created_at) VALUES (?, 'Paulo', 50, 10, ?)", [shopId, nowIso()]).lastInsertRowid;
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, 'service', 'Corte', 10000, ?)", [shopId, nowIso()]).lastInsertRowid;
const barba = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, 'service', 'Barba', 4000, ?)", [shopId, nowIso()]).lastInsertRowid;
// Barba com comissão fixa de R$ 15: a taxa não mexe nela.
run("INSERT INTO barber_service_rates (barber_id, service_id, mode, value) VALUES (?, ?, 'fixed', 1500)", [paulo, barba]);
const sell = (method: 'dinheiro' | 'credito' | 'debito' | 'pix', item = corte) =>
  createSale({ shopId, userId: null, items: [{ catalog_item_id: item, qty: 1, barber_id: paulo }], method }).sale.items[0].commission_cents;

describe('taxa da maquininha antes da comissão', () => {
  test('desligada (o padrão): comissão sobre o valor cheio', () => {
    assert.equal(sell('credito'), 5000);
  });

  test('ligada: cada forma de pagamento tira a taxa dela antes da comissão em %', () => {
    saveCommissionFees(shopId, { enabled: true, debito_pct: 1.5, credito_pct: 4, pix_pct: 0 });
    assert.equal(sell('credito'), 4800, '50% de R$ 96');
    assert.equal(sell('debito'), 4925, '50% de R$ 98,50');
    assert.equal(sell('pix'), 5000);
    assert.equal(sell('dinheiro'), 5000);
    assert.equal(sell('credito', barba), 1500, 'comissão fixa não muda');
  });
});
