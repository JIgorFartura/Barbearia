import { dailyBackup } from './backup.js';
import { accessStatus, ensureInvoices } from './billing.js';
import { askConsumption } from './consumption.js';
import { all, get, nowIso, run } from './db.js';
import { customerHabit, lastVisitDate, type Habit } from './habits.js';
import { sendMessage, shopBot, type MessageKind, type ShopBot } from './messaging.js';
import { freeTimes, upcomingFor } from './scheduling.js';
import { shopNow, shopTz } from './clock.js';
import { addDays, addMinutes, daysBetween, dayLabel, hourLabel, isoToLocal, relativeDay, toMinutes, weekdayOf } from './time.js';

/** Mensagens automáticas só neste horário (horário local da barbearia). */
export const SEND_FROM = '08:00';
export const SEND_UNTIL = '21:00';
/** No máximo tantos recontatos por barbearia a cada rodada (evita disparo em massa). */
const WINBACK_PER_RUN = 20;
const OPT_OUT_HINT = '(Para não receber estes avisos, responda PARAR.)';

interface CustomerLite {
  id: number;
  name: string;
  phone: string;
  wa_id: string | null;
}

const firstName = (name: string) => name.split(/\s+/)[0];

function logged(shopId: number, customerId: number | null, kind: string, ref: string): boolean {
  return Boolean(
    get('SELECT 1 AS ok FROM automation_log WHERE barbershop_id = ? AND kind = ? AND ref = ? AND customer_id IS ?', [shopId, kind, ref, customerId]),
  );
}

function log(shopId: number, customerId: number | null, kind: string, ref: string): void {
  run('INSERT INTO automation_log (barbershop_id, customer_id, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, customerId, kind, ref, nowIso()]);
}

async function send(shop: ShopBot, c: CustomerLite, kind: MessageKind, text: string): Promise<void> {
  await sendMessage({ shop, customerId: c.id, phone: c.phone, waId: c.wa_id, text, kind });
}

const optedInCustomers = (shopId: number) =>
  all<CustomerLite>('SELECT id, name, phone, wa_id FROM customers WHERE barbershop_id = ? AND reminders_opt_out = 0 ORDER BY id', [shopId]);

export interface Suggestion {
  barberId: number;
  barberName: string;
  serviceId: number | null;
  date: string;
  time: string;
}

/**
 * Horário para oferecer no dia: o de costume com o barbeiro de costume; senão, o mesmo horário
 * com outro barbeiro; senão, o horário livre mais perto do de costume (até 2h de diferença).
 */
export function suggestSlot(shopId: number, habit: Habit, date: string, now: Date): Suggestion | null {
  const days = freeTimes(shopId, date, { serviceId: habit.serviceId, now, leadMin: 120 });
  const target = toMinutes(habit.time);
  const preferred = days.find((d) => d.barber.id === habit.barberId);
  const pick = (d: (typeof days)[number], time: string): Suggestion => ({
    barberId: d.barber.id,
    barberName: d.barber.name,
    serviceId: habit.serviceId,
    date,
    time,
  });
  if (preferred?.times.includes(habit.time)) return pick(preferred, habit.time);
  const sameTime = days.find((d) => d.times.includes(habit.time));
  if (sameTime) return pick(sameTime, habit.time);
  let best: { d: (typeof days)[number]; time: string; diff: number } | null = null;
  for (const d of preferred ? [preferred, ...days.filter((x) => x !== preferred)] : days) {
    for (const time of d.times) {
      const diff = Math.abs(toMinutes(time) - target);
      if (diff <= 120 && (!best || diff < best.diff)) best = { d, time, diff };
    }
  }
  return best ? pick(best.d, best.time) : null;
}

function createOffer(shopId: number, customerId: number, s: Suggestion, kind: string): void {
  // Uma oferta por vez: as anteriores deixam de valer.
  run("UPDATE bot_offers SET status = 'expired' WHERE customer_id = ? AND status = 'pending'", [customerId]);
  run('INSERT INTO bot_offers (barbershop_id, customer_id, barber_id, service_id, starts_at, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    shopId,
    customerId,
    s.barberId,
    s.serviceId,
    `${s.date} ${s.time}`,
    kind,
    nowIso(),
  ]);
}

const offerLine = (s: Suggestion) => `${dayLabel(s.date)} às ${hourLabel(s.time)} com ${s.barberName}`;

// ---------- 1) lembrete do horário marcado

export async function appointmentReminders(shop: ShopBot, now: Date): Promise<number> {
  if (shop.reminder_hours <= 0) return 0;
  const n = shopNow(shop.id, now);
  const tz = shopTz(shop.id);
  const windowMin = shop.reminder_hours * 60;
  const rows = all<CustomerLite & { appt_id: number; starts_at: string; created_at: string; barber_name: string; service_name: string }>(
    `SELECT a.id AS appt_id, a.starts_at, a.created_at, a.service_name, b.name AS barber_name, c.id, c.name, c.phone, c.wa_id
       FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN barbers b ON b.id = a.barber_id
      WHERE a.barbershop_id = ? AND a.status = 'scheduled' AND a.starts_at > ? AND a.starts_at <= ?`,
    [shop.id, n.stamp, addMinutes(n.stamp, windowMin)],
  );
  let sent = 0;
  for (const r of rows) {
    // Marcado já dentro da janela: a confirmação basta, sem lembrete.
    if (isoToLocal(r.created_at, tz) > addMinutes(r.starts_at, -windowMin)) continue;
    if (logged(shop.id, r.id, 'lembrete', String(r.appt_id))) continue;
    log(shop.id, r.id, 'lembrete', String(r.appt_id));
    const date = r.starts_at.slice(0, 10);
    // Se ele costuma consumir algo e ainda não pediu, o lembrete já pergunta (o SIM separa e avisa o barbeiro).
    const ask = askConsumption(shop.id, r.appt_id, now);
    await send(
      shop,
      r,
      'lembrete',
      `Oi, ${firstName(r.name)}! Lembrete do ${shop.bot_name} 💈: seu horário na ${shop.name} é ${relativeDay(date, n.date)}${relativeDay(date, n.date) === dayLabel(date) ? '' : ` (${dayLabel(date)})`} às ${hourLabel(r.starts_at.slice(11))} com ${r.barber_name} (${r.service_name}). Se não puder vir, responda CANCELAR.${ask ? `\n${ask}` : ''}`,
    );
    sent++;
  }
  return sent;
}

// ---------- 2) oferta semanal no horário de costume

/** Próxima data (a partir de hoje, até 6 dias) no dia de costume, com pelo menos 2h de antecedência. */
function nextHabitDate(habit: Habit, nowStamp: string): string | null {
  const today = nowStamp.slice(0, 10);
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    if (weekdayOf(d) === habit.weekday && `${d} ${habit.time}` >= addMinutes(nowStamp, 120)) return d;
  }
  return null;
}

export async function habitOffers(shop: ShopBot, now: Date): Promise<number> {
  const n = shopNow(shop.id, now);
  if (!shop.habit_enabled || n.weekday !== shop.habit_weekday || n.time < shop.habit_time) return 0;
  const ref = n.date;
  if (logged(shop.id, null, 'costume_rodada', ref)) return 0;
  log(shop.id, null, 'costume_rodada', ref);

  let sent = 0;
  for (const c of optedInCustomers(shop.id)) {
    if (logged(shop.id, c.id, 'costume', ref) || upcomingFor(c.id, now).length) continue;
    const habit = customerHabit(c.id, now);
    if (!habit) continue;
    const date = nextHabitDate(habit, n.stamp);
    if (!date) continue;
    // Só oferece quando já está "na hora" de voltar, pelo ritmo do cliente (toda semana, a cada 15 dias...).
    const last = lastVisitDate(c.id, now);
    if (last && daysBetween(last, date) < habit.intervalDays - 3) continue;

    log(shop.id, c.id, 'costume', ref);
    const slot = suggestSlot(shop.id, habit, date, now);
    if (slot) createOffer(shop.id, c.id, slot, 'costume');
    const text = slot
      ? `Fala, ${firstName(c.name)}! Aqui é o ${shop.bot_name}, da ${shop.name}. 💈 Bora garantir seu horário de sempre? Separei *${offerLine(slot)}*.\nResponda *SIM* para confirmar ou me diga outro horário.\n${OPT_OUT_HINT}`
      : `Fala, ${firstName(c.name)}! Aqui é o ${shop.bot_name}, da ${shop.name}. 💈 Seu horário de costume (${dayLabel(date)} às ${hourLabel(habit.time)}) já está ocupado essa semana. Quer que eu veja outro horário pra você?\n${OPT_OUT_HINT}`;
    await send(shop, c, 'costume', text);
    sent++;
  }
  return sent;
}

// ---------- 3) recontato de quem sumiu

export interface AwayCustomer {
  id: number;
  name: string;
  phone: string;
  lastVisit: string;
  days: number;
  contacted: boolean;
  optOut: boolean;
}

/** Clientes que não vêm há `winback_days` dias ou mais e não têm horário marcado. */
export function awayCustomers(shopId: number, now: Date = new Date()): AwayCustomer[] {
  const shop = shopBot(shopId);
  const today = shopNow(shopId, now).date;
  const out: AwayCustomer[] = [];
  for (const c of all<CustomerLite & { reminders_opt_out: number }>('SELECT id, name, phone, wa_id, reminders_opt_out FROM customers WHERE barbershop_id = ?', [shopId])) {
    const last = lastVisitDate(c.id, now);
    if (!last) continue;
    const days = daysBetween(last, today);
    if (days < shop.winback_days || upcomingFor(c.id, now).length) continue;
    out.push({ id: c.id, name: c.name, phone: c.phone, lastVisit: last, days, contacted: logged(shopId, c.id, 'sumido', last), optOut: Boolean(c.reminders_opt_out) });
  }
  return out.sort((a, b) => a.days - b.days);
}

/** Mensagem de recontato (com sugestão de horário quando o cliente tem costume). */
export async function sendWinback(shop: ShopBot, c: CustomerLite, days: number, lastVisit: string, now: Date): Promise<void> {
  const n = shopNow(shop.id, now);
  const habit = customerHabit(c.id, now);
  let slot: Suggestion | null = null;
  if (habit) {
    const date = nextHabitDate(habit, n.stamp);
    if (date) slot = suggestSlot(shop.id, habit, date, now);
  }
  if (slot) createOffer(shop.id, c.id, slot, 'sumido');
  const fill = (tpl: string) =>
    tpl.replace(/\{nome\}/g, firstName(c.name)).replace(/\{dias\}/g, String(days)).replace(/\{barbearia\}/g, shop.name).replace(/\{robo\}/g, shop.bot_name);
  const opening = fill(
    shop.winback_message?.trim() ||
      'Oi, {nome}! Aqui é o {robo}, da {barbearia}. 💈 Faz {dias} dias que você não aparece por aqui... aconteceu alguma coisa? Bora deixar o visual em dia?',
  );
  const ask = slot ? `Tenho *${offerLine(slot)}*. Responda *SIM* para marcar ou me diga o melhor horário.` : 'Me diga o dia e o horário que eu marco pra você.';
  log(shop.id, c.id, 'sumido', lastVisit);
  await send(shop, c, 'sumido', `${opening}\n${ask}\n${OPT_OUT_HINT}`);
}

// O recontato olha todos os clientes: basta uma vez por hora para cada barbearia.
const lastWinbackCheck = new Map<number, number>();

export async function winbacks(shop: ShopBot, now: Date): Promise<number> {
  if (!shop.winback_enabled) return 0;
  const last = lastWinbackCheck.get(shop.id);
  if (last !== undefined && Math.abs(now.getTime() - last) < 3600000) return 0;
  lastWinbackCheck.set(shop.id, now.getTime());
  let sent = 0;
  for (const a of awayCustomers(shop.id, now)) {
    if (sent >= WINBACK_PER_RUN) break;
    if (a.contacted || a.optOut) continue;
    const c = get<CustomerLite>('SELECT id, name, phone, wa_id FROM customers WHERE id = ?', [a.id])!;
    await sendWinback(shop, c, a.days, a.lastVisit, now);
    sent++;
  }
  return sent;
}

// ---------- rodada

export interface RunSummary {
  reminders: number;
  habits: number;
  winbacks: number;
}

let running = false;
let lastInvoiceCheck = 0;

/** Última rodada (aparece na tela Sistema do master). */
export const automationStatus: { lastRun: string | null; lastSummary: RunSummary | null; lastInvoices: number } = {
  lastRun: null,
  lastSummary: null,
  lastInvoices: 0,
};

/** Roda tudo uma vez. Chamado a cada minuto; cada envio é registrado para não repetir. */
export async function runAutomations(now: Date = new Date()): Promise<RunSummary> {
  const summary: RunSummary = { reminders: 0, habits: 0, winbacks: 0 };
  if (running) return summary;
  running = true;
  try {
    // Faturas do mês da plataforma: confere de hora em hora (qualquer horário).
    if (Math.abs(now.getTime() - lastInvoiceCheck) >= 3600000) {
      lastInvoiceCheck = now.getTime();
      automationStatus.lastInvoices = ensureInvoices(now);
    }
    // Cópia de segurança do dia (a partir das 3h); uma falha aqui não para os lembretes.
    await dailyBackup(now).catch((err) => console.error('[backup]', err));
    for (const { id } of all<{ id: number }>('SELECT id FROM barbershops WHERE active = 1')) {
      const shop = shopBot(id);
      // Cada barbearia no seu relógio: ofertas vencidas e horário comercial pelo fuso dela.
      const n = shopNow(id, now);
      run("UPDATE bot_offers SET status = 'expired' WHERE barbershop_id = ? AND status = 'pending' AND starts_at <= ?", [id, n.stamp]);
      if (n.time < SEND_FROM || n.time >= SEND_UNTIL) continue;
      // Mensalidade em atraso além da carência: sem disparos até regularizar.
      if (accessStatus(id, now).blocked) continue;
      try {
        summary.reminders += await appointmentReminders(shop, now);
        summary.habits += await habitOffers(shop, now);
        summary.winbacks += await winbacks(shop, now);
      } catch (err) {
        console.error(`[automações] ${shop.slug}:`, err);
      }
    }
    return summary;
  } finally {
    automationStatus.lastRun = new Date().toISOString();
    automationStatus.lastSummary = summary;
    running = false;
  }
}

export function startAutomations(): () => void {
  const tick = () => void runAutomations().catch((err) => console.error('[automações]', err));
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
