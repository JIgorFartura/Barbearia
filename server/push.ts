import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';

/**
 * Notificações no celular (Web Push, o padrão dos navegadores: sem custo por mensagem). O dono e o
 * barbeiro recebem os horários novos e os cancelados; o cliente, o lembrete do horário. A mensagem vai
 * criptografada (RFC 8291) e assinada com a chave da plataforma (VAPID, RFC 8292), gerada sozinha na
 * primeira vez e guardada no banco (entra na cópia de segurança).
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Endereço que abre ao tocar no aviso. */
  url: string;
  /** Avisos com a mesma etiqueta se substituem (ex.: o mesmo horário). */
  tag?: string;
  /** Ícone do aviso (o da barbearia, para o cliente). */
  icon?: string;
}

/** Só os serviços de push dos navegadores (o servidor não manda nada para endereços quaisquer). */
const PUSH_HOSTS = ['.googleapis.com', '.mozilla.com', '.notify.windows.com', '.push.apple.com'];
/** Depois de tantas falhas seguidas (fora o "não existe mais"), a inscrição sai. */
const MAX_FAILS = 5;

const b64url = (b: Buffer) => b.toString('base64url');

// ---------- chave da plataforma (VAPID)

let cached: { publicKey: string; privateKey: crypto.KeyObject } | null = null;

export function vapidKeys(): { publicKey: string; privateKey: crypto.KeyObject } {
  if (cached) return cached;
  let jwk = get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'vapid_jwk'")?.value;
  if (!jwk) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
    // Duas instâncias ao mesmo tempo: vale a primeira que gravou.
    run("INSERT INTO platform_settings (key, value) VALUES ('vapid_jwk', ?) ON CONFLICT(key) DO NOTHING", [jwk]);
    jwk = get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'vapid_jwk'")!.value;
  }
  const key = JSON.parse(jwk) as crypto.JsonWebKey;
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(key.x!, 'base64url'), Buffer.from(key.y!, 'base64url')]));
  cached = { publicKey, privateKey: crypto.createPrivateKey({ key, format: 'jwk' }) };
  return cached;
}

/** Cabeçalho Authorization do VAPID para o serviço de push do endereço. */
export function vapidAuth(endpoint: string, now: Date = new Date()): string {
  const { publicKey, privateKey } = vapidKeys();
  // Contato do responsável pela plataforma (o serviço de push usa se houver problema com os envios).
  const email = get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'legal_email'")?.value;
  const sub = email ? `mailto:${email}` : config.appUrl.startsWith('https://') ? config.appUrl : 'mailto:suporte@sistemabarbearia.com.br';
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub })));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

// ---------- criptografia da mensagem (RFC 8291, aes128gcm)

/** `salt` e `serverKey` só nos testes (exemplo da RFC); fora deles, são novos a cada mensagem. */
export function encryptPayload(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, test?: { salt: Buffer; serverKey: Buffer }): Buffer {
  const ecdh = crypto.createECDH('prime256v1');
  if (test) ecdh.setPrivateKey(test.serverKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = test?.salt ?? crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(uaPublic), authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // Um registro só: o texto e o delimitador de último registro (2).
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// ---------- inscrições (cada celular/navegador que ligou os avisos)

/** O que o navegador devolve ao ligar os avisos (PushSubscription.toJSON()). */
export const zPushSubscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
export const zPushEndpoint = z.object({ endpoint: z.string().max(1000) });

export interface PushOwner {
  shopId: number;
  userId?: number | null;
  customerId?: number | null;
}

export function saveSubscription(owner: PushOwner, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null): void {
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    throw new HttpError(400, 'Inscrição de aviso inválida.');
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((h) => `.${url.hostname}`.endsWith(h))) throw new HttpError(400, 'Serviço de aviso não suportado neste navegador.');
  if (Buffer.from(sub.keys.p256dh, 'base64url').length !== 65 || Buffer.from(sub.keys.auth, 'base64url').length !== 16) {
    throw new HttpError(400, 'Inscrição de aviso inválida.');
  }
  // O mesmo celular trocou de conta: a inscrição passa para quem está logado agora.
  run(
    `INSERT INTO push_subscriptions (barbershop_id, user_id, customer_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET barbershop_id = excluded.barbershop_id, user_id = excluded.user_id, customer_id = excluded.customer_id,
       p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, fails = 0`,
    [owner.shopId, owner.userId ?? null, owner.customerId ?? null, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 200) ?? null, nowIso()],
  );
}

/** Desliga os avisos deste celular (só o dono da inscrição). */
export function removeSubscription(owner: PushOwner, endpoint: string): void {
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND barbershop_id = ? AND user_id IS ? AND customer_id IS ?', [
    endpoint,
    owner.shopId,
    owner.userId ?? null,
    owner.customerId ?? null,
  ]);
}

export function hasSubscription(owner: PushOwner): boolean {
  return Boolean(
    get('SELECT 1 AS ok FROM push_subscriptions WHERE barbershop_id = ? AND user_id IS ? AND customer_id IS ? LIMIT 1', [
      owner.shopId,
      owner.userId ?? null,
      owner.customerId ?? null,
    ]),
  );
}

// ---------- envio

interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

type Sender = (endpoint: string, init: { headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;
const httpSender: Sender = async (endpoint, init) => {
  const res = await fetch(endpoint, { method: 'POST', headers: init.headers, body: new Uint8Array(init.body), signal: AbortSignal.timeout(10_000) });
  return { status: res.status };
};
let sender: Sender = httpSender;
/** Testes: troca o envio por um que só registra. */
export function setPushSender(fn: Sender | null): void {
  sender = fn ?? httpSender;
}

async function deliver(s: SubRow, message: PushMessage): Promise<boolean> {
  const body = encryptPayload(Buffer.from(JSON.stringify(message)), Buffer.from(s.p256dh, 'base64url'), Buffer.from(s.auth, 'base64url'));
  try {
    const { status } = await sender(s.endpoint, {
      headers: { authorization: vapidAuth(s.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' },
      body,
    });
    // Não existe mais (desinstalou, limpou o navegador): sai da lista.
    if (status === 404 || status === 410) {
      run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
      return false;
    }
    if (status >= 200 && status < 300) {
      run('UPDATE push_subscriptions SET fails = 0, last_ok_at = ? WHERE id = ?', [nowIso(), s.id]);
      return true;
    }
  } catch (err) {
    console.error('[aviso no celular]', (err as Error).message);
  }
  run('UPDATE push_subscriptions SET fails = fails + 1 WHERE id = ?', [s.id]);
  run('DELETE FROM push_subscriptions WHERE id = ? AND fails >= ?', [s.id, MAX_FAILS]);
  return false;
}

/** Manda para todos os celulares inscritos das pessoas indicadas. Devolve quantos receberam. */
export async function pushTo(target: { shopId: number; userIds?: number[]; customerId?: number }, message: PushMessage): Promise<number> {
  const subs: SubRow[] = [];
  if (target.userIds?.length) {
    subs.push(
      ...all<SubRow>(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE barbershop_id = ? AND user_id IN (${target.userIds.map(() => '?').join(', ')})`, [
        target.shopId,
        ...target.userIds,
      ]),
    );
  }
  if (target.customerId) {
    subs.push(...all<SubRow>('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE barbershop_id = ? AND customer_id = ?', [target.shopId, target.customerId]));
  }
  let ok = 0;
  for (const s of subs) if (await deliver(s, message)) ok++;
  return ok;
}

// ---------- avisos da agenda

interface BookedView {
  id: number;
  barber_id: number;
  customer_name: string;
  barber_name: string;
  service_name: string;
  starts_at: string;
}

const when = (stamp: string) => `${stamp.slice(8, 10)}/${stamp.slice(5, 7)} às ${stamp.slice(11)}`;

/** Quem recebe os avisos da agenda: o barbeiro do horário e, se não foi o dono que mexeu, os donos. */
function agendaUsers(shopId: number, barberId: number, byOwner: boolean): number[] {
  return all<{ id: number }>(
    `SELECT id FROM users WHERE barbershop_id = ? AND ((role = 'barber' AND barber_id = ?) OR (role = 'owner' AND ? = 0))`,
    [shopId, barberId, byOwner ? 1 : 0],
  ).map((u) => u.id);
}

export async function notifyBooked(shopId: number, a: BookedView, byOwner: boolean): Promise<void> {
  const users = agendaUsers(shopId, a.barber_id, byOwner);
  if (!users.length) return;
  await pushTo(
    { shopId, userIds: users },
    { title: `Novo horário · ${when(a.starts_at)}`, body: `${a.customer_name} com ${a.barber_name} (${a.service_name})`, url: '/', tag: `horario-${a.id}` },
  );
}

export async function notifyCancelled(shopId: number, a: BookedView, byOwner: boolean): Promise<void> {
  const users = agendaUsers(shopId, a.barber_id, byOwner);
  if (!users.length) return;
  await pushTo(
    { shopId, userIds: users },
    { title: `Horário cancelado · ${when(a.starts_at)}`, body: `${a.customer_name} com ${a.barber_name} (${a.service_name})`, url: '/', tag: `horario-${a.id}` },
  );
}
