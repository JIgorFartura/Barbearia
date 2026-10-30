import type { Request, Router } from 'express';
import { z } from 'zod';
import { isReception, shopId } from '../auth.js';
import { accessStatus, annualPrice, billingInfo, informPayment, installmentOptions, invoice, invoicePix, listInvoices, platformSettings, saveBillingInfo, shopBilling, monthlyPrice } from '../billing.js';
import { asaasEnabled, asaasPix, chargeInvoice, chargeInvoiceCard, resetInvoiceCharge } from '../asaas.js';
import { setBillingCycle } from '../annual.js';
import { cancelSubscriptionCard, subscriptionCardLink, subscriptionCardState } from '../cards.js';
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
  saleView,
  updateEntry,
} from '../finance.js';
import { HttpError, idParam, parseBody, zId, zText } from '../http.js';
import { receivedFromCustomers } from '../payments.js';
import { shopNow } from '../clock.js';
import { addDays, isDate } from '../time.js';
import { autoSaleNfse, issueSaleNfse } from '../shopNfse.js';
import { shopAsaasOn } from '../shopAsaas.js';
import { cancelPixCheckout, pixCheckoutView, startPixCheckout } from '../pixCheckout.js';

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

/** A comanda montada na tela (venda direta ou PIX com confirmação automática). */
const zComanda = z.object({
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
        package_id: zId.nullish(),
      }),
    )
    .min(1, 'Inclua pelo menos um item.')
    .max(30),
  discount_cents: z.number().int().min(0).max(10_000_000).default(0),
  gift_code: z.string().trim().max(20).nullish(),
  gift_cents: z.number().int().min(1).max(10_000_000).nullish(),
  notes: zText(300),
});

/** Financeiro da barbearia, mensalidade da plataforma e situação de acesso (painel do dono). */
export function registerFinanceRoutes(router: Router): void {
  // ---------- situação do acesso, avisos da plataforma e mensalidade

  router.get('/status', (req, res) => {
    const shop = shopId(req);
    const status = accessStatus(shop);
    // Recepção: sem mensalidade nem conferência de PIX (são do dono).
    const desk = isReception(req);
    res.json({
      active: Boolean(get<{ active: number }>('SELECT active FROM barbershops WHERE id = ?', [shop])?.active),
      blocked: status.blocked,
      blockOn: desk ? null : status.blockOn,
      openInvoices: desk ? 0 : status.open.length,
      overdue: !desk && status.open.some((i) => i.overdue),
      trialUntil: desk ? null : status.trialUntil,
      whatsapp: connectionInfo(shop),
      pixToConfirm: desk ? 0 : get<{ n: number }>("SELECT COUNT(*) AS n FROM charges WHERE barbershop_id = ? AND status = 'open' AND claimed_at IS NOT NULL", [shop])!.n,
      // Desses, quantos vieram com o comprovante.
      receiptsToConfirm: desk
        ? 0
        : get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM charges WHERE barbershop_id = ? AND status = 'open' AND claimed_at IS NOT NULL AND receipt_file IS NOT NULL",
            [shop],
          )!.n,
      announcements: all("SELECT id, title, body, level, created_at FROM announcements WHERE active = 1 ORDER BY id DESC LIMIT 5"),
    });
  });

  router.get('/subscription', async (req, res) => {
    const shop = shopId(req);
    const s = shopBilling(shop);
    const status = accessStatus(shop);
    const invoices = listInvoices({ shopId: shop });
    const current = status.open[0] ?? null;
    const auto = asaasEnabled();
    const info = billingInfo(shop);
    // Cartão automático (Cielo): a fatura do mês é cobrada sozinha no cartão, no dia de vencimento.
    const card = subscriptionCardState(shop);
    const byCard = Boolean(current && card.active && !current.overdue);
    // Com o Asaas: PIX com baixa automática (precisa do CPF/CNPJ). Sem ele: PIX do master, confirmado à mão.
    let pix: { payload: string; qr: string } | null = null;
    // Página do Asaas da fatura: PIX, cartão de crédito ou boleto, com baixa automática.
    let payUrl: string | null = null;
    let pixError: string | null = null;
    if (current && auto && info.billing_document && !byCard) {
      const r = await asaasPix(current);
      if (r && 'url' in r) {
        payUrl = r.url;
        if (r.payload && r.qr) pix = { payload: r.payload, qr: r.qr };
      } else pixError = r?.error ?? null;
    }
    const autoPix = Boolean(pix);
    if (current && !pix && !payUrl && !byCard) pix = await invoicePix(current);
    res.json({
      plan: s.plan_name,
      price_cents: monthlyPrice(s),
      billing_day: s.billing_day,
      trial_until: s.trial_until,
      courtesy: status.courtesy,
      billing_cycle: s.billing_cycle,
      // Oferta do anual (para quem está no mensal) e o valor dele.
      annual:
        monthlyPrice(s) > 0 && !status.courtesy
          ? { price_cents: annualPrice(s), per_month_cents: Math.round(annualPrice(s) / 12), discount_pct: platformSettings().annual_discount_pct }
          : null,
      // Anual em aberto: parcelas no cartão (juros a partir da parcela configurada, pagos por quem parcela).
      card_options:
        current && auto && info.billing_document && (current.reference.startsWith('anual:') || current.reference === 'implantacao') ? installmentOptions(current.amount_cents) : [],
      installments: current ? (get<{ n: number | null }>('SELECT installments AS n FROM invoices WHERE id = ?', [current.id])?.n ?? null) : null,
      blocked: status.blocked,
      graceDays: status.graceDays,
      blockOn: status.blockOn,
      current: current ? { ...current, pix: pix && { ...pix, auto: autoPix }, payUrl, pixError, byCard } : null,
      card,
      invoices,
      billing: { auto, needsDocument: auto && !info.billing_document, ...info },
    });
  });

  /** A barbearia passa para o plano anual (com o desconto): a fatura anual sai na hora. */
  router.post('/subscription/annual', async (req, res) => {
    const shop = shopId(req);
    if (accessStatus(shop).courtesy) throw new HttpError(409, 'Sua barbearia está com cortesia: não há mensalidade.');
    if (monthlyPrice(shopBilling(shop)) <= 0) throw new HttpError(409, 'Sua barbearia ainda não tem mensalidade definida.');
    await setBillingCycle(shop, 'anual');
    res.json({ ok: true });
  });

  /** Fatura no cartão de crédito, à vista ou parcelada, pela página do Asaas. */
  router.post('/subscription/:id/card', async (req, res) => {
    const { installments } = parseBody(z.object({ installments: z.number().int().min(1).max(12) }), req.body);
    const inv = listInvoices({ shopId: shopId(req), status: 'open' }).find((i) => i.id === idParam(req));
    if (!inv) throw new HttpError(404, 'Fatura não encontrada.');
    if (installments > 1 && !inv.reference.startsWith('anual:') && inv.reference !== 'implantacao') throw new HttpError(400, 'O parcelamento é só para o plano anual e a implantação.');
    res.json(await chargeInvoiceCard(inv.id, installments));
  });

  /** Voltar para PIX ou boleto depois de escolher o cartão. */
  router.post('/subscription/:id/reset-charge', async (req, res) => {
    const inv = listInvoices({ shopId: shopId(req), status: 'open' }).find((i) => i.id === idParam(req));
    if (!inv) throw new HttpError(404, 'Fatura não encontrada.');
    await resetInvoiceCharge(inv.id);
    res.json({ ok: true });
  });

  /** Cartão automático da mensalidade (Cielo): devolve o link para cadastrar o cartão e pagar a fatura em aberto. */
  router.post('/subscription/card', async (req, res) => {
    res.json(await subscriptionCardLink(shopId(req)));
  });

  router.delete('/subscription/card', async (req, res) => {
    await cancelSubscriptionCard(shopId(req));
    res.json(subscriptionCardState(shopId(req)));
  });

  /** CPF/CNPJ e nome para a cobrança automática e a nota fiscal da mensalidade. */
  router.put('/billing-info', async (req, res) => {
    const body = parseBody(
      z.object({ document: z.string().trim().max(20), name: z.string().trim().min(2, 'Informe o nome ou a razão social.').max(100), email: z.email().nullish().or(z.literal('')) }),
      req.body,
    );
    const shop = shopId(req);
    const info = saveBillingInfo(shop, { document: body.document, name: body.name, email: body.email || null });
    // Já cria a cobrança da fatura em aberto, para o PIX aparecer na hora.
    const open = accessStatus(shop).open[0];
    if (open) await chargeInvoice(open.id);
    res.json(info);
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

  /** Recebimentos: tudo o que os clientes pagaram no período (balcão e clube), com os comprovantes do PIX. */
  router.get('/finance/received', (req, res) => {
    const { from, to } = period(req);
    res.json(receivedFromCustomers(shopId(req), from, to));
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
        `SELECT a.id, a.customer_id, c.name AS customer_name, a.barber_id, a.service_id, a.service_name, a.price_cents, a.promo_percent, a.promo_kind, a.starts_at
           FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ? AND a.barbershop_id = ?`,
        [appointmentId, shop],
      );
      if (!appointment) throw new HttpError(404, 'Horário não encontrado.');
    }
    res.json({
      appointment,
      reserved: appointmentId ? reservedItems(appointmentId) : [],
      // Produtos com controle de estoque trazem quanto ainda tem (descontado o que está separado).
      catalog: all<{ id: number; kind: string; name: string; price_cents: number; track_stock: number }>(
        'SELECT id, kind, name, price_cents, track_stock FROM catalog_items WHERE barbershop_id = ? AND active = 1 ORDER BY kind DESC, name COLLATE NOCASE',
        [shop],
      ).map(({ track_stock, ...c }) => ({ ...c, available: track_stock ? availableQty(shop, c.id, { exceptAppointmentId: appointmentId ?? undefined }) : null })),
      barbers: all('SELECT id, name FROM barbers WHERE barbershop_id = ? AND active = 1 ORDER BY name COLLATE NOCASE', [shop]),
      // Asaas da barbearia ligado: o PIX da comanda sai com QR próprio e a venda fecha sozinha quando cai.
      pixAuto: shopAsaasOn(shop),
    });
  });

  router.post('/finance/sales', (req, res) => {
    const body = parseBody(zComanda.extend({ method: zMethod }), req.body);
    const result = createSale({
      shopId: shopId(req),
      userId: req.user!.id,
      appointmentId: body.appointment_id,
      customerId: body.customer_id,
      items: body.items,
      discountCents: body.discount_cents,
      giftCode: body.gift_code,
      giftCents: body.gift_cents,
      method: body.method,
      notes: body.notes,
    });
    // Nota fiscal automática (se a barbearia ligou): sem travar a venda.
    autoSaleNfse(shopId(req), result.sale.id);
    // A recepção registra a venda, mas a comissão de cada barbeiro é assunto do dono.
    if (isReception(req)) result.sale.items = result.sale.items.map((i) => ({ ...i, commission_cents: 0 }));
    res.status(201).json(result);
  });

  /** Nota fiscal de serviço da venda (com o CPF do cliente, se ainda não tinha). */
  router.post('/finance/sales/:id/nfse', async (req, res) => {
    const { cpf } = parseBody(z.object({ cpf: zText(20) }), req.body ?? {});
    const r = await issueSaleNfse(shopId(req), idParam(req), { cpf });
    if (!r.ok) throw new HttpError(r.status ?? 502, r.error ?? 'O Asaas não aceitou a nota.');
    res.json(saleView(idParam(req)));
  });

  router.post('/finance/sales/:id/cancel', (req, res) => {
    res.json(cancelSale(shopId(req), idParam(req), req.user!.id));
  });

  // ---------- PIX da comanda com confirmação automática (Asaas da barbearia)

  router.post('/finance/pix-checkout', async (req, res) => {
    const body = parseBody(zComanda.extend({ payer_cpf: zText(20) }), req.body);
    const r = await startPixCheckout(
      shopId(req),
      req.user!.id,
      {
        appointmentId: body.appointment_id,
        customerId: body.customer_id,
        items: body.items,
        discountCents: body.discount_cents,
        giftCode: body.gift_code,
        giftCents: body.gift_cents,
        notes: body.notes,
      },
      body.payer_cpf,
    );
    res.status('needsCpf' in r ? 200 : 201).json(r);
  });

  router.get('/finance/pix-checkout/:id', (req, res) => {
    res.json(pixCheckoutView(shopId(req), idParam(req)));
  });

  router.delete('/finance/pix-checkout/:id', async (req, res) => {
    res.json(await cancelPixCheckout(shopId(req), idParam(req)));
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
