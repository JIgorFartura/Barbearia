import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-gerente-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book } = await import('../scheduling.js');
const { createSale } = await import('../finance.js');
const { monthForecast, occupancy, periodNumbers, retention, weekSummary } = await import('../insights.js');
const { handlePlatformInbound, weeklySummary } = await import('../manager.js');
const { savePlatformChannel, platformWebhookToken } = await import('../platform.js');
const { shopBot } = await import('../messaging.js');

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
const at = (date: string, time = '12:00') => new Date(`${date}T${time}:00-03:00`);

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, winback_days, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 45, ?)", [nowIso()]).lastInsertRowid;
const carlos = run(
  "INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos Lima', 'carlos@navalha.com', '11977776666', ?, ?, ?)",
  [shopId, hashPassword('senha-forte-1'), nowIso(), nowIso()],
).lastInsertRowid;
const barber = (name: string) => {
  const id = run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shopId, name, nowIso()]).lastInsertRowid;
  // Segunda a sábado, 9h às 18h.
  for (let d = 1; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '18:00')", [id, d]);
  return id;
};
const paulo = barber('Paulo');
const marcos = barber('Marcos');
run(
  "INSERT INTO users (barbershop_id, role, name, phone, barber_id, password_hash, terms_accepted_at, created_at) VALUES (?, 'barber', 'Marcos', '11955554444', ?, ?, ?, ?)",
  [shopId, marcos, hashPassword('senha-forte-1'), nowIso(), nowIso()],
);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shopId, name, phone, nowIso()]).lastInsertRowid;

// Semana de referência: segunda 17/03/2031 a domingo 23/03 (passado em relação ao "agora" dos testes).
const MON = '2031-03-17';
/** Horário atendido e pago (corte R$ 50). */
function visit(customerId: number, date: string, time: string, barberId = paulo) {
  const a = book({ shopId, customerId, barberId, serviceId: corte, date, time, source: 'painel', now: at(date, '08:00') });
  createSale({ shopId, userId: null, appointmentId: a.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix', now: at(date, '18:00') });
  return a;
}
const ana = customer('Ana Lima', '11988880000');
const bia = customer('Bia Souza', '11988881111');
const caio = customer('Caio Reis', '11988882222');
const davi = customer('Davi Melo', '11988883333');

// Semana: segunda 10h (Ana) e terça 14h (Caio) com o Paulo; quarta de manhã o Paulo bloqueou 9h–12h.
visit(ana, MON, '10:00');
visit(caio, '2031-03-18', '14:00');
run("INSERT INTO barber_blocks (barber_id, starts_at, ends_at, reason, created_at) VALUES (?, '2031-03-19 09:00', '2031-03-19 12:00', 'médico', ?)", [paulo, nowIso()]);
// Semana anterior: um corte só (para a comparação).
visit(davi, '2031-03-12', '11:00');

describe('indicadores da barbearia', () => {
  test('números do período e ocupação da agenda (expediente menos bloqueios)', () => {
    const p = periodNumbers(shopId, MON, '2031-03-23');
    assert.deepEqual(p, { from: MON, to: '2031-03-23', income: 10000, sales: 2, services: 2, average: 5000 });
    const o = occupancy(shopId, MON, '2031-03-23');
    // Paulo: 6 dias × 9h = 3240 min, menos 3h de bloqueio = 3060; marcado: 30 + 30 min.
    const p1 = o.byBarber.find((b) => b.id === paulo)!;
    assert.equal(p1.open_min, 3060);
    assert.equal(p1.booked_min, 60);
    assert.equal(o.byBarber.find((b) => b.id === marcos)!.open_min, 3240);
    assert.equal(o.open_min, 6300);
    assert.equal(o.rate, 60 / 6300);
    const mon10 = o.heat.find((c) => c.weekday === 1 && c.hour === 10)!;
    assert.deepEqual(mon10, { weekday: 1, hour: 10, open_min: 120, booked_min: 30 });
    assert.equal(o.heat.some((c) => c.weekday === 0), false, 'domingo fechado não entra no mapa');
    const wed9 = o.heat.find((c) => c.weekday === 3 && c.hour === 9)!;
    assert.equal(wed9.open_min, 60, 'quarta 9h: só o Marcos (o Paulo bloqueou)');
  });

  test('retorno dos clientes, quem está passando do tempo e quem sumiu', () => {
    // Um ano depois da semana de referência (as visitas dela ficam fora da janela de 365 dias).
    const D = '2032-06-10';
    // Ana: 80 e 50 dias atrás (voltou); Bia: 70 dias atrás (não voltou, sumida); Caio: a cada 10 dias, a última há 20;
    // Davi: há 5 dias.
    const ago = (n: number) => new Date(at(D).getTime() - n * 86400000).toISOString().slice(0, 10);
    for (const [c, days, h] of [
      [ana, 80, '09:00'],
      [ana, 50, '09:00'],
      [bia, 70, '10:00'],
      [caio, 40, '11:00'],
      [caio, 30, '11:00'],
      [caio, 20, '11:00'],
      [davi, 5, '12:00'],
    ] as const) {
      visit(c, ago(days), h);
    }
    const r = retention(shopId, at(D));
    assert.equal(r.active, 4);
    assert.equal(r.cohort, 2);
    assert.equal(r.returned, 1);
    assert.equal(r.returnRate, 0.5);
    assert.deepEqual(
      r.atRisk.map((c) => [c.name, c.days, c.interval]),
      [['Caio Reis', 20, 10]],
    );
    assert.equal(r.away, 2, 'Ana (50 dias) e Bia (70) passaram dos 45 dias do cliente sumido');
  });

  test('previsão do mês: o que entrou, os horários marcados e a média do balcão', () => {
    const D = '2031-07-15';
    visit(ana, '2031-07-02', '10:00');
    // Venda de balcão (produto, sem horário) nos últimos 28 dias.
    const pomada = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, 'product', 'Pomada', 2800, ?)", [shopId, nowIso()]).lastInsertRowid;
    createSale({ shopId, userId: null, items: [{ catalog_item_id: pomada, qty: 1 }], method: 'dinheiro', now: at('2031-07-10', '15:00') });
    // Marcado para o resto do mês.
    book({ shopId, customerId: bia, barberId: marcos, serviceId: corte, date: '2031-07-20', time: '10:00', source: 'painel', now: at(D) });
    const f = monthForecast(shopId, at(D));
    assert.equal(f.month, '2031-07');
    assert.equal(f.soFar, 5000 + 2800);
    assert.equal(f.scheduled, 5000);
    assert.equal(f.extraPerDay, 100, 'R$ 28 em 28 dias');
    assert.equal(f.daysLeft, 16);
    assert.equal(f.projected, 7800 + 5000 + 1600);
  });

  test('resumo da semana com a comparação', () => {
    const w = weekSummary(shopId, MON);
    assert.equal(w.current.income, 10000);
    assert.equal(w.previous.income, 5000);
    assert.equal(w.topBarber?.name, 'Paulo');
    assert.equal(w.noShows, 0);
    assert.equal(w.newCustomers, 2, 'Ana e Caio vieram pela primeira vez nessa semana');
  });
});

describe('gerente virtual no WhatsApp da plataforma', () => {
  const sentTo = (phone: string) =>
    all<{ body: string; kind: string }>("SELECT body, kind FROM platform_messages WHERE phone = ? AND direction = 'out' ORDER BY id", [phone]);

  test('o dono pergunta por palavra-chave e recebe os números', async () => {
    const reply = await handlePlatformInbound({ from: '5511977776666', text: 'Quanto entrou hoje?', now: at('2031-03-17', '19:00') });
    assert.match(reply!, /\*Hoje\* \(17\/03\)/);
    assert.match(reply!, /Entrou \*R\$\s50,00\* · 1 atendimento/);
    assert.match(reply!, /No mesmo dia da semana passada \(segunda\): R\$\s0,00/);
    const week = await handlePlatformInbound({ from: '5511977776666', text: 'e a semana?', now: at('2031-03-23', '20:00') });
    assert.match(week!, /\*Semana\* \(17\/03 a 23\/03\)/);
    assert.match(week!, /Entrou \*R\$\s100,00\*/);
    assert.match(week!, /\(\+100%\)/);
    const out = sentTo('11977776666');
    assert.equal(out.length, 2, 'as respostas saem pelo WhatsApp da plataforma');
    assert.equal(out[0].kind, 'gerente');
    const menu = await handlePlatformInbound({ from: '5511977776666', text: 'oi', now: at('2031-03-23', '20:00') });
    assert.match(menu!, /Sou o gerente virtual da Navalha de Ouro/);
  });

  test('agenda de amanhã e bloqueio pelo WhatsApp (avisa se já tinha cliente)', async () => {
    book({ shopId, customerId: davi, barberId: paulo, serviceId: corte, date: '2031-03-25', time: '15:00', source: 'painel', now: at('2031-03-24') });
    const agenda = await handlePlatformInbound({ from: '5511977776666', text: 'agenda de amanhã', now: at('2031-03-24', '20:00') });
    assert.match(agenda!, /Agenda de amanhã/);
    assert.match(agenda!, /\*Paulo\*: 15h Davi/);
    assert.match(agenda!, /\*Marcos\*: nenhum horário · 18 vagas livres/);

    const blocked = await handlePlatformInbound({ from: '5511977776666', text: 'bloquear o Paulo amanhã das 14h às 16h', now: at('2031-03-24', '20:05') });
    assert.match(blocked!, /Agenda do Paulo bloqueada terça, 25\/03, das 14h às 16h/);
    assert.match(blocked!, /Já tinha horário marcado nesse período: 15h Davi/);
    assert.ok(get("SELECT 1 AS ok FROM barber_blocks WHERE barber_id = ? AND starts_at = '2031-03-25 14:00' AND ends_at = '2031-03-25 16:00'", [paulo]));
    const ask = await handlePlatformInbound({ from: '5511977776666', text: 'bloquear amanhã', now: at('2031-03-24', '20:06') });
    assert.match(ask!, /De qual barbeiro\?/);
  });

  test('o barbeiro vê só a agenda dele; quem não é da casa recebe uma explicação por dia', async () => {
    const mine = await handlePlatformInbound({ from: '5511955554444', text: 'minha agenda amanhã', now: at('2031-03-24', '20:00') });
    assert.match(mine!, /\*Marcos\*/);
    assert.doesNotMatch(mine!, /Paulo|Davi/);
    const stranger = await handlePlatformInbound({ from: '5511912345678', text: 'quero marcar um corte', now: at('2031-03-24', '20:00') });
    assert.match(stranger!, /só atende os donos e barbeiros cadastrados/);
    assert.equal(await handlePlatformInbound({ from: '5511912345678', text: 'oi?', now: at('2031-03-24', '21:00') }), null, 'não repete no mesmo dia');
  });

  test('com a IA: entende a pergunta livre e usa as ferramentas do gerente', async () => {
    const calls: string[] = [];
    let step = 0;
    const create = async (params: { tools?: { name: string }[]; messages: unknown[] }) => {
      calls.push((params.tools ?? []).map((t) => t.name).join(','));
      step++;
      if (step === 1) {
        return {
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 't1', name: 'numeros', input: { de: '2031-03-17', ate: '2031-03-23' } }],
        };
      }
      const last = JSON.stringify(params.messages[params.messages.length - 1]);
      assert.match(last, /R\$\s?100,00|10000/);
      return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Na semana passada entraram R$ 100,00 (o dobro da anterior). 💈' }] };
    };
    const reply = await handlePlatformInbound({ from: '5511977776666', text: 'como fomos na semana passada?', now: at('2031-03-24', '09:00'), create: create as never });
    assert.equal(reply, 'Na semana passada entraram R$ 100,00 (o dobro da anterior). 💈');
    assert.match(calls[0], /numeros,previsao_mes,agenda,clientes,resumo_semana,bloquear_agenda/);
  });

  test('entrada pelo webhook do WhatsApp da plataforma (com o segredo da URL)', async () => {
    savePlatformChannel('evolution', { baseUrl: 'http://127.0.0.1:9', instance: 'plataforma', apiKey: 'chave-de-teste' });
    const token = platformWebhookToken();
    const payload = { event: 'messages.upsert', data: { key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: 'ABC123' }, message: { conversation: 'previsão do mês' } } };
    assert.equal((await fetch(`${base}/api/webhooks/platform/evolution/errado`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status, 404);
    assert.equal((await fetch(`${base}/api/webhooks/platform/meta/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, 'canal errado');
    const r = await fetch(`${base}/api/webhooks/platform/evolution/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(r.status, 200);
    for (let i = 0; i < 50 && !get("SELECT 1 AS ok FROM platform_messages WHERE external_id = 'ABC123'"); i++) await new Promise((res) => setTimeout(res, 20));
    for (let i = 0; i < 50 && !get("SELECT 1 AS ok FROM platform_messages WHERE body LIKE '%Previsão do mês%'"); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(get("SELECT 1 AS ok FROM platform_messages WHERE direction = 'in' AND external_id = 'ABC123' AND user_id = ?", [carlos]));
    assert.ok(get("SELECT 1 AS ok FROM platform_messages WHERE direction = 'out' AND body LIKE '%Previsão do mês%'"));
    // A mesma mensagem de novo (reenvio do WhatsApp): não responde duas vezes.
    assert.equal(await handlePlatformInbound({ from: '5511977776666', text: 'previsão do mês', externalId: 'ABC123' }), null);
    savePlatformChannel('simulador', null);
  });

  test('resumo da semana: segunda a partir das 8h, uma vez, e dá para desligar', async () => {
    const shop = shopBot(shopId);
    assert.equal(weeklySummary(shop, at('2031-03-24', '07:50')), null, 'antes das 8h');
    const msg = weeklySummary(shop, at('2031-03-24', '08:05'))!;
    assert.match(msg.text, /Resumo da semana\* da Navalha de Ouro \(17\/03 a 23\/03\)/);
    assert.match(msg.text, /Entrou \*R\$\s100,00\* \(\+100% em relação à semana anterior\)/);
    assert.match(msg.text, /Quem mais atendeu: Paulo \(2\)/);
    assert.deepEqual(msg.template.params.slice(0, 5), ['Navalha de Ouro', '17/03 a 23/03', 'R$ 100,00', '+100%', '2']);
    assert.equal(weeklySummary(shop, at('2031-03-24', '09:00')), null, 'uma vez por semana');

    assert.equal((await owner('PUT', '/api/shop/manager', { weekly_summary: false })).status, 200);
    assert.equal(weeklySummary(shopBot(shopId), at('2031-03-31', '08:05')), null, 'desligado');
    const rep = (await owner('GET', '/api/shop/reports?period=30')).data;
    assert.equal(rep.manager.weekly_summary, false);
    assert.ok('heat' in rep.occupancy && 'atRisk' in rep.retention && 'projected' in rep.forecast);
  });
});
