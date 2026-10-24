import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Canais de WhatsApp. Cada barbearia escolhe o seu:
 * - simulador: nada sai do sistema (as mensagens ficam no histórico do painel) — bom para testar;
 * - meta: API oficial do WhatsApp (Cloud API da Meta);
 * - evolution: Evolution API (conecta o WhatsApp da barbearia por QR Code).
 */
export type Provider = 'simulador' | 'meta' | 'evolution';
export const PROVIDERS: Provider[] = ['simulador', 'meta', 'evolution'];

export const zMetaConfig = z.object({
  token: z.string().trim().min(10, 'Token de acesso da Meta.'),
  phoneNumberId: z.string().trim().regex(/^\d+$/, 'ID do número (só dígitos).'),
  appSecret: z.string().trim().max(200).optional().default(''),
  verifyToken: z.string().trim().min(6, 'Token de verificação do webhook (mín. 6 caracteres).'),
  /** Modelo aprovado para mensagens automáticas fora da janela de 24h (corpo com uma variável {{1}}). */
  templateName: z.string().trim().max(100).optional().default(''),
  templateLang: z.string().trim().max(10).optional().default('pt_BR'),
});
export type MetaConfig = z.infer<typeof zMetaConfig>;

export const zEvolutionConfig = z.object({
  baseUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s]+$/i, 'Endereço da Evolution API (https://...).')
    .transform((v) => v.replace(/\/+$/, '')),
  instance: z.string().trim().min(1, 'Nome da instância.').max(100),
  apiKey: z.string().trim().min(6, 'Chave (apikey) da Evolution API.'),
});
export type EvolutionConfig = z.infer<typeof zEvolutionConfig>;

export interface SendResult {
  status: 'sent' | 'simulated' | 'failed';
  externalId?: string;
  error?: string;
}

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v23.0';

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Envia texto. `to` no formato internacional só com dígitos (ex.: 5511988887777). */
export async function sendText(provider: Provider, rawConfig: unknown, to: string, text: string, opts: { automated?: boolean } = {}): Promise<SendResult> {
  try {
    if (provider === 'meta') {
      const cfg = zMetaConfig.parse(rawConfig);
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`;
      // Fora da janela de 24h a Meta só entrega modelos aprovados; as automações usam o modelo quando configurado.
      const body =
        opts.automated && cfg.templateName
          ? {
              messaging_product: 'whatsapp',
              to,
              type: 'template',
              template: {
                name: cfg.templateName,
                language: { code: cfg.templateLang || 'pt_BR' },
                components: [{ type: 'body', parameters: [{ type: 'text', text }] }],
              },
            }
          : { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: text } };
      const r = await postJson(url, { authorization: `Bearer ${cfg.token}` }, body);
      if (!r.ok) return { status: 'failed', error: r.data?.error?.message ?? `HTTP ${r.status}` };
      return { status: 'sent', externalId: r.data?.messages?.[0]?.id };
    }
    if (provider === 'evolution') {
      const cfg = zEvolutionConfig.parse(rawConfig);
      const r = await postJson(`${cfg.baseUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`, { apikey: cfg.apiKey }, { number: to, text });
      if (!r.ok) return { status: 'failed', error: r.data?.response?.message?.toString?.() ?? r.data?.message ?? `HTTP ${r.status}` };
      return { status: 'sent', externalId: r.data?.key?.id };
    }
    return { status: 'simulated' };
  } catch (err) {
    if (err instanceof z.ZodError) return { status: 'failed', error: 'WhatsApp não configurado corretamente no painel (aba Robô).' };
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Mensagem recebida, já no formato comum aos canais. */
export interface Inbound {
  /** Número de quem mandou, só dígitos, como o WhatsApp informa (ex.: 5511988887777). */
  from: string;
  name: string | null;
  /** Texto (vazio para áudio, foto etc.). */
  text: string;
  externalId: string;
}

/** Webhook da API oficial (Meta). */
export function parseMetaWebhook(body: any): Inbound[] {
  const out: Inbound[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), c?.profile?.name ?? '');
      for (const m of value.messages ?? []) {
        if (!m?.from || !m?.id) continue;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
        out.push({ from: String(m.from).replace(/\D/g, ''), name: names.get(String(m.from)) || null, text: String(text), externalId: String(m.id) });
      }
    }
  }
  return out;
}

/** Confere a assinatura X-Hub-Signature-256 (HMAC do corpo com o App Secret). */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Webhook da Evolution API (evento messages.upsert). */
export function parseEvolutionWebhook(body: any): Inbound[] {
  const event = String(body?.event ?? '').toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return [];
  const items = Array.isArray(body?.data) ? body.data : [body?.data];
  const out: Inbound[] = [];
  for (const d of items) {
    const jid = String(d?.key?.remoteJid ?? '');
    if (!jid.endsWith('@s.whatsapp.net') || d?.key?.fromMe || !d?.key?.id) continue;
    const msg = d.message ?? {};
    const text = msg.conversation ?? msg.extendedTextMessage?.text ?? msg.buttonsResponseMessage?.selectedDisplayText ?? '';
    out.push({ from: jid.split('@')[0].replace(/\D/g, ''), name: d.pushName || null, text: String(text), externalId: String(d.key.id) });
  }
  return out;
}

/** Número do WhatsApp (com 55) → celular com DDD como guardamos (10 ou 11 dígitos). */
export function localPhone(waNumber: string): string {
  const digits = waNumber.replace(/\D/g, '');
  return digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
}

/**
 * Chave para comparar celulares: DDD + últimos 8 dígitos. O WhatsApp às vezes informa números
 * brasileiros sem o nono dígito (5511 8888-7777 em vez de 5511 98888-7777).
 */
export const phoneKey = (local: string) => `${local.slice(0, 2)}|${local.slice(-8)}`;
