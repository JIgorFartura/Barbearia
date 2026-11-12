import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-app-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { encryptPayload, setPushSender, vapidAuth, vapidKeys } = await import('../push.js');
const { renderIndex } = await import('../pwa.js');
const { appointmentReminders } = await import('../automations.js');
const { shopBot } = await import('../messaging.js');
const { book } = await import('../scheduling.js');
const { shopNow } = await import('../clock.js');
const { addDays } = await import('../time.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const barber = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await owner('POST', `/api/shop/barbers/${paulo}/access`, { phone: '11955554444', password: 'paulo-senha-1' });
  await barber('POST', '/api/auth/login', { login: '11955554444', password: 'paulo-senha-1' });
});
after(() => {
  setPushSender(null);
  server.close();
});

const shopId = run(
  "INSERT INTO barbershops (slug, name, bot_name, primary_color, accent_color, reminder_hours, created_at) VALUES ('navalha', 'Navalha & Ouro', 'João', '#1d4ed8', '#fbbf24', 24, ?)",
  [nowIso()],
).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '08:00', '20:00')", [paulo, d]);
run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]);
const ana = run("INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, 'Ana Lima', '11988880000', ?, ?)", [
  shopId,
  nowIso(),
  nowIso(),
]).lastInsertRowid;

/** Um "celular": par de chaves e segredo como o navegador gera, para abrir as mensagens recebidas. */
function device(host = 'fcm.googleapis.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    sub: { endpoint: `https://${host}/fcm/send/${crypto.randomBytes(8).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

/** Abre a mensagem como o navegador (RFC 8291). */
function decrypt(body: Buffer, d: ReturnType<typeof device>): Record<string, string> {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), d.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', d.ecdh.computeSecret(asPublic), d.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  assert.equal(pt[pt.length - 1], 2, 'delimitador de último registro');
  return JSON.parse(pt.subarray(0, pt.length - 1).toString());
}

const sent: { endpoint: string; headers: Record<string, string>; body: Buffer }[] = [];
let status = 201;
setPushSender(async (endpoint, init) => {
  sent.push({ endpoint, ...init });
  return { status };
});
/** Os avisos saem em segundo plano: espera chegarem. */
async function waitSent(n: number) {
  for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, n);
}

const D = addDays(shopNow(shopId).date, 3);
const paulosPhone = device();
const carlosPhone = device('updates.push.services.mozilla.com');
const anasPhone = device('web.push.apple.com');

describe('app instalável e avisos no celular', () => {
  test('criptografia igual ao exemplo da RFC 8291', () => {
    const b = (s: string) => Buffer.from(s, 'base64url');
    const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), b('BTBZMqHH6r4Tts7J_aSIgg'), {
      salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
      serverKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    });
    assert.equal(
      out.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  test('assinatura VAPID válida para o serviço do aviso (e a chave fica guardada)', async () => {
    const key = (await owner('GET', '/api/public/push-key')).data.key;
    assert.equal(key, vapidKeys().publicKey);
    assert.equal(Buffer.from(key, 'base64url').length, 65);
    const header = vapidAuth('https://fcm.googleapis.com/fcm/send/abc');
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    assert.equal(k, key);
    const [h, c, sig] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
    assert.match(claims.sub, /^(mailto:|https:)/);
    const pub = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: Buffer.from(key, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(key, 'base64url').subarray(33).toString('base64url') },
      format: 'jwk',
    });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    assert.ok(get("SELECT 1 AS ok FROM platform_settings WHERE key = 'vapid_jwk'"));
  });

  test('só aceita os serviços de aviso dos navegadores', async () => {
    const evil = device('evil.example.com');
    assert.equal((await barber('POST', '/api/auth/push', evil.sub)).status, 400, 'o servidor não manda nada para endereço qualquer');
    const tricky = device('fcm.googleapis.com.evil.com');
    assert.equal((await barber('POST', '/api/auth/push', tricky.sub)).status, 400);
    assert.equal((await barber('POST', '/api/auth/push', { ...paulosPhone.sub, keys: { p256dh: 'abc', auth: 'x' } })).status, 400);
    assert.equal((await makeClient(() => base)('POST', '/api/auth/push', paulosPhone.sub)).status, 401);

    assert.equal((await barber('POST', '/api/auth/push', paulosPhone.sub)).status, 200);
    assert.equal((await owner('POST', '/api/auth/push', carlosPhone.sub)).status, 200);
    const c = makeClient(() => base);
    const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone: '11988880000' });
    await c('POST', '/api/public/shops/navalha/login/verify', { phone: '11988880000', code: asked.data.demoCode });
    assert.equal((await c('POST', '/api/customer/navalha/push', anasPhone.sub)).status, 200);
  });

  test('horário marcado pelo cliente avisa o barbeiro e o dono; pelo balcão, só o barbeiro', async () => {
    sent.length = 0;
    const a = book({ shopId, customerId: ana, barberId: paulo, date: D, time: '15:00', source: 'cliente' });
    await waitSent(2);
    assert.deepEqual(sent.map((s) => s.endpoint).sort(), [paulosPhone.sub.endpoint, carlosPhone.sub.endpoint].sort());
    const msg = decrypt(sent.find((s) => s.endpoint === paulosPhone.sub.endpoint)!.body, paulosPhone);
    assert.equal(msg.title, `Novo horário · ${D.slice(8, 10)}/${D.slice(5, 7)} às 15:00`);
    assert.equal(msg.body, 'Ana Lima com Paulo (Corte)');
    assert.equal(msg.tag, `horario-${a.id}`);
    const h = sent[0].headers;
    assert.equal(h['content-encoding'], 'aes128gcm');
    assert.match(h.authorization, /^vapid t=/);

    sent.length = 0;
    book({ shopId, customerId: ana, barberId: paulo, date: D, time: '17:00', source: 'painel' });
    await waitSent(1);
    assert.equal(sent[0].endpoint, paulosPhone.sub.endpoint);

    sent.length = 0;
    const c = makeClient(() => base);
    const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone: '11988880000' });
    await c('POST', '/api/public/shops/navalha/login/verify', { phone: '11988880000', code: asked.data.demoCode });
    assert.equal((await c('POST', `/api/customer/navalha/appointments/${a.id}/cancel`)).status, 200);
    await waitSent(2);
    assert.match(decrypt(sent.find((s) => s.endpoint === carlosPhone.sub.endpoint)!.body, carlosPhone).title, /^Horário cancelado/);
  });

  test('o cliente recebe o lembrete no celular; aparelho que não existe mais sai da lista', async () => {
    sent.length = 0;
    const lead = book({ shopId, customerId: ana, barberId: paulo, date: D, time: '10:00', source: 'painel' });
    await waitSent(1);
    sent.length = 0;
    await appointmentReminders(shopBot(shopId), new Date(`${addDays(D, -1)}T12:00:00-03:00`));
    await waitSent(1);
    const msg = decrypt(sent[0].body, anasPhone);
    assert.equal(msg.title, 'Navalha & Ouro');
    assert.match(msg.body, /^Lembrete: seu horário é amanhã .* com Paulo\. Toque para confirmar\.$/);
    assert.equal(msg.url, '/b/navalha/conta');
    assert.equal(msg.tag, `lembrete-${lead.id}`);

    // O celular do Paulo desinstalou o app: o serviço responde 410 e a inscrição sai.
    status = 410;
    sent.length = 0;
    book({ shopId, customerId: ana, barberId: paulo, date: D, time: '11:00', source: 'painel' });
    await waitSent(1);
    assert.equal(get('SELECT 1 AS ok FROM push_subscriptions WHERE endpoint = ?', [paulosPhone.sub.endpoint]), undefined);
    status = 201;
  });

  test('cada barbearia instala como o app dela (nome, cores e ícone)', async () => {
    const m = await owner('GET', '/b/navalha/manifest.webmanifest');
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type') ?? '', /application\/manifest\+json/);
    assert.equal(m.data.name, 'Navalha & Ouro');
    assert.equal(m.data.start_url, '/b/navalha/conta');
    assert.equal(m.data.scope, '/b/navalha/');
    assert.equal(m.data.theme_color, '#1d4ed8');
    assert.deepEqual(
      m.data.icons.map((i: { src: string; purpose: string }) => [i.src, i.purpose]),
      [
        ['/b/navalha/icons/192.png', 'any'],
        ['/b/navalha/icons/512.png', 'any'],
        ['/b/navalha/icons/maskable.png', 'maskable'],
      ],
    );
    assert.equal((await owner('GET', '/manifest.webmanifest')).data.start_url, '/');
    assert.equal((await owner('GET', '/b/nao-existe/manifest.webmanifest')).status, 404);

    const icon = await fetch(`${base}/b/navalha/icons/192.png`);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await icon.arrayBuffer());
    assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.equal(png.readUInt32BE(16), 192, 'largura');
    assert.equal(png.readUInt32BE(20), 192, 'altura');
    assert.equal((await fetch(`${base}/icons/maskable.png`)).status, 200);
    assert.equal((await fetch(`${base}/icons/999.png`)).status, 404);

    const file = path.join(process.env.DATA_DIR!, 'index.html');
    fs.writeFileSync(file, '<html><head><meta name="theme-color" content="#111827" /><title>Sistema Barbearia</title></head><body></body></html>');
    const shopPage = renderIndex(file, '/b/navalha/conta');
    assert.match(shopPage, /<link rel="manifest" href="\/b\/navalha\/manifest\.webmanifest" \/>/);
    assert.match(shopPage, /<link rel="apple-touch-icon" href="\/b\/navalha\/icons\/apple\.png" \/>/);
    assert.match(shopPage, /<meta name="theme-color" content="#1d4ed8" \/>/);
    assert.match(shopPage, /<title>Navalha &amp; Ouro<\/title>/);
    const panel = renderIndex(file, '/painel/agenda');
    assert.match(panel, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
    assert.match(panel, /<title>Sistema Barbearia<\/title>/);
  });

  test('LGPD: a exclusão da conta tira os avisos do celular do cliente', async () => {
    const c = makeClient(() => base);
    const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone: '11988880000' });
    await c('POST', '/api/public/shops/navalha/login/verify', { phone: '11988880000', code: asked.data.demoCode });
    assert.ok(get('SELECT 1 AS ok FROM push_subscriptions WHERE customer_id = ?', [ana]));
    assert.equal((await c('POST', '/api/customer/navalha/delete-account', { confirm: 'EXCLUIR' })).status, 200);
    assert.equal(get('SELECT 1 AS ok FROM push_subscriptions WHERE customer_id = ?', [ana]), undefined);
  });
});
