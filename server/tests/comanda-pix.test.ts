import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-comanda-pix-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { asaasHttp } = await import('../asaas.js');

// Asaas da barbearia de mentira: clientes, cobranças PIX com QR e exclusão.
const customers: Record<string, unknown>[] = [];
const payments: Record<string, unknown>[] = [];
const deleted: string[] = [];
asaasHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/customers') && method === 'POST') {
    customers.push(body);
    return json({ id: `cus_${customers.length}` });
  }
  if (url.endsWith('/payments') && method === 'POST') {
    payments.push(body);
    return json({ id: `pay_${payments.length}` });
  }
  const qr = /\/payments\/(pay_\d+)\/pixQrCode$/.exec(url);
  if (qr && method === 'GET') return json({ payload: `00020126PIX-${qr[1]}`, encodedImage: 'iVBORw0KGgo=' });
  const del = /\/payments\/(pay_\d+)$/.exec(url);
  if (del && method === 'DELETE') {
    deleted.push(del[1]);
    return json({ deleted: true });
  }
  return json({ errors: [{ description: 'não encontrado' }] }, 404);
}) as typeof fetch;

let server: Server;
let base = '';
const owner = makeClient(() => base);
const desk = makeClient(() => base);
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
const item = (kind: string, name: string, price: number) =>
  run('INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, kind, name, price, nowIso()]).lastInsertRowid;
const corte = item('service', 'Corte', 5000);
const pomada = item('product', 'Pomada', 4000);
const ana = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'Ana Lima', '11988880000', ?)", [shopId, nowIso()]).lastInsertRowid;

const sales = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM sales WHERE barbershop_id = ?', [shopId])!.n;
const cashIn = () => get<{ s: number }>("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM cash_entries WHERE barbershop_id = ? AND type = 'in'", [shopId])!.s;
const pomadas = () => get<{ stock_qty: number }>('SELECT stock_qty FROM catalog_items WHERE id = ?', [pomada])!.stock_qty;
const comanda = { customer_id: ana, items: [{ catalog_item_id: corte, qty: 1 }, { catalog_item_id: pomada, qty: 1 }] };
let token = '';
const paid = (paymentId: string, ref: string, event = 'PAYMENT_RECEIVED') =>
  asaas('POST', `/api/webhooks/asaas/barbearia/${token}`, { event, payment: { id: paymentId, billingType: 'PIX', externalReference: ref } }, { 'asaas-access-token': token });

describe('PIX na comanda com confirmação automática', () => {
  test('sem o Asaas da barbearia: o PIX da chave continua, sem QR automático', async () => {
    assert.equal((await owner('GET', '/api/shop/finance/checkout')).data.pixAuto, false);
    const r = await owner('POST', '/api/shop/finance/pix-checkout', comanda);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Asaas/);
  });

  test('cliente sem CPF: pede o CPF antes de gerar o PIX, sem gravar nada', async () => {
    const a = await owner('PUT', '/api/shop/asaas', { env: 'sandbox', apiKey: 'chave-da-barbearia', pixAuto: false });
    token = a.data.webhookToken;
    await owner('POST', '/api/shop/stock/entries', { items: [{ catalog_item_id: pomada, qty: 5, unit_cost_cents: 1500 }], supplier: null, cash: { status: 'pending', date: '2026-11-10', method: null } });
    assert.equal((await owner('GET', '/api/shop/finance/checkout')).data.pixAuto, true);
    const r = await owner('POST', '/api/shop/finance/pix-checkout', comanda);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { needsCpf: true });
    assert.equal(payments.length, 0);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM pix_checkouts')!.n, 0);
  });

  test('gera o QR na conta da barbearia e espera: nada entra no caixa nem sai do estoque', async () => {
    const before = { sales: sales(), cash: cashIn(), stock: pomadas() };
    const r = await owner('POST', '/api/shop/finance/pix-checkout', { ...comanda, discount_cents: 1000, payer_cpf: '529.982.247-25' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.status, 'pending');
    assert.equal(r.data.amount_cents, 8000);
    assert.equal(r.data.payload, '00020126PIX-pay_1');
    assert.match(r.data.qr, /^data:image\/png;base64,/);
    assert.equal(payments[0].billingType, 'PIX');
    assert.equal(payments[0].value, 80);
    assert.equal(payments[0].customer, 'cus_1');
    assert.equal(payments[0].externalReference, `comanda:${r.data.id}`);
    assert.equal(get<{ cpf: string }>('SELECT cpf FROM customers WHERE id = ?', [ana])!.cpf, '52998224725', 'o CPF fica na ficha');
    assert.deepEqual({ sales: sales(), cash: cashIn(), stock: pomadas() }, before, 'conferir a venda não grava nada');
    assert.equal((await owner('GET', `/api/shop/finance/pix-checkout/${r.data.id}`)).data.status, 'pending');
  });

  test('o Asaas avisa que caiu: a venda é registrada uma vez só, com estoque e caixa', async () => {
    const id = get<{ id: number }>("SELECT id FROM pix_checkouts WHERE status = 'pending'")!.id;
    const before = { sales: sales(), cash: cashIn(), stock: pomadas() };
    assert.equal((await paid('pay_1', `comanda:${id}`, 'PAYMENT_CONFIRMED')).status, 200);
    assert.equal((await paid('pay_1', `comanda:${id}`)).status, 200, 'o segundo aviso não registra de novo');
    assert.equal(sales(), before.sales + 1);
    assert.equal(cashIn(), before.cash + 8000);
    assert.equal(pomadas(), before.stock - 1);
    const v = (await owner('GET', `/api/shop/finance/pix-checkout/${id}`)).data;
    assert.equal(v.status, 'paid');
    assert.equal(v.payload, null, 'o QR some depois de pago');
    assert.equal(v.sale.total_cents, 8000);
    const sale = get<{ method: string; customer_id: number; discount_cents: number }>('SELECT method, customer_id, discount_cents FROM sales WHERE id = ?', [v.sale.id])!;
    assert.deepEqual(sale, { method: 'pix', customer_id: ana, discount_cents: 1000 });
    assert.equal((await owner('DELETE', `/api/shop/finance/pix-checkout/${id}`)).status, 409, 'pago não cancela');
  });

  test('cliente de balcão: o CPF de quem paga basta, sem cadastro', async () => {
    const r = await owner('POST', '/api/shop/finance/pix-checkout', { items: [{ catalog_item_id: corte, qty: 1 }] });
    assert.deepEqual(r.data, { needsCpf: true });
    assert.equal((await owner('POST', '/api/shop/finance/pix-checkout', { items: [{ catalog_item_id: corte, qty: 1 }], payer_cpf: '111.111.111-11' })).status, 400);
    const ok = await owner('POST', '/api/shop/finance/pix-checkout', { items: [{ catalog_item_id: corte, qty: 1 }], payer_cpf: '529.982.247-25' });
    assert.equal(ok.status, 201);
    assert.deepEqual(customers.at(-1), { name: 'Cliente do balcão', cpfCnpj: '52998224725', notificationDisabled: true });
    // O aviso sem a referência (só o id da cobrança) também acha a comanda.
    const before = sales();
    await paid(`pay_${payments.length}`, '');
    assert.equal(sales(), before + 1);
    assert.equal((await owner('GET', `/api/shop/finance/pix-checkout/${ok.data.id}`)).data.status, 'paid');
  });

  test('cancelar tira a cobrança do Asaas; se pagarem mesmo assim, o valor entra no caixa para conferir', async () => {
    const r = await owner('POST', '/api/shop/finance/pix-checkout', comanda);
    assert.equal(r.status, 201);
    const paymentId = `pay_${payments.length}`;
    const c = await owner('DELETE', `/api/shop/finance/pix-checkout/${r.data.id}`);
    assert.equal(c.data.status, 'cancelled');
    assert.deepEqual(deleted, [paymentId]);
    const before = { sales: sales(), cash: cashIn() };
    await paid(paymentId, `comanda:${r.data.id}`);
    assert.equal(sales(), before.sales, 'não vira venda (a comanda pode ter sido fechada de outro jeito)');
    assert.equal(cashIn(), before.cash + 9000);
    const entry = get<{ description: string }>('SELECT description FROM cash_entries WHERE barbershop_id = ? ORDER BY id DESC LIMIT 1', [shopId])!;
    assert.match(entry.description, new RegExp(`PIX da comanda #${r.data.id} \\(conferir`));
  });

  test('vale-presente que paga tudo: não tem PIX a gerar', async () => {
    const card = await owner('POST', '/api/shop/gift-cards', { amount_cents: 5000, buyer_name: 'Pedro', recipient_name: 'Ana', method: 'dinheiro' });
    assert.equal(card.status, 201, JSON.stringify(card.data));
    const r = await owner('POST', '/api/shop/finance/pix-checkout', { customer_id: ana, items: [{ catalog_item_id: corte, qty: 1 }], gift_code: card.data.card.code, gift_cents: 5000 });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Não sobra nada/);
  });

  test('a recepção também gera e acompanha o PIX', async () => {
    await owner('POST', '/api/shop/reception', { name: 'Bruna', phone: '11966665555', password: 'recepcao-123' });
    await desk('POST', '/api/auth/login', { login: '11966665555', password: 'recepcao-123' });
    assert.equal((await desk('GET', '/api/shop/finance/checkout')).data.pixAuto, true);
    const r = await desk('POST', '/api/shop/finance/pix-checkout', comanda);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await desk('GET', `/api/shop/finance/pix-checkout/${r.data.id}`)).status, 200);
    assert.equal((await desk('DELETE', `/api/shop/finance/pix-checkout/${r.data.id}`)).status, 200);
  });

  test('outra barbearia não vê o PIX', async () => {
    const id = all<{ id: number }>('SELECT id FROM pix_checkouts')[0].id;
    const other = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('outra', 'Outra', 'Zé', ?)", [nowIso()]).lastInsertRowid;
    run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Rita', 'rita@outra.com', ?, ?, ?)", [
      other,
      hashPassword('senha-forte-2'),
      nowIso(),
      nowIso(),
    ]);
    const rita = makeClient(() => base);
    await rita('POST', '/api/auth/login', { login: 'rita@outra.com', password: 'senha-forte-2' });
    assert.equal((await rita('GET', `/api/shop/finance/pix-checkout/${id}`)).status, 404);
  });
});
