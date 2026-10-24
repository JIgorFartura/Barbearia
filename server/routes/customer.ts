import { Router, type Request } from 'express';
import { z } from 'zod';
import { destroyCustomerSession, sessionCustomer } from '../customerAuth.js';
import { get, run } from '../db.js';
import { customerHabit, lastVisitDate } from '../habits.js';
import { HttpError, idParam, parseBody, zId } from '../http.js';
import { customerCard } from '../loyalty.js';
import { claimVoucher, customerVouchers, offersFor } from '../offers.js';
import { activeBarbers, book, cancel, freeTimes, historyFor, services, upcomingFor } from '../scheduling.js';
import { isDate, isTime } from '../time.js';

/**
 * Área logada do cliente (/b/:slug/conta). Só enxerga os próprios dados:
 * agenda, cartão fidelidade, benefícios/vouchers e preferências de lembrete.
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
    'SELECT id, name, phone, pref_weekday, pref_time, pref_barber_id, pref_service_id, pref_interval_days, reminders_opt_out FROM customers WHERE id = ?',
    [customerId],
  )!;
  res.json({
    customer,
    habit: customerHabit(customerId),
    lastVisit: lastVisitDate(customerId),
    upcoming: upcomingFor(customerId),
    history: historyFor(customerId).slice(0, 10),
    card: customerCard(shopId, customerId).map(({ campaign, running, progress }) => ({
      id: campaign.id,
      name: campaign.name,
      unit_label: campaign.unit_label,
      reward: campaign.reward,
      running,
      progress,
    })),
    offers: offersFor(shopId, customerId),
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
  res.status(201).json(
    book({ shopId, customerId, barberId: body.barber_id, serviceId: body.service_id, date: body.date, time: body.time, source: 'cliente' }),
  );
});

customerRouter.post('/appointments/:id/cancel', (req, res) => {
  const { shopId, customerId } = ctx(req);
  res.json(cancel(shopId, idParam(req), { customerId }));
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

customerRouter.post('/logout', (req, res) => {
  const shop = get<{ id: number }>('SELECT id FROM barbershops WHERE slug = ?', [slugOf(req)]);
  if (shop) destroyCustomerSession(req, res, shop.id);
  res.json({ ok: true });
});
