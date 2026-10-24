import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-online-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { asaasHttp } = await import('../asaas.js');
const { book } = await import('../scheduling.js');
const { depositMessage, expireDeposits, requireDeposit } = await import('../deposits.js');
const { sendClubCharge } = await import('../club.js');
const { sweepStaleOnlinePayments } = await import('../onlinePayments.js');
const { shopBot } = await import('../messaging.js');
const { localNow } = await import('../time.js');

// ---------- Asaas de mentira (API v3): guarda os pedidos e responde.
const calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
let customers = 0;
let payments = 0;
asaasHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/customers') && method === 'POST') return json({ id: `cus_${++customers}` });
  if (url.endsWith('/payments') && method === 'POST') {
    payments++;
    return json({ id: `pay_${payments}`, status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${payments}` });
  }
  if (/\/payments\/pay_\d+$/.test(url) && method === 'DELETE') return json({ deleted: true });
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
const at = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);
const WALLET = '48548710-9baa-4ec1-a11f-9010193527c6';

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
run("INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', ?, ?)", [hashPassword('senha-forte-1'), nowIso()]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '06:00', '23:30')", [paulo, d]);
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, name, phone, nowIso(), nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const ana = customer('Ana Lima', '11988880000');
const bruno = customer('Bruno Costa', '11977770000');

async function enter(phone: string) {
  const c = makeClient(() => base);
  const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone });
  await c('POST', '/api/public/shops/navalha/login/verify', { phone, code: asked.data.demoCode });
  return c;
}

async function paid(paymentId: string, extra: Record<string, unknown> = {}, event = 'PAYMENT_CONFIRMED') {
  const token = (await master('GET', '/api/master/asaas')).data.webhookToken;
  return webhook('POST', '/api/webhooks/asaas', { event, payment: { id: paymentId, status: event === 'PAYMENT_RECEIVED' ? 'RECEIVED' : 'CONFIRMED', ...extra } }, { 'asaas-access-token': token });
}

const paymentCall = (n: number) => calls.filter((c) => c.url.endsWith('/payments') && c.method === 'POST')[n - 1];
let clubCharge = 0;

describe('pagamento online dos clientes (cartão), com repasse para a barbearia', () => {
  test('o master libera os pagamentos online com a taxa da plataforma; a barbearia liga com a carteira dela', async () => {
    const nfse = { enabled: false, serviceName: '', serviceCode: '', iss: 0, observations: '' };
    const saved = await master('PUT', '/api/master/asaas', { env: 'sandbox', apiKey: 'chave-de-teste', nfse, online: { enabled: true, feePct: 5 } });
    assert.deepEqual(saved.data.online, { enabled: true, feePct: 5 });

    assert.equal((await owner('GET', '/api/shop/online')).data.status.available, false);
    assert.equal((await owner('PUT', '/api/shop/online', { enabled: true, walletId: 'errada' })).status, 400);
    assert.equal((await owner('PUT', '/api/shop/online', { enabled: true, walletId: '' })).status, 400, 'ligar sem carteira');
    const step = async () => (await owner('GET', '/api/shop/summary')).data.setup.find((s: { id: string }) => s.id === 'cartao');
    assert.deepEqual(await step(), { id: 'cartao', label: 'Aceite cartão: informe a carteira (Wallet ID) da sua conta Asaas', done: false, link: '/painel/clube', optional: true });
    const ok = await owner('PUT', '/api/shop/online', { enabled: true, walletId: WALLET });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data.status, { available: true, platform: true, feePct: 5, reason: null });
    assert.equal((await step()).done, true, 'primeiros passos: cartão pronto');
  });

  test('mensalidade do clube no cartão: o CPF vai só para o Asaas e o dinheiro é repassado para a barbearia', async () => {
    const plan = await owner('POST', '/api/shop/club/plans', { name: 'Ouro', price_cents: 9990, uses_per_month: null, item_ids: [corte] });
    const c = await enter('11999990000');
    const sub = (await c('POST', '/api/customer/navalha/club/subscribe', { plan_id: plan.data.id })).data;
    assert.equal(sub.online, true);
    assert.equal(sub.needsCpf, true);
    clubCharge = sub.charge.id;

    const url = `/api/customer/navalha/charges/${clubCharge}/pay-online`;
    assert.match((await c('POST', url, {})).data.error, /CPF/);
    assert.equal((await c('POST', url, { cpf: '111.111.111-11' })).status, 400, 'CPF inválido');
    const r = await c('POST', url, { cpf: '529.982.247-25' });
    assert.equal(r.status, 200);
    assert.equal(r.data.url, 'https://sandbox.asaas.com/i/1');

    const created = calls.find((x) => x.url.endsWith('/customers'))!;
    assert.deepEqual(created.body, { name: 'João Pereira', cpfCnpj: '52998224725', mobilePhone: '11999990000', externalReference: `cliente:${joao}`, notificationDisabled: true });
    assert.deepEqual(paymentCall(1).body, {
      customer: 'cus_1',
      billingType: 'UNDEFINED',
      value: 99.9,
      dueDate: today,
      description: `Navalha de Ouro: ${sub.charge.description}`,
      externalReference: `cobranca:${clubCharge}`,
      split: [{ walletId: WALLET, percentualValue: 95 }],
    });
    const row = get<Record<string, unknown>>('SELECT * FROM customers WHERE id = ?', [joao])!;
    assert.equal(row.asaas_customer_id, 'cus_1');
    assert.ok(!JSON.stringify(row).includes('52998224725'), 'o CPF não fica no sistema');

    assert.equal((await c('POST', url, {})).data.url, 'https://sandbox.asaas.com/i/1', 'pedir de novo devolve o mesmo link');
    assert.equal(calls.filter((x) => x.url.endsWith('/payments') && x.method === 'POST').length, 1);
    assert.equal((await c('GET', '/api/customer/navalha/club')).data.needsCpf, false);
  });

  test('o Asaas avisa: a mensalidade é confirmada sozinha, com as taxas no caixa; o aviso repetido não duplica', async () => {
    assert.equal((await paid('pay_1', { billingType: 'CREDIT_CARD', value: 99.9, netValue: 96.9, confirmedDate: today })).status, 200);
    const ch = get<{ status: string; method: string }>('SELECT status, method FROM charges WHERE id = ?', [clubCharge])!;
    assert.deepEqual(ch, { status: 'paid', method: 'credito' });
    assert.equal(get<{ status: string }>('SELECT status FROM club_members WHERE customer_id = ?', [joao])!.status, 'active');
    const entries = () => all<{ type: string; category: string; amount_cents: number; method: string | null }>(
      'SELECT type, category, amount_cents, method FROM cash_entries WHERE charge_id = ? ORDER BY id',
      [clubCharge],
    );
    // 99,90 pagos; o Asaas fica com 3,00; dos 96,90, 95% (92,06) vão para a barbearia: 7,84 de taxas.
    assert.deepEqual(entries(), [
      { type: 'in', category: 'Clube de assinatura', amount_cents: 9990, method: 'credito' },
      { type: 'out', category: 'Impostos e taxas', amount_cents: 784, method: null },
    ]);
    await paid('pay_1', { billingType: 'CREDIT_CARD', value: 99.9, netValue: 96.9 }, 'PAYMENT_RECEIVED');
    assert.equal(entries().length, 2, 'confirmado e recebido: baixa uma vez só');
    const undo = await owner('POST', `/api/shop/charges/${clubCharge}/undo`);
    assert.equal(undo.status, 409, 'pago online não se desfaz no painel');
  });

  test('sinal no cartão (só cartão); pago depois de a vaga ser liberada, vira crédito', async () => {
    await owner('PUT', '/api/shop/deposits/settings', { deposit_mode: 'all', deposit_cents: 2000, deposit_hold_min: 60, deposit_credit_hours: 24 });
    const now = at('2026-11-10', '09:00');
    const a = book({ shopId, customerId: ana, barberId: paulo, serviceId: corte, date: '2026-11-10', time: '15:00', source: 'cliente', now });
    const dep = requireDeposit(shopId, a.id, now)!;
    const c = await enter('11988880000');
    const detail = (await c('GET', `/api/customer/navalha/deposits/${dep.id}`)).data;
    assert.equal(detail.online, true);
    const r = await c('POST', `/api/customer/navalha/charges/${dep.id}/pay-online`, { cpf: '529.982.247-25' });
    assert.equal(r.status, 200);
    assert.equal(paymentCall(2).body!.billingType, 'CREDIT_CARD');

    // Não pagou a tempo: a vaga é liberada... e o cartão é aprovado depois.
    assert.equal(await expireDeposits(shopBot(shopId), at('2026-11-10', '10:01')), 1);
    await paid('pay_2', { billingType: 'CREDIT_CARD', value: 20, netValue: 19.01 });
    const credit = get<{ status: string; appointment_id: number | null }>('SELECT status, appointment_id FROM charges WHERE id = ?', [dep.id])!;
    assert.deepEqual(credit, { status: 'paid', appointment_id: null }, 'crédito para o próximo horário');
  });

  test('pago de dois jeitos fica marcado para devolver; link de cobrança que não vale mais é apagado no Asaas', async () => {
    // Nova mensalidade do clube: o João gera o link do cartão, mas paga no PIX direto e o dono confirma.
    const next = run(
      "INSERT INTO charges (barbershop_id, customer_id, kind, description, amount_cents, club_member_id, period_start, period_end, due_date, created_at) SELECT barbershop_id, customer_id, 'clube', 'Clube Ouro · mês seguinte', 9990, club_member_id, '2030-01-01', '2030-01-31', ?, ? FROM charges WHERE id = ?",
      [today, nowIso(), clubCharge],
    ).lastInsertRowid;
    const c = await enter('11999990000');
    await c('POST', `/api/customer/navalha/charges/${next}/pay-online`, {});
    await owner('POST', `/api/shop/charges/${next}/confirm`, { method: 'pix' });
    assert.equal(await sweepStaleOnlinePayments(), 1);
    assert.ok(calls.some((x) => x.method === 'DELETE' && x.url.endsWith('/payments/pay_3')));
    // O aviso do cartão chega mesmo assim (pagou antes de o link sumir).
    await paid('pay_3', { billingType: 'CREDIT_CARD', value: 99.9, netValue: 96.9 });
    const online = (await owner('GET', '/api/shop/online')).data.payments;
    const dup = online.find((p: { charge_id: number }) => p.charge_id === next);
    assert.equal(dup.duplicate, 1);
    assert.equal(dup.customer, 'João Pereira', 'o dono vê o cliente dele');
  });

  test('o master vê os pagamentos online (barbearia, tipo, forma, valores e repasse), sem o nome dos clientes', async () => {
    const r = (await master('GET', `/api/master/payments?from=${today}&to=${today}`)).data;
    const club = r.items.find((i: { kind: string; status: string }) => i.kind === 'clube' && i.status === 'RECEIVED');
    assert.equal(club.shop, 'Navalha de Ouro');
    assert.equal(club.method, 'CREDIT_CARD');
    assert.equal(club.value_cents, 9990);
    assert.equal(club.net, 9690);
    assert.equal(club.toShop, 9206, 'repassado para a barbearia');
    assert.equal(club.platform, 484, '5% de 96,90 fica com a plataforma');
    assert.ok(r.items.some((i: { kind: string }) => i.kind === 'sinal'));
    assert.ok(r.totals.processed >= 9990 + 2000);
    const text = JSON.stringify(r);
    assert.ok(!text.includes('João') && !text.includes('Ana'), 'sem nome de cliente');
    assert.equal((await master('GET', `/api/master/payments?kind=sinal&from=${today}&to=${today}`)).data.items.every((i: { kind: string }) => i.kind === 'sinal'), true);
  });
  test('estorno pelo Asaas: o repasse sai do caixa da barbearia (uma vez só) e o sinal deixa de ser crédito', async () => {
    await paid('pay_1', { status: 'REFUNDED', billingType: 'CREDIT_CARD', value: 99.9, netValue: 96.9 }, 'PAYMENT_REFUNDED');
    await paid('pay_1', { status: 'REFUNDED', billingType: 'CREDIT_CARD', value: 99.9, netValue: 96.9 }, 'PAYMENT_REFUNDED');
    const out = all<{ category: string; amount_cents: number }>(
      "SELECT category, amount_cents FROM cash_entries WHERE charge_id = ? AND description LIKE 'Estorno%'",
      [clubCharge],
    );
    assert.deepEqual(out, [{ category: 'Outras saídas', amount_cents: 9206 }]);
    const sinal = get<{ charge_id: number }>("SELECT charge_id FROM gateway_payments WHERE external_id = 'pay_2'")!.charge_id;
    await paid('pay_2', { status: 'REFUNDED', billingType: 'CREDIT_CARD', value: 20, netValue: 19.01 }, 'PAYMENT_REFUNDED');
    assert.ok(get<{ refunded_at: string | null }>('SELECT refunded_at FROM charges WHERE id = ?', [sinal])!.refunded_at, 'não vale mais como crédito');
    const listed = (await master('GET', `/api/master/payments?from=${today}&to=${today}&kind=clube`)).data.items;
    assert.ok(listed.some((i: { status: string }) => i.status === 'REFUNDED'));
  });

  test('no WhatsApp o link do cartão vai junto do PIX; sem chave PIX, o sinal é cobrado só no cartão', async () => {
    const open = run(
      "INSERT INTO charges (barbershop_id, customer_id, kind, description, amount_cents, club_member_id, period_start, period_end, due_date, created_at) SELECT barbershop_id, customer_id, 'clube', 'Clube Ouro · outro mês', 9990, club_member_id, '2030-02-01', '2030-02-28', '2030-02-01', ? FROM charges WHERE id = ?",
      [nowIso(), clubCharge],
    ).lastInsertRowid;
    assert.equal(await sendClubCharge(shopBot(shopId), open), true);
    const bodies = all<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? AND kind = 'assinatura' ORDER BY id", [joao]).map((m) => m.body);
    assert.ok(bodies.some((b) => /PIX copia e cola vai na próxima mensagem.*\nPrefere cartão\? Pague pela sua área: \S+\/b\/navalha\/conta\?t=/s.test(b)));

    run('UPDATE barbershops SET pix_key = NULL WHERE id = ?', [shopId]);
    try {
      const now = at('2026-11-12', '09:00');
      const a = book({ shopId, customerId: bruno, barberId: paulo, serviceId: corte, date: '2026-11-12', time: '16:00', source: 'whatsapp', now });
      const dep = requireDeposit(shopId, a.id, now);
      assert.ok(dep, 'cobra o sinal mesmo sem PIX');
      const msg = depositMessage(shopBot(shopId), dep);
      assert.equal(msg.payload, null);
      assert.match(msg.text, /sinal de R\$\s20,00 no cartão até as 10h, pela sua área: \S+\/b\/navalha\/conta\?t=/);
      // Sem PIX e com o cartão desligado: sem sinal.
      await owner('PUT', '/api/shop/online', { enabled: false, walletId: WALLET });
      const b = book({ shopId, customerId: bruno, barberId: paulo, serviceId: corte, date: '2026-11-13', time: '16:00', source: 'whatsapp', now });
      assert.equal(requireDeposit(shopId, b.id, now), null);
    } finally {
      run("UPDATE barbershops SET pix_key = 'pix@navalha.com.br' WHERE id = ?", [shopId]);
      await owner('PUT', '/api/shop/online', { enabled: true, walletId: WALLET });
    }
  });

  test('o master vê que os avisos do Asaas estão chegando', async () => {
    const a = (await master('GET', '/api/master/asaas')).data;
    assert.ok(a.webhookAt, 'último aviso registrado');
    const online = (await master('GET', '/api/master/readiness')).data.find((i: { id: string }) => i.id === 'online');
    assert.equal(online.done, false, 'ainda no ambiente de testes');
  });
});
