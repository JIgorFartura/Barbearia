import { dailyBackup } from './backup.js';
import { checkConnections } from './connection.js';
import { purgeOldData } from './privacy.js';
import { askReviews } from './reviews.js';
import { clubBilling } from './club.js';
import { birthdayGifts } from './growth.js';
import { syncAsaasCharges } from './asaas.js';
import { syncCardLinks } from './cards.js';
import { askPresence, presenceText, releaseUnconfirmed } from './attendance.js';
import { offerFreedSlots } from './waitlist.js';
import { idleOffers } from './idle.js';
import { pushTo } from './push.js';
import { weeklySummary } from './manager.js';
import { notifyOwners } from './platform.js';
import { shopOwnerIds } from './shops.js';
import { errorAlerts } from './errors.js';
import { invoiceReminders } from './invoiceReminders.js';
import { trialReminders } from './trial.js';
import { accessStatus, ensureInvoices } from './billing.js';
import { config } from './config.js';
import { askConsumption } from './consumption.js';
import { all, get, nowIso, run } from './db.js';
import { awayAfter, customerHabit, lastVisitDate, rhythmDays, shopVisitDays, type Habit } from './habits.js';
import { availableComeback, availableComebacks, grantComeback } from './comeback.js';
import { sendMessage, sendsTemplate, shopBot, waConfig, type MessageKind, type ShopBot } from './messaging.js';
import { templateField, type TemplateKind, type TemplateUse } from './templates.js';
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

function log(shopId: number, customerId: number | null, kind: string, ref: string, at?: Date): void {
  run('INSERT INTO automation_log (barbershop_id, customer_id, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, customerId, kind, ref, at ? at.toISOString() : nowIso()]);
}

async function send(shop: ShopBot, c: CustomerLite, kind: MessageKind, text: string, template: TemplateUse | null = null): Promise<void> {
  await sendMessage({ shop, customerId: c.id, phone: c.phone, waId: c.wa_id, text, kind, template });
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
  const rows = all<CustomerLite & { appt_id: number; starts_at: string; created_at: string; confirmed_at: string | null; barber_name: string; service_name: string }>(
    `SELECT a.id AS appt_id, a.starts_at, a.created_at, a.confirmed_at, a.service_name, b.name AS barber_name, c.id, c.name, c.phone, c.wa_id
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
    const when = `${relativeDay(date, n.date)}${relativeDay(date, n.date) === dayLabel(date) ? '' : ` (${dayLabel(date)})`} às ${hourLabel(r.starts_at.slice(11))}`;
    // O lembrete pede a confirmação (SIM confirma; NÃO libera a vaga para a lista de espera). Já confirmado:
    // se ele costuma consumir algo e ainda não pediu, pergunta (o SIM separa e avisa o barbeiro). Pelo modelo
    // da Meta o texto é fixo (e pede a confirmação): aí não pergunta do consumo.
    let tail: string;
    if (!r.confirmed_at) {
      askPresence(shop.id, r.id, r.appt_id, now);
      tail = presenceText(shop, r.phone) || ' Se não puder vir, responda NÃO.';
    } else {
      const ask = sendsTemplate(shop, r.phone) ? null : askConsumption(shop.id, r.appt_id, now);
      tail = ` Presença confirmada ✅. Se não puder vir, responda CANCELAR.${ask ? `\n${ask}` : ''}`;
    }
    await send(
      shop,
      r,
      'lembrete',
      `Oi, ${firstName(r.name)}! Lembrete do ${shop.bot_name} 💈: seu horário na ${shop.name} é ${when} com ${r.barber_name} (${r.service_name}).${tail}`,
      { kind: 'lembrete', params: [firstName(r.name), shop.name, when, r.barber_name] },
    );
    // Quem instalou o app e ligou os avisos recebe também no celular (de graça).
    await pushTo(
      { shopId: shop.id, customerId: r.id },
      {
        title: shop.name,
        body: `Lembrete: seu horário é ${when} com ${r.barber_name}.${r.confirmed_at ? '' : ' Toque para confirmar.'}`,
        url: `/b/${shop.slug}/conta`,
        tag: `lembrete-${r.appt_id}`,
        icon: `/b/${shop.slug}/icons/192.png`,
      },
    ).catch((err) => console.error('[aviso no celular]', err));
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
    await send(shop, c, 'costume', text, slot ? { kind: 'costume', params: [firstName(c.name), shop.name, `${dayLabel(slot.date)} às ${hourLabel(slot.time)}`, slot.barberName] } : null);
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
  /** De quantos em quantos dias costuma vir (null: ainda sem ritmo, vale o prazo da barbearia). */
  rhythm: number | null;
  /** Vira "sumido" com tantos dias sem vir. */
  after: number;
  /** Mensagens desta ausência (ISO, a mais recente): o recontato e a segunda tentativa. */
  contactedAt: string | null;
  followedUpAt: string | null;
  contacted: boolean;
  /** Desconto de volta valendo. */
  promo: { percent: number; validUntil: string } | null;
  optOut: boolean;
}

/** Até dois anos sem vir ainda entra no recontato. */
const AWAY_LOOKBACK_DAYS = 730;

/**
 * Clientes sumidos, sem horário marcado: quem tem ritmo (3 visitas ou mais) passou bem do tempo dele;
 * quem não tem, passou do prazo da barbearia. Poucas consultas por barbearia (a última visita é o
 * horário atendido, a venda fechada ou o carimbo mais recente).
 */
export function awayCustomers(shopId: number, now: Date = new Date()): AwayCustomer[] {
  const shop = shopBot(shopId);
  const n = shopNow(shopId, now);
  const visits = shopVisitDays(shopId, addDays(n.date, -AWAY_LOOKBACK_DAYS), now);
  const sent = new Map<string, string>();
  for (const r of all<{ customer_id: number; kind: string; ref: string; at: string }>(
    "SELECT customer_id, kind, ref, MAX(created_at) AS at FROM automation_log WHERE barbershop_id = ? AND kind IN ('sumido', 'sumido2') GROUP BY customer_id, kind, ref",
    [shopId],
  )) {
    sent.set(`${r.kind}:${r.customer_id}:${r.ref}`, r.at);
  }
  const upcoming = new Set(
    all<{ customer_id: number }>("SELECT DISTINCT customer_id FROM appointments WHERE barbershop_id = ? AND status = 'scheduled' AND starts_at >= ?", [shopId, n.stamp]).map(
      (r) => r.customer_id,
    ),
  );
  const promos = availableComebacks(shopId, n.date);
  const out: AwayCustomer[] = [];
  for (const c of all<{ id: number; name: string; phone: string; reminders_opt_out: number }>(
    'SELECT id, name, phone, reminders_opt_out FROM customers WHERE barbershop_id = ? AND anonymized_at IS NULL',
    [shopId],
  )) {
    const days = visits.get(c.id);
    if (!days?.length || upcoming.has(c.id)) continue;
    const last = days[days.length - 1];
    const since = daysBetween(last, n.date);
    const rhythm = shop.winback_rhythm ? rhythmDays(days) : null;
    const after = awayAfter(rhythm, shop.winback_days);
    if (since < after) continue;
    const contactedAt = sent.get(`sumido:${c.id}:${last}`) ?? null;
    const promo = promos.get(c.id);
    out.push({
      id: c.id,
      name: c.name,
      phone: c.phone,
      lastVisit: last,
      days: since,
      rhythm,
      after,
      contactedAt,
      followedUpAt: sent.get(`sumido2:${c.id}:${last}`) ?? null,
      contacted: contactedAt !== null,
      promo: promo ? { percent: promo.percent, validUntil: promo.valid_until } : null,
      optOut: Boolean(c.reminders_opt_out),
    });
  }
  // Quem acabou de sumir primeiro: é quem mais volta.
  return out.sort((a, b) => a.days - a.after - (b.days - b.after));
}

const shortDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

const WINBACK_TEXT = 'Oi, {nome}! Aqui é o {robo}, da {barbearia}. 💈 Faz {dias} dias que você não aparece por aqui... aconteceu alguma coisa? Bora deixar o visual em dia?';
const FOLLOWUP_TEXT = 'Oi, {nome}! Aqui é o {robo} de novo, da {barbearia}. 💈 Passando pra lembrar que a sua cadeira está te esperando.';

const fillWinback = (tpl: string, shop: ShopBot, c: CustomerLite, days: number) =>
  tpl.replace(/\{nome\}/g, firstName(c.name)).replace(/\{dias\}/g, String(days)).replace(/\{barbearia\}/g, shop.name).replace(/\{robo\}/g, shop.bot_name);

/** Horário para sugerir no recontato: o de costume do cliente, se ele tem um e está livre. */
function winbackSlot(shop: ShopBot, customerId: number, now: Date): Suggestion | null {
  const habit = customerHabit(customerId, now);
  if (!habit) return null;
  const date = nextHabitDate(habit, shopNow(shop.id, now).stamp);
  return date ? suggestSlot(shop.id, habit, date, now) : null;
}

/** A barbearia cadastrou esse modelo na Meta? (Senão, vai o modelo sem desconto.) */
const hasTemplate = (shop: ShopBot, kind: TemplateKind) => Boolean((waConfig(shop) as Record<string, string>)[templateField(kind)]);

/** Mensagem de recontato: com o desconto de volta (se a barbearia dá) e a sugestão de horário de costume. */
export async function sendWinback(shop: ShopBot, c: CustomerLite, days: number, lastVisit: string, now: Date): Promise<void> {
  const n = shopNow(shop.id, now);
  const slot = winbackSlot(shop, c.id, now);
  if (slot) createOffer(shop.id, c.id, slot, 'sumido');
  const promo = shop.winback_discount ? grantComeback(shop.id, c.id, shop.winback_discount, addDays(n.date, shop.winback_discount_days), n.date) : null;
  const text = [
    fillWinback(shop.winback_message?.trim() || WINBACK_TEXT, shop, c, days),
    promo ? `🎁 Pra você voltar: *${promo.percent}% de desconto* no próximo horário, marcando até ${shortDate(promo.valid_until)}.` : '',
    slot ? `Tenho *${offerLine(slot)}*. Responda *SIM* para marcar ou me diga o melhor horário.` : 'Me diga o dia e o horário que eu marco pra você.',
    OPT_OUT_HINT,
  ];
  const template: TemplateUse =
    promo && hasTemplate(shop, 'sumido_desconto')
      ? { kind: 'sumido_desconto', params: [firstName(c.name), shop.name, String(days), `${promo.percent}%`, shortDate(promo.valid_until)] }
      : { kind: 'sumido', params: [firstName(c.name), shop.name, String(days)] };
  log(shop.id, c.id, 'sumido', lastVisit, now);
  await send(shop, c, 'sumido', text.filter(Boolean).join('\n'), template);
}

/** Segunda tentativa, para quem não respondeu nem marcou: lembra do desconto que ainda vale. */
export async function sendFollowUp(shop: ShopBot, c: CustomerLite, days: number, lastVisit: string, now: Date): Promise<void> {
  const n = shopNow(shop.id, now);
  const slot = winbackSlot(shop, c.id, now);
  if (slot) createOffer(shop.id, c.id, slot, 'sumido');
  const promo = availableComeback(c.id, n.date);
  const text = [
    fillWinback(shop.winback_followup_message?.trim() || FOLLOWUP_TEXT, shop, c, days),
    promo ? `🎁 Seu desconto de *${promo.percent}%* ainda vale, marcando até ${shortDate(promo.valid_until)}.` : '',
    slot ? `Separei *${offerLine(slot)}*. Responda *SIM* para marcar ou me diga outro horário.` : 'É só me dizer o dia e o horário que eu marco pra você.',
    OPT_OUT_HINT,
  ];
  log(shop.id, c.id, 'sumido2', lastVisit, now);
  await send(shop, c, 'sumido2', text.filter(Boolean).join('\n'), { kind: 'sumido2', params: [firstName(c.name), shop.name] });
}

/** O cliente escreveu depois da última mensagem de recontato? (A conversa aconteceu: o robô não insiste.) */
function repliedAfterWinback(shopId: number, c: CustomerLite): boolean {
  const last = get<{ id: number | null }>("SELECT MAX(id) AS id FROM messages WHERE barbershop_id = ? AND customer_id = ? AND direction = 'out' AND kind = 'sumido'", [
    shopId,
    c.id,
  ])?.id;
  if (!last) return false;
  return Boolean(
    get("SELECT 1 AS ok FROM messages WHERE barbershop_id = ? AND direction = 'in' AND id > ? AND (customer_id = ? OR phone = ?) LIMIT 1", [shopId, last, c.id, c.phone]),
  );
}

/** Recebeu hoje o convite do horário de costume ou a oferta do horário vazio? (Uma mensagem dessas por dia.) */
const offeredToday = (shopId: number, customerId: number, today: string) =>
  Boolean(get("SELECT 1 AS ok FROM automation_log WHERE barbershop_id = ? AND customer_id = ? AND kind IN ('costume', 'vazio') AND ref = ? LIMIT 1", [shopId, customerId, today]));

// O recontato olha todos os clientes: basta uma vez por hora para cada barbearia.
const lastWinbackCheck = new Map<number, number>();

export async function winbacks(shop: ShopBot, now: Date): Promise<number> {
  if (!shop.winback_enabled) return 0;
  const last = lastWinbackCheck.get(shop.id);
  if (last !== undefined && Math.abs(now.getTime() - last) < 3600000) return 0;
  lastWinbackCheck.set(shop.id, now.getTime());
  const today = shopNow(shop.id, now).date;
  let sent = 0;
  for (const a of awayCustomers(shop.id, now)) {
    if (sent >= WINBACK_PER_RUN) break;
    if (a.optOut || offeredToday(shop.id, a.id, today)) continue;
    const c = get<CustomerLite>('SELECT id, name, phone, wa_id FROM customers WHERE id = ?', [a.id])!;
    if (!a.contactedAt) {
      await sendWinback(shop, c, a.days, a.lastVisit, now);
      sent++;
      continue;
    }
    // Segunda tentativa: uma só, N dias depois, se ele não respondeu (quem marcou já saiu da lista).
    if (!shop.winback_followup_days || a.followedUpAt) continue;
    if (now.getTime() - Date.parse(a.contactedAt) < shop.winback_followup_days * 86400000) continue;
    if (repliedAfterWinback(shop.id, c)) continue;
    await sendFollowUp(shop, c, a.days, a.lastVisit, now);
    sent++;
  }
  return sent;
}

export interface WinbackResults {
  /** Clientes que o robô chamou nos últimos 90 dias. */
  contacted: number;
  /** Desses, quantos vieram depois da mensagem. */
  returned: number;
  /** O que os que voltaram gastaram desde a mensagem (vendas fechadas). */
  revenueCents: number;
}

/** Resultado do recontato nos últimos 90 dias (para o dono ver que funciona). */
export function winbackResults(shopId: number, now: Date = new Date()): WinbackResults {
  const n = shopNow(shopId, now);
  const tz = shopTz(shopId);
  const first = new Map(
    all<{ customer_id: number; at: string }>(
      "SELECT customer_id, MIN(created_at) AS at FROM automation_log WHERE barbershop_id = ? AND kind = 'sumido' AND customer_id IS NOT NULL AND created_at >= ? GROUP BY customer_id",
      [shopId, new Date(now.getTime() - 90 * 86400000).toISOString()],
    ).map((r) => [r.customer_id, isoToLocal(r.at, tz).slice(0, 10)]),
  );
  const visits = first.size ? shopVisitDays(shopId, addDays(n.date, -91), now) : new Map<number, string[]>();
  let returned = 0;
  let revenueCents = 0;
  for (const [id, day] of first) {
    if (!(visits.get(id) ?? []).some((d) => d >= day)) continue;
    returned++;
    revenueCents +=
      get<{ v: number | null }>("SELECT SUM(total_cents) AS v FROM sales WHERE barbershop_id = ? AND customer_id = ? AND status = 'closed' AND date >= ?", [shopId, id, day])!.v ?? 0;
  }
  return { contacted: first.size, returned, revenueCents };
}

// ---------- resumo da semana para o dono

/** Pelo WhatsApp da plataforma (modelo aprovado fora da janela) e no celular de quem ligou os avisos do painel. */
async function sendWeeklySummary(shop: ShopBot, now: Date): Promise<number> {
  const msg = weeklySummary(shop, now);
  if (!msg) return 0;
  const sent = await notifyOwners(shop.id, msg.text, msg.template, { kind: 'resumo' });
  const owners = shopOwnerIds(shop.id);
  await pushTo({ shopId: shop.id, userIds: owners }, { ...msg.push, url: '/painel/relatorios', tag: 'resumo-semana' }).catch((err) => console.error('[aviso no celular]', err));
  return sent ? 1 : 0;
}

// ---------- rodada

export interface RunSummary {
  reminders: number;
  habits: number;
  winbacks: number;
  reviews: number;
  club: number;
  birthdays: number;
  /** Horários liberados por falta de confirmação. */
  released: number;
  /** Vagas oferecidas para quem estava na lista de espera. */
  waitlist: number;
  /** Horários vazios oferecidos com desconto. */
  idle: number;
  /** Resumos da semana enviados aos donos. */
  summaries: number;
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
  const summary: RunSummary = { reminders: 0, habits: 0, winbacks: 0, reviews: 0, club: 0, birthdays: 0, released: 0, waitlist: 0, idle: 0, summaries: 0 };
  if (running) return summary;
  running = true;
  try {
    // Faturas do mês da plataforma: confere de hora em hora (qualquer horário).
    if (Math.abs(now.getTime() - lastInvoiceCheck) >= 3600000) {
      lastInvoiceCheck = now.getTime();
      automationStatus.lastInvoices = ensureInvoices(now);
      // Cobrança PIX no Asaas (se configurado) e lembrete da mensalidade no WhatsApp da plataforma.
      if (config.automations) {
        await syncAsaasCharges().catch((err) => console.error('[asaas]', err));
        await syncCardLinks(now).catch((err) => console.error('[cielo]', err));
        await invoiceReminders(now).catch((err) => console.error('[mensalidade]', err));
        await trialReminders(now).catch((err) => console.error('[teste grátis]', err));
      }
    }
    // Cópia de segurança do dia (a partir das 3h); uma falha aqui não para os lembretes.
    const backedUp = await dailyBackup(now).catch((err) => console.error('[backup]', err));
    // Uma vez por dia, junto da cópia: apaga o que não precisa mais ser guardado (LGPD).
    if (backedUp) purgeOldData(now);
    // Conexão do WhatsApp de cada barbearia (avisa o dono se cair) e erros novos do sistema (avisa o master).
    if (config.automations) {
      await checkConnections(now).catch((err) => console.error('[conexão]', err));
      await errorAlerts(now).catch((err) => console.error('[erros]', err));
    }
    for (const { id } of all<{ id: number }>('SELECT id FROM barbershops WHERE active = 1')) {
      // Entre uma barbearia e outra, dá passagem ao site e ao robô (o banco é síncrono).
      await new Promise((resolve) => setImmediate(resolve));
      const shop = shopBot(id);
      // Cada barbearia no seu relógio: ofertas vencidas e horário comercial pelo fuso dela.
      const n = shopNow(id, now);
      run("UPDATE bot_offers SET status = 'expired' WHERE barbershop_id = ? AND status = 'pending' AND starts_at <= ?", [id, n.stamp]);
      // Horário de quem não confirmou (se a barbearia ligou) e vaga aberta para a lista de espera: têm o
      // próprio horário de envio (são resposta ao que o cliente pediu), fora a regra das automáticas.
      try {
        summary.released += await releaseUnconfirmed(shop, now);
        summary.waitlist += await offerFreedSlots(shop, now);
      } catch (err) {
        console.error(`[lista de espera] ${shop.slug}:`, err);
      }
      if (n.time < SEND_FROM || n.time >= SEND_UNTIL) continue;
      // Mensalidade em atraso além da carência: sem disparos até regularizar.
      if (accessStatus(id, now).blocked) continue;
      try {
        summary.reminders += await appointmentReminders(shop, now);
        summary.habits += await habitOffers(shop, now);
        summary.winbacks += await winbacks(shop, now);
        summary.reviews += await askReviews(shop, now);
        summary.club += await clubBilling(shop, now);
        summary.birthdays += await birthdayGifts(shop, now);
        summary.idle += await idleOffers(shop, now);
        summary.summaries += await sendWeeklySummary(shop, now);
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
