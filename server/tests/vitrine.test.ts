import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-vitrine-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { book } = await import('../scheduling.js');
const { shopNow } = await import('../clock.js');
const { addDays } = await import('../time.js');

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

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
const marcos = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Marcos', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '18:00')", [marcos, d]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const product = (name: string, price: number, extra: { stock?: number; active?: boolean } = {}) =>
  run(
    "INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, track_stock, stock_qty, active, created_at) VALUES (?, 'product', ?, ?, ?, ?, ?, ?)",
    [shopId, name, price, extra.stock == null ? 0 : 1, extra.stock ?? 0, extra.active === false ? 0 : 1, nowIso()],
  ).lastInsertRowid;
const pomada = product('Pomada modeladora', 4500, { stock: 2 });
const oleo = product('Óleo para barba', 3900, { stock: 0 });
product('Pente', 1500);
product('Tônico antigo', 2000, { active: false });
const burger = run(
  "INSERT INTO partners (barbershop_id, name, category, benefit, created_at) VALUES (?, 'Burger da Esquina', 'Hamburgueria', '10% no combo', ?)",
  [shopId, nowIso()],
).lastInsertRowid;
run("INSERT INTO partners (barbershop_id, name, active, created_at) VALUES (?, 'Parceiro oculto', 0, ?)", [shopId, nowIso()]);
const today = shopNow(shopId).date;
const ad = (title: string, placement: string, extra: { ends_on?: string } = {}) =>
  run('INSERT INTO ads (barbershop_id, partner_id, title, link_url, placement, ends_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    shopId,
    burger,
    title,
    'https://burger.exemplo.com',
    placement,
    extra.ends_on ?? null,
    nowIso(),
  ]).lastInsertRowid;
const destaque = ad('Combo do barbeado', 'destaque');
const mural = ad('Terça do hambúrguer', 'mural');
ad('Promoção vencida', 'mural', { ends_on: addDays(today, -1) });
const joao = run("INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, 'João Pereira', '11999990000', ?, ?)", [
  shopId,
  nowIso(),
  nowIso(),
]).lastInsertRowid;

describe('vitrine no app do cliente', () => {
  test('mostra os produtos à venda (com o que tem), os parceiros e os anúncios no ar; cada abertura conta uma visualização', async () => {
    const r = await cliente('GET', '/api/customer/navalha/vitrine');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(
      r.data.products.map((p: { name: string; available: number | null }) => [p.name, p.available]),
      [
        ['Pente', null],
        ['Pomada modeladora', 2],
        ['Óleo para barba', 0],
      ],
    );
    assert.deepEqual(
      r.data.partners.map((p: { name: string }) => p.name),
      ['Burger da Esquina'],
    );
    assert.deepEqual(
      r.data.ads.map((a: { title: string; placement: string; partner: string; hasLink: boolean }) => [a.title, a.placement, a.partner, a.hasLink]),
      [
        ['Combo do barbeado', 'destaque', 'Burger da Esquina', true],
        ['Terça do hambúrguer', 'mural', 'Burger da Esquina', true],
      ],
    );
    assert.equal(r.data.ads[0].link_url, undefined, 'o link de destino só sai pelo contador de cliques');
    await cliente('GET', '/api/customer/navalha/vitrine');
    assert.equal(get<{ views: number }>('SELECT views FROM ads WHERE id = ?', [destaque])!.views, 2);
    assert.equal(get<{ views: number }>('SELECT views FROM ads WHERE id = ?', [mural])!.views, 2);
  });

  test('só quem entrou vê a vitrine', async () => {
    const anon = makeClient(() => base);
    assert.equal((await anon('GET', '/api/customer/navalha/vitrine')).status, 401);
  });

  test('o cliente pede para separar no próximo horário; respeita o estoque', async () => {
    const appt = book({ shopId, customerId: joao, barberId: marcos, serviceId: corte, date: addDays(today, 2), time: '10:00', source: 'cliente' });
    const r = await cliente('POST', `/api/customer/navalha/appointments/${appt.id}/items`, { items: [{ product_id: pomada, qty: 2 }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(
      r.data.items.map((i: { name: string; qty: number }) => [i.name, i.qty]),
      [['Pomada modeladora', 2]],
    );
    const after = (await cliente('GET', '/api/customer/navalha/vitrine')).data.products.find((p: { name: string }) => p.name === 'Pomada modeladora');
    assert.equal(after.available, 0, 'as duas ficaram separadas');
    const sold = await cliente('POST', `/api/customer/navalha/appointments/${appt.id}/items`, { items: [{ product_id: oleo, qty: 1 }] });
    assert.equal(sold.status, 409);
    assert.match(sold.data.error, /acabou/);
    const me = (await cliente('GET', '/api/customer/navalha/me')).data;
    assert.deepEqual(
      me.upcoming[0].items.map((i: { name: string }) => i.name),
      ['Pomada modeladora'],
    );
  });
});
