import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-cadastro-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { savePlatformSettings, platformSettings } = await import('../billing.js');
const { signup } = await import('../signup.js');
const { parseBirth } = await import('../importCustomers.js');

let server: Server;
let base = '';
const newOwner = makeClient(() => base);
const owner = makeClient(() => base);
const desk = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await desk('POST', '/api/auth/login', { login: 'bruna@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
for (const [role, name, email, phone, shop] of [
  ['owner', 'Carlos', 'carlos@navalha.com', null, shopId],
  ['reception', 'Bruna', 'bruna@navalha.com', null, shopId],
  ['master', 'Igor', 'igor@exemplo.com', '11900001111', null],
] as const) {
  run('INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    shop,
    role,
    name,
    email,
    phone,
    hashPassword('senha-forte-1'),
    nowIso(),
    nowIso(),
  ]);
}
run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Ana Lima', '11988880000', ?)", [shopId, nowIso()]);

const form = { shop_name: 'Barbearia do Zé', name: 'José Silva', phone: '(21) 97777-6666', email: 'ze@barbearia.com', password: 'senha-do-ze-1', accept: true };

describe('cadastro sozinho com teste grátis', () => {
  test('o site mostra se o cadastro está aberto e quantos dias grátis', async () => {
    assert.deepEqual((await newOwner('GET', '/api/public/signup')).data, { enabled: true, trialDays: 14 });
  });

  test('cria a barbearia, o login do dono e já entra no painel', async () => {
    assert.equal((await newOwner('POST', '/api/public/signup', { ...form, accept: false })).status, 400, 'sem aceitar os termos');
    // O endereço do site aparece enquanto o dono digita o nome, igual ao que o cadastro cria.
    assert.equal((await newOwner('GET', `/api/public/signup/link?name=${encodeURIComponent('Barbearia do Zé')}`)).data.slug, 'barbearia-do-ze');
    assert.equal((await newOwner('GET', '/api/public/signup/link?name=Z')).data.slug, null);
    const r = await newOwner('POST', '/api/public/signup', form);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.slug, 'barbearia-do-ze');
    assert.equal((await newOwner('GET', `/api/public/signup/link?name=${encodeURIComponent('Barbearia do Zé')}`)).data.slug, 'barbearia-do-ze-2', 'nome já usado ganha um número');
    const me = (await newOwner('GET', '/api/auth/me')).data;
    assert.equal(me.user.role, 'owner');
    assert.equal(me.user.termsAccepted, true, 'aceitou os termos no cadastro');
    assert.equal(me.shop.name, 'Barbearia do Zé');
    const shop = get<{ trial_until: string | null }>('SELECT trial_until FROM barbershops WHERE id = ?', [me.shop.id])!;
    assert.ok(shop.trial_until, 'começa nos dias grátis');
    assert.equal((await newOwner('GET', '/api/shop/status')).data.blocked, false);
    // O master recebe o aviso para dar as boas-vindas.
    for (let i = 0; i < 50 && !get("SELECT 1 AS ok FROM platform_messages WHERE kind = 'aviso'"); i++) await new Promise((res) => setTimeout(res, 10));
    assert.match(get<{ body: string }>("SELECT body FROM platform_messages WHERE kind = 'aviso' AND phone = '11900001111'")!.body, /Nova barbearia no teste grátis: Barbearia do Zé/);
  });

  test('não repete celular; limite de cadastros por endereço', async () => {
    const again = await makeClient(() => base)('POST', '/api/public/signup', { ...form, shop_name: 'Outra', email: 'outro@x.com' });
    assert.equal(again.status, 409, 'celular já usado');
    const many = await makeClient(() => base)('POST', '/api/public/signup', { ...form, phone: '21966665555', email: 'mais@x.com' });
    assert.equal(many.status, 429, 'no máximo 3 tentativas por hora do mesmo endereço');
  });

  test('o master pode fechar o cadastro', () => {
    savePlatformSettings({ ...platformSettings(), signup_enabled: false });
    assert.throws(() => signup({ shopName: 'Fechada', name: 'X', phone: '11955554444', email: null, password: 'senha-forte-1' }), /cadastro pelo site está fechado/);
    savePlatformSettings({ ...platformSettings(), signup_enabled: true });
  });
});

describe('importação de clientes por planilha', () => {
  test('aniversário em vários formatos', () => {
    assert.equal(parseBirth('25/12'), '12-25');
    assert.equal(parseBirth('5/3/1990'), '03-05');
    assert.equal(parseBirth('1990-12-25'), '12-25');
    assert.equal(parseBirth('31/02'), null);
    assert.equal(parseBirth(''), null);
  });

  test('importa, pula o que não serve e diz por quê', async () => {
    const rows = [
      { name: 'João Pereira', phone: '(11) 99999-0000', birth: '25/12/1990' },
      { name: '', phone: '11911112222' },
      { name: 'Celular Errado', phone: '1234' },
      { name: 'Ana de Novo', phone: '11 98888-0000' },
      { name: 'João Repetido', phone: '+55 11 99999-0000' },
      { name: '  Pedro   Alves ', phone: '11977770000' },
    ];
    const r = await owner('POST', '/api/shop/customers/import', { rows });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.created, 2);
    assert.deepEqual(
      r.data.skipped.map((s: { line: number; reason: string }) => [s.line, s.reason]),
      [
        [3, 'sem nome'],
        [4, 'celular inválido'],
        [5, 'já cadastrado'],
        [6, 'já cadastrado'],
      ],
    );
    assert.deepEqual(
      all<{ name: string; birth_date: string | null }>("SELECT name, birth_date FROM customers WHERE barbershop_id = ? AND name IN ('João Pereira', 'Pedro Alves') ORDER BY name", [shopId]),
      [
        { name: 'João Pereira', birth_date: '12-25' },
        { name: 'Pedro Alves', birth_date: null },
      ],
    );
    assert.equal((await desk('POST', '/api/shop/customers/import', { rows })).status, 403, 'a recepção não importa');
    assert.equal((await owner('POST', '/api/shop/customers/import', { rows: [] })).status, 400);
  });
});
