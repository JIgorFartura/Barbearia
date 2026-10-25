import type { Router } from 'express';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { awayCustomers, sendWinback } from '../automations.js';
import { handleInbound } from '../bot/inbound.js';
import { checkShopConnection, connectionInfo, resetConnection } from '../connection.js';
import { llmEnabled } from '../bot/brain.js';
import { config } from '../config.js';
import { all, get, run } from '../db.js';
import { HttpError, idParam, normalizePhone, parseBody, zBool, zText } from '../http.js';
import { sendMessage, shopBot, waConfig } from '../messaging.js';
import { SHOP_TEMPLATE_KINDS, TEMPLATES, templateField } from '../templates.js';
import { isTime } from '../time.js';
import { PROVIDERS, zEvolutionConfig, zMetaConfig } from '../whatsapp.js';

const SECRET_MASK = '••••••';
const SECRET_FIELDS = ['token', 'appSecret', 'apiKey'];

/** Credenciais nunca voltam inteiras para a tela. */
function maskedConfig(raw: unknown): Record<string, string> {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, SECRET_FIELDS.includes(k) && v ? SECRET_MASK : String(v ?? '')]));
}

function botSettings(shop: number) {
  const s = shopBot(shop);
  const base = config.publicUrl || config.appUrl;
  return {
    bot_name: s.bot_name,
    bot_persona: s.bot_persona,
    wa_provider: s.wa_provider,
    wa_config: maskedConfig(waConfig(s)),
    webhooks: {
      meta: `${base}/api/webhooks/meta/${s.webhook_token}`,
      evolution: `${base}/api/webhooks/evolution/${s.webhook_token}`,
    },
    slot_step_min: s.slot_step_min,
    reminder_hours: s.reminder_hours,
    habit_enabled: Boolean(s.habit_enabled),
    habit_weekday: s.habit_weekday,
    habit_time: s.habit_time,
    winback_enabled: Boolean(s.winback_enabled),
    winback_days: s.winback_days,
    winback_message: s.winback_message,
    confirm_release_hours: s.confirm_release_hours,
    llm: llmEnabled(),
    connection: connectionInfo(shop),
    /** Modelos para cadastrar na Meta (WhatsApp oficial), com o texto sugerido. */
    templates: SHOP_TEMPLATE_KINDS.map((k) => ({ kind: k, field: templateField(k), ...TEMPLATES[k] })),
  };
}

const zSettings = z.object({
  bot_name: z.string().trim().min(2, 'Dê um nome ao robô.').max(30),
  bot_persona: zText(800),
  wa_provider: z.enum(PROVIDERS as [string, ...string[]]),
  wa_config: z.record(z.string(), z.string()).default({}),
  slot_step_min: z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
  reminder_hours: z.number().int().min(0).max(72),
  habit_enabled: zBool,
  habit_weekday: z.number().int().min(0).max(6),
  habit_time: z.string().refine(isTime, 'Hora no formato HH:MM.'),
  winback_enabled: zBool,
  winback_days: z.number().int().min(7).max(365),
  winback_message: zText(600),
  /** Liberar o horário de quem não confirmou até N horas antes (null = não libera). */
  confirm_release_hours: z.number().int().min(1).max(24).nullish().transform((v) => v ?? null),
});

/** Robô do WhatsApp, simulador, conversas e clientes sumidos (painel do dono). */
export function registerBotRoutes(router: Router): void {
  router.get('/bot', (req, res) => {
    res.json(botSettings(shopId(req)));
  });

  router.put('/bot', async (req, res) => {
    const shop = shopId(req);
    const body = parseBody(zSettings, req.body);
    // Quem não confirmou só perde o horário se teve pelo menos 2 horas para responder ao lembrete.
    if (body.confirm_release_hours && body.reminder_hours <= 0) throw new HttpError(400, 'Ligue o lembrete do horário: é ele que pede a confirmação.');
    if (body.confirm_release_hours && body.confirm_release_hours > body.reminder_hours - 2) {
      throw new HttpError(400, `O lembrete sai ${body.reminder_hours}h antes: o horário de quem não confirmar pode ser liberado até ${Math.max(1, body.reminder_hours - 2)}h antes.`);
    }
    // Campo de senha que voltou mascarado = manter o valor salvo.
    const before = shopBot(shop);
    const previous = waConfig(before) as Record<string, string>;
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.wa_config)) merged[k] = v === SECRET_MASK ? (previous[k] ?? '') : v;
    let waJson: string | null = null;
    if (body.wa_provider === 'meta') {
      waJson = JSON.stringify(parseBody(zMetaConfig.extend({ verifyToken: z.string().trim().min(6, 'Token de verificação do webhook (mín. 6 caracteres).') }), merged));
    }
    if (body.wa_provider === 'evolution') waJson = JSON.stringify(parseBody(zEvolutionConfig, merged));
    run(
      `UPDATE barbershops SET bot_name = ?, bot_persona = ?, wa_provider = ?, wa_config = COALESCE(?, wa_config), slot_step_min = ?, reminder_hours = ?,
              habit_enabled = ?, habit_weekday = ?, habit_time = ?, winback_enabled = ?, winback_days = ?, winback_message = ?, confirm_release_hours = ? WHERE id = ?`,
      [
        body.bot_name,
        body.bot_persona,
        body.wa_provider,
        waJson,
        body.slot_step_min,
        body.reminder_hours,
        body.habit_enabled,
        body.habit_weekday,
        body.habit_time,
        body.winback_enabled,
        body.winback_days,
        body.winback_message,
        body.confirm_release_hours,
        shop,
      ],
    );
    // Canal ou credenciais novas: a situação da conexão volta a "não verificada" e é conferida agora.
    const after = shopBot(shop);
    if (after.wa_provider !== before.wa_provider || after.wa_config !== before.wa_config) {
      resetConnection(shop);
      if (after.wa_provider !== 'simulador') await checkShopConnection(shop).catch(() => null);
    }
    res.json(botSettings(shop));
  });

  /** Confere agora se o WhatsApp está conectado. */
  router.post('/bot/check', async (req, res) => {
    res.json({ connection: await checkShopConnection(shopId(req)) });
  });

  /** Manda uma mensagem de teste pelo canal configurado. */
  router.post('/bot/test', async (req, res) => {
    const { phone } = parseBody(z.object({ phone: z.string() }), req.body);
    const shop = shopBot(shopId(req));
    const local = normalizePhone(phone);
    const result = await sendMessage({
      shop,
      customerId: null,
      phone: local,
      text: `Teste do ${shop.bot_name}, da ${shop.name}: se você recebeu esta mensagem, o WhatsApp está conectado! ✅`,
      kind: 'teste',
    });
    if (result.status === 'failed') throw new HttpError(502, `O WhatsApp recusou: ${result.error}`);
    res.json(result);
  });

  /** Simulador: conversa com o robô como se fosse um cliente (nada sai pelo WhatsApp). */
  router.post('/bot/simulate', async (req, res) => {
    const body = parseBody(z.object({ phone: z.string(), text: z.string().max(1000) }), req.body);
    const local = normalizePhone(body.phone);
    const reply = await handleInbound({ shopId: shopId(req), from: local, text: body.text, dryRun: true });
    res.json({ reply });
  });

  /** Conversas: últimas mensagens por celular. */
  router.get('/messages', (req, res) => {
    const shop = shopId(req);
    const phone = typeof req.query.phone === 'string' ? req.query.phone.replace(/\D/g, '') : '';
    if (phone) {
      res.json(
        all(
          `SELECT m.id, m.direction, m.kind, m.body, m.status, m.error, m.created_at FROM messages m
            WHERE m.barbershop_id = ? AND m.phone = ? ORDER BY m.id DESC LIMIT 100`,
          [shop, phone],
        ).reverse(),
      );
      return;
    }
    res.json(
      all(
        `SELECT m.phone, c.name AS customer, m.body AS last_body, m.direction AS last_direction, m.kind AS last_kind, m.status AS last_status,
                m.created_at AS last_at,
                (SELECT COUNT(*) FROM messages x WHERE x.barbershop_id = m.barbershop_id AND x.phone = m.phone) AS total
           FROM messages m LEFT JOIN customers c ON c.id = (
                  SELECT customer_id FROM messages y WHERE y.barbershop_id = m.barbershop_id AND y.phone = m.phone AND y.customer_id IS NOT NULL LIMIT 1)
          WHERE m.id IN (SELECT MAX(id) FROM messages WHERE barbershop_id = ? GROUP BY phone)
          ORDER BY m.id DESC LIMIT 100`,
        [shop],
      ),
    );
  });

  /** Clientes sumidos (não vêm há N dias). */
  router.get('/winback', (req, res) => {
    res.json({ days: shopBot(shopId(req)).winback_days, customers: awayCustomers(shopId(req)) });
  });

  router.post('/winback/:id', async (req, res) => {
    const shop = shopBot(shopId(req));
    const id = idParam(req);
    const away = awayCustomers(shop.id).find((a) => a.id === id);
    if (!away) throw new HttpError(404, 'Esse cliente não está na lista de sumidos.');
    const c = get<{ id: number; name: string; phone: string; wa_id: string | null }>('SELECT id, name, phone, wa_id FROM customers WHERE id = ?', [id])!;
    await sendWinback(shop, c, away.days, away.lastVisit, new Date());
    res.json({ ok: true });
  });
}
