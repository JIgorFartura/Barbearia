import { Router } from 'express';
import { z } from 'zod';
import { checkLoginRate, createSession, destroySession, hashPassword, hasMaster, verifyPassword } from '../auth.js';
import { get, nowIso, run } from '../db.js';
import { HttpError, normalizePhone, parseBody, rateLimit } from '../http.js';
import { consumePasswordCode, findLogin, requestPasswordCode } from '../passwordReset.js';
import { removeSubscription, saveSubscription, zPushEndpoint, zPushSubscription } from '../push.js';

export const authRouter = Router();

const zEmail = z.string().trim().toLowerCase().email('E-mail inválido.');
export const zPassword = z.string().min(8, 'A senha precisa de pelo menos 8 caracteres.').max(200);
/** E-mail ou celular. */
const zLogin = z.string().trim().min(3, 'Informe o e-mail ou o celular.').max(120);

authRouter.get('/me', (req, res) => {
  const shop = req.user?.barbershopId ? get('SELECT id, slug, name FROM barbershops WHERE id = ?', [req.user.barbershopId]) : null;
  res.json({ user: req.user ?? null, shop, setupNeeded: !hasMaster() });
});

/** Primeiro acesso: cria o master (dono da plataforma). Só funciona enquanto não existe master. */
authRouter.post('/setup', (req, res) => {
  if (hasMaster()) throw new HttpError(409, 'O sistema já foi configurado.');
  const body = parseBody(z.object({ name: z.string().trim().min(2), email: zEmail, password: zPassword }), req.body);
  const { lastInsertRowid } = run(
    "INSERT INTO users (role, name, email, password_hash, terms_accepted_at, created_at) VALUES ('master', ?, ?, ?, ?, ?)",
    [body.name, body.email, hashPassword(body.password), nowIso(), nowIso()],
  );
  createSession(res, lastInsertRowid);
  res.status(201).json({ ok: true });
});

/** Entra com e-mail ou celular (barbeiros costumam usar o celular). */
authRouter.post('/login', (req, res) => {
  checkLoginRate(req.ip ?? '');
  const body = parseBody(z.object({ login: zLogin.optional(), email: z.string().max(120).optional(), password: z.string().max(200) }), req.body);
  const login = body.login ?? body.email ?? '';
  const found = login ? findLogin(login) : undefined;
  const user = found ? get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE id = ?', [found.id]) : undefined;
  if (!user || !verifyPassword(body.password, user.password_hash)) throw new HttpError(401, 'Login ou senha incorretos.');
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

/** Nome e celular do próprio login (o celular recebe o código de "esqueci minha senha" e os avisos). */
authRouter.put('/profile', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Faça login para continuar.');
  const body = parseBody(z.object({ name: z.string().trim().min(2).max(80), phone: z.string().max(30).nullish() }), req.body);
  const phone = body.phone?.trim() ? normalizePhone(body.phone) : null;
  if (!phone && !req.user.email) throw new HttpError(400, 'Seu login é pelo celular: ele não pode ficar em branco.');
  if (phone && get('SELECT 1 AS ok FROM users WHERE phone = ? AND id <> ?', [phone, req.user.id])) throw new HttpError(409, 'Esse celular já está em outro login.');
  run('UPDATE users SET name = ?, phone = ? WHERE id = ?', [body.name, phone, req.user.id]);
  res.json({ ok: true });
});

/** Avisos no celular do dono e do barbeiro (horário novo, cancelado). */
authRouter.post('/push', (req, res) => {
  if (!req.user?.barbershopId) throw new HttpError(401, 'Faça login para continuar.');
  saveSubscription({ shopId: req.user.barbershopId, userId: req.user.id }, parseBody(zPushSubscription, req.body), req.get('user-agent') ?? null);
  res.json({ ok: true });
});

authRouter.delete('/push', (req, res) => {
  if (!req.user?.barbershopId) throw new HttpError(401, 'Faça login para continuar.');
  removeSubscription({ shopId: req.user.barbershopId, userId: req.user.id }, parseBody(zPushEndpoint, req.body).endpoint);
  res.json({ ok: true });
});

/** Aceite dos termos de uso e da política de privacidade (dono e barbeiro, no primeiro acesso). */
authRouter.post('/accept-terms', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Faça login para continuar.');
  run('UPDATE users SET terms_accepted_at = COALESCE(terms_accepted_at, ?) WHERE id = ?', [nowIso(), req.user.id]);
  res.json({ ok: true });
});

/** Esqueci minha senha (1): manda o código para o celular do login. */
authRouter.post('/forgot', async (req, res) => {
  rateLimit(`forgot:${req.ip ?? ''}`, 10, 3600000, 'Muitos pedidos. Tente mais tarde.');
  const { login } = parseBody(z.object({ login: zLogin }), req.body);
  res.json(await requestPasswordCode(login));
});

/** Esqueci minha senha (2): confere o código, grava a nova senha e já entra. */
authRouter.post('/reset', (req, res) => {
  rateLimit(`reset:${req.ip ?? ''}`, 30, 3600000, 'Muitas tentativas. Tente mais tarde.');
  const body = parseBody(z.object({ login: zLogin, code: z.string().max(10), password: zPassword }), req.body);
  const user = consumePasswordCode(body.login, body.code);
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(body.password), user.id]);
  // Senha nova derruba as sessões abertas (ex.: num celular perdido).
  run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
  createSession(res, user.id);
  res.json({ ok: true });
});
