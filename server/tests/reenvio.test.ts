import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-reenvio-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { recentHistory, retryMessages, sendMessage, shopBot, undeliveredCount } = await import('../messaging.js');

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

// Evolution de mentira: falha enquanto `down` for verdade.
const realFetch = globalThis.fetch;
let down = true;
let calls = 0;
let seq = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(base)) return realFetch(input, init);
  calls++;
  if (down) return new Response(JSON.stringify({ message: 'instância fora do ar' }), { status: 503 });
  return new Response(JSON.stringify({ key: { id: `evo-${++seq}` } }), { status: 200 });
}) as typeof fetch;

const evo = { baseUrl: 'https://evo.exemplo.com', apiKey: 'chave-evo-123', instance: 'navalha' };
const shopId = run("INSERT INTO barbershops (slug, name, bot_name, wa_provider, wa_config, created_at) VALUES ('navalha', 'Navalha', 'João', 'evolution', ?, ?)", [
  JSON.stringify(evo),
  nowIso(),
]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Dono', 'dono@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const joao = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'João', '11999990000', ?)", [shopId, nowIso()]).lastInsertRowid;
const row = (id: number) => get<{ status: string; attempts: number; retry_at: string | null; external_id: string | null; error: string | null }>(
  'SELECT status, attempts, retry_at, external_id, error FROM messages WHERE id = ?',
  [id],
)!;
const later = (t0: number, min: number) => new Date(t0 + min * 60000);

describe('fila de reenvio do WhatsApp', () => {
  test('falhou: tenta de novo 1 e 5 minutos depois e entrega quando o WhatsApp volta', async () => {
    const t0 = Date.now();
    const sent = await sendMessage({ shop: shopBot(shopId), customerId: joao, phone: '11999990000', text: 'Lembrete: amanhã às 10h', kind: 'lembrete' });
    assert.equal(sent.status, 'failed', 'para quem chamou, ainda não foi entregue');
    let m = row(sent.id);
    assert.equal(m.status, 'retrying');
    assert.equal(m.attempts, 1);
    // Mensagem que ainda não chegou não entra no contexto do robô.
    assert.equal(recentHistory(shopId, '11999990000').length, 0);

    assert.deepEqual(await retryMessages(later(t0, 0.5)), { resent: 0, gaveUp: 0 }, 'antes de 1 minuto, espera');
    assert.deepEqual(await retryMessages(later(t0, 1.1)), { resent: 0, gaveUp: 0 });
    m = row(sent.id);
    assert.deepEqual([m.status, m.attempts], ['retrying', 2]);
    assert.ok(m.retry_at! > later(t0, 5).toISOString(), 'a próxima, 5 minutos depois');

    down = false;
    assert.deepEqual(await retryMessages(later(t0, 7)), { resent: 1, gaveUp: 0 });
    m = row(sent.id);
    assert.deepEqual([m.status, m.attempts, m.retry_at, m.error, m.external_id], ['sent', 3, null, null, 'evo-1']);
    assert.equal(recentHistory(shopId, '11999990000').length, 1);
    assert.equal(undeliveredCount(shopId), 0);
  });

  test('depois da última tentativa desiste e avisa o dono no painel', async () => {
    down = true;
    const t0 = Date.now();
    const sent = await sendMessage({ shop: shopBot(shopId), customerId: joao, phone: '11999990000', text: 'Seu horário foi liberado', kind: 'liberado' });
    // Primeira tentativa + 3 novas (1, 5 e 15 minutos depois): na terceira nova, desiste.
    for (const min of [1.1, 6.2]) await retryMessages(later(t0, min));
    assert.equal(row(sent.id).status, 'retrying', 'ainda falta a última');
    assert.deepEqual(await retryMessages(later(t0, 21.3)), { resent: 0, gaveUp: 1 });
    const m = row(sent.id);
    assert.deepEqual([m.status, m.attempts, m.retry_at], ['failed', 4, null]);
    assert.match(m.error!, /fora do ar/);
    assert.equal(undeliveredCount(shopId), 1);
    const status = await owner('GET', '/api/shop/status');
    assert.equal(status.data.undelivered, 1);
  });

  test('o código de acesso e o teste do dono não são reenviados', async () => {
    down = true;
    const before = calls;
    const code = await sendMessage({ shop: shopBot(shopId), customerId: joao, phone: '11999990000', text: 'Seu código: 123456', kind: 'codigo' });
    const test = await sendMessage({ shop: shopBot(shopId), customerId: null, phone: '11999990000', text: 'teste', kind: 'teste' });
    assert.equal(row(code.id).status, 'failed');
    assert.equal(row(test.id).status, 'failed');
    assert.equal(calls - before, 2);
  });

  test('configuração errada no painel não fica tentando', async () => {
    run('UPDATE barbershops SET wa_config = ? WHERE id = ?', [JSON.stringify({ ...evo, apiKey: 'x' }), shopId]);
    const sent = await sendMessage({ shop: shopBot(shopId), customerId: joao, phone: '11999990000', text: 'Oi', kind: 'lembrete' });
    assert.deepEqual([row(sent.id).status, row(sent.id).retry_at], ['failed', null]);
    run('UPDATE barbershops SET wa_config = ? WHERE id = ?', [JSON.stringify(evo), shopId]);
  });

  test('se a barbearia desligou o WhatsApp, não insiste', async () => {
    down = true;
    const t0 = Date.now();
    const sent = await sendMessage({ shop: shopBot(shopId), customerId: joao, phone: '11999990000', text: 'Oi', kind: 'aniversario' });
    run("UPDATE barbershops SET wa_provider = 'simulador' WHERE id = ?", [shopId]);
    assert.deepEqual(await retryMessages(later(t0, 2)), { resent: 0, gaveUp: 1 });
    assert.equal(row(sent.id).status, 'failed');
    run("UPDATE barbershops SET wa_provider = 'evolution' WHERE id = ?", [shopId]);
  });
});
