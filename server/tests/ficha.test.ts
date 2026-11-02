import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-ficha-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_LOGIN_CODES = '1';

const { app } = await import('../index.js');
const { all, get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { addPhoto, photosDir } = await import('../profile.js');
const { book } = await import('../scheduling.js');
const { shopNow } = await import('../clock.js');
const { addDays } = await import('../time.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
const master = makeClient(() => base);
const paulo = makeClient(() => base);
const otherOwner = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
  await master('POST', '/api/auth/login', { login: 'igor@exemplo.com', password: 'senha-forte-1' });
  await otherOwner('POST', '/api/auth/login', { login: 'rita@tesoura.com', password: 'senha-forte-1' });
  await owner('POST', `/api/shop/barbers/${pauloId}/access`, { phone: '11955554444', password: 'paulo-senha-1' });
  await paulo('POST', '/api/auth/login', { login: '11955554444', password: 'paulo-senha-1' });
});
after(() => server.close());

const user = (shop: number | null, role: string, name: string, email: string) =>
  run('INSERT INTO users (barbershop_id, role, name, email, password_hash, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    shop,
    role,
    name,
    email,
    hashPassword('senha-forte-1'),
    nowIso(),
    nowIso(),
  ]);
const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
const otherShop = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('tesoura', 'Tesoura Fina', 'Zé', ?)", [nowIso()]).lastInsertRowid;
user(shopId, 'owner', 'Carlos', 'carlos@navalha.com');
user(otherShop, 'owner', 'Rita', 'rita@tesoura.com');
user(null, 'master', 'Igor', 'igor@exemplo.com');
const barber = (name: string) => {
  const id = run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shopId, name, nowIso()]).lastInsertRowid;
  for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [id, d]);
  return id;
};
const pauloId = barber('Paulo');
const marcosId = barber('Marcos');
const corte = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [
  shopId,
  nowIso(),
]).lastInsertRowid;
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, name, phone, nowIso(), nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const ana = customer('Ana Lima', '11988880000');

const D = addDays(shopNow(shopId).date, 2);
const joaoAppt = book({ shopId, customerId: joao, barberId: pauloId, serviceId: corte, date: D, time: '10:00', source: 'painel' }).id;
const anaAppt = book({ shopId, customerId: ana, barberId: marcosId, serviceId: corte, date: D, time: '10:00', source: 'painel' }).id;

/** Basta o começo do arquivo para o servidor reconhecer o JPG. */
const jpg = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(label)]);
const dataUrl = (bytes: Buffer, type = 'image/jpeg') => `data:${type};base64,${bytes.toString('base64')}`;
const photo = (label: string) => ({ dataUrl: dataUrl(jpg(label)), thumbUrl: dataUrl(jpg(`${label}-mini`)) });
const files = () => fs.readdirSync(photosDir).sort();
const fileOf = (id: number) => get<{ file: string; thumb: string | null }>('SELECT file, thumb FROM cut_photos WHERE id = ?', [id])!;

async function enter(phone: string) {
  const c = makeClient(() => base);
  const asked = await c('POST', '/api/public/shops/navalha/login/code', { phone });
  await c('POST', '/api/public/shops/navalha/login/verify', { phone, code: asked.data.demoCode });
  return c;
}

let ownerPhoto = 0;
let pauloPhoto = 0;

describe('ficha do cliente', () => {
  test('o dono anota o jeito que o cliente gosta e tira a foto do corte; aparece no cartão do horário', async () => {
    const saved = await owner('PUT', `/api/shop/customers/${joao}/notes`, { notes: '  Máquina 2 nas laterais, tesoura em cima  ' });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.notes, 'Máquina 2 nas laterais, tesoura em cima');

    const bad = await owner('POST', `/api/shop/customers/${joao}/photos`, { dataUrl: dataUrl(Buffer.from('<svg onload="alert(1)"/>')) });
    assert.equal(bad.status, 400, 'só foto de verdade (o tipo é conferido pelo conteúdo)');
    const pdf = await owner('POST', `/api/shop/customers/${joao}/photos`, { dataUrl: dataUrl(Buffer.from('%PDF-1.4 x'), 'application/pdf') });
    assert.equal(pdf.status, 400, 'PDF não é foto do corte');

    const r = await owner('POST', `/api/shop/customers/${joao}/photos`, { ...photo('corte-1'), appointment_id: joaoAppt, note: 'Degradê navalhado' });
    assert.equal(r.status, 201);
    assert.equal(r.data.photos.length, 1);
    ownerPhoto = r.data.photos[0].id;
    assert.equal(r.data.photos[0].barber_name, 'Paulo', 'foto do horário fica com o barbeiro do horário');
    assert.equal(r.data.photos[0].note, 'Degradê navalhado');
    assert.equal(r.data.photos[0].can_delete, true);
    assert.equal(r.data.photos[0].file, undefined, 'o nome do arquivo guardado não vai para a tela');

    const full = await owner('GET', `/api/shop/photos/${ownerPhoto}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'image/jpeg');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.match(full.headers.get('cache-control') ?? '', /no-store/);
    assert.match(full.headers.get('content-disposition') ?? '', /^inline/);
    assert.match(String(full.data), /corte-1$/);
    assert.match(String((await owner('GET', `/api/shop/photos/${ownerPhoto}?mini=1`)).data), /corte-1-mini$/, 'a miniatura para o cartão');

    const agenda = (await owner('GET', `/api/shop/agenda?date=${D}`)).data;
    const card = agenda.appointments.find((a: { id: number }) => a.id === joaoAppt);
    assert.deepEqual(card.profile, { notes: 'Máquina 2 nas laterais, tesoura em cima', photos: 1, lastPhotoId: ownerPhoto });
    assert.deepEqual(agenda.appointments.find((a: { id: number }) => a.id === anaAppt).profile, { notes: null, photos: 0, lastPhotoId: null });
  });

  test('o barbeiro vê e anota a ficha só de quem é da agenda dele, e apaga só a foto que ele tirou', async () => {
    const ficha = await paulo('GET', `/api/barber/customers/${joao}/profile`);
    assert.equal(ficha.status, 200);
    assert.equal(ficha.data.notes, 'Máquina 2 nas laterais, tesoura em cima');
    assert.equal(ficha.data.photos[0].can_delete, false, 'a foto do dono ele não apaga');
    assert.equal((await paulo('GET', `/api/barber/customers/${ana}/profile`)).status, 404, 'a Ana é cliente do Marcos');
    assert.equal((await paulo('PUT', `/api/barber/customers/${ana}/notes`, { notes: 'x' })).status, 404);
    assert.equal((await paulo('POST', `/api/barber/customers/${ana}/photos`, photo('ana'))).status, 404);

    const linkedToOther = await paulo('POST', `/api/barber/customers/${joao}/photos`, { ...photo('x'), appointment_id: anaAppt });
    assert.equal(linkedToOther.status, 404, 'não liga a foto a horário de outro barbeiro');

    const r = await paulo('POST', `/api/barber/customers/${joao}/photos`, { ...photo('corte-2'), appointment_id: joaoAppt });
    assert.equal(r.status, 201);
    pauloPhoto = r.data.photos[0].id;
    assert.deepEqual(
      r.data.photos.map((p: { id: number; can_delete: boolean }) => [p.id, p.can_delete]),
      [
        [pauloPhoto, true],
        [ownerPhoto, false],
      ],
      'a mais nova primeiro',
    );
    assert.equal((await paulo('GET', `/api/barber/photos/${ownerPhoto}?mini=1`)).status, 200, 'vê as fotos dos colegas do mesmo cliente');

    const notes = await paulo('PUT', `/api/barber/customers/${joao}/notes`, { notes: 'Máquina 2 nas laterais, tesoura em cima. Pomada matte.' });
    assert.equal(notes.data.notes, 'Máquina 2 nas laterais, tesoura em cima. Pomada matte.');

    assert.equal((await paulo('DELETE', `/api/barber/photos/${ownerPhoto}`)).status, 403);
    const agenda = (await paulo('GET', `/api/barber/agenda?date=${D}`)).data;
    assert.equal(agenda.appointments[0].profile.photos, 2);
    assert.equal(agenda.appointments[0].profile.lastPhotoId, pauloPhoto);

    // Foto da Ana (cliente do Marcos): o Paulo não abre.
    const anaPhoto = (await owner('POST', `/api/shop/customers/${ana}/photos`, photo('ana'))).data.photos[0].id;
    assert.equal((await paulo('GET', `/api/barber/photos/${anaPhoto}`)).status, 404);
    assert.equal((await owner('DELETE', `/api/shop/photos/${anaPhoto}`)).status, 200);
  });

  test('o master e as outras barbearias não veem a ficha', async () => {
    assert.equal((await master('GET', `/api/shop/customers/${joao}/profile`)).status, 403);
    assert.equal((await master('GET', `/api/shop/photos/${ownerPhoto}`)).status, 403);
    assert.equal((await otherOwner('GET', `/api/shop/customers/${joao}/profile`)).status, 404);
    assert.equal((await otherOwner('GET', `/api/shop/photos/${ownerPhoto}`)).status, 404);
    assert.equal((await otherOwner('DELETE', `/api/shop/photos/${ownerPhoto}`)).status, 404);
  });

  test('o cliente vê as fotos dele em Meus cortes (sem as anotações internas) e pode apagar', async () => {
    const c = await enter('11999990000');
    const me = (await c('GET', '/api/customer/navalha/me')).data;
    assert.deepEqual(
      me.photos.map((p: Record<string, unknown>) => Object.keys(p).sort()),
      [
        ['barber_name', 'created_at', 'id', 'note'],
        ['barber_name', 'created_at', 'id', 'note'],
      ],
    );
    assert.equal(me.customer.notes, undefined);
    assert.equal((await c('GET', `/api/customer/navalha/photos/${ownerPhoto}`)).status, 200);

    const ana = await enter('11988880000');
    assert.equal((await ana('GET', `/api/customer/navalha/photos/${ownerPhoto}`)).status, 404, 'a foto do João só ele vê');
    assert.equal((await ana('DELETE', `/api/customer/navalha/photos/${ownerPhoto}`)).status, 404);

    const { file, thumb } = fileOf(pauloPhoto);
    assert.equal((await c('DELETE', `/api/customer/navalha/photos/${pauloPhoto}`)).status, 200);
    assert.equal(fs.existsSync(path.join(photosDir, file)), false, 'o arquivo sai do servidor');
    assert.equal(fs.existsSync(path.join(photosDir, thumb!)), false, 'a miniatura também');
    assert.equal((await owner('GET', `/api/shop/photos/${pauloPhoto}`)).status, 404, 'a barbearia deixa de ver');
  });

  test('guarda as 30 fotos mais recentes por cliente', () => {
    const start = Date.now();
    const ids = Array.from({ length: 31 }, (_, i) =>
      addPhoto({ shopId, customerId: ana, ...photo(`ana-${i}`), userId: null, now: new Date(start + i * 60000) }).id,
    );
    const left = all<{ id: number }>('SELECT id FROM cut_photos WHERE customer_id = ? ORDER BY id', [ana]).map((p) => p.id);
    assert.equal(left.length, 30);
    assert.ok(!left.includes(ids[0]), 'a mais antiga saiu');
    assert.equal(files().filter((f) => f.startsWith(`${shopId}-${ana}-`)).length, 60, 'foto e miniatura de cada uma');
  });

  test('LGPD: a cópia dos dados leva as anotações e as fotos; a exclusão apaga tudo', async () => {
    const data = (await owner('GET', `/api/shop/customers/${joao}/export`)).data;
    assert.equal(data.cliente.anotacoes_da_barbearia, 'Máquina 2 nas laterais, tesoura em cima. Pomada matte.');
    assert.equal(data.fotos_do_corte.length, 1);
    assert.equal(data.fotos_do_corte[0].descricao, 'Degradê navalhado');

    const { file, thumb } = fileOf(ownerPhoto);
    const c = await enter('11999990000');
    assert.equal((await c('POST', '/api/customer/navalha/delete-account', { confirm: 'EXCLUIR' })).status, 200);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM cut_photos WHERE customer_id = ?', [joao])!.n, 0);
    assert.equal(get<{ notes: string | null }>('SELECT notes FROM customers WHERE id = ?', [joao])!.notes, null);
    assert.equal(fs.existsSync(path.join(photosDir, file)), false);
    assert.equal(fs.existsSync(path.join(photosDir, thumb!)), false);
    assert.equal(files().filter((f) => f.startsWith(`${shopId}-${joao}-`)).length, 0);
  });
});
