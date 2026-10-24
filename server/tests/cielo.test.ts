import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-cielo-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';
process.env.CIELO_BASE_URL = 'https://cielo.test';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { cieloHttp } = await import('../cielo.js');
const { book } = await import('../scheduling.js');
const { expireDeposits, requireDeposit } = await import('../deposits.js');
const { clubBilling, clubCoverage } = await import('../club.js');
const { syncCardLinks } = await import('../cards.js');
const { shopBot } = await import('../messaging.js');
const { shopNow } = await import('../clock.js');
const { addDays } = await import('../time.js');

// ---------- Cielo de mentira (API do Link de Pagamento): guarda os pedidos e responde.
interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | string | undefined;
}
const calls: Call[] = [];
const orders = new Map<string, unknown>();
const linkPayments = new Map<string, unknown[]>();
const jsonNotices = new Map<string, unknown>();
const failDeactivate = new Set<string>();
let links = 0;
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
cieloHttp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
  const raw = init?.body ? String(init.body) : undefined;
  const body = raw?.startsWith('{') ? (JSON.parse(raw) as Record<string, unknown>) : raw;
  calls.push({ method, path: url.pathname, auth, body });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/public/v2/token') {
    const known = [basic('cid-plat', 'sec-plat'), basic('cid-shop', 'sec-shop')];
    if (!auth || !known.includes(auth)) return json({ error: 'invalid_client' }, 401);
    return json({ access_token: `tok-${Buffer.from(auth.slice(6), 'base64').toString().split(':')[0]}`, token_type: 'bearer', expires_in: 1200 });
  }
  if (!auth?.startsWith('Bearer tok-')) return json({ message: 'Unauthorized' }, 401);
  let m: RegExpMatchArray | null;
  if (url.pathname === '/api/public/v1/products/' && method === 'POST') {
    links++;
    return json({ id: `link-${links}`, shortUrl: `https://cielolink.com.br/${links}`, type: (body as Record<string, unknown>).type }, 201);
  }
  if ((m = url.pathname.match(/^\/api\/public\/v1\/products\/([^/]+)\/payments$/))) return json({ productId: m[1], orders: linkPayments.get(m[1]) ?? [] });
  if (url.pathname.match(/^\/api\/public\/v1\/products\/[^/]+$/) && method === 'DELETE') return new Response(null, { status: 204 });
  if ((m = url.pathname.match(/^\/api\/public\/v2\/orders\/([^/]+)$/))) {
    const o = orders.get(m[1]);
    return o ? json(o) : json({ message: 'Order not found' }, 404);
  }
  if ((m = url.pathname.match(/^\/api\/public\/v1\/RecurrentPayment\/Deactivate\/([^/]+)$/)) && method === 'DELETE') {
    return failDeactivate.has(m[1]) ? json({ message: 'Erro interno' }, 500) : new Response(null, { status: 204 });
  }
  if ((m = url.pathname.match(/^\/api\/public\/v1\/notification\/([^/]+)$/))) return json(jsonNotices.get(m[1]) ?? {});
  return json({ message: 'not found' }, 404);
}) as typeof fetch;

const paidOrder = (type = 'CreditCard', extra: Record<string, unknown> = {}) => ({ orderNumber: 'x', payment: { status: 'Paid', type, ...extra } });
const created = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/public/v1/products/');

let server: Server;
let base = '';
const master = makeClient(() => base);
const owner = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

/** Aviso da Cielo (formulário, como a Cielo manda). */
const notify = (token: string, fields: Record<string, string>) =>
  fetch(`${base}/api/webhooks/cielo/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
const tokenOf = (webhookUrl: string) => webhookUrl.split('/').pop()!;

const shopId = run(
  "INSERT INTO barbershops (slug, name, bot_name, pix_key, pix_name, pix_city, monthly_price_cents, billing_day, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'pix@navalha.com.br', 'Navalha', 'Sao Paulo', 14990, 10, ?)",
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

async function enter(phone: string) {
  const c = makeClient(() => base);
  const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone });
  await c('POST', '/api/public/shops/navalha/login/verify', { phone, code: asked.data.demoCode });
  return c;
}

const today = () => shopNow(shopId).date;
let platformToken = '';
let shopToken = '';
let invoiceId = 0;
let clubCharge = 0;
let memberId = 0;

describe('cartão pela Cielo: menor taxa, dinheiro em 1 dia útil e cobrança automática todo mês', () => {
  test('o master liga a Cielo da plataforma: credenciais conferidas na Cielo e a URL de aviso para colar lá', async () => {
    assert.equal((await master('PUT', '/api/master/cielo', { clientId: 'cid-plat', clientSecret: 'errado', feePct: 3.48 })).status, 200);
    const bad = await master('POST', '/api/master/cielo/test');
    assert.equal(bad.status, 502);
    assert.match(bad.data.error, /recusou as credenciais/);
    const saved = await master('PUT', '/api/master/cielo', { clientId: 'cid-plat', clientSecret: 'sec-plat', feePct: 3.48 });
    assert.equal(saved.data.ready, true);
    assert.equal(saved.data.secretHint, '••••plat');
    assert.ok(!JSON.stringify(saved.data).includes('sec-plat'), 'o segredo não volta para a tela');
    assert.match(saved.data.webhookUrl, /\/api\/webhooks\/cielo\/[\w-]{20,}$/);
    assert.match(saved.data.returnUrl, /\/painel\/mensalidade$/);
    assert.equal((await master('POST', '/api/master/cielo/test')).status, 200);
    platformToken = tokenOf(saved.data.webhookUrl);
    // Em branco, o segredo atual fica.
    assert.equal((await master('PUT', '/api/master/cielo', { clientId: 'cid-plat', clientSecret: '', feePct: 3.48 })).data.ready, true);
  });

  test('mensalidade no cartão automático: o link recorrente paga a fatura e a Cielo cobra todo mês no mesmo dia', async () => {
    invoiceId = run("INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at) VALUES (?, ?, 'Mensalidade', 14990, ?, ?)", [
      shopId,
      today().slice(0, 7),
      addDays(today(), 5),
      nowIso(),
    ]).lastInsertRowid;
    const sub = (await owner('GET', '/api/shop/subscription')).data;
    assert.deepEqual(sub.card, { available: true, active: false, amount_cents: null, since: null, last_paid_at: null, error: null });

    const r = await owner('POST', '/api/shop/subscription/card');
    assert.equal(r.status, 200);
    assert.equal(r.data.url, 'https://cielolink.com.br/1');
    const link = created()[0];
    assert.equal(link.auth, 'Bearer tok-cid-plat', 'na conta Cielo da plataforma');
    assert.deepEqual(link.body, {
      type: 'Recurrent',
      name: 'Mensalidade',
      description: 'Sistema da Navalha de Ouro: cobrado no cartão todo mês, no mesmo dia.',
      showDescription: true,
      price: 14990,
      sku: `m${shopId}`,
      quantity: 1,
      shipping: { type: 'WithoutShipping' },
      recurrent: { interval: 'Monthly' },
    });
    assert.equal((await owner('POST', '/api/shop/subscription/card')).data.url, 'https://cielolink.com.br/1', 'pedir de novo devolve o mesmo link');
    assert.equal(created().length, 1);

    // A Cielo avisa (e o sistema confere o pedido nela antes de dar baixa).
    orders.set('ord-1', paidOrder());
    const fields = { checkout_cielo_order_number: 'ord-1', product_id: 'link-1', payment_status: '2', amount: '14990', payment_method_type: '1', recurrent_payment_id: 'rec-plat' };
    assert.equal((await notify('segredo-que-nao-existe-123', fields)).status, 404);
    assert.equal((await notify(platformToken, fields)).status, 200);
    assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/api/public/v2/orders/ord-1'), 'conferiu na Cielo');
    const inv = get<{ status: string; method: string; notes: string }>('SELECT status, method, notes FROM invoices WHERE id = ?', [invoiceId])!;
    assert.deepEqual(inv, { status: 'paid', method: 'cartao', notes: 'Cartão (Cielo): cobrança automática todo mês.' });
    assert.equal(get<{ billing_day: number }>('SELECT billing_day FROM barbershops WHERE id = ?', [shopId])!.billing_day, Math.min(Number(today().slice(8, 10)), 28), 'passa a vencer no dia do cartão');
    const sub2 = (await owner('GET', '/api/shop/subscription')).data;
    assert.equal(sub2.card.active, true);
    // O aviso de mudança de situação do mesmo pedido não dá baixa de novo.
    await notify(platformToken, { ...fields, payment_status: '2' });
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM gateway_payments WHERE provider = 'cielo'")!.n, 1);
    assert.equal((await owner('POST', '/api/shop/subscription/card')).status, 409, 'já cadastrado');
  });

  test('a Cielo cobra o mês seguinte antes de a fatura nascer: a fatura é criada e já sai paga', async () => {
    orders.set('ord-2', paidOrder());
    await notify(platformToken, { checkout_cielo_order_number: 'ord-2', recurrent_payment_id: 'rec-plat', payment_status: '2', amount: '14990' });
    const next = get<{ reference: string; status: string; amount_cents: number }>(
      'SELECT reference, status, amount_cents FROM invoices WHERE barbershop_id = ? ORDER BY reference DESC LIMIT 1',
      [shopId],
    )!;
    assert.equal(next.status, 'paid');
    assert.equal(next.amount_cents, 14990);
    assert.ok(next.reference > today().slice(0, 7));
  });

  test('aviso falso ou recusado não dá baixa', async () => {
    const before = get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE status = 'paid'")!.n;
    // Pedido que não existe na Cielo.
    const forged = await notify(platformToken, { checkout_cielo_order_number: 'ord-falso', product_id: 'link-1', payment_status: '2' });
    assert.equal(forged.status, 200);
    // O aviso diz "pago", mas a Cielo diz "negado".
    orders.set('ord-3', { payment: { status: 'Denied', type: 'CreditCard' } });
    await notify(platformToken, { checkout_cielo_order_number: 'ord-3', product_id: 'link-1', payment_status: '2', amount: '14990' });
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE status = 'paid'")!.n, before);
    assert.equal(get<{ status: string; applied: number }>("SELECT status, applied FROM gateway_payments WHERE external_id = 'cielo:ord-3'")!.status, 'DENIED');
    assert.equal((await owner('GET', '/api/shop/subscription')).data.card.error, 'O cartão recusou a última cobrança.');
  });

  test('a barbearia liga a Cielo dela para os clientes (sem as credenciais não liga)', async () => {
    assert.equal((await owner('GET', '/api/shop/online')).data.status.available, false);
    assert.equal((await owner('PUT', '/api/shop/online', { clientId: '', clientSecret: '', enabled: true, feePct: 3.48 })).status, 400);
    const r = await owner('PUT', '/api/shop/online', { clientId: 'cid-shop', clientSecret: 'sec-shop', enabled: true, feePct: 3.48 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.status, { available: true, feePct: 3.48, reason: null });
    assert.match(r.data.returnUrl, /\/b\/navalha\/conta$/);
    assert.equal((await owner('POST', '/api/shop/online/test')).status, 200);
    shopToken = tokenOf(r.data.webhookUrl);
    assert.notEqual(shopToken, platformToken);
    const step = (await owner('GET', '/api/shop/summary')).data.setup.find((s: { id: string }) => s.id === 'cartao');
    assert.equal(step.done, true);
  });

  test('clube no cartão automático: a Cielo da barbearia cobra todo mês e a baixa é sozinha, com a taxa no caixa', async () => {
    const plan = await owner('POST', '/api/shop/club/plans', { name: 'Ouro', price_cents: 9990, uses_per_month: null, item_ids: [corte] });
    const c = await enter('11999990000');
    const sub = (await c('POST', '/api/customer/navalha/club/subscribe', { plan_id: plan.data.id })).data;
    assert.equal(sub.online, true);
    clubCharge = sub.charge.id;
    memberId = sub.member.id;
    const r = await c('POST', `/api/customer/navalha/charges/${clubCharge}/pay-online`, {});
    assert.equal(r.status, 200);
    const link = created().at(-1)!;
    assert.equal(link.auth, 'Bearer tok-cid-shop', 'na conta Cielo da barbearia');
    assert.deepEqual(
      { type: (link.body as Record<string, unknown>).type, price: (link.body as Record<string, unknown>).price, sku: (link.body as Record<string, unknown>).sku },
      { type: 'Recurrent', price: 9990, sku: `c${memberId}` },
    );
    const linkId = `link-${links}`;

    // O pagamento chega no aviso em JSON (só o endereço para buscar os dados na Cielo).
    jsonNotices.set('n-1', { checkout_cielo_order_number: 'ord-c1', product_id: linkId, payment_status: '2', amount: '9990', payment_method_type: '1' });
    orders.set('ord-c1', paidOrder('CreditCard', { recurrentPayment: { id: 'rec-club' } }));
    const res = await fetch(`${base}/api/webhooks/cielo/${shopToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ URL: 'https://cielo.test/api/public/v1/notification/n-1', MerchantId: 'x', MerchantOrderNumber: 'y' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(get('SELECT status, method FROM charges WHERE id = ?', [clubCharge]), { status: 'paid', method: 'credito' });
    assert.deepEqual(
      all('SELECT type, category, amount_cents FROM cash_entries WHERE charge_id = ? ORDER BY id', [clubCharge]),
      [
        { type: 'in', category: 'Clube de assinatura', amount_cents: 9990 },
        { type: 'out', category: 'Impostos e taxas', amount_cents: 348 },
      ],
      '3,48% de 99,90 = 3,48',
    );
    const state = (await c('GET', '/api/customer/navalha/club')).data;
    assert.equal(state.member.state, 'ok');
    assert.equal(state.member.card, true);
    assert.equal(get<{ recurrent_payment_id: string }>("SELECT recurrent_payment_id FROM card_links WHERE sku = ?", [`c${memberId}`])!.recurrent_payment_id, 'rec-club');
    assert.equal((await owner('POST', `/api/shop/charges/${clubCharge}/undo`)).status, 409, 'pago no cartão não se desfaz no painel');
    assert.equal((await c('POST', `/api/customer/navalha/charges/${clubCharge}/pay-online`, {})).status, 409);
  });

  test('o mês seguinte do clube vem da Cielo (sem PIX pelo WhatsApp); cartão recusado vira cobrança com PIX depois da tolerância', async () => {
    const paidUntil = () => get<{ paid_until: string }>('SELECT paid_until FROM club_members WHERE id = ?', [memberId])!.paid_until;
    const first = paidUntil();
    const at = (date: string) => new Date(`${date}T12:00:00-03:00`);
    // Perto de vencer: no PIX sairia a cobrança pelo WhatsApp; no cartão, não.
    await clubBilling(shopBot(shopId), at(addDays(first, -1)));
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM charges WHERE club_member_id = ? AND status = 'open'", [memberId])!.n, 0);
    // Até 3 dias depois do vencimento ainda vale (a Cielo pode cobrar um pouco depois e tenta de novo).
    assert.ok(clubCoverage(shopId, joao, addDays(first, 3)));
    assert.equal(clubCoverage(shopId, joao, addDays(first, 4)), null);
    const c = await enter('11999990000');
    // A Cielo cobra o mês seguinte.
    orders.set('ord-c2', paidOrder());
    await notify(shopToken, { checkout_cielo_order_number: 'ord-c2', recurrent_payment_id: 'rec-club', payment_status: '2', amount: '9990' });
    assert.ok(paidUntil() > first, 'o clube vale mais um mês');
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM charges WHERE club_member_id = ? AND status = 'paid'", [memberId])!.n, 2);

    // Depois disso o cartão não passa: passada a tolerância, sai a mensalidade com o PIX no WhatsApp.
    const later = paidUntil();
    await clubBilling(shopBot(shopId), at(addDays(later, 4)));
    const open = get<{ id: number; amount_cents: number }>("SELECT id, amount_cents FROM charges WHERE club_member_id = ? AND status = 'open'", [memberId]);
    assert.ok(open);
    const msg = get<{ body: string }>("SELECT body FROM messages WHERE customer_id = ? AND kind = 'assinatura' ORDER BY id DESC LIMIT 1 OFFSET 1", [joao])!;
    assert.match(msg.body, /no cartão não passou/);
    // Ele pode cadastrar outro cartão (o antigo para de ser cobrado).
    const swap = await c('POST', `/api/customer/navalha/charges/${open!.id}/pay-online`, {});
    assert.equal(swap.status, 200);
    assert.ok(calls.some((x) => x.method === 'DELETE' && x.path === '/api/public/v1/RecurrentPayment/Deactivate/rec-club'));
  });

  test('sinal no cartão (avulso, uso único); pago depois de a vaga ser liberada vira crédito', async () => {
    await owner('PUT', '/api/shop/deposits/settings', { deposit_mode: 'all', deposit_cents: 2000, deposit_hold_min: 60, deposit_credit_hours: 24 });
    const date = addDays(today(), 5);
    const now = new Date(Date.now() - 2 * 3600000);
    const a = book({ shopId, customerId: ana, barberId: paulo, serviceId: corte, date, time: '15:00', source: 'cliente', now });
    const dep = requireDeposit(shopId, a.id, now)!;
    const c = await enter('11988880000');
    assert.equal((await c('GET', `/api/customer/navalha/deposits/${dep.id}`)).data.online, true);
    const r = await c('POST', `/api/customer/navalha/charges/${dep.id}/pay-online`, {});
    assert.equal(r.status, 200);
    const body = created().at(-1)!.body as Record<string, unknown>;
    assert.equal(body.type, 'Payment');
    assert.equal(body.maxNumberOfInstallments, 1);
    assert.equal(body.quantity, 1);
    assert.equal(body.sku, `s${dep.id}`);
    assert.equal(body.expirationDate, addDays(today(), 1));
    assert.equal(body.recurrent, undefined);
    let linkId = `link-${links}`;

    // O cartão foi recusado: pedir de novo gera outro link (o de uso único pode não valer mais).
    orders.set('ord-s0', { payment: { status: 'Denied', type: 'CreditCard' } });
    await notify(shopToken, { checkout_cielo_order_number: 'ord-s0', product_id: linkId, payment_status: '3', amount: '2000' });
    const again = await c('POST', `/api/customer/navalha/charges/${dep.id}/pay-online`, {});
    assert.notEqual(again.data.url, r.data.url);
    assert.ok(calls.some((x) => x.method === 'DELETE' && x.path === `/api/public/v1/products/${linkId}`), 'o link antigo sai do ar');
    linkId = `link-${links}`;

    // Não pagou no prazo: a vaga é liberada. O cartão é aprovado depois.
    assert.equal(await expireDeposits(shopBot(shopId), new Date()), 1);
    orders.set('ord-s1', paidOrder('DebitCard'));
    await notify(shopToken, { checkout_cielo_order_number: 'ord-s1', product_id: linkId, payment_status: '2', amount: '2000', payment_method_type: '4' });
    assert.deepEqual(get('SELECT status, method, appointment_id FROM charges WHERE id = ?', [dep.id]), { status: 'paid', method: 'debito', appointment_id: null });
  });

  test('conferência de hora em hora: pagamento cujo aviso não chegou e link que não vale mais', async () => {
    // Sinal pago na Cielo, mas o aviso se perdeu: a conferência acha e dá baixa.
    const date = addDays(today(), 6);
    const now = new Date();
    const bruno = customer('Bruno Costa', '11977770000');
    const a = book({ shopId, customerId: bruno, barberId: paulo, serviceId: corte, date, time: '16:00', source: 'cliente', now });
    const dep = requireDeposit(shopId, a.id, now)!;
    const c = await enter('11977770000');
    await c('POST', `/api/customer/navalha/charges/${dep.id}/pay-online`, {});
    const lost = `link-${links}`;
    orders.set('ord-perdido', paidOrder());
    linkPayments.set(lost, [{ orderNumber: 'ord-perdido', payment: { status: 'Paid', price: 2000 } }]);

    // Outro sinal: o cliente gera o link mas paga no PIX direto e o dono confirma. O link é apagado.
    const d2 = book({ shopId, customerId: bruno, barberId: paulo, serviceId: corte, date: addDays(today(), 7), time: '16:00', source: 'cliente', now });
    const dep2 = requireDeposit(shopId, d2.id, now)!;
    await c('POST', `/api/customer/navalha/charges/${dep2.id}/pay-online`, {});
    const stale = `link-${links}`;
    await owner('POST', `/api/shop/charges/${dep2.id}/confirm`, { method: 'pix' });

    const r = await syncCardLinks(new Date(Date.now() + 2 * 3600000));
    assert.equal(r.applied, 1);
    assert.equal(r.removed, 1);
    assert.equal(get<{ status: string }>('SELECT status FROM charges WHERE id = ?', [dep.id])!.status, 'paid');
    assert.ok(calls.some((x) => x.method === 'DELETE' && x.path === `/api/public/v1/products/${stale}`));
    assert.equal(get<{ status: string }>('SELECT status FROM card_links WHERE link_id = ?', [stale])!.status, 'cancelled');
  });

  test('quem cancela o clube para de ser cobrado na Cielo; se a Cielo falhar, o dono é avisado e a conferência tenta de novo', async () => {
    const c = await enter('11999990000');
    // O cartão novo (trocado no teste anterior) foi pago: recorrência ativa.
    const fresh = get<{ link_id: string }>("SELECT link_id FROM card_links WHERE club_member_id = ? AND status = 'open'", [memberId])!;
    orders.set('ord-c3', paidOrder('CreditCard', { recurrentPayment: { id: 'rec-club-2' } }));
    await notify(shopToken, { checkout_cielo_order_number: 'ord-c3', product_id: fresh.link_id, payment_status: '2', amount: '9990' });
    assert.equal((await c('GET', '/api/customer/navalha/club')).data.member.card, true);

    failDeactivate.add('rec-club-2');
    const r = await owner('POST', `/api/shop/club/members/${memberId}/cancel`);
    assert.match(r.data.warning, /Cancele no site da Cielo/);
    assert.equal(get<{ status: string }>("SELECT status FROM card_links WHERE recurrent_payment_id = 'rec-club-2'")!.status, 'active');
    failDeactivate.delete('rec-club-2');
    await syncCardLinks(new Date());
    assert.equal(get<{ status: string }>("SELECT status FROM card_links WHERE recurrent_payment_id = 'rec-club-2'")!.status, 'cancelled');
    // Se a Cielo ainda cobrou depois do cancelamento, fica marcado para devolver.
    orders.set('ord-c4', paidOrder());
    await notify(shopToken, { checkout_cielo_order_number: 'ord-c4', recurrent_payment_id: 'rec-club-2', payment_status: '2', amount: '9990' });
    assert.equal(get<{ duplicate: number }>("SELECT duplicate FROM gateway_payments WHERE external_id = 'cielo:ord-c4'")!.duplicate, 1);
  });

  test('o master vê os pagamentos no cartão (barbearia, tipo, forma e valores), sem o nome dos clientes', async () => {
    const r = (await master('GET', `/api/master/payments?from=${today()}&to=${today()}`)).data;
    assert.equal(r.cielo, true);
    const kinds = new Set(r.items.filter((i: { paid: boolean }) => i.paid).map((i: { kind: string }) => i.kind));
    assert.deepEqual([...kinds].sort(), ['clube', 'mensalidade', 'sinal']);
    const monthly = r.items.find((i: { kind: string; paid: boolean }) => i.kind === 'mensalidade' && i.paid);
    assert.equal(monthly.provider, 'cielo');
    assert.equal(monthly.value_cents, 14990);
    assert.equal(monthly.net, 14990 - 522, 'taxa estimada de 3,48%');
    assert.ok(!JSON.stringify(r).match(/João|Ana|Bruno/), 'sem nome de cliente');
    const ready = (await master('GET', '/api/master/readiness')).data.find((i: { id: string }) => i.id === 'online');
    assert.equal(ready.done, true, 'Cielo ligada e recebendo avisos');
  });

  test('o valor da mensalidade mudou: o cartão automático no valor antigo é desligado', async () => {
    const plan = (await master('GET', `/api/master/shops`)).data.find((s: { id: number }) => s.id === shopId);
    const r = await master('PUT', `/api/master/shops/${shopId}/billing`, {
      plan_id: plan.plan_id,
      monthly_price_cents: 19990,
      billing_day: 10,
      trial_until: null,
    });
    assert.equal(r.status, 200);
    assert.ok(calls.some((x) => x.method === 'DELETE' && x.path === '/api/public/v1/RecurrentPayment/Deactivate/rec-plat'));
    assert.equal((await owner('GET', '/api/shop/subscription')).data.card.active, false);
  });
});
