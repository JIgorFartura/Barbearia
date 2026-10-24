import crypto from 'node:crypto';
import { config } from './config.js';
import { get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { sendMessage, shopBot } from './messaging.js';
import { sendPlatformMessage } from './platform.js';

/**
 * "Esqueci minha senha": um código de 6 dígitos vai para o celular do login pelo WhatsApp da
 * plataforma (ou, se ela não tiver WhatsApp ligado, pelo da barbearia). Vale 15 minutos e 5 tentativas.
 */

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 3;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export interface LoginRow {
  id: number;
  name: string;
  role: 'master' | 'owner' | 'barber';
  email: string | null;
  phone: string | null;
  barbershop_id: number | null;
}

/** Celular digitado → como guardamos (DDD + número, sem 55). */
export function localDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
}

/** Acha o login pelo e-mail ou pelo celular. */
export function findLogin(login: string): LoginRow | undefined {
  const value = login.trim();
  const cols = 'id, name, role, email, phone, barbershop_id';
  if (value.includes('@')) return get<LoginRow>(`SELECT ${cols} FROM users WHERE email = ?`, [value.toLowerCase()]);
  const local = localDigits(value);
  if (local.length < 10 || local.length > 11) return undefined;
  // Tolera o nono dígito: DDD + últimos 8.
  return (
    get<LoginRow>(`SELECT ${cols} FROM users WHERE phone = ?`, [local]) ??
    get<LoginRow>(`SELECT ${cols} FROM users WHERE substr(phone, 1, 2) = ? AND substr(phone, -8) = ? ORDER BY id LIMIT 1`, [local.slice(0, 2), local.slice(-8)])
  );
}

export const maskPhone = (phone: string) => `(${phone.slice(0, 2)}) •••••-${phone.slice(-4)}`;

export interface CodeResult {
  /** Celular para onde foi (mascarado). */
  masked: string;
  sent: boolean;
  /** Só em demonstração, quando não há WhatsApp para enviar. */
  demoCode?: string;
}

export async function requestPasswordCode(login: string): Promise<CodeResult> {
  const user = findLogin(login);
  if (!user) throw new HttpError(404, 'Não encontramos esse login. Confira o e-mail ou o celular.');
  if (!user.phone) {
    throw new HttpError(
      400,
      user.role === 'barber'
        ? 'Seu login não tem celular cadastrado. Peça ao dono da barbearia para trocar sua senha.'
        : 'Esse login não tem celular cadastrado. Fale com o suporte da plataforma para trocar a senha.',
    );
  }
  const since = new Date(Date.now() - 3600000).toISOString();
  if (get<{ n: number }>('SELECT COUNT(*) AS n FROM password_codes WHERE user_id = ? AND created_at >= ?', [user.id, since])!.n >= MAX_CODES_PER_HOUR) {
    throw new HttpError(429, 'Muitos códigos pedidos. Aguarde um pouco e tente de novo.');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  run('INSERT INTO password_codes (user_id, secret_hash, expires_at, created_at) VALUES (?, ?, ?, ?)', [
    user.id,
    sha256(`${user.id}:${code}`),
    new Date(Date.now() + CODE_MINUTES * 60000).toISOString(),
    nowIso(),
  ]);
  const text = `Código para criar uma nova senha no painel: *${code}*. Vale por ${CODE_MINUTES} minutos. Se não foi você que pediu, ignore esta mensagem.`;
  let sent = (await sendPlatformMessage({ phone: user.phone, text, kind: 'senha', userId: user.id, shopId: user.barbershop_id, template: { kind: 'senha', params: [code] } })).status === 'sent';
  // Plataforma sem WhatsApp: tenta pelo número da barbearia do usuário.
  if (!sent && user.barbershop_id) {
    const shop = shopBot(user.barbershop_id);
    if (shop.wa_provider !== 'simulador') {
      sent = (await sendMessage({ shop, customerId: null, phone: user.phone, text, kind: 'codigo', template: { kind: 'codigo', params: [code] } })).status === 'sent';
    }
  }
  if (!sent && !config.demoLoginCodes) throw new HttpError(503, 'Não conseguimos enviar o código pelo WhatsApp agora. Tente de novo em instantes ou fale com o suporte.');
  return { masked: maskPhone(user.phone), sent, demoCode: sent ? undefined : code };
}

/** Confere o código e grava a nova senha (já com hash). Devolve o usuário. */
export function consumePasswordCode(login: string, code: string): LoginRow {
  const user = findLogin(login);
  if (!user) throw new HttpError(400, 'Código incorreto.');
  const row = get<{ id: number; secret_hash: string; attempts: number }>(
    'SELECT id, secret_hash, attempts FROM password_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1',
    [user.id, nowIso()],
  );
  if (!row) throw new HttpError(400, 'Código expirado. Peça um novo.');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Muitas tentativas. Peça um novo código.');
  run('UPDATE password_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  const given = Buffer.from(sha256(`${user.id}:${code.replace(/\D/g, '')}`));
  if (!crypto.timingSafeEqual(given, Buffer.from(row.secret_hash))) throw new HttpError(400, 'Código incorreto.');
  run('UPDATE password_codes SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
  return user;
}
