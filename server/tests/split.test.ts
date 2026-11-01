import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-split-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { asaasHttp } = await import('../asaas.js');
const { commissionBalances } = await import('../finance.js');

// Asaas da barbearia de mentira: guarda as cobranças (com o split) e devolve o QR.
const payments: Record<string, unknown>[] = [];
asaasHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/customers') && method === 'POST') return json({ id: 'cus_1' });
  if (url.endsWith('/payments') && method === 'POST') {
    payments.push(body);
    return json({ id: `pay_${payments.length}` });
  }
  const qr = /\/payments\/(pay_\d+)\/pixQrCode$/.exec(url);
  if (qr) return json({ payload: `PIX-${qr[1]}`, encodedImage: 'iVBORw0KGgo=' });
  return json({ errors: [{ description: 'não encontrado' }] }, 404);
}) as typeof fetch;

let server: Server;
let base = '';
const owner = makeClient(() => base);
const asaas = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const barber = (name: string) => run('INSERT INTO barbers (barbershop_id, name, service_commission, created_at) VALUES (?, ?, 50, ?)', [shopId, name, nowIso()]).lastInsertRowid;
const paulo = barber('Paulo');
const marcos = barber('Marcos');
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, 'service', 'Corte', 6000, ?)", [shopId, nowIso()]).lastInsertRowid;
const ana = run("INSERT INTO customers (barbershop_id, name, phone, cpf, created_at) VALUES (?, 'Ana Lima', '11988880000', '52998224725', ?)", [shopId, nowIso()]).lastInsertRowid;
let token = '';

describe('comissão direto na conta do barbeiro (split do Asaas)', () => {
  test('o dono guarda a carteira Asaas do barbeiro e liga o split', async () => {
    const r = await owner('PUT', `/api/shop/barbers/${paulo}`, {
      name: 'Paulo',
      photo_url: null,
      active: true,
      hours: [],
      phone: null,
      service_commission: 50,
      product_commission: 0,
      rates: [],
      asaas_wallet_id: 'wallet-do-paulo',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(get<{ asaas_wallet_id: string }>('SELECT asaas_wallet_id FROM barbers WHERE id = ?', [paulo])!.asaas_wallet_id, 'wallet-do-paulo');
    const a = await owner('PUT', '/api/shop/asaas', { env: 'sandbox', apiKey: 'chave', pixAuto: false, splitCommissions: true });
    assert.equal(a.data.splitCommissions, true);
    token = a.data.webhookToken;
  });

  test('o PIX da comanda sai com a comissão e a gorjeta do Paulo para a carteira dele; o Marcos (sem carteira) recebe pelo caixa', async () => {
    const r = await owner('POST', '/api/shop/finance/pix-checkout', {
      customer_id: ana,
      items: [
        { catalog_item_id: corte, qty: 1, barber_id: paulo },
        { catalog_item_id: corte, qty: 1, barber_id: marcos },
      ],
      tip_cents: 1000,
      tip_barber_id: paulo,
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(payments[0].value, 130);
    // 50% de R$ 60 + R$ 10 de gorjeta.
    assert.deepEqual(payments[0].split, [{ walletId: 'wallet-do-paulo', fixedValue: 40 }]);

    const paid = await asaas(
      'POST',
      `/api/webhooks/asaas/barbearia/${token}`,
      { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', billingType: 'PIX', externalReference: `comanda:${r.data.id}` } },
      { 'asaas-access-token': token },
    );
    assert.equal(paid.status, 200);
    const bal = commissionBalances(shopId);
    assert.equal(bal.find((b) => b.barber_id === paulo)!.unpaid_cents, 0, 'o Paulo já recebeu pelo split');
    assert.equal(bal.find((b) => b.barber_id === marcos)!.unpaid_cents, 3000, 'o Marcos recebe no pagamento de comissões');
    assert.deepEqual(
      all<{ category: string; type: string; amount_cents: number }>("SELECT category, type, amount_cents FROM cash_entries WHERE category = 'Comissões'").map((e) => [e.type, e.amount_cents]),
      [['out', 4000]],
    );
  });

  test('sem o split ligado, a cobrança sai inteira para a barbearia', async () => {
    await owner('PUT', '/api/shop/asaas', { env: 'sandbox', pixAuto: false, splitCommissions: false });
    const r = await owner('POST', '/api/shop/finance/pix-checkout', { customer_id: ana, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(payments.at(-1)!.split, undefined);
  });
});
