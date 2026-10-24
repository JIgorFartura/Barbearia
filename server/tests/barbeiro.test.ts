import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-barbeiro-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book } = await import('../scheduling.js');
const { shopNow } = await import('../clock.js');
const { addDays } = await import('../time.js');

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
const barber = (name: string, pct: number) => {
  const id = run('INSERT INTO barbers (barbershop_id, name, service_commission, product_commission, created_at) VALUES (?, ?, ?, 10, ?)', [shopId, name, pct, nowIso()]).lastInsertRowid;
  for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '06:00', '23:30')", [id, d]);
  return id;
};
const paulo = barber('Paulo', 40);
const marcos = barber('Marcos', 50);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]).lastInsertRowid;
const joao = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'João Pereira', '11999990000', ?)", [shopId, nowIso()]).lastInsertRowid;
const ana = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Ana Lima', '11988880000', ?)", [shopId, nowIso()]).lastInsertRowid;
// Horários de amanhã: um com o Paulo, outro com o Marcos.
const tomorrow = addDays(shopNow(shopId).date, 1);
const withPaulo = book({ shopId, customerId: joao, barberId: paulo, serviceId: corte, date: tomorrow, time: '10:00', source: 'painel' });
const withMarcos = book({ shopId, customerId: ana, barberId: marcos, serviceId: corte, date: tomorrow, time: '10:00', source: 'painel' });

describe('acesso do barbeiro', () => {
  const paul = makeClient(() => base);

  test('o dono cria o acesso do Paulo; o Paulo entra pelo celular', async () => {
    const created = await owner('POST', `/api/shop/barbers/${paulo}/access`, { phone: '(11) 95555-4444', email: '', password: 'paulo-senha-1' });
    assert.equal(created.status, 201);
    assert.equal(created.data.find((b: { id: number }) => b.id === paulo).access.phone, '11955554444');
    assert.equal((await owner('POST', `/api/shop/barbers/${paulo}/access`, { phone: '11955554444', password: 'outra-senha-1' })).status, 409);
    assert.equal((await owner('POST', `/api/shop/barbers/${marcos}/access`, { phone: '11955554444', password: 'outra-senha-1' })).status, 409, 'celular já usado');

    assert.equal((await paul('POST', '/api/auth/login', { login: '11955554444', password: 'paulo-senha-1' })).status, 200);
    const me = (await paul('GET', '/api/auth/me')).data.user;
    assert.equal(me.role, 'barber');
    assert.equal(me.barberId, paulo);
    assert.equal((await paul('GET', '/api/shop/finance/summary')).status, 403, 'barbeiro não vê o caixa');
    assert.equal((await paul('GET', '/api/master/shops')).status, 403);
  });

  test('vê só a própria agenda e fecha só os próprios atendimentos', async () => {
    const agenda = (await paul('GET', `/api/barber/agenda?date=${tomorrow}`)).data;
    assert.deepEqual(
      agenda.appointments.map((a: { id: number; customer_name: string }) => [a.id, a.customer_name]),
      [[withPaulo.id, 'João Pereira']],
    );
    assert.equal((await paul('GET', `/api/barber/checkout?appointment_id=${withMarcos.id}`)).status, 404);
    const checkout = (await paul('GET', `/api/barber/checkout?appointment_id=${withPaulo.id}`)).data;
    assert.deepEqual(checkout.barbers, [{ id: paulo, name: 'Paulo' }]);

    const stolen = await paul('POST', '/api/barber/sales', { appointment_id: withPaulo.id, items: [{ catalog_item_id: corte, qty: 1, barber_id: marcos }], method: 'pix' });
    assert.equal(stolen.status, 403);
    const sale = await paul('POST', '/api/barber/sales', { appointment_id: withPaulo.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix' });
    assert.equal(sale.status, 201);
    assert.equal(sale.data.sale.items[0].barber_id, paulo);
    assert.equal(sale.data.sale.items[0].commission_cents, 2000);
    assert.equal((await paul('POST', '/api/barber/sales', { appointment_id: withMarcos.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix' })).status, 404);
  });

  test('meus ganhos: comissão em aberto e extrato só dele', async () => {
    const e = (await paul('GET', `/api/barber/earnings?from=${addDays(tomorrow, -2)}&to=${addDays(tomorrow, 1)}`)).data;
    assert.equal(e.balance.unpaid_cents, 2000);
    assert.equal(e.items.length, 1);
    assert.equal(e.commission, 2000);
  });

  test('o dono pode impedir o fechamento, desativar o barbeiro e trocar a senha', async () => {
    await owner('PUT', '/api/shop/barber-settings', { barber_can_close: false });
    assert.equal((await paul('GET', '/api/barber/me')).data.canClose, false);
    assert.equal((await paul('GET', `/api/barber/checkout?appointment_id=${withPaulo.id}`)).status, 403);
    await owner('PUT', '/api/shop/barber-settings', { barber_can_close: true });

    run('UPDATE barbers SET active = 0 WHERE id = ?', [paulo]);
    assert.equal((await paul('GET', '/api/barber/me')).status, 403);
    run('UPDATE barbers SET active = 1 WHERE id = ?', [paulo]);

    assert.equal((await owner('PUT', `/api/shop/barbers/${paulo}/access`, { password: 'senha-nova-99' })).status, 200);
    assert.equal((await paul('GET', '/api/barber/me')).status, 401, 'senha trocada derruba a sessão');
    const again = makeClient(() => base);
    assert.equal((await again('POST', '/api/auth/login', { login: '11955554444', password: 'senha-nova-99' })).status, 200);

    await owner('DELETE', `/api/shop/barbers/${paulo}/access`);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'barber'")!.n, 0);
    assert.equal((await again('GET', '/api/barber/me')).status, 401);
  });
});
