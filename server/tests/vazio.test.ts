import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-vazio-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { idleOffers, idleStats } = await import('../idle.js');
const { idleDiscount, idleWindow, saveIdleSettings } = await import('../promo.js');
const { book } = await import('../scheduling.js');
const { shopBot } = await import('../messaging.js');
const { handleInbound } = await import('../bot/inbound.js');
const { runTool } = await import('../bot/tools.js');
const { shopNow } = await import('../clock.js');
const { addDays, weekdayOf } = await import('../time.js');

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
const barber = (name: string) => {
  const id = run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shopId, name, nowIso()]).lastInsertRowid;
  for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [id, d]);
  return id;
};
const marcos = barber('Marcos');
const paulo = barber('Paulo');
run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]);
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, name, phone, nowIso(), nowIso()]).lastInsertRowid;

// Dia da promoção: daqui a 10 dias (as visitas "passadas" ficam antes dele).
const D = addDays(shopNow(shopId).date, 10);
const morning = at(D, '09:05');
const visit = (customerId: number, daysBefore: number, time = '10:00') =>
  book({ shopId, customerId, barberId: paulo, date: addDays(D, -daysBefore), time, source: 'painel', now: at(addDays(D, -daysBefore), '08:00') });

// João: costuma vir com o Paulo às 15h, a cada 14 dias; veio há 15 dias (na hora de voltar).
const joao = customer('João Pereira', '11999990000');
run("UPDATE customers SET pref_weekday = ?, pref_time = '15:00', pref_barber_id = ?, pref_interval_days = 14 WHERE id = ?", [weekdayOf(D), paulo, joao]);
visit(joao, 15);
// Ana: sem costume; veio há 25 dias (passou das 3 semanas: a mais atrasada).
const ana = customer('Ana Lima', '11988880000');
visit(ana, 25);
// Não recebem: veio há 3 dias; pediu para não receber; já tem horário; sumiu há 200 dias; recebeu oferta há 3 dias.
const pedro = customer('Pedro Alves', '11977770000');
visit(pedro, 3);
const bruno = customer('Bruno Costa', '11966660000');
visit(bruno, 30);
run('UPDATE customers SET reminders_opt_out = 1 WHERE id = ?', [bruno]);
const carla = customer('Carla Dias', '11955550000');
visit(carla, 30, '11:00');
book({ shopId, customerId: carla, barberId: marcos, date: addDays(D, 2), time: '10:00', source: 'painel', now: at(addDays(D, -30), '09:00') });
const diego = customer('Diego Rocha', '11944440000');
visit(diego, 200);
const eva = customer('Eva Nunes', '11933330000');
visit(eva, 30, '12:00');
run("INSERT INTO automation_log (barbershop_id, customer_id, kind, ref, created_at) VALUES (?, ?, 'vazio', ?, ?)", [
  shopId,
  eva,
  addDays(D, -3),
  new Date(morning.getTime() - 3 * 86400000).toISOString(),
]);

const lastMessage = (customerId: number) => get<{ kind: string; body: string }>('SELECT kind, body FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [customerId]);
const offerOf = (customerId: number) =>
  get<{ barber_id: number; starts_at: string; discount_percent: number; status: string }>(
    "SELECT barber_id, starts_at, discount_percent, status FROM bot_offers WHERE customer_id = ? AND kind = 'vazio' ORDER BY id DESC LIMIT 1",
    [customerId],
  );

describe('horário vazio com desconto', () => {
  test('o dono escolhe os dias, a faixa e o desconto (com conferência)', async () => {
    const bad = async (body: object) => (await owner('PUT', '/api/shop/growth/idle', { percent: 20, weekdays: [2], from: '10:00', until: '16:00', ...body })).status;
    assert.equal(await bad({ percent: 60 }), 400);
    assert.equal(await bad({ percent: 2 }), 400);
    assert.equal(await bad({ from: '16:00', until: '10:00' }), 400, 'a faixa precisa terminar depois de começar');
    assert.equal(await bad({ weekdays: [] }), 400, 'ligado sem nenhum dia');
    assert.equal(await bad({ percent: null, weekdays: [] }), 200, 'desligado pode ficar sem dia');

    const r = await owner('PUT', '/api/shop/growth/idle', { percent: 20, weekdays: [weekdayOf(D)], from: '10:00', until: '16:00' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.idle.settings, { percent: 20, weekdays: [weekdayOf(D)], from: '10:00', until: '16:00' });
    assert.equal(r.data.idle.perDay, 10);
  });

  test('só vale marcando no mesmo dia, dentro da faixa, nos dias escolhidos (o balcão marca com preço normal)', () => {
    const now = at(D, '09:30');
    assert.equal(idleDiscount(shopId, D, '11:00', now), 20);
    assert.equal(idleDiscount(shopId, D, '16:00', now), null, 'fora da faixa');
    assert.equal(idleDiscount(shopId, D, '09:30', now), null);
    assert.equal(idleDiscount(shopId, D, '11:00', at(addDays(D, -1), '18:00')), null, 'marcando no dia anterior: preço normal');
    assert.equal(idleWindow(shopId, addDays(D, 1), at(addDays(D, 1), '09:00')), null, 'outro dia da semana');

    const a = book({ shopId, customerId: pedro, barberId: marcos, date: D, time: '11:00', source: 'cliente', now });
    assert.equal(a.promo_percent, 20);
    assert.equal(a.price_cents, 4000);
    const late = book({ shopId, customerId: pedro, barberId: marcos, date: D, time: '17:00', source: 'cliente', now });
    assert.equal(late.promo_percent, null);
    assert.equal(late.price_cents, 5000);
    const counter = book({ shopId, customerId: bruno, barberId: marcos, date: D, time: '12:00', source: 'painel', now });
    assert.equal(counter.promo_percent, null, 'no balcão o dono dá o desconto na comanda, se quiser');
    for (const id of [a.id, late.id, counter.id]) run('DELETE FROM appointments WHERE id = ?', [id]);
  });

  test('às 9h o robô oferece uma vaga diferente para cada cliente que está na hora de cortar', async () => {
    const shop = shopBot(shopId);
    assert.equal(await idleOffers(shop, at(D, '08:55')), 0, 'antes das 9h, nada');
    assert.equal(await idleOffers(shop, at(addDays(D, 1), '09:05')), 0, 'dia sem promoção');
    assert.equal(await idleOffers(shop, morning), 2);
    assert.equal(await idleOffers(shop, at(D, '09:30')), 0, 'uma rodada por dia');

    // Ana (a mais atrasada, sem costume): a primeira vaga da faixa daqui a 2 horas.
    assert.deepEqual(offerOf(ana), { barber_id: marcos, starts_at: `${D} 11:30`, discount_percent: 20, status: 'pending' });
    // João: com o barbeiro e no horário de costume.
    assert.deepEqual(offerOf(joao), { barber_id: paulo, starts_at: `${D} 15:00`, discount_percent: 20, status: 'pending' });
    const msg = lastMessage(joao)!;
    assert.equal(msg.kind, 'vazio');
    assert.match(msg.body, /Hoje tem horário livre às \*15h\* com Paulo/);
    assert.match(msg.body, /R\$\s40,00\* \(em vez de R\$\s50,00\)/);
    assert.match(msg.body, /PARAR/);
    for (const c of [pedro, bruno, carla, diego, eva]) assert.equal(offerOf(c), undefined);
  });

  test('SIM marca com o desconto prometido, mesmo que o dono mude a regra depois', async () => {
    saveIdleSettings(shopId, { percent: 10, weekdays: [weekdayOf(D)], from: '10:00', until: '16:00' });
    const reply = await handleInbound({ shopId, from: '5511999990000', text: 'sim', now: at(D, '09:20'), dryRun: true });
    assert.match(reply ?? '', /Fechado, João!.*com 20% de desconto: R\$\s40,00/s);
    const a = get<{ price_cents: number; promo_percent: number; starts_at: string }>(
      'SELECT price_cents, promo_percent, starts_at FROM appointments WHERE customer_id = ? AND starts_at = ?',
      [joao, `${D} 15:00`],
    )!;
    assert.deepEqual(a, { price_cents: 4000, promo_percent: 20, starts_at: `${D} 15:00` });
    assert.equal(offerOf(joao)!.status, 'accepted');

    // A Ana aceita pela conversa com a IA (ferramenta agendar com os dados da oferta).
    const r = await runTool(
      { shop: shopBot(shopId), phone: '11988880000', waId: null, customer: get('SELECT * FROM customers WHERE id = ?', [ana])!, profileName: null, now: at(D, '09:40'), dryRun: true } as never,
      'agendar',
      { data: D, hora: '11:30', barbeiro_id: marcos },
    );
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /"desconto_horario_vazio":"20%"/);
    assert.equal(offerOf(ana)!.status, 'accepted');
    saveIdleSettings(shopId, { percent: 20, weekdays: [weekdayOf(D)], from: '10:00', until: '16:00' });
  });

  test('a comanda vem com o preço do horário e o painel mostra o resultado do mês', async () => {
    const appt = get<{ id: number }>('SELECT id FROM appointments WHERE customer_id = ? AND promo_percent IS NOT NULL', [joao])!.id;
    const checkout = (await owner('GET', `/api/shop/finance/checkout?appointment_id=${appt}`)).data;
    assert.equal(checkout.appointment.price_cents, 4000);
    assert.equal(checkout.appointment.promo_percent, 20);

    const agenda = (await owner('GET', `/api/shop/agenda?date=${D}`)).data;
    assert.equal(agenda.appointments.find((a: { id: number }) => a.id === appt).promo_percent, 20);

    // João e Ana marcaram pelas ofertas: 2 horários que iam ficar parados, R$ 80 no mês.
    assert.deepEqual(idleStats(shopId, morning), { month: D.slice(0, 7), booked: 2, revenue_cents: 8000, offers: 2 });
    assert.equal((await owner('GET', '/api/shop/growth')).data.idle.perDay, 10);
  });

  test('a página de horários mostra o selo só para hoje', async () => {
    const today = shopNow(shopId).date;
    saveIdleSettings(shopId, { percent: 15, weekdays: [weekdayOf(today)], from: '00:00', until: '23:59' });
    const c = makeClient(() => base);
    const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone: '11977770000' });
    await c('POST', '/api/public/shops/navalha/login/verify', { phone: '11977770000', code: asked.data.demoCode });
    const todays = (await c('GET', `/api/customer/navalha/availability?date=${today}`)).data;
    assert.deepEqual(todays[0].promo, { percent: 15, from: '00:00', until: '23:59' });
    const tomorrow = (await c('GET', `/api/customer/navalha/availability?date=${addDays(today, 1)}`)).data;
    assert.equal(tomorrow[0].promo, null);
  });
});
