import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-pagamentos-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { handleInbound } = await import('../bot/inbound.js');
const { purgeOldData } = await import('../privacy.js');
const { receiptsDir } = await import('../receipts.js');
const { shopNow } = await import('../clock.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const master = makeClient(() => base);
const barber = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
});
after(() => server.close());

const shopId = run(
  "INSERT INTO barbershops (slug, name, bot_name, pix_key, pix_name, pix_city, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'pix@navalha.com.br', 'Navalha', 'Sao Paulo', ?)",
  [nowIso()],
).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', '11977776666', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
run("INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('master', 'Igor', 'igor@exemplo.com', ?, ?)", [hashPassword('senha-forte-1'), nowIso()]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, service_commission, created_at) VALUES (?, 'Paulo', 40, ?)", [shopId, nowIso()]).lastInsertRowid;
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

// Arquivos de verdade (o servidor confere o tipo pelo conteúdo).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const dataUrl = (bytes: Buffer, type: string) => `data:${type};base64,${bytes.toString('base64')}`;
const receiptOf = (chargeId: number) => get<{ receipt_file: string | null; receipt_type: string | null; claimed_at: string | null }>(
  'SELECT receipt_file, receipt_type, claimed_at FROM charges WHERE id = ?',
  [chargeId],
)!;
const notices = () => get<{ n: number }>("SELECT COUNT(*) AS n FROM platform_messages WHERE kind = 'alerta' AND body LIKE '%Comprovante de PIX%'")!.n;

let chargeId = 0;
const today = () => shopNow(shopId).date;

describe('cada um vê só o que é seu, e o comprovante do PIX', () => {
  test('o cliente manda o comprovante do PIX do clube: vale como "já paguei" e o dono recebe o aviso', async () => {
    const plan = await owner('POST', '/api/shop/club/plans', { name: 'Ouro', price_cents: 9990, uses_per_month: null, item_ids: [corte] });
    const c = await enter('11999990000');
    const sub = (await c('POST', '/api/customer/navalha/club/subscribe', { plan_id: plan.data.id })).data;
    chargeId = sub.charge.id;
    assert.equal(sub.charge.receipt, null);

    // Arquivo que não é foto nem PDF (mesmo dizendo que é imagem): recusado.
    const fake = await c('POST', `/api/customer/navalha/club/charges/${chargeId}/receipt`, { dataUrl: dataUrl(Buffer.from('<svg onload="alert(1)"/>'), 'image/png') });
    assert.equal(fake.status, 400);
    const big = await c('POST', `/api/customer/navalha/club/charges/${chargeId}/receipt`, {
      dataUrl: dataUrl(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'image/png'),
    });
    assert.equal(big.status, 400);

    const r = await c('POST', `/api/customer/navalha/club/charges/${chargeId}/receipt`, { dataUrl: dataUrl(PNG, 'image/png') });
    assert.equal(r.status, 200);
    assert.equal(r.data.charge.claimed, true, 'vale como "já paguei"');
    assert.equal(r.data.charge.receipt.type, 'image/png');
    assert.equal(r.data.member.state, 'ok', 'o clube já vale enquanto a barbearia confere');
    const saved = receiptOf(chargeId);
    assert.ok(saved.claimed_at);
    assert.deepEqual(fs.readFileSync(path.join(receiptsDir, saved.receipt_file!)), PNG);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(notices(), 1, 'o dono recebe o aviso no WhatsApp');
    const body = get<{ body: string }>("SELECT body FROM platform_messages WHERE body LIKE '%Comprovante de PIX%' ORDER BY id DESC LIMIT 1")!.body;
    assert.match(body, /João Pereira pagou R\$\s?99,90/);
    assert.match(body, /\/painel\?conferir=1/);

    // Trocou o arquivo logo depois: o antigo é apagado e o dono não é avisado de novo.
    const again = await c('POST', `/api/customer/navalha/club/charges/${chargeId}/receipt`, { dataUrl: dataUrl(PDF, 'application/pdf') });
    assert.equal(again.data.charge.receipt.type, 'application/pdf');
    assert.equal(fs.existsSync(path.join(receiptsDir, saved.receipt_file!)), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(notices(), 1);
  });

  test('só o próprio cliente e a barbearia abrem o comprovante', async () => {
    const mine = await (await enter('11999990000'))('GET', `/api/customer/navalha/charges/${chargeId}/receipt`);
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'application/pdf');
    assert.match(mine.headers.get('content-disposition') ?? '', /^attachment/, 'PDF baixa, não abre no site');
    assert.equal(mine.headers.get('x-content-type-options'), 'nosniff');
    assert.match(mine.headers.get('cache-control') ?? '', /no-store/);

    const other = await enter('11988880000');
    assert.equal((await other('GET', `/api/customer/navalha/charges/${chargeId}/receipt`)).status, 404, 'outro cliente não vê');
    assert.equal((await other('POST', `/api/customer/navalha/club/charges/${chargeId}/receipt`, { dataUrl: dataUrl(PNG, 'image/png') })).status, 404);
    assert.equal((await makeClient(() => base)('GET', `/api/customer/navalha/charges/${chargeId}/receipt`)).status, 401);

    const copy = await owner('GET', `/api/shop/charges/${chargeId}/receipt`);
    assert.equal(copy.status, 200, 'a barbearia recebe a cópia');
    const toConfirm = (await owner('GET', '/api/shop/charges/to-confirm')).data;
    assert.equal(toConfirm.length, 1);
    assert.equal(toConfirm[0].receipt.type, 'application/pdf');
    assert.equal(toConfirm[0].receipt_file, undefined, 'o nome do arquivo guardado não vai para a tela');
    assert.equal((await owner('GET', '/api/shop/status')).data.receiptsToConfirm, 1);

    assert.equal((await master('GET', `/api/shop/charges/${chargeId}/receipt`)).status, 403, 'o master não vê');
    await owner('POST', `/api/shop/barbers/${paulo}/access`, { phone: '11955554444', password: 'paulo-senha-1' });
    await barber('POST', '/api/auth/login', { login: '11955554444', password: 'paulo-senha-1' });
    assert.equal((await barber('GET', `/api/shop/charges/${chargeId}/receipt`)).status, 403, 'o barbeiro não vê');
  });

  test('"não caiu": o comprovante sai junto com o aviso; depois de confirmado, fica como cópia nos recebimentos', async () => {
    const file = receiptOf(chargeId).receipt_file!;
    await owner('POST', `/api/shop/charges/${chargeId}/reject`);
    assert.deepEqual(receiptOf(chargeId), { receipt_file: null, receipt_type: null, claimed_at: null });
    assert.equal(fs.existsSync(path.join(receiptsDir, file)), false);

    const c = await enter('11999990000');
    await c('POST', `/api/customer/navalha/club/charges/${chargeId}/receipt`, { dataUrl: dataUrl(PNG, 'image/png') });
    const shown = await owner('GET', `/api/shop/charges/${chargeId}/receipt`);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.match(shown.headers.get('content-disposition') ?? '', /^inline/, 'a foto abre na tela');
    assert.equal((await owner('POST', `/api/shop/charges/${chargeId}/confirm`, { method: 'pix' })).status, 200);
    assert.equal((await c('POST', `/api/customer/navalha/club/charges/${chargeId}/receipt`, { dataUrl: dataUrl(PNG, 'image/png') })).status, 409, 'pago não troca');

    // Vendas no balcão: uma do João e uma da Ana.
    await owner('POST', '/api/shop/finance/sales', { customer_id: joao, items: [{ catalog_item_id: corte, qty: 1, barber_id: paulo }], method: 'dinheiro' });
    await owner('POST', '/api/shop/finance/sales', { customer_id: ana, items: [{ catalog_item_id: corte, qty: 2, barber_id: paulo }], method: 'credito' });

    const rec = (await owner('GET', `/api/shop/finance/received?from=${today()}&to=${today()}`)).data;
    assert.deepEqual(rec.totals, { total: 9990 + 5000 + 10000, count: 3, counter: 15000, club: 9990, receipts: 1 });
    const club = rec.items.find((i: { kind: string }) => i.kind === 'clube');
    assert.equal(club.customer, 'João Pereira');
    assert.equal(club.method, 'pix');
    assert.equal(club.receipt.type, 'image/png');
    assert.ok(rec.items.some((i: { customer: string; description: string }) => i.customer === 'Ana Lima' && i.description === '2× Corte'));
  });

  test('o cliente vê só os pagamentos dele; o barbeiro, só a parte dele; o master, nenhum', async () => {
    const me = (await (await enter('11999990000'))('GET', '/api/customer/navalha/me')).data;
    assert.equal(me.purchases, undefined);
    assert.deepEqual(
      me.payments.map((p: { kind: string; amount_cents: number; status: string; method: string }) => [p.kind, p.amount_cents, p.status, p.method]).sort(),
      [
        ['clube', 9990, 'paid', 'pix'],
        ['compra', 5000, 'paid', 'dinheiro'],
      ],
    );
    assert.ok(!JSON.stringify(me.payments).includes('Ana'), 'nada da Ana');
    assert.equal(me.payments.find((p: { kind: string }) => p.kind === 'clube').receipt.type, 'image/png');

    const earnings = (await barber('GET', `/api/barber/earnings?from=${today()}&to=${today()}`)).data;
    assert.equal(earnings.commission, 2000 + 4000, '40% dos cortes dele');
    assert.equal(earnings.revenue, undefined);
    assert.ok(earnings.items.every((i: Record<string, unknown>) => !('total_cents' in i)));
    assert.equal((await barber('GET', `/api/shop/finance/received?from=${today()}&to=${today()}`)).status, 403);

    assert.equal((await master('GET', `/api/shop/finance/received?from=${today()}&to=${today()}`)).status, 403);
    const payments = (await master('GET', `/api/master/payments?from=${today()}&to=${today()}`)).data;
    assert.deepEqual(payments.items, [], 'o que os clientes pagam à barbearia não aparece para o master');
  });

  test('no WhatsApp: foto (o robô só lê texto) e "paguei" levam ao envio do comprovante pela área', async () => {
    const plan = get<{ id: number }>('SELECT id FROM club_plans LIMIT 1')!;
    const c = await enter('11988880000');
    const sub = (await c('POST', '/api/customer/navalha/club/subscribe', { plan_id: plan.id })).data;
    const photo = await handleInbound({ shopId, from: '5511988880000', text: '', dryRun: true });
    assert.match(photo!, /comprovante do PIX do clube, mande pela sua área/);
    assert.match(photo!, /\/b\/navalha\/conta\?t=/);
    const paid = await handleInbound({ shopId, from: '5511988880000', text: 'paguei', dryRun: true });
    assert.match(paid!, /Anotado, Ana!/);
    assert.match(paid!, /mande o comprovante pela sua área/);
    assert.ok(receiptOf(sub.charge.id).claimed_at);
    // Sem nada em aberto, a resposta de sempre.
    const none = await handleInbound({ shopId, from: '5511966665555', text: '', dryRun: true });
    assert.match(none!, /só entendo mensagens de texto/);
  });

  test('LGPD: o comprovante sai na exclusão da conta e depois de 12 meses', async () => {
    // Comprovante antigo (mais de um ano): a limpeza diária apaga o arquivo; o pagamento continua registrado.
    const ana2 = get<{ id: number }>("SELECT id FROM charges WHERE customer_id = ? AND status = 'open'", [ana])!.id;
    const c = await enter('11988880000');
    await c('POST', `/api/customer/navalha/club/charges/${ana2}/receipt`, { dataUrl: dataUrl(PNG, 'image/png') });
    const oldFile = receiptOf(ana2).receipt_file!;
    run('UPDATE charges SET receipt_at = ? WHERE id = ?', [new Date(Date.now() - 400 * 86400000).toISOString(), ana2]);
    const r = purgeOldData(new Date());
    assert.equal(r.receipts, 1);
    assert.equal(fs.existsSync(path.join(receiptsDir, oldFile)), false);
    assert.equal(receiptOf(ana2).receipt_file, null);

    // O João exclui a conta: o comprovante dele é apagado.
    const joaoFile = receiptOf(chargeId).receipt_file!;
    assert.ok(fs.existsSync(path.join(receiptsDir, joaoFile)));
    const j = await enter('11999990000');
    const exported = (await j('GET', '/api/customer/navalha/my-data')).data;
    assert.ok(exported.cobrancas.some((x: { comprovante_enviado_em: string | null }) => x.comprovante_enviado_em), 'a cópia dos dados mostra o comprovante');
    assert.equal((await j('POST', '/api/customer/navalha/delete-account', { confirm: 'EXCLUIR' })).status, 200);
    assert.equal(fs.existsSync(path.join(receiptsDir, joaoFile)), false);
    assert.equal(receiptOf(chargeId).receipt_file, null);
  });
});
