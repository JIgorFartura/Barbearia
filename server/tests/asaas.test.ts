import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-asaas-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { asaasHttp } = await import('../asaas.js');
const { accessStatus } = await import('../billing.js');
const { invoiceReminders } = await import('../invoiceReminders.js');
const { localNow, addDays } = await import('../time.js');

// ---------- Asaas de mentira: guarda os pedidos e responde como a API v3.
const calls: { method: string; url: string; body: Record<string, unknown> | undefined; key: string }[] = [];
let payments = 0;
asaasHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body, key: headers.access_token });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (headers.access_token !== 'chave-de-teste') return json({ errors: [{ code: 'invalid_access_token', description: 'A chave de API fornecida é inválida' }] }, 401);
  if (url.endsWith('/customers?limit=1')) return json({ object: 'list', data: [] });
  if (url.endsWith('/customers') && method === 'POST') return json({ id: 'cus_000001' });
  if (url.endsWith('/payments') && method === 'POST') {
    payments++;
    return json({ id: `pay_${payments}`, status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${payments}` });
  }
  if (/\/payments\/pay_\d+\/pixQrCode$/.test(url)) return json({ encodedImage: 'iVBORw0KGgo=', payload: '00020101021226820014br.gov.bcb.pix-asaas', expirationDate: '2027-01-01 23:59:59' });
  if (/\/payments\/pay_\d+\/receiveInCash$/.test(url)) return json({ id: 'pay_x', status: 'RECEIVED_IN_CASH' });
  if (/\/payments\/pay_\d+$/.test(url) && method === 'DELETE') return json({ deleted: true });
  if (url.endsWith('/invoices') && method === 'POST') return json({ id: 'inv_000001', status: 'SCHEDULED' });
  return json({ errors: [{ description: 'não encontrado' }] }, 404);
}) as typeof fetch;

let server: Server;
let base = '';
const master = makeClient(() => base);
const owner = makeClient(() => base);
const webhook = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

const today = localNow().date;
const shopId = run("INSERT INTO barbershops (slug, name, bot_name, monthly_price_cents, billing_day, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 14990, 10, ?)", [
  '2025-01-01T12:00:00.000Z',
]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos Lima', 'carlos@navalha.com', '11955550000', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
run("INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', ?, ?)", [hashPassword('senha-forte-1'), nowIso()]);
// Fatura vencida há 2 dias (a barbearia ainda está na carência).
const invoiceId = run("INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at) VALUES (?, '2026-10', 'Mensalidade outubro/2026', 14990, ?, ?)", [
  shopId,
  addDays(today, -2),
  nowIso(),
]).lastInsertRowid;

describe('mensalidade cobrada pelo Asaas', () => {
  test('o master configura: chave errada é recusada no teste; o token do webhook é gerado', async () => {
    const nfse = { enabled: true, serviceName: 'Licenciamento de programas de computador', serviceCode: '1.05', iss: 2, observations: '' };
    await master('PUT', '/api/master/asaas', { env: 'sandbox', apiKey: 'chave-errada', nfse });
    const bad = await master('POST', '/api/master/asaas/test');
    assert.equal(bad.status, 502);
    assert.match(bad.data.error, /chave de API fornecida é inválida/i);
    const saved = await master('PUT', '/api/master/asaas', { env: 'sandbox', apiKey: 'chave-de-teste', nfse });
    assert.equal(saved.data.keyHint, '••••este');
    assert.ok(saved.data.webhookToken.length >= 20);
    assert.match(saved.data.webhookUrl, /\/api\/webhooks\/asaas$/);
    assert.equal((await master('POST', '/api/master/asaas/test')).status, 200);
    assert.deepEqual(saved.data.shopsWithoutDocument, [{ id: shopId, name: 'Navalha de Ouro' }]);
    // Salvar sem mandar a chave mantém a atual.
    assert.equal((await master('PUT', '/api/master/asaas', { env: 'sandbox', apiKey: '', nfse })).data.keyHint, '••••este');
  });

  test('sem CPF/CNPJ, o dono é avisado; com o documento, a cobrança nasce no Asaas (PIX, cartão ou boleto)', async () => {
    const before = (await owner('GET', '/api/shop/subscription')).data;
    assert.equal(before.billing.needsDocument, true);
    assert.equal((await owner('PUT', '/api/shop/billing-info', { document: '111.111.111-11', name: 'Carlos Lima' })).status, 400, 'CPF inválido');
    const ok = await owner('PUT', '/api/shop/billing-info', { document: '11.222.333/0001-81', name: 'Navalha de Ouro Ltda', email: 'financeiro@navalha.com' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.billing_document, '11222333000181');

    const customer = calls.find((c) => c.url.endsWith('/customers') && c.method === 'POST')!;
    assert.deepEqual(customer.body, {
      name: 'Navalha de Ouro Ltda',
      cpfCnpj: '11222333000181',
      email: 'financeiro@navalha.com',
      mobilePhone: '11955550000',
      externalReference: `barbearia:${shopId}`,
      notificationDisabled: true,
    });
    const payment = calls.find((c) => c.url.endsWith('/payments') && c.method === 'POST')!;
    assert.deepEqual(payment.body, {
      customer: 'cus_000001',
      billingType: 'UNDEFINED',
      value: 149.9,
      dueDate: today,
      description: 'Mensalidade outubro/2026',
      externalReference: `fatura:${invoiceId}`,
    });
    assert.match(payment.url, /^https:\/\/api-sandbox\.asaas\.com\/v3\/payments$/);

    const sub = (await owner('GET', '/api/shop/subscription')).data;
    assert.equal(sub.current.pix.auto, true);
    assert.equal(sub.current.pix.payload, '00020101021226820014br.gov.bcb.pix-asaas');
    assert.equal(sub.current.pix.qr, 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(sub.current.payUrl, 'https://sandbox.asaas.com/i/1', 'página do Asaas: PIX, cartão ou boleto');
    assert.equal(calls.filter((c) => c.url.endsWith('/payments') && c.method === 'POST').length, 1, 'uma cobrança só');
  });

  test('o PIX caiu: o Asaas avisa, a fatura é baixada sozinha e a nota fiscal é pedida', async () => {
    const token = (await master('GET', '/api/master/asaas')).data.webhookToken;
    const event = { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', billingType: 'PIX', paymentDate: today, value: 149.9 } };
    assert.equal((await webhook('POST', '/api/webhooks/asaas', event)).status, 401, 'sem token');
    assert.equal((await webhook('POST', '/api/webhooks/asaas', event, { 'asaas-access-token': 'outro' })).status, 401);
    const r = await webhook('POST', '/api/webhooks/asaas', event, { 'asaas-access-token': token });
    assert.equal(r.status, 200);
    const inv = get<{ status: string; method: string; paid_at: string }>('SELECT status, method, paid_at FROM invoices WHERE id = ?', [invoiceId])!;
    assert.deepEqual(inv, { status: 'paid', method: 'pix', paid_at: today });
    assert.equal(accessStatus(shopId).open.length, 0);
    assert.deepEqual(get("SELECT category, amount_cents FROM cash_entries WHERE invoice_id = ?", [invoiceId]), { category: 'Mensalidade do sistema', amount_cents: 14990 });
    assert.deepEqual(get("SELECT status, method, applied, duplicate FROM gateway_payments WHERE external_id = 'pay_1'"), { status: 'RECEIVED', method: 'PIX', applied: 1, duplicate: 0 });

    await new Promise((resolve) => setTimeout(resolve, 30)); // a nota é pedida depois da resposta
    const nf = calls.find((c) => c.url.endsWith('/invoices') && c.method === 'POST')!;
    assert.equal(nf.body!.payment, 'pay_1');
    assert.equal(nf.body!.municipalServiceName, 'Licenciamento de programas de computador');
    assert.deepEqual(nf.body!.taxes, { retainIss: false, iss: 2, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 });

    // Aviso repetido não faz nada; nota autorizada guarda o link do PDF.
    assert.equal((await webhook('POST', '/api/webhooks/asaas', event, { 'asaas-access-token': token })).status, 200);
    await webhook(
      'POST',
      '/api/webhooks/asaas',
      { event: 'INVOICE_AUTHORIZED', invoice: { id: 'inv_000001', status: 'AUTHORIZED', pdfUrl: 'https://asaas.com/nf/1.pdf' } },
      { 'asaas-access-token': token },
    );
    const billing = (await owner('GET', '/api/shop/subscription')).data;
    assert.equal(billing.invoices[0].nfse_url, 'https://asaas.com/nf/1.pdf');
  });

  test('o master baixa à mão ou cancela: o Asaas acompanha', async () => {
    const mk = (ref: string) =>
      run("INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at) VALUES (?, ?, 'Avulsa', 5000, ?, ?)", [shopId, ref, addDays(today, 5), nowIso()])
        .lastInsertRowid;
    const paid = mk('avulsa-1');
    const cancelled = mk('avulsa-2');
    await owner('GET', '/api/shop/subscription'); // cria a cobrança da fatura em aberto mais antiga
    const { syncAsaasCharges } = await import('../asaas.js');
    await syncAsaasCharges();
    const payOf = (id: number) => get<{ asaas_payment_id: string }>('SELECT asaas_payment_id FROM invoices WHERE id = ?', [id])!.asaas_payment_id;
    assert.ok(payOf(paid) && payOf(cancelled));

    await master('POST', `/api/master/invoices/${paid}/pay`, { paid_at: today, method: 'dinheiro', notes: null });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(calls.some((c) => c.url.endsWith(`/payments/${payOf(paid)}/receiveInCash`)));
    // O Asaas confirma a baixa manual: não é pagamento em dobro (e não conta como pago pelo Asaas).
    const token = (await master('GET', '/api/master/asaas')).data.webhookToken;
    const echo = (event: string, status: string, billingType: string) =>
      webhook('POST', '/api/webhooks/asaas', { event, payment: { id: payOf(paid), status, billingType, value: 50 } }, { 'asaas-access-token': token });
    await echo('PAYMENT_RECEIVED', 'RECEIVED_IN_CASH', 'UNDEFINED');
    const row = () => get<{ status: string; duplicate: number }>('SELECT status, duplicate FROM gateway_payments WHERE external_id = ?', [payOf(paid)]);
    assert.deepEqual(row(), { status: 'RECEIVED_IN_CASH', duplicate: 0 });
    // Se a barbearia pagar com cartão mesmo assim (a baixa não chegou ao Asaas), fica marcado para devolver.
    await echo('PAYMENT_CONFIRMED', 'CONFIRMED', 'CREDIT_CARD');
    assert.deepEqual(row(), { status: 'CONFIRMED', duplicate: 1 });
    await master('POST', `/api/master/invoices/${cancelled}/cancel`);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/payments/${payOf(cancelled)}`)));
  });

  test('lembrete da mensalidade no WhatsApp da plataforma: antes de vencer e depois de vencida, uma vez cada', async () => {
    const due = run("INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at) VALUES (?, '2026-11', 'Mensalidade novembro/2026', 14990, '2026-11-10', ?)", [
      shopId,
      nowIso(),
    ]).lastInsertRowid;
    const at = (d: string, t: string) => new Date(`${d}T${t}:00-03:00`);
    assert.equal(await invoiceReminders(at('2026-11-06', '10:00')), 0, 'cedo demais');
    assert.equal(await invoiceReminders(at('2026-11-07', '07:00')), 0, 'fora do horário');
    assert.equal(await invoiceReminders(at('2026-11-07', '10:00')), 1);
    assert.equal(await invoiceReminders(at('2026-11-08', '10:00')), 0, 'uma vez');
    assert.equal(await invoiceReminders(at('2026-11-11', '10:00')), 1, 'vencida');
    const msgs = all<{ body: string }>("SELECT body FROM platform_messages WHERE kind = 'fatura' ORDER BY id", []);
    assert.match(msgs[0].body, /Olá, Carlos! A mensalidade do sistema da Navalha de Ouro \(R\$\s149,90\) vence em 10\/11\. Pague pelo PIX da tela Mensalidade/);
    assert.match(msgs[1].body, /venceu em 10\/11\. Para não ter o acesso restrito a partir de 16\/11/);
    run("UPDATE invoices SET status = 'cancelled' WHERE id = ?", [due]);
  });
});
