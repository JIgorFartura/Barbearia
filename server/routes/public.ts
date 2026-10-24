import { Router } from 'express';
import { z } from 'zod';
import { today } from '../config.js';
import { all, get, run } from '../db.js';
import { HttpError, idParam, normalizePhone, parseBody } from '../http.js';
import { customerCard, isRunning, type Campaign } from '../loyalty.js';

/** Dados da landing page de cada barbearia (/b/:slug) — sem login. */
export const publicRouter = Router();

interface Shop {
  id: number;
  slug: string;
  name: string;
  active: number;
}

function shopBySlug(slug: string): Shop {
  const shop = get<Shop>('SELECT * FROM barbershops WHERE slug = ? AND active = 1', [slug.toLowerCase()]);
  if (!shop) throw new HttpError(404, 'Barbearia não encontrada.');
  return shop;
}

publicRouter.get('/shops/:slug', (req, res) => {
  const shop = shopBySlug(String(req.params.slug));
  const day = today();
  const { id, created_at: _created, active: _active, ...profile } = shop as Shop & Record<string, unknown>;

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

/** Clique no anúncio: conta e redireciona para o link do anunciante (validado no cadastro). */
publicRouter.get('/ads/:id/click', (req, res) => {
  const ad = get<{ link_url: string | null }>('SELECT link_url FROM ads WHERE id = ? AND active = 1', [idParam(req)]);
  if (!ad?.link_url) throw new HttpError(404, 'Anúncio não encontrado.');
  run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', [idParam(req)]);
  res.redirect(302, ad.link_url);
});

/** "Meu cartão": o cliente consulta os carimbos pelo celular. Mostra só o primeiro nome. */
publicRouter.post('/shops/:slug/card', (req, res) => {
  const shop = shopBySlug(String(req.params.slug));
  const body = parseBody(z.object({ phone: z.string().max(30) }), req.body);
  const customer = get<{ id: number; name: string }>('SELECT id, name FROM customers WHERE barbershop_id = ? AND phone = ?', [
    shop.id,
    normalizePhone(body.phone),
  ]);
  if (!customer) throw new HttpError(404, 'Ainda não encontramos esse celular. Peça seu cadastro no balcão!');
  res.json({
    firstName: customer.name.split(/\s+/)[0],
    card: customerCard(shop.id, customer.id).map(({ campaign, progress }) => ({
      id: campaign.id,
      name: campaign.name,
      unit_label: campaign.unit_label,
      reward: campaign.reward,
      progress,
    })),
  });
});
