import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-clube-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { clubBilling, clubCoverage, nextBilling, subscribe } = await import('../club.js');
const { shopBot } = await import('../messaging.js');
const { handleInbound } = await import('../bot/inbound.js');
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

/** "AAAA-MM-DD", "HH:MM" no horário de Brasília → Date. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, service_commission, product_commission, created_at) VALUES (?, 'Paulo', 40, 10, ?)", [shopId, nowIso()]).lastInsertRowid;
const item = (kind: string, name: string, price: number) =>
  run('INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, ?, ?, ?, 30, ?)', [shopId, kind, name, price, nowIso()]).lastInsertRowid;
const corte = item('service', 'Corte', 5000);
const barba = item('service', 'Barba', 3000);
const cerveja = item('product', 'Cerveja', 800);
const joao = run("INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, 'João Pereira', '11999990000', ?, ?)", [
  shopId,
  nowIso(),
  nowIso(),
]).lastInsertRowid;
const ana = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Ana Lima', '11988880000', ?)", [shopId, nowIso()]).lastInsertRowid;

/** Entra na área do cliente pelo código (em demonstração o código vem na resposta). */
async function enter(phone: string) {
  const c = makeClient(() => base);
  const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone });
  await c('POST', '/api/public/shops/navalha/login/verify', { phone, code: asked.data.demoCode });
  return c;
}

let planId = 0;

describe('clube de assinatura', () => {
  test('dia de cobrança: nenhum mês fica curto demais', () => {
    assert.equal(nextBilling('2026-11-10', 10), '2026-12-10');
    assert.equal(nextBilling('2026-12-10', 10), '2027-01-10');
    assert.equal(nextBilling('2026-11-30', 1), '2027-01-01', 'assinou dia 30: cobra todo dia 1º, a partir de janeiro');
    assert.equal(nextBilling('2027-01-01', 1), '2027-02-01');
    assert.equal(nextBilling('2027-01-28', 28), '2027-02-28');
  });

  test('chave PIX: celular vai como +55 no copia e cola; chave errada é recusada', async () => {
    assert.equal((await owner('PUT', '/api/shop/pix', { pix_type: 'cpf', pix_key: '123', pix_name: 'Navalha', pix_city: 'Sao Paulo' })).status, 400);
    const ok = await owner('PUT', '/api/shop/pix', { pix_type: 'celular', pix_key: '(11) 98888-7777', pix_name: 'Navalha de Ouro', pix_city: 'São Paulo' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.pix_key, '+5511988887777');
    assert.equal(ok.data.pix_type, 'celular');
  });

  test('o dono cria o plano com os serviços incluídos', async () => {
    assert.equal((await owner('POST', '/api/shop/club/plans', { name: 'Ouro', price_cents: 9990, uses_per_month: 4, item_ids: [] })).status, 400);
    const r = await owner('POST', '/api/shop/club/plans', { name: 'Ouro', description: 'Corte e barba', price_cents: 9990, uses_per_month: 4, item_ids: [corte, barba] });
    assert.equal(r.status, 201);
    planId = r.data.id;
    assert.deepEqual(
      r.data.items.map((i: { name: string }) => i.name),
      ['Barba', 'Corte'],
    );
    const landing = (await makeClient(() => base)('GET', '/api/public/shops/navalha')).data;
    assert.deepEqual(landing.clubPlans[0].items, ['Barba', 'Corte']);
  });

  test('o cliente assina pela área dele, paga o PIX e avisa: o clube já vale', async () => {
    const c = await enter('11999990000');
    const before = (await c('GET', '/api/customer/navalha/club')).data;
    assert.equal(before.member, null);
    assert.equal(before.plans[0].name, 'Ouro');

    const sub = await c('POST', '/api/customer/navalha/club/subscribe', { plan_id: planId });
    assert.equal(sub.status, 201);
    assert.equal(sub.data.member.state, 'pending');
    assert.match(sub.data.charge.pix.payload, /0114\+5511988887777/, 'chave do celular no formato do PIX');
    assert.match(sub.data.charge.pix.payload, /540599\.90/, 'valor da mensalidade');
    assert.equal((await c('POST', '/api/customer/navalha/club/subscribe', { plan_id: planId })).status, 409, 'já é assinante');
    assert.equal((await owner('GET', `/api/shop/finance/club?customer_id=${joao}`)).data, null, 'sem pagamento, ainda não vale');

    const claimed = await c('POST', `/api/customer/navalha/club/charges/${sub.data.charge.id}/claim`);
    assert.equal(claimed.data.member.state, 'ok');
    assert.equal(claimed.data.charge.claimed, true);
    assert.equal((await owner('GET', '/api/shop/status')).data.pixToConfirm, 1, 'o dono vê o aviso de pagamento');
  });

  test('no balcão: o corte pelo clube sai por R$ 0 e a comissão usa o preço normal; respeita o limite', async () => {
    assert.equal((await owner('GET', `/api/shop/finance/club?customer_id=${joao}`)).data.left, 4);
    const sale = await owner('POST', '/api/shop/finance/sales', {
      customer_id: joao,
      items: [
        { catalog_item_id: corte, qty: 1, barber_id: paulo, club: true },
        { catalog_item_id: cerveja, qty: 1, barber_id: paulo },
      ],
      method: 'pix',
    });
    assert.equal(sale.status, 201);
    assert.equal(sale.data.sale.total_cents, 800, 'só a cerveja é cobrada');
    assert.equal(sale.data.sale.items[0].total_cents, 0);
    assert.equal(sale.data.sale.items[0].commission_cents, 2000, '40% de R$ 50');

    const notInPlan = await owner('POST', '/api/shop/finance/sales', { customer_id: joao, items: [{ catalog_item_id: cerveja, qty: 1, club: true }], method: 'pix' });
    assert.equal(notInPlan.status, 409);
    const over = await owner('POST', '/api/shop/finance/sales', { customer_id: joao, items: [{ catalog_item_id: barba, qty: 4, club: true }], method: 'pix' });
    assert.equal(over.status, 409);
    assert.match(over.data.error, /só tem mais 3 usos/);

    await owner('PUT', '/api/shop/club/settings', { club_commission_pct: 50 });
    const half = await owner('POST', '/api/shop/finance/sales', { customer_id: joao, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo, club: true }], method: 'pix' });
    assert.equal(half.data.sale.items[0].commission_cents, 1000, 'metade da comissão');
    assert.equal((await owner('GET', `/api/shop/finance/club?customer_id=${joao}`)).data.left, 2);
    assert.equal((await owner('POST', '/api/shop/finance/sales', { customer_id: ana, items: [{ catalog_item_id: corte, qty: 1, club: true }], method: 'pix' })).status, 409, 'Ana não assina');
  });

  test('o dono confirma o PIX: entra no caixa; desfazer tira do caixa', async () => {
    const [pending] = (await owner('GET', '/api/shop/charges/to-confirm')).data;
    const ok = await owner('POST', `/api/shop/charges/${pending.id}/confirm`, { method: 'pix' });
    assert.equal(ok.data.status, 'paid');
    assert.deepEqual(get('SELECT category, amount_cents FROM cash_entries WHERE charge_id = ?', [pending.id]), { category: 'Clube de assinatura', amount_cents: 9990 });
    const entryId = get<{ id: number }>('SELECT id FROM cash_entries WHERE charge_id = ?', [pending.id])!.id;
    assert.equal((await owner('DELETE', `/api/shop/finance/entries/${entryId}`)).status, 409, 'lançamento automático');

    const club = (await owner('GET', '/api/shop/club')).data;
    assert.equal(club.active, 1);
    assert.equal(club.monthly_cents, 9990);
    assert.equal(club.members[0].status, 'active');
    assert.equal(club.members[0].used, 2);

    await owner('POST', `/api/shop/charges/${pending.id}/undo`);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM cash_entries WHERE charge_id = ?', [pending.id])!.n, 0);
    assert.equal((await owner('GET', '/api/shop/club')).data.members[0].status, 'pending');
    assert.equal((await owner('POST', `/api/shop/charges/${pending.id}/confirm`, {})).data.status, 'paid');
  });

  test('a mensalidade seguinte sai 3 dias antes, com o PIX em mensagem separada; atrasou, pausa e lembra uma vez', async () => {
    const until = (await owner('GET', '/api/shop/club')).data.members[0].paid_until as string;
    const shop = shopBot(shopId);
    assert.equal(await clubBilling(shop, at(addDays(until, -4), '10:00')), 0, 'ainda cedo');
    assert.equal(await clubBilling(shop, at(addDays(until, -3), '10:00')), 1);
    assert.equal(await clubBilling(shop, at(addDays(until, -2), '10:00')), 0, 'uma cobrança por vez');
    const msgs = all<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? AND kind = 'assinatura' ORDER BY id", [joao]);
    assert.equal(msgs.length, 2);
    assert.match(msgs[0].body, /mensalidade do clube Ouro \(R\$\s99,90\) vence em/);
    assert.match(msgs[1].body, /^000201/, 'só o PIX copia e cola, fácil de copiar');

    const late = addDays(until, 2);
    assert.equal(clubCoverage(shopId, joao, late), null, 'mensalidade atrasada pausa o clube');
    assert.equal(await clubBilling(shop, at(late, '10:00')), 1, 'lembrete');
    assert.equal(await clubBilling(shop, at(addDays(late, 1), '10:00')), 0, 'um lembrete só');

    const reply = await handleInbound({ shopId, from: '5511999990000', text: 'Já paguei!', now: at(late, '11:00'), dryRun: true });
    assert.match(reply!, /Anotado, João!/);
    assert.ok(clubCoverage(shopId, joao, late), 'com o PIX avisado, volta a valer');
  });

  test('cancelou: o mês pago continua valendo; assinar de novo reativa', async () => {
    const c = await enter('11999990000');
    const r = await c('POST', '/api/customer/navalha/club/cancel');
    assert.equal(r.data.member.state, 'ending');
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM charges WHERE customer_id = ? AND status = 'open' AND claimed_at IS NOT NULL", [joao])!.n, 1, 'PIX avisado fica para o dono conferir');
    const again = await c('POST', '/api/customer/navalha/club/subscribe', { plan_id: planId });
    assert.equal(again.status, 201);
    assert.equal(again.data.member.state, 'ok');
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM club_members WHERE customer_id = ?', [joao])!.n, 1, 'a mesma assinatura');
  });

  test('assinou e nunca pagou: some depois de 7 dias', async () => {
    const m = subscribe(shopId, ana, planId, { now: at('2026-11-01', '10:00') });
    assert.equal(m.state, 'pending');
    assert.equal(await clubBilling(shopBot(shopId), at('2026-11-02', '10:00')), 1, 'lembrete do primeiro pagamento');
    await clubBilling(shopBot(shopId), at('2026-11-09', '10:00'));
    assert.equal(get<{ status: string }>('SELECT status FROM club_members WHERE id = ?', [m.id])!.status, 'cancelled');
    assert.equal(get<{ status: string }>('SELECT status FROM charges WHERE club_member_id = ?', [m.id])!.status, 'cancelled');
  });

  test('LGPD: excluir o cliente encerra a assinatura e as cobranças em aberto', async () => {
    assert.equal((await owner('POST', `/api/shop/customers/${joao}/anonymize`, { confirm: 'EXCLUIR' })).status, 200);
    assert.equal(get<{ status: string }>('SELECT status FROM club_members WHERE customer_id = ?', [joao])!.status, 'cancelled');
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM charges WHERE customer_id = ? AND status = 'open'", [joao])!.n, 0);
  });
});
