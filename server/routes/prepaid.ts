import type { Router } from 'express';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { get } from '../db.js';
import { METHODS } from '../finance.js';
import { HttpError, idParam, parseBody, zBool, zCents, zId, zText } from '../http.js';
import { customerPackages, giftCardByCode, sellGiftCard, sellPackage, shopGiftCards, shopPackages } from '../prepaid.js';
import { crudRoutes } from './crud.js';

/** Pacotes pré-pagos e vale-presente (painel do dono). */
export function registerPrepaidRoutes(router: Router): void {
  crudRoutes(router, {
    path: '/packages',
    table: 'packages',
    label: 'Pacote',
    order: 'active DESC, name COLLATE NOCASE',
    refs: { service_id: 'catalog_items' },
    schema: z.object({
      name: z.string().trim().min(2, 'Dê um nome ao pacote.').max(60),
      service_id: zId,
      uses: z.number().int().min(2, 'Pacote de 2 a 50 usos.').max(50, 'Pacote de 2 a 50 usos.'),
      price_cents: zCents.refine((v) => v > 0, 'Informe o preço do pacote.'),
      valid_days: z.number().int().min(7).max(730),
      description: zText(300),
      active: zBool,
    }),
  });

  /** O que foi vendido: pacotes dos clientes e vales-presente. */
  router.get('/prepaid', (req, res) => {
    const shop = shopId(req);
    res.json({ packages: shopPackages(shop), giftCards: shopGiftCards(shop) });
  });

  router.post('/packages/sell', (req, res) => {
    const body = parseBody(z.object({ package_id: zId, customer_id: zId, method: z.enum(METHODS) }), req.body);
    res.status(201).json(sellPackage({ shopId: shopId(req), customerId: body.customer_id, packageId: body.package_id, method: body.method, userId: req.user!.id }));
  });

  /** Pacotes valendo do cliente (comanda). */
  router.get('/customers/:id/packages', (req, res) => {
    const shop = shopId(req);
    if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ?', [idParam(req), shop])) throw new HttpError(404, 'Cliente não encontrado.');
    res.json(customerPackages(shop, idParam(req), { activeOnly: true }));
  });

  router.post('/gift-cards', (req, res) => {
    const body = parseBody(
      z.object({
        amount_cents: z.number().int().min(1000, 'Vale-presente de R$ 10 a R$ 5.000.').max(500000, 'Vale-presente de R$ 10 a R$ 5.000.'),
        valid_days: z.number().int().min(30).max(730).default(180),
        buyer_name: zText(80),
        recipient_name: zText(80),
        message: zText(200),
        method: z.enum(METHODS),
      }),
      req.body,
    );
    res.status(201).json(
      sellGiftCard({
        shopId: shopId(req),
        amountCents: body.amount_cents,
        validDays: body.valid_days,
        buyerName: body.buyer_name,
        recipientName: body.recipient_name,
        message: body.message,
        method: body.method,
        userId: req.user!.id,
      }),
    );
  });

  /** Confere o saldo pelo código (balcão). */
  router.get('/gift-cards/:code', (req, res) => {
    res.json(giftCardByCode(shopId(req), String(req.params.code)));
  });
}
