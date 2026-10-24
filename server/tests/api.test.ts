import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Banco em memória e pasta temporária, antes de carregar o servidor.
process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-test-'));

const { app } = await import('../index.js');
const { progressFor, isRunning } = await import('../loyalty.js');

let server: Server;
let base = '';

/** Cliente HTTP com cookie de sessão próprio (simula um navegador). */
function client() {
  let cookie = '';
  return async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* texto puro */
    }
    return { status: res.status, data, headers: res.headers };
  };
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe('regras do cartão fidelidade', () => {
  test('a cada N carimbos libera um prêmio e o cartão recomeça', () => {
    assert.deepEqual(progressFor(5, 0, 0), { earned: 0, redeemed: 0, goal: 5, stamps: 0, available: 0 });
    assert.deepEqual(progressFor(5, 4, 0), { earned: 4, redeemed: 0, goal: 5, stamps: 4, available: 0 });
    assert.deepEqual(progressFor(5, 7, 0), { earned: 7, redeemed: 0, goal: 5, stamps: 2, available: 1 });
    assert.deepEqual(progressFor(5, 10, 1), { earned: 10, redeemed: 1, goal: 5, stamps: 0, available: 1 });
  });

  test('campanha vale só dentro do período e quando ativa', () => {
    const c = { active: 1, starts_on: '2026-10-01', ends_on: '2026-10-31' };
    assert.equal(isRunning(c, '2026-10-15'), true);
    assert.equal(isRunning(c, '2026-09-30'), false);
    assert.equal(isRunning(c, '2026-11-01'), false);
    assert.equal(isRunning({ ...c, active: 0 }, '2026-10-15'), false);
    assert.equal(isRunning({ active: 1, starts_on: null, ends_on: null }, '2030-01-01'), true);
  });
});

describe('fluxo completo pela API', () => {
  const master = client();
  const ze = client();
  const outro = client();
  const visitante = client();
  let campaignId = 0;
  let customerId = 0;

  test('primeiro acesso cria o master; depois não deixa criar de novo', async () => {
    assert.equal((await master('GET', '/api/auth/me')).data.setupNeeded, true);
    const r = await master('POST', '/api/auth/setup', { name: 'Igor', email: 'igor@exemplo.com', password: 'senha-forte-1' });
    assert.equal(r.status, 201);
    assert.equal((await master('POST', '/api/auth/setup', { name: 'X', email: 'x@exemplo.com', password: 'senha-forte-1' })).status, 409);
    assert.equal((await master('GET', '/api/auth/me')).data.user.role, 'master');
  });

  test('master cadastra duas barbearias com seus donos', async () => {
    const base = { ownerName: 'Dono', ownerPassword: 'senha-forte-1' };
    assert.equal((await master('POST', '/api/master/shops', { ...base, name: 'Barbearia do Zé', slug: 'barbearia-do-ze', ownerEmail: 'ze@exemplo.com' })).status, 201);
    assert.equal((await master('POST', '/api/master/shops', { ...base, name: 'Outra', slug: 'outra', ownerEmail: 'outra@exemplo.com' })).status, 201);
    const dup = await master('POST', '/api/master/shops', { ...base, name: 'Copia', slug: 'barbearia-do-ze', ownerEmail: 'y@exemplo.com' });
    assert.equal(dup.status, 409);
    assert.equal((await ze('POST', '/api/auth/login', { email: 'ze@exemplo.com', password: 'senha-forte-1' })).status, 200);
    assert.equal((await outro('POST', '/api/auth/login', { email: 'outra@exemplo.com', password: 'senha-forte-1' })).status, 200);
  });

  test('dono não acessa o painel master', async () => {
    assert.equal((await ze('GET', '/api/master/shops')).status, 403);
  });

  test('dono cria campanha "tomou 5 cervejas, ganhou um copo" e lança consumo', async () => {
    const c = await ze('POST', '/api/shop/campaigns', {
      name: 'Cerveja da casa',
      unit_label: 'cerveja',
      goal: 5,
      reward: 'Copo personalizado',
      active: true,
    });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    campaignId = c.data.id;

    const cu = await ze('POST', '/api/shop/customers', { name: 'João da Silva', phone: '(11) 98888-7777' });
    assert.equal(cu.status, 201);
    customerId = cu.data.id;
    assert.equal(cu.data.phone, '11988887777');

    assert.equal((await ze('POST', '/api/shop/loyalty/redeem', { campaignId, customerId })).status, 400);
    const p = await ze('POST', '/api/shop/loyalty/earn', { campaignId, customerId, qty: 6 });
    assert.deepEqual(p.data, { earned: 6, redeemed: 0, goal: 5, stamps: 1, available: 1 });
    const r = await ze('POST', '/api/shop/loyalty/redeem', { campaignId, customerId });
    assert.equal(r.data.available, 0);
  });

  test('uma barbearia não enxerga nem mexe nos dados da outra', async () => {
    assert.deepEqual((await outro('GET', '/api/shop/campaigns')).data, []);
    assert.deepEqual((await outro('GET', '/api/shop/customers')).data, []);
    assert.equal((await outro('POST', '/api/shop/loyalty/earn', { campaignId, customerId, qty: 1 })).status, 404);
    assert.equal((await outro('PUT', `/api/shop/campaigns/${campaignId}`, { name: 'Invasão', unit_label: 'x', goal: 1, reward: 'xx', active: true })).status, 404);
    assert.equal((await outro('DELETE', `/api/shop/campaigns/${campaignId}`)).status, 404);
  });

  test('anúncio de parceiro aparece na landing e conta views e cliques', async () => {
    const partner = await ze('POST', '/api/shop/partners', { name: 'Hamburgueria Brasa', benefit: '10% para membros', active: true });
    assert.equal(partner.status, 201);
    const bad = await ze('POST', '/api/shop/ads', { title: 'Promo', placement: 'destaque', price_cents: 0, active: true, link_url: 'javascript:alert(1)' });
    assert.equal(bad.status, 400);
    const ad = await ze('POST', '/api/shop/ads', {
      partner_id: partner.data.id,
      title: 'Combo do mês',
      placement: 'destaque',
      price_cents: 15000,
      link_url: 'https://exemplo.com/brasa',
      active: true,
    });
    assert.equal(ad.status, 201);

    // Parceiro de outra barbearia não pode ser usado.
    const foreign = await outro('POST', '/api/shop/ads', { partner_id: partner.data.id, title: 'x', placement: 'mural', price_cents: 0, active: true });
    assert.equal(foreign.status, 400);

    const page = await visitante('GET', '/api/public/shops/barbearia-do-ze');
    assert.equal(page.status, 200);
    assert.equal(page.data.ads[0].title, 'Combo do mês');
    assert.equal(page.data.ads[0].partner, 'Hamburgueria Brasa');
    assert.equal(page.data.ads[0].link_url, undefined, 'link só via redirecionamento com contagem');
    assert.equal(page.data.campaigns[0].reward, 'Copo personalizado');

    const click = await visitante('GET', `/api/public/ads/${ad.data.id}/click`);
    assert.equal(click.status, 302);
    assert.equal(click.headers.get('location'), 'https://exemplo.com/brasa');

    const summary = await ze('GET', '/api/shop/summary');
    assert.equal(summary.data.adViews, 1);
    assert.equal(summary.data.adClicks, 1);
    assert.equal(summary.data.adRevenueCents, 15000);
    assert.equal(summary.data.stampsThisMonth, 6);
    assert.equal(summary.data.rewardsThisMonth, 1);
  });

  test('o site público não expõe configurações internas da barbearia', async () => {
    const page = await visitante('GET', '/api/public/shops/barbearia-do-ze');
    for (const key of ['wa_config', 'webhook_token', 'bot_persona', 'wa_provider', 'id']) assert.equal(key in page.data.shop, false, key);
    assert.equal(page.data.loggedIn, false);
  });

  test('cliente entra na área logada com o código do WhatsApp e vê o próprio cartão', async () => {
    const cliente = client();
    const code = await cliente('POST', '/api/public/shops/barbearia-do-ze/login/code', { phone: '11 98888 7777' });
    assert.equal(code.status, 200, JSON.stringify(code.data));
    assert.match(code.data.demoCode, /^\d{6}$/, 'sem WhatsApp conectado, o código aparece em modo demonstração');
    assert.equal((await cliente('POST', '/api/public/shops/barbearia-do-ze/login/verify', { phone: '11988887777', code: '000000' })).status, 400);
    const ok = await cliente('POST', '/api/public/shops/barbearia-do-ze/login/verify', { phone: '11988887777', code: code.data.demoCode });
    assert.equal(ok.status, 200);
    const me = await cliente('GET', '/api/customer/barbearia-do-ze/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.customer.name, 'João da Silva');
    assert.equal(me.data.card[0].progress.stamps, 1);
    // A sessão vale só para esta barbearia.
    assert.equal((await cliente('GET', '/api/customer/outra/me')).status, 401);
    assert.equal((await visitante('GET', '/api/customer/barbearia-do-ze/me')).status, 401);
    // Celular novo precisa do nome para criar a conta.
    const novo = await visitante('POST', '/api/public/shops/barbearia-do-ze/login/code', { phone: '11977776666' });
    assert.equal(novo.status, 404);
    assert.equal(novo.data.needsName, true);
  });

  test('visitante sem login não acessa o painel', async () => {
    assert.equal((await visitante('GET', '/api/shop/customers')).status, 401);
  });
});
