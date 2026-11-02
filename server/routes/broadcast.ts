import type { Router } from 'express';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { createBroadcast, listBroadcasts, previewBroadcast, broadcastUsage, runBroadcast, type Segment } from '../broadcast.js';
import { all } from '../db.js';
import { parseBody } from '../http.js';

const zSegment: z.ZodType<Segment> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('todos') }),
  z.object({ type: z.literal('barbeiro'), barberId: z.number().int().positive() }),
  z.object({ type: z.literal('sumidos'), days: z.number().int().min(15).max(365) }),
  z.object({ type: z.literal('aniversariantes') }),
  z.object({ type: z.literal('clube') }),
]);

/** Promoções no WhatsApp para um grupo de clientes (só o dono: a recepção não tem acesso). */
export function registerBroadcastRoutes(router: Router): void {
  router.get('/broadcasts', (req, res) => {
    const shop = shopId(req);
    res.json({
      usage: broadcastUsage(shop),
      barbers: all('SELECT id, name FROM barbers WHERE barbershop_id = ? AND active = 1 ORDER BY name COLLATE NOCASE', [shop]),
      history: listBroadcasts(shop),
    });
  });

  router.post('/broadcasts/preview', (req, res) => {
    const body = parseBody(z.object({ segment: zSegment }), req.body);
    res.json(previewBroadcast(shopId(req), body.segment));
  });

  router.post('/broadcasts', (req, res) => {
    const body = parseBody(z.object({ segment: zSegment, text: z.string().max(700) }), req.body);
    const id = createBroadcast({ shopId: shopId(req), userId: req.user!.id, segment: body.segment, text: body.text });
    // Envia em segundo plano: a tela acompanha pelo histórico.
    void runBroadcast(id).catch((e) => console.error('[promoção]', e));
    res.status(202).json({ id });
  });
}
