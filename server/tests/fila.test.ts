import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-fila-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { callNext, joinQueue, leaveQueue, queueView, setQueueEnabled, startEntry } = await import('../queue.js');
const { createSale } = await import('../finance.js');
const { addDays, localNow } = await import('../time.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const desk = makeClient(() => base);
const anon = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await desk('POST', '/api/auth/login', { login: 'recepcao@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
for (const [role, email] of [
  ['owner', 'carlos@navalha.com'],
  ['reception', 'recepcao@navalha.com'],
]) {
  run('INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    shopId,
    role,
    role,
    email,
    hashPassword('senha-forte-1'),
    nowIso(),
    nowIso(),
  ]);
}
const barber = (name: string) => {
  const id = run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shopId, name, nowIso()]).lastInsertRowid;
  for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '18:00')", [id, d]);
  return id;
};
const paulo = barber('Paulo');
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]).lastInsertRowid;
const joao = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'João Pereira', '11999990000', ?)", [shopId, nowIso()]).lastInsertRowid;

// Um dia de teste às 10h: o Paulo tem o João marcado às 10h20 (até 10h50).
const D = addDays(localNow().date, 2);
const at = (time: string) => new Date(`${D}T${time}:00-03:00`);
run(
  "INSERT INTO appointments (barbershop_id, customer_id, barber_id, service_id, service_name, price_cents, starts_at, ends_at, source, created_at) VALUES (?, ?, ?, ?, 'Corte', 5000, ?, ?, 'painel', ?)",
  [shopId, joao, paulo, corte, `${D} 10:20`, `${D} 10:50`, nowIso()],
);
const lastMessage = (phone: string) => get<{ kind: string; body: string }>('SELECT kind, body FROM messages WHERE phone = ? ORDER BY id DESC LIMIT 1', [phone]);

describe('fila de chegada', () => {
  test('desligada, ninguém entra', async () => {
    await assert.rejects(joinQueue({ shopId, name: 'Ana', phone: '11988880000', source: 'qr', now: at('10:00') }), /não está usando a fila/);
    assert.equal((await anon('GET', '/api/public/shops/navalha/queue')).data.enabled, false);
  });

  test('quem chega sem horário espera o intervalo livre: o horário marcado do João fica com ele', async () => {
    setQueueEnabled(shopId, true);
    const ana = await joinQueue({ shopId, name: 'Ana Lima', phone: '11988880000', source: 'qr', privacyAccepted: true, now: at('10:00') });
    // 10h00-10h30 bateria no João (10h20): a Ana fica para depois dele.
    assert.deepEqual([ana.ticket, ana.position, ana.expected_at, ana.wait_min], [1, 1, '10:50', 50]);
    const bruno = await joinQueue({ shopId, name: 'Bruno', phone: '11977770000', source: 'qr', privacyAccepted: true, now: at('10:00') });
    assert.deepEqual([bruno.ticket, bruno.position, bruno.expected_at], [2, 2, '11:20']);
    assert.match(lastMessage('11988880000')!.body, /senha 1, você é o próximo \(previsão 10:50\)/);
    // O cliente novo fica cadastrado (com o aceite da política), para o histórico e a fidelidade.
    assert.ok(get('SELECT 1 AS ok FROM customers WHERE phone = ? AND privacy_accepted_at IS NOT NULL', ['11988880000']));
    await assert.rejects(joinQueue({ shopId, name: 'Ana Lima', phone: '11988880000', source: 'qr', now: at('10:01') }), /já está na fila/);
  });

  test('com mais um barbeiro livre, a fila anda por ele', () => {
    const marcos = barber('Marcos');
    const view = queueView(shopId, at('10:00'));
    assert.deepEqual(
      view.entries.map((e) => [e.name, e.expected_at]),
      [
        ['Ana Lima', '10:00'],
        ['Bruno', '10:30'],
      ],
    );
    const p = view.barbers.find((b) => b.name === 'Paulo')!;
    assert.deepEqual([p.next_appointment, p.free_min], [{ time: '10:20', customer: 'João' }, 20]);
    run('UPDATE barbers SET active = 0 WHERE id = ?', [marcos]);
  });

  test('o barbeiro chama o próximo, o cliente é avisado e a comanda fecha o atendimento', async () => {
    const called = await callNext(shopId, paulo, at('10:50'));
    assert.equal(called!.name, 'Ana Lima');
    assert.deepEqual([lastMessage('11988880000')!.kind, /é a sua vez/.test(lastMessage('11988880000')!.body)], ['fila', true]);
    await assert.rejects(callNext(shopId, paulo, at('10:51')), /ainda está com alguém da fila/);
    startEntry(shopId, called!.id, paulo);

    const sale = createSale({ shopId, userId: null, queueEntryId: called!.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix', now: at('11:15') });
    const ana = get<{ id: number }>("SELECT id FROM customers WHERE phone = '11988880000'")!.id;
    assert.equal(sale.sale.customer_id, ana, 'a venda fica no nome de quem estava na fila');
    assert.equal(sale.sale.items[0].barber_id, paulo, 'e com o barbeiro que chamou');
    const row = get<{ status: string; sale_id: number }>('SELECT status, sale_id FROM queue_entries WHERE id = ?', [called!.id])!;
    assert.deepEqual(row, { status: 'done', sale_id: sale.sale.id });
    assert.throws(() => createSale({ shopId, userId: null, queueEntryId: called!.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix' }), /já foi fechado/);
  });

  test('pelo link da senha o cliente acompanha e pode sair da fila', async () => {
    const token = get<{ token: string }>("SELECT token FROM queue_entries WHERE name = 'Bruno'")!.token;
    const r = await anon('GET', `/api/public/queue/${token}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.ticket, r.data.status, r.data.name], [2, 'waiting', 'Bruno']);
    assert.equal(r.data.phone, undefined, 'o link não mostra o celular');
    await anon('POST', `/api/public/queue/${token}/leave`);
    assert.equal(get<{ status: string }>("SELECT status FROM queue_entries WHERE name = 'Bruno'")!.status, 'left');
  });

  test('a recepção põe quem chegou no balcão; só o dono liga e desliga a fila', async () => {
    const r = await desk('POST', '/api/shop/queue', { name: 'Carlos Souza' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.source, 'balcao');
    const list = await desk('GET', '/api/shop/queue');
    assert.equal(list.status, 200);
    assert.ok(list.data.entries.some((e: { name: string }) => e.name === 'Carlos Souza'));
    assert.equal((await desk('PUT', '/api/shop/queue/settings', { enabled: false })).status, 403);
    leaveQueue(shopId, r.data.id);
    assert.equal((await owner('PUT', '/api/shop/queue/settings', { enabled: false })).status, 200);
  });

  test('fora do expediente não entra e não gasta senha', async () => {
    setQueueEnabled(shopId, true);
    const before = get<{ n: number }>('SELECT COUNT(*) AS n FROM queue_entries')!.n;
    await assert.rejects(joinQueue({ shopId, name: 'Tarde Demais', phone: '11955550000', source: 'qr', now: at('17:50') }), /não dá mais tempo/);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM queue_entries')!.n, before);
  });

  test('entrar pelo QR exige o aceite da política', async () => {
    setQueueEnabled(shopId, true);
    const r = await anon('POST', '/api/public/shops/navalha/queue', { name: 'Diego', phone: '(11) 96666-0000' });
    assert.equal(r.status, 400);
  });
});
