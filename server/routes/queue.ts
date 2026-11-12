import type { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { isReception, shopId } from '../auth.js';
import { get } from '../db.js';
import { HttpError, idParam, normalizePhone, parseBody, zId } from '../http.js';
import { backToQueue, callNext, joinQueue, leaveQueue, queueEnabled, queueLink, queueView, setQueueEnabled, startEntry } from '../queue.js';

const zJoin = z.object({
  name: z.string().trim().min(2, 'Informe o nome.').max(80),
  phone: z.string().trim().max(30).nullish(),
  barber_id: zId.nullish(),
  service_id: zId.nullish(),
});

/** Fila de chegada no painel (dono e recepção): quem está esperando, chamar o próximo e o QR do balcão. */
export function registerQueueRoutes(router: Router): void {
  router.get('/queue', (req, res) => {
    const shop = shopId(req);
    const slug = get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [shop])!.slug;
    res.json({ enabled: queueEnabled(shop), link: queueLink(slug), ...queueView(shop) });
  });

  router.put('/queue/settings', (req, res) => {
    if (isReception(req)) throw new HttpError(403, 'Só o dono liga ou desliga a fila.');
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body);
    setQueueEnabled(shopId(req), body.enabled);
    res.json({ enabled: body.enabled });
  });

  /** QR Code para o cartaz do balcão (SVG). */
  router.get('/queue/qr', async (req, res) => {
    const slug = get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [shopId(req)])!.slug;
    res.type('image/svg+xml').send(await QRCode.toString(queueLink(slug), { type: 'svg', margin: 1 }));
  });

  /** Quem chegou no balcão (a recepção põe na fila). */
  router.post('/queue', async (req, res) => {
    const body = parseBody(zJoin, req.body);
    const entry = await joinQueue({
      shopId: shopId(req),
      name: body.name,
      phone: body.phone ? normalizePhone(body.phone) : null,
      barberId: body.barber_id,
      serviceId: body.service_id,
      source: 'balcao',
    });
    res.status(201).json(entry);
  });

  router.post('/queue/call', async (req, res) => {
    const body = parseBody(z.object({ barber_id: zId }), req.body);
    res.json({ called: await callNext(shopId(req), body.barber_id) });
  });

  router.post('/queue/:id/start', (req, res) => {
    const body = parseBody(z.object({ barber_id: zId.nullish() }), req.body ?? {});
    res.json(startEntry(shopId(req), idParam(req), body.barber_id ?? undefined));
  });

  router.post('/queue/:id/back', (req, res) => {
    backToQueue(shopId(req), idParam(req));
    res.json({ ok: true });
  });

  router.post('/queue/:id/left', (req, res) => {
    leaveQueue(shopId(req), idParam(req));
    res.json({ ok: true });
  });
}
