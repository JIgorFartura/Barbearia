import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-equipe-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { notifyOwners } = await import('../platform.js');
const { addDays, localNow } = await import('../time.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const desk = makeClient(() => base);
const master = makeClient(() => base);
const rita = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
  await rita('POST', '/api/auth/login', { login: 'rita@tesoura.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
const tesoura = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('tesoura', 'Tesoura Fina', 'Zé', ?)", [nowIso()]).lastInsertRowid;
const user = (shop: number | null, role: string, name: string, email: string, phone: string | null = null) =>
  run('INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    shop,
    role,
    name,
    email,
    phone,
    hashPassword('senha-forte-1'),
    nowIso(),
    nowIso(),
  ]).lastInsertRowid;
const carlos = user(shopId, 'owner', 'Carlos', 'carlos@navalha.com', '11977776666');
user(tesoura, 'owner', 'Rita', 'rita@tesoura.com');
user(null, 'master', 'Igor', 'igor@exemplo.com');
const paulo = run('INSERT INTO barbers (barbershop_id, name, service_commission, created_at) VALUES (?, ?, 40, ?)', [shopId, 'Paulo', nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [paulo, d]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const D = addDays(localNow().date, 2);

describe('recepção', () => {
  test('o dono cria o login da recepção', async () => {
    const r = await owner('POST', '/api/shop/reception', { name: 'Bruna', phone: '11966665555', password: 'recepcao-123' });
    assert.equal(r.status, 201);
    assert.equal(r.data.length, 1);
    assert.equal((await owner('POST', '/api/shop/reception', { name: 'Outra', phone: '11966665555', password: 'recepcao-123' })).status, 409, 'celular já usado');
    assert.equal((await rita('GET', '/api/shop/reception')).data.length, 0, 'cada barbearia vê só a sua');
    const login = await desk('POST', '/api/auth/login', { login: '11966665555', password: 'recepcao-123' });
    assert.equal(login.status, 200);
    assert.equal((await desk('GET', '/api/auth/me')).data.user.role, 'reception');
  });

  test('agenda, clientes, comanda e pacotes: sim; sem comissões nem mensalidade', async () => {
    const agenda = await desk('GET', `/api/shop/agenda?date=${D}`);
    assert.equal(agenda.status, 200);
    assert.deepEqual(Object.keys(agenda.data.barbers[0]).sort(), ['active', 'blocks', 'hours', 'id', 'name', 'photo_url'], 'sem comissão nem login do barbeiro');
    const c = await desk('POST', '/api/shop/customers', { name: 'João Pereira', phone: '11999990000' });
    assert.equal(c.status, 201);
    const a = await desk('POST', '/api/shop/appointments', { customer_id: c.data.id, barber_id: paulo, service_id: corte, date: D, time: '10:00' });
    assert.equal(a.status, 201);
    assert.equal((await desk('POST', `/api/shop/appointments/${a.data.id}/confirm`, { confirmed: true })).status, 200);
    assert.equal((await desk('GET', `/api/shop/finance/checkout?appointment_id=${a.data.id}`)).status, 200);
    const sale = await desk('POST', '/api/shop/finance/sales', { appointment_id: a.data.id, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo }], method: 'pix' });
    assert.equal(sale.status, 201);
    assert.equal(sale.data.sale.items[0].commission_cents, 0, 'a recepção não vê a comissão');
    assert.equal(get<{ v: number }>('SELECT commission_cents AS v FROM sale_items WHERE sale_id = ?', [sale.data.sale.id])!.v, 2000, 'mas ela é calculada');
    const status = (await desk('GET', '/api/shop/status')).data;
    assert.equal(status.pixToConfirm, 0);
    assert.equal(status.openInvoices, 0);
    assert.equal((await desk('GET', '/api/shop/prepaid')).status, 200);
  });

  test('financeiro, relatórios, configurações, LGPD e equipe: não', async () => {
    const denied = [
      ['GET', '/api/shop/finance/summary?from=2026-01-01&to=2026-12-31'],
      ['GET', '/api/shop/finance/sales?from=2026-01-01&to=2026-12-31'],
      ['GET', '/api/shop/reports'],
      ['GET', '/api/shop/barbers'],
      ['GET', '/api/shop/bot'],
      ['GET', '/api/shop/subscription'],
      ['GET', '/api/shop/customers/1/export'],
      ['POST', '/api/shop/customers/1/anonymize'],
      ['POST', '/api/shop/packages'],
      ['GET', '/api/shop/reception'],
      ['POST', '/api/shop/units'],
      ['GET', '/api/shop/network'],
      ['GET', '/api/shop/summary'],
      ['GET', '/api/shop/charges/to-confirm'],
      ['GET', '/api/barber/agenda'],
      ['GET', '/api/master/shops'],
    ] as const;
    for (const [method, url] of denied) assert.equal((await desk(method, url, method === 'POST' ? {} : undefined)).status, 403, `${method} ${url}`);
  });

  test('trocar a senha derruba a sessão; tirar o acesso apaga o login', async () => {
    const id = (await owner('GET', '/api/shop/reception')).data[0].id;
    assert.equal((await owner('PUT', `/api/shop/reception/${id}/password`, { password: 'nova-senha-123' })).status, 200);
    assert.equal((await desk('GET', '/api/shop/agenda')).status, 401);
    assert.equal((await rita('DELETE', `/api/shop/reception/${id}`)).status, 404, 'outra barbearia não mexe');
    assert.equal((await owner('DELETE', `/api/shop/reception/${id}`)).status, 200);
    assert.equal((await desk('POST', '/api/auth/login', { login: '11966665555', password: 'nova-senha-123' })).status, 401);
  });
});

describe('rede com filiais', () => {
  let filial = 0;

  test('o dono abre uma nova unidade e troca de unidade no painel', async () => {
    const r = await owner('POST', '/api/shop/units', { name: 'Navalha de Ouro – Centro' });
    assert.equal(r.status, 201);
    filial = r.data.id;
    assert.equal(get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [filial])!.slug, 'navalha-de-ouro-centro');
    assert.ok(get<{ trial_until: string | null }>('SELECT trial_until FROM barbershops WHERE id = ?', [filial])!.trial_until, 'começa nos dias grátis');
    const units = (await owner('GET', '/api/auth/units')).data;
    assert.deepEqual(
      units.units.map((u: { name: string }) => u.name),
      ['Navalha de Ouro', 'Navalha de Ouro – Centro'],
    );
    assert.equal(units.current, shopId);

    assert.equal((await owner('POST', '/api/auth/units/switch', { shop_id: filial })).status, 200);
    assert.equal((await owner('GET', '/api/auth/me')).data.shop.id, filial);
    assert.equal((await owner('GET', `/api/shop/agenda?date=${D}`)).data.barbers.length, 0, 'a filial tem a agenda dela');
    const net = (await owner('GET', '/api/shop/network')).data;
    assert.equal(net.units.length, 2);
    assert.equal(net.units.find((u: { id: number }) => u.id === shopId).today.income, 5000, 'o corte de hoje da matriz');
    assert.equal((await owner('POST', '/api/auth/units/switch', { shop_id: shopId })).status, 200);
    assert.equal((await owner('GET', '/api/auth/me')).data.shop.id, shopId);
  });

  test('ninguém troca para uma unidade que não é dele', async () => {
    assert.equal((await owner('POST', '/api/auth/units/switch', { shop_id: tesoura })).status, 404);
    assert.equal((await rita('POST', '/api/auth/units/switch', { shop_id: filial })).status, 404);
    assert.equal((await master('GET', '/api/auth/units')).status, 403);
    // Sessão com unidade forjada no banco: vale a casa do login.
    run('UPDATE sessions SET acting_shop_id = ? WHERE user_id = ?', [tesoura, carlos]);
    assert.equal((await owner('GET', '/api/auth/me')).data.shop.id, shopId);
    run('UPDATE sessions SET acting_shop_id = NULL WHERE user_id = ?', [carlos]);
  });

  test('os avisos da filial chegam ao dono da rede; o master liga um dono existente a outra barbearia', async () => {
    await notifyOwners(filial, 'Teste de aviso da filial');
    assert.ok(get("SELECT 1 AS ok FROM platform_messages WHERE user_id = ? AND body = 'Teste de aviso da filial'", [carlos]));
    assert.equal((await master('POST', `/api/master/shops/${tesoura}/link-owner`, { email: 'nao-existe@x.com' })).status, 404);
    assert.equal((await master('POST', `/api/master/shops/${tesoura}/link-owner`, { email: 'carlos@navalha.com' })).status, 201);
    assert.equal((await owner('GET', '/api/auth/units')).data.units.length, 3);
    assert.equal(all('SELECT 1 FROM shop_members WHERE user_id = ?', [carlos]).length, 2);
  });
});
