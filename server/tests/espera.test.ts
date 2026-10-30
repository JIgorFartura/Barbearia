import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-espera-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { appointmentReminders } = await import('../automations.js');
const { releaseUnconfirmed } = await import('../attendance.js');
const { offerFreedSlots, joinWaitlist } = await import('../waitlist.js');
const { book } = await import('../scheduling.js');
const { shopBot } = await import('../messaging.js');
const { handleInbound } = await import('../bot/inbound.js');
const { runTool } = await import('../bot/tools.js');
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

/** "AAAA-MM-DD", "HH:MM" no horário de Brasília → Date. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, reminder_hours, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 24, ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
// O Marcos só atende das 10h às 11h: dois horários por dia (fácil de lotar).
const marcos = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Marcos', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '10:00', '11:00')", [marcos, d]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, name, phone, nowIso(), nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const ana = customer('Ana Lima', '11988880000');
const pedro = customer('Pedro Alves', '11977770000');
const bruno = customer('Bruno Costa', '11966660000');

async function enter(phone: string) {
  const c = makeClient(() => base);
  const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone });
  await c('POST', '/api/public/shops/navalha/login/verify', { phone, code: asked.data.demoCode });
  return c;
}

// Dia do teste: daqui a 3 dias (os horários da lista de espera precisam estar no futuro de verdade).
const today = shopNow(shopId).date;
const D = addDays(today, 3);
const eve = addDays(D, -1);
const lastMessage = (customerId: number) => get<{ kind: string; body: string }>('SELECT kind, body FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [customerId]);
const status = (id: number) => get<{ status: string; confirmed_at: string | null }>('SELECT status, confirmed_at FROM appointments WHERE id = ?', [id])!;

let joaoAppt = 0;
let anaAppt = 0;

describe('confirmação de presença e lista de espera', () => {
  test('o lembrete pede a confirmação; SIM confirma', async () => {
    joaoAppt = book({ shopId, customerId: joao, barberId: marcos, serviceId: corte, date: D, time: '10:00', source: 'painel', now: at(eve, '08:00') }).id;
    anaAppt = book({ shopId, customerId: ana, barberId: marcos, serviceId: corte, date: D, time: '10:30', source: 'painel', now: at(eve, '08:00') }).id;
    run('UPDATE appointments SET created_at = ? WHERE id IN (?, ?)', [at(addDays(D, -5), '10:00').toISOString(), joaoAppt, anaAppt]);
    assert.equal(await appointmentReminders(shopBot(shopId), at(eve, '10:31')), 2);
    assert.match(lastMessage(joao)!.body, /Você confirma\? Responda \*SIM\* para confirmar ou \*NÃO\* se não puder vir/);

    const reply = await handleInbound({ shopId, from: '5511988880000', text: 'sim', now: at(eve, '10:40'), dryRun: true });
    assert.match(reply!, /Confirmado, Ana! ✅/);
    assert.ok(status(anaAppt).confirmed_at);
  });

  test('a agenda mostra quem confirmou e quem ainda não respondeu', async () => {
    const agenda = (await owner('GET', `/api/shop/agenda?date=${D}`)).data;
    const byName = (n: string) => agenda.appointments.find((a: { customer_name: string }) => a.customer_name === n);
    assert.ok(byName('Ana Lima').confirmed_at);
    assert.equal(byName('João Pereira').confirmed_at, null);
    assert.equal(byName('João Pereira').awaiting, true);
  });

  test('dia lotado: Pedro e Bruno entram na lista de espera (área do cliente e robô)', async () => {
    const p = await enter('11977770000');
    const full = (await p('GET', `/api/customer/navalha/availability?date=${D}`)).data;
    assert.deepEqual(full[0].times, [], 'o Marcos está lotado');
    assert.equal((await p('POST', '/api/customer/navalha/waitlist', { date: addDays(today, -1) })).status, 400, 'dia que passou');
    assert.equal((await p('POST', '/api/customer/navalha/waitlist', { date: addDays(today, 40) })).status, 400, 'longe demais');
    const joined = await p('POST', '/api/customer/navalha/waitlist', { date: D, barber_id: marcos, period: 'tarde' });
    assert.equal(joined.status, 201);
    // Pedir de novo para o mesmo dia só ajusta o pedido.
    const again = await p('POST', '/api/customer/navalha/waitlist', { date: D, barber_id: marcos, period: 'manha' });
    assert.equal(again.data.id, joined.data.id);
    assert.equal(again.data.period, 'manha');
    const me = (await p('GET', '/api/customer/navalha/me')).data;
    assert.equal(me.waitlist.length, 1);
    assert.equal(me.waitlist[0].barber_name, 'Marcos');

    // Bruno pede pelo robô (ferramenta da IA).
    const r = await runTool(
      { shop: shopBot(shopId), phone: '11966660000', waId: null, customer: get('SELECT * FROM customers WHERE id = ?', [bruno])!, profileName: null, now: at(eve, '09:00'), dryRun: true } as never,
      'entrar_lista_espera',
      { data: D, periodo: 'qualquer' },
    );
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /lista_de_espera/);
    const agenda = (await owner('GET', `/api/shop/agenda?date=${D}`)).data;
    assert.deepEqual(
      agenda.waitlist.map((w: { customer_name: string }) => w.customer_name),
      ['Pedro Alves', 'Bruno Costa'],
      'na ordem de chegada',
    );
  });

  test('NÃO no lembrete cancela e a vaga vai para o primeiro da fila, guardada por 30 minutos', async () => {
    const reply = await handleInbound({ shopId, from: '5511999990000', text: 'não', now: at(eve, '11:00'), dryRun: true });
    assert.match(reply!, /cancelei seu horário/);
    assert.equal(status(joaoAppt).status, 'cancelled');

    // De madrugada não sai oferta.
    assert.equal(await offerFreedSlots(shopBot(shopId), at(eve, '23:30')), 0);
    assert.equal(await offerFreedSlots(shopBot(shopId), at(eve, '11:01')), 1, 'só o Pedro: o Bruno espera a vez');
    const offer = lastMessage(pedro)!;
    assert.equal(offer.kind, 'espera');
    assert.match(offer.body, /Abriu uma vaga na Navalha de Ouro: \*.+ às 10h com Marcos\*/);
    assert.equal(lastMessage(bruno), undefined);
    // Dentro dos 30 minutos, a vaga continua guardada para o Pedro.
    assert.equal(await offerFreedSlots(shopBot(shopId), at(eve, '11:20')), 0);
  });

  test('sem resposta em 30 minutos, a vaga vai para o próximo; o SIM marca', async () => {
    assert.equal(await offerFreedSlots(shopBot(shopId), at(eve, '11:35')), 1);
    assert.match(lastMessage(bruno)!.body, /às 10h com Marcos/);
    const yes = await handleInbound({ shopId, from: '5511966660000', text: 'sim', now: at(eve, '11:36'), dryRun: true });
    assert.match(yes!, /Fechado, Bruno! ✅/);
    assert.equal(get<{ status: string }>("SELECT status FROM waitlist WHERE customer_id = ?", [bruno])!.status, 'booked');
    // O Pedro responde depois: a vaga já foi preenchida, e ele continua na fila.
    const late = await handleInbound({ shopId, from: '5511977770000', text: 'sim', now: at(eve, '11:40'), dryRun: true });
    assert.match(late!, /acabou de ser ocupado/);
    assert.equal(get<{ status: string }>("SELECT status FROM waitlist WHERE customer_id = ?", [pedro])!.status, 'waiting');
  });

  test('quem não confirmar pode ter o horário liberado (se a barbearia ligar)', async () => {
    const settings = (await owner('GET', '/api/shop/bot')).data;
    const put = (extra: Record<string, unknown>) =>
      owner('PUT', '/api/shop/bot', {
        bot_name: settings.bot_name,
        bot_persona: settings.bot_persona,
        wa_provider: 'simulador',
        wa_config: {},
        slot_step_min: settings.slot_step_min,
        reminder_hours: 24,
        habit_enabled: settings.habit_enabled,
        habit_weekday: settings.habit_weekday,
        habit_time: settings.habit_time,
        winback_enabled: settings.winback_enabled,
        winback_days: settings.winback_days,
        winback_message: settings.winback_message,
        ...extra,
      });
    assert.equal((await put({ confirm_release_hours: 23 })).status, 400, 'precisa deixar 2 horas para responder');
    assert.equal((await put({ confirm_release_hours: 3 })).data.confirm_release_hours, 3);

    // Um horário novo do Pedro, no dia seguinte, com o lembrete sem resposta.
    const D2 = addDays(D, 1);
    const p = book({ shopId, customerId: pedro, barberId: marcos, serviceId: corte, date: D2, time: '10:30', source: 'painel', now: at(D, '08:00') });
    run('UPDATE appointments SET created_at = ? WHERE id = ?', [at(addDays(D2, -4), '10:00').toISOString(), p.id]);
    assert.equal(await appointmentReminders(shopBot(shopId), at(D, '10:31')), 1);
    const shop = shopBot(shopId);
    assert.equal(await releaseUnconfirmed(shop, at(D2, '07:00')), 0, 'ainda falta mais de 3 horas');
    assert.equal(await releaseUnconfirmed(shop, at(D2, '07:31')), 1);
    assert.equal(status(p.id).status, 'cancelled');
    assert.equal(lastMessage(pedro)!.kind, 'liberado');
    // Quem confirmou (aqui, pela área do cliente) não perde o horário. Outro cliente não confirma o horário dele.
    const kept = book({ shopId, customerId: ana, barberId: marcos, serviceId: corte, date: D2, time: '10:00', source: 'painel', now: at(D, '08:00') });
    run('UPDATE appointments SET created_at = ? WHERE id = ?', [at(addDays(D2, -4), '10:00').toISOString(), kept.id]);
    await appointmentReminders(shop, at(D, '10:01'));
    assert.equal((await (await enter('11977770000'))('POST', `/api/customer/navalha/appointments/${kept.id}/confirm`)).status, 404);
    assert.ok((await (await enter('11988880000'))('POST', `/api/customer/navalha/appointments/${kept.id}/confirm`)).data.confirmed_at);
    assert.equal(await releaseUnconfirmed(shop, at(D2, '07:05')), 0);
    assert.equal(status(kept.id).status, 'scheduled');
  });

  test('o dono põe na lista, tira e confirma pelo cliente', async () => {
    const day = addDays(today, 6);
    const added = await owner('POST', '/api/shop/waitlist', { customer_id: joao, date: day, period: 'qualquer' });
    assert.equal(added.status, 201);
    assert.equal((await owner('GET', `/api/shop/agenda?date=${day}`)).data.waitlist.length, 1);
    assert.equal((await owner('DELETE', `/api/shop/waitlist/${added.data.id}`)).status, 200);
    assert.equal((await owner('GET', `/api/shop/agenda?date=${day}`)).data.waitlist.length, 0);
    // Limite: 3 dias na lista ao mesmo tempo.
    for (let i = 7; i <= 9; i++) joinWaitlist({ shopId, customerId: joao, date: addDays(today, i), source: 'painel' });
    assert.throws(() => joinWaitlist({ shopId, customerId: joao, date: addDays(today, 10), source: 'painel' }), /3 dias/);
    // Marcar um horário no dia atende o pedido da lista.
    const free = addDays(today, 7);
    book({ shopId, customerId: joao, barberId: marcos, serviceId: corte, date: free, time: '10:00', source: 'painel' });
    assert.equal(all<{ status: string }>("SELECT status FROM waitlist WHERE customer_id = ? AND date = ?", [joao, free])[0].status, 'booked');
  });
});
