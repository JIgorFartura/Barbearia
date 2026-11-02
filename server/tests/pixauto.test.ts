import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-pixauto-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { asaasHttp } = await import('../asaas.js');
const { savePlan, subscribe, clubBilling } = await import('../club.js');
const { shopBot } = await import('../messaging.js');
const { normalizeCpf } = await import('../shopAsaas.js');
const { addDays } = await import('../time.js');

// Asaas de mentira: a conta da barbearia (chave "chave-da-barbearia").
const calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
let payments = 0;
asaasHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (headers.access_token !== 'chave-da-barbearia') return json({ errors: [{ description: 'A chave de API fornecida é inválida' }] }, 401);
  if (url.endsWith('/customers?limit=1')) return json({ data: [] });
  if (url.endsWith('/customers') && method === 'POST') return json({ id: 'cus_joao' });
  if (url.endsWith('/payments') && method === 'POST') return json({ id: `pay_${++payments}`, status: 'PENDING' });
  if (/\/payments\/pay_\d+\/pixQrCode$/.test(url)) return json({ encodedImage: 'iVBORw0KGgo=', payload: '00020101021226-pix-asaas-da-barbearia' });
  if (/\/payments\/pay_\d+$/.test(url) && method === 'DELETE') return json({ deleted: true });
  if (url.endsWith('/pix/automatic/authorizations') && method === 'POST')
    return json({ id: 'aut_1', status: 'CREATED', immediateQrCode: { payload: '00020101-pix-automatico-1o-pagamento', encodedImage: 'iVBORw0KGgo=' } });
  if (/\/pix\/automatic\/authorizations\/aut_1$/.test(url) && method === 'DELETE') return json({ id: 'aut_1', status: 'CANCELLED' });
  return json({ errors: [{ description: 'não encontrado' }] }, 404);
}) as typeof fetch;

let server: Server;
let base = '';
const owner = makeClient(() => base);
const joao = makeClient(() => base);
const hook = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  const asked = await joao('POST', '/api/public/shops/navalha/login/code', { phone: '11999990000' });
  await joao('POST', '/api/public/shops/navalha/login/verify', { phone: '11999990000', code: asked.data.demoCode });
});
after(() => server.close());

const shopId = run(
  "INSERT INTO barbershops (slug, name, bot_name, pix_key, pix_name, pix_city, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'pix@navalha.com.br', 'Navalha', 'Sao Paulo', ?)",
  [nowIso()],
).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const joaoId = run("INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, 'João Pereira', '11999990000', ?, ?)", [
  shopId,
  nowIso(),
  nowIso(),
]).lastInsertRowid;
const plan = savePlan(shopId, null, { name: 'Clube Ouro', description: null, price_cents: 9990, uses_per_month: 4, active: true, item_ids: [corte] });

let token = '';
const event = (body: object, headerToken = token, urlToken = token) =>
  hook('POST', `/api/webhooks/asaas/barbearia/${urlToken}`, body, { 'asaas-access-token': headerToken });
const charges = () => get<{ id: number; status: string; asaas_payment_id: string | null; auto_debit: number }>(
  'SELECT id, status, asaas_payment_id, auto_debit FROM charges WHERE customer_id = ? ORDER BY id DESC LIMIT 1',
  [joaoId],
)!;
const member = () => get<{ id: number; status: string; paid_until: string | null; pix_auto_status: string | null }>(
  'SELECT id, status, paid_until, pix_auto_status FROM club_members WHERE customer_id = ?',
  [joaoId],
)!;

describe('PIX do clube com baixa automática (Asaas da barbearia)', () => {
  test('CPF conferido pelos dígitos', () => {
    assert.equal(normalizeCpf('529.982.247-25'), '52998224725');
    assert.equal(normalizeCpf('529.982.247-26'), null);
    assert.equal(normalizeCpf('111.111.111-11'), null);
  });

  test('o dono liga a conta Asaas dele e recebe o endereço do aviso', async () => {
    assert.equal((await owner('PUT', '/api/shop/asaas', { env: 'sandbox', apiKey: 'chave-errada', pixAuto: true })).status, 200);
    assert.equal((await owner('POST', '/api/shop/asaas/test')).status, 502, 'chave recusada pelo Asaas');
    const r = await owner('PUT', '/api/shop/asaas', { env: 'sandbox', apiKey: 'chave-da-barbearia', pixAuto: true });
    assert.equal(r.data.connected, true);
    assert.equal(r.data.pixAuto, true);
    token = r.data.webhookToken;
    assert.match(r.data.webhookUrl, new RegExp(`/api/webhooks/asaas/barbearia/${token}$`));
    assert.equal((await owner('POST', '/api/shop/asaas/test')).status, 200);
    assert.equal(JSON.stringify((await owner('GET', '/api/shop/asaas')).data).includes('chave-da-barbearia'), false, 'a chave não volta para a tela');
  });

  test('sem CPF: o PIX da chave (conferido à mão) e o pedido do CPF; com CPF: o PIX do Asaas', async () => {
    subscribe(shopId, joaoId, plan.id);
    let club = (await joao('GET', '/api/customer/navalha/club')).data;
    assert.equal(club.charge.pix.needsCpf, true);
    assert.equal(club.charge.pix.auto, false);
    assert.ok(club.charge.pix.payload, 'enquanto isso, o PIX da chave da barbearia');
    assert.equal((await joao('PUT', '/api/customer/navalha/cpf', { cpf: '123.456.789-00' })).status, 400);
    club = (await joao('PUT', '/api/customer/navalha/cpf', { cpf: '529.982.247-25' })).data;
    assert.equal(club.charge.pix.auto, true);
    assert.equal(club.charge.pix.payload, '00020101021226-pix-asaas-da-barbearia');
    const created = calls.find((c) => c.url.endsWith('/customers') && c.method === 'POST')!;
    assert.equal(created.body!.cpfCnpj, '52998224725');
    const pay = calls.find((c) => c.url.endsWith('/payments') && c.method === 'POST')!;
    assert.equal(pay.body!.billingType, 'PIX');
    assert.equal(pay.body!.value, 99.9);
    assert.equal(pay.body!.externalReference, `clube:${charges().id}`);
    // Pedir de novo não cria outra cobrança no Asaas.
    await joao('GET', '/api/customer/navalha/club');
    assert.equal(calls.filter((c) => c.url.endsWith('/payments') && c.method === 'POST').length, 1);
  });

  test('o aviso do Asaas baixa a mensalidade sozinho (e só com o segredo certo)', async () => {
    const pay = { event: 'PAYMENT_RECEIVED', payment: { id: charges().asaas_payment_id, status: 'RECEIVED', billingType: 'PIX', value: 99.9, externalReference: `clube:${charges().id}` } };
    assert.equal((await event(pay, 'errado')).status, 401);
    assert.equal((await event(pay, token, 'outra-url')).status, 401);
    const r = await event(pay);
    assert.equal(r.status, 200);
    assert.equal(charges().status, 'paid');
    assert.equal(member().status, 'active');
    assert.ok(get("SELECT 1 AS ok FROM cash_entries WHERE barbershop_id = ? AND category = 'Clube de assinatura' AND amount_cents = 9990", [shopId]));
    assert.equal((await event(pay)).data.note, 'já baixada', 'aviso repetido não paga duas vezes');
    for (let i = 0; i < 50 && !get("SELECT 1 AS ok FROM messages WHERE customer_id = ? AND body LIKE 'Recebemos o pagamento do clube%'", [joaoId]); i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    assert.ok(get("SELECT 1 AS ok FROM messages WHERE customer_id = ? AND body LIKE 'Recebemos o pagamento do clube%'", [joaoId]), 'o cliente recebe a confirmação');
    assert.ok(get('SELECT asaas_shop_webhook_at FROM barbershops WHERE id = ?', [shopId]));
  });
});

describe('clube no Pix Automático', () => {
  test('o cliente liga o débito automático pagando o 1º mês; a ativação baixa essa mensalidade', async () => {
    // Mensalidade seguinte em aberto (o mês pago está acabando).
    const until = member().paid_until!;
    await clubBilling(shopBot(shopId), new Date(`${addDays(until, -2)}T12:00:00-03:00`));
    const open = charges();
    assert.equal(open.status, 'open');
    const r = await joao('POST', '/api/customer/navalha/club/pix-auto');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.pixAutoStart.payload, '00020101-pix-automatico-1o-pagamento');
    const auth = calls.find((c) => c.url.endsWith('/pix/automatic/authorizations'))!;
    assert.equal(auth.body!.customerId, 'cus_joao');
    assert.equal(auth.body!.frequency, 'MONTHLY');
    assert.ok(String(auth.body!.contractId).length <= 35);
    assert.equal(auth.body!.value, 99.9);
    assert.deepEqual(Object.keys(auth.body!.immediateQrCode as object).sort(), ['description', 'expirationSeconds', 'originalValue']);
    assert.equal(member().pix_auto_status, 'CREATED');

    assert.equal((await event({ event: 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', pixAutomaticAuthorization: { id: 'aut_1', status: 'ACTIVE' } })).status, 200);
    assert.equal(member().pix_auto_status, 'ACTIVE');
    assert.equal(get<{ status: string }>('SELECT status FROM charges WHERE id = ?', [open.id])!.status, 'paid', 'o 1º pagamento (que autorizou) pagou o mês');
    assert.equal((await joao('GET', '/api/customer/navalha/club')).data.member.pixAuto, 'ACTIVE');
  });

  test('os meses seguintes vão para o débito automático uns dias antes, sem PIX pelo WhatsApp', async () => {
    const until = member().paid_until!;
    const before = calls.length;
    await clubBilling(shopBot(shopId), new Date(`${addDays(until, -7)}T12:00:00-03:00`));
    const next = charges();
    assert.equal(next.auto_debit, 1);
    const pay = calls.slice(before).find((c) => c.url.endsWith('/payments') && c.method === 'POST')!;
    assert.equal(pay.body!.pixAutomaticAuthorizationId, 'aut_1');
    assert.equal(pay.body!.dueDate, addDays(until, 1));
    const msg = get<{ body: string }>('SELECT body FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [joaoId])!;
    assert.match(msg.body, /debitada sozinha pelo Pix Automático/);
    // No vencimento o banco debita e o Asaas avisa.
    await event({ event: 'PAYMENT_RECEIVED', payment: { id: next.asaas_payment_id, status: 'RECEIVED', billingType: 'PIX', externalReference: `clube:${next.id}` } });
    assert.equal(charges().status, 'paid');
  });

  test('desligar cancela a autorização no Asaas', async () => {
    const r = await joao('DELETE', '/api/customer/navalha/club/pix-auto');
    assert.equal(r.status, 200);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/pix/automatic/authorizations/aut_1')));
    assert.equal(member().pix_auto_status, 'CANCELLED');
  });
});
