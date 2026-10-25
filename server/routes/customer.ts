import { Router, type Request } from 'express';
import { z } from 'zod';
import { charge, chargePix, claimCharge } from '../charges.js';
import { cancelMemberCard, payChargeByCard } from '../cards.js';
import { shopCardStatus } from '../cardSettings.js';
import { birthdayKey, customerReferral, growthSettings } from '../growth.js';
import { cancelMembership, customerMembership, listPlans, subscribe } from '../club.js';
import { destroyCustomerSession, sessionCustomer } from '../customerAuth.js';
import { anonymizeCustomer, exportCustomerData } from '../privacy.js';
import { reservedItems, reserveItems, suggestionFor } from '../consumption.js';
import { get, run } from '../db.js';
import { customerHabit, lastVisitDate } from '../habits.js';
import { HttpError, idParam, parseBody, zId } from '../http.js';
import { customerCard } from '../loyalty.js';
import { claimVoucher, customerVouchers, offersFor } from '../offers.js';
import { customerPayments } from '../payments.js';
import { notifyReceipt, receiptInfo, saveReceipt, sendReceipt } from '../receipts.js';
import { activeBarbers, book, cancel, freeTimes, historyFor, services, upcomingFor } from '../scheduling.js';
import { confirmAppointment } from '../attendance.js';
import { PERIOD_IDS, customerWaitlist, joinWaitlist, leaveWaitlist, slotFreed, type Period } from '../waitlist.js';
import { isDate, isTime } from '../time.js';

/**
 * Área logada do cliente (/b/:slug/conta). Só enxerga os próprios dados: agenda, os pagamentos
 * dele à barbearia, cartão fidelidade, benefícios/vouchers e preferências de lembrete.
 */
export const customerRouter = Router({ mergeParams: true });

interface Ctx {
  shopId: number;
  slug: string;
  customerId: number;
}

const slugOf = (req: Request) => String(req.params.slug ?? '').toLowerCase();

function ctx(req: Request): Ctx {
  const slug = slugOf(req);
  const shop = get<{ id: number }>('SELECT id FROM barbershops WHERE slug = ? AND active = 1', [slug]);
  if (!shop) throw new HttpError(404, 'Barbearia não encontrada.');
  const customerId = sessionCustomer(req, shop.id);
  if (!customerId) throw new HttpError(401, 'Entre com seu celular para continuar.');
  return { shopId: shop.id, slug, customerId };
}

customerRouter.get('/me', (req, res) => {
  const { shopId, customerId } = ctx(req);
  const customer = get<Record<string, unknown>>(
    'SELECT id, name, phone, pref_weekday, pref_time, pref_barber_id, pref_service_id, pref_interval_days, reminders_opt_out, birth_date, privacy_accepted_at FROM customers WHERE id = ?',
    [customerId],
  )!;
  res.json({
    customer,
    privacyAccepted: Boolean(customer.privacy_accepted_at),
    habit: customerHabit(customerId),
    lastVisit: lastVisitDate(customerId),
    upcoming: upcomingFor(customerId).map((a) => ({ ...a, items: reservedItems(a.id) })),
    // Dias em que ele está na lista de espera (o robô avisa quando abrir vaga).
    waitlist: customerWaitlist(customerId).map(({ id, date, period, barber_id, barber_name, service_name, offers }) => ({ id, date, period, barber_id, barber_name, service_name, offers })),
    history: historyFor(customerId).slice(0, 10),
    // Os pagamentos dele (é dele por direito): compras e clube, com data, forma e o comprovante que ele mandou.
    // Nada interno (comissão, barbeiro do produto...).
    payments: customerPayments(shopId, customerId),
    card: customerCard(shopId, customerId).map(({ campaign, running, progress }) => ({
      id: campaign.id,
      name: campaign.name,
      unit_label: campaign.unit_label,
      reward: campaign.reward,
      running,
      progress,
    })),
    offers: offersFor(shopId, customerId),
    referral: customerReferral(shopId, customerId),
    birthday: (() => {
      const g = growthSettings(shopId);
      return { enabled: g.birthday_enabled, gift: g.birthday_enabled ? (g.birthday_reward?.title ?? null) : null, value: (customer.birth_date as string | null) ?? null };
    })(),
    vouchers: customerVouchers(customerId),
    barbers: activeBarbers(shopId).map(({ id, name, photo_url }) => ({ id, name, photo_url })),
    services: services(shopId),
  });
});

customerRouter.get('/availability', (req, res) => {
  const { shopId } = ctx(req);
  const date = String(req.query.date ?? '');
  const num = (v: unknown) => (v ? Number(v) : null);
  res.json(freeTimes(shopId, date, { barberId: num(req.query.barber_id), serviceId: num(req.query.service_id) }));
});

customerRouter.post('/appointments', (req, res) => {
  const { shopId, customerId } = ctx(req);
  const body = parseBody(
    z.object({
      barber_id: zId,
      service_id: zId.nullish(),
      date: z.string().refine(isDate, 'Data inválida.'),
      time: z.string().refine(isTime, 'Hora inválida.'),
    }),
    req.body,
  );
  const appointment = book({ shopId, customerId, barberId: body.barber_id, serviceId: body.service_id, date: body.date, time: body.time, source: 'cliente' });
  res.status(201).json({
    ...appointment,
    // Mesma pergunta do robô: "posso avisar o Paulo da sua cerveja?"
    suggestion: suggestionFor(shopId, appointment.id),
  });
});

customerRouter.post('/appointments/:id/items', async (req, res) => {
  const { shopId, customerId } = ctx(req);
  const body = parseBody(z.object({ items: z.array(z.object({ product_id: zId, qty: z.number().int().min(1).max(10) })).min(1).max(5) }), req.body);
  res.json(await reserveItems(shopId, idParam(req), body.items.map((i) => ({ productId: i.product_id, qty: i.qty })), 'cliente', { customerId }));
});

customerRouter.post('/appointments/:id/cancel', (req, res) => {
  const { shopId, customerId } = ctx(req);
  const a = cancel(shopId, idParam(req), { customerId });
  // A vaga vai na hora para quem está na lista de espera.
  slotFreed(shopId);
  res.json(a);
});

customerRouter.post('/appointments/:id/confirm', (req, res) => {
  const { shopId, customerId } = ctx(req);
  res.json(confirmAppointment(shopId, idParam(req), { customerId }));
});

/** Lista de espera: dia sem horário livre (com barbeiro e período, se quiser). */
customerRouter.post('/waitlist', (req, res) => {
  const { shopId, customerId } = ctx(req);
  const body = parseBody(
    z.object({
      date: z.string().refine(isDate, 'Data inválida.'),
      barber_id: zId.nullish(),
      service_id: zId.nullish(),
      period: z.enum(PERIOD_IDS as [Period, ...Period[]]).default('qualquer'),
    }),
    req.body,
  );
  const w = joinWaitlist({ shopId, customerId, date: body.date, barberId: body.barber_id, serviceId: body.service_id, period: body.period, source: 'cliente' });
  // Se já tem vaga que serve (alguém acabou de cancelar), a oferta sai agora.
  slotFreed(shopId);
  res.status(201).json({ id: w.id, date: w.date, period: w.period, barber_id: w.barber_id, barber_name: w.barber_name, service_name: w.service_name, offers: w.offers });
});

customerRouter.delete('/waitlist/:id', (req, res) => {
  const { shopId, customerId } = ctx(req);
  leaveWaitlist(shopId, idParam(req), { customerId });
  res.json({ ok: true });
});

customerRouter.post('/offers/:id/claim', (req, res) => {
  const { shopId, customerId } = ctx(req);
  res.status(201).json(claimVoucher(shopId, idParam(req), customerId));
});

/** Horário de costume (para o lembrete semanal) e se quer receber mensagens automáticas. */
customerRouter.put('/preferences', (req, res) => {
  const { shopId, customerId } = ctx(req);
  const body = parseBody(
    z.object({
      name: z.string().trim().min(2).max(80),
      pref_weekday: z.number().int().min(0).max(6).nullable(),
      pref_time: z.string().refine(isTime, 'Hora inválida.').nullable(),
      pref_barber_id: zId.nullable(),
      pref_service_id: zId.nullable(),
      pref_interval_days: z.number().int().min(7).max(60).nullable(),
      reminders_opt_out: z.boolean(),
    }),
    req.body,
  );
  if ((body.pref_weekday == null) !== (body.pref_time == null)) throw new HttpError(400, 'Informe o dia e a hora do seu costume (ou deixe os dois em branco).');
  if (body.pref_barber_id && !get('SELECT 1 AS ok FROM barbers WHERE id = ? AND barbershop_id = ?', [body.pref_barber_id, shopId])) {
    throw new HttpError(400, 'Barbeiro não encontrado.');
  }
  if (body.pref_service_id && !get("SELECT 1 AS ok FROM catalog_items WHERE id = ? AND barbershop_id = ? AND kind = 'service'", [body.pref_service_id, shopId])) {
    throw new HttpError(400, 'Serviço não encontrado.');
  }
  run(
    `UPDATE customers SET name = ?, pref_weekday = ?, pref_time = ?, pref_barber_id = ?, pref_service_id = ?, pref_interval_days = ?, reminders_opt_out = ?
      WHERE id = ?`,
    [
      body.name,
      body.pref_weekday,
      body.pref_time,
      body.pref_barber_id,
      body.pref_service_id,
      body.pref_interval_days,
      body.reminders_opt_out,
      customerId,
    ],
  );
  res.json({ ok: true, habit: customerHabit(customerId) });
});

/** Aniversário (dia e mês) para o presente da barbearia. */
customerRouter.put('/birthday', (req, res) => {
  const { customerId } = ctx(req);
  const body = parseBody(z.object({ day: z.number().int().nullable(), month: z.number().int().nullable() }), req.body);
  const key = body.day == null && body.month == null ? null : birthdayKey(body.day ?? 0, body.month ?? 0);
  if ((body.day != null || body.month != null) && !key) throw new HttpError(400, 'Data de aniversário inválida.');
  run('UPDATE customers SET birth_date = ? WHERE id = ?', [key, customerId]);
  res.json({ ok: true, value: key });
});

// ---------- LGPD: aceite, cópia dos dados e exclusão da conta

customerRouter.post('/privacy/accept', (req, res) => {
  const { customerId } = ctx(req);
  run('UPDATE customers SET privacy_accepted_at = COALESCE(privacy_accepted_at, ?) WHERE id = ?', [new Date().toISOString(), customerId]);
  res.json({ ok: true });
});

/** Baixa tudo o que a barbearia guarda sobre o cliente (arquivo JSON). */
customerRouter.get('/my-data', (req, res) => {
  const { shopId, slug, customerId } = ctx(req);
  res.setHeader('content-disposition', `attachment; filename="meus-dados-${slug}.json"`);
  res.json(exportCustomerData(shopId, customerId));
});

/** Exclui a conta: apaga os dados pessoais (as vendas ficam no caixa sem identificação). */
customerRouter.post('/delete-account', (req, res) => {
  const { shopId, customerId } = ctx(req);
  parseBody(z.object({ confirm: z.literal('EXCLUIR', 'Digite EXCLUIR para confirmar.') }), req.body);
  anonymizeCustomer(shopId, customerId);
  destroyCustomerSession(req, res, shopId);
  res.json({ ok: true });
});

// ---------- clube de assinatura

async function clubState(shopId: number, customerId: number) {
  const member = customerMembership(shopId, customerId);
  const open = member?.open_charge ?? null;
  return {
    plans: listPlans(shopId, { activeOnly: true }).map(({ id, name, description, price_cents, uses_per_month, items }) => ({
      id,
      name,
      description,
      price_cents,
      uses_per_month,
      items: items.map((i) => i.name),
    })),
    member: member && {
      id: member.id,
      plan: member.plan,
      status: member.status,
      state: member.state,
      period: member.period,
      used: member.used,
      paid_until: member.paid_until,
      /** No cartão automático: a Cielo cobra sozinha todo mês. */
      card: member.card.active,
    },
    charge: open && {
      id: open.id,
      description: open.description,
      amount_cents: open.amount_cents,
      due_date: open.due_date,
      claimed: Boolean(open.claimed_at),
      receipt: receiptInfo(open),
      pix: await chargePix(open),
    },
    /** A barbearia aceita cartão (página segura da Cielo). */
    online: shopCardStatus(shopId).available,
  };
}

/** Pagar a mensalidade do clube no cartão (a Cielo cobra sozinha todo mês): devolve o link da página da Cielo. */
customerRouter.post('/charges/:id/pay-online', async (req, res) => {
  const { shopId, customerId } = ctx(req);
  res.json(await payChargeByCard(shopId, customerId, idParam(req)));
});

customerRouter.get('/club', async (req, res) => {
  const { shopId, customerId } = ctx(req);
  res.json(await clubState(shopId, customerId));
});

customerRouter.post('/club/subscribe', async (req, res) => {
  const { shopId, customerId } = ctx(req);
  const { plan_id } = parseBody(z.object({ plan_id: zId }), req.body);
  subscribe(shopId, customerId, plan_id);
  res.status(201).json(await clubState(shopId, customerId));
});

customerRouter.post('/club/charges/:id/claim', async (req, res) => {
  const { shopId, customerId } = ctx(req);
  claimCharge(shopId, customerId, idParam(req));
  res.json(await clubState(shopId, customerId));
});

/** Comprovante do PIX (foto ou PDF): vale como "já paguei" e a barbearia recebe uma cópia. */
customerRouter.post('/club/charges/:id/receipt', async (req, res) => {
  const { shopId, customerId } = ctx(req);
  const { dataUrl } = parseBody(z.object({ dataUrl: z.string().max(5_000_000) }), req.body);
  const id = idParam(req);
  const { notify } = saveReceipt(shopId, customerId, id, dataUrl);
  if (notify) void notifyReceipt(id).catch((err) => console.error('[comprovante]', err));
  res.json(await clubState(shopId, customerId));
});

/** O próprio cliente revê o comprovante que mandou. */
customerRouter.get('/charges/:id/receipt', (req, res) => {
  const { shopId, customerId } = ctx(req);
  const c = charge(idParam(req), shopId);
  if (c.customer_id !== customerId) throw new HttpError(404, 'Comprovante não encontrado.');
  sendReceipt(res, c);
});

customerRouter.post('/club/cancel', async (req, res) => {
  const { shopId, customerId } = ctx(req);
  const member = customerMembership(shopId, customerId);
  if (!member || member.status === 'cancelled') throw new HttpError(404, 'Você não tem assinatura ativa.');
  cancelMembership(shopId, member.id);
  // A Cielo para de cobrar o cartão (se falhar agora, a conferência de hora em hora tenta de novo).
  await cancelMemberCard(member.id);
  res.json(await clubState(shopId, customerId));
});

customerRouter.post('/logout', (req, res) => {
  const shop = get<{ id: number }>('SELECT id FROM barbershops WHERE slug = ?', [slugOf(req)]);
  if (shop) destroyCustomerSession(req, res, shop.id);
  res.json({ ok: true });
});
