import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeClient } from './client.js';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-avaliacao-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../index.js');
const { get, nowIso, run } = await import('../db.js');
const { hashPassword } = await import('../auth.js');
const { book } = await import('../scheduling.js');
const { askReviews, parseRating } = await import('../reviews.js');
const { handleInbound } = await import('../bot/inbound.js');
const { shopBot } = await import('../messaging.js');

let server: Server;
let base = '';
const owner = makeClient(() => base);
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await owner('POST', '/api/auth/login', { login: 'carlos@navalha.com', password: 'senha-forte-1' });
});
after(() => server.close());

/** "AAAA-MM-DD HH:MM" no horário de Brasília → Date. */
const at = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}:00-03:00`);

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, review_link, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', 'https://g.page/r/navalha/review', ?)", [
  nowIso(),
]).lastInsertRowid;
run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', 'Carlos', 'carlos@navalha.com', '11955550000', ?, ?, ?)", [
  shopId,
  hashPassword('senha-forte-1'),
  nowIso(),
  nowIso(),
]);
const paulo = run("INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, 'Paulo', ?)", [shopId, nowIso()]).lastInsertRowid;
for (let d = 0; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '08:00', '20:00')", [paulo, d]);
run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 5000, 30, ?)", [shopId, nowIso()]);
const customer = (name: string, phone: string) => run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shopId, name, phone, nowIso()]).lastInsertRowid;
const joao = customer('João Pereira', '11999990000');
const maria = customer('Maria Souza', '11988880000');
const pedro = customer('Pedro Alves', '11977770000');
const lastOut = (customerId: number) => get<{ body: string; kind: string }>("SELECT body, kind FROM messages WHERE customer_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", [customerId]);
const say = (phone: string, text: string, now: Date) => handleInbound({ shopId, from: `55${phone}`, text, now, dryRun: true });

describe('avaliação depois do corte', () => {
  test('entende a nota', () => {
    assert.equal(parseRating('5'), 5);
    assert.equal(parseRating('nota 4'), 4);
    assert.equal(parseRating('3 estrelas!'), 3);
    assert.equal(parseRating('⭐⭐⭐⭐⭐'), 5);
    assert.equal(parseRating('10'), null);
    assert.equal(parseRating('sexta às 5'), null);
  });

  test('pede a nota 2h depois do atendimento, uma vez só; nota alta ganha o link do Google', async () => {
    const created = at('2026-11-01 09:00');
    book({ shopId, customerId: joao, barberId: paulo, date: '2026-11-02', time: '10:00', source: 'painel', now: created });
    book({ shopId, customerId: maria, barberId: paulo, date: '2026-11-02', time: '10:30', source: 'painel', now: created });
    const cancelled = book({ shopId, customerId: pedro, barberId: paulo, date: '2026-11-02', time: '11:00', source: 'painel', now: created });
    run("UPDATE appointments SET status = 'no_show' WHERE id = ?", [cancelled.id]);

    assert.equal(await askReviews(shopBot(shopId), at('2026-11-02 12:00')), 0, 'ainda não deu 2h do fim');
    assert.equal(await askReviews(shopBot(shopId), at('2026-11-02 13:10')), 2);
    assert.equal(await askReviews(shopBot(shopId), at('2026-11-02 14:00')), 0, 'não repete');
    assert.match(lastOut(joao)!.body, /Como foi seu atendimento com o Paulo\? Responda com uma nota de 1 a 5/);
    assert.equal(lastOut(pedro), undefined, 'falta não recebe');

    const reply = await say('11999990000', '5', at('2026-11-02 13:20'));
    assert.match(reply!, /Valeu demais, João!.*\n.*https:\/\/g\.page\/r\/navalha\/review/);
    assert.equal(get<{ rating: number; status: string }>('SELECT rating, status FROM reviews WHERE customer_id = ?', [joao])!.status, 'done');
  });

  test('nota baixa: pergunta o que melhorar e avisa o dono', async () => {
    assert.match((await say('11988880000', '2', at('2026-11-02 13:30')))!, /O que a gente pode melhorar/);
    assert.match((await say('11988880000', 'Demorou muito pra ser atendida', at('2026-11-02 13:32')))!, /Já passei para o dono/);
    const r = get<{ rating: number; comment: string }>('SELECT rating, comment FROM reviews WHERE customer_id = ?', [maria])!;
    assert.deepEqual(r, { rating: 2, comment: 'Demorou muito pra ser atendida' });
    const alert = get<{ phone: string; body: string }>("SELECT phone, body FROM platform_messages ORDER BY id DESC LIMIT 1")!;
    assert.equal(alert.phone, '11955550000');
    assert.match(alert.body, /Avaliação 2\/5.*Maria Souza \(atendido pelo Paulo\).*Demorou muito/);
  });

  test('número solto só vale como nota logo depois do pedido; 30 dias sem pedir de novo', async () => {
    // João volta na semana seguinte: não recebe outro pedido (30 dias).
    book({ shopId, customerId: joao, barberId: paulo, date: '2026-11-09', time: '10:00', source: 'painel', now: at('2026-11-08 09:00') });
    assert.equal(await askReviews(shopBot(shopId), at('2026-11-09 13:00')), 0);

    // Pedro recebe o pedido, mas a conversa segue: o robô respondeu outra coisa e ele manda "3" (escolha de horário, não nota).
    book({ shopId, customerId: pedro, barberId: paulo, date: '2026-11-10', time: '10:00', source: 'painel', now: at('2026-11-09 09:00') });
    assert.equal(await askReviews(shopBot(shopId), at('2026-11-10 13:00')), 1);
    await say('11977770000', 'tem horário amanhã?', at('2026-11-10 13:05'));
    await say('11977770000', '3', at('2026-11-10 13:06'));
    assert.equal(get<{ rating: number | null }>('SELECT rating FROM reviews WHERE customer_id = ?', [pedro])!.rating, null);
  });

  test('painel: média geral e por barbeiro; o dono pode desligar', async () => {
    const r = (await owner('GET', '/api/shop/reviews')).data;
    assert.equal(r.count, 2);
    assert.equal(r.average, 3.5);
    assert.deepEqual(
      r.byBarber.map((b: { name: string; avg: number; n: number }) => [b.name, b.avg, b.n]),
      [['Paulo', 3.5, 2]],
    );
    assert.equal(r.recent[0].comment, 'Demorou muito pra ser atendida');
    const saved = await owner('PUT', '/api/shop/reviews/settings', { review_enabled: false, review_delay_min: 60, review_link: 'https://g.page/r/outro/review' });
    assert.equal(saved.data.settings.review_enabled, false);
    book({ shopId, customerId: maria, barberId: paulo, date: '2026-12-20', time: '10:00', source: 'painel', now: at('2026-12-19 09:00') });
    assert.equal(await askReviews(shopBot(shopId), at('2026-12-20 13:00')), 0);
  });
});
