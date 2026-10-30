import crypto from 'node:crypto';
import { all, get, nowIso, run } from './db.js';
import type { TemplateUse } from './templates.js';
import { sendText, type Provider } from './whatsapp.js';

/**
 * WhatsApp da plataforma (o número do master). Fala com os donos e barbeiros: código de
 * "esqueci minha senha", aviso de WhatsApp da barbearia desconectado, lembrete da mensalidade, resumo
 * da semana e as respostas do gerente virtual (o dono pergunta, o sistema responde).
 * Configurado no painel master, aba Sistema. Sem ele (simulador), as mensagens só ficam registradas.
 */

export type PlatformKind = 'senha' | 'alerta' | 'fatura' | 'aviso' | 'teste' | 'gerente' | 'resumo';

export interface PlatformChannel {
  provider: Provider;
  config: Record<string, string>;
}

const setting = (key: string) => get<{ value: string }>('SELECT value FROM platform_settings WHERE key = ?', [key])?.value;

export function platformChannel(): PlatformChannel {
  const provider = (setting('wa_provider') ?? 'simulador') as Provider;
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(setting('wa_config') ?? '{}');
  } catch {
    cfg = {};
  }
  return { provider, config: cfg };
}

/** Segredo da URL que recebe as mensagens do WhatsApp da plataforma (gerente virtual dos donos). */
export function platformWebhookToken(): string {
  if (!setting('wa_webhook_token')) {
    run("INSERT INTO platform_settings (key, value) VALUES ('wa_webhook_token', ?) ON CONFLICT(key) DO NOTHING", [crypto.randomBytes(24).toString('base64url')]);
  }
  return setting('wa_webhook_token')!;
}

/** O número do WhatsApp da plataforma, para mostrar aos donos (falar com o gerente virtual). */
export const platformDisplayPhone = () => setting('wa_display_phone') || null;

export function savePlatformDisplayPhone(phone: string | null): void {
  run("INSERT INTO platform_settings (key, value) VALUES ('wa_display_phone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [phone ?? '']);
}

export function savePlatformChannel(provider: Provider, cfg: Record<string, string> | null): void {
  const put = (key: string, value: string) =>
    run('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  put('wa_provider', provider);
  if (cfg) put('wa_config', JSON.stringify(cfg));
}

export interface PlatformSend {
  /** Celular com DDD (sem 55). */
  phone: string;
  text: string;
  kind: PlatformKind;
  userId?: number | null;
  shopId?: number | null;
  template?: TemplateUse | null;
  /** Resposta a uma mensagem da pessoa (dentro da janela de 24h da Meta: vai como texto livre). */
  reply?: boolean;
  now?: Date;
}

/** Envia pelo WhatsApp da plataforma e registra. Nunca lança erro. */
export async function sendPlatformMessage(opts: PlatformSend): Promise<{ status: 'sent' | 'simulated' | 'failed'; error?: string }> {
  const { provider, config } = platformChannel();
  // Aviso por conta própria: na API oficial vale o modelo aprovado. Resposta ao gerente virtual: texto livre.
  const result = await sendText(provider, config, `55${opts.phone}`, opts.text, opts.reply ? {} : { automated: true, template: opts.template, inWindow: false });
  run('INSERT INTO platform_messages (barbershop_id, user_id, phone, kind, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    opts.shopId ?? null,
    opts.userId ?? null,
    opts.phone,
    opts.kind,
    // Códigos não ficam legíveis no histórico.
    opts.kind === 'senha' ? opts.text.replace(/\d{6}/g, '••••••') : opts.text,
    result.status,
    result.error ?? null,
    opts.now?.toISOString() ?? nowIso(),
  ]);
  if (result.status === 'failed') console.warn(`[whatsapp da plataforma] ${opts.phone}: ${result.error}`);
  return { status: result.status, error: result.error };
}

/** Avisa os donos da barbearia (e o master) que têm celular cadastrado. Devolve quantos avisos saíram. */
export async function notifyOwners(
  shopId: number,
  text: string,
  template: TemplateUse | null = null,
  opts: { includeMaster?: boolean; kind?: PlatformKind } = {},
): Promise<number> {
  // Donos da unidade: a casa do login ou uma unidade ligada a ele (rede com filiais).
  const people = all<{ id: number; phone: string }>(
    `SELECT id, phone FROM users WHERE phone IS NOT NULL AND ((role = 'owner' AND (barbershop_id = :s OR id IN (SELECT user_id FROM shop_members WHERE barbershop_id = :s)))${
      opts.includeMaster ? " OR role = 'master'" : ''
    })`,
    { s: shopId },
  );
  let sent = 0;
  for (const p of people) {
    const r = await sendPlatformMessage({ phone: p.phone, text, kind: opts.kind ?? 'alerta', userId: p.id, shopId, template });
    if (r.status !== 'failed') sent++;
  }
  return sent;
}
