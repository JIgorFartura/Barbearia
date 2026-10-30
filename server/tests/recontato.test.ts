import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-recontato-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book, cancel } = await import('../scheduling.js');
const { awayCustomers, runAutomations, winbackResults, winbacks } = await import('../automations.js');
const { handleInbound } = await import('../bot/inbound.js');
const { createSale } = await import('../finance.js');
const { shopBot } = await import('../messaging.js');

/** "AAAA-MM-DD HH:MM" no horário de Brasília → Date. */
const at = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}:00-03:00`);
/** Segunda-feira, começo da manhã. */
const T0 = at('2026-11-16 09:05');

let server: Server;
let base = '';
const owner = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'dono@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

// Navalha de Ouro (convite semanal do horário de costume desligado, para cada teste olhar só o recontato).
const shopId = run("INSERT INTO barbershops (slug, name, bot_name, habit_enabled, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 0, ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Dono', 'dono@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const barberIn = (shop: number, name: string) => {
  const id = run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shop, name, nowIso()]).lastInsertRowid;
  for (let d = 1; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [id, d]);
  return id;
};
const serviceIn = (shop: number, name: string, price: number) =>
  run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', ?, ?, 30, ?)", [shop, name, price, nowIso()])
    .lastInsertRowid;
const customerIn = (shop: number, name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shop, name, phone, nowIso()]).lastInsertRowid;

const paulo = barberIn(shopId, 'Paulo');
const marcos = barberIn(shopId, 'Marcos');
const corte = serviceIn(shopId, 'Corte', 5000);
// Rita: toda segunda às 17h com o Paulo, a cada 14 dias; a última há 21 dias (passou bem do ritmo dela).
const rita = customerIn(shopId, 'Rita Lopes', '11977771111');
// Luis: a cada 40 dias; a última há 30 (ainda dentro do ritmo dele).
const luis = customerIn(shopId, 'Luis Prado', '11977772222');
// Maria e Bruno: uma visita só (sem ritmo: vale o prazo de 30 dias da barbearia), há 35 e 40 dias.
const maria = customerIn(shopId, 'Maria Souza', '11977774444');
const bruno = customerIn(shopId, 'Bruno Dias', '11977773333');
const visit = (customerId: number, barberId: number, date: string, time: string) =>
  book({ shopId, customerId, barberId, serviceId: corte, date, time, source: 'painel' });
for (const d of ['2026-09-28', '2026-10-12', '2026-10-26']) visit(rita, paulo, d, '17:00');
for (const d of ['2026-07-29', '2026-09-07', '2026-10-17']) visit(luis, marcos, d, '11:00');
visit(maria, marcos, '2026-10-12', '10:00');
visit(bruno, paulo, '2026-10-07', '11:00');

const lastOut = (customerId: number) =>
  get<{ body: string; kind: string }>("SELECT body, kind FROM messages WHERE customer_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", [customerId]);
const countKind = (customerId: number, kind: string) =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ? AND direction = 'out' AND kind = ?", [customerId, kind])!.n;

describe('recontato de quem sumiu', () => {
  test('o ritmo de cada cliente decide quando ele vira sumido', () => {
    assert.deepEqual(
      awayCustomers(shopId, T0).map((a) => [a.name, a.days, a.rhythm, a.after]),
      [
        ['Rita Lopes', 21, 14, 21],
        ['Maria Souza', 35, null, 30],
        ['Bruno Dias', 40, null, 30],
      ],
    );
    // Pelo prazo para todos: o Luis seria chamado antes da hora dele, e a Rita só no dia 30.
    run('UPDATE barbershops SET winback_rhythm = 0 WHERE id = ?', [shopId]);
    assert.deepEqual(
      awayCustomers(shopId, T0).map((a) => a.name),
      ['Luis Prado', 'Maria Souza', 'Bruno Dias'],
    );
    run('UPDATE barbershops SET winback_rhythm = 1 WHERE id = ?', [shopId]);
  });

  test('o dono liga o desconto de volta no painel (e um app antigo não apaga o que está salvo)', async () => {
    const s = (await owner('GET', '/api/shop/bot')).data;
    assert.equal(s.winback_rhythm, true);
    assert.equal(s.winback_discount, null);
    assert.equal(s.winback_followup_days, 7);
    assert.equal((await owner('PUT', '/api/shop/bot', { ...s, winback_discount: 70 })).status, 400);
    const r = await owner('PUT', '/api/shop/bot', { ...s, winback_discount: 15, winback_discount_days: 14 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.winback_discount, 15);
    const { winback_rhythm, winback_discount, winback_discount_days, winback_followup_days, winback_followup_message, ...old } = r.data;
    void [winback_rhythm, winback_discount, winback_discount_days, winback_followup_days, winback_followup_message];
    assert.equal((await owner('PUT', '/api/shop/bot', old)).data.winback_discount, 15);
    // O modelo com o desconto e o da segunda mensagem aparecem para cadastrar na Meta.
    assert.ok(['sumido_desconto', 'sumido2'].every((k) => s.templates.some((t: { kind: string }) => t.kind === k)));
  });

  test('a mensagem promete o desconto e o SIM marca o horário de costume com ele', async () => {
    assert.equal((await runAutomations(T0)).winbacks, 3);
    const msg = lastOut(rita)!;
    assert.equal(msg.kind, 'sumido');
    assert.match(msg.body, /Faz 21 dias/);
    assert.match(msg.body, /\*15% de desconto\* no próximo horário, marcando até 30\/11/);
    assert.match(msg.body, /Tenho \*segunda, 16\/11 às 17h com Paulo\*/);
    assert.match(msg.body, /PARAR/);
    assert.match(lastOut(maria)!.body, /Me diga o dia e o horário que eu marco pra você/);

    const reply = await handleInbound({ shopId, from: '5511977771111', text: 'Sim', now: at('2026-11-16 09:20') });
    assert.match(reply!, /com 15% de desconto: R\$\s42,50/);
    const a = get<{ id: number; price_cents: number; promo_percent: number; promo_kind: string }>(
      "SELECT id, price_cents, promo_percent, promo_kind FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at = '2026-11-16 17:00'",
      [rita],
    )!;
    assert.deepEqual([a.price_cents, a.promo_percent, a.promo_kind], [4250, 15, 'volta']);

    // Cancelou: o desconto volta a valer e entra sozinho no horário que ela marcar pela área.
    cancel(shopId, a.id);
    const b = book({ shopId, customerId: rita, barberId: marcos, serviceId: corte, date: '2026-11-18', time: '10:00', source: 'cliente', now: at('2026-11-16 12:00') });
    assert.deepEqual([b.price_cents, b.promo_percent, b.promo_kind], [4250, 15, 'volta']);
    // Uma vez só: outro horário sai com o preço normal.
    const c = book({ shopId, customerId: rita, barberId: marcos, serviceId: corte, date: '2026-11-25', time: '10:00', source: 'cliente', now: at('2026-11-16 12:05') });
    assert.deepEqual([c.price_cents, c.promo_percent], [5000, null]);
    cancel(shopId, c.id);
  });

  test('segunda mensagem só para quem não respondeu nem marcou, uma vez', async () => {
    // O Bruno respondeu (está viajando): a conversa aconteceu, o robô não insiste.
    await handleInbound({ shopId, from: '11977773333', text: 'Oi! To viajando, volto mês que vem', now: at('2026-11-16 10:00') });
    assert.equal((await runAutomations(at('2026-11-22 10:00'))).winbacks, 0, 'antes dos 7 dias, nada');
    assert.equal((await runAutomations(at('2026-11-23 10:00'))).winbacks, 1);
    const m = lastOut(maria)!;
    assert.equal(m.kind, 'sumido2');
    assert.match(m.body, /Seu desconto de \*15%\* ainda vale, marcando até 30\/11/);
    assert.match(m.body, /PARAR/);
    assert.equal(countKind(bruno, 'sumido2'), 0);
    // A Rita marcou e veio: saiu da lista.
    assert.equal(
      awayCustomers(shopId, at('2026-11-23 10:00')).some((x) => x.id === rita),
      false,
    );
    assert.equal((await runAutomations(at('2026-11-24 10:00'))).winbacks, 0, 'segunda mensagem, uma só');
  });

  test('o painel mostra a situação de cada um e quantos voltaram', async () => {
    const appt = get<{ id: number }>("SELECT id FROM appointments WHERE customer_id = ? AND starts_at = '2026-11-18 10:00'", [rita])!;
    createSale({ shopId, userId: null, appointmentId: appt.id, items: [{ catalog_item_id: corte, qty: 1, unit_price_cents: 4250 }], method: 'pix', now: at('2026-11-18 10:40') });
    assert.deepEqual(winbackResults(shopId, at('2026-11-24 10:00')), { contacted: 3, returned: 1, revenueCents: 4250 });
    const m = awayCustomers(shopId, at('2026-11-24 10:00')).find((x) => x.id === maria)!;
    assert.ok(m.contactedAt && m.followedUpAt);
    assert.deepEqual(m.promo, { percent: 15, validUntil: '2026-11-30' });
    const r = await owner('GET', '/api/shop/winback');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['customers', 'days', 'discount', 'results', 'rhythm']);
  });

  test('quem recebeu o convite do horário de costume hoje só é chamado no dia seguinte', async () => {
    // Caio: toda segunda às 15h com o Marcos, a cada 14 dias; a última há 21 dias.
    const caio = customerIn(shopId, 'Caio Reis', '11977775555');
    for (const d of ['2026-10-19', '2026-11-02', '2026-11-16']) visit(caio, marcos, d, '15:00');
    run("UPDATE barbershops SET habit_enabled = 1, habit_weekday = 1, habit_time = '09:00' WHERE id = ?", [shopId]);
    await runAutomations(at('2026-12-07 09:05'));
    assert.equal(lastOut(caio)!.kind, 'costume');
    assert.equal(countKind(caio, 'sumido'), 0);
    await runAutomations(at('2026-12-08 09:30'));
    assert.equal(lastOut(caio)!.kind, 'sumido');
    run('UPDATE barbershops SET habit_enabled = 0 WHERE id = ?', [shopId]);
  });

  test('o desconto vence: marcando depois do prazo, preço normal', () => {
    const late = book({ shopId, customerId: maria, barberId: paulo, serviceId: corte, date: '2026-12-02', time: '10:00', source: 'cliente', now: at('2026-12-01 10:00') });
    assert.equal(late.promo_percent, null);
    cancel(shopId, late.id);
  });
});

describe('WhatsApp oficial (Meta): modelos do recontato', () => {
  test('com desconto vai o modelo próprio (se cadastrado); sem ele, o de sempre; a segunda mensagem tem o dela', async () => {
    const realFetch = globalThis.fetch;
    const sent: { template: { name: string; components: { parameters: { text: string }[] }[] } }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://graph.facebook.com/')) {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const cfg = { token: 'token-de-teste-123', phoneNumberId: '123456', tpl_sumido: 'cliente_sumido', tpl_sumido_desconto: 'cliente_sumido_desconto', tpl_sumido2: 'cliente_sumido_2' };
      const meta = run(
        "INSERT INTO barbershops (slug, name, bot_name, habit_enabled, wa_provider, wa_config, winback_discount, created_at) VALUES ('meta', 'Barbearia Meta', 'Zé', 0, 'meta', ?, 20, ?)",
        [JSON.stringify(cfg), nowIso()],
      ).lastInsertRowid;
      const ze = barberIn(meta, 'Zé');
      const svc = serviceIn(meta, 'Corte', 4000);
      const ana = customerIn(meta, 'Ana Lima', '11966660001');
      book({ shopId: meta, customerId: ana, barberId: ze, serviceId: svc, date: '2026-10-12', time: '10:00', source: 'painel' });
      const params = (i: number) => sent[i].template.components[0].parameters.map((p) => p.text);

      await winbacks(shopBot(meta), T0);
      assert.equal(sent[0].template.name, 'cliente_sumido_desconto');
      assert.deepEqual(params(0), ['Ana', 'Barbearia Meta', '35', '20%', '30/11']);

      // Sem o modelo com desconto cadastrado: vai o de sempre (o desconto vale do mesmo jeito).
      run('UPDATE barbershops SET wa_config = ? WHERE id = ?', [JSON.stringify({ ...cfg, tpl_sumido_desconto: '' }), meta]);
      const beto = customerIn(meta, 'Beto Lima', '11966660002');
      book({ shopId: meta, customerId: beto, barberId: ze, serviceId: svc, date: '2026-10-13', time: '10:00', source: 'painel' });
      await winbacks(shopBot(meta), at('2026-11-16 11:00'));
      assert.equal(sent[1].template.name, 'cliente_sumido');
      assert.deepEqual(params(1), ['Beto', 'Barbearia Meta', '34']);

      await winbacks(shopBot(meta), at('2026-11-23 12:00'));
      assert.deepEqual(
        sent
          .slice(2)
          .map((m) => [m.template.name, m.template.components[0].parameters.map((p) => p.text)])
          .sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
        [
          ['cliente_sumido_2', ['Ana', 'Barbearia Meta']],
          ['cliente_sumido_2', ['Beto', 'Barbearia Meta']],
        ],
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
