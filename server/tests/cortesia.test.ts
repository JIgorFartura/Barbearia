import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-cortesia-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { accessStatus, ensureInvoices, platformRevenue } = await import('../billing.js');
const { localNow } = await import('../time.js');

let server: Server;
let base = '';
const master = makeClient(() => base);
const owner = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

run("INSERT INTO users (role, name, email, password_hash, terms_accepted_at, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', ?, ?, ?)", [
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
// Cadastrada há dois meses, com mensalidade de R$ 99,90 vencendo hoje.
const today = localNow().date;
const shopId = run(
  "INSERT INTO barbershops (slug, name, bot_name, monthly_price_cents, billing_day, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 9990, ?, ?)",
  [Number(today.slice(8, 10)), new Date(Date.now() - 60 * 86400000).toISOString()],
).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const openInvoices = () => get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE barbershop_id = ? AND status = 'open'", [shopId])!.n;

describe('cortesia do master', () => {
  test('dar cortesia cancela a fatura que ainda não venceu e não gera as próximas', async () => {
    ensureInvoices();
    assert.equal(openInvoices(), 1);
    assert.equal(platformRevenue().payingShops, 1);

    const r = await master('PUT', `/api/master/shops/${shopId}/courtesy`, { active: true, until: '2027-03-31', note: 'Parceria: 3 meses' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.courtesy, { since: today, until: '2027-03-31', note: 'Parceria: 3 meses' });
    assert.equal(openInvoices(), 0);
    assert.equal(ensureInvoices(), 0, 'com cortesia não sai fatura');
    assert.equal(openInvoices(), 0);

    const revenue = platformRevenue();
    assert.equal(revenue.payingShops, 0);
    assert.equal(revenue.courtesyShops, 1);
    const row = (await master('GET', '/api/master/shops')).data.find((s: { id: number }) => s.id === shopId);
    assert.equal(row.courtesy.until, '2027-03-31');
  });

  test('o dono vê a cortesia e o acesso não bloqueia nem com fatura antiga vencida', async () => {
    run("INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at) VALUES (?, '2020-01', 'Antiga', 9990, '2020-01-10', ?)", [
      shopId,
      nowIso(),
    ]);
    assert.equal(accessStatus(shopId).blocked, false);
    const s = await owner('GET', '/api/shop/subscription');
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.courtesy.note, 'Parceria: 3 meses');
  });

  test('tirar a cortesia volta a cobrar (e a fatura vencida volta a contar)', async () => {
    const r = await master('PUT', `/api/master/shops/${shopId}/courtesy`, { active: false });
    assert.equal(r.status, 200);
    assert.equal(r.data.courtesy, null);
    assert.equal(r.data.blocked, true, 'a fatura antiga vencida bloqueia de novo');
    assert.equal(platformRevenue().payingShops, 1);
  });

  test('só o master marca a cortesia', async () => {
    assert.equal((await owner('PUT', `/api/master/shops/${shopId}/courtesy`, { active: true })).status, 403);
  });
});
