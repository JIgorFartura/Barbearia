import { Router, type Request } from 'express';
import { z } from 'zod';
import { shopToday } from '../clock.js';
import { config } from '../config.js';
import { checkLoginCode, consumeAccessLink, createCustomerSession, issueLoginCode, sessionCustomer } from '../customerAuth.js';
import { all, get, nowIso, run } from '../db.js';
import { HttpError, idParam, normalizePhone, parseBody, rateLimit } from '../http.js';
import { isRunning, type Campaign } from '../loyalty.js';
import { customerByPhone, sendMessage, shopBot } from '../messaging.js';

/** Dados da landing page de cada barbearia (/b/:slug) e login da área do cliente — sem login. */
export const publicRouter = Router();

/** Só o que pode aparecer no site (nunca credenciais do WhatsApp nem configurações internas). */
const PUBLIC_FIELDS = 'id, slug, name, tagline, about, primary_color, accent_color, logo_url, cover_url, whatsapp, instagram, address, hours, bot_name';

interface Shop {
  id: number;
  slug: string;
  name: string;
}

function shopBySlug(slug: string): Shop & Record<string, unknown> {
  const shop = get<Shop & Record<string, unknown>>(`SELECT ${PUBLIC_FIELDS} FROM barbershops WHERE slug = ? AND active = 1`, [slug.toLowerCase()]);
  if (!shop) throw new HttpError(404, 'Barbearia não encontrada.');
  return shop;
}

publicRouter.get('/shops/:slug', (req, res) => {
  const { id, ...profile } = shopBySlug(String(req.params.slug));
  const day = shopToday(id);

  const ads = all<{ id: number; active: number; starts_on: string | null; ends_on: string | null } & Record<string, unknown>>(
    `SELECT a.id, a.title, a.body, a.image_url, a.link_url, a.placement, a.active, a.starts_on, a.ends_on, p.name AS partner
       FROM ads a LEFT JOIN partners p ON p.id = a.partner_id
      WHERE a.barbershop_id = ? AND a.active = 1`,
    [id],
  ).filter((a) => isRunning(a, day));
  if (ads.length) run(`UPDATE ads SET views = views + 1 WHERE id IN (${ads.map(() => '?').join(',')})`, ads.map((a) => a.id));

  const campaigns = all<Campaign & { partner: string | null }>(
    `SELECT c.*, p.name AS partner FROM campaigns c LEFT JOIN partners p ON p.id = c.partner_id
      WHERE c.barbershop_id = ? ORDER BY c.created_at DESC`,
    [id],
  ).filter((c) => isRunning(c, day));

  res.json({
    shop: profile,
    loggedIn: Boolean(sessionCustomer(req, id)),
    canBook: Boolean(get('SELECT 1 AS ok FROM barbers b JOIN barber_hours h ON h.barber_id = b.id WHERE b.barbershop_id = ? AND b.active = 1 LIMIT 1', [id])),
    services: all('SELECT id, name, description, price_cents, duration_min, image_url FROM catalog_items WHERE barbershop_id = ? AND kind = ? AND active = 1 ORDER BY name', [id, 'service']),
    products: all('SELECT id, name, description, price_cents, image_url FROM catalog_items WHERE barbershop_id = ? AND kind = ? AND active = 1 ORDER BY name', [id, 'product']),
    partners: all('SELECT id, name, category, description, benefit, instagram, website, logo_url FROM partners WHERE barbershop_id = ? AND active = 1 ORDER BY name', [id]),
    campaigns: campaigns.map(({ id: cid, name, description, unit_label, goal, reward, image_url, ends_on, partner }) => ({
      id: cid,
      name,
      description,
      unit_label,
      goal,
      reward,
      image_url,
      ends_on,
      partner,
    })),
    ads: ads.map(({ id: aid, title, body, image_url, link_url, placement, partner }) => ({ id: aid, title, body, image_url, hasLink: Boolean(link_url), placement, partner })),
  });
});

/** Só a marca (área do cliente): não conta visualização de anúncio. */
publicRouter.get('/shops/:slug/brand', (req, res) => {
  const { id, ...profile } = shopBySlug(String(req.params.slug));
  res.json({ ...profile, connected: shopBot(id).wa_provider !== 'simulador', loggedIn: Boolean(sessionCustomer(req, id)) });
});

/** Clique no anúncio: conta e redireciona para o link do anunciante (validado no cadastro). */
publicRouter.get('/ads/:id/click', (req, res) => {
  const ad = get<{ link_url: string | null }>('SELECT link_url FROM ads WHERE id = ? AND active = 1', [idParam(req)]);
  if (!ad?.link_url) throw new HttpError(404, 'Anúncio não encontrado.');
  run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', [idParam(req)]);
  res.redirect(302, ad.link_url);
});

// ---------- login da área do cliente

const ip = (req: Request) => req.ip ?? '';

/**
 * Passo 1: o cliente informa o celular (e o nome, se for novo). O robô manda o código no WhatsApp.
 * Sem WhatsApp conectado, só em modo demonstração o código aparece na tela.
 */
publicRouter.post('/shops/:slug/login/code', async (req, res) => {
  rateLimit(`code:${ip(req)}`, 10, 3600000, 'Muitos pedidos de código. Tente mais tarde.');
  const { id } = shopBySlug(String(req.params.slug));
  const body = parseBody(z.object({ phone: z.string().max(30), name: z.string().trim().max(80).optional() }), req.body);
  const phone = normalizePhone(body.phone);
  let customer = customerByPhone(id, phone);
  if (!customer) {
    if (!body.name || body.name.length < 2) {
      res.status(404).json({ error: 'Primeira vez por aqui? Informe seu nome para criar sua conta.', needsName: true });
      return;
    }
    run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [id, body.name, phone, nowIso()]);
    customer = customerByPhone(id, phone)!;
  }
  const shop = shopBot(id);
  const connected = shop.wa_provider !== 'simulador';
  if (!connected && !config.demoLoginCodes) {
    throw new HttpError(503, 'O WhatsApp da barbearia ainda não está conectado. Peça seu link de acesso no balcão.');
  }
  const code = issueLoginCode(customer.id);
  const sent = await sendMessage({
    shop,
    customerId: customer.id,
    phone: customer.phone,
    waId: customer.wa_id,
    text: `Seu código de acesso à área do cliente da ${shop.name}: *${code}*. Vale por 10 minutos. Não passe para ninguém.`,
    kind: 'codigo',
    template: { kind: 'codigo', params: [code] },
  });
  if (connected && sent.status === 'failed' && !config.demoLoginCodes) throw new HttpError(502, 'Não conseguimos enviar o código pelo WhatsApp. Tente de novo.');
  res.json({ sent: connected && sent.status === 'sent', demoCode: config.demoLoginCodes && (!connected || sent.status === 'failed') ? code : undefined });
});

/** Passo 2: confere o código e abre a sessão (180 dias). */
publicRouter.post('/shops/:slug/login/verify', (req, res) => {
  rateLimit(`verify:${ip(req)}`, 30, 3600000, 'Muitas tentativas. Tente mais tarde.');
  const { id } = shopBySlug(String(req.params.slug));
  const body = parseBody(z.object({ phone: z.string().max(30), code: z.string().max(10) }), req.body);
  const customer = customerByPhone(id, normalizePhone(body.phone));
  if (!customer) throw new HttpError(400, 'Código incorreto.');
  checkLoginCode(customer.id, body.code);
  createCustomerSession(res, id, customer.id);
  res.json({ ok: true });
});

/** Link de acesso enviado pelo robô (ou copiado pelo dono no painel). */
publicRouter.post('/shops/:slug/login/link', (req, res) => {
  rateLimit(`link:${ip(req)}`, 30, 3600000, 'Muitas tentativas. Tente mais tarde.');
  const { id } = shopBySlug(String(req.params.slug));
  const { token } = parseBody(z.object({ token: z.string().min(10).max(100) }), req.body);
  createCustomerSession(res, id, consumeAccessLink(id, token));
  res.json({ ok: true });
});
