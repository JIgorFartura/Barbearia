import type { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { config } from '../config.js';
import { get, run } from '../db.js';
import { HttpError, parseBody, zText } from '../http.js';
import { queueEnabled, queueLink } from '../queue.js';

const shopLink = (slug: string) => `${config.appUrl}/b/${slug}`;

/** Divulgar a barbearia: links, QR Code do site e o guia de barbearias. */
export function registerPromoteRoutes(router: Router): void {
  router.get('/promote', (req, res) => {
    const shop = shopId(req);
    const s = get<{ slug: string; guide_listed: number; city: string | null; district: string | null }>(
      'SELECT slug, guide_listed, city, district FROM barbershops WHERE id = ?',
      [shop],
    )!;
    res.json({
      site: shopLink(s.slug),
      area: `${shopLink(s.slug)}/conta`,
      queue: queueEnabled(shop) ? queueLink(s.slug) : null,
      guide: { listed: Boolean(s.guide_listed), city: s.city, district: s.district, url: `${config.appUrl}/barbearias` },
    });
  });

  /** QR Code do site (SVG), para cartaz, cartão de visita e espelho. */
  router.get('/promote/qr', async (req, res) => {
    const slug = get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [shopId(req)])!.slug;
    res.type('image/svg+xml').send(await QRCode.toString(shopLink(slug), { type: 'svg', margin: 1 }));
  });

  router.put('/promote/guide', (req, res) => {
    const body = parseBody(z.object({ listed: z.boolean(), city: zText(60), district: zText(60) }), req.body);
    if (body.listed && !body.city) throw new HttpError(400, 'Informe a cidade para aparecer no guia.');
    run('UPDATE barbershops SET guide_listed = ?, city = ?, district = ? WHERE id = ?', [body.listed ? 1 : 0, body.city, body.district, shopId(req)]);
    res.json({ ok: true });
  });
}
