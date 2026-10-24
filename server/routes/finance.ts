import type { Request, Router } from 'express';
import { depositState } from '../deposits.js';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { accessStatus, informPayment, invoice, invoicePix, listInvoices, shopBilling, monthlyPrice } from '../billing.js';
import { connectionInfo } from '../connection.js';
import { availableQty } from '../stock.js';
import { reservedItems, reserveItems, suggestionFor } from '../consumption.js';
import { all, get } from '../db.js';
import {
  METHODS,
  addEntry,
  barberStatement,
  cancelSale,
  commissionBalances,
  createPayout,
  createSale,
  deleteEntry,
  financeSummary,
  listEntries,
  listSales,
  payEntry,
  updateEntry,
} from '../finance.js';
import { HttpError, idParam, parseBody, zId, zText } from '../http.js';
import { shopNow } from '../clock.js';
import { addDays, isDate } from '../time.js';

const zDay = z.string().refine(isDate, 'Data no formato AAAA-MM-DD.');
const zMethod = z.enum(METHODS);

/** Período da consulta (?from=&to=); padrão: mês atual. */
function period(req: Request): { from: string; to: string } {
  const today = shopNow(shopId(req)).date;
  const from = typeof req.query.from === 'string' && isDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = typeof req.query.to === 'string' && isDate(req.query.to) ? req.query.to : today;
  if (to < from) throw new HttpError(400, 'Período inválido.');
  if (to > addDays(from, 400)) throw new HttpError(400, 'Período longo demais (máximo de um ano).');
  return { from, to };
}

const zEntry = z.object({
  type: z.enum(['in', 'out']),
  category: z.string().trim().min(2).max(60),
  description: zText(200),
  amount_cents: z.number().int().min(1).max(100_000_000),
  method: z.enum(METHODS).nullish().transform((v) => v ?? null),
  date: zDay,
  status: z.enum(['paid', 'pending']),
});

/** Financeiro da barbearia, mensalidade da plataforma e situação de acesso (painel do dono). */
export function registerFinanceRoutes(router: Router): void {
  // ---------- situação do acesso, avisos da plataforma e mensalidade

  router.get('/status', (req, res) => {
    const shop = shopId(req);
    const status = accessStatus(shop);
    res.json({
      active: Boolean(get<{ active: number }>('SELECT active FROM barbershops WHERE id = ?', [shop])?.active),
      blocked: status.blocked,
      blockOn: status.blockOn,
      openInvoices: status.open.length,
      overdue: status.open.some((i) => i.overdue),
      trialUntil: status.trialUntil,
      whatsapp: connectionInfo(shop),
      pixToConfirm: get<{ n: number }>("SELECT COUNT(*) AS n FROM charges WHERE barbershop_id = ? AND status = 'open' AND claimed_at IS NOT NULL", [shop])!.n,
      announcements: all("SELECT id, title, body, level, created_at FROM announcements WHERE active = 1 ORDER BY id DESC LIMIT 5"),
    });
  });

  router.get('/subscription', async (req, res) => {
    const shop = shopId(req);
    const s = shopBilling(shop);
    const status = accessStatus(shop);
    const invoices = listInvoices({ shopId: shop });
    const current = status.open[0] ?? null;
    res.json({
      plan: s.plan_name,
      price_cents: monthlyPrice(s),
      billing_day: s.billing_day,
      trial_until: s.trial_until,
      blocked: status.blocked,
      graceDays: status.graceDays,
      blockOn: status.blockOn,
      current: current ? { ...current, pix: await invoicePix(current) } : null,
      invoices,
    });
  });

  router.post('/subscription/:id/inform', (req, res) => {
    res.json(informPayment(shopId(req), idParam(req)));
  });

  router.get('/subscription/:id', async (req, res) => {
    const inv = invoice(idParam(req));
    if (inv.barbershop_id !== shopId(req)) throw new HttpError(404, 'Fatura não encontrada.');
    res.json({ ...inv, pix: await invoicePix(inv) });
  });

  // ---------- resumo e caixa

  router.get('/finance/summary', (req, res) => {
    const { from, to } = period(req);
    res.json(financeSummary(shopId(req), from, to));
  });

  router.get('/finance/entries', (req, res) => {
    const { from, to } = period(req);
    const shop = shopId(req);
    // Contas pendentes aparecem sempre, mesmo fora do período.
    const pending = all<{ id: number }>("SELECT id FROM cash_entries WHERE barbershop_id = ? AND status = 'pending' AND (date < ? OR date > ?)", [shop, from, to]).map((e) => e.id);
    const inPeriod = listEntries(shop, from, to);
    const extra = pending.length ? listEntries(shop, '0000-01-01', '9999-12-31').filter((e) => pending.includes(e.id)) : [];
    res.json([...extra, ...inPeriod]);
  });

  router.post('/finance/entries', (req, res) => {
    const body = parseBody(zEntry, req.body);
    res.status(201).json({ id: addEntry(shopId(req), body, req.user!.id) });
  });

  router.put('/finance/entries/:id', (req, res) => {
    updateEntry(shopId(req), idParam(req), parseBody(zEntry, req.body));
    res.json({ ok: true });
  });

  router.delete('/finance/entries/:id', (req, res) => {
    deleteEntry(shopId(req), idParam(req));
    res.json({ ok: true });
  });

  router.post('/finance/entries/:id/pay', (req, res) => {
    const body = parseBody(z.object({ date: zDay, method: zMethod.nullish().transform((v) => v ?? null) }), req.body);
    payEntry(shopId(req), idParam(req), body.date, body.method);
    res.json({ ok: true });
  });

  // ---------- vendas (fechar atendimento / venda de balcão)

  router.get('/finance/sales', (req, res) => {
    const { from, to } = period(req);
    res.json(listSales(shopId(req), from, to));
  });

  /** Dados para a tela de fechamento: catálogo, barbeiros e, se vier de um horário, o que já foi pedido. */
  router.get('/finance/checkout', (req, res) => {
    const shop = shopId(req);
    const appointmentId = req.query.appointment_id ? Number(req.query.appointment_id) : null;
    let appointment = null;
    if (appointmentId) {
      appointment = get(
        `SELECT a.id, a.customer_id, c.name AS customer_name, a.barber_id, a.service_id, a.service_name, a.price_cents, a.starts_at
           FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ? AND a.barbershop_id = ?`,
        [appointmentId, shop],
      );
      if (!appointment) throw new HttpError(404, 'Horário não encontrado.');
    }
    res.json({
      appointment,
      reserved: appointmentId ? reservedItems(appointmentId) : [],
      // Sinal pago antes (abatido no fechamento) ou ainda pendente.
      deposit: appointmentId ? depositState(shop, appointmentId) : null,
      // Produtos com controle de estoque trazem quanto ainda tem (descontado o que está separado).
      catalog: all<{ id: number; kind: string; name: string; price_cents: number; track_stock: number }>(
        'SELECT id, kind, name, price_cents, track_stock FROM catalog_items WHERE barbershop_id = ? AND active = 1 ORDER BY kind DESC, name COLLATE NOCASE',
        [shop],
      ).map(({ track_stock, ...c }) => ({ ...c, available: track_stock ? availableQty(shop, c.id, { exceptAppointmentId: appointmentId ?? undefined }) : null })),
      barbers: all('SELECT id, name FROM barbers WHERE barbershop_id = ? AND active = 1 ORDER BY name COLLATE NOCASE', [shop]),
    });
  });

  router.post('/finance/sales', (req, res) => {
    const body = parseBody(
      z.object({
        appointment_id: zId.nullish(),
        customer_id: zId.nullish(),
        items: z
          .array(
            z.object({
              catalog_item_id: zId.nullish(),
              name: zText(80),
              kind: z.enum(['service', 'product']).nullish(),
              qty: z.number().int().min(1).max(99),
              unit_price_cents: z.number().int().min(0).max(10_000_000).nullish(),
              barber_id: zId.nullish(),
              club: z.boolean().nullish(),
            }),
          )
          .min(1, 'Inclua pelo menos um item.')
          .max(30),
        discount_cents: z.number().int().min(0).max(10_000_000).default(0),
        method: zMethod,
        notes: zText(300),
      }),
      req.body,
    );
    const result = createSale({
      shopId: shopId(req),
      userId: req.user!.id,
      appointmentId: body.appointment_id,
      customerId: body.customer_id,
      items: body.items,
      discountCents: body.discount_cents,
      method: body.method,
      notes: body.notes,
    });
    res.status(201).json(result);
  });

  router.post('/finance/sales/:id/cancel', (req, res) => {
    res.json(cancelSale(shopId(req), idParam(req), req.user!.id));
  });

  // ---------- comissões e pagamento dos barbeiros

  router.get('/finance/commissions', (req, res) => {
    res.json(commissionBalances(shopId(req)));
  });

  router.get('/finance/commissions/:id', (req, res) => {
    const { from, to } = period(req);
    res.json(barberStatement(shopId(req), idParam(req), from, to));
  });

  router.post('/finance/payouts', (req, res) => {
    const body = parseBody(z.object({ barber_id: zId, until: zDay, method: zMethod.nullish().transform((v) => v ?? null), notes: zText(200) }), req.body);
    res.status(201).json(createPayout({ shopId: shopId(req), barberId: body.barber_id, until: body.until, method: body.method, notes: body.notes, userId: req.user!.id }));
  });

  // ---------- itens separados para um horário (ex.: cerveja do cliente)

  router.get('/appointments/:id/items', (req, res) => {
    const shop = shopId(req);
    const id = idParam(req);
    if (!get('SELECT 1 AS ok FROM appointments WHERE id = ? AND barbershop_id = ?', [id, shop])) throw new HttpError(404, 'Horário não encontrado.');
    res.json({ reserved: reservedItems(id), suggestion: suggestionFor(shop, id) });
  });

  router.post('/appointments/:id/items', async (req, res) => {
    const body = parseBody(z.object({ items: z.array(z.object({ product_id: zId, qty: z.number().int().min(1).max(20) })).min(1).max(10) }), req.body);
    res.json(await reserveItems(shopId(req), idParam(req), body.items.map((i) => ({ productId: i.product_id, qty: i.qty })), 'painel'));
  });
}
