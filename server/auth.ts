import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { get, nowIso, run } from './db.js';
import { HttpError } from './http.js';

/**
 * Perfis com login (e-mail ou celular) e senha; o cliente da barbearia tem a área própria, em customerAuth.ts:
 * - master: dono da plataforma — cadastra as barbearias, vê tudo e pode entrar no painel de qualquer uma;
 * - owner: dono da barbearia — cuida da marca, agenda, robô, catálogo, parceiros, anúncios, campanhas e clientes;
 * - barber: barbeiro — vê a própria agenda, fecha os próprios atendimentos e acompanha as comissões.
 */
export type Role = 'master' | 'owner' | 'barber';

export interface AuthUser {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  barbershopId: number | null;
  /** Barbeiro ligado a este login (perfil barber). */
  barberId: number | null;
  /** Já aceitou os termos de uso da plataforma (dono). */
  termsAccepted: boolean;
  /** Master operando o painel de uma barbearia. */
  acting?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
      rawBody?: Buffer;
    }
  }
}

const COOKIE = 'bb_session';
const SESSION_DAYS = 30;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function readCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export const hasMaster = () => Boolean(get("SELECT 1 AS ok FROM users WHERE role = 'master' LIMIT 1"));

export function createSession(res: Response, userId: number): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
  run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, nowIso(), expires.toISOString()]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires, path: '/' });
}

export function destroySession(req: Request, res: Response): void {
  const token = readCookie(req);
  if (token) run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

/** Preenche req.user quando há sessão válida (não bloqueia). */
export function loadUser(req: Request, _res: Response, next: NextFunction): void {
  const token = readCookie(req);
  if (token) {
    const row = get<{
      id: number;
      name: string;
      email: string | null;
      phone: string | null;
      role: Role;
      barbershop_id: number | null;
      barber_id: number | null;
      terms_accepted_at: string | null;
      acting_shop_id: number | null;
    }>(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.barbershop_id, u.barber_id, u.terms_accepted_at, s.acting_shop_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`,
      [sha256(token), nowIso()],
    );
    if (row) {
      // Master "dentro" do painel de uma barbearia enxerga e opera como o dono dela.
      const acting = row.role === 'master' && row.acting_shop_id ? row.acting_shop_id : null;
      req.user = {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        role: row.role,
        barbershopId: acting ?? row.barbershop_id,
        barberId: row.barber_id,
        termsAccepted: Boolean(row.terms_accepted_at),
        acting: Boolean(acting),
      };
      req.sessionId = sha256(token);
    }
  }
  next();
}

/** Master entra no painel de uma barbearia (ou sai, com null). */
export function setActingShop(req: Request, shopId: number | null): void {
  if (!req.sessionId) throw new HttpError(401, 'Faça login para continuar.');
  run('UPDATE sessions SET acting_shop_id = ? WHERE id = ?', [shopId, req.sessionId]);
}

export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, 'Faça login para continuar.');
    const masterActing = role === 'owner' && req.user.role === 'master' && req.user.acting;
    if (req.user.role !== role && !masterActing) throw new HttpError(403, 'Acesso não permitido para este perfil.');
    if (role === 'owner' && !req.user.barbershopId) throw new HttpError(403, 'Usuário sem barbearia vinculada.');
    next();
  };
}

/** Barbearia do dono logado (rotas do painel). */
export function shopId(req: Request): number {
  return req.user!.barbershopId!;
}

// Limite simples de tentativas de login por IP (10 a cada 15 minutos).
const attempts = new Map<string, { count: number; until: number }>();
export function checkLoginRate(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.until < now) {
    attempts.set(ip, { count: 1, until: now + 15 * 60000 });
    return;
  }
  entry.count++;
  if (entry.count > 10) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
}
