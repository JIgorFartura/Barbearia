import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

/*
 * Uma barbearia nunca vê nem mexe nos dados de outra. Em vez de conferir rota por rota (e esquecer a
 * próxima), este teste percorre TODAS as rotas do painel, do app do barbeiro e da área do cliente com
 * os IDs de outra barbearia (a de demonstração, cheia de dados) e exige que:
 *   1) nenhuma resposta traga um celular ou nome de cliente dela;
 *   2) nenhum dado dela mude (as linhas de todas as tabelas, antes e depois).
 * Rota nova entra no teste sozinha.
 */

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-isolamento-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { signup } = await import('../signup.js');
const { shopRouter } = await import('../routes/shop.js');
const { barberRouter } = await import('../routes/barber.js');
const { customerRouter } = await import('../routes/customer.js');
// A vítima: a barbearia de demonstração (e a filial dela), com meses de movimento.
await import('../../tools/seed-demo.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

// Todas as barbearias que existem antes do intruso: a demonstração e a filial dela.
const victimIds = all<{ id: number }>('SELECT id FROM barbershops').map((r) => r.id);
const victimSlug = 'demo';
const inVictim = `(${victimIds.join(',')})`;

// O intruso: outra barbearia, criada depois (os IDs dela são todos maiores que os da vítima).
const intruder = signup({ shopName: 'Barbearia Intrusa', name: 'Dono Intruso', phone: '21900001111', email: 'intruso@exemplo.com', password: 'senha-forte-1' });
const intruderBarber = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Zeca Intruso', ?)", [intruder.shopId, nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, phone, barber_id, password_hash, terms_accepted_at, created_at) VALUES (?, 'barber', 'Zeca Intruso', '21900002222', ?, ?, ?, ?)", [
  intruder.shopId,
  intruderBarber,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
run("INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, 'Cliente Intruso', '21900003333', ?, ?)", [intruder.shopId, nowIso(), nowIso()]);

/**
 * Onde estão os dados da vítima, tabela por tabela: pela coluna barbershop_id ou, nas tabelas filhas,
 * pelo cliente, venda, horário, barbeiro ou oferta a que pertencem.
 */
const parents: [string, string][] = [
  ['barbershop_id', `SELECT id FROM barbershops WHERE id IN ${inVictim}`],
  ['customer_id', `SELECT id FROM customers WHERE barbershop_id IN ${inVictim}`],
  ['sale_id', `SELECT id FROM sales WHERE barbershop_id IN ${inVictim}`],
  ['appointment_id', `SELECT id FROM appointments WHERE barbershop_id IN ${inVictim}`],
  ['barber_id', `SELECT id FROM barbers WHERE barbershop_id IN ${inVictim}`],
  ['offer_id', `SELECT id FROM offers WHERE barbershop_id IN ${inVictim}`],
];
const scoped = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").flatMap((t) => {
  const cols = all<{ name: string }>(`PRAGMA table_info(${t.name})`).map((c) => c.name);
  const p = parents.find(([col]) => cols.includes(col));
  return p ? [{ table: t.name, where: `${p[0]} IN (${p[1]})` }] : [];
});

/** Fotografia de tudo o que é da vítima. */
const snapshot = () => {
  const h = createHash('sha256');
  for (const { table, where } of scoped) h.update(table + JSON.stringify(all(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`)));
  return h.digest('hex');
};

/** O que nunca pode aparecer para o intruso: celulares e nomes completos dos clientes da vítima. */
const markers = [
  ...new Set(
    all<{ name: string; phone: string }>(`SELECT name, phone FROM customers WHERE barbershop_id IN ${inVictim}`).flatMap((c) => [c.phone, ...(c.name.includes(' ') ? [c.name] : [])]),
  ),
];
// Nomes que aparecem nos textos fixos do sistema (os exemplos dos modelos da Meta) não contam.
const fixedTexts = fs.readFileSync(new URL('../templates.ts', import.meta.url), 'utf8');
const markersOk = markers.filter((m) => !fixedTexts.includes(m));
const leaked = (body: unknown) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return markersOk.find((m) => text.includes(m));
};

/** IDs da vítima para pôr nos parâmetros: o menor, o do meio e o maior de cada tabela, mais os códigos de voucher e vale-presente. */
const victimIdValues = [
  ...new Set(
    scoped.flatMap(({ table, where }) => {
      const ids = all<{ id: number }>(`SELECT rowid AS id FROM ${table} WHERE ${where} ORDER BY rowid`).map((r) => r.id);
      return ids.length ? [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]] : [];
    }),
  ),
].map(String);
const victimCodes = [
  ...all<{ code: string }>(`SELECT code FROM gift_cards WHERE barbershop_id IN ${inVictim} LIMIT 3`),
  ...all<{ code: string }>(`SELECT code FROM vouchers WHERE customer_id IN (SELECT id FROM customers WHERE barbershop_id IN ${inVictim}) LIMIT 3`),
].map((r) => r.code);

interface Route {
  method: string;
  path: string;
}
function routesOf(router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }): Route[] {
  return router.stack.flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route!.path })) : []));
}
/** Endereços a tentar: com parâmetro, um para cada ID (ou código) da vítima; sem parâmetro, só a leitura. */
function attempts(routes: Route[], skip: RegExp): Route[] {
  return routes
    .filter((r) => !skip.test(`${r.method} ${r.path}`))
    .flatMap((r) => {
      const param = /:(\w+)/.exec(r.path);
      if (!param) return r.method === 'GET' ? [r] : [];
      const values = param[1] === 'code' ? victimCodes : victimIdValues;
      return values.map((v) => ({ method: r.method, path: r.path.replace(/:\w+/g, v) }));
    });
}

async function sweep(client: ReturnType<typeof makeClient>, prefix: string, list: Route[]) {
  const leaks: string[] = [];
  for (const r of list) {
    // Corpo mínimo: rotas de ação (cancelar, confirmar, apagar...) funcionam sem corpo; as de formulário recusam antes.
    const res = await client(r.method, `${prefix}${r.path}`, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    const found = leaked(res.data);
    if (found) leaks.push(`${r.method} ${prefix}${r.path} → ${res.status} (mostrou ${found.replace(/\d{6}/, '••••••')})`);
  }
  return leaks;
}

describe('isolamento entre barbearias', () => {
  test('a vítima tem dados de verdade para o teste valer', () => {
    assert.ok(markers.length > 50, `clientes da demonstração: ${markers.length}`);
    assert.ok(victimIdValues.length > 15);
    assert.ok(victimCodes.length > 0);
  });

  test('o barbeiro de outra barbearia não vê nem mexe em nada pelo app do barbeiro', async () => {
    const barber = makeClient(() => base);
    assert.equal((await barber('POST', '/api/auth/login', { login: '21900002222', password: 'senha-forte-1' })).status, 200);
    const before = snapshot();
    const leaks = await sweep(barber, '/api/barber', attempts(routesOf(barberRouter), /^$/));
    assert.deepEqual(leaks, []);
    assert.equal(snapshot(), before);
  });

  test('o cliente de outra barbearia não entra na área do cliente da vítima', async () => {
    const customer = makeClient(() => base);
    const code = await customer('POST', `/api/public/shops/${intruder.slug}/login/code`, { phone: '21900003333' });
    assert.equal((await customer('POST', `/api/public/shops/${intruder.slug}/login/verify`, { phone: '21900003333', code: code.data.demoCode })).status, 200);
    const before = snapshot();
    const leaks = await sweep(customer, `/api/customer/${victimSlug}`, attempts(routesOf(customerRouter), /^$/));
    assert.deepEqual(leaks, []);
    assert.equal(snapshot(), before);
  });
  // Por último: o dono pode mexer nos próprios barbeiros e clientes com os mesmos números de ID.
  test('o dono de outra barbearia não vê nem mexe em nada pelas rotas do painel', async () => {
    const owner = makeClient(() => base);
    assert.equal((await owner('POST', '/api/auth/login', { login: 'intruso@exemplo.com', password: 'senha-forte-1' })).status, 200);
    const before = snapshot();
    // Fora: as que encerram a própria conta do intruso (o resto do teste precisa dela).
    const list = attempts(routesOf(shopRouter), /^POST \/subscription\/cancel$/);
    assert.ok(list.length > 500, `tentativas: ${list.length}`);
    const leaks = await sweep(owner, '/api/shop', list);
    assert.deepEqual(leaks, []);
    assert.equal(snapshot(), before, 'algum dado da outra barbearia mudou');
  });
});
