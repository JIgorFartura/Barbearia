import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-loja-app-'));
process.env.AUTOMATIONS = '0';
process.env.ANDROID_PACKAGE = 'br.com.bladr.app';
process.env.ANDROID_SHA256 = 'AA:BB:CC, DD:EE:FF';

const { app } = await import('../index.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe('app na Play Store', () => {
  test('o site declara o app da loja (Digital Asset Links)', async () => {
    const r = await fetch(`${base}/.well-known/assetlinks.json`);
    assert.equal(r.status, 200);
    const [link] = await r.json();
    assert.deepEqual(link.target, { namespace: 'android_app', package_name: 'br.com.bladr.app', sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'] });
  });
});
