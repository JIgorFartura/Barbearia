import { Router } from 'express';
import { z } from 'zod';
import { requireRole, shopId } from '../auth.js';
import { shopNow, shopTz } from '../clock.js';
import { all, get, nowIso, run } from '../db.js';
import { HttpError, idParam, normalizePhone, parseBody, zBool, zCents, zColor, zDate, zId, zText, zUrl } from '../http.js';
import { addStamps, customerCard, isRunning, redeemReward, type Campaign } from '../loyalty.js';
import { issueAccessLink } from '../customerAuth.js';
import { anonymizeCustomer, exportCustomerData } from '../privacy.js';
import { customerByPhone } from '../messaging.js';
import { findVoucher, redeemVoucher, shopVouchers } from '../offers.js';
import { dayAgenda } from '../scheduling.js';
import { TIMEZONES, addDays, localNow } from '../time.js';
import { accessStatus } from '../billing.js';
import { registerAgendaRoutes } from './agenda.js';
import { registerBotRoutes } from './bot.js';
import { crudRoutes } from './crud.js';
import { registerFinanceRoutes } from './finance.js';
import { registerStockRoutes } from './stock.js';
import { registerClubRoutes } from './club.js';
import { lowStock } from '../stock.js';
import { reviewsOverview, shopRating } from '../reviews.js';
import { shopCardStatus } from '../cardSettings.js';

/** Painel do dono da barbearia. Tudo aqui é filtrado pela barbearia do usuário logado. */
export const shopRouter = Router();
shopRouter.use(requireRole('owner'));
// Barbearia suspensa ou com mensalidade em atraso: só a situação e a mensalidade.
shopRouter.use((req, _res, next) => {
  if (req.path === '/status' || req.path.startsWith('/subscription')) return next();
  const shop = get<{ active: number }>('SELECT active FROM barbershops WHERE id = ?', [shopId(req)]);
  if (!shop?.active) throw new HttpError(403, 'Barbearia suspensa pelo administrador da plataforma.');
  if (accessStatus(shopId(req)).blocked) throw new HttpError(402, 'Acesso suspenso: há mensalidade em atraso. Regularize na tela Mensalidade.');
  next();
});
registerAgendaRoutes(shopRouter);
registerBotRoutes(shopRouter);
registerFinanceRoutes(shopRouter);
registerStockRoutes(shopRouter);
registerClubRoutes(shopRouter);

// ---------- marca (o que aparece na landing page)

const zProfile = z.object({
  name: z.string().trim().min(2).max(80),
  tagline: zText(120),
  about: zText(1500),
  primary_color: zColor,
  accent_color: zColor,
  logo_url: zUrl,
  cover_url: zUrl,
  whatsapp: zText(20),
  instagram: zText(60),
  address: zText(200),
  hours: zText(300),
  /** Fuso da barbearia (vazio = horário de Brasília). */
  timezone: z
    .enum(TIMEZONES)
    .nullish()
    .transform((v) => v ?? null),
});

shopRouter.get('/profile', (req, res) => {
  res.json(get(`SELECT slug, ${Object.keys(zProfile.shape).join(', ')} FROM barbershops WHERE id = ?`, [shopId(req)]));
});

shopRouter.put('/profile', (req, res) => {
  const data = parseBody(zProfile, req.body);
  const cols = Object.keys(zProfile.shape);
  run(`UPDATE barbershops SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`, { ...data, id: shopId(req) });
  res.json(get(`SELECT slug, ${Object.keys(zProfile.shape).join(', ')} FROM barbershops WHERE id = ?`, [shopId(req)]));
});

// ---------- cadastros

crudRoutes(shopRouter, {
  path: '/catalog',
  table: 'catalog_items',
  label: 'Item',
  order: "kind DESC, name COLLATE NOCASE",
  schema: z.object({
    kind: z.enum(['service', 'product']),
    name: z.string().trim().min(2).max(80),
    description: zText(500),
    price_cents: zCents,
    duration_min: z.number().int().min(5).max(600).nullish().transform((v) => v ?? null),
    image_url: zUrl,
    active: zBool,
    // Estoque (produtos): a quantidade muda pelas vendas, entradas e ajustes, não por aqui.
    track_stock: zBool.optional().default(false),
    stock_min: z.number().int().min(0).max(100000).nullish().transform((v) => v ?? null),
    cost_cents: zCents.nullish().transform((v) => v ?? null),
  }),
});

crudRoutes(shopRouter, {
  path: '/partners',
  table: 'partners',
  label: 'Parceiro',
  order: 'name COLLATE NOCASE',
  schema: z.object({
    name: z.string().trim().min(2).max(80),
    category: zText(60),
    description: zText(500),
    benefit: zText(200),
    phone: zText(20),
    instagram: zText(60),
    website: zUrl,
    logo_url: zUrl,
    active: zBool,
  }),
});

crudRoutes(shopRouter, {
  path: '/ads',
  table: 'ads',
  label: 'Anúncio',
  order: "active DESC, COALESCE(ends_on, '9999') DESC",
  refs: { partner_id: 'partners' },
  schema: z.object({
    partner_id: zId.nullish().transform((v) => v ?? null),
    title: z.string().trim().min(2).max(80),
    body: zText(300),
    image_url: zUrl,
    link_url: zUrl,
    placement: z.enum(['destaque', 'mural']),
    price_cents: zCents,
    starts_on: zDate,
    ends_on: zDate,
    active: zBool,
  }),
});

crudRoutes(shopRouter, {
  path: '/campaigns',
  table: 'campaigns',
  label: 'Campanha',
  order: 'active DESC, created_at DESC',
  refs: { partner_id: 'partners', catalog_item_id: 'catalog_items' },
  schema: z.object({
    name: z.string().trim().min(2).max(80),
    description: zText(500),
    unit_label: z.string().trim().min(1, 'O que o cliente junta? Ex.: cerveja, corte.').max(40),
    goal: z.number().int().min(1).max(100),
    reward: z.string().trim().min(2, 'Qual é o prêmio? Ex.: um copo personalizado.').max(120),
    catalog_item_id: zId.nullish().transform((v) => v ?? null),
    partner_id: zId.nullish().transform((v) => v ?? null),
    image_url: zUrl,
    starts_on: zDate,
    ends_on: zDate,
    active: zBool,
  }),
});

crudRoutes(shopRouter, {
  path: '/offers',
  table: 'offers',
  label: 'Benefício',
  // Os prêmios de indicação e aniversário são configurados na tela deles.
  scope: 'reward_only = 0',
  order: 'active DESC, created_at DESC',
  refs: { partner_id: 'partners' },
  schema: z.object({
    title: z.string().trim().min(2, 'Dê um título ao benefício.').max(80),
    description: zText(400),
    partner_id: zId.nullish().transform((v) => v ?? null),
    image_url: zUrl,
    valid_days: z.number().int().min(1).max(365),
    max_total: z.number().int().min(1).max(100000).nullish().transform((v) => v ?? null),
    per_customer: z.number().int().min(1).max(50),
    starts_on: zDate,
    ends_on: zDate,
    active: zBool,
  }),
});

// ---------- vouchers (validação no balcão)

shopRouter.get('/vouchers', (req, res) => {
  res.json(shopVouchers(shopId(req)));
});

shopRouter.get('/vouchers/:code', (req, res) => {
  res.json(findVoucher(shopId(req), String(req.params.code)));
});

shopRouter.post('/vouchers/redeem', (req, res) => {
  const { code } = parseBody(z.object({ code: z.string().trim().min(3).max(20) }), req.body);
  res.json(redeemVoucher(shopId(req), code, req.user!.id));
});

// ---------- clientes (comunidade) e balcão

shopRouter.get('/customers', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const digits = q.replace(/\D/g, '');
  res.json(
    all(
      `SELECT c.*,
              (SELECT COALESCE(SUM(qty), 0) FROM loyalty_events e WHERE e.customer_id = c.id AND e.kind = 'earn') AS stamps_total,
              (SELECT MAX(created_at) FROM loyalty_events e WHERE e.customer_id = c.id) AS last_visit
         FROM customers c
        WHERE c.barbershop_id = :shop AND c.anonymized_at IS NULL
          AND (:q = '' OR c.name LIKE '%' || :q || '%' OR (:digits <> '' AND c.phone LIKE '%' || :digits || '%'))
        ORDER BY COALESCE(last_visit, c.created_at) DESC
        LIMIT 100`,
      { shop: shopId(req), q, digits },
    ),
  );
});

shopRouter.post('/customers', (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(2, 'Informe o nome do cliente.').max(80), phone: z.string() }), req.body);
  const phone = normalizePhone(body.phone);
  const shop = shopId(req);
  if (customerByPhone(shop, phone)) throw new HttpError(409, 'Esse celular já está cadastrado.');
  const { lastInsertRowid } = run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [
    shop,
    body.name,
    phone,
    nowIso(),
  ]);
  res.status(201).json(get('SELECT * FROM customers WHERE id = ?', [lastInsertRowid]));
});

shopRouter.get('/customers/:id', (req, res) => {
  const shop = shopId(req);
  const id = idParam(req);
  const customer = get('SELECT * FROM customers WHERE id = ? AND barbershop_id = ?', [id, shop]);
  if (!customer) throw new HttpError(404, 'Cliente não encontrado.');
  const history = all(
    `SELECT e.id, e.kind, e.qty, e.created_at, c.name AS campaign, c.unit_label, c.reward
       FROM loyalty_events e JOIN campaigns c ON c.id = e.campaign_id
      WHERE e.customer_id = ? ORDER BY e.created_at DESC LIMIT 50`,
    [id],
  );
  res.json({ customer, card: customerCard(shop, id), history });
});

/** Link de acesso à área do cliente, para o dono mandar pelo próprio WhatsApp. */
shopRouter.post('/customers/:id/access-link', (req, res) => {
  const shop = shopId(req);
  const id = idParam(req);
  if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ?', [id, shop])) throw new HttpError(404, 'Cliente não encontrado.');
  const slug = get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [shop])!.slug;
  res.json({ url: issueAccessLink(id, slug) });
});

/** LGPD: cópia dos dados do cliente (pedido no balcão). */
shopRouter.get('/customers/:id/export', (req, res) => {
  res.setHeader('content-disposition', `attachment; filename="dados-cliente-${idParam(req)}.json"`);
  res.json(exportCustomerData(shopId(req), idParam(req)));
});

/** LGPD: exclui os dados pessoais a pedido do cliente. */
shopRouter.post('/customers/:id/anonymize', (req, res) => {
  parseBody(z.object({ confirm: z.literal('EXCLUIR', 'Digite EXCLUIR para confirmar.') }), req.body);
  anonymizeCustomer(shopId(req), idParam(req));
  res.json({ ok: true });
});

const zLoyalty = z.object({ campaignId: zId, customerId: zId });

shopRouter.post('/loyalty/earn', (req, res) => {
  const body = parseBody(zLoyalty.extend({ qty: z.number().int().min(1).max(50) }), req.body);
  res.json(addStamps(shopId(req), body.campaignId, body.customerId, body.qty, req.user!.id));
});

shopRouter.post('/loyalty/redeem', (req, res) => {
  const body = parseBody(zLoyalty, req.body);
  res.json(redeemReward(shopId(req), body.campaignId, body.customerId, req.user!.id));
});

/** Desfaz um lançamento feito por engano (ex.: carimbo a mais). */
shopRouter.delete('/loyalty/events/:id', (req, res) => {
  const { changes } = run(
    `DELETE FROM loyalty_events WHERE id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE barbershop_id = ?)`,
    [idParam(req), shopId(req)],
  );
  if (!changes) throw new HttpError(404, 'Lançamento não encontrado.');
  res.json({ ok: true });
});

// ---------- avaliações depois do corte

shopRouter.get('/reviews', (req, res) => {
  res.json(reviewsOverview(shopId(req)));
});

shopRouter.put('/reviews/settings', (req, res) => {
  const body = parseBody(
    z.object({ review_enabled: zBool, review_delay_min: z.number().int().min(30).max(24 * 60), review_link: zUrl }),
    req.body,
  );
  run('UPDATE barbershops SET review_enabled = ?, review_delay_min = ?, review_link = ? WHERE id = ?', [body.review_enabled, body.review_delay_min, body.review_link, shopId(req)]);
  res.json(reviewsOverview(shopId(req)));
});

// ---------- resumo do painel

/**
 * Primeiros passos para a barbearia começar a usar de verdade (piloto). Os opcionais não contam
 * no "tudo pronto", mas aparecem como sugestão.
 */
function setupChecklist(shop: number, userId: number) {
  const b = get<{ slug: string; logo_url: string | null; whatsapp: string | null; address: string | null; wa_provider: string; wa_status: string | null; pix_key: string | null; review_link: string | null }>(
    'SELECT slug, logo_url, whatsapp, address, wa_provider, wa_status, pix_key, review_link FROM barbershops WHERE id = ?',
    [shop],
  )!;
  const has = (sql: string) => Boolean(get(sql, [shop]));
  const card = shopCardStatus(shop);
  return [
    { id: 'marca', label: 'Coloque logo, WhatsApp e endereço em Minha marca', done: Boolean(b.logo_url && b.whatsapp && b.address), link: '/painel/marca' },
    {
      id: 'barbeiros',
      label: 'Cadastre os barbeiros com o expediente',
      done: has('SELECT 1 AS ok FROM barbers br JOIN barber_hours h ON h.barber_id = br.id WHERE br.barbershop_id = ? AND br.active = 1 LIMIT 1'),
      link: '/painel/barbeiros',
    },
    { id: 'servicos', label: 'Cadastre os serviços com preço e duração', done: has("SELECT 1 AS ok FROM catalog_items WHERE barbershop_id = ? AND kind = 'service' AND active = 1 LIMIT 1"), link: '/painel/servicos' },
    { id: 'whatsapp', label: 'Conecte o WhatsApp da barbearia ao robô', done: b.wa_provider !== 'simulador' && b.wa_status !== 'down', link: '/painel/robo' },
    {
      id: 'celular',
      label: 'Cadastre seu celular em Minha conta (avisos e "esqueci minha senha")',
      done: Boolean(get<{ phone: string | null }>('SELECT phone FROM users WHERE id = ?', [userId])?.phone),
      link: 'conta',
    },
    { id: 'cliente', label: 'Divulgue o site: os clientes entram e agendam pelo celular', done: has('SELECT 1 AS ok FROM customers WHERE barbershop_id = ? LIMIT 1'), link: `/b/${b.slug}` },
    { id: 'venda', label: 'Feche o primeiro atendimento pela Agenda', done: has("SELECT 1 AS ok FROM sales WHERE barbershop_id = ? AND status = 'closed' LIMIT 1"), link: '/painel/agenda' },
    { id: 'pix', label: 'Cadastre a chave PIX (clube de assinatura)', done: Boolean(b.pix_key), link: '/painel/clube', optional: true },
    { id: 'google', label: 'Coloque o link de avaliação do Google', done: Boolean(b.review_link), link: '/painel/avaliacoes', optional: true },
    { id: 'cartao', label: 'Receba o clube no cartão pela Cielo (cobrança automática todo mês)', done: card.available, link: '/painel/clube', optional: true },
  ];
}

shopRouter.get('/summary', (req, res) => {
  const shop = shopId(req);
  const day = shopNow(shop).date;
  const tz = shopTz(shop);
  const month = day.slice(0, 7);
  const count = (sql: string) => get<{ n: number }>(sql, [shop])?.n ?? 0;

  const campaigns = all<Campaign>('SELECT * FROM campaigns WHERE barbershop_id = ?', [shop]);
  const ads = all<{ active: number; starts_on: string | null; ends_on: string | null; price_cents: number; views: number; clicks: number }>(
    'SELECT active, starts_on, ends_on, price_cents, views, clicks FROM ads WHERE barbershop_id = ?',
    [shop],
  );
  const runningAds = ads.filter((a) => isRunning(a, day));

  // Lançamentos dos últimos ~32 dias, filtrados pelo mês no fuso da barbearia.
  const since = new Date(Date.now() - 32 * 86400000).toISOString();
  const events = all<{ kind: string; qty: number; created_at: string }>(
    `SELECT e.kind, e.qty, e.created_at FROM loyalty_events e JOIN campaigns c ON c.id = e.campaign_id
      WHERE c.barbershop_id = ? AND e.created_at >= ?`,
    [shop, since],
  ).filter((e) => localNow(new Date(e.created_at), tz).date.startsWith(month));

  res.json({
    customers: count('SELECT COUNT(*) AS n FROM customers WHERE barbershop_id = ?'),
    partners: count('SELECT COUNT(*) AS n FROM partners WHERE barbershop_id = ? AND active = 1'),
    runningCampaigns: campaigns.filter((c) => isRunning(c, day)).length,
    runningAds: runningAds.length,
    adRevenueCents: runningAds.reduce((s, a) => s + a.price_cents, 0),
    adViews: ads.reduce((s, a) => s + a.views, 0),
    adClicks: ads.reduce((s, a) => s + a.clicks, 0),
    stampsThisMonth: events.filter((e) => e.kind === 'earn').reduce((s, e) => s + e.qty, 0),
    rewardsThisMonth: events.filter((e) => e.kind === 'redeem').length,
    topCustomers: all(
      `SELECT cu.id, cu.name, SUM(e.qty) AS stamps
         FROM loyalty_events e JOIN customers cu ON cu.id = e.customer_id
        WHERE cu.barbershop_id = ? AND e.kind = 'earn' AND e.created_at >= ?
        GROUP BY cu.id ORDER BY stamps DESC LIMIT 5`,
      [shop, since],
    ),
    lowStock: lowStock(shop),
    rating: shopRating(shop),
    setup: setupChecklist(shop, req.user!.id),
    // Agenda e robô
    today: dayAgenda(shop, day)
      .filter((a) => a.status === 'scheduled')
      .map((a) => ({ id: a.id, time: a.starts_at.slice(11), customer: a.customer_name, barber: a.barber_name, service: a.service_name })),
    upcomingWeek: get<{ n: number }>("SELECT COUNT(*) AS n FROM appointments WHERE barbershop_id = ? AND status = 'scheduled' AND starts_at >= ? AND starts_at < ?", [
      shop,
      `${day} 00:00`,
      `${addDays(day, 7)} 00:00`,
    ])!.n,
    botMessagesWeek: get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE barbershop_id = ? AND direction = 'out' AND created_at >= ?", [
      shop,
      new Date(Date.now() - 7 * 86400000).toISOString(),
    ])!.n,
    bookedByBotWeek: get<{ n: number }>("SELECT COUNT(*) AS n FROM appointments WHERE barbershop_id = ? AND source = 'whatsapp' AND created_at >= ?", [
      shop,
      new Date(Date.now() - 7 * 86400000).toISOString(),
    ])!.n,
  });
});
