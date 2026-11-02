import crypto from 'node:crypto';
import { z } from 'zod';
import { TEMPLATE_KINDS, TEMPLATES, templateField, type TemplateUse } from './templates.js';

/**
 * Canais de WhatsApp. Cada barbearia escolhe o seu:
 * - simulador: nada sai do sistema (as mensagens ficam no histórico do painel) — bom para testar;
 * - meta: API oficial do WhatsApp (Cloud API da Meta);
 * - evolution: Evolution API (conecta o WhatsApp da barbearia por QR Code).
 */
export type Provider = 'simulador' | 'meta' | 'evolution';
export const PROVIDERS: Provider[] = ['simulador', 'meta', 'evolution'];

/** Nome aprovado de cada modelo (tpl_lembrete, tpl_costume...); vazio = modelo não cadastrado. */
const templateFields = Object.fromEntries(TEMPLATE_KINDS.map((k) => [templateField(k), z.string().trim().max(100).optional().default('')])) as Record<
  `tpl_${(typeof TEMPLATE_KINDS)[number]}`,
  z.ZodDefault<z.ZodOptional<z.ZodString>>
>;

export const zMetaConfig = z.object({
  token: z.string().trim().min(10, 'Token de acesso da Meta.'),
  phoneNumberId: z.string().trim().regex(/^\d+$/, 'ID do número (só dígitos).'),
  appSecret: z.string().trim().max(200).optional().default(''),
  verifyToken: z.string().trim().min(6, 'Token de verificação do webhook (mín. 6 caracteres).').optional().default(''),
  /** Modelo genérico antigo (corpo com uma variável {{1}}): usado quando o tipo não tem modelo próprio. */
  templateName: z.string().trim().max(100).optional().default(''),
  templateLang: z.string().trim().max(10).optional().default('pt_BR'),
  ...templateFields,
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

export interface SendTextOptions {
  /** Mensagem que a barbearia manda por conta própria (lembrete, oferta...), não uma resposta. */
  automated?: boolean;
  /** Modelo e variáveis para a API oficial, quando a mensagem sai fora da janela de 24h. */
  template?: TemplateUse | null;
  /** O cliente escreveu nas últimas 24h: a Meta aceita texto livre. */
  inWindow?: boolean;
}

/** Corpo da mensagem para a API oficial: texto livre ou modelo aprovado. */
export function metaBody(cfg: MetaConfig, to: string, text: string, opts: SendTextOptions): Record<string, unknown> {
  const language = { code: cfg.templateLang || 'pt_BR' };
  const name = opts.template ? (cfg as Record<string, string>)[templateField(opts.template.kind)] : '';
  if (opts.automated && !opts.inWindow && opts.template && name) {
    const params = opts.template.params.map((p) => ({ type: 'text', text: p.replace(/\s*\n+\s*/g, ' ').slice(0, 1000) }));
    const components: Record<string, unknown>[] = [{ type: 'body', parameters: params }];
    // Modelo de autenticação: o botão "copiar código" leva o código como parâmetro.
    if (TEMPLATES[opts.template.kind].category === 'AUTHENTICATION') {
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: opts.template.params[0] }] });
    }
    return { messaging_product: 'whatsapp', to, type: 'template', template: { name, language, components } };
  }
  if (opts.automated && !opts.inWindow && cfg.templateName) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: cfg.templateName, language, components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n+\s*/g, ' ') }] }] },
    };
  }
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: text } };
}

/** Envia texto. `to` no formato internacional só com dígitos (ex.: 5511988887777). */
export async function sendText(provider: Provider, rawConfig: unknown, to: string, text: string, opts: SendTextOptions = {}): Promise<SendResult> {
  try {
    if (provider === 'meta') {
      const cfg = zMetaConfig.parse(rawConfig);
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`;
      // Fora da janela de 24h a Meta só entrega modelos aprovados: cada tipo de mensagem usa o seu.
      const body = metaBody(cfg, to, text, opts);
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

// ---------- conexão

/** Confere se o canal está conectado (Evolution: sessão do QR Code; Meta: token e número válidos). */
export async function probeConnection(provider: Provider, rawConfig: unknown, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  try {
    if (provider === 'evolution') {
      const cfg = zEvolutionConfig.parse(rawConfig);
      const res = await fetchImpl(`${cfg.baseUrl}/instance/connectionState/${encodeURIComponent(cfg.instance)}`, {
        headers: { apikey: cfg.apiKey },
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as { instance?: { state?: string }; state?: string; message?: unknown };
      if (!res.ok) return { ok: false, detail: `Evolution respondeu HTTP ${res.status}` };
      const state = data.instance?.state ?? data.state ?? 'desconhecido';
      return state === 'open' ? { ok: true, detail: 'conectado' } : { ok: false, detail: `WhatsApp desconectado (estado: ${state})` };
    }
    if (provider === 'meta') {
      const cfg = zMetaConfig.parse(rawConfig);
      const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}?fields=display_phone_number`, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return res.ok ? { ok: true, detail: 'conectado' } : { ok: false, detail: data.error?.message ?? `Meta respondeu HTTP ${res.status}` };
    }
    return { ok: true, detail: 'simulador' };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, detail: 'WhatsApp não configurado corretamente.' };
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Evento de conexão da Evolution (connection.update): "open" conectou, "close" caiu. */
export function parseEvolutionConnection(body: any): 'open' | 'close' | null {
  const event = String(body?.event ?? '').toLowerCase().replace(/_/g, '.');
  if (event !== 'connection.update') return null;
  const state = String(body?.data?.state ?? '').toLowerCase();
  return state === 'open' || state === 'close' ? state : null;
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
