import type { Router } from 'express';
import { z } from 'zod';
import { hashPassword, shopId } from '../auth.js';
import { zPassword } from './auth.js';
import { customerHabit } from '../habits.js';
import { all, get, nowIso, run, tx } from '../db.js';
import { reservedItems } from '../consumption.js';
import { HttpError, idParam, normalizePhone, parseBody, zBool, zId, zText, zUrl } from '../http.js';
import { book, cancel, dayAgenda, freeTimes, upcomingFor } from '../scheduling.js';
import { shopNow } from '../clock.js';
import { addDays, isDate, isTime, toMinutes } from '../time.js';

const zTime = z.string().refine(isTime, 'Hora no formato HH:MM.');
const zDay = z.string().refine(isDate, 'Data no formato AAAA-MM-DD.');

const zHours = z
  .array(z.object({ weekday: z.number().int().min(0).max(6), start_time: zTime, end_time: zTime }))
  .max(21)
  .superRefine((ranges, ctx) => {
    for (const r of ranges) {
      if (toMinutes(r.end_time) <= toMinutes(r.start_time)) ctx.addIssue({ code: 'custom', message: 'O fim do expediente deve ser depois do início.' });
    }
    for (let d = 0; d < 7; d++) {
      const day = ranges.filter((r) => r.weekday === d).sort((a, b) => a.start_time.localeCompare(b.start_time));
      for (let i = 1; i < day.length; i++) {
        if (day[i].start_time < day[i - 1].end_time) ctx.addIssue({ code: 'custom', message: 'Faixas de horário sobrepostas no mesmo dia.' });
      }
    }
  });

const zRates = z
  .array(z.object({ service_id: zId, mode: z.enum(['percent', 'fixed']), value: z.number().min(0).max(10_000_000) }))
  .max(50)
  .superRefine((rates, ctx) => {
    if (rates.some((r) => r.mode === 'percent' && r.value > 100)) ctx.addIssue({ code: 'custom', message: 'Comissão em % vai de 0 a 100.' });
  });

const zBarber = z.object({
  name: z.string().trim().min(2).max(60),
  photo_url: zUrl,
  active: zBool,
  hours: zHours,
  /** Celular para o robô avisar o barbeiro (ex.: cerveja separada para o cliente). */
  phone: zText(20),
  service_commission: z.number().min(0).max(100),
  product_commission: z.number().min(0).max(100),
  rates: zRates,
});

function barberOf(shop: number, id: number) {
  const barber = get<{ id: number }>('SELECT id FROM barbers WHERE id = ? AND barbershop_id = ?', [id, shop]);
  if (!barber) throw new HttpError(404, 'Barbeiro não encontrado.');
  return barber;
}

function saveHours(barberId: number, hours: z.infer<typeof zHours>) {
  run('DELETE FROM barber_hours WHERE barber_id = ?', [barberId]);
  for (const h of hours) run('INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)', [barberId, h.weekday, h.start_time, h.end_time]);
}

/** Exceções de comissão por serviço (ex.: corte R$ 25,00 fixo, barba 60%). */
function saveRates(shop: number, barberId: number, rates: z.infer<typeof zRates>) {
  run('DELETE FROM barber_service_rates WHERE barber_id = ?', [barberId]);
  for (const r of rates) {
    if (!get("SELECT 1 AS ok FROM catalog_items WHERE id = ? AND barbershop_id = ? AND kind = 'service'", [r.service_id, shop])) throw new HttpError(400, 'Serviço não encontrado.');
    run('INSERT OR REPLACE INTO barber_service_rates (barber_id, service_id, mode, value) VALUES (?, ?, ?, ?)', [barberId, r.service_id, r.mode, r.value]);
  }
}

const cleanPhone = (phone: string | null) => (phone ? normalizePhone(phone) : null);

function barbersWithHours(shop: number) {
  const barbers = all<{ id: number; name: string; photo_url: string | null; active: number; phone: string | null; service_commission: number; product_commission: number }>(
    'SELECT id, name, photo_url, active, phone, service_commission, product_commission FROM barbers WHERE barbershop_id = ? ORDER BY active DESC, name COLLATE NOCASE',
    [shop],
  );
  const now = shopNow(shop).stamp;
  return barbers.map((b) => ({
    ...b,
    hours: all('SELECT weekday, start_time, end_time FROM barber_hours WHERE barber_id = ? ORDER BY weekday, start_time', [b.id]),
    blocks: all('SELECT id, starts_at, ends_at, reason FROM barber_blocks WHERE barber_id = ? AND ends_at >= ? ORDER BY starts_at', [b.id, now]),
    rates: all('SELECT service_id, mode, value FROM barber_service_rates WHERE barber_id = ?', [b.id]),
    // Login do barbeiro no sistema (agenda própria, fechar atendimento, comissões).
    access: get<{ user_id: number; phone: string | null; email: string | null }>("SELECT id AS user_id, phone, email FROM users WHERE barber_id = ? AND role = 'barber'", [b.id]) ?? null,
  }));
}

/** Agenda, barbeiros e horários (painel do dono). */
export function registerAgendaRoutes(router: Router): void {
  router.get('/barbers', (req, res) => {
    res.json(barbersWithHours(shopId(req)));
  });

  router.post('/barbers', (req, res) => {
    const body = parseBody(zBarber, req.body);
    const shop = shopId(req);
    tx(() => {
      const { lastInsertRowid } = run(
        'INSERT INTO barbers (barbershop_id, name, photo_url, active, phone, service_commission, product_commission, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [shop, body.name, body.photo_url, body.active, cleanPhone(body.phone), body.service_commission, body.product_commission, nowIso()],
      );
      saveHours(lastInsertRowid, body.hours);
      saveRates(shop, lastInsertRowid, body.rates);
    });
    res.status(201).json(barbersWithHours(shop));
  });

  router.put('/barbers/:id', (req, res) => {
    const shop = shopId(req);
    const id = barberOf(shop, idParam(req)).id;
    const body = parseBody(zBarber, req.body);
    tx(() => {
      run('UPDATE barbers SET name = ?, photo_url = ?, active = ?, phone = ?, service_commission = ?, product_commission = ? WHERE id = ?', [
        body.name,
        body.photo_url,
        body.active,
        cleanPhone(body.phone),
        body.service_commission,
        body.product_commission,
        id,
      ]);
      saveHours(id, body.hours);
      saveRates(shop, id, body.rates);
    });
    res.json(barbersWithHours(shop));
  });

  router.delete('/barbers/:id', (req, res) => {
    const shop = shopId(req);
    const id = barberOf(shop, idParam(req)).id;
    if (get('SELECT 1 AS ok FROM appointments WHERE barber_id = ? LIMIT 1', [id]) || get('SELECT 1 AS ok FROM sale_items WHERE barber_id = ? LIMIT 1', [id])) {
      throw new HttpError(409, 'Esse barbeiro tem horários no histórico. Desative em vez de excluir.');
    }
    run('DELETE FROM barbers WHERE id = ?', [id]);
    res.json(barbersWithHours(shop));
  });

  // Acesso do barbeiro ao sistema (login pelo celular ou e-mail)
  router.post('/barbers/:id/access', (req, res) => {
    const shop = shopId(req);
    const id = barberOf(shop, idParam(req)).id;
    const body = parseBody(
      z.object({ phone: z.string().max(30), email: z.string().trim().toLowerCase().email('E-mail inválido.').nullish().or(z.literal('')), password: zPassword }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    const email = body.email || null;
    if (get("SELECT 1 AS ok FROM users WHERE barber_id = ? AND role = 'barber'", [id])) throw new HttpError(409, 'Esse barbeiro já tem acesso.');
    if (get('SELECT 1 AS ok FROM users WHERE phone = ?', [phone])) throw new HttpError(409, 'Esse celular já está em outro login.');
    if (email && get('SELECT 1 AS ok FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Esse e-mail já está em outro login.');
    const name = get<{ name: string }>('SELECT name FROM barbers WHERE id = ?', [id])!.name;
    run("INSERT INTO users (barbershop_id, role, name, email, phone, barber_id, password_hash, terms_accepted_at, created_at) VALUES (?, 'barber', ?, ?, ?, ?, ?, ?, ?)", [
      shop,
      name,
      email,
      phone,
      id,
      hashPassword(body.password),
      nowIso(),
      nowIso(),
    ]);
    res.status(201).json(barbersWithHours(shop));
  });

  router.put('/barbers/:id/access', (req, res) => {
    const shop = shopId(req);
    const id = barberOf(shop, idParam(req)).id;
    const { password } = parseBody(z.object({ password: zPassword }), req.body);
    const user = get<{ id: number }>("SELECT id FROM users WHERE barber_id = ? AND role = 'barber'", [id]);
    if (!user) throw new HttpError(404, 'Esse barbeiro ainda não tem acesso.');
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user.id]);
    run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    res.json(barbersWithHours(shop));
  });

  router.delete('/barbers/:id/access', (req, res) => {
    const shop = shopId(req);
    const id = barberOf(shop, idParam(req)).id;
    run("DELETE FROM users WHERE barber_id = ? AND role = 'barber'", [id]);
    res.json(barbersWithHours(shop));
  });

  /** O que os barbeiros podem fazer com o acesso deles. */
  router.get('/barber-settings', (req, res) => {
    res.json(get('SELECT barber_can_close FROM barbershops WHERE id = ?', [shopId(req)]));
  });

  router.put('/barber-settings', (req, res) => {
    const { barber_can_close } = parseBody(z.object({ barber_can_close: zBool }), req.body);
    run('UPDATE barbershops SET barber_can_close = ? WHERE id = ?', [barber_can_close, shopId(req)]);
    res.json({ barber_can_close: barber_can_close ? 1 : 0 });
  });

  // Folgas e bloqueios
  router.post('/barbers/:id/blocks', (req, res) => {
    const shop = shopId(req);
    const id = barberOf(shop, idParam(req)).id;
    const body = parseBody(z.object({ date: zDay, start_time: zTime, end_date: zDay, end_time: zTime, reason: zText(120) }), req.body);
    const start = `${body.date} ${body.start_time}`;
    const end = `${body.end_date} ${body.end_time}`;
    if (end <= start) throw new HttpError(400, 'O fim do bloqueio deve ser depois do início.');
    run('INSERT INTO barber_blocks (barber_id, starts_at, ends_at, reason, created_at) VALUES (?, ?, ?, ?, ?)', [id, start, end, body.reason, nowIso()]);
    res.status(201).json(barbersWithHours(shop));
  });

  router.delete('/blocks/:id', (req, res) => {
    const shop = shopId(req);
    const { changes } = run('DELETE FROM barber_blocks WHERE id = ? AND barber_id IN (SELECT id FROM barbers WHERE barbershop_id = ?)', [idParam(req), shop]);
    if (!changes) throw new HttpError(404, 'Bloqueio não encontrado.');
    res.json(barbersWithHours(shop));
  });

  // Agenda do dia
  router.get('/agenda', (req, res) => {
    const shop = shopId(req);
    const date = typeof req.query.date === 'string' && isDate(req.query.date) ? req.query.date : shopNow(shop).date;
    const blocks = all(
      `SELECT k.id, k.barber_id, k.starts_at, k.ends_at, k.reason FROM barber_blocks k JOIN barbers b ON b.id = k.barber_id
        WHERE b.barbershop_id = ? AND k.starts_at < ? AND k.ends_at > ?`,
      [shop, `${addDays(date, 1)} 00:00`, `${date} 00:00`],
    );
    const appointments = dayAgenda(shop, date).map((a) => ({
      ...a,
      items: reservedItems(a.id),
      sale: get<{ id: number; total_cents: number; method: string }>("SELECT id, total_cents, method FROM sales WHERE appointment_id = ? AND status = 'closed'", [a.id]) ?? null,
    }));
    res.json({ date, barbers: barbersWithHours(shop).filter((b) => b.active), appointments, blocks });
  });

  router.get('/availability', (req, res) => {
    const date = String(req.query.date ?? '');
    const num = (v: unknown) => (v ? Number(v) : null);
    res.json(freeTimes(shopId(req), date, { barberId: num(req.query.barber_id), serviceId: num(req.query.service_id), leadMin: 0 }));
  });

  router.post('/appointments', (req, res) => {
    const body = parseBody(
      z.object({
        customer_id: zId,
        barber_id: zId,
        service_id: zId.nullish(),
        date: zDay,
        time: zTime,
        notes: zText(300),
      }),
      req.body,
    );
    const a = book({
      shopId: shopId(req),
      customerId: body.customer_id,
      barberId: body.barber_id,
      serviceId: body.service_id,
      date: body.date,
      time: body.time,
      notes: body.notes,
      source: 'painel',
    });
    res.status(201).json(a);
  });

  router.post('/appointments/:id/cancel', (req, res) => {
    res.json(cancel(shopId(req), idParam(req)));
  });

  /** Falta (no_show) ou desfazer a falta. */
  router.post('/appointments/:id/status', (req, res) => {
    const { status } = parseBody(z.object({ status: z.enum(['scheduled', 'no_show']) }), req.body);
    const { changes } = run("UPDATE appointments SET status = ? WHERE id = ? AND barbershop_id = ? AND status <> 'cancelled'", [
      status,
      idParam(req),
      shopId(req),
    ]);
    if (!changes) throw new HttpError(404, 'Horário não encontrado.');
    res.json({ ok: true });
  });

  /** Costume e próximos horários do cliente (usado no Balcão). */
  router.get('/customers/:id/agenda', (req, res) => {
    const id = idParam(req);
    if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ?', [id, shopId(req)])) throw new HttpError(404, 'Cliente não encontrado.');
    res.json({ habit: customerHabit(id), upcoming: upcomingFor(id) });
  });
}
