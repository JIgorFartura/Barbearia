import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-guia-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const anon = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO barbershops (slug, name, bot_name, guide_listed, city, created_at) VALUES ('outra', 'Outra Barbearia', 'Zé', 1, 'Campinas', ?)", [nowIso()]);
run("INSERT INTO barbershops (slug, name, bot_name, guide_listed, city, active, created_at) VALUES ('suspensa', 'Suspensa', 'Zé', 1, 'Campinas', 0, ?)", [nowIso()]);
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);

describe('divulgar e guia de barbearias', () => {
  test('o dono vê os links para divulgar', async () => {
    const r = await owner('GET', '/api/shop/promote');
    assert.match(r.data.site, /\/b\/navalha$/);
    assert.equal(r.data.queue, null, 'sem fila ligada, sem link da fila');
  });

  test('só aparece no guia quem pediu (e está ativa); precisa da cidade', async () => {
    let g = (await anon('GET', '/api/public/guide')).data;
    assert.deepEqual(g.shops.map((s: { slug: string }) => s.slug), ['outra']);
    assert.equal((await owner('PUT', '/api/shop/promote/guide', { listed: true, city: null, district: null })).status, 400);
    assert.equal((await owner('PUT', '/api/shop/promote/guide', { listed: true, city: 'São Paulo', district: 'Pinheiros' })).status, 200);
    g = (await anon('GET', '/api/public/guide')).data;
    assert.deepEqual(g.cities, ['Campinas', 'São Paulo']);
    g = (await anon('GET', '/api/public/guide?q=pinheiros')).data;
    assert.deepEqual(g.shops.map((s: { slug: string; district: string }) => [s.slug, s.district]), [['navalha', 'Pinheiros']]);
    assert.equal(g.shops[0].id, undefined, 'sem o id interno');
  });
});
