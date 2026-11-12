import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-nfse-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { asaasHttp } = await import('../asaas.js');
const { saleServices } = await import('../shopNfse.js');

const invoices: Record<string, unknown>[] = [];
asaasHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/customers') && method === 'POST') return json({ id: 'cus_ana' });
  if (url.endsWith('/invoices') && method === 'POST') {
    invoices.push(body);
    return json({ id: `inv_${invoices.length}`, status: 'SCHEDULED' });
  }
  return json({ errors: [{ description: 'não encontrado' }] }, 404);
}) as typeof fetch;

let server: Server;
let base = '';
const owner = makeClient(() => base);
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
const item = (kind: string, name: string, price: number) =>
  run('INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, kind, name, price, nowIso()]).lastInsertRowid;
const corte = item('service', 'Corte', 5000);
const barba = item('service', 'Barba', 3000);
const pomada = item('product', 'Pomada', 4000);
const ana = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Ana Lima', '11988880000', ?)", [shopId, nowIso()]).lastInsertRowid;
const sell = (body: object) => owner('POST', '/api/shop/finance/sales', { method: 'pix', ...body });
let token = '';

describe('nota fiscal de serviço (NFS-e)', () => {
  test('só liga com a conta Asaas da barbearia', async () => {
    assert.equal((await owner('PUT', '/api/shop/nfse', { mode: 'manual', serviceName: 'Serviços de barbearia', serviceCode: '06.01', iss: 2, observations: '' })).status, 409);
    const a = await owner('PUT', '/api/shop/asaas', { env: 'sandbox', apiKey: 'chave-da-barbearia', pixAuto: false });
    token = a.data.webhookToken;
    const r = await owner('PUT', '/api/shop/nfse', { mode: 'manual', serviceName: 'Serviços de barbearia', serviceCode: '06.01', iss: 2, observations: 'Obrigado pela preferência!' });
    assert.equal(r.status, 200);
    assert.equal(r.data.mode, 'manual');
  });

  test('a nota leva só os serviços, com o desconto dividido', async () => {
    const s = await sell({ customer_id: ana, items: [{ catalog_item_id: corte, qty: 1 }, { catalog_item_id: barba, qty: 1 }, { catalog_item_id: pomada, qty: 1 }], discount_cents: 1200 });
    // Subtotal R$ 120 com R$ 12 de desconto (10%): serviços R$ 80 → R$ 72.
    assert.deepEqual(saleServices(s.data.sale.id), { value: 7200, names: 'Corte, Barba' });

    const noCpf = await owner('POST', `/api/shop/finance/sales/${s.data.sale.id}/nfse`, {});
    assert.equal(noCpf.status, 409);
    assert.match(noCpf.data.error, /CPF/);
    const r = await owner('POST', `/api/shop/finance/sales/${s.data.sale.id}/nfse`, { cpf: '529.982.247-25' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.nfse_status, 'SCHEDULED');
    const sent = invoices[0];
    assert.equal(sent.customer, 'cus_ana');
    assert.equal(sent.value, 72);
    assert.equal(sent.serviceDescription, 'Corte, Barba');
    assert.equal(sent.municipalServiceCode, '06.01');
    assert.deepEqual(sent.taxes, { retainIss: false, iss: 2, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 });
    // Pedir de novo não emite duas notas.
    await owner('POST', `/api/shop/finance/sales/${s.data.sale.id}/nfse`, {});
    assert.equal(invoices.length, 1);

    // Só produto: sem nota de serviço.
    const p = await sell({ customer_id: ana, items: [{ catalog_item_id: pomada, qty: 1 }] });
    assert.equal((await owner('POST', `/api/shop/finance/sales/${p.data.sale.id}/nfse`, {})).status, 409);
  });

  test('o aviso do Asaas traz a nota emitida, que aparece para o cliente', async () => {
    const r = await makeClient(() => base)(
      'POST',
      `/api/webhooks/asaas/barbearia/${token}`,
      { event: 'INVOICE_AUTHORIZED', invoice: { id: 'inv_1', status: 'AUTHORIZED', pdfUrl: 'https://sandbox.asaas.com/nota/inv_1.pdf' } },
      { 'asaas-access-token': token },
    );
    assert.equal(r.status, 200);
    const sale = get<{ nfse_status: string; nfse_url: string }>("SELECT nfse_status, nfse_url FROM sales WHERE nfse_id = 'inv_1'")!;
    assert.deepEqual(sale, { nfse_status: 'AUTHORIZED', nfse_url: 'https://sandbox.asaas.com/nota/inv_1.pdf' });
    const c = makeClient(() => base);
    const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone: '11988880000' });
    await c('POST', '/api/public/shops/navalha/login/verify', { phone: '11988880000', code: asked.data.demoCode });
    const me = (await c('GET', '/api/customer/navalha/me')).data;
    assert.ok(me.payments.some((p: { nfse_url: string | null }) => p.nfse_url === 'https://sandbox.asaas.com/nota/inv_1.pdf'));
  });

  test('automática: toda venda com serviço de cliente com CPF', async () => {
    await owner('PUT', '/api/shop/nfse', { mode: 'auto', serviceName: 'Serviços de barbearia', serviceCode: '06.01', iss: 2, observations: '' });
    const s = await sell({ customer_id: ana, items: [{ catalog_item_id: corte, qty: 1 }] });
    for (let i = 0; i < 50 && invoices.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(invoices.length, 2);
    assert.equal(invoices[1].value, 50);
    assert.equal(get<{ nfse_id: string }>('SELECT nfse_id FROM sales WHERE id = ?', [s.data.sale.id])!.nfse_id, 'inv_2');
    // Venda sem cliente: sem nota (e a venda passa normalmente).
    const avulsa = await sell({ items: [{ catalog_item_id: corte, qty: 1 }] });
    assert.equal(avulsa.status, 201);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(invoices.length, 2);
  });
});
