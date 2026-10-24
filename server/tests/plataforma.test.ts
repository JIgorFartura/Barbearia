import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-plataforma-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book } = await import('../scheduling.js');
const { appointmentReminders } = await import('../automations.js');
const { shopBot } = await import('../messaging.js');
const { metaBody, zMetaConfig } = await import('../whatsapp.js');
const { checkConnections, setConnection } = await import('../connection.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

// O servidor também usa fetch: só as chamadas para fora (Meta, Evolution) passam pelo falso.
const realFetch = globalThis.fetch;
const outbound: { url: string; body: any }[] = [];
let evolutionState = 'open';
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(base)) return realFetch(input, init);
  outbound.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.includes('/instance/connectionState/')) return new Response(JSON.stringify({ instance: { instanceName: 'navalha', state: evolutionState } }), { status: 200 });
  return new Response(JSON.stringify({ messages: [{ id: `wamid.${outbound.length}.${Date.now()}` }], key: { id: `evo-${outbound.length}.${Date.now()}` } }), { status: 200 });
}) as typeof fetch;
beforeEach(() => {
  outbound.length = 0;
});

/** "AAAA-MM-DD HH:MM" no horário de Brasília → Date. */
const at = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}:00-03:00`);

const META = {
  token: 'token-da-meta-123',
  phoneNumberId: '1234567890',
  appSecret: '',
  verifyToken: 'verifica',
  templateLang: 'pt_BR',
  tpl_lembrete: 'lembrete_horario',
  tpl_codigo: 'codigo_acesso',
};
const shopId = run(
  "INSERT INTO barbershops (slug, name, bot_name, wa_provider, wa_config, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'meta', ?, ?)",
  [JSON.stringify(META), nowIso()],
).lastInsertRowid;
const ownerId = run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', '11955550000', ?, ?)", [
  shopId,
  hashPassword('senha-antiga-1'),
  nowIso(),
]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', 'Sócio', 'socio@navalha.com', ?, ?)", [shopId, hashPassword('senha-forte-1'), nowIso()]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [paulo, d]);
run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]);
const joao = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'João Pereira', '11999990000', ?)", [shopId, nowIso()]).lastInsertRowid;

describe('modelos da Meta por tipo de mensagem', () => {
  const cfg = zMetaConfig.parse({ ...META, templateName: 'generico' });

  test('fora da janela de 24h usa o modelo do tipo, com as variáveis', () => {
    const body = metaBody(cfg, '5511999990000', 'texto livre', { automated: true, inWindow: false, template: { kind: 'lembrete', params: ['João', 'Navalha', 'amanhã às 11h', 'Paulo'] } }) as any;
    assert.equal(body.type, 'template');
    assert.equal(body.template.name, 'lembrete_horario');
    assert.deepEqual(
      body.template.components[0].parameters.map((p: { text: string }) => p.text),
      ['João', 'Navalha', 'amanhã às 11h', 'Paulo'],
    );
  });

  test('dentro da janela vai texto livre; tipo sem modelo cai no genérico; código leva o botão de copiar', () => {
    const inWindow = metaBody(cfg, '55', 'oi', { automated: true, inWindow: true, template: { kind: 'lembrete', params: ['x'] } }) as any;
    assert.equal(inWindow.type, 'text');
    const generic = metaBody(cfg, '55', 'oi\nde novo', { automated: true, inWindow: false, template: { kind: 'sumido', params: ['x'] } }) as any;
    assert.equal(generic.template.name, 'generico');
    assert.equal(generic.template.components[0].parameters[0].text, 'oi de novo');
    const code = metaBody(cfg, '55', 'código', { automated: true, inWindow: false, template: { kind: 'codigo', params: ['123456'] } }) as any;
    assert.equal(code.template.name, 'codigo_acesso');
    assert.deepEqual(code.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] });
    const reply = metaBody(cfg, '55', 'resposta', { automated: false }) as any;
    assert.equal(reply.type, 'text');
  });

  test('lembrete pela Meta: modelo fora da janela (sem a pergunta da cerveja); texto com a pergunta dentro dela', async () => {
    // João toma cerveja toda vez: o lembrete costuma perguntar se pode separar.
    const beer = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, 'product', 'Cerveja', 1200, ?)", [shopId, nowIso()]).lastInsertRowid;
    for (const day of ['2026-10-02', '2026-10-09']) {
      const sale = run("INSERT INTO sales (barbershop_id, customer_id, date, subtotal_cents, total_cents, method, created_at) VALUES (?, ?, ?, 1200, 1200, 'pix', ?)", [
        shopId,
        joao,
        day,
        nowIso(),
      ]).lastInsertRowid;
      run("INSERT INTO sale_items (sale_id, catalog_item_id, kind, name, qty, unit_price_cents, total_cents) VALUES (?, ?, 'product', 'Cerveja', 1, 1200, 1200)", [sale, beer]);
    }
    const created = at('2026-11-01 10:00');
    book({ shopId, customerId: joao, barberId: paulo, date: '2026-11-03', time: '11:00', source: 'painel', now: created });
    assert.equal(await appointmentReminders(shopBot(shopId), at('2026-11-02 12:00')), 1);
    const sent = outbound.find((o) => o.url.includes('graph.facebook.com'))!;
    assert.equal(sent.body.type, 'template');
    assert.equal(sent.body.template.name, 'lembrete_horario');
    assert.equal(sent.body.template.components[0].parameters[0].text, 'João');
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM bot_questions WHERE customer_id = ? AND status = 'pending'", [joao])!.n, 0);

    // Cliente escreveu hoje: o próximo lembrete vai como texto, já com a pergunta.
    outbound.length = 0;
    run("INSERT INTO messages (barbershop_id, customer_id, phone, direction, kind, body, status, created_at) VALUES (?, ?, '11999990000', 'in', 'chat', 'oi', 'received', ?)", [
      shopId,
      joao,
      nowIso(),
    ]);
    book({ shopId, customerId: joao, barberId: paulo, date: '2026-11-04', time: '11:00', source: 'painel', now: created });
    assert.equal(await appointmentReminders(shopBot(shopId), at('2026-11-03 12:00')), 1);
    const text = outbound.find((o) => o.url.includes('graph.facebook.com'))!;
    assert.equal(text.body.type, 'text');
    assert.match(text.body.text.body, /Posso avisar o Paulo/);
  });
});

describe('esqueci minha senha', () => {
  test('código pelo WhatsApp, nova senha e entrada pelo celular', async () => {
    const web = makeClient(() => base);
    const old = makeClient(() => base);
    assert.equal((await old('POST', '/api/auth/login', { email: 'carlos@navalha.com', password: 'senha-antiga-1' })).status, 200);

    assert.equal((await web('POST', '/api/auth/forgot', { login: 'ninguem@x.com' })).status, 404);
    const noPhone = await web('POST', '/api/auth/forgot', { login: 'socio@navalha.com' });
    assert.equal(noPhone.status, 400);
    assert.match(noPhone.data.error, /não tem celular/);

    // Plataforma no simulador: o código sai pelo WhatsApp da barbearia (Meta, modelo de autenticação).
    const asked = await web('POST', '/api/auth/forgot', { login: 'carlos@navalha.com' });
    assert.equal(asked.status, 200);
    assert.equal(asked.data.masked, '(11) •••••-0000');
    assert.equal(asked.data.sent, true);
    assert.equal(asked.data.demoCode, undefined, 'código enviado não aparece na tela');
    const viaShop = outbound.find((o) => o.url.includes('graph.facebook.com'))!;
    assert.equal(viaShop.body.template.name, 'codigo_acesso');
    const code = viaShop.body.template.components[0].parameters[0].text as string;
    const logged = get<{ body: string; kind: string }>('SELECT body, kind FROM platform_messages ORDER BY id DESC LIMIT 1')!;
    assert.equal(logged.kind, 'senha');
    assert.doesNotMatch(logged.body, /\d{6}/, 'o código não fica legível no histórico');

    assert.equal((await web('POST', '/api/auth/reset', { login: 'carlos@navalha.com', code: '000000', password: 'senha-nova-123' })).status, 400);
    const ok = await web('POST', '/api/auth/reset', { login: '(11) 95555-0000', code, password: 'senha-nova-123' });
    assert.equal(ok.status, 200);
    assert.equal((await web('GET', '/api/auth/me')).data.user.id, ownerId);
    assert.equal((await old('GET', '/api/auth/me')).data.user, null, 'sessões antigas caem');
    assert.equal((await web('POST', '/api/auth/reset', { login: 'carlos@navalha.com', code, password: 'outra-senha-1' })).status, 400, 'código só vale uma vez');

    const byPhone = makeClient(() => base);
    assert.equal((await byPhone('POST', '/api/auth/login', { login: '11955550000', password: 'senha-nova-123' })).status, 200);
    assert.equal((await byPhone('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-antiga-1' })).status, 401);

    // Sem WhatsApp nenhum (demonstração): o código aparece na tela.
    const provider = get<{ wa_provider: string }>('SELECT wa_provider FROM barbershops WHERE id = ?', [shopId])!.wa_provider;
    run("UPDATE barbershops SET wa_provider = 'simulador' WHERE id = ?", [shopId]);
    const demo = await web('POST', '/api/auth/forgot', { login: 'carlos@navalha.com' });
    assert.equal(demo.data.sent, false);
    assert.match(demo.data.demoCode, /^\d{6}$/);
    await web('POST', '/api/auth/forgot', { login: 'carlos@navalha.com' });
    assert.equal((await web('POST', '/api/auth/forgot', { login: 'carlos@navalha.com' })).status, 429);
    run('UPDATE barbershops SET wa_provider = ? WHERE id = ?', [provider, shopId]);
  });

  test('o dono cadastra o próprio celular', async () => {
    const web = makeClient(() => base);
    await web('POST', '/api/auth/login', { login: 'socio@navalha.com', password: 'senha-forte-1' });
    assert.equal((await web('PUT', '/api/auth/profile', { name: 'Sócio', phone: '(11) 95555-0000' })).status, 409);
    assert.equal((await web('PUT', '/api/auth/profile', { name: 'Sócio Novo', phone: '(21) 98888-1111' })).status, 200);
    const me = (await web('GET', '/api/auth/me')).data.user;
    assert.equal(me.phone, '21988881111');
    assert.equal(me.name, 'Sócio Novo');
  });
});

describe('WhatsApp da barbearia desconectado', () => {
  const evo = { baseUrl: 'https://evo.exemplo.com', instance: 'navalha', apiKey: 'chave-evo-123' };

  test('duas falhas seguidas: aviso no painel e mensagem para o dono; depois, aviso de volta', async () => {
    run("UPDATE barbershops SET wa_provider = 'evolution', wa_config = ? WHERE id = ?", [JSON.stringify(evo), shopId]);
    evolutionState = 'close';
    assert.equal(await checkConnections(at('2026-11-05 10:00')), 1);
    assert.equal(get<{ wa_status: string | null }>('SELECT wa_status FROM barbershops WHERE id = ?', [shopId])!.wa_status, null, 'uma falha só não alarma');
    assert.equal(await checkConnections(at('2026-11-05 10:05')), 0, 'confere de 10 em 10 minutos');
    await checkConnections(at('2026-11-05 10:11'));
    const shop = get<{ wa_status: string; wa_alerted_at: string | null }>('SELECT wa_status, wa_alerted_at FROM barbershops WHERE id = ?', [shopId])!;
    assert.equal(shop.wa_status, 'down');
    assert.ok(shop.wa_alerted_at);
    const alert = all<{ phone: string; kind: string; body: string }>("SELECT phone, kind, body FROM platform_messages WHERE kind = 'alerta' ORDER BY id");
    assert.deepEqual(
      alert.map((a) => a.phone),
      ['11955550000', '21988881111'],
    );
    assert.match(alert[0].body, /desconectou em 05\/11 às 10h11/);

    const owner = makeClient(() => base);
    await owner('POST', '/api/auth/login', { login: '11955550000', password: 'senha-nova-123' });
    assert.equal((await owner('GET', '/api/shop/status')).data.whatsapp.status, 'down');

    evolutionState = 'open';
    await checkConnections(at('2026-11-05 10:30'));
    assert.equal((await owner('GET', '/api/shop/status')).data.whatsapp.status, 'ok');
    assert.match(get<{ body: string }>("SELECT body FROM platform_messages ORDER BY id DESC LIMIT 1")!.body, /voltou a funcionar/);
  });

  test('evento da Evolution derruba na hora; de madrugada o aviso espera a manhã', async () => {
    const token = get<{ webhook_token: string }>('SELECT webhook_token FROM barbershops WHERE id = ?', [shopId])!.webhook_token;
    const before = get<{ n: number }>('SELECT COUNT(*) AS n FROM platform_messages')!.n;
    await realFetch(`${base}/api/webhooks/evolution/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'connection.update', instance: 'navalha', data: { instance: 'navalha', state: 'close' } }),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(get<{ wa_status: string }>('SELECT wa_status FROM barbershops WHERE id = ?', [shopId])!.wa_status, 'down');
    assert.ok(get<{ n: number }>('SELECT COUNT(*) AS n FROM platform_messages')!.n > before);

    // Caiu de novo às 23h: sem mensagem de madrugada; às 8h o dono é avisado.
    await setConnection(shopId, true, 'conectado', at('2026-11-06 22:50'));
    const count = () => get<{ n: number }>("SELECT COUNT(*) AS n FROM platform_messages WHERE kind = 'alerta' AND body LIKE '%desconectou%'")!.n;
    const n0 = count();
    await setConnection(shopId, false, 'sessão encerrada', at('2026-11-06 23:10'), { immediate: true });
    assert.equal(count(), n0);
    await setConnection(shopId, false, 'sessão encerrada', at('2026-11-07 08:00'));
    assert.equal(count(), n0 + 2);
  });
});

describe('WhatsApp da plataforma (master)', () => {
  test('configura, mascara a chave e testa o envio', async () => {
    const master = makeClient(() => base);
    assert.equal((await master('POST', '/api/auth/setup', { name: 'Igor', email: 'igor@exemplo.com', password: 'senha-forte-1' })).status, 201);
    const saved = await master('PUT', '/api/master/whatsapp', { provider: 'evolution', config: { baseUrl: 'https://evo.plataforma.com/', instance: 'plataforma', apiKey: 'segredo-123' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.config.apiKey, '••••••');
    assert.equal(saved.data.config.baseUrl, 'https://evo.plataforma.com');
    assert.ok(saved.data.templates.some((t: { kind: string }) => t.kind === 'senha'));
    // Chave mascarada volta como estava.
    await master('PUT', '/api/master/whatsapp', { provider: 'evolution', config: { ...saved.data.config } });
    const test = await master('POST', '/api/master/whatsapp/test', { phone: '(11) 97777-6666' });
    assert.equal(test.status, 200);
    const call = outbound.find((o) => o.url.startsWith('https://evo.plataforma.com/message/sendText/plataforma'))!;
    assert.equal(call.body.number, '5511977776666');

    // Com a plataforma conectada, o código de "esqueci a senha" sai de verdade (sem código na tela).
    const asked = await makeClient(() => base)('POST', '/api/auth/forgot', { login: '21988881111' });
    assert.equal(asked.data.sent, true);
    assert.equal(asked.data.demoCode, undefined);
  });
});
