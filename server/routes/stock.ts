import type { Router } from 'express';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { METHODS } from '../finance.js';
import { idParam, parseBody, zId, zText } from '../http.js';
import { adjustStock, stockEntry, stockList, stockMoves } from '../stock.js';
import { isDate } from '../time.js';

/** Estoque dos produtos (painel do dono). */
export function registerStockRoutes(router: Router): void {
  router.get('/stock', (req, res) => {
    res.json({ items: stockList(shopId(req)), moves: stockMoves(shopId(req)) });
  });

  router.get('/stock/:id/moves', (req, res) => {
    res.json(stockMoves(shopId(req), idParam(req)));
  });

  /** Entrada de mercadoria (compra), com lançamento opcional no caixa. */
  router.post('/stock/entries', (req, res) => {
    const body = parseBody(
      z.object({
        items: z
          .array(z.object({ catalog_item_id: zId, qty: z.number().int().min(1).max(100000), unit_cost_cents: z.number().int().min(0).max(10_000_000).nullish() }))
          .min(1, 'Inclua pelo menos um produto.')
          .max(50),
        supplier: zText(80),
        cash: z
          .object({
            status: z.enum(['paid', 'pending']),
            date: z.string().refine(isDate, 'Data inválida.'),
            method: z.enum(METHODS).nullish().transform((v) => v ?? null),
          })
          .nullish(),
      }),
      req.body,
    );
    res.status(201).json(stockEntry(shopId(req), body.items, { supplier: body.supplier, cash: body.cash ?? null, userId: req.user!.id }));
  });

  /** Contagem (nova quantidade) ou saída por perda / uso interno. */
  router.post('/stock/:id/adjust', (req, res) => {
    const body = parseBody(z.object({ kind: z.enum(['ajuste', 'perda', 'uso']), qty: z.number().int().min(0).max(100000), notes: zText(200) }), req.body);
    res.json(adjustStock(shopId(req), idParam(req), { ...body, userId: req.user!.id }));
  });
}
