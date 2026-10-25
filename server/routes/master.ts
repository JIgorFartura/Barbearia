import { Router } from 'express';
import { platformPayments } from '../gatewayPayments.js';
import { stopSubscriptionCard, subscriptionPriceChanged } from '../cards.js';
import { cieloWebhookUrl, platformCardReady, platformCielo, savePlatformCielo, secretHint } from '../cardSettings.js';
import { CieloError, testCielo } from '../cielo.js';
import { PIX_KEY_TYPES, guessPixKeyType, normalizePixKey, pixKeyType } from '../pix.js';
import { asaasEnabled, asaasSettings, cancelInvoiceEverywhere, issueNfse, rotateWebhookToken, saveAsaasSettings, syncManualPayment, testAsaas } from '../asaas.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, requireRole } from '../auth.js';
import { automationStatus } from '../automations.js';
import { backupPath, backupStatus, createBackup, listBackups, remoteConfig } from '../backup.js';
import { encrypt } from '../backupCrypto.js';
import {
  accessStatus,
  createInvoice,
  ensureInvoices,
  invoice,
  listInvoices,
  markInvoicePaid,
  monthlyPrice,
  platformRevenue,
  platformSettings,
  savePlatformSettings,
  shopBilling,
} from '../billing.js';
import { llmEnabled } from '../bot/brain.js';
import { downShops } from '../connection.js';
import { platformChannel, savePlatformChannel, sendPlatformMessage } from '../platform.js';
import { legalInfo, saveLegalInfo } from '../privacy.js';
import { PLATFORM_TEMPLATE_KINDS, TEMPLATES, templateField } from '../templates.js';
import { PROVIDERS, zEvolutionConfig, zMetaConfig } from '../whatsapp.js';
import { config } from '../config.js';
import { all, get, nowIso, run, tx } from '../db.js';
import { HttpError, idParam, normalizePhone, parseBody, zId, zText } from '../http.js';
import { addDays, isDate, localNow } from '../time.js';
import { zPassword } from './auth.js';

/**
 * Painel do dono da plataforma: cadastra cada barbearia (o "inquilino") e o login do dono dela,
 * acompanha tudo o que acontece e pode entrar no painel de qualquer barbearia.
 */
export const masterRouter = Router();
masterRouter.use(requireRole('master'));

const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'Endereço só com letras minúsculas, números e hífen (ex.: barbearia-do-ze).');

const zOwner = z.object({
  ownerName: z.string().trim().min(2, 'Informe o nome do dono.'),
  ownerEmail: z.string().trim().toLowerCase().email('E-mail do dono inválido.'),
  ownerPassword: zPassword,
  /** Celular do dono: recebe o código de "esqueci minha senha" e os avisos da plataforma. */
  ownerPhone: z.string().max(30).nullish(),
});

const ownerPhone = (raw: string | null | undefined) => (raw?.trim() ? normalizePhone(raw) : null);

function assertFreePhone(phone: string | null, exceptId = 0): void {
  if (phone && get('SELECT 1 AS ok FROM users WHERE phone = ? AND id <> ?', [phone, exceptId])) throw new HttpError(409, 'Esse celular já está em outro login.');
}

function assertFreeSlug(slug: string, exceptId = 0): void {
  if (get('SELECT 1 AS ok FROM barbershops WHERE slug = ? AND id <> ?', [slug, exceptId])) {
    throw new HttpError(409, 'Esse endereço já é usado por outra barbearia.');
  }
}

function assertFreeEmail(email: string): void {
  if (get('SELECT 1 AS ok FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Já existe um usuário com esse e-mail.');
}

/**
 * Barbearias para o controle geral: cadastro, logins dos donos, mensalidade, conexão do WhatsApp e
 * consumo da IA. O master não enxerga barbeiros, agenda, clientes nem conversas (são da barbearia).
 */
masterRouter.get('/shops', (_req, res) => {
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  res.json(
    all(
      `
      SELECT b.id, b.slug, b.name, b.active, b.created_at, b.bot_name, b.wa_provider, b.wa_status, b.wa_status_at,
             (SELECT group_concat(email, ', ') FROM users u WHERE u.barbershop_id = b.id AND u.role = 'owner') AS owners,
             (SELECT COUNT(*) FROM messages m WHERE m.barbershop_id = b.id AND m.status = 'failed' AND m.created_at >= :since7) AS failed_week,
             (SELECT COALESCE(SUM(tokens_in), 0) FROM messages m WHERE m.barbershop_id = b.id AND m.created_at >= :since30) AS tokens_in_30d,
             (SELECT COALESCE(SUM(tokens_out), 0) FROM messages m WHERE m.barbershop_id = b.id AND m.created_at >= :since30) AS tokens_out_30d
        FROM barbershops b ORDER BY b.name`,
      { since7, since30 },
    ).map((row) => {
      const id = (row as { id: number }).id;
      const billing = shopBilling(id);
      const access = accessStatus(id);
      return {
        ...row,
        plan_id: billing.plan_id,
        plan_name: billing.plan_name,
        monthly_price_cents: billing.monthly_price_cents,
        price_cents: monthlyPrice(billing),
        billing_day: billing.billing_day,
        trial_until: billing.trial_until,
        released_until: billing.released_until,
        blocked: access.blocked,
        open_invoices: access.open.length,
        overdue_invoices: access.open.filter((i) => i.overdue).length,
      };
    }),
  );
});

/** Visão geral da plataforma: barbearias, situação das mensalidades, WhatsApp e IA. */
masterRouter.get('/overview', (_req, res) => {
  const today = localNow().date;
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const shops = all<{ id: number; trial_until: string | null; wa_status: string | null }>('SELECT id, trial_until, wa_status FROM barbershops WHERE active = 1');
  const access = shops.map((s) => accessStatus(s.id));
  const tokens = get<{ tin: number; tout: number }>('SELECT COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout FROM messages WHERE created_at >= ?', [
    since30,
  ])!;
  res.json({
    shops: shops.length,
    trial: shops.filter((s) => s.trial_until && s.trial_until >= today).length,
    overdue: access.filter((a) => a.open.some((i) => i.overdue)).length,
    blocked: access.filter((a) => a.blocked).length,
    whatsappDown: shops.filter((s) => s.wa_status === 'down').length,
    tokens30d: { in: tokens.tin, out: tokens.tout },
    llm: llmEnabled(),
    model: llmEnabled() ? config.botModel : null,
  });
});

const zBilling = z.object({
  plan_id: zId.nullish().transform((v) => v ?? null),
  /** Valor combinado (vazio = preço do plano). */
  monthly_price_cents: z.number().int().min(0).max(100_000_000).nullish().transform((v) => v ?? null),
  billing_day: z.number().int().min(1).max(31),
});

function assertPlan(planId: number | null) {
  if (planId && !get('SELECT 1 AS ok FROM plans WHERE id = ?', [planId])) throw new HttpError(400, 'Plano não encontrado.');
}

masterRouter.post('/shops', (req, res) => {
  const body = parseBody(
    z
      .object({ name: z.string().trim().min(2, 'Informe o nome da barbearia.'), slug: zSlug, trial_days: z.number().int().min(0).max(365).nullish() })
      .extend(zOwner.shape)
      .extend(zBilling.partial().shape),
    req.body,
  );
  assertPlan(body.plan_id ?? null);
  const trialDays = body.trial_days ?? platformSettings().trial_days;
  const trialUntil = trialDays > 0 ? addDays(localNow().date, trialDays) : null;
  const phone = ownerPhone(body.ownerPhone);
  const id = tx(() => {
    assertFreeSlug(body.slug);
    assertFreeEmail(body.ownerEmail);
    assertFreePhone(phone);
    const shop = run('INSERT INTO barbershops (slug, name, plan_id, monthly_price_cents, billing_day, trial_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      body.slug,
      body.name,
      body.plan_id ?? null,
      body.monthly_price_cents ?? null,
      body.billing_day ?? 10,
      trialUntil,
      nowIso(),
    ]).lastInsertRowid;
    run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, created_at) VALUES (?, 'owner', ?, ?, ?, ?, ?)", [
      shop,
      body.ownerName,
      body.ownerEmail,
      phone,
      hashPassword(body.ownerPassword),
      nowIso(),
    ]);
    return shop;
  });
  res.status(201).json({ id });
});

masterRouter.put('/shops/:id', async (req, res) => {
  const id = idParam(req);
  const body = parseBody(z.object({ name: z.string().trim().min(2), slug: zSlug, active: z.boolean() }), req.body);
  assertFreeSlug(body.slug, id);
  const { changes } = run('UPDATE barbershops SET name = ?, slug = ?, active = ? WHERE id = ?', [body.name, body.slug, body.active, id]);
  if (!changes) throw new HttpError(404, 'Barbearia não encontrada.');
  // Suspensa: para de cobrar a mensalidade no cartão.
  const warning = body.active ? null : await stopSubscriptionCard(id);
  res.json({ ok: true, warning });
});

/** Mais um login para a mesma barbearia (sócio, gerente). */
masterRouter.post('/shops/:id/owners', (req, res) => {
  const id = idParam(req);
  const body = parseBody(zOwner, req.body);
  if (!get('SELECT 1 AS ok FROM barbershops WHERE id = ?', [id])) throw new HttpError(404, 'Barbearia não encontrada.');
  assertFreeEmail(body.ownerEmail);
  const phone = ownerPhone(body.ownerPhone);
  assertFreePhone(phone);
  run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, created_at) VALUES (?, 'owner', ?, ?, ?, ?, ?)", [
    id,
    body.ownerName,
    body.ownerEmail,
    phone,
    hashPassword(body.ownerPassword),
    nowIso(),
  ]);
  res.status(201).json({ ok: true });
});

/** Plano, valor e vencimento da mensalidade de uma barbearia. */
masterRouter.put('/shops/:id/billing', async (req, res) => {
  const id = idParam(req);
  const body = parseBody(zBilling.extend({ trial_until: z.string().refine(isDate, 'Data inválida.').nullish().transform((v) => v ?? null) }), req.body);
  assertPlan(body.plan_id);
  const { changes } = run('UPDATE barbershops SET plan_id = ?, monthly_price_cents = ?, billing_day = ?, trial_until = ? WHERE id = ?', [
    body.plan_id,
    body.monthly_price_cents,
    body.billing_day,
    body.trial_until,
    id,
  ]);
  if (!changes) throw new HttpError(404, 'Barbearia não encontrada.');
  // Mudou o valor: o cartão automático (no valor antigo) é desligado e a barbearia cadastra de novo.
  await subscriptionPriceChanged(id);
  res.json({ ok: true });
});

/** Libera o acesso até uma data, mesmo com mensalidade em atraso (null tira a liberação). */
masterRouter.post('/shops/:id/release', (req, res) => {
  const { until } = parseBody(z.object({ until: z.string().refine(isDate, 'Data inválida.').nullable() }), req.body);
  const { changes } = run('UPDATE barbershops SET released_until = ? WHERE id = ?', [until, idParam(req)]);
  if (!changes) throw new HttpError(404, 'Barbearia não encontrada.');
  res.json(accessStatus(idParam(req)));
});

masterRouter.get('/shops/:id/owners', (req, res) => {
  res.json(all("SELECT id, name, email, phone, created_at FROM users WHERE barbershop_id = ? AND role = 'owner' ORDER BY id", [idParam(req)]));
});

/** Celular de um login de dono (recebe o código de "esqueci minha senha" e os avisos). */
masterRouter.put('/owners/:id/phone', (req, res) => {
  const { phone: raw } = parseBody(z.object({ phone: z.string().max(30).nullish() }), req.body);
  const phone = ownerPhone(raw);
  assertFreePhone(phone, idParam(req));
  const { changes } = run("UPDATE users SET phone = ? WHERE id = ? AND role = 'owner'", [phone, idParam(req)]);
  if (!changes) throw new HttpError(404, 'Login não encontrado.');
  res.json({ ok: true });
});

/** Nova senha para um login de dono (ele troca depois). */
masterRouter.put('/owners/:id/password', (req, res) => {
  const { password } = parseBody(z.object({ password: zPassword }), req.body);
  const { changes } = run("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'owner'", [hashPassword(password), idParam(req)]);
  if (!changes) throw new HttpError(404, 'Login não encontrado.');
  run('DELETE FROM sessions WHERE user_id = ?', [idParam(req)]);
  res.json({ ok: true });
});

// ---------- financeiro da plataforma (mensalidades)

const zPlan = z.object({
  name: z.string().trim().min(2).max(60),
  price_cents: z.number().int().min(0).max(100_000_000),
  description: zText(300),
  active: z.boolean(),
});

masterRouter.get('/plans', (_req, res) => {
  res.json(all('SELECT p.*, (SELECT COUNT(*) FROM barbershops b WHERE b.plan_id = p.id) AS shops FROM plans p ORDER BY p.active DESC, p.price_cents'));
});

masterRouter.post('/plans', (req, res) => {
  const b = parseBody(zPlan, req.body);
  const id = run('INSERT INTO plans (name, price_cents, description, active, created_at) VALUES (?, ?, ?, ?, ?)', [b.name, b.price_cents, b.description, b.active, nowIso()]).lastInsertRowid;
  res.status(201).json(get('SELECT * FROM plans WHERE id = ?', [id]));
});

masterRouter.put('/plans/:id', (req, res) => {
  const b = parseBody(zPlan, req.body);
  const { changes } = run('UPDATE plans SET name = ?, price_cents = ?, description = ?, active = ? WHERE id = ?', [b.name, b.price_cents, b.description, b.active, idParam(req)]);
  if (!changes) throw new HttpError(404, 'Plano não encontrado.');
  res.json(get('SELECT * FROM plans WHERE id = ?', [idParam(req)]));
});

masterRouter.get('/settings', (_req, res) => {
  res.json(settingsView());
});

const settingsView = () => {
  const s = platformSettings();
  return { ...s, pix_type: s.pix_key ? pixKeyType(s.pix_key) : 'cpf' };
};

masterRouter.put('/settings', (req, res) => {
  const { pix_type, ...b } = parseBody(
    z.object({
      grace_days: z.number().int().min(0).max(60),
      trial_days: z.number().int().min(0).max(365),
      pix_type: z.enum(PIX_KEY_TYPES).nullish(),
      pix_key: z.string().trim().max(77),
      pix_name: z.string().trim().max(60),
      pix_city: z.string().trim().max(40),
    }),
    req.body,
  );
  // Chave no formato que os bancos aceitam no PIX copia e cola (ex.: celular como +55...).
  let key = '';
  if (b.pix_key) {
    key = normalizePixKey(pix_type ?? guessPixKeyType(b.pix_key), b.pix_key) ?? '';
    if (!key) throw new HttpError(400, 'Chave PIX inválida para o tipo escolhido.');
  }
  savePlatformSettings({ ...b, pix_key: key });
  res.json(settingsView());
});

masterRouter.get('/billing', (req, res) => {
  const status = typeof req.query.status === 'string' && ['open', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : undefined;
  res.json({ revenue: platformRevenue(), invoices: listInvoices({ status }) });
});

/** Gera agora as faturas do mês (normalmente acontece sozinho). */
masterRouter.post('/billing/generate', (_req, res) => {
  res.json({ created: ensureInvoices() });
});

masterRouter.post('/invoices', (req, res) => {
  const b = parseBody(
    z.object({
      barbershop_id: zId,
      description: z.string().trim().min(2).max(120),
      amount_cents: z.number().int().min(1).max(100_000_000),
      due_date: z.string().refine(isDate, 'Data inválida.'),
    }),
    req.body,
  );
  res.status(201).json(createInvoice(b.barbershop_id, b));
});

masterRouter.post('/invoices/:id/pay', (req, res) => {
  const b = parseBody(
    z.object({
      paid_at: z.string().refine(isDate, 'Data inválida.'),
      method: z.enum(['pix', 'boleto', 'cartao', 'dinheiro', 'transferencia', 'outro']).nullish().transform((v) => v ?? null),
      notes: zText(200),
    }),
    req.body,
  );
  const inv = markInvoicePaid(idParam(req), b);
  // Pagou por fora: dá baixa também no Asaas (e pede a nota fiscal, se ligada).
  void syncManualPayment(inv.id);
  res.json(inv);
});

masterRouter.post('/invoices/:id/cancel', async (req, res) => {
  res.json(await cancelInvoiceEverywhere(idParam(req)));
});

/** Tenta de novo a nota fiscal de uma mensalidade paga. */
masterRouter.post('/invoices/:id/nfse', async (req, res) => {
  const id = idParam(req);
  run('UPDATE invoices SET nfse_error = NULL WHERE id = ?', [id]);
  const ok = await issueNfse(id);
  const inv = invoice(id);
  if (!ok && inv.nfse_error) throw new HttpError(502, inv.nfse_error);
  res.json(inv);
});

// ---------- cobrança automática pelo Asaas (PIX com baixa automática e nota fiscal)

const asaasView = () => {
  const s = asaasSettings();
  return {
    env: s.env,
    hasKey: Boolean(s.apiKey),
    keyHint: s.apiKey ? `••••${s.apiKey.slice(-4)}` : null,
    webhookUrl: `${config.appUrl}/api/webhooks/asaas`,
    webhookToken: s.webhookToken || null,
    nfse: s.nfse,
    webhookAt: s.webhookAt,
    shopsWithoutDocument: all<{ id: number; name: string }>(
      'SELECT id, name FROM barbershops WHERE active = 1 AND billing_document IS NULL ORDER BY name COLLATE NOCASE',
    ),
  };
};

masterRouter.get('/asaas', (_req, res) => {
  res.json(asaasView());
});

masterRouter.put('/asaas', (req, res) => {
  const b = parseBody(
    z.object({
      env: z.enum(['sandbox', 'production']),
      apiKey: z.string().trim().max(300).nullish(),
      nfse: z.object({
        enabled: z.boolean(),
        serviceName: z.string().trim().max(250),
        serviceCode: z.string().trim().max(30),
        iss: z.number().min(0).max(10),
        observations: z.string().trim().max(500),
      }),
    }),
    req.body,
  );
  if (b.nfse.enabled && !b.nfse.serviceName) throw new HttpError(400, 'Para emitir a nota, informe o serviço (como está no cadastro da prefeitura).');
  saveAsaasSettings({ env: b.env, apiKey: b.apiKey || null, nfse: b.nfse });
  res.json(asaasView());
});

// ---------- cartão pela Cielo (mensalidade das barbearias no cartão automático)

const cieloView = () => {
  const c = platformCielo();
  return {
    clientId: c.clientId || null,
    secretHint: secretHint(c.clientSecret),
    ready: platformCardReady(),
    feePct: c.feePct,
    webhookUrl: c.webhookToken ? cieloWebhookUrl(c.webhookToken) : null,
    returnUrl: `${config.appUrl}/painel/mensalidade`,
    webhookAt: c.webhookAt,
  };
};

masterRouter.get('/cielo', (_req, res) => {
  res.json(cieloView());
});

masterRouter.put('/cielo', (req, res) => {
  const b = parseBody(
    z.object({ clientId: z.string().trim().max(100), clientSecret: z.string().trim().max(200).nullish(), feePct: z.number().min(0).max(20) }),
    req.body,
  );
  savePlatformCielo(b);
  res.json(cieloView());
});

masterRouter.post('/cielo/test', async (_req, res) => {
  const c = platformCielo();
  if (!c.clientId || !c.clientSecret) throw new HttpError(409, 'Salve o ClientId e o Client Secret primeiro.');
  try {
    await testCielo({ clientId: c.clientId, clientSecret: c.clientSecret });
  } catch (err) {
    if (err instanceof CieloError) throw new HttpError(502, err.message);
    throw err;
  }
  res.json({ ok: true });
});

/**
 * Mensalidades pagas online pelas barbearias (cartão pela Cielo; PIX ou boleto pelo Asaas). O que os
 * clientes pagam às barbearias é delas: não aparece para o master.
 */
masterRouter.get('/payments', (req, res) => {
  const today = localNow().date;
  const from = typeof req.query.from === 'string' && isDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = typeof req.query.to === 'string' && isDate(req.query.to) ? req.query.to : today;
  res.json({ asaas: asaasEnabled(), cielo: platformCardReady(), from, to, ...platformPayments({ from, to }) });
});

masterRouter.post('/asaas/test', async (_req, res) => {
  try {
    await testAsaas();
  } catch (err) {
    throw new HttpError(502, (err as Error).message);
  }
  res.json({ ok: true });
});

masterRouter.post('/asaas/token', (_req, res) => {
  rotateWebhookToken();
  res.json(asaasView());
});

// ---------- avisos e atualizações para as barbearias

const zAnnouncement = z.object({
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(2).max(1000),
  level: z.enum(['novidade', 'aviso', 'manutencao']),
  active: z.boolean(),
});

masterRouter.get('/announcements', (_req, res) => {
  res.json(all('SELECT * FROM announcements ORDER BY id DESC'));
});

masterRouter.post('/announcements', (req, res) => {
  const b = parseBody(zAnnouncement, req.body);
  const id = run('INSERT INTO announcements (title, body, level, active, created_at) VALUES (?, ?, ?, ?, ?)', [b.title, b.body, b.level, b.active, nowIso()]).lastInsertRowid;
  res.status(201).json(get('SELECT * FROM announcements WHERE id = ?', [id]));
});

masterRouter.put('/announcements/:id', (req, res) => {
  const b = parseBody(zAnnouncement, req.body);
  const { changes } = run('UPDATE announcements SET title = ?, body = ?, level = ?, active = ? WHERE id = ?', [b.title, b.body, b.level, b.active, idParam(req)]);
  if (!changes) throw new HttpError(404, 'Aviso não encontrado.');
  res.json(get('SELECT * FROM announcements WHERE id = ?', [idParam(req)]));
});

masterRouter.delete('/announcements/:id', (req, res) => {
  const { changes } = run('DELETE FROM announcements WHERE id = ?', [idParam(req)]);
  if (!changes) throw new HttpError(404, 'Aviso não encontrado.');
  res.json({ ok: true });
});

// ---------- empresa (aparece nos termos de uso e na política de privacidade)

masterRouter.get('/legal', (_req, res) => {
  res.json(legalInfo());
});

masterRouter.put('/legal', (req, res) => {
  const b = parseBody(
    z.object({
      company: z.string().trim().min(2, 'Informe o nome da empresa.').max(120),
      document: z.string().trim().max(30),
      email: z.string().trim().max(120),
      address: z.string().trim().max(200),
    }),
    req.body,
  );
  saveLegalInfo(b);
  res.json(legalInfo());
});

// ---------- WhatsApp da plataforma (avisos aos donos e "esqueci minha senha")

const SECRET_MASK = '••••••';
const SECRET_FIELDS = ['token', 'appSecret', 'apiKey'];

function platformWhatsapp() {
  const { provider, config: cfg } = platformChannel();
  return {
    provider,
    config: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, SECRET_FIELDS.includes(k) && v ? SECRET_MASK : String(v ?? '')])),
    templates: PLATFORM_TEMPLATE_KINDS.map((k) => ({ kind: k, field: templateField(k), ...TEMPLATES[k] })),
    down: downShops(),
    recent: all("SELECT id, phone, kind, status, error, created_at FROM platform_messages ORDER BY id DESC LIMIT 10"),
  };
}

masterRouter.get('/whatsapp', (_req, res) => {
  res.json(platformWhatsapp());
});

masterRouter.put('/whatsapp', (req, res) => {
  const body = parseBody(z.object({ provider: z.enum(PROVIDERS as [string, ...string[]]), config: z.record(z.string(), z.string()).default({}) }), req.body);
  const previous = platformChannel().config;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.config)) merged[k] = v === SECRET_MASK ? (previous[k] ?? '') : v;
  let cfg: Record<string, string> | null = null;
  if (body.provider === 'meta') cfg = parseBody(zMetaConfig, merged) as Record<string, string>;
  if (body.provider === 'evolution') cfg = parseBody(zEvolutionConfig, merged) as Record<string, string>;
  savePlatformChannel(body.provider as 'simulador' | 'meta' | 'evolution', cfg);
  res.json(platformWhatsapp());
});

masterRouter.post('/whatsapp/test', async (req, res) => {
  const { phone } = parseBody(z.object({ phone: z.string() }), req.body);
  const r = await sendPlatformMessage({ phone: normalizePhone(phone), text: 'Teste do WhatsApp da plataforma: se você recebeu, os avisos aos donos estão funcionando. ✅', kind: 'teste' });
  if (r.status === 'failed') throw new HttpError(502, `O WhatsApp recusou: ${r.error}`);
  res.json(r);
});

// ---------- saúde do sistema

const startedAt = new Date().toISOString();
const appVersion = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version?: string }).version ?? '—';
  } catch {
    return '—';
  }
})();

// ---------- cópias de segurança

masterRouter.get('/backups', (_req, res) => {
  const remote = remoteConfig();
  res.json({
    status: backupStatus(),
    files: listBackups(),
    remote: remote ? { bucket: remote.bucket, endpoint: remote.endpoint || 'AWS S3', encrypted: Boolean(process.env.BACKUP_PASSWORD) } : null,
    // Baixar só criptografada (a cópia tem os dados de dentro das barbearias).
    canDownload: Boolean(process.env.BACKUP_PASSWORD),
  });
});

masterRouter.post('/backups', async (_req, res) => {
  res.status(201).json(await createBackup());
});

/**
 * Baixar uma cópia para guardar fora do servidor. Ela tem os dados de dentro das barbearias (clientes,
 * agenda, conversas), que o master não vê: por isso sai só criptografada, e abre apenas com a senha
 * no restaurador (npm run restore).
 */
masterRouter.get('/backups/:name', (req, res) => {
  const name = String(req.params.name);
  const file = backupPath(name);
  if (!file) throw new HttpError(404, 'Cópia não encontrada.');
  const password = process.env.BACKUP_PASSWORD;
  if (!password) throw new HttpError(409, 'Para baixar, defina a senha das cópias (BACKUP_PASSWORD) no servidor: a cópia sai criptografada.');
  res.attachment(`${name}.enc`);
  res.type('application/octet-stream');
  res.send(encrypt(fs.readFileSync(file), password));
});

/**
 * Pronto para o piloto? O que precisa estar certo antes da primeira barbearia de verdade.
 * Os opcionais (recomendados) não travam o "tudo pronto".
 */
masterRouter.get('/readiness', (req, res) => {
  const backup = backupStatus();
  const legal = legalInfo();
  const settings = platformSettings();
  const lastBackupHours = backup.at ? (Date.now() - new Date(backup.at).getTime()) / 3600000 : null;
  const me = get<{ phone: string | null }>('SELECT phone FROM users WHERE id = ?', [req.user!.id]);
  res.json([
    {
      id: 'https',
      label: 'Endereço público com HTTPS (PUBLIC_URL)',
      done: /^https:\/\//.test(config.publicUrl) && !/localhost|127\.0\.0\.1/.test(config.publicUrl),
      hint: 'Os links da área do cliente, os webhooks e o login seguro dependem dele.',
    },
    {
      id: 'demo',
      label: 'Código de acesso na tela desligado (DEMO_LOGIN_CODES=0)',
      done: !config.demoLoginCodes,
      hint: 'Ligado, qualquer pessoa entra na área de um cliente sabendo o celular dele.',
    },
    {
      id: 'backup',
      label: 'Cópia de segurança fora do servidor (BACKUP_S3_...) funcionando',
      done: Boolean(remoteConfig()) && backup.remote === 'ok' && lastBackupHours != null && lastBackupHours < 30,
      hint: 'Sem ela, se o servidor quebrar, os dados das barbearias se perdem.',
    },
    { id: 'backup_password', label: 'Cópia criptografada (BACKUP_PASSWORD)', done: Boolean(process.env.BACKUP_PASSWORD), hint: 'Guarde a senha fora do servidor.', optional: true },
    {
      id: 'whatsapp',
      label: 'WhatsApp da plataforma conectado (aba Sistema)',
      done: platformChannel().provider !== 'simulador',
      hint: 'É por ele que saem o "esqueci minha senha", os lembretes da mensalidade e o aviso de WhatsApp desconectado.',
    },
    { id: 'phone', label: 'Seu celular cadastrado em Minha conta', done: Boolean(me?.phone), hint: 'Para receber os alertas da plataforma.' },
    {
      id: 'legal',
      label: 'Dados da empresa nos termos e na política de privacidade',
      done: Boolean(legal.company && legal.document && legal.email),
      hint: 'Nome, CNPJ e e-mail de contato (aba Sistema).',
    },
    {
      id: 'billing',
      label: 'Recebimento das mensalidades (chave PIX ou Asaas)',
      done: Boolean(settings.pix_key) || Boolean(asaasSettings().apiKey),
      hint: 'Aba Financeiro.',
    },
    {
      id: 'online',
      label: 'Mensalidade no cartão automático (Cielo configurada e recebendo os avisos)',
      done: platformCardReady() && Boolean(platformCielo().webhookAt),
      hint: 'Aba Financeiro → Cartão (Cielo). Teste antes com o modo de teste da loja na Cielo.',
      optional: true,
    },
    { id: 'ai', label: 'Inteligência artificial do robô (ANTHROPIC_API_KEY)', done: llmEnabled(), hint: 'Sem ela, o robô responde por menu.', optional: true },
  ]);
});

masterRouter.get('/system', (_req, res) => {
  const fileSize = (file: string) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  const since = new Date(Date.now() - 86400000).toISOString();
  res.json({
    version: appVersion,
    node: process.version,
    startedAt,
    database: { file: config.dbFile, bytes: fileSize(config.dbFile) + fileSize(`${config.dbFile}-wal`) },
    automations: { enabled: config.automations, ...automationStatus },
    llm: { enabled: llmEnabled(), model: llmEnabled() ? config.botModel : null, effort: config.botEffort },
    publicUrl: config.publicUrl || null,
    // Falhas de envio por barbearia: só a contagem e o motivo (números de celular mascarados).
    failures24h: all<{ shop: string; failed: number; last_error: string | null }>(
      `SELECT b.name AS shop, COUNT(*) AS failed, MAX(m.error) AS last_error FROM messages m JOIN barbershops b ON b.id = m.barbershop_id
        WHERE m.status = 'failed' AND m.created_at >= ? GROUP BY b.id ORDER BY failed DESC`,
      [since],
    ).map((f) => ({ ...f, last_error: f.last_error?.replace(/\d{8,}/g, '•••') ?? null })),
    counts: get('SELECT (SELECT COUNT(*) FROM barbershops) AS shops'),
  });
});
