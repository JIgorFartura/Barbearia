import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-promocao-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { audience, createBroadcast, previewBroadcast, runBroadcast } = await import('../broadcast.js');
const { platformSettings, savePlatformSettings } = await import('../billing.js');
const { addDays, localNow } = await import('../time.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const desk = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await desk('POST', '/api/auth/login', { login: 'recepcao@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
for (const [role, email] of [
  ['owner', 'carlos@navalha.com'],
  ['reception', 'recepcao@navalha.com'],
]) {
  run('INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    shopId,
    role,
    role,
    email,
    hashPassword('senha-forte-1'),
    nowIso(),
    nowIso(),
  ]);
}
const barber = (name: string) => run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shopId, name, nowIso()]).lastInsertRowid;
const paulo = barber('Paulo');
const marcos = barber('Marcos');
const today = localNow().date;
const customer = (name: string, phone: string, extra: { optOut?: boolean; birth?: string; anonymized?: boolean } = {}) =>
  run('INSERT INTO customers (barbershop_id, name, phone, reminders_opt_out, birth_date, anonymized_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    shopId,
    name,
    phone,
    extra.optOut ? 1 : 0,
    extra.birth ?? null,
    extra.anonymized ? nowIso() : null,
    nowIso(),
  ]).lastInsertRowid;
const visit = (customerId: number, barberId: number, daysAgo: number) =>
  run(
    "INSERT INTO appointments (barbershop_id, customer_id, barber_id, service_name, price_cents, starts_at, ends_at, source, created_at) VALUES (?, ?, ?, 'Corte', 5000, ?, ?, 'painel', ?)",
    [shopId, customerId, barberId, `${addDays(today, -daysAgo)} 10:00`, `${addDays(today, -daysAgo)} 10:30`, nowIso()],
  );

const ana = customer('Ana Lima', '11911110001');
visit(ana, paulo, 60);
const bruno = customer('Bruno Costa', '11911110002');
visit(bruno, marcos, 5);
customer('Carlos Parou', '11911110003', { optOut: true });
const diego = customer('Diego Souza', '11911110004', { birth: `${today.slice(5, 7)}-15` });
const elis = customer('Elis Clube', '11911110005');
const plan = run("INSERT INTO club_plans (barbershop_id, name, price_cents, created_at) VALUES (?, 'Plano Corte', 8990, ?)", [shopId, nowIso()]).lastInsertRowid;
run("INSERT INTO club_members (barbershop_id, customer_id, plan_id, status, billing_day, created_at) VALUES (?, ?, ?, 'active', 10, ?)", [shopId, elis, plan, nowIso()]);
customer('Fábio Apagado', '11911110006', { anonymized: true });

const names = (list: { name: string }[]) => list.map((p) => p.name.split(' ')[0]).sort();

describe('promoções no WhatsApp para um grupo', () => {
  test('cada grupo pega só quem deve, e nunca quem pediu para parar ou foi apagado', () => {
    assert.deepEqual(names(audience(shopId, { type: 'todos' })), ['Ana', 'Bruno', 'Diego', 'Elis']);
    assert.deepEqual(names(audience(shopId, { type: 'barbeiro', barberId: paulo })), ['Ana']);
    assert.deepEqual(names(audience(shopId, { type: 'sumidos', days: 30 })), ['Ana']);
    assert.deepEqual(names(audience(shopId, { type: 'aniversariantes' })), ['Diego']);
    assert.deepEqual(names(audience(shopId, { type: 'clube' })), ['Elis']);
  });

  test('a prévia mostra quantos, o custo (só na API oficial) e o limite do mês', () => {
    let p = previewBroadcast(shopId, { type: 'todos' });
    assert.deepEqual([p.count, p.cost_cents, p.usage.left], [4, null, 300]);
    run("UPDATE barbershops SET wa_provider = 'meta' WHERE id = ?", [shopId]);
    p = previewBroadcast(shopId, { type: 'todos' });
    assert.equal(p.cost_cents, 4 * platformSettings().marketing_msg_cost_cents);
    run("UPDATE barbershops SET wa_provider = 'simulador' WHERE id = ?", [shopId]);
  });

  test('envia com o nome de cada um e o PARAR; o mesmo cliente não recebe outra em 7 dias', async () => {
    const id = createBroadcast({ shopId, userId: null, segment: { type: 'sumidos', days: 30 }, text: 'Oi {nome}, sábado tem corte + barba por R$ 60!' });
    await runBroadcast(id);
    await runBroadcast(id);
    const msgs = all<{ customer_id: number; body: string }>("SELECT customer_id, body FROM messages WHERE kind = 'campanha'");
    assert.equal(msgs.length, 1, 'roda uma vez só');
    assert.equal(msgs[0].customer_id, ana);
    assert.match(msgs[0].body, /^Oi Ana, sábado tem corte \+ barba por R\$ 60!\n\n\(Para não receber promoções, responda PARAR\.\)$/);
    assert.deepEqual(get('SELECT status, sent, failed, recipients FROM broadcasts WHERE id = ?', [id]), { status: 'sent', sent: 1, failed: 0, recipients: 1 });
    assert.deepEqual(names(audience(shopId, { type: 'todos' })), ['Bruno', 'Diego', 'Elis']);
    assert.throws(() => createBroadcast({ shopId, userId: null, segment: { type: 'sumidos', days: 30 }, text: 'Outra promoção na mesma semana' }), /Ninguém nesse grupo/);
  });

  test('não passa do limite do mês', () => {
    savePlatformSettings({ ...platformSettings(), broadcast_monthly_limit: 2 });
    assert.throws(() => createBroadcast({ shopId, userId: null, segment: { type: 'todos' }, text: 'Promoção para todo mundo!' }), /sobram 1 mensagens de 2/);
    savePlatformSettings({ ...platformSettings(), broadcast_monthly_limit: 300 });
  });

  test('pelo painel: só o dono manda promoção', async () => {
    assert.equal((await desk('GET', '/api/shop/broadcasts')).status, 403);
    const r = await owner('POST', '/api/shop/broadcasts', { segment: { type: 'clube' }, text: 'Assinante tem pomada com 20% este mês!' });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const list = (await owner('GET', '/api/shop/broadcasts')).data;
    assert.equal(list.history[0].label, 'Assinantes do clube');
    assert.equal(list.usage.used, 2);
  });
});
