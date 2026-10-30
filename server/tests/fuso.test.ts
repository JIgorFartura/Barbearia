import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-fuso-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book, freeTimes } = await import('../scheduling.js');
const { runAutomations } = await import('../automations.js');
const { buildContext } = await import('../bot/brain.js');
const { shopBot } = await import('../messaging.js');
const { shopNow } = await import('../clock.js');
const { localToIso } = await import('../time.js');
const { platformPayments } = await import('../gatewayPayments.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** Duas barbearias iguais: uma em São Paulo, outra em Manaus (uma hora a menos). */
function shop(slug: string, timezone: string | null) {
  const id = run('INSERT INTO barbershops (slug, name, bot_name, timezone, created_at) VALUES (?, ?, ?, ?, ?)', [slug, `Barbearia ${slug}`, 'João', timezone, nowIso()]).lastInsertRowid;
  const barber = run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [id, 'Paulo', nowIso()]).lastInsertRowid;
  for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '08:00', '22:00')", [barber, d]);
  run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [id, nowIso()]);
  const customer = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Ana Lima', '92999990000', ?)", [id, nowIso()]).lastInsertRowid;
  return { id, barber, customer };
}
const sp = shop('sp', null);
const manaus = shop('manaus', 'America/Manaus');

describe('dia local e horário UTC', () => {
  test('meia-noite local vira o instante certo em UTC', () => {
    assert.equal(localToIso('2026-10-29 00:00', 'America/Sao_Paulo'), '2026-10-29T03:00:00.000Z');
    assert.equal(localToIso('2026-10-29 22:30', 'America/Manaus'), '2026-10-30T02:30:00.000Z');
    assert.equal(localToIso('2026-11-01 00:00', 'America/Sao_Paulo'), '2026-11-01T03:00:00.000Z');
  });

  test('a mensalidade paga às 22h30 de Brasília conta no dia dela, não no seguinte', () => {
    const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('virada', 'Barbearia Virada', 'João', ?)", [nowIso()]).lastInsertRowid;
    const pay = (external: string, at: string) =>
      run(
        "INSERT INTO gateway_payments (kind, provider, external_id, barbershop_id, value_cents, status, created_at, updated_at) VALUES ('mensalidade', 'asaas', ?, ?, 14990, 'RECEIVED', ?, ?)",
        [external, shopId, at, at],
      );
    pay('virada-1', '2026-10-30T01:30:00.000Z'); // 29/10 às 22h30 em Brasília
    pay('virada-2', '2026-10-30T03:10:00.000Z'); // 30/10 às 0h10 em Brasília
    assert.deepEqual(
      platformPayments({ from: '2026-10-29', to: '2026-10-29' }).items.map((i) => i.value_cents),
      [14990],
    );
    assert.equal(platformPayments({ from: '2026-10-30', to: '2026-10-31' }).items.length, 1);
  });
});

describe('fuso horário por barbearia', () => {
  test('o "agora" de cada barbearia segue o fuso dela', () => {
    const instant = new Date('2026-11-02T20:00:00Z');
    assert.equal(shopNow(sp.id, instant).time, '17:00');
    assert.equal(shopNow(manaus.id, instant).time, '16:00');
    // Horários livres de hoje começam depois de agora + 30 min, no relógio de cada uma.
    assert.equal(freeTimes(sp.id, '2026-11-02', { now: instant })[0].times[0], '17:30');
    assert.equal(freeTimes(manaus.id, '2026-11-02', { now: instant })[0].times[0], '16:30');
    assert.match(buildContext({ shop: shopBot(manaus.id), phone: '92999990000', waId: null, customer: null, profileName: null, now: instant, dryRun: true }), /Agora: segunda, 02\/11\/2026, 16:00/);
  });

  test('lembretes respeitam o horário comercial local (21h em SP ainda é 20h em Manaus)', async () => {
    const created = new Date('2026-11-01T12:00:00Z');
    for (const s of [sp, manaus]) book({ shopId: s.id, customerId: s.customer, barberId: s.barber, date: '2026-11-03', time: '18:00', source: 'painel', now: created });
    // 00:30 UTC = 21:30 em São Paulo (fora do horário) e 20:30 em Manaus (dentro).
    const summary = await runAutomations(new Date('2026-11-03T00:30:00Z'));
    assert.equal(summary.reminders, 1);
    const sent = (shopId: number) => get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE barbershop_id = ? AND kind = 'lembrete'", [shopId])!.n;
    assert.equal(sent(manaus.id), 1);
    assert.equal(sent(sp.id), 0);
  });

  test('o dono escolhe o fuso em Minha marca', async () => {
    run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', 'Dono', 'dono@sp.com', ?, ?)", [sp.id, hashPassword('senha-forte-1'), nowIso()]);
    const owner = makeClient(() => base);
    assert.equal((await owner('POST', '/api/auth/login', { email: 'dono@sp.com', password: 'senha-forte-1' })).status, 200);
    const profile = (await owner('GET', '/api/shop/profile')).data;
    assert.equal(profile.timezone, null);
    assert.equal((await owner('PUT', '/api/shop/profile', { ...profile, timezone: 'America/Rio_Branco' })).data.timezone, 'America/Rio_Branco');
    assert.equal(shopNow(sp.id, new Date('2026-11-02T20:00:00Z')).time, '15:00');
    assert.equal((await owner('PUT', '/api/shop/profile', { ...profile, timezone: 'Europe/Lisbon' })).status, 400);
  });
});
