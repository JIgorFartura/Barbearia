import { shopNow } from './clock.js';
import { all, get } from './db.js';
import { addDays, daysBetween, toMinutes, weekdayOf } from './time.js';

/**
 * Indicadores da barbearia para o dono (relatórios, gerente virtual no WhatsApp e resumo da semana):
 * quanto entrou, ocupação da agenda (por barbeiro e por dia/hora), retorno dos clientes e previsão do
 * mês. Visita = horário atendido ou compra no balcão com o cliente identificado.
 */

const sum = (sql: string, params: unknown[]) => get<{ v: number | null }>(sql, params)?.v ?? 0;

/** Dinheiro que entrou (vendas, clube e outras entradas pagas) entre as datas, inclusive. */
export const incomeBetween = (shopId: number, from: string, to: string) =>
  sum("SELECT SUM(amount_cents) AS v FROM cash_entries WHERE barbershop_id = ? AND type = 'in' AND status = 'paid' AND date >= ? AND date <= ?", [shopId, from, to]);

export interface PeriodNumbers {
  from: string;
  to: string;
  income: number;
  sales: number;
  services: number;
  /** Ticket médio das vendas (centavos). */
  average: number;
}

export function periodNumbers(shopId: number, from: string, to: string): PeriodNumbers {
  const s = get<{ n: number; total: number | null }>("SELECT COUNT(*) AS n, SUM(total_cents) AS total FROM sales WHERE barbershop_id = ? AND status = 'closed' AND date >= ? AND date <= ?", [
    shopId,
    from,
    to,
  ])!;
  const services = sum(
    "SELECT SUM(i.qty) AS v FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.barbershop_id = ? AND s.status = 'closed' AND i.kind = 'service' AND s.date >= ? AND s.date <= ?",
    [shopId, from, to],
  );
  return { from, to, income: incomeBetween(shopId, from, to), sales: s.n, services, average: s.n ? Math.round((s.total ?? 0) / s.n) : 0 };
}

// ---------- ocupação da agenda

interface Range {
  start: number;
  end: number;
}

const overlap = (a: Range, b: Range) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Tira os trechos `cut` de `ranges`. */
function subtract(ranges: Range[], cut: Range[]): Range[] {
  let out = ranges;
  for (const c of cut) {
    out = out.flatMap((r) => {
      if (c.end <= r.start || c.start >= r.end) return [r];
      const parts: Range[] = [];
      if (c.start > r.start) parts.push({ start: r.start, end: c.start });
      if (c.end < r.end) parts.push({ start: c.end, end: r.end });
      return parts;
    });
  }
  return out;
}

export interface Occupancy {
  /** Fração da agenda aberta que foi marcada (null = nenhum horário aberto no período). */
  rate: number | null;
  open_min: number;
  booked_min: number;
  byBarber: { id: number; name: string; rate: number | null; open_min: number; booked_min: number }[];
  /** Mapa de calor: dia da semana (0 = domingo) × hora, só onde houve agenda aberta. */
  heat: { weekday: number; hour: number; open_min: number; booked_min: number }[];
}

/** Ocupação da agenda: tempo marcado (horários não cancelados) sobre o tempo aberto (expediente menos bloqueios). */
export function occupancy(shopId: number, from: string, to: string): Occupancy {
  const barbers = all<{ id: number; name: string }>('SELECT id, name FROM barbers WHERE barbershop_id = ? AND active = 1 ORDER BY name COLLATE NOCASE', [shopId]);
  const hours = all<{ barber_id: number; weekday: number; start_time: string; end_time: string }>(
    'SELECT h.barber_id, h.weekday, h.start_time, h.end_time FROM barber_hours h JOIN barbers b ON b.id = h.barber_id WHERE b.barbershop_id = ?',
    [shopId],
  );
  const start = `${from} 00:00`;
  const end = `${addDays(to, 1)} 00:00`;
  const blocks = all<{ barber_id: number; starts_at: string; ends_at: string }>(
    'SELECT k.barber_id, k.starts_at, k.ends_at FROM barber_blocks k JOIN barbers b ON b.id = k.barber_id WHERE b.barbershop_id = ? AND k.starts_at < ? AND k.ends_at > ?',
    [shopId, end, start],
  );
  const appts = all<{ barber_id: number; starts_at: string; ends_at: string }>(
    "SELECT barber_id, starts_at, ends_at FROM appointments WHERE barbershop_id = ? AND status <> 'cancelled' AND starts_at < ? AND ends_at > ?",
    [shopId, end, start],
  );
  /** Trecho do dia (minutos) ocupado por um intervalo "AAAA-MM-DD HH:MM". */
  const clip = (date: string, s: string, e: string): Range => ({
    start: s.slice(0, 10) < date ? 0 : s.slice(0, 10) > date ? 24 * 60 : toMinutes(s.slice(11)),
    end: e.slice(0, 10) > date ? 24 * 60 : e.slice(0, 10) < date ? 0 : toMinutes(e.slice(11)),
  });
  const heat = new Map<string, { weekday: number; hour: number; open_min: number; booked_min: number }>();
  const byBarber = barbers.map((b) => ({ ...b, open_min: 0, booked_min: 0 }));
  const days = Math.min(daysBetween(from, to) + 1, 400);
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const wd = weekdayOf(date);
    const dayStart = `${date} 00:00`;
    const dayEnd = `${addDays(date, 1)} 00:00`;
    for (const b of byBarber) {
      const work = hours.filter((h) => h.barber_id === b.id && h.weekday === wd).map((h) => ({ start: toMinutes(h.start_time), end: toMinutes(h.end_time) }));
      if (!work.length) continue;
      const open = subtract(
        work,
        blocks.filter((k) => k.barber_id === b.id && k.starts_at < dayEnd && k.ends_at > dayStart).map((k) => clip(date, k.starts_at, k.ends_at)),
      );
      const booked = appts.filter((a) => a.barber_id === b.id && a.starts_at < dayEnd && a.ends_at > dayStart).map((a) => clip(date, a.starts_at, a.ends_at));
      for (let h = 0; h < 24; h++) {
        const slot = { start: h * 60, end: h * 60 + 60 };
        const o = open.reduce((s, r) => s + overlap(r, slot), 0);
        if (!o) continue;
        // Só conta o que foi marcado dentro da agenda aberta (encaixe fora do expediente não infla a ocupação).
        const bk = Math.min(
          o,
          open.reduce((s, r) => {
            const inOpen = { start: Math.max(r.start, slot.start), end: Math.min(r.end, slot.end) };
            return inOpen.end > inOpen.start ? s + booked.reduce((t, a) => t + overlap(a, inOpen), 0) : s;
          }, 0),
        );
        b.open_min += o;
        b.booked_min += bk;
        const key = `${wd}:${h}`;
        const cell = heat.get(key) ?? { weekday: wd, hour: h, open_min: 0, booked_min: 0 };
        cell.open_min += o;
        cell.booked_min += bk;
        heat.set(key, cell);
      }
    }
  }
  const rate = (booked: number, open: number) => (open ? booked / open : null);
  const open_min = byBarber.reduce((s, b) => s + b.open_min, 0);
  const booked_min = byBarber.reduce((s, b) => s + b.booked_min, 0);
  return {
    rate: rate(booked_min, open_min),
    open_min,
    booked_min,
    byBarber: byBarber.map((b) => ({ ...b, rate: rate(b.booked_min, b.open_min) })),
    heat: [...heat.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
  };
}

// ---------- retorno dos clientes

/** Dias de visita por cliente (horário atendido ou compra identificada), em ordem. */
function visitDays(shopId: number, sinceDate: string, todayStamp: string): Map<number, string[]> {
  const rows = all<{ customer_id: number; day: string }>(
    `SELECT customer_id, day FROM (
        SELECT customer_id, substr(starts_at, 1, 10) AS day FROM appointments
         WHERE barbershop_id = :shop AND status = 'scheduled' AND starts_at < :now AND starts_at >= :since
        UNION
        SELECT customer_id, date AS day FROM sales
         WHERE barbershop_id = :shop AND status = 'closed' AND customer_id IS NOT NULL AND date >= :since AND date <= :today
      ) ORDER BY customer_id, day`,
    { shop: shopId, now: todayStamp, since: sinceDate, today: todayStamp.slice(0, 10) },
  );
  const map = new Map<number, string[]>();
  for (const r of rows) map.set(r.customer_id, [...(map.get(r.customer_id) ?? []), r.day]);
  return map;
}

export interface Retention {
  /** Clientes atendidos nos últimos 90 dias. */
  active: number;
  /** Primeira visita neste mês. */
  newThisMonth: number;
  /** Dos que vieram entre 90 e 45 dias atrás, quantos voltaram em até 45 dias. */
  cohort: number;
  returned: number;
  returnRate: number | null;
  /** Intervalo médio entre visitas (dias), de quem veio mais de uma vez no último ano. */
  avgInterval: number | null;
  /** Passaram bem do ritmo deles e ainda não marcaram (antes de virarem "sumidos"). */
  atRisk: { id: number; name: string; phone: string; days: number; interval: number }[];
  /** Não vêm há mais que o prazo do "cliente sumido" da barbearia. */
  away: number;
}

export function retention(shopId: number, now: Date = new Date()): Retention {
  const n = shopNow(shopId, now);
  const today = n.date;
  const winback = get<{ winback_days: number }>('SELECT winback_days FROM barbershops WHERE id = ?', [shopId])?.winback_days ?? 45;
  const visits = visitDays(shopId, addDays(today, -365), n.stamp);
  const firsts = new Map(
    all<{ customer_id: number; first: string }>(
      `SELECT customer_id, MIN(day) AS first FROM (
          SELECT customer_id, substr(starts_at, 1, 10) AS day FROM appointments WHERE barbershop_id = :shop AND status = 'scheduled' AND starts_at < :now
          UNION ALL
          SELECT customer_id, date AS day FROM sales WHERE barbershop_id = :shop AND status = 'closed' AND customer_id IS NOT NULL
        ) GROUP BY customer_id`,
      { shop: shopId, now: n.stamp },
    ).map((r) => [r.customer_id, r.first]),
  );
  const upcoming = new Set(
    all<{ customer_id: number }>("SELECT DISTINCT customer_id FROM appointments WHERE barbershop_id = ? AND status = 'scheduled' AND starts_at >= ?", [shopId, n.stamp]).map(
      (r) => r.customer_id,
    ),
  );
  const people = new Map(
    all<{ id: number; name: string; phone: string }>('SELECT id, name, phone FROM customers WHERE barbershop_id = ? AND anonymized_at IS NULL', [shopId]).map((c) => [c.id, c]),
  );
  const d90 = addDays(today, -90);
  const d45 = addDays(today, -45);
  let active = 0;
  let cohort = 0;
  let returned = 0;
  let gaps = 0;
  let gapCount = 0;
  let away = 0;
  const atRisk: Retention['atRisk'] = [];
  for (const [id, days] of visits) {
    const person = people.get(id);
    if (!person) continue;
    const last = days[days.length - 1];
    if (last >= d90) active++;
    // Coorte: primeira visita da janela entre 90 e 45 dias atrás; voltou se veio de novo em até 45 dias.
    const inWindow = days.find((d) => d >= d90 && d < d45);
    if (inWindow) {
      cohort++;
      if (days.some((d) => d > inWindow && daysBetween(inWindow, d) <= 45)) returned++;
    }
    for (let i = 1; i < days.length; i++) {
      gaps += daysBetween(days[i - 1], days[i]);
      gapCount++;
    }
    const since = daysBetween(last, today);
    if (upcoming.has(id)) continue;
    if (since >= winback) {
      away++;
      continue;
    }
    // Ritmo do cliente: mediana dos intervalos dele (pelo menos 2 visitas); sem isso, 30 dias.
    const own = days.slice(1).map((d, i) => daysBetween(days[i], d)).sort((a, b) => a - b);
    const interval = own.length ? own[Math.floor(own.length / 2)] : 30;
    if (since > Math.max(interval * 1.5, interval + 7)) atRisk.push({ id, name: person.name, phone: person.phone, days: since, interval });
  }
  const monthStart = `${today.slice(0, 8)}01`;
  let newThisMonth = 0;
  for (const [id, first] of firsts) if (first >= monthStart && people.has(id)) newThisMonth++;
  return {
    active,
    newThisMonth,
    cohort,
    returned,
    returnRate: cohort ? returned / cohort : null,
    avgInterval: gapCount ? Math.round(gaps / gapCount) : null,
    atRisk: atRisk.sort((a, b) => b.days - b.interval - (a.days - a.interval)).slice(0, 30),
    away,
  };
}

// ---------- previsão do mês

export interface Forecast {
  month: string;
  /** Entrou até hoje. */
  soFar: number;
  /** Horários marcados daqui até o fim do mês (valor do serviço). */
  scheduled: number;
  /** Média por dia do que entra sem horário marcado (balcão, produtos, clube), nos últimos 28 dias. */
  extraPerDay: number;
  daysLeft: number;
  projected: number;
  /** Mês passado: até o mesmo dia e o total. */
  lastMonthSamePoint: number;
  lastMonthTotal: number;
}

export function monthForecast(shopId: number, now: Date = new Date()): Forecast {
  const n = shopNow(shopId, now);
  const today = n.date;
  const monthStart = `${today.slice(0, 8)}01`;
  const nextMonth = addDays(monthStart, 32).slice(0, 8) + '01';
  const monthEnd = addDays(nextMonth, -1);
  const soFar = incomeBetween(shopId, monthStart, today);
  const scheduled = sum(
    "SELECT SUM(price_cents) AS v FROM appointments WHERE barbershop_id = ? AND status = 'scheduled' AND starts_at >= ? AND starts_at < ?",
    [shopId, n.stamp, `${nextMonth} 00:00`],
  );
  const from28 = addDays(today, -28);
  const income28 = incomeBetween(shopId, from28, addDays(today, -1));
  const fromAppointments = sum(
    "SELECT SUM(total_cents) AS v FROM sales WHERE barbershop_id = ? AND status = 'closed' AND appointment_id IS NOT NULL AND date >= ? AND date <= ?",
    [shopId, from28, addDays(today, -1)],
  );
  const extraPerDay = Math.max(0, Math.round((income28 - fromAppointments) / 28));
  const daysLeft = daysBetween(today, monthEnd);
  const lastStart = addDays(monthStart, -1).slice(0, 8) + '01';
  const lastEnd = addDays(monthStart, -1);
  const samePoint = `${lastStart.slice(0, 8)}${today.slice(8, 10)}`;
  return {
    month: today.slice(0, 7),
    soFar,
    scheduled,
    extraPerDay,
    daysLeft,
    projected: soFar + scheduled + extraPerDay * daysLeft,
    lastMonthSamePoint: incomeBetween(shopId, lastStart, samePoint < lastEnd ? samePoint : lastEnd),
    lastMonthTotal: incomeBetween(shopId, lastStart, lastEnd),
  };
}

// ---------- resumo da semana

export interface WeekSummary {
  from: string;
  to: string;
  current: PeriodNumbers;
  previous: PeriodNumbers;
  occupancy: number | null;
  noShows: number;
  /** Horários vazios preenchidos com o desconto. */
  idleFilled: number;
  newCustomers: number;
  rating: { n: number; avg: number | null };
  topBarber: { name: string; services: number } | null;
  /** Horários já marcados para a semana que começa. */
  nextWeekBooked: number;
}

/** Semana de segunda (`from`) a domingo. */
export function weekSummary(shopId: number, from: string): WeekSummary {
  const to = addDays(from, 6);
  const top = get<{ name: string; services: number }>(
    `SELECT b.name, SUM(i.qty) AS services FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN barbers b ON b.id = i.barber_id
      WHERE s.barbershop_id = ? AND s.status = 'closed' AND i.kind = 'service' AND s.date >= ? AND s.date <= ? GROUP BY b.id ORDER BY services DESC LIMIT 1`,
    [shopId, from, to],
  );
  const firstVisits = all<{ first: string }>(
    `SELECT MIN(day) AS first FROM (
        SELECT customer_id, substr(starts_at, 1, 10) AS day FROM appointments WHERE barbershop_id = :shop AND status = 'scheduled' AND starts_at < :end
        UNION ALL
        SELECT customer_id, date AS day FROM sales WHERE barbershop_id = :shop AND status = 'closed' AND customer_id IS NOT NULL AND date <= :to
      ) GROUP BY customer_id`,
    { shop: shopId, end: `${addDays(to, 1)} 00:00`, to },
  );
  const rating = get<{ n: number; avg: number | null }>(
    'SELECT COUNT(rating) AS n, ROUND(AVG(rating), 1) AS avg FROM reviews WHERE barbershop_id = ? AND answered_at >= ? AND answered_at < ?',
    [shopId, `${from}T00:00`, `${addDays(to, 2)}T00:00`],
  )!;
  return {
    from,
    to,
    current: periodNumbers(shopId, from, to),
    previous: periodNumbers(shopId, addDays(from, -7), addDays(from, -1)),
    occupancy: occupancy(shopId, from, to).rate,
    noShows: sum("SELECT COUNT(*) AS v FROM appointments WHERE barbershop_id = ? AND status = 'no_show' AND starts_at >= ? AND starts_at < ?", [
      shopId,
      `${from} 00:00`,
      `${addDays(to, 1)} 00:00`,
    ]),
    idleFilled: sum(
      "SELECT COUNT(*) AS v FROM appointments WHERE barbershop_id = ? AND status <> 'cancelled' AND promo_percent IS NOT NULL AND starts_at >= ? AND starts_at < ?",
      [shopId, `${from} 00:00`, `${addDays(to, 1)} 00:00`],
    ),
    newCustomers: firstVisits.filter((v) => v.first >= from && v.first <= to).length,
    rating,
    topBarber: top ?? null,
    nextWeekBooked: sum("SELECT COUNT(*) AS v FROM appointments WHERE barbershop_id = ? AND status = 'scheduled' AND starts_at >= ? AND starts_at < ?", [
      shopId,
      `${addDays(to, 1)} 00:00`,
      `${addDays(to, 8)} 00:00`,
    ]),
  };
}
