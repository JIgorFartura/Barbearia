import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-calendario-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { nowIso, run } = await import('../db.js');
const { calendarLink } = await import('../calendar.js');
const { addDays, localNow } = await import('../time.js');

let server: Server;
let base = '';
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, address, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'Rua A, 10', ?)", [nowIso()]).lastInsertRowid;
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
const marcos = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Marcos', ?)", [shopId, nowIso()]).lastInsertRowid;
const joao = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'João Pereira', '11999990000', ?)", [shopId, nowIso()]).lastInsertRowid;
const D = addDays(localNow().date, 2);
const appt = (barberId: number, time: string) =>
  run("INSERT INTO appointments (barbershop_id, customer_id, barber_id, service_name, price_cents, starts_at, ends_at, source, created_at) VALUES (?, ?, ?, 'Corte, barba', 5000, ?, ?, 'painel', ?)", [
    shopId,
    joao,
    barberId,
    `${D} ${time}`,
    `${D} ${time.slice(0, 3)}30`,
    nowIso(),
  ]);
appt(paulo, '10:00');
appt(marcos, '11:00');
const fetchIcs = (url: string) => fetch(base + new URL(url).pathname);

describe('agenda do barbeiro no Google Agenda', () => {
  test('o link mostra só os horários dele, no horário certo (UTC), sem o celular do cliente', async () => {
    const url = calendarLink(shopId, paulo);
    assert.match(url, /\/api\/public\/calendar\/[\w-]+\.ics$/);
    const r = await fetchIcs(url);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/calendar/);
    const ics = await r.text();
    assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
    assert.match(ics, new RegExp(`DTSTART:${D.replace(/-/g, '')}T130000Z`), '10h em Brasília = 13h UTC');
    assert.match(ics, /SUMMARY:Corte\\, barba · João/);
    assert.match(ics, /LOCATION:Rua A\\, 10/);
    assert.doesNotMatch(ics, /99999/);
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  });

  test('trocar o link desliga o antigo', async () => {
    const old = calendarLink(shopId, paulo);
    const fresh = calendarLink(shopId, paulo, { renew: true });
    assert.notEqual(old, fresh);
    assert.equal((await fetchIcs(old)).status, 404);
    assert.equal((await fetchIcs(fresh)).status, 200);
  });
});
