import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-lgpd-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book } = await import('../scheduling.js');
const { addStamps } = await import('../loyalty.js');
const { purgeOldData } = await import('../privacy.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, address, whatsapp, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'Rua A, 1', '11955550000', ?)", [
  nowIso(),
]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [paulo, d]);
run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]);
const campaign = run("INSERT INTO campaigns (barbershop_id, name, unit_label, goal, reward, created_at) VALUES (?, 'Clube', 'cervejas', 5, 'Copo', ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;

/** Entra na área do cliente pelo código (em demonstração o código vem na resposta). */
async function enter(c: ReturnType<typeof makeClient>, phone: string, name?: string, accept?: boolean) {
  const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone, name, accept });
  if (asked.status !== 200 || asked.data.needsName) return asked;
  return c('POST', '/api/public/shops/navalha/login/verify', { phone, code: asked.data.demoCode });
}

describe('LGPD na área do cliente', () => {
  test('a conta só é criada com o aceite da política de privacidade', async () => {
    const c = makeClient(() => base);
    assert.equal((await enter(c, '11977770000')).data.needsName, true, 'número novo pede o nome');
    const refused = await enter(c, '11977770000', 'Ana Lima');
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /aceite a política de privacidade/);
    assert.equal((await enter(c, '11977770000', 'Ana Lima', true)).status, 200);
    const me = (await c('GET', '/api/customer/navalha/me')).data;
    assert.equal(me.privacyAccepted, true);
  });

  test('cliente antigo aceita depois; baixa os próprios dados', async () => {
    const id = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Bruno Dias', '11966660000', ?)", [shopId, nowIso()]).lastInsertRowid;
    addStamps(shopId, campaign, id, 2, null);
    run("INSERT INTO messages (barbershop_id, customer_id, phone, direction, kind, body, status, created_at) VALUES (?, ?, '11966660000', 'in', 'chat', 'oi João', 'received', ?)", [
      shopId,
      id,
      nowIso(),
    ]);
    const c = makeClient(() => base);
    assert.equal((await enter(c, '11966660000')).status, 200);
    assert.equal((await c('GET', '/api/customer/navalha/me')).data.privacyAccepted, false);
    await c('POST', '/api/customer/navalha/privacy/accept');
    assert.equal((await c('GET', '/api/customer/navalha/me')).data.privacyAccepted, true);

    const data = await c('GET', '/api/customer/navalha/my-data');
    assert.match(data.headers.get('content-disposition') ?? '', /attachment; filename="meus-dados-navalha.json"/);
    assert.equal(data.data.cliente.nome, 'Bruno Dias');
    assert.equal(data.data.fidelidade[0].quantidade, 2);
    assert.equal(data.data.mensagens[0].texto, 'oi João');
  });

  test('excluir a conta apaga os dados pessoais e mantém a venda sem identificação', async () => {
    const id = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Carla Souza', '11955554444', ?)", [shopId, nowIso()]).lastInsertRowid;
    const now = new Date('2026-11-02T12:00:00Z');
    const future = book({ shopId, customerId: id, barberId: paulo, date: '2026-11-10', time: '10:00', source: 'painel', now });
    run("INSERT INTO sales (barbershop_id, customer_id, date, subtotal_cents, total_cents, method, created_at) VALUES (?, ?, '2026-10-20', 5000, 5000, 'pix', ?)", [shopId, id, nowIso()]);
    addStamps(shopId, campaign, id, 1, null);
    const c = makeClient(() => base);
    assert.equal((await enter(c, '11955554444')).status, 200);
    assert.equal((await c('POST', '/api/customer/navalha/delete-account', { confirm: 'sim' })).status, 400);
    assert.equal((await c('POST', '/api/customer/navalha/delete-account', { confirm: 'EXCLUIR' })).status, 200);
    assert.equal((await c('GET', '/api/customer/navalha/me')).status, 401, 'a sessão acaba');

    const row = get<{ name: string; phone: string; anonymized_at: string | null }>('SELECT name, phone, anonymized_at FROM customers WHERE id = ?', [id])!;
    assert.equal(row.name, 'Cliente removido');
    assert.equal(row.phone, `removido-${id}`);
    assert.ok(row.anonymized_at);
    assert.equal(get<{ status: string }>('SELECT status FROM appointments WHERE id = ?', [future.id])!.status, 'cancelled');
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM loyalty_events WHERE customer_id = ?', [id])!.n, 0);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM sales WHERE customer_id = ? AND total_cents = 5000", [id])!.n, 1, 'a venda fica no caixa');

    // O mesmo celular pode voltar como cliente novo (com novo aceite).
    const again = makeClient(() => base);
    assert.equal((await enter(again, '11955554444', 'Carla Souza', true)).status, 200);
  });
});

describe('LGPD no painel e na plataforma', () => {
  test('dono exporta e exclui os dados de um cliente a pedido; excluído some da lista', async () => {
    const id = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Diego Melo', '11944443333', ?)", [shopId, nowIso()]).lastInsertRowid;
    const owner = makeClient(() => base);
    await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
    assert.equal((await owner('GET', `/api/shop/customers/${id}/export`)).data.cliente.nome, 'Diego Melo');
    assert.equal((await owner('POST', `/api/shop/customers/${id}/anonymize`, { confirm: 'EXCLUIR' })).status, 200);
    const list = (await owner('GET', '/api/shop/customers?q=Diego')).data as unknown[];
    assert.equal(list.length, 0);
    assert.equal((await owner('GET', `/api/shop/customers/${id}/export`)).status, 404);
  });

  test('dono aceita os termos no primeiro acesso', async () => {
    const owner = makeClient(() => base);
    await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
    assert.equal((await owner('GET', '/api/auth/me')).data.user.termsAccepted, false);
    await owner('POST', '/api/auth/accept-terms');
    assert.equal((await owner('GET', '/api/auth/me')).data.user.termsAccepted, true);
  });

  test('páginas públicas: dados da empresa e política da barbearia', async () => {
    const master = makeClient(() => base);
    await master('POST', '/api/auth/setup', { name: 'Igor', email: 'igor@exemplo.com', password: 'senha-forte-1' });
    const saved = await master('PUT', '/api/master/legal', { company: 'Barbearia Digital Ltda', document: '12.345.678/0001-90', email: 'privacidade@exemplo.com', address: 'São Paulo/SP' });
    assert.equal(saved.data.company, 'Barbearia Digital Ltda');
    const pub = makeClient(() => base);
    assert.equal((await pub('GET', '/api/public/legal')).data.email, 'privacidade@exemplo.com');
    const policy = (await pub('GET', '/api/public/shops/navalha/privacy')).data;
    assert.equal(policy.shop.name, 'Navalha de Ouro');
    assert.equal(policy.legal.company, 'Barbearia Digital Ltda');
    assert.equal(policy.ai, false);
  });

  test('limpeza diária apaga mensagens de mais de um ano e códigos velhos', () => {
    const old = new Date('2025-01-01T12:00:00Z').toISOString();
    run("INSERT INTO messages (barbershop_id, phone, direction, kind, body, status, created_at) VALUES (?, '11900000000', 'in', 'chat', 'antiga', 'received', ?)", [shopId, old]);
    run("INSERT INTO messages (barbershop_id, phone, direction, kind, body, status, created_at) VALUES (?, '11900000000', 'in', 'chat', 'recente', 'received', ?)", [
      shopId,
      new Date('2026-10-01T12:00:00Z').toISOString(),
    ]);
    const r = purgeOldData(new Date('2026-11-02T12:00:00Z'));
    assert.ok(r.messages >= 1);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE body = 'antiga'")!.n, 0);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE body = 'recente'")!.n, 1);
  });
});
