import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-fim-teste-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { platformSettings } = await import('../billing.js');
const { trialReminders } = await import('../trial.js');
const { addDays, localNow } = await import('../time.js');

let server: Server;
let base = '';
const master = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const today = localNow().date;
const equipe = get<{ id: number }>("SELECT id FROM plans WHERE name = 'Equipe'")!.id;
let n = 0;
/** Barbearia no teste grátis até `trialUntil`, com o dono já logado. */
async function trialShop(trialUntil: string) {
  n++;
  const shopId = run('INSERT INTO barbershops (slug, name, bot_name, plan_id, billing_day, trial_until, created_at) VALUES (?, ?, ?, ?, 10, ?, ?)', [
    `teste-${n}`,
    `Barbearia ${n}`,
    'João',
    equipe,
    trialUntil,
    nowIso(),
  ]).lastInsertRowid;
  run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos Lima', ?, ?, ?, ?, ?)", [
    shopId,
    `dono${n}@exemplo.com`,
    `1195555000${n}`,
    hashPassword('senha-forte-1'),
    nowIso(),
    nowIso(),
  ]);
  const owner = makeClient(() => base);
  await owner('POST', '/api/auth/login', { login: `dono${n}@exemplo.com`, password: 'senha-forte-1' });
  return { shopId, owner };
}
const invoices = (shopId: number) =>
  all<{ reference: string; amount_cents: number; due_date: string; status: string }>('SELECT reference, amount_cents, due_date, status FROM invoices WHERE barbershop_id = ? ORDER BY id', [
    shopId,
  ]);

describe('fim do teste grátis', () => {
  test('instalação nova: 7 dias grátis e implantação de R$ 197 (grátis no anual)', async () => {
    assert.equal((await master('POST', '/api/auth/setup', { name: 'Igor', email: 'igor@exemplo.com', password: 'senha-forte-1' })).status, 201);
    const s = platformSettings();
    assert.deepEqual([s.trial_days, s.setup_fee_cents, s.setup_free_on_annual], [7, 19700, true]);
  });

  test('2 dias antes de acabar, o dono recebe o aviso uma vez; o painel pergunta se quer continuar', async () => {
    const { shopId, owner } = await trialShop(addDays(today, 2));
    const at10 = new Date(`${today}T10:00:00-03:00`);
    await trialReminders(at10);
    await trialReminders(at10);
    const sent = all<{ body: string }>('SELECT body FROM platform_messages WHERE barbershop_id = ?', [shopId]);
    assert.equal(sent.length, 1, 'um aviso só');
    assert.match(sent[0].body, /teste grátis da Barbearia \d+ termina em/);
    const status = (await owner('GET', '/api/shop/status')).data;
    assert.equal(status.trialDecision, null);
    const sub = (await owner('GET', '/api/shop/subscription')).data;
    assert.equal(sub.setup_fee_cents, 19700);
    assert.equal(sub.periods.find((p: { cycle: string }) => p.cycle === 'anual').price_cents, 83916);
  });

  test('continuar no mensal: mensalidade e implantação vencem no dia seguinte ao último dia grátis', async () => {
    const until = addDays(today, 3);
    const { shopId, owner } = await trialShop(until);
    assert.equal((await owner('POST', '/api/shop/subscription/continue', { cycle: 'mensal' })).status, 200);
    const due = addDays(until, 1);
    assert.deepEqual(
      invoices(shopId).map((i) => [i.reference.replace(/^\d{4}-\d{2}$/, 'mes'), i.amount_cents, i.due_date]),
      [
        ['implantacao', 19700, due],
        ['mes', 9990, due],
      ],
    );
    assert.equal((await owner('GET', '/api/shop/status')).data.trialDecision, 'continuar');
  });

  test('continuar no anual: só a fatura do ano, sem implantação', async () => {
    const until = addDays(today, 1);
    const { shopId, owner } = await trialShop(until);
    assert.equal((await owner('POST', '/api/shop/subscription/continue', { cycle: 'anual' })).status, 200);
    const list = invoices(shopId);
    assert.equal(list.length, 1);
    assert.match(list[0].reference, /^anual:/);
    assert.deepEqual([list[0].amount_cents, list[0].due_date], [83916, addDays(until, 1)]);
  });

  test('trimestral paga a implantação (e parcela em até 3x); semestral não paga', async () => {
    const until = addDays(today, 2);
    const tri = await trialShop(until);
    assert.equal((await tri.owner('POST', '/api/shop/subscription/continue', { cycle: 'trimestral' })).status, 200);
    assert.deepEqual(
      invoices(tri.shopId).map((i) => [i.reference.replace(/\d{4}-\d{2}$/, 'mes'), i.amount_cents]),
      [
        ['implantacao', 19700],
        ['trimestral:mes', 26973],
      ],
    );
    const sem = await trialShop(until);
    assert.equal((await sem.owner('POST', '/api/shop/subscription/continue', { cycle: 'semestral' })).status, 200);
    assert.deepEqual(
      invoices(sem.shopId).map((i) => [i.reference.replace(/\d{4}-\d{2}$/, 'mes'), i.amount_cents]),
      [['semestral:mes', 47952]],
    );
  });

  test('não quer continuar: a contratação é cancelada e o painel fecha', async () => {
    const { shopId, owner } = await trialShop(addDays(today, 1));
    assert.equal((await owner('POST', '/api/shop/subscription/cancel', { reason: 'Ainda não é o momento' })).status, 200);
    const shop = get<{ active: number; trial_decision: string; cancel_reason: string }>('SELECT active, trial_decision, cancel_reason FROM barbershops WHERE id = ?', [shopId])!;
    assert.deepEqual(shop, { active: 0, trial_decision: 'cancelar', cancel_reason: 'Ainda não é o momento' });
    assert.equal((await owner('GET', '/api/shop/agenda?date=' + today)).status, 403);
  });

  test('quem já pagou não cancela por aqui', async () => {
    const { shopId, owner } = await trialShop(addDays(today, -40));
    run("INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, status, paid_at, created_at) VALUES (?, '2026-01', 'Mensalidade', 9990, '2026-01-10', 'paid', '2026-01-10', ?)", [
      shopId,
      nowIso(),
    ]);
    const r = await owner('POST', '/api/shop/subscription/cancel', {});
    assert.equal(r.status, 409);
    assert.equal(get<{ active: number }>('SELECT active FROM barbershops WHERE id = ?', [shopId])!.active, 1);
  });
});
