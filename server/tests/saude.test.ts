import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-saude-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { config } = await import('../config.js');
const { automationStatus } = await import('../automations.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const health = async () => {
  const r = await fetch(`${base}/api/health`);
  return { status: r.status, body: await r.json() };
};

describe('saúde do sistema (monitor de disponibilidade)', () => {
  test('banco respondendo e automações em dia: 200', async () => {
    assert.deepEqual(await health(), { status: 200, body: { ok: true, database: true, automations: true } });
  });

  test('automações paradas há mais de 10 minutos: 503 (o monitor avisa)', async () => {
    const saved = { enabled: config.automations, lastRun: automationStatus.lastRun };
    (config as { automations: boolean }).automations = true;
    automationStatus.lastRun = new Date(Date.now() - 11 * 60000).toISOString();
    try {
      assert.deepEqual(await health(), { status: 503, body: { ok: false, database: true, automations: false } });
      automationStatus.lastRun = new Date(Date.now() - 2 * 60000).toISOString();
      assert.equal((await health()).status, 200);
    } finally {
      (config as { automations: boolean }).automations = saved.enabled;
      automationStatus.lastRun = saved.lastRun;
    }
  });
});
