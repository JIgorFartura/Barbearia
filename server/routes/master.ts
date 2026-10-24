import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, requireRole, setActingShop } from '../auth.js';
import { llmEnabled } from '../bot/brain.js';
import { config } from '../config.js';
import { all, get, nowIso, run, tx } from '../db.js';
import { HttpError, idParam, parseBody } from '../http.js';
import { addDays, localNow } from '../time.js';
import { zPassword } from './auth.js';

/**
 * Painel do dono da plataforma: cadastra cada barbearia (o "inquilino") e o login do dono dela,
 * acompanha tudo o que acontece e pode entrar no painel de qualquer barbearia.
 */
export const masterRouter = Router();
masterRouter.use(requireRole('master'));

const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'Endereço só com letras minúsculas, números e hífen (ex.: barbearia-do-ze).');

const zOwner = z.object({
  ownerName: z.string().trim().min(2, 'Informe o nome do dono.'),
  ownerEmail: z.string().trim().toLowerCase().email('E-mail do dono inválido.'),
  ownerPassword: zPassword,
});

function assertFreeSlug(slug: string, exceptId = 0): void {
  if (get('SELECT 1 AS ok FROM barbershops WHERE slug = ? AND id <> ?', [slug, exceptId])) {
    throw new HttpError(409, 'Esse endereço já é usado por outra barbearia.');
  }
}

function assertFreeEmail(email: string): void {
  if (get('SELECT 1 AS ok FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Já existe um usuário com esse e-mail.');
}

masterRouter.get('/shops', (_req, res) => {
  const now = localNow();
  const week = `${addDays(now.date, 7)} 00:00`;
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  res.json(
    all(
      `
      SELECT b.id, b.slug, b.name, b.active, b.created_at, b.bot_name, b.wa_provider,
             (SELECT group_concat(email, ', ') FROM users u WHERE u.barbershop_id = b.id) AS owners,
             (SELECT COUNT(*) FROM customers c WHERE c.barbershop_id = b.id) AS customers,
             (SELECT COUNT(*) FROM campaigns c WHERE c.barbershop_id = b.id AND c.active = 1) AS campaigns,
             (SELECT COUNT(*) FROM barbers x WHERE x.barbershop_id = b.id AND x.active = 1) AS barbers,
             (SELECT COUNT(*) FROM appointments a WHERE a.barbershop_id = b.id AND a.status = 'scheduled' AND a.starts_at >= :now AND a.starts_at < :week) AS appointments_week,
             (SELECT COUNT(*) FROM messages m WHERE m.barbershop_id = b.id AND m.created_at >= :since7) AS messages_week,
             (SELECT COUNT(*) FROM messages m WHERE m.barbershop_id = b.id AND m.status = 'failed' AND m.created_at >= :since7) AS failed_week,
             (SELECT COALESCE(SUM(tokens_in), 0) FROM messages m WHERE m.barbershop_id = b.id AND m.created_at >= :since30) AS tokens_in_30d,
             (SELECT COALESCE(SUM(tokens_out), 0) FROM messages m WHERE m.barbershop_id = b.id AND m.created_at >= :since30) AS tokens_out_30d
        FROM barbershops b ORDER BY b.name`,
      { now: now.stamp, week, since7, since30 },
    ),
  );
});

/** Visão geral da plataforma (todas as barbearias). */
masterRouter.get('/overview', (_req, res) => {
  const now = localNow();
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const count = (sql: string, params: unknown[] = []) => get<{ n: number }>(sql, params)?.n ?? 0;
  res.json({
    shops: count('SELECT COUNT(*) AS n FROM barbershops WHERE active = 1'),
    customers: count('SELECT COUNT(*) AS n FROM customers'),
    appointmentsToday: count("SELECT COUNT(*) AS n FROM appointments WHERE status = 'scheduled' AND starts_at >= ? AND starts_at < ?", [
      `${now.date} 00:00`,
      `${addDays(now.date, 1)} 00:00`,
    ]),
    messagesWeek: count('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', [since7]),
    vouchersWeek: count('SELECT COUNT(*) AS n FROM vouchers WHERE created_at >= ?', [since7]),
    llm: llmEnabled(),
    model: llmEnabled() ? config.botModel : null,
    recentMessages: all(
      `SELECT m.id, b.name AS shop, m.direction, m.kind, m.status, m.body, m.created_at FROM messages m JOIN barbershops b ON b.id = m.barbershop_id
        WHERE m.kind <> 'codigo' ORDER BY m.id DESC LIMIT 15`,
    ),
  });
});

/** Master entra no painel de uma barbearia (vê e opera como o dono). */
masterRouter.post('/shops/:id/enter', (req, res) => {
  const id = idParam(req);
  if (!get('SELECT 1 AS ok FROM barbershops WHERE id = ?', [id])) throw new HttpError(404, 'Barbearia não encontrada.');
  setActingShop(req, id);
  res.json({ ok: true });
});

masterRouter.post('/exit', (req, res) => {
  setActingShop(req, null);
  res.json({ ok: true });
});

masterRouter.post('/shops', (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(2, 'Informe o nome da barbearia.'), slug: zSlug }).extend(zOwner.shape), req.body);
  const id = tx(() => {
    assertFreeSlug(body.slug);
    assertFreeEmail(body.ownerEmail);
    const shop = run('INSERT INTO barbershops (slug, name, created_at) VALUES (?, ?, ?)', [body.slug, body.name, nowIso()]).lastInsertRowid;
    run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', ?, ?, ?, ?)", [
      shop,
      body.ownerName,
      body.ownerEmail,
      hashPassword(body.ownerPassword),
      nowIso(),
    ]);
    return shop;
  });
  res.status(201).json({ id });
});

masterRouter.put('/shops/:id', (req, res) => {
  const id = idParam(req);
  const body = parseBody(z.object({ name: z.string().trim().min(2), slug: zSlug, active: z.boolean() }), req.body);
  assertFreeSlug(body.slug, id);
  const { changes } = run('UPDATE barbershops SET name = ?, slug = ?, active = ? WHERE id = ?', [body.name, body.slug, body.active, id]);
  if (!changes) throw new HttpError(404, 'Barbearia não encontrada.');
  res.json({ ok: true });
});

/** Mais um login para a mesma barbearia (sócio, gerente). */
masterRouter.post('/shops/:id/owners', (req, res) => {
  const id = idParam(req);
  const body = parseBody(zOwner, req.body);
  if (!get('SELECT 1 AS ok FROM barbershops WHERE id = ?', [id])) throw new HttpError(404, 'Barbearia não encontrada.');
  assertFreeEmail(body.ownerEmail);
  run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', ?, ?, ?, ?)", [
    id,
    body.ownerName,
    body.ownerEmail,
    hashPassword(body.ownerPassword),
    nowIso(),
  ]);
  res.status(201).json({ ok: true });
});
