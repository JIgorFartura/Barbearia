import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import type { TemplateUse } from './templates.js';
import { localPhone, sendText, type Provider, type SendResult } from './whatsapp.js';

/** Tipos de mensagem no histórico do robô. */
export type MessageKind =
  | 'chat'
  | 'lembrete'
  | 'costume'
  | 'sumido'
  | 'sumido2'
  | 'codigo'
  | 'teste'
  | 'manual'
  | 'barbeiro'
  | 'avaliacao'
  | 'aniversario'
  | 'indicacao'
  | 'assinatura'
  | 'espera'
  | 'liberado'
  | 'vazio'
  | 'fila'
  | 'campanha'
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
  /** Atende por ordem de chegada (fila pelo celular), junto com a agenda. */
  queue_enabled?: number;
  winback_days: number;
  winback_message: string | null;
  /** Quem já tem ritmo é chamado quando passa bem do tempo dele (senão, todos pelo prazo). */
  winback_rhythm: number;
  /** Desconto de volta no próximo horário (null = sem desconto), marcando em até N dias. */
  winback_discount: number | null;
  winback_discount_days: number;
  /** Segunda mensagem para quem não respondeu nem marcou, N dias depois (0 = não manda). */
  winback_followup_days: number;
  winback_followup_message: string | null;
  /** Libera o horário de quem não confirmou até N horas antes (null = não libera). */
  confirm_release_hours: number | null;
  /** Resumo da semana para o dono, toda segunda (WhatsApp da plataforma). */
  weekly_summary: number;
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

/** Minutos entre as novas tentativas de uma mensagem que falhou (depois da última, desiste). */
export const RETRY_DELAYS_MIN = [1, 5, 15];
/** Não tenta de novo: o código de acesso vence logo (o cliente pede outro) e o teste é do dono, na hora. */
const NO_RETRY = new Set<MessageKind>(['codigo', 'teste']);

interface RetryPayload {
  to: string;
  text: string;
  automated: boolean;
  template: TemplateUse | null;
}

const addMin = (now: Date, min: number) => new Date(now.getTime() + min * 60000).toISOString();

/** Uma tentativa de envio pelo canal da barbearia (na API oficial, modelo ou texto conforme a janela de 24h). */
function attempt(shop: ShopBot, provider: Provider, phone: string, p: RetryPayload): Promise<SendResult> {
  const inWindow = provider === 'meta' && p.automated ? inServiceWindow(shop.id, phone) : true;
  return sendText(provider, waConfig(shop), p.to, p.text, { automated: p.automated, template: p.template ?? undefined, inWindow });
}

/**
 * Envia pelo canal da barbearia e grava no histórico. Nunca lança erro: falhas ficam registradas.
 * Se o WhatsApp falhar, a mensagem fica "tentando de novo" (1, 5 e 15 minutos depois, em retryMessages);
 * para quem chamou, ela conta como não entregue.
 */
export async function sendMessage(opts: SendOptions): Promise<{ id: number; status: string; error?: string }> {
  const provider: Provider = opts.dryRun ? 'simulador' : opts.shop.wa_provider;
  const payload: RetryPayload = {
    to: waTarget(opts.phone, opts.waId),
    text: opts.text,
    automated: opts.kind !== 'chat' && opts.kind !== 'teste',
    template: opts.template ?? null,
  };
  const result = await attempt(opts.shop, provider, opts.phone, payload);
  // Configuração errada no painel não se resolve sozinha: aí não adianta tentar de novo.
  const retry = result.status === 'failed' && provider !== 'simulador' && !NO_RETRY.has(opts.kind) && !result.error?.startsWith('WhatsApp não configurado');
  const { lastInsertRowid } = run(
    `INSERT INTO messages (barbershop_id, customer_id, phone, direction, kind, body, status, error, external_id, tokens_in, tokens_out, retry_at, retry_payload, created_at)
     VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.shop.id,
      opts.customerId,
      opts.phone,
      opts.kind,
      // O código de acesso não fica legível no histórico (nem para o dono, nem para o master).
      opts.kind === 'codigo' ? opts.text.replace(/\d{6}/g, '••••••') : opts.text,
      retry ? 'retrying' : result.status,
      result.error ?? null,
      result.externalId ?? null,
      opts.tokens?.in ?? null,
      opts.tokens?.out ?? null,
      retry ? addMin(new Date(), RETRY_DELAYS_MIN[0]) : null,
      retry ? JSON.stringify(payload) : null,
      nowIso(),
    ],
  );
  if (result.status === 'failed') console.warn(`[whatsapp] ${opts.shop.slug} → ${opts.phone}: ${result.error}${retry ? ' (vai tentar de novo)' : ''}`);
  return { id: lastInsertRowid, status: result.status, error: result.error };
}

/**
 * Manda de novo as mensagens que falharam e já deram o tempo. Depois da última tentativa, desiste: a
 * mensagem fica "falhou" e aparece no aviso do painel do dono e na tela Sistema do master.
 */
export async function retryMessages(now: Date = new Date()): Promise<{ resent: number; gaveUp: number }> {
  const due = all<{ id: number; barbershop_id: number; phone: string; attempts: number; retry_payload: string }>(
    "SELECT id, barbershop_id, phone, attempts, retry_payload FROM messages WHERE status = 'retrying' AND retry_at <= ? ORDER BY retry_at LIMIT 200",
    [now.toISOString()],
  );
  let resent = 0;
  let gaveUp = 0;
  for (const m of due) {
    const shop = get<ShopBot>('SELECT * FROM barbershops WHERE id = ?', [m.barbershop_id]);
    const attempts = m.attempts + 1;
    const giveUp = (error: string) => {
      run("UPDATE messages SET status = 'failed', error = ?, attempts = ?, retry_at = NULL, retry_payload = NULL WHERE id = ?", [error, attempts, m.id]);
      gaveUp++;
    };
    // Barbearia desativada ou que desligou o WhatsApp: não insiste.
    if (!shop || !shop.active || shop.wa_provider === 'simulador') {
      giveUp('O WhatsApp da barbearia não está mais ligado.');
      continue;
    }
    let payload: RetryPayload;
    try {
      payload = JSON.parse(m.retry_payload) as RetryPayload;
    } catch {
      giveUp('Mensagem sem os dados para reenviar.');
      continue;
    }
    const result = await attempt(shop, shop.wa_provider, m.phone, payload);
    if (result.status !== 'failed') {
      run('UPDATE messages SET status = ?, error = NULL, external_id = ?, attempts = ?, retry_at = NULL, retry_payload = NULL WHERE id = ?', [
        result.status,
        result.externalId ?? null,
        attempts,
        m.id,
      ]);
      resent++;
    } else if (attempts <= RETRY_DELAYS_MIN.length) {
      run('UPDATE messages SET error = ?, attempts = ?, retry_at = ? WHERE id = ?', [result.error ?? null, attempts, addMin(now, RETRY_DELAYS_MIN[attempts - 1]), m.id]);
    } else {
      giveUp(result.error ?? 'O WhatsApp recusou a mensagem.');
      console.warn(`[whatsapp] ${shop.slug} → ${m.phone}: desistiu depois de ${attempts} tentativas (${result.error})`);
    }
  }
  return { resent, gaveUp };
}

/** Mensagens que não chegaram nem depois de tentar de novo, nas últimas 24h (aviso no painel do dono). */
export function undeliveredCount(shopId: number, now: Date = new Date()): number {
  const since = new Date(now.getTime() - 86400000).toISOString();
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE barbershop_id = ? AND direction = 'out' AND status = 'failed' AND created_at >= ?", [shopId, since])!.n;
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
      WHERE barbershop_id = ? AND phone = ? AND created_at >= ? AND status NOT IN ('failed', 'retrying')
      ORDER BY id DESC LIMIT ?`,
    [shopId, phone, since, limit],
  ).reverse();
}
