import { all, get } from './db.js';
import { addDays, daysBetween, fromMinutes, isoToLocal, localNow, toMinutes, weekdayOf } from './time.js';

/** Dia e hora em que o cliente costuma vir: informado por ele ou descoberto pelo histórico. */
export interface Habit {
  weekday: number;
  time: string;
  barberId: number | null;
  serviceId: number | null;
  /** De quantos em quantos dias ele costuma vir. */
  intervalDays: number;
  source: 'cliente' | 'automatico';
}

export interface Visit {
  /** "AAAA-MM-DD HH:MM" */
  starts_at: string;
  barber_id: number | null;
  service_id: number | null;
}

/** Valor mais frequente; empate fica com o que apareceu primeiro na lista (a mais recente). */
function mode<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const v of values) {
    const c = counts.get(v)!;
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** De quantos em quantos dias (mediana dos intervalos entre visitas, entre 7 e 60). */
export function typicalInterval(visits: Visit[]): number {
  const dates = [...new Set(visits.map((v) => v.starts_at.slice(0, 10)))].sort();
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d)).sort((a, b) => a - b);
  if (!gaps.length) return 7;
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
  return clamp(median, 7, 60);
}

/**
 * Descobre o costume pelas últimas visitas (mais recentes primeiro): precisa de pelo menos
 * 2 visitas no mesmo dia da semana e que esse dia seja 40% ou mais das visitas.
 */
export function inferHabit(visits: Visit[]): Habit | null {
  const recent = visits.slice(0, 10);
  if (recent.length < 2) return null;
  const weekday = mode(recent.map((v) => weekdayOf(v.starts_at.slice(0, 10))))!;
  const sameDay = recent.filter((v) => weekdayOf(v.starts_at.slice(0, 10)) === weekday);
  if (sameDay.length < 2 || sameDay.length / recent.length < 0.4) return null;
  const halfHour = (stamp: string) => fromMinutes(Math.round(toMinutes(stamp.slice(11)) / 30) * 30);
  return {
    weekday,
    time: mode(sameDay.map((v) => halfHour(v.starts_at)))!,
    barberId: mode(sameDay.map((v) => v.barber_id)),
    serviceId: mode(sameDay.map((v) => v.service_id)),
    intervalDays: typicalInterval(recent),
    source: 'automatico',
  };
}

/** Visitas dos últimos 180 dias (horários que não foram cancelados nem marcados como falta). */
export function pastVisits(customerId: number, now?: Date): Visit[] {
  const today = localNow(now);
  return all<Visit>(
    `SELECT starts_at, barber_id, service_id FROM appointments
      WHERE customer_id = ? AND status = 'scheduled' AND starts_at < ? AND starts_at >= ?
      ORDER BY starts_at DESC`,
    [customerId, today.stamp, `${addDays(today.date, -180)} 00:00`],
  );
}

interface PrefRow {
  pref_weekday: number | null;
  pref_time: string | null;
  pref_barber_id: number | null;
  pref_service_id: number | null;
  pref_interval_days: number | null;
}

export function customerHabit(customerId: number, now?: Date): Habit | null {
  const pref = get<PrefRow>('SELECT pref_weekday, pref_time, pref_barber_id, pref_service_id, pref_interval_days FROM customers WHERE id = ?', [customerId]);
  const visits = pastVisits(customerId, now);
  if (pref && pref.pref_weekday != null && pref.pref_time) {
    return {
      weekday: pref.pref_weekday,
      time: pref.pref_time,
      barberId: pref.pref_barber_id,
      serviceId: pref.pref_service_id,
      intervalDays: pref.pref_interval_days ?? 7,
      source: 'cliente',
    };
  }
  return inferHabit(visits);
}

/** Última vez que o cliente esteve na barbearia (horário atendido ou consumo lançado no balcão), data local. */
export function lastVisitDate(customerId: number, now?: Date): string | null {
  const appt =
    get<{ at: string | null }>("SELECT MAX(starts_at) AS at FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at < ?", [
      customerId,
      localNow(now).stamp,
    ])?.at?.slice(0, 10) ?? null;
  const loyalty = get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM loyalty_events WHERE customer_id = ?', [customerId])?.at;
  const fromLoyalty = loyalty ? isoToLocal(loyalty).slice(0, 10) : null;
  if (!appt) return fromLoyalty;
  if (!fromLoyalty) return appt;
  return appt > fromLoyalty ? appt : fromLoyalty;
}
