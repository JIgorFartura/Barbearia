import { all, get } from './db.js';
import { customerNow, customerTz, shopNow, shopTz } from './clock.js';
import { addDays, daysBetween, fromMinutes, isoToLocal, toMinutes, weekdayOf } from './time.js';

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

/** Mediana dos intervalos, em dias, entre datas distintas em ordem (null se só há uma). */
function medianGap(dates: string[]): number | null {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d)).sort((a, b) => a - b);
  if (!gaps.length) return null;
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

/** De quantos em quantos dias (mediana dos intervalos entre visitas, entre 7 e 60). */
export function typicalInterval(visits: Visit[]): number {
  const dates = [...new Set(visits.map((v) => v.starts_at.slice(0, 10)))].sort();
  return clamp(medianGap(dates) ?? 7, 7, 60);
}

/**
 * Ritmo do cliente: de quantos em quantos dias ele volta, pelas últimas 10 visitas. Só com 3 visitas
 * ou mais (com 2, um retorno para retoque já distorceria); entre 7 e 60 dias.
 */
export function rhythmDays(days: string[]): number | null {
  const dates = [...new Set(days)].sort().slice(-10);
  return dates.length < 3 ? null : clamp(medianGap(dates)!, 7, 60);
}

/**
 * Com quantos dias sem vir o cliente vira "sumido" e o robô chama: bem depois do ritmo dele (metade a
 * mais, pelo menos uma semana de atraso); sem ritmo conhecido, o prazo da barbearia.
 */
export const awayAfter = (rhythm: number | null, shopDays: number): number => (rhythm ? Math.max(Math.ceil(rhythm * 1.5), rhythm + 7) : shopDays);

/**
 * Dias (data local) em que cada cliente da barbearia esteve lá desde `since`, em ordem: horário
 * atendido, venda fechada no balcão ou carimbo do cartão fidelidade.
 */
export function shopVisitDays(shopId: number, since: string, now?: Date): Map<number, string[]> {
  const n = shopNow(shopId, now);
  const tz = shopTz(shopId);
  const days = new Map<number, Set<string>>();
  const add = (customerId: number, day: string) => {
    if (day < since || day > n.date) return;
    days.set(customerId, (days.get(customerId) ?? new Set()).add(day));
  };
  for (const r of all<{ customer_id: number; day: string }>(
    `SELECT customer_id, substr(starts_at, 1, 10) AS day FROM appointments
      WHERE barbershop_id = :shop AND status = 'scheduled' AND starts_at < :now AND starts_at >= :since
     UNION
     SELECT customer_id, date AS day FROM sales
      WHERE barbershop_id = :shop AND status = 'closed' AND customer_id IS NOT NULL AND date >= :since`,
    { shop: shopId, now: n.stamp, since },
  )) {
    add(r.customer_id, r.day);
  }
  // Carimbo é gravado em UTC: um dia de folga na busca e a data local de cada um.
  const fromIso = new Date(Date.parse(`${since}T00:00:00Z`) - 86400000).toISOString();
  for (const r of all<{ customer_id: number; created_at: string }>(
    'SELECT l.customer_id, l.created_at FROM loyalty_events l JOIN customers c ON c.id = l.customer_id WHERE c.barbershop_id = ? AND l.created_at >= ?',
    [shopId, fromIso],
  )) {
    add(r.customer_id, isoToLocal(r.created_at, tz).slice(0, 10));
  }
  return new Map([...days].map(([id, set]) => [id, [...set].sort()]));
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
  const today = customerNow(customerId, now);
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
      customerNow(customerId, now).stamp,
    ])?.at?.slice(0, 10) ?? null;
  const loyalty = get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM loyalty_events WHERE customer_id = ?', [customerId])?.at;
  const fromLoyalty = loyalty ? isoToLocal(loyalty, customerTz(customerId)).slice(0, 10) : null;
  if (!appt) return fromLoyalty;
  if (!fromLoyalty) return appt;
  return appt > fromLoyalty ? appt : fromLoyalty;
}
