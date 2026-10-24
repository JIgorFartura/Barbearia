import crypto from 'node:crypto';
import type { CieloCredentials } from './cielo.js';
import { config } from './config.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';

/**
 * Contas Cielo de quem recebe no cartão: a plataforma (mensalidade das barbearias) e cada barbearia
 * (clube e sinal dos clientes). Cada uma tem a sua URL de aviso, com um segredo, para colar no site da
 * Cielo. O Client Secret nunca volta para a tela.
 */

/** Taxa do crédito à vista no Link de Pagamento Cielo (tabela pública); cada conta ajusta a sua. */
export const DEFAULT_CARD_FEE = 3.48;

const newToken = () => crypto.randomBytes(24).toString('base64url');
export const cieloWebhookUrl = (token: string) => `${config.appUrl}/api/webhooks/cielo/${token}`;
export const secretHint = (secret: string | null | undefined) => (secret ? `••••${secret.slice(-4)}` : null);

// ---------- plataforma

const KEYS = ['cielo_client_id', 'cielo_client_secret', 'cielo_webhook_token', 'cielo_fee_pct', 'cielo_webhook_at'];

export interface PlatformCielo {
  clientId: string;
  clientSecret: string;
  webhookToken: string;
  feePct: number;
  webhookAt: string | null;
}

export function platformCielo(): PlatformCielo {
  const rows = all<{ key: string; value: string }>(`SELECT key, value FROM platform_settings WHERE key IN (${KEYS.map(() => '?').join(', ')})`, KEYS);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    clientId: m.cielo_client_id ?? '',
    clientSecret: m.cielo_client_secret ?? '',
    webhookToken: m.cielo_webhook_token ?? '',
    feePct: m.cielo_fee_pct != null ? Number(m.cielo_fee_pct) : DEFAULT_CARD_FEE,
    webhookAt: m.cielo_webhook_at ?? null,
  };
}

const setKey = (key: string, value: string) =>
  run('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);

/** Client Secret em branco = mantém o atual. ClientId em branco desliga o cartão da plataforma. */
export function savePlatformCielo(s: { clientId: string; clientSecret?: string | null; feePct: number }): PlatformCielo {
  tx(() => {
    const clientId = s.clientId.trim();
    setKey('cielo_client_id', clientId);
    if (s.clientSecret?.trim()) setKey('cielo_client_secret', s.clientSecret.trim());
    if (!clientId) setKey('cielo_client_secret', '');
    setKey('cielo_fee_pct', String(s.feePct));
    if (!platformCielo().webhookToken) setKey('cielo_webhook_token', newToken());
  });
  return platformCielo();
}

export function platformCieloCreds(): CieloCredentials | null {
  const p = platformCielo();
  return p.clientId && p.clientSecret ? { clientId: p.clientId, clientSecret: p.clientSecret } : null;
}

/** A plataforma recebe a mensalidade no cartão (recorrente). */
export const platformCardReady = () => Boolean(platformCieloCreds());

// ---------- barbearia

export interface ShopCielo {
  clientId: string | null;
  clientSecret: string | null;
  webhookToken: string | null;
  webhookAt: string | null;
  feePct: number;
  enabled: boolean;
}

export function shopCielo(shopId: number): ShopCielo {
  const r = get<{ cielo_client_id: string | null; cielo_client_secret: string | null; cielo_webhook_token: string | null; cielo_webhook_at: string | null; cielo_fee_pct: number; card_enabled: number }>(
    'SELECT cielo_client_id, cielo_client_secret, cielo_webhook_token, cielo_webhook_at, cielo_fee_pct, card_enabled FROM barbershops WHERE id = ?',
    [shopId],
  );
  if (!r) throw new HttpError(404, 'Barbearia não encontrada.');
  return {
    clientId: r.cielo_client_id,
    clientSecret: r.cielo_client_secret,
    webhookToken: r.cielo_webhook_token,
    webhookAt: r.cielo_webhook_at,
    feePct: r.cielo_fee_pct,
    enabled: Boolean(r.card_enabled),
  };
}

export function saveShopCielo(shopId: number, s: { clientId: string | null; clientSecret?: string | null; enabled: boolean; feePct: number }): ShopCielo {
  const clientId = s.clientId?.trim() || null;
  const current = shopCielo(shopId);
  const secret = clientId ? s.clientSecret?.trim() || current.clientSecret : null;
  if (s.enabled && !(clientId && secret)) throw new HttpError(400, 'Para ligar o cartão, informe o ClientId e o Client Secret da sua conta Cielo.');
  run('UPDATE barbershops SET cielo_client_id = ?, cielo_client_secret = ?, cielo_fee_pct = ?, card_enabled = ?, cielo_webhook_token = COALESCE(cielo_webhook_token, ?) WHERE id = ?', [
    clientId,
    secret,
    s.feePct,
    s.enabled ? 1 : 0,
    newToken(),
    shopId,
  ]);
  return shopCielo(shopId);
}

export function shopCieloCreds(shopId: number): CieloCredentials | null {
  const s = shopCielo(shopId);
  return s.clientId && s.clientSecret ? { clientId: s.clientId, clientSecret: s.clientSecret } : null;
}

export interface CardStatusView {
  available: boolean;
  feePct: number;
  reason: string | null;
}

/** A barbearia aceita cartão dos clientes (clube no automático e sinal)? */
export function shopCardStatus(shopId: number): CardStatusView {
  const s = shopCielo(shopId);
  const reason = !(s.clientId && s.clientSecret) ? 'Falta ligar a conta Cielo da barbearia.' : !s.enabled ? 'A barbearia não ligou o pagamento com cartão.' : null;
  return { available: !reason, feePct: s.feePct, reason };
}

// ---------- avisos

export type CardReceiver = { receiver: 'platform' } | { receiver: 'shop'; shopId: number };

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** De quem é a URL de aviso (o segredo do fim da URL). */
export function receiverByToken(token: string): CardReceiver | null {
  if (!token || token.length < 20) return null;
  const p = platformCielo().webhookToken;
  if (p && sameToken(p, token)) return { receiver: 'platform' };
  const shop = get<{ id: number }>('SELECT id FROM barbershops WHERE cielo_webhook_token = ?', [token]);
  return shop ? { receiver: 'shop', shopId: shop.id } : null;
}

/** Chegou um aviso válido: mostra na tela que a URL foi cadastrada certo. */
export function markCieloSeen(r: CardReceiver): void {
  if (r.receiver === 'platform') setKey('cielo_webhook_at', nowIso());
  else run('UPDATE barbershops SET cielo_webhook_at = ? WHERE id = ?', [nowIso(), r.shopId]);
}
