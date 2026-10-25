import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { accessStatus } from '../billing.js';
import { shopNow } from '../clock.js';
import { reservedItems } from '../consumption.js';
import { barberRating } from '../reviews.js';
import { clubCoverage } from '../club.js';
import { all, get, run } from '../db.js';
import { METHODS, barberStatement, commissionBalances, createSale } from '../finance.js';
import { HttpError, idParam, parseBody, zId, zText } from '../http.js';
import { addPhoto, barberSeesCustomer, customerProfile, deletePhoto, photoOf, profileSummary, saveNotes, sendPhoto, zNotes, zPhoto } from '../profile.js';
import { dayAgenda } from '../scheduling.js';
import { availableQty } from '../stock.js';
import { addDays, isDate } from '../time.js';

/**
 * Área do barbeiro: a própria agenda, fechar os próprios atendimentos (se o dono permitir) e o
 * extrato das comissões. Nada de caixa da barbearia, comissão dos colegas ou configurações.
 */
export const barberRouter = Router();
barberRouter.use(requireRole('barber'));
barberRouter.use((req, _res, next) => {
  const shop = get<{ active: number }>('SELECT active FROM barbershops WHERE id = ?', [req.user!.barbershopId]);
  if (!shop?.active) throw new HttpError(403, 'Barbearia suspensa pelo administrador da plataforma.');
  if (accessStatus(req.user!.barbershopId!).blocked) throw new HttpError(402, 'Acesso suspenso no momento. Fale com o dono da barbearia.');
  next();
});

const ids = (req: Request) => ({ shop: req.user!.barbershopId!, barber: req.user!.barberId!, user: req.user!.id });

function myAppointment(req: Request, id: number) {
  const { shop, barber } = ids(req);
  const a = get<{ id: number; customer_id: number; barber_id: number; status: string }>('SELECT id, customer_id, barber_id, status FROM appointments WHERE id = ? AND barbershop_id = ?', [
    id,
    shop,
  ]);
  if (!a || a.barber_id !== barber) throw new HttpError(404, 'Horário não encontrado na sua agenda.');
  return a;
}

const canClose = (shop: number) => Boolean(get<{ barber_can_close: number }>('SELECT barber_can_close FROM barbershops WHERE id = ?', [shop])?.barber_can_close);

barberRouter.get('/me', (req, res) => {
  const { shop, barber } = ids(req);
  res.json({
    barber: get('SELECT id, name, photo_url FROM barbers WHERE id = ?', [barber]),
    shop: get('SELECT id, slug, name, primary_color, accent_color, logo_url FROM barbershops WHERE id = ?', [shop]),
    canClose: canClose(shop),
    today: shopNow(shop).date,
    rating: barberRating(barber),
  });
});

/** Agenda do dia, só os horários deste barbeiro (com o que o cliente pediu para separar e, fechado, a parte dele). */
barberRouter.get('/agenda', (req, res) => {
  const { shop, barber } = ids(req);
  const date = typeof req.query.date === 'string' && isDate(req.query.date) ? req.query.date : shopNow(shop).date;
  res.json({
    date,
    appointments: dayAgenda(shop, date)
      .filter((a) => a.barber_id === barber)
      .map((a) => ({
        ...a,
        items: reservedItems(a.id),
        profile: profileSummary(a.customer_id),
        // Atendimento fechado: só a comissão dele, não o total que a barbearia recebeu.
        sale:
          get<{ id: number; commission_cents: number }>(
            `SELECT s.id, COALESCE((SELECT SUM(i.commission_cents) FROM sale_items i WHERE i.sale_id = s.id AND i.barber_id = ?), 0) AS commission_cents
               FROM sales s WHERE s.appointment_id = ? AND s.status = 'closed'`,
            [barber, a.id],
          ) ?? null,
      })),
    blocks: all('SELECT id, starts_at, ends_at, reason FROM barber_blocks WHERE barber_id = ? AND starts_at < ? AND ends_at > ?', [
      barber,
      `${addDays(date, 1)} 00:00`,
      `${date} 00:00`,
    ]),
    hours: all('SELECT weekday, start_time, end_time FROM barber_hours WHERE barber_id = ? ORDER BY weekday, start_time', [barber]),
  });
});

/** Falta (ou desfazer a falta) num horário do próprio barbeiro. */
barberRouter.post('/appointments/:id/status', (req, res) => {
  const a = myAppointment(req, idParam(req));
  const { status } = parseBody(z.object({ status: z.enum(['scheduled', 'no_show']) }), req.body);
  if (a.status === 'cancelled') throw new HttpError(409, 'Esse horário foi cancelado.');
  run('UPDATE appointments SET status = ? WHERE id = ?', [status, a.id]);
  res.json({ ok: true });
});

/** Ficha do cliente (anotações e fotos do corte): só de quem tem ou já teve horário com ele. */
function myCustomer(req: Request): number {
  const id = idParam(req);
  if (!barberSeesCustomer(ids(req).barber, id)) throw new HttpError(404, 'Cliente não encontrado na sua agenda.');
  return id;
}

barberRouter.get('/customers/:id/profile', (req, res) => {
  res.json(customerProfile(ids(req).shop, myCustomer(req), { userId: ids(req).user }));
});

barberRouter.put('/customers/:id/notes', (req, res) => {
  const id = myCustomer(req);
  const { notes } = parseBody(zNotes, req.body);
  saveNotes(ids(req).shop, id, notes);
  res.json(customerProfile(ids(req).shop, id, { userId: ids(req).user }));
});

barberRouter.post('/customers/:id/photos', (req, res) => {
  const { shop, barber, user } = ids(req);
  const id = myCustomer(req);
  const body = parseBody(zPhoto, req.body);
  // Foto ligada a um horário: só dos horários dele.
  if (body.appointment_id) myAppointment(req, body.appointment_id);
  addPhoto({ shopId: shop, customerId: id, dataUrl: body.dataUrl, thumbUrl: body.thumbUrl, appointmentId: body.appointment_id, barberId: barber, note: body.note, userId: user });
  res.status(201).json(customerProfile(shop, id, { userId: user }));
});

barberRouter.get('/photos/:id', (req, res) => {
  const { shop, barber } = ids(req);
  const p = photoOf(shop, idParam(req));
  if (!barberSeesCustomer(barber, p.customer_id)) throw new HttpError(404, 'Foto não encontrada.');
  sendPhoto(res, shop, p.id, { thumb: req.query.mini === '1' });
});

/** Apaga só a foto que ele mesmo tirou (as dos colegas ficam). */
barberRouter.delete('/photos/:id', (req, res) => {
  const { shop, user } = ids(req);
  const p = photoOf(shop, idParam(req));
  if (p.created_by !== user) throw new HttpError(403, 'Só quem tirou a foto (ou o dono) pode apagar.');
  deletePhoto(shop, p.id);
  res.json({ ok: true });
});

/** Clientes (só nome e celular) para a venda de balcão. */
barberRouter.get('/customers', (req, res) => {
  const { shop } = ids(req);
  const q = String(req.query.q ?? '').trim();
  const digits = q.replace(/\D/g, '');
  res.json(
    all(
      `SELECT id, name, phone FROM customers
        WHERE barbershop_id = :shop AND anonymized_at IS NULL AND (:q = '' OR name LIKE '%' || :q || '%' OR (:digits <> '' AND phone LIKE '%' || :digits || '%'))
        ORDER BY name COLLATE NOCASE LIMIT 20`,
      { shop, q, digits },
    ),
  );
});

/** Dados da comanda: o mesmo da tela do dono, mas só com este barbeiro. */
barberRouter.get('/checkout', (req, res) => {
  const { shop, barber } = ids(req);
  if (!canClose(shop)) throw new HttpError(403, 'O dono da barbearia não liberou o fechamento pelos barbeiros.');
  const appointmentId = req.query.appointment_id ? Number(req.query.appointment_id) : null;
  let appointment = null;
  if (appointmentId) {
    myAppointment(req, appointmentId);
    appointment = get(
      `SELECT a.id, a.customer_id, c.name AS customer_name, a.barber_id, a.service_id, a.service_name, a.price_cents, a.promo_percent, a.starts_at
         FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?`,
      [appointmentId],
    );
  }
  res.json({
    appointment,
    reserved: appointmentId ? reservedItems(appointmentId) : [],
    catalog: all<{ id: number; kind: string; name: string; price_cents: number; track_stock: number }>(
      'SELECT id, kind, name, price_cents, track_stock FROM catalog_items WHERE barbershop_id = ? AND active = 1 ORDER BY kind DESC, name COLLATE NOCASE',
      [shop],
    ).map(({ track_stock, ...c }) => ({ ...c, available: track_stock ? availableQty(shop, c.id, { exceptAppointmentId: appointmentId ?? undefined }) : null })),
    barbers: all('SELECT id, name FROM barbers WHERE id = ?', [barber]),
  });
});

/** O que o clube de assinatura cobre para o cliente hoje (na hora de fechar a comanda). */
barberRouter.get('/club', (req, res) => {
  const { shop } = ids(req);
  const customer = Number(req.query.customer_id);
  if (!Number.isInteger(customer) || customer <= 0) throw new HttpError(400, 'Informe o cliente.');
  res.json(clubCoverage(shop, customer, shopNow(shop).date));
});

/** Fecha um atendimento próprio ou registra uma venda de balcão (comissão sempre dele ou de ninguém). */
barberRouter.post('/sales', (req, res) => {
  const { shop, barber, user } = ids(req);
  if (!canClose(shop)) throw new HttpError(403, 'O dono da barbearia não liberou o fechamento pelos barbeiros.');
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
      method: z.enum(METHODS),
      notes: zText(300),
    }),
    req.body,
  );
  if (body.appointment_id) myAppointment(req, body.appointment_id);
  if (body.items.some((i) => i.barber_id && i.barber_id !== barber)) throw new HttpError(403, 'Você só lança vendas no seu nome.');
  res.status(201).json(
    createSale({
      shopId: shop,
      userId: user,
      appointmentId: body.appointment_id,
      customerId: body.customer_id,
      // No horário dele, item sem barbeiro fica com ele; "sem comissão" só na venda de balcão.
      items: body.items,
      discountCents: body.discount_cents,
      method: body.method,
      notes: body.notes,
    }),
  );
});

/** Meus ganhos: só a parte dele (comissão em aberto, extrato das comissões e pagamentos recebidos). */
barberRouter.get('/earnings', (req, res) => {
  const { shop, barber } = ids(req);
  const today = shopNow(shop).date;
  const from = typeof req.query.from === 'string' && isDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = typeof req.query.to === 'string' && isDate(req.query.to) ? req.query.to : today;
  if (to < from) throw new HttpError(400, 'Período inválido.');
  const balance = commissionBalances(shop).find((b) => b.barber_id === barber);
  // O valor das vendas é da barbearia: para o barbeiro vai só a comissão de cada item.
  const { items, commission, payouts } = barberStatement(shop, barber, from, to);
  res.json({
    from,
    to,
    balance: balance ?? null,
    items: items.map(({ total_cents: _total, sale_id: _sale, ...i }) => i),
    commission,
    services: items.filter((i) => i.kind === 'service').reduce((n, i) => n + i.qty, 0),
    payouts,
  });
});
