import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { get, nowIso, run } from './db.js';
import { HttpError } from './http.js';

/**
 * Área logada do cliente. O login é pelo celular: o robô manda um código de 6 dígitos no WhatsApp
 * (ou um link de acesso). A sessão vale 180 dias e é separada por barbearia (cookie bbc_<id>).
 */

const SESSION_DAYS = 180;
const CODE_MINUTES = 10;
const LINK_HOURS = 72;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const cookieName = (shopId: number) => `bbc_${shopId}`;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function createCustomerSession(res: Response, shopId: number, customerId: number): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  run('DELETE FROM customer_sessions WHERE expires_at < ?', [nowIso()]);
  run('INSERT INTO customer_sessions (id, customer_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), customerId, nowIso(), expires.toISOString()]);
  res.cookie(cookieName(shopId), token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires, path: '/' });
}

export function destroyCustomerSession(req: Request, res: Response, shopId: number): void {
  const token = readCookie(req, cookieName(shopId));
  if (token) run('DELETE FROM customer_sessions WHERE id = ?', [sha256(token)]);
  res.clearCookie(cookieName(shopId), { path: '/' });
}

/** Cliente logado nesta barbearia (ou undefined). */
export function sessionCustomer(req: Request, shopId: number): number | undefined {
  const token = readCookie(req, cookieName(shopId));
  if (!token) return undefined;
  return get<{ customer_id: number }>(
    `SELECT s.customer_id FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
      WHERE s.id = ? AND s.expires_at > ? AND c.barbershop_id = ?`,
    [sha256(token), nowIso(), shopId],
  )?.customer_id;
}

/** Gera o código de 6 dígitos (o robô envia). */
export function issueLoginCode(customerId: number): string {
  const since = new Date(Date.now() - 3600000).toISOString();
  const recent = get<{ n: number }>("SELECT COUNT(*) AS n FROM customer_codes WHERE customer_id = ? AND purpose = 'code' AND created_at >= ?", [customerId, since])!.n;
  if (recent >= MAX_CODES_PER_HOUR) throw new HttpError(429, 'Muitos códigos pedidos. Aguarde um pouco e tente de novo.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  run("INSERT INTO customer_codes (customer_id, purpose, secret_hash, expires_at, created_at) VALUES (?, 'code', ?, ?, ?)", [
    customerId,
    sha256(`${customerId}:${code}`),
    new Date(Date.now() + CODE_MINUTES * 60000).toISOString(),
    nowIso(),
  ]);
  return code;
}

/** Confere o código mais recente do cliente (até 5 tentativas). */
export function checkLoginCode(customerId: number, code: string): void {
  const row = get<{ id: number; secret_hash: string; attempts: number }>(
    `SELECT id, secret_hash, attempts FROM customer_codes
      WHERE customer_id = ? AND purpose = 'code' AND used_at IS NULL AND expires_at > ?
      ORDER BY id DESC LIMIT 1`,
    [customerId, nowIso()],
  );
  if (!row) throw new HttpError(400, 'Código expirado. Peça um novo.');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Muitas tentativas. Peça um novo código.');
  run('UPDATE customer_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  const given = Buffer.from(sha256(`${customerId}:${code.replace(/\D/g, '')}`));
  if (!crypto.timingSafeEqual(given, Buffer.from(row.secret_hash))) throw new HttpError(400, 'Código incorreto.');
  run('UPDATE customer_codes SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
}

/** Link de acesso de uso único (o robô manda no WhatsApp; o dono pode copiar no painel). */
export function issueAccessLink(customerId: number, slug: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  run("INSERT INTO customer_codes (customer_id, purpose, secret_hash, expires_at, created_at) VALUES (?, 'link', ?, ?, ?)", [
    customerId,
    sha256(token),
    new Date(Date.now() + LINK_HOURS * 3600000).toISOString(),
    nowIso(),
  ]);
  return `${config.appUrl}/b/${slug}/conta?t=${token}`;
}

/** Troca o link por uma sessão. Devolve o cliente. */
export function consumeAccessLink(shopId: number, token: string): number {
  const row = get<{ id: number; customer_id: number }>(
    `SELECT k.id, k.customer_id FROM customer_codes k JOIN customers c ON c.id = k.customer_id
      WHERE k.secret_hash = ? AND k.purpose = 'link' AND k.used_at IS NULL AND k.expires_at > ? AND c.barbershop_id = ?`,
    [sha256(token), nowIso(), shopId],
  );
  if (!row) throw new HttpError(400, 'Link expirado ou já usado. Entre com seu celular.');
  run('UPDATE customer_codes SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
  return row.customer_id;
}
