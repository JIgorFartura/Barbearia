import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-indicacao-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { createSale } = await import('../finance.js');
const { birthdayGifts } = await import('../growth.js');
const { shopBot } = await import('../messaging.js');
const { runTool } = await import('../bot/tools.js');

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

const at = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
run("INSERT INTO offers (barbershop_id, title, valid_days, per_customer, created_at) VALUES (?, 'Cerveja grátis', 7, 1, ?)", [shopId, nowIso()]);
const joao = run("INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, 'João Pereira', '11999990000', ?, ?)", [
  shopId,
  nowIso(),
  nowIso(),
]).lastInsertRowid;

/** Entra na área do cliente (cria a conta se precisar, com o código de indicação). */
async function enter(phone: string, extra: Record<string, unknown> = {}) {
  const c = makeClient(() => base);
  const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone, ...extra });
  await c('POST', '/api/public/shops/navalha/login/verify', { phone, code: asked.data.demoCode });
  return c;
}

const settings = {
  referral_enabled: true,
  friend_reward: { title: '10% no primeiro corte', valid_days: 30 },
  referrer_reward: { title: 'Corte grátis', valid_days: 60 },
  birthday_enabled: true,
  birthday_reward: { title: '1 cerveja grátis', valid_days: 7 },
};

let code = '';

describe('indique um amigo', () => {
  test('o dono liga e define os prêmios (que não aparecem como benefício comum)', async () => {
    assert.equal((await owner('PUT', '/api/shop/growth/settings', { ...settings, referrer_reward: null })).status, 400);
    const r = await owner('PUT', '/api/shop/growth/settings', settings);
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.referrer_reward.title, 'Corte grátis');
    assert.deepEqual(
      (await owner('GET', '/api/shop/offers')).data.map((o: { title: string }) => o.title),
      ['Cerveja grátis'],
      'a tela de benefícios não mostra os prêmios',
    );
    const reward = get<{ id: number }>("SELECT id FROM offers WHERE title = 'Corte grátis'")!.id;
    const c = await enter('11999990000');
    const me = (await c('GET', '/api/customer/navalha/me')).data;
    assert.deepEqual(
      me.offers.map((o: { title: string }) => o.title),
      ['Cerveja grátis'],
    );
    assert.equal((await c('POST', `/api/customer/navalha/offers/${reward}/claim`)).status, 404, 'prêmio não se pega');
    code = me.referral.code;
    assert.match(code, /^JOAO[A-Z2-9]{3}$/);
    assert.match(me.referral.link, new RegExp(`/b/navalha/conta\\?indicacao=${code}$`));
  });

  test('o amigo entra pelo link: ganha o presente de boas-vindas depois de confirmar o celular', async () => {
    const who = (await makeClient(() => base)('GET', `/api/public/shops/navalha/referral/${code.toLowerCase()}`)).data;
    assert.deepEqual(who, { name: 'João', gift: '10% no primeiro corte' });
    const c = await enter('11977770000', { name: 'Pedro Alves', accept: true, referral: code });
    const pedro = get<{ id: number; referred_by: number }>("SELECT id, referred_by FROM customers WHERE phone = '11977770000'")!;
    assert.equal(pedro.referred_by, joao);
    const vouchers = (await c('GET', '/api/customer/navalha/me')).data.vouchers;
    assert.deepEqual(
      vouchers.map((v: { title: string }) => v.title),
      ['10% no primeiro corte'],
    );
    // Entrar de novo não dá outro presente.
    await enter('11977770000');
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM vouchers WHERE customer_id = ?', [pedro.id])!.n, 1);
  });

  test('na primeira visita do amigo, quem indicou ganha o prêmio e recebe no WhatsApp (uma vez só)', async () => {
    const pedro = get<{ id: number }>("SELECT id FROM customers WHERE phone = '11977770000'")!.id;
    createSale({ shopId, userId: null, customerId: pedro, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix' });
    createSale({ shopId, userId: null, customerId: pedro, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix' });
    const prizes = all<{ code: string; title: string }>('SELECT v.code, o.title FROM vouchers v JOIN offers o ON o.id = v.offer_id WHERE v.customer_id = ?', [joao]);
    assert.deepEqual(
      prizes.map((p) => p.title),
      ['Corte grátis'],
    );
    await new Promise((r) => setTimeout(r, 50)); // a mensagem sai depois da venda
    const msg = get<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? AND kind = 'indicacao'", [joao])!;
    assert.match(msg.body, new RegExp(`Pedro veio à Navalha de Ouro por indicação sua.*Corte grátis.*${prizes[0].code}`));
    const panel = (await owner('GET', '/api/shop/growth')).data.referrals;
    assert.equal(panel[0].friend, 'Pedro Alves');
    assert.ok(panel[0].rewarded_at);
  });

  test('pelo WhatsApp: cadastro com o código de quem indicou', async () => {
    const ctx = { shop: shopBot(shopId), phone: '11955554444', waId: null, customer: null, profileName: null, now: new Date(), dryRun: true };
    const r = await runTool(ctx, 'cadastrar_cliente', { nome: 'Lia Rocha', codigo_indicacao: code });
    const out = JSON.parse(r.content);
    assert.equal(out.indicacao, 'registrada');
    assert.equal(out.presente_boas_vindas.presente, '10% no primeiro corte');
    const bad = await runTool({ ...ctx, phone: '11955553333', customer: null }, 'cadastrar_cliente', { nome: 'Rui', codigo_indicacao: 'NAOEXISTE' });
    assert.equal(JSON.parse(bad.content).indicacao, 'código não encontrado');
  });
});

describe('presente de aniversário', () => {
  test('o cliente informa dia e mês; data inválida é recusada', async () => {
    const c = await enter('11999990000');
    assert.equal((await c('PUT', '/api/customer/navalha/birthday', { day: 31, month: 4 })).status, 400);
    assert.equal((await c('PUT', '/api/customer/navalha/birthday', { day: 29, month: 2 })).data.value, '02-29');
    const me = (await c('GET', '/api/customer/navalha/me')).data;
    assert.deepEqual(me.birthday, { enabled: true, gift: '1 cerveja grátis', value: '02-29' });
  });

  test('no dia (29/02 cai em 28/02 nos outros anos): voucher e mensagem, uma vez por ano; quem pediu PARAR não recebe', async () => {
    const quiet = run("INSERT INTO customers (barbershop_id, name, phone, birth_date, reminders_opt_out, created_at) VALUES (?, 'Quieto', '11944443333', '02-28', 1, ?)", [
      shopId,
      nowIso(),
    ]).lastInsertRowid;
    assert.equal(await birthdayGifts(shopBot(shopId), at('2027-02-27', '10:00')), 0);
    assert.equal(await birthdayGifts(shopBot(shopId), at('2027-02-28', '10:00')), 1);
    assert.equal(await birthdayGifts(shopBot(shopId), at('2027-02-28', '15:00')), 0, 'um por ano');
    const msg = get<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? AND kind = 'aniversario'", [joao])!;
    assert.match(msg.body, /Feliz aniversário, João! .*1 cerveja grátis.*código \*NAV-[A-Z2-9]{6}\* no balcão até 07\/03\/2027/);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ? AND kind = 'aniversario'", [quiet])!.n, 0);
    assert.equal(await birthdayGifts(shopBot(shopId), at('2028-02-29', '10:00')), 1, 'no ano bissexto, no dia certo');
  });

  test('o painel mostra os aniversariantes do mês', async () => {
    run("INSERT INTO customers (barbershop_id, name, phone, birth_date, created_at) VALUES (?, 'Ana', '11933332222', ?, ?)", [
      shopId,
      new Date(Date.now() + 3 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(5),
      nowIso(),
    ]);
    const b = (await owner('GET', '/api/shop/growth')).data.birthdays;
    assert.ok(b.registered >= 2);
    assert.ok(b.upcoming.some((u: { name: string }) => u.name === 'Ana'));
  });
});
