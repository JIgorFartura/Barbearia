import { Router } from 'express';
import { z } from 'zod';
import { checkLoginRate, createSession, destroySession, hashPassword, hasMaster, verifyPassword } from '../auth.js';
import { get, nowIso, run } from '../db.js';
import { HttpError, parseBody } from '../http.js';

export const authRouter = Router();

const zEmail = z.string().trim().toLowerCase().email('E-mail inválido.');
export const zPassword = z.string().min(8, 'A senha precisa de pelo menos 8 caracteres.').max(200);

authRouter.get('/me', (req, res) => {
  const shop = req.user?.barbershopId ? get('SELECT id, slug, name FROM barbershops WHERE id = ?', [req.user.barbershopId]) : null;
  res.json({ user: req.user ?? null, shop, setupNeeded: !hasMaster() });
});

/** Primeiro acesso: cria o master (dono da plataforma). Só funciona enquanto não existe master. */
authRouter.post('/setup', (req, res) => {
  if (hasMaster()) throw new HttpError(409, 'O sistema já foi configurado.');
  const body = parseBody(z.object({ name: z.string().trim().min(2), email: zEmail, password: zPassword }), req.body);
  const { lastInsertRowid } = run(
    "INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('master', ?, ?, ?, ?)",
    [body.name, body.email, hashPassword(body.password), nowIso()],
  );
  createSession(res, lastInsertRowid);
  res.status(201).json({ ok: true });
});

authRouter.post('/login', (req, res) => {
  checkLoginRate(req.ip ?? '');
  const body = parseBody(z.object({ email: zEmail, password: z.string().max(200) }), req.body);
  const user = get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = ?', [body.email]);
  if (!user || !verifyPassword(body.password, user.password_hash)) throw new HttpError(401, 'E-mail ou senha incorretos.');
  createSession(res, user.id);
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

authRouter.post('/password', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Faça login para continuar.');
  const body = parseBody(z.object({ current: z.string().max(200), password: zPassword }), req.body);
  const row = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!row || !verifyPassword(body.current, row.password_hash)) throw new HttpError(400, 'Senha atual incorreta.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(body.password), req.user.id]);
  res.json({ ok: true });
});
