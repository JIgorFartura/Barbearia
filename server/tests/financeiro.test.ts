import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-fin-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book } = await import('../scheduling.js');
const { cancelSale, commissionBalances, commissionFor, createPayout, createSale, financeSummary, addEntry } = await import('../finance.js');
const { askConsumption, usualConsumption } = await import('../consumption.js');
const { accessStatus, dueDate, ensureInvoices } = await import('../billing.js');
const { crc16 } = await import('../pix.js');
const { handleInbound } = await import('../bot/inbound.js');
const { addDays, localNow, weekdayOf } = await import('../time.js');

const at = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}:00-03:00`);

let server: Server;
let base = '';
function client() {
  let cookies: Record<string, string> = {};
  return async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [k, ...v] = c.split(';')[0].split('=');
      cookies = { ...cookies, [k]: v.join('=') };
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* texto */
    }
    return { status: res.status, data };
  };
}

// ---------- cenário
const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', 'Dono', 'dono@navalha.com', ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
]);
run("INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', ?, ?)", [hashPassword('senha-forte-1'), nowIso()]);
const barber = (name: string, phone: string | null, service: number, product: number) => {
  const id = run('INSERT INTO barbers (barbershop_id, name, phone, service_commission, product_commission, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    shopId,
    name,
    phone,
    service,
    product,
    nowIso(),
  ]).lastInsertRowid;
  for (let d = 1; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [id, d]);
  return id;
};
const paulo = barber('Paulo', '11955554444', 40, 10);
const marcos = barber('Marcos', null, 50, 0);
const item = (kind: string, name: string, price: number) =>
  run('INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    shopId,
    kind,
    name,
    price,
    kind === 'service' ? 30 : null,
    nowIso(),
  ]).lastInsertRowid;
const corte = item('service', 'Corte', 5000);
const barba = item('service', 'Barba', 3500);
const cerveja = item('product', 'Cerveja long neck', 1200);
// Paulo ganha R$ 15,00 fixos por barba.
run("INSERT INTO barber_service_rates (barber_id, service_id, mode, value) VALUES (?, ?, 'fixed', 1500)", [paulo, barba]);
const clube = run("INSERT INTO campaigns (barbershop_id, name, unit_label, goal, reward, catalog_item_id, created_at) VALUES (?, 'Clube da Cerveja', 'cervejas', 5, 'um copo', ?, ?)", [
  shopId,
  cerveja,
  nowIso(),
]).lastInsertRowid;
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shopId, name, phone, nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const pedro = customer('Pedro Alves', '11977770000');

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe('financeiro da barbearia', () => {
  let saleId = 0;
  let apptId = 0;

  test('comissão: % padrão, valor fixo por serviço e % de produtos', () => {
    assert.equal(commissionFor(paulo, 'service', corte, 1, 5000), 2000);
    assert.equal(commissionFor(paulo, 'service', barba, 2, 7000), 3000);
    assert.equal(commissionFor(paulo, 'product', cerveja, 2, 2400), 240);
    assert.equal(commissionFor(marcos, 'service', corte, 1, 5000), 2500);
    assert.equal(commissionFor(marcos, 'product', cerveja, 1, 1200), 0);
    assert.equal(commissionFor(null, 'service', corte, 1, 5000), 0);
  });

  test('fechar o atendimento: venda, caixa, comissão e carimbos automáticos', () => {
    apptId = book({ shopId, customerId: joao, barberId: paulo, serviceId: corte, date: '2026-11-06', time: '17:00', source: 'painel' }).id;
    const r = createSale({
      shopId,
      userId: null,
      appointmentId: apptId,
      items: [{ catalog_item_id: corte, qty: 1 }, { catalog_item_id: cerveja, qty: 2 }],
      discountCents: 400,
      method: 'pix',
      now: at('2026-11-06 17:40'),
    });
    saleId = r.sale.id;
    assert.equal(r.sale.date, '2026-11-06');
    assert.equal(r.sale.customer_name, 'João Pereira');
    assert.deepEqual([r.sale.subtotal_cents, r.sale.discount_cents, r.sale.total_cents], [7400, 400, 7000]);
    // Desconto dividido: corte vale 4730 → 40% = 1892; cervejas 2270 → 10% = 227.
    assert.deepEqual(
      r.sale.items.map((i) => [i.name, i.barber_name, i.commission_cents]),
      [
        ['Corte', 'Paulo', 1892],
        ['Cerveja long neck', 'Paulo', 227],
      ],
    );
    assert.deepEqual(r.stamps, [{ campaign: 'Clube da Cerveja', qty: 2, unit: 'cervejas', available: 0 }]);
    const entry = get<{ type: string; category: string; amount_cents: number; method: string }>('SELECT type, category, amount_cents, method FROM cash_entries WHERE sale_id = ?', [saleId]);
    assert.deepEqual(entry, { type: 'in', category: 'Atendimentos', amount_cents: 7000, method: 'pix' });
    assert.throws(() => createSale({ shopId, userId: null, appointmentId: apptId, items: [{ catalog_item_id: corte, qty: 1 }], method: 'pix' }), /já foi fechado/);
  });

  test('cancelar a venda tira do caixa e os carimbos; dá para fechar de novo', () => {
    cancelSale(shopId, saleId);
    assert.equal(get('SELECT 1 AS ok FROM cash_entries WHERE sale_id = ?', [saleId]), undefined);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM loyalty_events WHERE campaign_id = ?', [clube])!.n, 0);
    const again = createSale({
      shopId,
      userId: null,
      appointmentId: apptId,
      items: [{ catalog_item_id: corte, qty: 1 }, { catalog_item_id: cerveja, qty: 2 }],
      discountCents: 400,
      method: 'pix',
      now: at('2026-11-06 17:45'),
    });
    saleId = again.sale.id;
  });

  test('pagamento ao barbeiro: soma o que está em aberto e sai do caixa', () => {
    const before = commissionBalances(shopId).find((b) => b.barber_id === paulo)!;
    assert.equal(before.unpaid_cents, 2119);
    assert.equal(before.unpaid_items, 2);
    const p = createPayout({ shopId, barberId: paulo, until: '2026-11-07', method: 'pix', notes: null, userId: null, now: at('2026-11-07 19:00') });
    assert.deepEqual([p.amount_cents, p.items], [2119, 2]);
    assert.equal(commissionBalances(shopId).find((b) => b.barber_id === paulo)!.unpaid_cents, 0);
    assert.throws(() => createPayout({ shopId, barberId: paulo, until: '2026-11-07', method: 'pix', notes: null, userId: null }), /Não há comissão/);
    assert.throws(() => cancelSale(shopId, saleId), /já foi paga/);
    const out = get<{ category: string; amount_cents: number; date: string }>('SELECT category, amount_cents, date FROM cash_entries WHERE payout_id = ?', [p.id]);
    assert.deepEqual(out, { category: 'Comissões', amount_cents: 2119, date: '2026-11-07' });
  });

  test('resumo do mês: faturamento, gastos, resultado, contas a pagar', () => {
    addEntry(shopId, { type: 'out', category: 'Aluguel', description: 'Aluguel de novembro', amount_cents: 150000, method: 'pix', date: '2026-11-05', status: 'paid' }, null);
    addEntry(shopId, { type: 'out', category: 'Contas (água, luz, internet)', description: 'Luz', amount_cents: 30000, method: null, date: '2026-11-02', status: 'pending' }, null);
    const s = financeSummary(shopId, '2026-11-01', '2026-11-30', at('2026-11-10 12:00'));
    assert.equal(s.income, 7000);
    assert.equal(s.expenses, 2119 + 150000);
    assert.equal(s.result, 7000 - 152119);
    assert.equal(s.pendingOut, 30000);
    assert.equal(s.overdueOut, 30000);
    assert.equal(s.salesCount, 1);
    assert.equal(s.averageTicket, 7000);
    assert.deepEqual(s.byMethod, [{ method: 'pix', total: 7000, count: 1 }]);
    assert.deepEqual(
      s.byBarber.map((b) => [b.name, b.services, b.products, b.revenue, b.commission]),
      [['Paulo', 1, 2, 7400, 2119]],
    );
    assert.equal(s.byDay.find((d) => d.date === '2026-11-06')!.in, 7000);
    assert.equal(s.expensesByCategory[0].category, 'Aluguel');
  });
});

describe('o robô entende o consumo do cliente', () => {
  test('descobre que o João sempre toma uma cerveja', () => {
    for (const [date, qty] of [['2026-10-30', 1], ['2026-10-23', 1]] as const) {
      createSale({ shopId, userId: null, customerId: joao, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo }, { catalog_item_id: cerveja, qty }], method: 'dinheiro', now: at(`${date} 18:00`) });
    }
    assert.deepEqual(usualConsumption(joao), [{ productId: cerveja, name: 'Cerveja long neck', qty: 1 }]);
    assert.deepEqual(usualConsumption(pedro), []);
  });

  test('ao confirmar o horário pelo SIM, pergunta se pode avisar o Paulo; o SIM separa e avisa o barbeiro', async () => {
    run("INSERT INTO bot_offers (barbershop_id, customer_id, barber_id, service_id, starts_at, kind, created_at) VALUES (?, ?, ?, ?, '2026-11-13 17:00', 'costume', ?)", [
      shopId,
      joao,
      paulo,
      corte,
      nowIso(),
    ]);
    const confirm = await handleInbound({ shopId, from: '11999990000', text: 'sim', now: at('2026-11-09 09:10') });
    assert.match(confirm!, /Fechado, João! ✅ sexta, 13\/11 às 17h com Paulo/);
    assert.match(confirm!, /Posso avisar o Paulo que você vai querer 1 cerveja long neck/);
    const reply = await handleInbound({ shopId, from: '11999990000', text: 'Sim', now: at('2026-11-09 09:11') });
    assert.match(reply!, /Avisei o Paulo: 1 cerveja long neck separado/);
    const appt = get<{ id: number }>("SELECT id FROM appointments WHERE customer_id = ? AND starts_at = '2026-11-13 17:00'", [joao])!.id;
    assert.deepEqual(all('SELECT catalog_item_id, qty, source FROM appointment_items WHERE appointment_id = ?', [appt]), [
      { catalog_item_id: cerveja, qty: 1, source: 'whatsapp' },
    ]);
    const toBarber = get<{ phone: string; body: string; kind: string }>("SELECT phone, body, kind FROM messages WHERE kind = 'barbeiro' ORDER BY id DESC LIMIT 1")!;
    assert.equal(toBarber.phone, '11955554444');
    assert.match(toBarber.body, /João Pereira vem sexta, 13\/11 às 17h e pediu pra deixar separado: 1 cerveja long neck/);
    // Já separado: não pergunta de novo.
    assert.equal(askConsumption(shopId, appt, at('2026-11-09 09:12')), null);
  });

  test('NÃO encerra a pergunta educadamente', async () => {
    const appt = book({ shopId, customerId: joao, barberId: marcos, serviceId: corte, date: '2026-11-20', time: '10:00', source: 'painel' }).id;
    assert.match(askConsumption(shopId, appt, at('2026-11-18 09:00'))!, /Posso avisar o Marcos/);
    assert.equal(await handleInbound({ shopId, from: '11999990000', text: 'não', now: at('2026-11-18 09:01') }), 'Beleza! Até lá. 👊');
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM appointment_items WHERE appointment_id = ?', [appt])!.n, 0);
  });

  test('pela IA: ao marcar, a ferramenta já traz a pergunta do consumo', async () => {
    let seen: any = null;
    const create = async (params: any) => {
      const last = params.messages.at(-1);
      if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        seen = JSON.parse(last.content[0].content);
        return { content: [{ type: 'text', text: 'Marcado!' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as any;
      }
      assert.match(params.system[1].text, /Consumo de costume quando vem: 1 Cerveja long neck/);
      assert.ok(params.tools.some((t: any) => t.name === 'reservar_consumo'));
      return {
        content: [{ type: 'tool_use', id: 't1', name: 'agendar', input: { data: '2026-11-27', hora: '17:00', barbeiro_id: paulo } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      } as any;
    };
    await handleInbound({ shopId, from: '11999990000', text: 'Marca sexta dia 27 às 17h com o Paulo', now: at('2026-11-21 10:00'), create });
    assert.match(seen.pergunta_consumo, /Posso avisar o Paulo que você vai querer 1 cerveja long neck/);
  });

  test('o cliente informa na área dele, após marcar pelo site', async () => {
    for (const date of ['2026-10-16', '2026-10-09']) {
      createSale({ shopId, userId: null, customerId: pedro, items: [{ catalog_item_id: cerveja, qty: 2 }], method: 'dinheiro', now: at(`${date} 18:00`) });
    }
    const dono = client();
    await dono('POST', '/api/auth/login', { email: 'dono@navalha.com', password: 'senha-forte-1' });
    const link = (await dono('POST', `/api/shop/customers/${pedro}/access-link`)).data.url;
    const cli = client();
    await cli('POST', '/api/public/shops/navalha/login/link', { token: new URL(link).searchParams.get('t') });
    let date = addDays(localNow().date, 2);
    while (weekdayOf(date) === 0) date = addDays(date, 1);
    const created = await cli('POST', '/api/customer/navalha/appointments', { barber_id: marcos, date, time: '15:00' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.suggestion.items, [{ productId: cerveja, name: 'Cerveja long neck', qty: 2 }]);
    const reserved = await cli('POST', `/api/customer/navalha/appointments/${created.data.id}/items`, { items: [{ product_id: cerveja, qty: 2 }] });
    assert.equal(reserved.data.barberNotified, false, 'o Marcos não tem celular cadastrado');
    const me = await cli('GET', '/api/customer/navalha/me');
    assert.deepEqual(me.data.upcoming[0].items, [{ catalog_item_id: cerveja, name: 'Cerveja long neck', qty: 2 }]);
    assert.equal(me.data.purchases.length, 2);
    assert.equal('commission_cents' in me.data.purchases[0].items[0], false, 'cliente não vê comissão');
  });
});

describe('mensalidades da plataforma', () => {
  const master = client();
  const dono = client();

  test('PIX copia e cola confere com o exemplo do Banco Central', () => {
    const ex = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
    assert.equal(crc16(ex), '1D3D');
    assert.equal(dueDate('2027-02', 31), '2027-02-28');
  });

  test('fatura do mês sai sozinha, uma vez, e bloqueia depois da carência', async () => {
    assert.equal((await master('POST', '/api/auth/login', { email: 'igor@exemplo.com', password: 'senha-forte-1' })).status, 200);
    await master('PUT', '/api/master/settings', { grace_days: 5, trial_days: 14, pix_key: 'pix@plataforma.com', pix_name: 'Igor Fartura', pix_city: 'São Paulo' });
    const plan = await master('POST', '/api/master/plans', { name: 'Comunidade', price_cents: 14990, description: null, active: true });
    assert.equal(plan.status, 201);
    assert.equal((await master('PUT', `/api/master/shops/${shopId}/billing`, { plan_id: plan.data.id, monthly_price_cents: null, billing_day: 10, trial_until: null })).status, 200);

    assert.equal(ensureInvoices(at('2026-11-02 08:00')), 1);
    assert.equal(ensureInvoices(at('2026-11-20 08:00')), 0);
    const inv = get<{ amount_cents: number; due_date: string; description: string }>('SELECT amount_cents, due_date, description FROM invoices WHERE barbershop_id = ?', [shopId])!;
    assert.deepEqual(inv, { amount_cents: 14990, due_date: '2026-11-10', description: 'Mensalidade novembro/2026 · Comunidade' });
    assert.equal(accessStatus(shopId, at('2026-11-15 12:00')).blocked, false, 'ainda na carência');
    assert.equal(accessStatus(shopId, at('2026-11-16 12:00')).blocked, true);
  });

  test('bloqueada: painel só mostra a mensalidade (com PIX), robô fica no menu, master entra e libera', async () => {
    // Fatura vencida há 10 dias (pelo relógio real) para testar pelas rotas.
    const created = await master('POST', '/api/master/invoices', { barbershop_id: shopId, description: 'Ajuste', amount_cents: 5000, due_date: addDays(localNow().date, -10) });
    assert.equal(created.status, 201);
    await dono('POST', '/api/auth/login', { email: 'dono@navalha.com', password: 'senha-forte-1' });
    const blocked = await dono('GET', '/api/shop/barbers');
    assert.equal(blocked.status, 402);
    assert.match(blocked.data.error, /mensalidade em atraso/);
    const sub = await dono('GET', '/api/shop/subscription');
    assert.equal(sub.status, 200);
    assert.equal(sub.data.blocked, true);
    assert.equal(sub.data.current.description, 'Ajuste');
    assert.match(sub.data.current.pix.payload, /^000201.*br\.gov\.bcb\.pix.*pix@plataforma\.com.*540550\.00/);
    assert.match(sub.data.current.pix.qr, /^data:image\/png;base64,/);
    assert.ok((await dono('POST', `/api/shop/subscription/${created.data.id}/inform`)).data.informed_at);

    let called = false;
    const reply = await handleInbound({ shopId, from: '11977770000', text: 'quanto falta no meu cartão?', create: async () => ((called = true), {}) as any });
    assert.equal(called, false, 'sem IA enquanto estiver bloqueada');
    assert.match(reply!, /Clube da Cerveja/);

    assert.equal((await master('POST', `/api/master/shops/${shopId}/enter`)).status, 200);
    assert.equal((await master('GET', '/api/shop/barbers')).status, 200, 'master entra mesmo bloqueada');
    await master('POST', '/api/master/exit');

    await master('POST', `/api/master/shops/${shopId}/release`, { until: addDays(localNow().date, 3) });
    assert.equal((await dono('GET', '/api/shop/barbers')).status, 200, 'liberada pelo master');
    await master('POST', `/api/master/shops/${shopId}/release`, { until: null });
    assert.equal((await dono('GET', '/api/shop/barbers')).status, 402);

    const paid = await master('POST', `/api/master/invoices/${created.data.id}/pay`, { paid_at: localNow().date, method: 'pix', notes: null });
    assert.equal(paid.data.status, 'paid');
    assert.equal((await dono('GET', '/api/shop/barbers')).status, 200, 'pagou, voltou');
    const expense = get<{ category: string; amount_cents: number }>('SELECT category, amount_cents FROM cash_entries WHERE invoice_id = ?', [created.data.id]);
    assert.deepEqual(expense, { category: 'Mensalidade do sistema', amount_cents: 5000 });
  });

  test('avisos do master aparecem no painel; barbearia suspensa perde o acesso', async () => {
    await master('POST', '/api/master/announcements', { title: 'Novidade: financeiro', body: 'Agora o caixa está integrado à agenda.', level: 'novidade', active: true });
    const status = await dono('GET', '/api/shop/status');
    assert.equal(status.data.announcements[0].title, 'Novidade: financeiro');
    run('UPDATE barbershops SET active = 0 WHERE id = ?', [shopId]);
    assert.equal((await dono('GET', '/api/shop/barbers')).status, 403);
    assert.equal((await dono('GET', '/api/shop/status')).data.active, false);
    run('UPDATE barbershops SET active = 1 WHERE id = ?', [shopId]);
    const system = await master('GET', '/api/master/system');
    assert.equal(system.data.version, '0.1.0');
    assert.ok(system.data.counts.sales >= 4);
    const billing = await master('GET', '/api/master/billing');
    assert.ok(billing.data.revenue.mrr >= 14990);
  });
});
