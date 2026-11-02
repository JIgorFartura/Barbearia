import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-pacotes-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { buildContext } = await import('../bot/brain.js');
const { shopBot } = await import('../messaging.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const otherOwner = makeClient(() => base);
const barber = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await otherOwner('POST', '/api/auth/login', { login: 'rita@tesoura.com', password: 'senha-forte-1' });
  await owner('PUT', '/api/shop/barber-settings', { barber_can_close: true });
  await owner('POST', `/api/shop/barbers/${paulo}/access`, { phone: '11955554444', password: 'paulo-senha-1' });
  await barber('POST', '/api/auth/login', { login: '11955554444', password: 'paulo-senha-1' });
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
const otherShop = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('tesoura', 'Tesoura Fina', 'Zé', ?)", [nowIso()]).lastInsertRowid;
for (const [shop, name, email] of [
  [shopId, 'Carlos', 'carlos@navalha.com'],
  [otherShop, 'Rita', 'rita@tesoura.com'],
] as const) {
  run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', ?, ?, ?, ?, ?)", [
    shop,
    name,
    email,
    hashPassword('senha-forte-1'),
    nowIso(),
    nowIso(),
  ]);
}
// Paulo ganha 40% nos serviços.
const paulo = run('INSERT INTO barbers (barbershop_id, name, service_commission, created_at) VALUES (?, ?, 40, ?)', [shopId, 'Paulo', nowIso()]).lastInsertRowid;
const service = (shop: number, name: string, price: number) =>
  run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', ?, ?, 30, ?)", [shop, name, price, nowIso()]).lastInsertRowid;
const corte = service(shopId, 'Corte', 5000);
const barba = service(shopId, 'Barba', 3000);
const alheio = service(otherShop, 'Corte', 4000);
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shopId, name, phone, nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const ana = customer('Ana Lima', '11988880000');

const cash = (category: string) => get<{ v: number | null }>("SELECT SUM(amount_cents) AS v FROM cash_entries WHERE barbershop_id = ? AND category = ?", [shopId, category])!.v ?? 0;
const pack = () => get<{ id: number; used: number; status: string; expires_on: string }>('SELECT id, used, status, expires_on FROM customer_packages WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [joao])!;
const sale = (body: object, who = owner) => who('POST', who === barber ? '/api/barber/sales' : '/api/shop/finance/sales', body);

let packageId = 0;
let packSaleId = 0;
let useSaleId = 0;
let code = '';

describe('pacotes pré-pagos', () => {
  test('o dono cadastra o pacote (com conferência)', async () => {
    const bad = async (body: object) =>
      (await owner('POST', '/api/shop/packages', { name: '5 cortes', service_id: corte, uses: 5, price_cents: 20000, valid_days: 180, description: null, active: true, ...body })).status;
    assert.equal(await bad({ uses: 1 }), 400);
    assert.equal(await bad({ price_cents: 0 }), 400);
    assert.equal(await bad({ service_id: alheio }), 400, 'serviço de outra barbearia');
    const r = await owner('POST', '/api/shop/packages', { name: '5 cortes', service_id: corte, uses: 5, price_cents: 20000, valid_days: 180, description: null, active: true });
    assert.equal(r.status, 201);
    packageId = r.data.id;
    assert.equal((await otherOwner('GET', '/api/shop/packages')).data.length, 0, 'cada barbearia vê só os seus');
  });

  test('vender o pacote: o dinheiro entra no caixa e os usos ficam com o cliente', async () => {
    const r = await owner('POST', '/api/shop/packages/sell', { package_id: packageId, customer_id: joao, method: 'pix' });
    assert.equal(r.status, 201);
    packSaleId = r.data.sale.sale.id;
    assert.equal(r.data.package.left, 5);
    assert.equal(cash('Pacotes e vale-presente'), 20000);
    assert.equal(cash('Atendimentos'), 0);
    assert.equal(r.data.sale.sale.items[0].commission_cents, 0, 'vender o pacote não gera comissão');
    assert.equal(r.data.sale.sale.items[0].kind, 'product', 'não conta como atendimento');
    const mine = (await owner('GET', `/api/shop/customers/${joao}/packages`)).data;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].left, 5);
  });

  test('na comanda o corte sai por R$ 0 pelo pacote e o barbeiro ganha sobre o valor de cada uso', async () => {
    const r = await sale({ customer_id: joao, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo, package_id: pack().id }], method: 'pix' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    useSaleId = r.data.sale.id;
    assert.equal(r.data.sale.total_cents, 0);
    // R$ 200 / 5 = R$ 40 por uso; 40% de R$ 40 = R$ 16.
    assert.equal(r.data.sale.items[0].commission_cents, 1600);
    assert.equal(pack().used, 1);
    assert.equal(cash('Atendimentos'), 0, 'nada novo no caixa: o pacote já foi pago');

    // Pelo app do barbeiro também.
    const b = await sale({ customer_id: joao, items: [{ catalog_item_id: corte, qty: 1, package_id: pack().id }], method: 'pix' }, barber);
    assert.equal(b.status, 201, JSON.stringify(b.data));
    assert.equal(pack().used, 2);
    assert.equal((await barber('GET', `/api/barber/customers/${joao}/packages`)).data[0].left, 3);
  });

  test('não usa pacote para outro serviço, de outro cliente nem além dos usos', async () => {
    const p = pack().id;
    assert.equal((await sale({ customer_id: joao, items: [{ catalog_item_id: barba, qty: 1, package_id: p }], method: 'pix' })).status, 409, 'barba não está no pacote');
    assert.equal((await sale({ customer_id: ana, items: [{ catalog_item_id: corte, qty: 1, package_id: p }], method: 'pix' })).status, 404, 'pacote do João');
    assert.equal((await sale({ customer_id: joao, items: [{ catalog_item_id: corte, qty: 4, package_id: p }], method: 'pix' })).status, 409, 'só sobram 3');
    assert.equal(pack().used, 2, 'nada mudou');
  });

  test('cancelar o atendimento devolve o uso; a venda do pacote só cancela se ele não foi usado', async () => {
    assert.equal((await owner('POST', `/api/shop/finance/sales/${useSaleId}/cancel`)).status, 200);
    assert.equal(pack().used, 1);
    assert.equal((await owner('POST', `/api/shop/finance/sales/${packSaleId}/cancel`)).status, 409);
    // Pacote vencido não vale mais.
    run('UPDATE customer_packages SET expires_on = ? WHERE id = ?', ['2020-01-01', pack().id]);
    assert.equal((await sale({ customer_id: joao, items: [{ catalog_item_id: corte, qty: 1, package_id: pack().id }], method: 'pix' })).status, 409);
    assert.equal((await owner('GET', `/api/shop/customers/${joao}/packages`)).data.length, 0);
    assert.equal(pack().status, 'expired');
  });

  test('o cliente vê os pacotes dele e o robô sabe quantos usos sobram', async () => {
    const r = await owner('POST', '/api/shop/packages/sell', { package_id: packageId, customer_id: joao, method: 'dinheiro' });
    assert.equal(r.status, 201);
    const c = makeClient(() => base);
    const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone: '11999990000' });
    await c('POST', '/api/public/shops/navalha/login/verify', { phone: '11999990000', code: asked.data.demoCode });
    const me = (await c('GET', '/api/customer/navalha/me')).data;
    assert.deepEqual(
      me.packages.map((p: { status: string; left: number }) => [p.status, p.left]),
      [
        ['active', 5],
        ['expired', 4],
      ],
    );
    const ctx = buildContext({ shop: shopBot(shopId), phone: '11999990000', waId: null, customer: get('SELECT * FROM customers WHERE id = ?', [joao])!, profileName: null, now: new Date(), dryRun: true } as never);
    assert.match(ctx, /Pacotes pré-pagos \(compra no balcão ou com a equipe\): 5 cortes, R\$\s200,00 por 5 usos/);
    assert.match(ctx, /Pacotes dele: 5 cortes: 5 de 5 usos sobrando/);
    const data = (await owner('GET', `/api/shop/customers/${joao}/export`)).data;
    assert.equal(data.pacotes.length, 2, 'LGPD: a cópia dos dados leva os pacotes');
  });
});

describe('vale-presente', () => {
  test('vender: entra no caixa e sai com o código', async () => {
    assert.equal((await owner('POST', '/api/shop/gift-cards', { amount_cents: 500, method: 'pix' })).status, 400, 'mínimo R$ 10');
    const before = cash('Pacotes e vale-presente');
    const r = await owner('POST', '/api/shop/gift-cards', { amount_cents: 10000, buyer_name: 'Mariana', recipient_name: 'Rafael', message: 'Feliz aniversário!', method: 'credito' });
    assert.equal(r.status, 201);
    code = r.data.card.code;
    assert.match(code, /^VP-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(r.data.card.balance_cents, 10000);
    assert.equal(cash('Pacotes e vale-presente') - before, 10000);
  });

  test('confere o saldo pelo código (o barbeiro vê só o necessário)', async () => {
    const loose = code.replace('VP-', 'vp ').toLowerCase();
    assert.equal((await owner('GET', `/api/shop/gift-cards/${encodeURIComponent(loose)}`)).data.balance_cents, 10000);
    assert.equal((await owner('GET', '/api/shop/gift-cards/VP-ZZZZZZ')).status, 404);
    assert.equal((await otherOwner('GET', `/api/shop/gift-cards/${code}`)).status, 404, 'vale de outra barbearia');
    const b = (await barber('GET', `/api/barber/gift-cards/${code}`)).data;
    assert.deepEqual(Object.keys(b).sort(), ['balance_cents', 'code', 'expires_on', 'status']);
  });

  test('paga a conta até o saldo; o resto vai na forma de pagamento; a comissão não muda', async () => {
    const atend = cash('Atendimentos');
    const r1 = await sale({ customer_id: ana, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo }], gift_code: code, method: 'pix' });
    assert.equal(r1.status, 201, JSON.stringify(r1.data));
    assert.equal(r1.data.sale.total_cents, 5000);
    assert.equal(r1.data.sale.gift_cents, 5000);
    assert.equal(r1.data.sale.items[0].commission_cents, 2000, '40% do corte, pago com o vale');
    assert.equal(cash('Atendimentos'), atend, 'o vale já tinha entrado no caixa');
    // Segunda vez: corte + barba (R$ 80); o vale paga R$ 50 e o resto (R$ 30) entra no PIX.
    const r2 = await sale({ customer_id: ana, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo }, { catalog_item_id: barba, qty: 1, barber_id: paulo }], gift_code: code, method: 'pix' });
    assert.equal(r2.status, 201);
    assert.equal(r2.data.sale.gift_cents, 5000);
    assert.equal(cash('Atendimentos') - atend, 3000);
    const card = (await owner('GET', `/api/shop/gift-cards/${code}`)).data;
    assert.equal(card.balance_cents, 0);
    assert.equal(card.status, 'used');
    assert.equal((await sale({ customer_id: ana, items: [{ catalog_item_id: corte, qty: 1 }], gift_code: code, method: 'pix' })).status, 409, 'sem saldo');

    // Cancelou a segunda venda: os R$ 50 voltam para o vale.
    assert.equal((await owner('POST', `/api/shop/finance/sales/${r2.data.sale.id}/cancel`)).status, 200);
    const back = (await owner('GET', `/api/shop/gift-cards/${code}`)).data;
    assert.equal(back.balance_cents, 5000);
    assert.equal(back.status, 'active');
    assert.equal(all('SELECT 1 FROM gift_card_uses').length, 1);
  });

  test('a lista mostra pacotes e vales vendidos', async () => {
    const r = (await owner('GET', '/api/shop/prepaid')).data;
    assert.equal(r.giftCards.length, 1);
    assert.equal(r.giftCards[0].recipient_name, 'Rafael');
    assert.ok(r.packages.some((p: { customer_name: string; status: string }) => p.customer_name === 'João Pereira' && p.status === 'active'));
  });
});
