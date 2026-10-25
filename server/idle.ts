import { shopNow, shopTz } from './clock.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { customerHabit, type Habit } from './habits.js';
import { sendMessage, type ShopBot } from './messaging.js';
import { discounted, idleWindow } from './promo.js';
import { freeTimes, resolveService, type Service } from './scheduling.js';
import { addDays, addMinutes, daysBetween, hourLabel, isoToLocal, toMinutes } from './time.js';

/**
 * Oferta da manhã do horário vazio: nos dias da promoção, a partir das 9h, o robô pega as vagas do dia
 * dentro da faixa e oferece cada uma para um cliente que já está na hora de cortar (pelo ritmo dele),
 * com o barbeiro e o horário mais parecidos com o costume dele. SIM marca com o desconto prometido.
 */

export const IDLE_SEND_FROM = '09:00';
/** No máximo tantas ofertas por barbearia por dia (cada cliente recebe uma vaga diferente). */
export const IDLE_PER_DAY = 10;
/** A vaga oferecida é daqui a pelo menos 2 horas (dá tempo de o cliente se organizar). */
const LEAD_MIN = 120;
/** O mesmo cliente recebe no máximo uma oferta dessas por semana. */
const COOLDOWN_DAYS = 7;
/** Sem costume conhecido, "na hora de cortar" é a partir de 3 semanas. Mais de 90 dias é cliente sumido (outra mensagem). */
const DEFAULT_INTERVAL = 21;
const MAX_DAYS_AWAY = 90;
const OPT_OUT_HINT = '(Para não receber estes avisos, responda PARAR.)';

const firstName = (name: string) => name.split(/\s+/)[0];
const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface Slot {
  barberId: number;
  barberName: string;
  time: string;
}

interface Candidate {
  id: number;
  name: string;
  phone: string;
  wa_id: string | null;
  habit: Habit | null;
  /** Dias além do ritmo dele (quanto maior, mais na hora de voltar). */
  overdue: number;
}

/** Clientes na hora de cortar: sem horário marcado, sem outra oferta valendo e sem oferta de horário vazio na semana. */
function dueCustomers(shopId: number, now: Date): Candidate[] {
  const n = shopNow(shopId, now);
  const tz = shopTz(shopId);
  const rows = all<{ id: number; name: string; phone: string; wa_id: string | null; last_appt: string | null; last_loyalty: string | null }>(
    `SELECT c.id, c.name, c.phone, c.wa_id,
            (SELECT MAX(a.starts_at) FROM appointments a WHERE a.customer_id = c.id AND a.status = 'scheduled' AND a.starts_at < :now) AS last_appt,
            (SELECT MAX(l.created_at) FROM loyalty_events l WHERE l.customer_id = c.id) AS last_loyalty
       FROM customers c
      WHERE c.barbershop_id = :shop AND c.anonymized_at IS NULL AND c.reminders_opt_out = 0
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = c.id AND a.status = 'scheduled' AND a.starts_at >= :now)
        AND NOT EXISTS (SELECT 1 FROM bot_offers o WHERE o.customer_id = c.id AND o.status = 'pending' AND o.starts_at > :now)
        AND NOT EXISTS (SELECT 1 FROM automation_log g WHERE g.customer_id = c.id AND g.kind = 'vazio' AND g.created_at >= :since)`,
    { shop: shopId, now: n.stamp, since: new Date(now.getTime() - COOLDOWN_DAYS * 86400000).toISOString() },
  );
  const out: Candidate[] = [];
  for (const r of rows) {
    const appt = r.last_appt?.slice(0, 10) ?? null;
    const loyalty = r.last_loyalty ? isoToLocal(r.last_loyalty, tz).slice(0, 10) : null;
    const last = appt && loyalty ? (appt > loyalty ? appt : loyalty) : (appt ?? loyalty);
    if (!last) continue;
    const days = daysBetween(last, n.date);
    if (days > MAX_DAYS_AWAY) continue;
    const habit = customerHabit(r.id, now);
    const interval = habit?.intervalDays ?? DEFAULT_INTERVAL;
    if (days < Math.max(7, interval - 3)) continue;
    out.push({ id: r.id, name: r.name, phone: r.phone, wa_id: r.wa_id, habit, overdue: days - interval });
  }
  return out.sort((a, b) => b.overdue - a.overdue);
}

/** A vaga mais parecida com o costume: o barbeiro dele primeiro, depois o horário mais perto do de sempre. */
function bestSlot(pool: Slot[], habit: Habit | null): Slot {
  const score = (s: Slot) => (habit?.barberId === s.barberId ? 0 : 10_000) + (habit ? Math.abs(toMinutes(s.time) - toMinutes(habit.time)) : toMinutes(s.time));
  return pool.reduce((best, s) => (score(s) < score(best) ? s : best));
}

function serviceFor(shopId: number, habit: Habit | null): Service | null {
  try {
    return resolveService(shopId, habit?.serviceId);
  } catch (err) {
    // O serviço de costume saiu do catálogo: oferece o padrão.
    if (err instanceof HttpError) return resolveService(shopId, null);
    throw err;
  }
}

export async function idleOffers(shop: ShopBot, now: Date): Promise<number> {
  const n = shopNow(shop.id, now);
  const w = idleWindow(shop.id, n.date, now);
  if (!w || n.time < IDLE_SEND_FROM || addMinutes(n.stamp, LEAD_MIN) >= `${n.date} ${w.until}`) return 0;
  // Uma rodada por dia.
  if (get("SELECT 1 AS ok FROM automation_log WHERE barbershop_id = ? AND kind = 'vazio_rodada' AND ref = ?", [shop.id, n.date])) return 0;
  run("INSERT INTO automation_log (barbershop_id, customer_id, kind, ref, created_at) VALUES (?, NULL, 'vazio_rodada', ?, ?)", [shop.id, n.date, nowIso()]);

  // Vagas da faixa que ninguém está segurando (outra oferta do robô valendo).
  const held = new Set(
    all<{ barber_id: number; starts_at: string }>("SELECT barber_id, starts_at FROM bot_offers WHERE barbershop_id = ? AND status = 'pending' AND starts_at > ?", [
      shop.id,
      n.stamp,
    ]).map((o) => `${o.barber_id} ${o.starts_at}`),
  );
  const pool: Slot[] = freeTimes(shop.id, n.date, { now, leadMin: LEAD_MIN }).flatMap((d) =>
    d.times
      .filter((t) => t >= w.from && t < w.until && !held.has(`${d.barber.id} ${n.date} ${t}`))
      .map((time) => ({ barberId: d.barber.id, barberName: d.barber.name, time })),
  );
  if (!pool.length) return 0;

  let sent = 0;
  for (const c of dueCustomers(shop.id, now)) {
    if (sent >= IDLE_PER_DAY || !pool.length) break;
    const slot = bestSlot(pool, c.habit);
    pool.splice(pool.indexOf(slot), 1);
    const service = serviceFor(shop.id, c.habit);
    run("UPDATE bot_offers SET status = 'expired' WHERE customer_id = ? AND status = 'pending'", [c.id]);
    run("INSERT INTO bot_offers (barbershop_id, customer_id, barber_id, service_id, starts_at, kind, discount_percent, created_at) VALUES (?, ?, ?, ?, ?, 'vazio', ?, ?)", [
      shop.id,
      c.id,
      slot.barberId,
      service?.id ?? null,
      `${n.date} ${slot.time}`,
      w.percent,
      nowIso(),
    ]);
    run("INSERT INTO automation_log (barbershop_id, customer_id, kind, ref, created_at) VALUES (?, ?, 'vazio', ?, ?)", [shop.id, c.id, n.date, nowIso()]);
    const price = service
      ? `o ${service.name.toLowerCase()} sai por *${money(discounted(service.price_cents, w.percent))}* (em vez de ${money(service.price_cents)})`
      : `o serviço sai com ${w.percent}% de desconto`;
    await sendMessage({
      shop,
      customerId: c.id,
      phone: c.phone,
      waId: c.wa_id,
      kind: 'vazio',
      text: `Oi, ${firstName(c.name)}! Aqui é o ${shop.bot_name}, da ${shop.name}. 💈 Hoje tem horário livre às *${hourLabel(slot.time)}* com ${slot.barberName} e, marcando hoje, ${price}. Quer? Responda *SIM* que eu marco pra você.\n${OPT_OUT_HINT}`,
      template: { kind: 'vazio', params: [firstName(c.name), shop.name, `hoje às ${hourLabel(slot.time)}`, slot.barberName, `${w.percent}%`] },
    });
    sent++;
  }
  return sent;
}

/** Quanto a promoção trouxe no mês: horários marcados com o desconto (sem os cancelados) e o valor deles. */
export function idleStats(shopId: number, now: Date = new Date()): { month: string; booked: number; revenue_cents: number; offers: number } {
  const today = shopNow(shopId, now).date;
  const from = `${today.slice(0, 8)}01`;
  const to = addDays(from, 40).slice(0, 8) + '01';
  const r = get<{ n: number; total: number | null }>(
    "SELECT COUNT(*) AS n, SUM(price_cents) AS total FROM appointments WHERE barbershop_id = ? AND promo_percent IS NOT NULL AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?",
    [shopId, from, to],
  )!;
  const offers = get<{ n: number }>("SELECT COUNT(*) AS n FROM bot_offers WHERE barbershop_id = ? AND kind = 'vazio' AND starts_at >= ? AND starts_at < ?", [
    shopId,
    from,
    to,
  ])!.n;
  return { month: today.slice(0, 7), booked: r.n, revenue_cents: r.total ?? 0, offers };
}
