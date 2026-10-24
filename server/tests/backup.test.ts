import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-backup-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.BACKUP_KEEP = '3';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { config } = await import('../config.js');
const { backupsDir, createBackup, dailyBackup, decrypt, listBackups, signS3 } = await import('../backup.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

run("INSERT INTO barbershops (slug, name, created_at) VALUES ('navalha', 'Navalha de Ouro', ?)", [nowIso()]);

/** Abre a cópia .db.gz e devolve o nome da barbearia gravada nela. */
function shopNameIn(gz: Buffer): string {
  const file = path.join(os.tmpdir(), `restaurado-${Date.now()}-${Math.random()}.db`);
  fs.writeFileSync(file, zlib.gunzipSync(gz));
  const db = new DatabaseSync(file);
  const name = (db.prepare('SELECT name FROM barbershops LIMIT 1').get() as { name: string }).name;
  db.close();
  fs.rmSync(file);
  return name;
}

describe('cópia de segurança', () => {
  test('assinatura do armazenamento confere com o exemplo oficial da AWS (SigV4)', () => {
    const h = signS3({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      amzDate: '20130524T000000Z',
    });
    assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });

  test('grava a cópia local compactada e guarda só as últimas', async () => {
    for (let i = 0; i < 5; i++) await createBackup({ now: new Date(Date.UTC(2026, 9, 20 + i, 7, 0, 0)), env: {} });
    const files = listBackups();
    assert.equal(files.length, 3);
    assert.equal(files[0].name, 'barbearia-2026-10-24-040000.db.gz');
    assert.equal(shopNameIn(fs.readFileSync(path.join(backupsDir, files[0].name))), 'Navalha de Ouro');
  });

  test('uma por dia, a partir das 3h', async () => {
    assert.equal(await dailyBackup(new Date('2026-10-25T05:00:00Z')), false); // 2h em Brasília
    assert.equal(await dailyBackup(new Date('2026-10-25T06:30:00Z')), true);
    assert.equal(await dailyBackup(new Date('2026-10-25T20:00:00Z')), false);
  });

  test('envia criptografada para o armazenamento e as imagens só uma vez', async () => {
    fs.writeFileSync(path.join(config.uploadsDir, 'logo123.png'), Buffer.from('png'));
    const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const env = {
      BACKUP_S3_ENDPOINT: 'https://conta.r2.cloudflarestorage.com',
      BACKUP_S3_BUCKET: 'copias',
      BACKUP_S3_ACCESS_KEY: 'chave',
      BACKUP_S3_SECRET_KEY: 'segredo',
      BACKUP_PASSWORD: 'senha-das-copias',
    };
    const status = await createBackup({ now: new Date('2026-10-26T07:00:00Z'), env, fetchImpl: fakeFetch });
    assert.equal(status.remote, 'ok');
    assert.equal(status.uploadsSent, 1);
    const [copy, image] = calls;
    assert.equal(copy.url, 'https://conta.r2.cloudflarestorage.com/copias/barbearia/barbearia-2026-10-26-040000.db.gz.enc');
    assert.match(copy.headers.authorization, /^AWS4-HMAC-SHA256 Credential=chave\/20\d{6}\/auto\/s3\/aws4_request/);
    assert.equal(shopNameIn(decrypt(copy.body, 'senha-das-copias')), 'Navalha de Ouro');
    assert.throws(() => decrypt(copy.body, 'errada'), /Senha da cópia incorreta/);
    assert.equal(image.url, 'https://conta.r2.cloudflarestorage.com/copias/barbearia/uploads/logo123.png');

    calls.length = 0;
    await createBackup({ now: new Date('2026-10-27T07:00:00Z'), env, fetchImpl: fakeFetch });
    assert.equal(calls.length, 1, 'a imagem já enviada não vai de novo');

    const failing = (async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as unknown as typeof fetch;
    const failed = await createBackup({ now: new Date('2026-10-28T07:00:00Z'), env, fetchImpl: failing });
    assert.equal(failed.remote, 'failed');
    assert.match(failed.error!, /HTTP 403 AccessDenied/);
    assert.ok(fs.existsSync(path.join(backupsDir, failed.file!)), 'a cópia local fica mesmo se o envio falhar');
  });

  test('master vê, faz e baixa as cópias; ninguém mais', async () => {
    const master = makeClient(() => base);
    assert.equal((await master('POST', '/api/auth/setup', { name: 'Igor', email: 'igor@exemplo.com', password: 'senha-forte-1' })).status, 201);
    const made = await master('POST', '/api/master/backups');
    assert.equal(made.status, 201);
    const list = await master('GET', '/api/master/backups');
    assert.equal(list.data.status.file, made.data.file);
    assert.equal(list.data.remote, null);
    const res = await fetch(`${base}/api/master/backups/${made.data.file}`, { headers: { cookie: '' } });
    assert.equal(res.status, 401);
    const download = await master('GET', `/api/master/backups/${made.data.file}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal((await master('GET', '/api/master/backups/..%2Fbarbearia.db')).status, 404);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM platform_settings WHERE key = 'backup_status'")!.n, 1);
  });
});
