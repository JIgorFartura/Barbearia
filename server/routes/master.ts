import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, requireRole } from '../auth.js';
import { all, get, nowIso, run, tx } from '../db.js';
import { HttpError, idParam, parseBody } from '../http.js';
import { zPassword } from './auth.js';

/** Painel do dono da plataforma: cadastra cada barbearia (o "inquilino") e o login do dono dela. */
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
  res.json(
    all(`
      SELECT b.id, b.slug, b.name, b.active, b.created_at,
             (SELECT group_concat(email, ', ') FROM users u WHERE u.barbershop_id = b.id) AS owners,
             (SELECT COUNT(*) FROM customers c WHERE c.barbershop_id = b.id) AS customers,
             (SELECT COUNT(*) FROM campaigns c WHERE c.barbershop_id = b.id AND c.active = 1) AS campaigns
        FROM barbershops b ORDER BY b.name`),
  );
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
