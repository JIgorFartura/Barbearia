import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-anual-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { asaasHttp } = await import('../asaas.js');
const { ensureInvoices, installmentOptions, platformRevenue } = await import('../billing.js');
const { localNow } = await import('../time.js');

// Asaas de mentira: clientes, cobranças (à vista ou parceladas), PIX e exclusão.
const posted: Record<string, unknown>[] = [];
const deleted: string[] = [];
asaasHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/customers?limit=1')) return json({ object: 'list', data: [] });
  if (url.endsWith('/customers') && method === 'POST') return json({ id: 'cus_1' });
  if (url.endsWith('/payments') && method === 'POST') {
    posted.push(body);
    const n = posted.length;
    return json({ id: `pay_${n}`, invoiceUrl: `https://sandbox.asaas.com/i/${n}`, installment: body.installmentCount ? `ins_${n}` : null });
  }
  if (/\/payments\/pay_\d+\/pixQrCode$/.test(url)) return json({ encodedImage: 'iVBORw0KGgo=', payload: '000201-pix-asaas' });
  const del = /\/(payments|installments)\/(\w+)$/.exec(url);
  if (del && method === 'DELETE') {
    deleted.push(del[2]);
    return json({ deleted: true });
  }
  return json({ errors: [{ description: 'não encontrado' }] }, 404);
}) as typeof fetch;

let server: Server;
let base = '';
const master = makeClient(() => base);
const owner = makeClient(() => base);
const asaas = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

run("INSERT INTO users (role, name, email, password_hash, terms_accepted_at, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', ?, ?, ?)", [
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const today = localNow().date;
const month = today.slice(0, 7);
// Plano Equipe (R$ 99,90), vence no último dia do mês (a mensalidade do mês ainda não venceu).
const equipe = get<{ id: number }>("SELECT id FROM plans WHERE name = 'Equipe'")!.id;
const shopId = run("INSERT INTO barbershops (slug, name, bot_name, plan_id, billing_day, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?, 31, ?)", [
  equipe,
  '2025-01-01T12:00:00.000Z',
]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const invoices = () => get<{ list: string }>("SELECT group_concat(reference || '=' || status || '=' || amount_cents, ' ') AS list FROM invoices WHERE barbershop_id = ?", [shopId])!.list;

describe('plano anual', () => {
  test('parcelas: sem juros até 2x; de 3x em diante, os juros vão para quem parcela', () => {
    const o = installmentOptions(83916);
    assert.deepEqual(o[0], { n: 1, each_cents: 83916, total_cents: 83916, interest: false });
    assert.deepEqual(o[1], { n: 2, each_cents: 41958, total_cents: 83916, interest: false });
    assert.equal(o[2].interest, true);
    assert.ok(o[2].total_cents > 83916, 'com juros a partir de 3x');
    // 12x a 2,99% ao mês (tabela Price): parcela de R$ 84,26 (total R$ 1.011,12).
    assert.equal(o[11].each_cents, 8426);
    assert.equal(o[11].total_cents, 101112);
    assert.equal(o.length, 12);
  });

  test('o dono vê a oferta e passa para o anual: a mensalidade do mês vira a fatura anual com 30% de desconto', async () => {
    ensureInvoices();
    assert.equal(invoices(), `${month}=open=9990`);
    await master('PUT', '/api/master/asaas', {
      env: 'sandbox',
      apiKey: 'chave-de-teste',
      nfse: { enabled: false, serviceName: '', serviceCode: '', iss: 0, observations: '' },
    });
    await owner('PUT', '/api/shop/billing-info', { document: '11.222.333/0001-81', name: 'Navalha de Ouro Ltda' });
    const sub = (await owner('GET', '/api/shop/subscription')).data;
    // 12 × R$ 99,90 = R$ 1.198,80; com 30% de desconto, R$ 839,16 (R$ 69,93 por mês).
    // Os quatro períodos sobre R$ 99,90: 10%, 20% e 30% de desconto; implantação grátis a partir do semestral.
    assert.deepEqual(
      sub.periods.map((p: { cycle: string; price_cents: number; per_month_cents: number; discount_pct: number; setup_free: boolean }) => [
        p.cycle,
        p.price_cents,
        p.per_month_cents,
        p.discount_pct,
        p.setup_free,
      ]),
      [
        ['mensal', 9990, 9990, 0, false],
        ['trimestral', 26973, 8991, 10, false],
        ['semestral', 47952, 7992, 20, true],
        ['anual', 83916, 6993, 30, true],
      ],
    );
    assert.deepEqual(sub.card_options, [], 'parcelar é só no anual');

    assert.equal((await owner('POST', '/api/shop/subscription/period', { cycle: 'anual' })).status, 200);
    assert.equal(invoices(), `${month}=cancelled=9990 anual:${month}=open=83916`);
    assert.ok(deleted.includes('pay_1'), 'a cobrança da mensalidade saiu do Asaas');
    assert.equal(ensureInvoices(), 0, 'nada de mensalidade enquanto o anual cobre o mês');
    assert.equal(platformRevenue().mrr, 6993);
  });

  test('o anual sai no Asaas com boleto/PIX; o cartão parcelado troca a cobrança e cobra os juros de quem parcela', async () => {
    let sub = (await owner('GET', '/api/shop/subscription')).data;
    assert.match(sub.current.description, /^Plano anual /);
    assert.equal(posted.at(-1)!.billingType, 'UNDEFINED', 'PIX, boleto ou cartão à vista na página do Asaas');
    assert.equal(sub.card_options.length, 12);
    assert.ok(sub.current.pix);

    assert.equal((await owner('POST', `/api/shop/subscription/${sub.current.id}/card`, { installments: 13 })).status, 400);
    const r = await owner('POST', `/api/shop/subscription/${sub.current.id}/card`, { installments: 6 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const six = installmentOptions(83916)[5];
    assert.equal(r.data.total_cents, six.total_cents);
    const sent = posted.at(-1)!;
    assert.equal(sent.billingType, 'CREDIT_CARD');
    assert.equal(sent.installmentCount, 6);
    assert.equal(sent.totalValue, six.total_cents / 100);
    assert.match(String(sent.externalReference), /^fatura:\d+$/);
    assert.equal(r.data.url, `https://sandbox.asaas.com/i/${posted.length}`);
    assert.ok(deleted.includes('pay_2'), 'a cobrança de PIX/boleto saiu');

    sub = (await owner('GET', '/api/shop/subscription')).data;
    assert.equal(sub.installments, 6);
    assert.equal(sub.current.pix, null, 'no cartão não tem PIX');
    assert.equal(sub.current.amount_cents, 83916, 'a fatura continua com o valor dela');
  });

  test('qualquer parcela aprovada no cartão baixa a fatura anual', async () => {
    const token = (await master('GET', '/api/master/asaas')).data.webhookToken;
    const r = await asaas(
      'POST',
      '/api/webhooks/asaas',
      { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_x', installment: `ins_${posted.length}`, billingType: 'CREDIT_CARD', confirmedDate: today } },
      { 'asaas-access-token': token },
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const inv = get<{ status: string; method: string }>("SELECT status, method FROM invoices WHERE reference = ?", [`anual:${month}`])!;
    assert.deepEqual(inv, { status: 'paid', method: 'cartao' });
    assert.equal((await owner('GET', '/api/shop/subscription')).data.current, null);
  });

  test('o master volta para o mensal: o anual pago continua valendo até o fim do período', async () => {
    const shop = (await master('GET', '/api/master/shops')).data.find((s: { id: number }) => s.id === shopId);
    assert.equal(shop.billing_cycle, 'anual');
    const r = await master('PUT', `/api/master/shops/${shopId}/billing`, { plan_id: equipe, monthly_price_cents: null, billing_day: 31, billing_cycle: 'mensal' });
    assert.equal(r.status, 200);
    assert.equal(ensureInvoices(), 0, 'o mês está pago pelo anual');
    assert.match(invoices(), new RegExp(`anual:${month}=paid=83916`));
  });
});
