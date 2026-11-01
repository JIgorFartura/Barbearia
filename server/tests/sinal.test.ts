import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-sinal-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { book, cancel } = await import('../scheduling.js');
const { confirmCharge } = await import('../charges.js');
const { createSale } = await import('../finance.js');
const { appointmentDeposit, expireDeposits, needsDeposit, requireDeposit, saveDepositSettings } = await import('../deposits.js');
const { addDays, localNow } = await import('../time.js');

let server: Server;
let base = '';
const cliente = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const asked = await cliente('POST', '/api/public/shops/navalha/login/code', { phone: '11999990000' });
  await cliente('POST', '/api/public/shops/navalha/login/verify', { phone: '11999990000', code: asked.data.demoCode });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, pix_key, pix_name, pix_city, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'chave@navalha.com', 'Navalha', 'SAO PAULO', ?)", [
  nowIso(),
]).lastInsertRowid;
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [paulo, d]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]).lastInsertRowid;
const joao = run("INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, 'João Pereira', '11999990000', ?, ?)", [shopId, nowIso(), nowIso()]).lastInsertRowid;
const ana = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Ana Lima', '11988880000', ?)", [shopId, nowIso()]).lastInsertRowid;
const today = localNow().date;
// O João faltou duas vezes no último mês.
for (const d of [-20, -10]) {
  run("INSERT INTO appointments (barbershop_id, customer_id, barber_id, service_name, price_cents, starts_at, ends_at, status, source, created_at) VALUES (?, ?, ?, 'Corte', 5000, ?, ?, 'no_show', 'cliente', ?)", [
    shopId,
    joao,
    paulo,
    `${addDays(today, d)} 10:00`,
    `${addDays(today, d)} 10:30`,
    nowIso(),
  ]);
}
const D = addDays(today, 3);
const slot = (time: string, customerId = joao) => book({ shopId, customerId, barberId: paulo, serviceId: corte, date: D, time, source: 'cliente' });

describe('sinal só para quem falta', () => {
  test('desligado (o padrão), ninguém paga sinal', () => {
    assert.equal(needsDeposit(shopId, joao, `${D} 10:00`), false);
  });

  test('ligado em 2 faltas: o João paga pelo app, a Ana (sem faltas) não', async () => {
    saveDepositSettings(shopId, { deposit_no_shows: 2, deposit_cents: 2000, deposit_hold_min: 60 });
    const r = await cliente('POST', '/api/customer/navalha/appointments', { barber_id: paulo, service_id: corte, date: D, time: '10:00' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.deepEqual([r.data.deposit.status, r.data.deposit.amount_cents], ['open', 2000]);
    assert.match(r.data.deposit.pix.payload, /^000201/);
    assert.equal(needsDeposit(shopId, ana, `${D} 11:00`), false);
    const me = (await cliente('GET', '/api/customer/navalha/me')).data;
    assert.equal(me.upcoming[0].deposit.amount_cents, 2000);
  });

  test('sem pagar no prazo, a vaga é liberada e o cliente é avisado', async () => {
    const a = get<{ id: number }>("SELECT id FROM appointments WHERE customer_id = ? AND status = 'scheduled'", [joao])!;
    assert.equal(await expireDeposits(shopId, new Date(Date.now() + 61 * 60000)), 1);
    assert.equal(get<{ status: string }>('SELECT status FROM appointments WHERE id = ?', [a.id])!.status, 'cancelled');
    assert.match(get<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 1", [joao])!.body, /sinal não foi pago no prazo/);
  });

  test('pago, é abatido no fechamento: só o resto entra no caixa', () => {
    const a = slot('14:00');
    const dep = requireDeposit(shopId, a.id)!;
    confirmCharge(shopId, dep.id, { method: 'pix', userId: null });
    const { sale } = createSale({ shopId, userId: null, appointmentId: a.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'dinheiro' });
    assert.deepEqual([sale.total_cents, sale.prepaid_cents], [5000, 2000]);
    const cash = (cat: string) => get<{ s: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM cash_entries WHERE category = ?', [cat])!.s;
    assert.deepEqual([cash('Sinal'), cash('Atendimentos')], [2000, 3000]);
  });

  test('cancelou com antecedência: vira crédito e já vale para o próximo horário', () => {
    const a = slot('15:00');
    confirmCharge(shopId, requireDeposit(shopId, a.id)!.id, { method: 'pix', userId: null });
    cancel(shopId, a.id, { customerId: joao });
    const b = slot('16:00');
    const credit = requireDeposit(shopId, b.id)!;
    assert.equal(credit.status, 'paid', 'usa o sinal já pago');
    assert.equal(appointmentDeposit(b.id)!.id, credit.id);
  });

  test('cancelou em cima da hora: o sinal fica com a barbearia', () => {
    const b = get<{ id: number }>("SELECT id FROM appointments WHERE customer_id = ? AND status = 'scheduled' ORDER BY id DESC LIMIT 1", [joao])!;
    cancel(shopId, b.id, { customerId: joao, now: new Date(`${D}T15:00:00-03:00`) });
    const c = get<{ forfeited_at: string | null }>("SELECT forfeited_at FROM charges WHERE kind = 'sinal' AND status = 'paid' ORDER BY id DESC LIMIT 1")!;
    assert.ok(c.forfeited_at);
  });
});
