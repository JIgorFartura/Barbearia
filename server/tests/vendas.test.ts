import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-vendas-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { run } = await import('../db.js');
const { savePlatformSettings, platformSettings } = await import('../billing.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const pricing = async () => (await fetch(`${base}/api/public/pricing`)).json();

describe('preços na página de vendas', () => {
  test('planos ativos do master (as redes à parte), descontos, implantação e dias grátis', async () => {
    savePlatformSettings({ ...platformSettings(), trial_days: 7, setup_fee_cents: 19700, setup_free_on_annual: true });
    const p = await pricing();
    assert.deepEqual(
      p.plans.map((x: { name: string; price_cents: number }) => [x.name, x.price_cents]),
      [
        ['Solo', 6990],
        ['Equipe', 9990],
        ['Equipe 10', 14990],
        ['Ilimitado', 18990],
      ],
    );
    assert.ok(p.network.minPerUnitCents < 13000, 'rede: o menor valor por unidade');
    assert.deepEqual(p.discounts, { trimestral: 10, semestral: 15, anual: 25 });
    assert.deepEqual([p.trialDays, p.setupFeeCents, p.setupFreeFromSemester, p.signupEnabled], [7, 19700, true, true]);
  });

  test('mudou no master, muda na página', async () => {
    run("UPDATE plans SET price_cents = 7990 WHERE name = 'Solo'");
    run("UPDATE plans SET active = 0 WHERE name = 'Equipe 10'");
    const names = (await pricing()).plans.map((x: { name: string; price_cents: number }) => `${x.name} ${x.price_cents}`);
    assert.deepEqual(names, ['Solo 7990', 'Equipe 9990', 'Ilimitado 18990']);
  });
});
