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
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book, cancel } = await import('../scheduling.js');
const { expireDeposits, needsDeposit, requireDeposit } = await import('../deposits.js');
const { claimCharge, confirmCharge } = await import('../charges.js');
const { cancelSale, createSale } = await import('../finance.js');
const { savePlan, subscribe } = await import('../club.js');
const { shopBot } = await import('../messaging.js');
const { handleInbound } = await import('../bot/inbound.js');

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
const paulo = run("INSERT INTO barbers (barbershop_id, name, service_commission, created_at) VALUES (?, 'Paulo', 40, ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '06:00', '23:30')", [paulo, d]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, name, phone, nowIso(), nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const ana = customer('Ana Lima', '11988880000');
const bia = customer('Bia Souza', '11977770000');
const caio = customer('Caio Lopes', '11966660000');

const status = (id: number) => get<{ status: string }>('SELECT status FROM appointments WHERE id = ?', [id])!.status;

describe('sinal via PIX para segurar o horário', () => {
  test('só liga com a chave PIX cadastrada', async () => {
    const off = await owner('PUT', '/api/shop/deposits/settings', { deposit_mode: 'all', deposit_cents: 2000, deposit_hold_min: 60, deposit_credit_hours: 24 });
    assert.equal(off.status, 409);
    await owner('PUT', '/api/shop/pix', { pix_type: 'email', pix_key: 'Pix@Navalha.com.br', pix_name: 'Navalha de Ouro', pix_city: 'Sao Paulo' });
    const on = await owner('PUT', '/api/shop/deposits/settings', { deposit_mode: 'all', deposit_cents: 2000, deposit_hold_min: 60, deposit_credit_hours: 24 });
    assert.equal(on.status, 200);
    assert.equal(on.data.settings.deposit_mode, 'all');
  });

  test('o cliente marca pelo site: o horário fica segurado esperando o PIX', async () => {
    const c = makeClient(() => base);
    const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone: '11999990000' });
    await c('POST', '/api/public/shops/navalha/login/verify', { phone: '11999990000', code: asked.data.demoCode });
    // Bem para a frente (o teste roda em qualquer dia): mais de 1h30 depois de agora.
    const day = new Date(Date.now() + 3 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const r = await c('POST', '/api/customer/navalha/appointments', { barber_id: paulo, service_id: corte, date: day, time: '10:00' });
    assert.equal(r.status, 201);
    assert.equal(r.data.deposit.amount_cents, 2000);
    assert.equal(r.data.deposit.paid, false);
    assert.match(r.data.deposit.pix.payload, /0118pix@navalha\.com\.br/, 'e-mail em minúsculas no PIX');
    assert.match(r.data.deposit.pix.payload, /540520\.00/);
    const me = (await c('GET', '/api/customer/navalha/me')).data;
    assert.equal(me.upcoming[0].deposit.id, r.data.deposit.id);
    // O pedido do sinal também vai pelo WhatsApp, com o PIX numa mensagem separada.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sent = all<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? AND kind = 'sinal' ORDER BY id", [joao]);
    assert.match(sent[0].body, /Seu horário na Navalha de Ouro .* está reservado\. Para confirmar, pague o sinal de R\$\s20,00/);
    assert.equal(sent[1].body, r.data.deposit.pix.payload);
    const claimed = await c('POST', `/api/customer/navalha/deposits/${r.data.deposit.id}/claim`);
    assert.equal(claimed.data.claimed, true);
    assert.equal(claimed.data.expires_local, null, 'avisou que pagou: não expira mais');
    cancel(shopId, r.data.id); // libera para os próximos testes
  });

  test('sem o PIX no prazo, a vaga é liberada e o cliente é avisado', async () => {
    const now = at('2026-11-10', '09:00');
    const a = book({ shopId, customerId: ana, barberId: paulo, serviceId: corte, date: '2026-11-10', time: '15:00', source: 'cliente', now });
    const dep = requireDeposit(shopId, a.id, now)!;
    assert.equal(dep.status, 'open');
    assert.equal(await expireDeposits(shopBot(shopId), at('2026-11-10', '09:59')), 0, 'ainda no prazo');
    assert.equal(await expireDeposits(shopBot(shopId), at('2026-11-10', '10:01')), 1);
    assert.equal(status(a.id), 'cancelled');
    const msg = get<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? AND kind = 'sinal' ORDER BY id DESC LIMIT 1", [ana])!;
    assert.match(msg.body, /não chegou a tempo, então liberei a vaga/);
  });

  test('em cima da hora não pede sinal; assinante do clube também não', () => {
    const now = at('2026-11-10', '09:00');
    assert.equal(needsDeposit(shopId, ana, '2026-11-10 10:00', now), false, 'menos de 1h30 de antecedência');
    assert.equal(needsDeposit(shopId, ana, '2026-11-10 11:00', now), true);
    const plan = savePlan(shopId, null, { name: 'Ouro', description: null, price_cents: 9990, uses_per_month: null, active: true, item_ids: [corte] });
    subscribe(shopId, caio, plan.id, { paidMethod: 'pix', now: at('2026-11-01', '10:00') });
    assert.equal(needsDeposit(shopId, caio, '2026-11-10 11:00', now), false);
  });

  test('pago e confirmado: no fechamento o sinal é abatido; cancelar a venda devolve o abatimento', () => {
    const now = at('2026-11-11', '09:00');
    const a = book({ shopId, customerId: bia, barberId: paulo, serviceId: corte, date: '2026-11-12', time: '10:00', source: 'whatsapp', now });
    const dep = requireDeposit(shopId, a.id, now)!;
    confirmCharge(shopId, dep.id, { method: 'pix', userId: null, now });
    assert.deepEqual(get('SELECT category, amount_cents FROM cash_entries WHERE charge_id = ?', [dep.id]), { category: 'Atendimentos', amount_cents: 2000 });

    const sale = createSale({ shopId, userId: null, appointmentId: a.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'dinheiro', now: at('2026-11-12', '10:40') });
    assert.equal(sale.sale.total_cents, 5000, 'o atendimento vale R$ 50');
    assert.equal(sale.sale.prepaid_cents, 2000);
    assert.equal(sale.sale.items[0].commission_cents, 2000, 'comissão sobre o valor cheio');
    assert.equal(get<{ amount_cents: number }>('SELECT amount_cents FROM cash_entries WHERE sale_id = ?', [sale.sale.id])!.amount_cents, 3000, 'só o resto entra agora');

    cancelSale(shopId, sale.sale.id);
    assert.equal(get<{ sale_id: number | null }>('SELECT sale_id FROM charges WHERE id = ?', [dep.id])!.sale_id, null);
    const again = createSale({ shopId, userId: null, appointmentId: a.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix', now: at('2026-11-12', '10:45') });
    assert.equal(again.sale.prepaid_cents, 2000);
  });

  test('cancelou com antecedência: vira crédito e vale no próximo horário; em cima da hora, fica com a barbearia', () => {
    const now = at('2026-11-13', '09:00');
    const first = book({ shopId, customerId: bia, barberId: paulo, serviceId: corte, date: '2026-11-15', time: '10:00', source: 'cliente', now });
    const dep = requireDeposit(shopId, first.id, now)!;
    confirmCharge(shopId, dep.id, { method: 'pix', userId: null, now });
    assert.equal(cancel(shopId, first.id, { customerId: bia, now }).deposit, 'credit');

    const second = book({ shopId, customerId: bia, barberId: paulo, serviceId: corte, date: '2026-11-16', time: '10:00', source: 'cliente', now });
    const reused = requireDeposit(shopId, second.id, now)!;
    assert.equal(reused.id, dep.id, 'usou o crédito, sem nova cobrança');
    assert.equal(reused.status, 'paid');

    const late = cancel(shopId, second.id, { customerId: bia, now: at('2026-11-16', '08:00') });
    assert.equal(late.deposit, 'kept', '2h antes: a barbearia fica com o sinal');
    assert.ok(get<{ forfeited_at: string }>('SELECT forfeited_at FROM charges WHERE id = ?', [dep.id])!.forfeited_at);
  });

  test('só de quem já faltou', async () => {
    await owner('PUT', '/api/shop/deposits/settings', { deposit_mode: 'no_show', deposit_cents: 2000, deposit_hold_min: 60, deposit_credit_hours: 24 });
    const now = at('2026-11-20', '09:00');
    assert.equal(needsDeposit(shopId, joao, '2026-11-21 10:00', now), false);
    const missed = book({ shopId, customerId: joao, barberId: paulo, serviceId: corte, date: '2026-11-18', time: '10:00', source: 'painel', now: at('2026-11-17', '09:00') });
    run("UPDATE appointments SET status = 'no_show' WHERE id = ?", [missed.id]);
    assert.equal(needsDeposit(shopId, joao, '2026-11-21 10:00', now), true);
  });

  test('pelo WhatsApp: aceitou o horário oferecido, o robô pede o sinal e manda o PIX numa mensagem separada; "paguei" avisa a barbearia', async () => {
    const now = at('2026-11-23', '09:00');
    run("INSERT INTO bot_offers (barbershop_id, customer_id, barber_id, service_id, starts_at, kind, status, created_at) VALUES (?, ?, ?, ?, '2026-11-24 10:00', 'costume', 'pending', ?)", [
      shopId,
      joao,
      paulo,
      corte,
      now.toISOString(),
    ]);
    const reply = await handleInbound({ shopId, from: '5511999990000', text: 'sim', now, dryRun: true });
    assert.match(reply!, /falta o sinal de R\$\s20,00 pelo PIX até as 10h/);
    const sent = all<{ body: string; kind: string }>("SELECT body, kind FROM messages WHERE customer_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 2", [joao]);
    assert.equal(sent[0].kind, 'sinal');
    assert.match(sent[0].body, /^000201/, 'só o código, fácil de copiar');

    const paid = await handleInbound({ shopId, from: '5511999990000', text: 'paguei', now: at('2026-11-23', '09:20'), dryRun: true });
    assert.match(paid!, /Seu horário continua garantido/);
    assert.equal(await expireDeposits(shopBot(shopId), at('2026-11-23', '11:00')), 0, 'PIX avisado não expira');
    // Este e o do horário que o João cancelou no site depois de avisar o PIX (se cair, vira crédito).
    assert.equal((await owner('GET', '/api/shop/status')).data.pixToConfirm, 2);
  });

  test('o dono devolve um crédito de sinal (sai do caixa)', async () => {
    const now = at('2026-11-25', '09:00');
    const a = book({ shopId, customerId: ana, barberId: paulo, serviceId: corte, date: '2026-11-28', time: '10:00', source: 'cliente', now });
    run("UPDATE barbershops SET deposit_mode = 'all' WHERE id = ?", [shopId]);
    const dep = requireDeposit(shopId, a.id, now)!;
    claimCharge(shopId, ana, dep.id, now);
    confirmCharge(shopId, dep.id, { method: 'pix', userId: null, now });
    cancel(shopId, a.id); // a barbearia cancelou: vira crédito
    const credits = (await owner('GET', '/api/shop/deposits')).data.credits;
    assert.equal(credits.length, 1);
    const r = await owner('POST', `/api/shop/charges/${dep.id}/refund`, { method: 'pix' });
    assert.equal(r.status, 200);
    assert.deepEqual(get("SELECT type, amount_cents FROM cash_entries WHERE charge_id = ? AND type = 'out'", [dep.id]), { type: 'out', amount_cents: 2000 });
    assert.equal((await owner('GET', '/api/shop/deposits')).data.credits.length, 0);
    assert.equal((await owner('POST', `/api/shop/charges/${dep.id}/undo`)).status, 409, 'devolvido não volta');
  });
});
