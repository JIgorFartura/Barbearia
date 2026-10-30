import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { customerNow, shopNow } from './clock.js';
import { availableComeback, useComeback } from './comeback.js';
import { discounted, idleDiscount } from './promo.js';
import { notifyBooked, notifyCancelled } from './push.js';
import { addDays, addMinutes, fromMinutes, isDate, isTime, toMinutes, weekdayOf } from './time.js';

export const DEFAULT_DURATION = 30;
/** Antecedência mínima para o cliente/robô marcar. */
export const CUSTOMER_LEAD_MIN = 30;
/** Quantos horários futuros um cliente pode ter ao mesmo tempo (site ou WhatsApp). */
export const CUSTOMER_MAX_UPCOMING = 2;

export type Source = 'painel' | 'cliente' | 'whatsapp';

export interface Barber {
  id: number;
  name: string;
  photo_url: string | null;
  active: number;
}

export interface Service {
  id: number;
  name: string;
  price_cents: number;
  duration_min: number | null;
}

export interface AppointmentView {
  id: number;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  barber_id: number;
  barber_name: string;
  service_id: number | null;
  service_name: string;
  price_cents: number;
  starts_at: string;
  ends_at: string;
  status: 'scheduled' | 'cancelled' | 'no_show';
  source: Source;
  notes: string | null;
  /** O cliente confirmou a presença (resposta ao lembrete, área do cliente ou o dono marcou). */
  confirmed_at: string | null;
  /** Desconto do horário (o preço já sai com ele): do horário vazio ou de volta (recontato). */
  promo_percent: number | null;
  promo_kind: 'vazio' | 'volta' | null;
}

const APPOINTMENT_SELECT = `
  SELECT a.id, a.customer_id, c.name AS customer_name, c.phone AS customer_phone, a.barber_id, b.name AS barber_name,
         a.service_id, a.service_name, a.price_cents, a.starts_at, a.ends_at, a.status, a.source, a.notes, a.confirmed_at, a.promo_percent,
         a.promo_kind
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    JOIN barbers b ON b.id = a.barber_id`;

export function appointment(id: number): AppointmentView | undefined {
  return get<AppointmentView>(`${APPOINTMENT_SELECT} WHERE a.id = ?`, [id]);
}

export function activeBarbers(shopId: number): Barber[] {
  return all<Barber>('SELECT id, name, photo_url, active FROM barbers WHERE barbershop_id = ? AND active = 1 ORDER BY name COLLATE NOCASE', [shopId]);
}

export function services(shopId: number): Service[] {
  return all<Service>(
    "SELECT id, name, price_cents, duration_min FROM catalog_items WHERE barbershop_id = ? AND kind = 'service' AND active = 1 ORDER BY name COLLATE NOCASE",
    [shopId],
  );
}

/** Serviço escolhido ou, sem escolha, o primeiro "corte" (ou o primeiro serviço) da barbearia. */
export function resolveService(shopId: number, serviceId: number | null | undefined): Service | null {
  if (serviceId) {
    const s = get<Service>("SELECT id, name, price_cents, duration_min FROM catalog_items WHERE id = ? AND barbershop_id = ? AND kind = 'service'", [
      serviceId,
      shopId,
    ]);
    if (!s) throw new HttpError(404, 'Serviço não encontrado.');
    return s;
  }
  const list = services(shopId);
  return list.find((s) => /^corte/i.test(s.name)) ?? list[0] ?? null;
}

const durationOf = (service: Service | null) => service?.duration_min || DEFAULT_DURATION;

interface Range {
  start: number;
  end: number;
}

function workRanges(barberId: number, date: string): Range[] {
  return all<{ start_time: string; end_time: string }>('SELECT start_time, end_time FROM barber_hours WHERE barber_id = ? AND weekday = ?', [
    barberId,
    weekdayOf(date),
  ]).map((r) => ({ start: toMinutes(r.start_time), end: toMinutes(r.end_time) }));
}

/** Horários ocupados no dia (agendamentos e bloqueios), em minutos desde 00:00. */
function busyRanges(barberId: number, date: string, ignoreAppointmentId = 0): Range[] {
  const dayStart = `${date} 00:00`;
  const dayEnd = `${addDays(date, 1)} 00:00`;
  const clip = (stamp: string, fallback: number) => (stamp.slice(0, 10) === date ? toMinutes(stamp.slice(11)) : fallback);
  const appts = all<{ starts_at: string; ends_at: string }>(
    "SELECT starts_at, ends_at FROM appointments WHERE barber_id = ? AND status = 'scheduled' AND starts_at < ? AND ends_at > ? AND id <> ?",
    [barberId, dayEnd, dayStart, ignoreAppointmentId],
  );
  const blocks = all<{ starts_at: string; ends_at: string }>('SELECT starts_at, ends_at FROM barber_blocks WHERE barber_id = ? AND starts_at < ? AND ends_at > ?', [
    barberId,
    dayEnd,
    dayStart,
  ]);
  return [...appts, ...blocks].map((r) => ({
    start: r.starts_at < dayStart ? 0 : clip(r.starts_at, 0),
    end: r.ends_at >= dayEnd ? 24 * 60 : clip(r.ends_at, 24 * 60),
  }));
}

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

interface FreeOptions {
  durationMin: number;
  /** Não oferecer horários antes deste momento ("AAAA-MM-DD HH:MM"). */
  notBefore: string;
  /** Ignora o expediente (encaixe feito pelo dono). */
  ignoreHours?: boolean;
  ignoreAppointmentId?: number;
}

export function isFree(barberId: number, date: string, time: string, opts: FreeOptions): boolean {
  if (`${date} ${time}` < opts.notBefore) return false;
  const slot = { start: toMinutes(time), end: toMinutes(time) + opts.durationMin };
  if (slot.end > 24 * 60) return false;
  if (!opts.ignoreHours && !workRanges(barberId, date).some((w) => w.start <= slot.start && slot.end <= w.end)) return false;
  return !busyRanges(barberId, date, opts.ignoreAppointmentId).some((b) => overlaps(b, slot));
}

export interface FreeDay {
  barber: { id: number; name: string };
  times: string[];
}

/** Horários livres de um dia, por barbeiro, no passo de agenda da barbearia. */
export function freeTimes(shopId: number, date: string, opts: { barberId?: number | null; serviceId?: number | null; now?: Date; leadMin?: number }): FreeDay[] {
  if (!isDate(date)) throw new HttpError(400, 'Data inválida (use AAAA-MM-DD).');
  const step = get<{ slot_step_min: number }>('SELECT slot_step_min FROM barbershops WHERE id = ?', [shopId])?.slot_step_min ?? 30;
  const duration = durationOf(resolveService(shopId, opts.serviceId));
  const notBefore = addMinutes(shopNow(shopId, opts.now).stamp, opts.leadMin ?? CUSTOMER_LEAD_MIN);
  const barbers = activeBarbers(shopId).filter((b) => !opts.barberId || b.id === opts.barberId);
  if (opts.barberId && !barbers.length) throw new HttpError(404, 'Barbeiro não encontrado.');

  return barbers.map((barber) => {
    const busy = busyRanges(barber.id, date);
    const times: string[] = [];
    for (const w of workRanges(barber.id, date).sort((a, b) => a.start - b.start)) {
      for (let t = w.start; t + duration <= w.end; t += step) {
        const time = fromMinutes(t);
        if (`${date} ${time}` < notBefore) continue;
        if (!busy.some((b) => overlaps(b, { start: t, end: t + duration }))) times.push(time);
      }
    }
    return { barber: { id: barber.id, name: barber.name }, times };
  });
}

export interface BookInput {
  shopId: number;
  customerId: number;
  barberId: number;
  serviceId?: number | null;
  date: string;
  time: string;
  source: Source;
  notes?: string | null;
  /**
   * Desconto do horário vazio. Sem informar: vale a regra da barbearia para quem marca no mesmo dia
   * (pela área ou pelo robô; no balcão, o dono dá o desconto na comanda se quiser). A oferta do robô
   * informa o que prometeu. O desconto de volta do recontato entra sozinho em qualquer canal.
   */
  promoPercent?: number | null;
  now?: Date;
}

/** Marca um horário conferindo expediente, conflitos e limites. Tudo numa transação: dois pedidos simultâneos não pegam a mesma vaga. */
export function book(input: BookInput): AppointmentView {
  if (!isDate(input.date) || !isTime(input.time)) throw new HttpError(400, 'Data ou hora inválida.');
  const a = tx(() => {
    const barber = get<Barber>('SELECT id, name, photo_url, active FROM barbers WHERE id = ? AND barbershop_id = ?', [input.barberId, input.shopId]);
    if (!barber || !barber.active) throw new HttpError(404, 'Barbeiro não encontrado.');
    if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ?', [input.customerId, input.shopId])) {
      throw new HttpError(404, 'Cliente não encontrado.');
    }
    const service = resolveService(input.shopId, input.serviceId);
    const duration = durationOf(service);
    const start = `${input.date} ${input.time}`;
    const end = addMinutes(start, duration);
    const clock = shopNow(input.shopId, input.now);
    const now = clock.stamp;
    const byOwner = input.source === 'painel';

    if (!byOwner) {
      const upcoming = get<{ n: number }>("SELECT COUNT(*) AS n FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at >= ?", [
        input.customerId,
        now,
      ])!.n;
      if (upcoming >= CUSTOMER_MAX_UPCOMING) throw new HttpError(409, 'Você já tem horários marcados. Cancele um para marcar outro.');
    }
    const free = isFree(barber.id, input.date, input.time, {
      durationMin: duration,
      notBefore: byOwner ? '0000-00-00 00:00' : addMinutes(now, CUSTOMER_LEAD_MIN),
      ignoreHours: byOwner,
    });
    if (!free) throw new HttpError(409, `${barber.name} não tem esse horário livre.`);
    const clash = get(
      "SELECT 1 AS ok FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at < ? AND ends_at > ?",
      [input.customerId, end, start],
    );
    if (clash) throw new HttpError(409, 'O cliente já tem um horário nesse momento.');

    const idle = (input.promoPercent !== undefined ? input.promoPercent : byOwner ? null : idleDiscount(input.shopId, input.date, input.time, input.now)) || null;
    // Desconto de volta (prometido no recontato): não soma com o do horário vazio, fica o maior.
    const back = availableComeback(input.customerId, clock.date);
    const useBack = back !== null && back.percent > (idle ?? 0);
    const promo = useBack ? back.percent : idle;
    const price = service?.price_cents ?? 0;
    const { lastInsertRowid } = run(
      `INSERT INTO appointments (barbershop_id, customer_id, barber_id, service_id, service_name, price_cents, promo_percent, promo_kind, starts_at, ends_at, source, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.shopId,
        input.customerId,
        barber.id,
        service?.id ?? null,
        service?.name ?? 'Atendimento',
        promo ? discounted(price, promo) : price,
        promo,
        useBack ? 'volta' : promo ? 'vazio' : null,
        start,
        end,
        input.source,
        input.notes ?? null,
        nowIso(),
      ],
    );
    if (useBack) useComeback(back.id, lastInsertRowid);
    // Quem estava na lista de espera desse dia já tem o horário.
    run("UPDATE waitlist SET status = 'booked' WHERE customer_id = ? AND date = ? AND status = 'waiting'", [input.customerId, input.date]);
    return appointment(lastInsertRowid)!;
  });
  // Aviso no celular do barbeiro (e do dono, se não foi ele que marcou).
  void notifyBooked(input.shopId, a, input.source === 'painel').catch((err) => console.error('[aviso no celular]', err));
  return a;
}

/** Cancela. Cliente só cancela os próprios horários futuros; o dono cancela qualquer um da barbearia. */
export function cancel(shopId: number, appointmentId: number, opts: { customerId?: number; now?: Date } = {}): AppointmentView {
  const a = appointment(appointmentId);
  const owned = a && get('SELECT 1 AS ok FROM appointments WHERE id = ? AND barbershop_id = ?', [appointmentId, shopId]);
  if (!a || !owned || (opts.customerId && a.customer_id !== opts.customerId)) throw new HttpError(404, 'Horário não encontrado.');
  if (a.status !== 'scheduled') throw new HttpError(409, 'Esse horário já foi cancelado.');
  if (opts.customerId && a.starts_at < shopNow(shopId, opts.now).stamp) throw new HttpError(409, 'Esse horário já passou.');
  run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [nowIso(), appointmentId]);
  void notifyCancelled(shopId, a, !opts.customerId).catch((err) => console.error('[aviso no celular]', err));
  return appointment(appointmentId)!;
}

export function upcomingFor(customerId: number, now?: Date): AppointmentView[] {
  return all<AppointmentView>(`${APPOINTMENT_SELECT} WHERE a.customer_id = ? AND a.status = 'scheduled' AND a.starts_at >= ? ORDER BY a.starts_at`, [
    customerId,
    customerNow(customerId, now).stamp,
  ]);
}

export function historyFor(customerId: number, now?: Date): AppointmentView[] {
  return all<AppointmentView>(`${APPOINTMENT_SELECT} WHERE a.customer_id = ? AND (a.starts_at < ? OR a.status <> 'scheduled') ORDER BY a.starts_at DESC LIMIT 30`, [
    customerId,
    customerNow(customerId, now).stamp,
  ]);
}

export function dayAgenda(shopId: number, date: string): AppointmentView[] {
  return all<AppointmentView>(`${APPOINTMENT_SELECT} WHERE a.barbershop_id = ? AND a.starts_at >= ? AND a.starts_at < ? ORDER BY a.starts_at`, [
    shopId,
    `${date} 00:00`,
    `${addDays(date, 1)} 00:00`,
  ]);
}

/** Barbeiro pelo nome (sem acento/maiúscula; "paulo" acha "Paulo Henrique"). */
export function findBarberByName(shopId: number, name: string): Barber | undefined {
  const norm = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const target = norm(name);
  const list = activeBarbers(shopId);
  return list.find((b) => norm(b.name) === target) ?? list.find((b) => norm(b.name).startsWith(target));
}
