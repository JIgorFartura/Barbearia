import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import type { TemplateUse } from './templates.js';
import { localPhone, sendText, type Provider } from './whatsapp.js';

/** Tipos de mensagem no histórico do robô. */
export type MessageKind =
  | 'chat'
  | 'lembrete'
  | 'costume'
  | 'sumido'
  | 'codigo'
  | 'teste'
  | 'manual'
  | 'barbeiro'
  | 'avaliacao'
  | 'aniversario'
  | 'indicacao'
  | 'assinatura'
  | 'aviso';

export interface ShopBot {
  id: number;
  slug: string;
  name: string;
  active: number;
  address: string | null;
  hours: string | null;
  whatsapp: string | null;
  instagram: string | null;
  bot_name: string;
  bot_persona: string | null;
  wa_provider: Provider;
  wa_config: string | null;
  webhook_token: string;
  slot_step_min: number;
  reminder_hours: number;
  habit_enabled: number;
  habit_weekday: number;
  habit_time: string;
  winback_enabled: number;
  winback_days: number;
  winback_message: string | null;
}

export function shopBot(shopId: number): ShopBot {
  const shop = get<ShopBot>('SELECT * FROM barbershops WHERE id = ?', [shopId]);
  if (!shop) throw new HttpError(404, 'Barbearia não encontrada.');
  return shop;
}

export function waConfig(shop: ShopBot): unknown {
  try {
    return shop.wa_config ? JSON.parse(shop.wa_config) : {};
  } catch {
    return {};
  }
}

export interface CustomerRow {
  id: number;
  barbershop_id: number;
  name: string;
  phone: string;
  wa_id: string | null;
  reminders_opt_out: number;
}

/** Acha o cliente pelo celular, tolerando o nono dígito que o WhatsApp às vezes omite. */
export function customerByPhone(shopId: number, rawPhone: string): CustomerRow | undefined {
  const local = localPhone(rawPhone);
  if (local.length < 10) return undefined;
  return get<CustomerRow>(
    `SELECT id, barbershop_id, name, phone, wa_id, reminders_opt_out FROM customers
      WHERE barbershop_id = ? AND substr(phone, 1, 2) = ? AND substr(phone, -8) = ?
      ORDER BY length(phone) DESC LIMIT 1`,
    [shopId, local.slice(0, 2), local.slice(-8)],
  );
}

/** Para onde enviar: o número exato que o cliente usa no WhatsApp, se já falou com o robô. */
export const waTarget = (phone: string, waId?: string | null) => waId || `55${phone}`;

export interface SendOptions {
  shop: ShopBot;
  customerId: number | null;
  /** Celular com DDD (sem 55). */
  phone: string;
  waId?: string | null;
  text: string;
  kind: MessageKind;
  /** Simulador do painel: grava, mas não manda nada pelo WhatsApp. */
  dryRun?: boolean;
  tokens?: { in: number; out: number };
  /** Modelo da API oficial (Meta) para quando a mensagem sai fora da janela de 24h. */
  template?: TemplateUse | null;
}

/** Na API oficial e fora da janela de 24h, a mensagem sai pelo modelo aprovado (texto fixo, sem extras). */
export const sendsTemplate = (shop: ShopBot, phone: string) => shop.wa_provider === 'meta' && !inServiceWindow(shop.id, phone);

/** O cliente escreveu nas últimas 24h? (Na API oficial, só então vale texto livre.) */
export function inServiceWindow(shopId: number, phone: string): boolean {
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  return Boolean(get("SELECT 1 AS ok FROM messages WHERE barbershop_id = ? AND phone = ? AND direction = 'in' AND created_at >= ? LIMIT 1", [shopId, phone, since]));
}

/** Envia pelo canal da barbearia e grava no histórico. Nunca lança erro: falhas ficam registradas. */
export async function sendMessage(opts: SendOptions): Promise<{ id: number; status: string; error?: string }> {
  const provider: Provider = opts.dryRun ? 'simulador' : opts.shop.wa_provider;
  const automated = opts.kind !== 'chat' && opts.kind !== 'teste';
  const inWindow = provider === 'meta' && automated ? inServiceWindow(opts.shop.id, opts.phone) : true;
  const result = await sendText(provider, waConfig(opts.shop), waTarget(opts.phone, opts.waId), opts.text, { automated, template: opts.template, inWindow });
  const { lastInsertRowid } = run(
    `INSERT INTO messages (barbershop_id, customer_id, phone, direction, kind, body, status, error, external_id, tokens_in, tokens_out, created_at)
     VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.shop.id,
      opts.customerId,
      opts.phone,
      opts.kind,
      // O código de acesso não fica legível no histórico (nem para o dono, nem para o master).
      opts.kind === 'codigo' ? opts.text.replace(/\d{6}/g, '••••••') : opts.text,
      result.status,
      result.error ?? null,
      result.externalId ?? null,
      opts.tokens?.in ?? null,
      opts.tokens?.out ?? null,
      nowIso(),
    ],
  );
  if (result.status === 'failed') console.warn(`[whatsapp] ${opts.shop.slug} → ${opts.phone}: ${result.error}`);
  return { id: lastInsertRowid, status: result.status, error: result.error };
}

/** Grava a mensagem recebida. Devolve false se for repetida (o WhatsApp reenvia webhooks). */
export function recordInbound(shopId: number, customerId: number | null, phone: string, text: string, externalId: string | null): boolean {
  try {
    run(
      `INSERT INTO messages (barbershop_id, customer_id, phone, direction, kind, body, status, external_id, created_at)
       VALUES (?, ?, ?, 'in', 'chat', ?, 'received', ?, ?)`,
      [shopId, customerId, phone, text, externalId, nowIso()],
    );
    return true;
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return false;
    throw err;
  }
}

export interface HistoryItem {
  direction: 'in' | 'out';
  body: string;
  kind: string;
  created_at: string;
}

/** Conversa recente com esse celular (mais antigas primeiro), para o robô ter contexto. */
export function recentHistory(shopId: number, phone: string, limit = 12, hours = 12): HistoryItem[] {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  return all<HistoryItem>(
    `SELECT direction, body, kind, created_at FROM messages
      WHERE barbershop_id = ? AND phone = ? AND created_at >= ? AND status <> 'failed'
      ORDER BY id DESC LIMIT ?`,
    [shopId, phone, since, limit],
  ).reverse();
}
