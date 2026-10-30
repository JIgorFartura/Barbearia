import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-sistema-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { errorHandler } = await import('../http.js');
const { errorAlerts, resetErrorAlerts } = await import('../errors.js');

let server: Server;
let base = '';
const master = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
});
after(() => server.close());

run("INSERT INTO users (role, name, email, phone, password_hash, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', '11977770000', ?, ?)", [
  hashPassword('senha-forte-1'),
  nowIso(),
]);

/** Simula um erro de programa numa rota (o tratador de erros do Express). */
function crash(err: Error, url: string) {
  const res = { headersSent: false, status: () => res, json: () => res } as unknown as Response;
  errorHandler(err, { originalUrl: url } as Request, res, () => undefined);
}

describe('erros do sistema: o master fica sabendo', () => {
  test('erro de programa no servidor e nas telas entra no registro, sem dados de clientes', async () => {
    crash(new Error('Falhou ao ler o cliente 11999990000'), '/api/shop/agenda?date=2026-10-25');
    crash(new Error('Falhou ao ler o cliente 11999990000'), '/api/shop/agenda?date=2026-10-26');
    const r = await fetch(`${base}/api/client-errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Cannot read properties of undefined (joao@exemplo.com)', stack: 'at Panel', path: '/painel/agenda' }),
    });
    assert.equal(r.status, 204);
    const list = (await master('GET', '/api/master/system')).data.errors;
    assert.equal(list.length, 2);
    const server = list.find((e: { source: string }) => e.source === 'server');
    assert.equal(server.count, 2, 'o mesmo erro só soma');
    assert.equal(server.path, '/api/shop/agenda', 'sem os parâmetros da URL');
    assert.doesNotMatch(JSON.stringify(list), /11999990000|joao@exemplo\.com/);
    // Aviso previsto (HttpError) não é erro de programa.
    const { HttpError } = await import('../http.js');
    crash(new HttpError(502, 'A Cielo não respondeu'), '/api/shop/online/test');
    assert.equal((await master('GET', '/api/master/system')).data.errors.length, 2);
  });

  test('o master recebe no máximo um aviso por hora no WhatsApp da plataforma', async () => {
    resetErrorAlerts();
    const now = new Date();
    assert.equal(await errorAlerts(now), 1);
    const msg = all<{ body: string }>("SELECT body FROM platform_messages WHERE kind = 'alerta' ORDER BY id DESC LIMIT 1")[0];
    assert.match(msg.body, /3 erro\(s\)/);
    crash(new Error('Outro erro'), '/api/shop/finance/summary');
    assert.equal(await errorAlerts(new Date(now.getTime() + 10 * 60000)), 0, 'dentro da mesma hora, não repete');
    assert.equal(await errorAlerts(new Date(now.getTime() + 61 * 60000)), 1, 'erro novo depois de uma hora: avisa');
    assert.equal(await errorAlerts(new Date(now.getTime() + 125 * 60000)), 0, 'nada de novo: não avisa');
  });

  test('o master limpa a lista; quem não é master não vê', async () => {
    const owner = makeClient(() => base);
    assert.equal((await owner('GET', '/api/master/system')).status, 401);
    assert.equal((await master('POST', '/api/master/errors/clear')).status, 200);
    assert.deepEqual((await master('GET', '/api/master/system')).data.errors, []);
  });
});
