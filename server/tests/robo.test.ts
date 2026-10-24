import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Banco em memória, sem automações em segundo plano e sem chave da Anthropic.
process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-robo-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book, cancel, freeTimes } = await import('../scheduling.js');
const { inferHabit, typicalInterval } = await import('../habits.js');
const { runAutomations } = await import('../automations.js');
const { handleInbound } = await import('../bot/inbound.js');
const { addStamps } = await import('../loyalty.js');
const { addDays, localNow, weekdayOf } = await import('../time.js');
const { parseEvolutionWebhook, parseMetaWebhook, phoneKey } = await import('../whatsapp.js');

/** "AAAA-MM-DD HH:MM" no horário de Brasília → Date. */
const at = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}:00-03:00`);

let server: Server;
let base = '';

function client() {
  let cookies: Record<string, string> = {};
  return async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      cookies = { ...cookies, [k]: v.join('=') };
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* texto puro */
    }
    return { status: res.status, data };
  };
}

// ---------- cenário: Navalha de Ouro, robô "João", barbeiros Paulo e Marcos (seg a sáb, 9h às 19h)
const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', 'Dono', 'dono@navalha.com', ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
]);
const barber = (name: string) => run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shopId, name, nowIso()]).lastInsertRowid;
const paulo = barber('Paulo');
const marcos = barber('Marcos');
for (const b of [paulo, marcos]) {
  for (let d = 1; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [b, d]);
}
const service = (name: string, price: number) =>
  run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', ?, ?, 30, ?)", [
    shopId,
    name,
    price,
    nowIso(),
  ]).lastInsertRowid;
const corte = service('Corte', 5000);
service('Barba', 3500);
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shopId, name, phone, nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const maria = customer('Maria Souza', '11988880000');
const pedro = customer('Pedro Alves', '11977770000');

const MONDAY = at('2026-11-02 09:05');
const lastOut = (customerId: number) =>
  get<{ body: string; kind: string; status: string; tokens_in: number | null }>(
    "SELECT body, kind, status, tokens_in FROM messages WHERE customer_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1",
    [customerId],
  );

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe('agenda', () => {
  test('horários livres respeitam expediente, antecedência, agendamentos e bloqueios', () => {
    const friday = '2026-11-06';
    const free = () => freeTimes(shopId, friday, { barberId: paulo, now: MONDAY })[0].times;
    assert.equal(free()[0], '09:00');
    assert.equal(free().at(-1), '18:30');
    assert.equal(free().length, 20);

    const a = book({ shopId, customerId: pedro, barberId: paulo, date: friday, time: '17:00', source: 'cliente', now: MONDAY });
    assert.equal(a.ends_at, '2026-11-06 17:30');
    assert.equal(free().includes('17:00'), false);
    run("INSERT INTO barber_blocks (barber_id, starts_at, ends_at, reason, created_at) VALUES (?, '2026-11-06 12:00', '2026-11-06 13:00', 'almoço', ?)", [
      paulo,
      nowIso(),
    ]);
    assert.equal(free().includes('12:00') || free().includes('12:30'), false);
    assert.equal(free().includes('11:30'), true);

    // Domingo não tem expediente; hoje só a partir de agora + 30 min.
    assert.deepEqual(freeTimes(shopId, '2026-11-08', { barberId: paulo, now: MONDAY })[0].times, []);
    assert.equal(freeTimes(shopId, '2026-11-02', { barberId: paulo, now: MONDAY })[0].times[0], '10:00');
    cancel(shopId, a.id);
    assert.equal(free().includes('17:00'), true);
  });

  test('não marca horário ocupado, fora do expediente, sem antecedência ou além do limite', () => {
    const friday = '2026-11-06';
    const base = { shopId, barberId: paulo, date: friday, source: 'cliente' as const, now: MONDAY };
    const first = book({ ...base, customerId: maria, time: '15:00' });
    assert.throws(() => book({ ...base, customerId: pedro, time: '15:00' }), /não tem esse horário livre/);
    assert.throws(() => book({ ...base, customerId: pedro, time: '15:15' }), /não tem esse horário livre/);
    assert.throws(() => book({ ...base, customerId: pedro, time: '19:00' }), /não tem esse horário livre/);
    assert.throws(() => book({ ...base, customerId: pedro, date: '2026-11-08', time: '10:00' }), /não tem esse horário livre/);
    assert.throws(() => book({ ...base, customerId: pedro, date: '2026-11-02', time: '09:20' }), /não tem esse horário livre/);
    // O dono pode encaixar fora do expediente.
    const extra = book({ ...base, customerId: pedro, time: '19:00', source: 'painel' });
    // Limite de 2 horários futuros por cliente.
    const second = book({ ...base, customerId: maria, barberId: marcos, time: '10:00' });
    assert.throws(() => book({ ...base, customerId: maria, barberId: marcos, time: '11:00' }), /já tem horários marcados/);
    // Cliente não cancela horário de outro.
    assert.throws(() => cancel(shopId, first.id, { customerId: pedro }), /não encontrado/);
    for (const a of [first, extra, second]) cancel(shopId, a.id);
  });
});

describe('horário de costume', () => {
  test('descobre dia, hora, barbeiro e ritmo pelo histórico', () => {
    const v = (starts_at: string, barber_id: number) => ({ starts_at, barber_id, service_id: corte });
    const habit = inferHabit([v('2026-10-30 17:00', paulo), v('2026-10-23 17:10', paulo), v('2026-10-20 19:00', marcos), v('2026-10-16 17:00', paulo)]);
    assert.deepEqual(habit, { weekday: 5, time: '17:00', barberId: paulo, serviceId: corte, intervalDays: 7, source: 'automatico' });
    assert.equal(inferHabit([v('2026-10-30 17:00', paulo)]), null);
    assert.equal(inferHabit([v('2026-10-29 10:00', paulo), v('2026-10-28 10:00', paulo), v('2026-10-27 10:00', paulo), v('2026-10-26 10:00', paulo)]), null);
    assert.equal(typicalInterval([v('2026-10-30 17:00', paulo), v('2026-10-16 17:00', paulo), v('2026-10-02 17:00', paulo)]), 14);
  });
});

describe('automações', () => {
  test('segunda de manhã: oferece o horário de costume e chama quem sumiu (uma vez só)', async () => {
    for (const d of ['2026-10-16', '2026-10-23', '2026-10-30']) book({ shopId, customerId: joao, barberId: paulo, date: d, time: '17:00', source: 'painel' });
    book({ shopId, customerId: maria, barberId: marcos, date: '2026-09-20', time: '10:00', source: 'painel' });

    const first = await runAutomations(MONDAY);
    assert.deepEqual(first, { reminders: 0, habits: 1, winbacks: 1, reviews: 0, club: 0, released: 0, birthdays: 0 });
    const offer = lastOut(joao)!;
    assert.equal(offer.kind, 'costume');
    assert.equal(offer.status, 'simulated');
    assert.match(offer.body, /sexta, 06\/11 às 17h com Paulo/);
    assert.match(offer.body, /SIM/);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM bot_offers WHERE customer_id = ? AND status = 'pending'", [joao])!.n, 1);
    const winback = lastOut(maria)!;
    assert.equal(winback.kind, 'sumido');
    assert.match(winback.body, /Faz 43 dias/);
    assert.match(winback.body, /PARAR/);

    assert.deepEqual(await runAutomations(at('2026-11-02 09:30')), { reminders: 0, habits: 0, winbacks: 0, reviews: 0, club: 0, released: 0, birthdays: 0 });
  });

  test('cliente responde SIM e o robô marca o horário oferecido', async () => {
    const reply = await handleInbound({ shopId, from: '5511999990000', text: 'Sim!', now: at('2026-11-02 09:10') });
    assert.match(reply!, /Fechado, João/);
    assert.match(reply!, /sexta, 06\/11 às 17h com Paulo/);
    const appt = get<{ source: string; barber_id: number }>("SELECT source, barber_id FROM appointments WHERE customer_id = ? AND starts_at = '2026-11-06 17:00' AND status = 'scheduled'", [joao]);
    assert.deepEqual(appt, { source: 'whatsapp', barber_id: paulo });
    assert.equal(get<{ wa_id: string }>('SELECT wa_id FROM customers WHERE id = ?', [joao])!.wa_id, '5511999990000');
  });

  test('lembrete do horário 24h antes, uma vez só, e nunca de madrugada', async () => {
    book({ shopId, customerId: pedro, barberId: marcos, date: '2026-11-06', time: '18:00', source: 'painel' });
    assert.deepEqual(await runAutomations(at('2026-11-05 22:00')), { reminders: 0, habits: 0, winbacks: 0, reviews: 0, club: 0, released: 0, birthdays: 0 });
    const r = await runAutomations(at('2026-11-06 08:00'));
    assert.equal(r.reminders, 2);
    assert.match(lastOut(joao)!.body, /hoje \(sexta, 06\/11\) às 17h com Paulo/);
    assert.match(lastOut(pedro)!.body, /CANCELAR/);
    assert.equal((await runAutomations(at('2026-11-06 08:05'))).reminders, 0);
  });

  test('PARAR desliga as mensagens automáticas e CANCELAR desmarca o próximo horário', async () => {
    const stop = await handleInbound({ shopId, from: '11988880000', text: 'PARAR', now: at('2026-11-06 09:00') });
    assert.match(stop!, /não vou mais mandar/);
    assert.equal(get<{ v: number }>('SELECT reminders_opt_out AS v FROM customers WHERE id = ?', [maria])!.v, 1);
    const cancelled = await handleInbound({ shopId, from: '5511999990000', text: 'cancelar', now: at('2026-11-06 09:00') });
    assert.match(cancelled!, /Cancelado: sexta, 06\/11 às 17h/);
  });

  test('sem IA, o robô responde pelo menu (ex.: cartão fidelidade)', async () => {
    const campaign = run("INSERT INTO campaigns (barbershop_id, name, unit_label, goal, reward, created_at) VALUES (?, 'Clube da Cerveja', 'cervejas', 5, 'um copo', ?)", [
      shopId,
      nowIso(),
    ]).lastInsertRowid;
    addStamps(shopId, campaign, joao, 3, null);
    const reply = await handleInbound({ shopId, from: '11999990000', text: 'Quantas cervejas faltam pro meu prêmio?', now: at('2026-11-06 10:00') });
    assert.match(reply!, /3 de 5 cervejas\. Faltam 2 para ganhar um copo/);
  });
});

/** Resposta falsa da API no formato de uma mensagem. */
function fakeMessage(content: unknown[], stop_reason: string) {
  return {
    id: 'msg_teste',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
  } as any;
}

describe('robô com IA (respostas simuladas da API)', () => {
  test('"Olha na agenda do Paulo se tem vaga sábado 10h" → consulta e marca', async () => {
    const calls: any[] = [];
    const create = async (params: any) => {
      calls.push(structuredClone(params));
      if (calls.length === 1) {
        assert.equal(params.model, 'claude-opus-5-5');
        assert.equal(params.fallbacks, 'default');
        assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
        assert.equal(params.output_config.effort, 'low');
        assert.equal(params.system[0].cache_control.type, 'ephemeral');
        assert.match(params.system[1].text, /Seu nome: João\. Barbearia: Navalha de Ouro/);
        assert.match(params.system[1].text, /sábado, 07\/11 = 2026-11-07/);
        assert.match(params.system[1].text, new RegExp(`Paulo \\(id ${paulo}\\)`));
        assert.ok(params.tools.some((t: any) => t.name === 'agendar' && t.input_schema.type === 'object' && !('$schema' in t.input_schema)));
        assert.equal(params.messages.at(-1).role, 'user');
        return fakeMessage([{ type: 'tool_use', id: 't1', name: 'ver_horarios_livres', input: { data: '2026-11-07', barbeiro_id: paulo } }], 'tool_use');
      }
      if (calls.length === 2) {
        const result = params.messages.at(-1).content[0];
        assert.equal(result.type, 'tool_result');
        assert.ok(JSON.parse(result.content).barbeiros[0].horarios_livres.includes('10:00'));
        return fakeMessage([{ type: 'tool_use', id: 't2', name: 'agendar', input: { data: '2026-11-07', hora: '10:00', barbeiro_id: paulo } }], 'tool_use');
      }
      const result = params.messages.at(-1).content[0];
      assert.equal(result.is_error, false);
      assert.equal(JSON.parse(result.content).agendamento.barbeiro, 'Paulo');
      return fakeMessage([{ type: 'text', text: 'Marcado, João! Sábado, 07/11 às 10h com o Paulo. ✅' }], 'end_turn');
    };
    const reply = await handleInbound({ shopId, from: '11999990000', text: 'João, olha na agenda do Paulo se tem vaga sábado 10h e já marca', now: at('2026-11-06 10:00'), create });
    assert.equal(reply, 'Marcado, João! Sábado, 07/11 às 10h com o Paulo. ✅');
    assert.equal(calls.length, 3);
    assert.ok(get("SELECT 1 AS ok FROM appointments WHERE customer_id = ? AND starts_at = '2026-11-07 10:00' AND status = 'scheduled'", [joao]));
    assert.equal(lastOut(joao)!.tokens_in, 3000);
  });

  test('número novo: o robô pergunta o nome e cadastra', async () => {
    const create = async (params: any) => {
      if (params.messages.at(-1).content === 'Meu nome é Carlos Lima') {
        assert.match(params.system[1].text, /ainda não é cliente/);
        return fakeMessage([{ type: 'tool_use', id: 't1', name: 'cadastrar_cliente', input: { nome: 'Carlos Lima' } }], 'tool_use');
      }
      return fakeMessage([{ type: 'text', text: 'Prazer, Carlos! Já está cadastrado.' }], 'end_turn');
    };
    await handleInbound({ shopId, from: '5511966665555', text: 'Meu nome é Carlos Lima', now: at('2026-11-06 10:00'), create });
    assert.equal(get<{ name: string }>("SELECT name FROM customers WHERE phone = '11966665555'")!.name, 'Carlos Lima');
  });

  test('o robô não mexe nos horários de outro cliente', async () => {
    const pedroAppt = get<{ id: number }>("SELECT id FROM appointments WHERE customer_id = ? AND status = 'scheduled'", [pedro])!.id;
    let seen: any = null;
    const create = async (params: any) => {
      const last = params.messages.at(-1);
      if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        seen = last.content[0];
        return fakeMessage([{ type: 'text', text: 'Não encontrei esse horário.' }], 'end_turn');
      }
      return fakeMessage([{ type: 'tool_use', id: 't1', name: 'cancelar_horario', input: { agendamento_id: pedroAppt } }], 'tool_use');
    };
    await handleInbound({ shopId, from: '11999990000', text: `Cancela o horário ${pedroAppt}`, now: at('2026-11-06 10:00'), create });
    assert.equal(seen.is_error, true);
    assert.match(seen.content, /não encontrado/);
    assert.equal(get<{ status: string }>('SELECT status FROM appointments WHERE id = ?', [pedroAppt])!.status, 'scheduled');
  });

  test('recusa da IA vira uma resposta educada', async () => {
    const reply = await handleInbound({
      shopId,
      from: '11999990000',
      text: 'oi',
      now: at('2026-11-06 10:00'),
      create: async () => fakeMessage([], 'refusal'),
    });
    assert.match(reply!, /não consigo ajudar/);
  });
});

describe('WhatsApp', () => {
  test('lê as mensagens dos webhooks da Meta e da Evolution', () => {
    const meta = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: 'João' }, wa_id: '5511999990000' }],
                messages: [
                  { from: '5511999990000', id: 'wamid.1', type: 'text', text: { body: 'Oi' } },
                  { from: '5511999990000', id: 'wamid.2', type: 'audio', audio: {} },
                ],
              },
            },
          ],
        },
      ],
    };
    assert.deepEqual(parseMetaWebhook(meta), [
      { from: '5511999990000', name: 'João', text: 'Oi', externalId: 'wamid.1' },
      { from: '5511999990000', name: 'João', text: '', externalId: 'wamid.2' },
    ]);
    const evo = (key: object, message: object, event = 'messages.upsert') => ({ event, data: { key, pushName: 'Maria', message } });
    assert.deepEqual(parseEvolutionWebhook(evo({ remoteJid: '5511988880000@s.whatsapp.net', fromMe: false, id: 'E1' }, { conversation: 'Bom dia' })), [
      { from: '5511988880000', name: 'Maria', text: 'Bom dia', externalId: 'E1' },
    ]);
    assert.equal(parseEvolutionWebhook(evo({ remoteJid: '5511988880000@s.whatsapp.net', fromMe: true, id: 'E2' }, { conversation: 'x' })).length, 0);
    assert.equal(parseEvolutionWebhook(evo({ remoteJid: '123@g.us', fromMe: false, id: 'E3' }, { conversation: 'x' })).length, 0);
    assert.equal(
      parseEvolutionWebhook(evo({ remoteJid: '5511988880000@s.whatsapp.net', id: 'E4' }, { extendedTextMessage: { text: 'Oi' } }, 'MESSAGES_UPSERT')).length,
      1,
    );
    // Número sem o nono dígito encontra o mesmo cliente.
    assert.equal(phoneKey('11999990000'), phoneKey('1199990000'));
  });
});

describe('área do cliente e vouchers', () => {
  const dono = client();
  const ana = client();
  const outro = client();

  test('dono cria benefício; cliente entra pelo link e pega o voucher; balcão dá baixa', async () => {
    assert.equal((await dono('POST', '/api/auth/login', { email: 'dono@navalha.com', password: 'senha-forte-1' })).status, 200);
    const offer = await dono('POST', '/api/shop/offers', { title: 'Cerveja grátis no corte', valid_days: 7, per_customer: 1, max_total: 2, active: true });
    assert.equal(offer.status, 201, JSON.stringify(offer.data));

    const link = await dono('POST', `/api/shop/customers/${pedro}/access-link`);
    const token = new URL(link.data.url).searchParams.get('t');
    assert.equal((await ana('POST', '/api/public/shops/navalha/login/link', { token })).status, 200);
    assert.equal((await outro('POST', '/api/public/shops/navalha/login/link', { token })).status, 400, 'o link é de uso único');

    const me = await ana('GET', '/api/customer/navalha/me');
    assert.equal(me.data.customer.name, 'Pedro Alves');
    assert.equal(me.data.offers[0].canClaim, true);
    const v = await ana('POST', `/api/customer/navalha/offers/${offer.data.id}/claim`);
    assert.equal(v.status, 201);
    assert.match(v.data.code, /^NAV-[A-Z2-9]{6}$/);
    assert.equal((await ana('POST', `/api/customer/navalha/offers/${offer.data.id}/claim`)).status, 409);

    const used = await dono('POST', '/api/shop/vouchers/redeem', { code: v.data.code.toLowerCase() });
    assert.equal(used.data.status, 'used');
    assert.equal((await dono('POST', '/api/shop/vouchers/redeem', { code: v.data.code })).status, 409);
  });

  test('cliente marca e cancela pela área; não cancela horário de outro', async () => {
    let date = addDays(localNow().date, 3);
    while (weekdayOf(date) === 0) date = addDays(date, 1);
    const slots = await ana('GET', `/api/customer/navalha/availability?date=${date}&barber_id=${marcos}`);
    const time = slots.data[0].times[0];
    const created = await ana('POST', '/api/customer/navalha/appointments', { barber_id: marcos, date, time });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const me = await ana('GET', '/api/customer/navalha/me');
    assert.ok(me.data.upcoming.some((a: any) => a.id === created.data.id));

    const joaoAppt = get<{ id: number }>("SELECT id FROM appointments WHERE customer_id = ? AND status = 'scheduled' ORDER BY id DESC", [joao])!.id;
    assert.equal((await ana('POST', `/api/customer/navalha/appointments/${joaoAppt}/cancel`)).status, 404);
    assert.equal((await ana('POST', `/api/customer/navalha/appointments/${created.data.id}/cancel`)).data.status, 'cancelled');
  });

  test('cliente informa o horário de costume', async () => {
    const r = await ana('PUT', '/api/customer/navalha/preferences', {
      name: 'Pedro Alves',
      pref_weekday: 5,
      pref_time: '19:00',
      pref_barber_id: paulo,
      pref_service_id: null,
      pref_interval_days: 14,
      reminders_opt_out: false,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.habit, { weekday: 5, time: '19:00', barberId: paulo, serviceId: null, intervalDays: 14, source: 'cliente' });
  });

  test('o código de acesso não fica legível no histórico de mensagens', async () => {
    const r = await client()('POST', '/api/public/shops/navalha/login/code', { phone: '11988880000' });
    assert.match(r.data.demoCode, /^\d{6}$/);
    const logged = get<{ body: string }>("SELECT body FROM messages WHERE kind = 'codigo' ORDER BY id DESC LIMIT 1")!.body;
    assert.equal(logged.includes(r.data.demoCode), false);
    assert.match(logged, /••••••/);
  });

  test('painel do robô: credenciais do WhatsApp nunca voltam para a tela', async () => {
    const settings = (await dono('GET', '/api/shop/bot')).data;
    const put = await dono('PUT', '/api/shop/bot', {
      ...settings,
      bot_name: 'João',
      wa_provider: 'meta',
      wa_config: { token: 'EAAG-token-secreto-123', phoneNumberId: '123456', appSecret: 'segredo-do-app', verifyToken: 'verifica123' },
    });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal(put.data.wa_config.token, '••••••');
    assert.equal(put.data.wa_config.phoneNumberId, '123456');
    // Salvar de novo com a máscara mantém o token guardado.
    await dono('PUT', '/api/shop/bot', { ...put.data, wa_config: put.data.wa_config });
    const saved = JSON.parse(get<{ wa_config: string }>('SELECT wa_config FROM barbershops WHERE id = ?', [shopId])!.wa_config);
    assert.equal(saved.token, 'EAAG-token-secreto-123');
  });

  test('webhook da Meta: verifica, confere a assinatura, responde e ignora repetidas', async () => {
    const token = get<{ webhook_token: string }>('SELECT webhook_token FROM barbershops WHERE id = ?', [shopId])!.webhook_token;
    const verify = await fetch(`${base}/api/webhooks/meta/${token}?hub.mode=subscribe&hub.verify_token=verifica123&hub.challenge=42`);
    assert.equal(await verify.text(), '42');

    const sent: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).startsWith('https://graph.facebook.com/')) {
        sent.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '5511977770000', id: 'wamid.voltar', type: 'text', text: { body: 'VOLTAR' } }] } }] }] });
      const post = (signature: string) =>
        realFetch(`${base}/api/webhooks/meta/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
      assert.equal((await post('sha256=00')).status, 401);
      const good = `sha256=${crypto.createHmac('sha256', 'segredo-do-app').update(body).digest('hex')}`;
      assert.equal((await post(good)).status, 200);
      for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(sent.length, 1);
      assert.match(sent[0].url, /\/123456\/messages$/);
      assert.equal(sent[0].body.to, '5511977770000');
      assert.match(sent[0].body.text.body, /Voltei a te lembrar/);
      // O WhatsApp reenviou a mesma mensagem: não responde de novo.
      assert.equal((await post(good)).status, 200);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(sent.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('master', () => {
  test('cuida só da plataforma: não vê barbeiros, agenda, clientes nem conversas', async () => {
    run("INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', ?, ?)", [hashPassword('senha-forte-1'), nowIso()]);
    const master = client();
    assert.equal((await master('POST', '/api/auth/login', { email: 'igor@exemplo.com', password: 'senha-forte-1' })).status, 200);
    const overview = (await master('GET', '/api/master/overview')).data;
    assert.equal(overview.shops, 1);
    for (const field of ['customers', 'appointmentsToday', 'recentMessages']) assert.equal(overview[field], undefined, `visão geral sem ${field}`);
    const shop = (await master('GET', '/api/master/shops')).data[0];
    assert.equal(shop.name, 'Navalha de Ouro');
    for (const field of ['customers', 'barbers', 'appointments_week', 'messages_week']) assert.equal(shop[field], undefined, `barbearia sem ${field}`);

    for (const path of ['/api/shop/barbers', '/api/shop/agenda', '/api/shop/customers', '/api/shop/bot/conversations']) {
      assert.equal((await master('GET', path)).status, 403, path);
    }
    assert.equal((await master('POST', `/api/master/shops/${shopId}/enter`)).status, 404, 'não existe mais "entrar no painel"');
    assert.equal((await master('GET', '/api/auth/me')).data.shop, null);

    // Pronto para o piloto: o que falta antes da primeira barbearia de verdade.
    const ready = (await master('GET', '/api/master/readiness')).data as { id: string; done: boolean }[];
    assert.deepEqual(
      ready.map((i) => i.id),
      ['https', 'demo', 'backup', 'backup_password', 'whatsapp', 'phone', 'legal', 'billing', 'ai'],
    );
    assert.equal(ready.find((i) => i.id === 'https')!.done, false, 'sem PUBLIC_URL com https');
    assert.equal(ready.find((i) => i.id === 'whatsapp')!.done, false, 'WhatsApp da plataforma no simulador');
  });
});
