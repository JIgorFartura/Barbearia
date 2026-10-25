import { shopNow } from './clock.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { sendMessage, shopBot, type ShopBot } from './messaging.js';
import { freeTimes } from './scheduling.js';
import { addDays, dayLabel, hourLabel, isDate } from './time.js';

/**
 * Lista de espera: o cliente entra para um dia (com barbeiro e período, se quiser) quando não acha
 * horário. Abriu vaga (alguém cancelou, o horário foi liberado por falta de confirmação, o dono
 * desbloqueou a agenda), o robô oferece no WhatsApp para o primeiro da fila: SIM marca. A vaga fica
 * guardada para ele por 30 minutos; sem resposta, vai para o próximo.
 */

export type Period = 'qualquer' | 'manha' | 'tarde' | 'noite';
export const PERIODS: Record<Period, { label: string; from: string; to: string }> = {
  qualquer: { label: 'qualquer horário', from: '00:00', to: '24:00' },
  manha: { label: 'de manhã', from: '00:00', to: '12:00' },
  tarde: { label: 'à tarde', from: '12:00', to: '18:00' },
  noite: { label: 'à noite', from: '18:00', to: '24:00' },
};
export const PERIOD_IDS = Object.keys(PERIODS) as Period[];

/** A vaga oferecida fica guardada para quem recebeu a oferta por este tempo. */
export const OFFER_MINUTES = 30;
/** Ofertas por pedido: depois disso ele continua podendo marcar pela área ou pelo robô. */
const MAX_OFFERS = 3;
/** Até quantos dias à frente dá para entrar na lista. */
const MAX_DAYS_AHEAD = 30;
/** Ofertas só neste horário (do relógio da barbearia) e para vagas daqui a pelo menos 1 hora. */
const OFFER_FROM = '07:00';
const OFFER_UNTIL = '22:00';
const LEAD_MIN = 60;

export interface WaitEntry {
  id: number;
  barbershop_id: number;
  customer_id: number;
  date: string;
  barber_id: number | null;
  service_id: number | null;
  period: Period;
  status: 'waiting' | 'booked' | 'expired' | 'cancelled';
  offers: number;
  last_offer_at: string | null;
  source: string;
  created_at: string;
}

export interface WaitView extends WaitEntry {
  customer_name: string;
  phone: string;
  barber_name: string | null;
  service_name: string | null;
}

const SELECT = `SELECT w.*, c.name AS customer_name, c.phone, b.name AS barber_name, s.name AS service_name
                  FROM waitlist w JOIN customers c ON c.id = w.customer_id
                  LEFT JOIN barbers b ON b.id = w.barber_id LEFT JOIN catalog_items s ON s.id = w.service_id`;

const firstName = (name: string) => name.split(/\s+/)[0];

/** "sábado, 25/10 · à tarde · com Paulo" */
export function describeWait(w: Pick<WaitView, 'date' | 'period' | 'barber_name'>): string {
  return `${dayLabel(w.date)}${w.period === 'qualquer' ? '' : ` · ${PERIODS[w.period].label}`}${w.barber_name ? ` · com ${w.barber_name}` : ''}`;
}

/** Entra na lista (ou atualiza o pedido que ele já tinha para o mesmo dia). */
export function joinWaitlist(input: {
  shopId: number;
  customerId: number;
  date: string;
  barberId?: number | null;
  serviceId?: number | null;
  period?: Period;
  source: 'cliente' | 'whatsapp' | 'painel';
  now?: Date;
}): WaitView {
  if (!isDate(input.date)) throw new HttpError(400, 'Data inválida (use AAAA-MM-DD).');
  const today = shopNow(input.shopId, input.now).date;
  if (input.date < today) throw new HttpError(400, 'Esse dia já passou.');
  if (input.date > addDays(today, MAX_DAYS_AHEAD)) throw new HttpError(400, `Dá para entrar na lista de espera para até ${MAX_DAYS_AHEAD} dias à frente.`);
  if (input.barberId && !get('SELECT 1 AS ok FROM barbers WHERE id = ? AND barbershop_id = ? AND active = 1', [input.barberId, input.shopId])) {
    throw new HttpError(404, 'Barbeiro não encontrado.');
  }
  if (input.serviceId && !get("SELECT 1 AS ok FROM catalog_items WHERE id = ? AND barbershop_id = ? AND kind = 'service'", [input.serviceId, input.shopId])) {
    throw new HttpError(404, 'Serviço não encontrado.');
  }
  if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ? AND anonymized_at IS NULL', [input.customerId, input.shopId])) {
    throw new HttpError(404, 'Cliente não encontrado.');
  }
  const period = input.period ?? 'qualquer';
  const same = get<{ id: number }>("SELECT id FROM waitlist WHERE customer_id = ? AND date = ? AND status = 'waiting'", [input.customerId, input.date]);
  if (same) {
    run('UPDATE waitlist SET barber_id = ?, service_id = ?, period = ? WHERE id = ?', [input.barberId ?? null, input.serviceId ?? null, period, same.id]);
    return waitEntry(same.id)!;
  }
  const active = get<{ n: number }>("SELECT COUNT(*) AS n FROM waitlist WHERE customer_id = ? AND status = 'waiting' AND date >= ?", [input.customerId, today])!.n;
  if (active >= 3) throw new HttpError(409, 'Você já está na lista de espera de 3 dias. Saia de um para entrar em outro.');
  const id = run(
    'INSERT INTO waitlist (barbershop_id, customer_id, date, barber_id, service_id, period, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [input.shopId, input.customerId, input.date, input.barberId ?? null, input.serviceId ?? null, period, input.source, (input.now ?? new Date()).toISOString()],
  ).lastInsertRowid;
  return waitEntry(id)!;
}

export const waitEntry = (id: number) => get<WaitView>(`${SELECT} WHERE w.id = ?`, [id]);

export function leaveWaitlist(shopId: number, entryId: number, opts: { customerId?: number } = {}): void {
  const w = waitEntry(entryId);
  if (!w || w.barbershop_id !== shopId || (opts.customerId && w.customer_id !== opts.customerId)) throw new HttpError(404, 'Pedido da lista de espera não encontrado.');
  run("UPDATE waitlist SET status = 'cancelled' WHERE id = ? AND status = 'waiting'", [entryId]);
}

/** Os pedidos do cliente que ainda valem (área do cliente e robô). */
export function customerWaitlist(customerId: number, now?: Date): WaitView[] {
  const shop = get<{ barbershop_id: number }>('SELECT barbershop_id FROM customers WHERE id = ?', [customerId]);
  if (!shop) return [];
  return all<WaitView>(`${SELECT} WHERE w.customer_id = ? AND w.status = 'waiting' AND w.date >= ? ORDER BY w.date`, [customerId, shopNow(shop.barbershop_id, now).date]);
}

/** A fila de um dia (ou de hoje em diante), na ordem de chegada (painel). */
export function shopWaitlist(shopId: number, date?: string, now?: Date): WaitView[] {
  if (date) return all<WaitView>(`${SELECT} WHERE w.barbershop_id = ? AND w.date = ? AND w.status = 'waiting' ORDER BY w.created_at`, [shopId, date]);
  return all<WaitView>(`${SELECT} WHERE w.barbershop_id = ? AND w.date >= ? AND w.status = 'waiting' ORDER BY w.date, w.created_at`, [shopId, shopNow(shopId, now).date]);
}

/** Vaga com oferta em aberto, guardada para alguém (não vai para outro da fila nesse tempo). */
function heldSlots(shopId: number, now: Date): Set<string> {
  const since = new Date(now.getTime() - OFFER_MINUTES * 60000).toISOString();
  return new Set(
    all<{ barber_id: number; starts_at: string }>(
      "SELECT barber_id, starts_at FROM bot_offers WHERE barbershop_id = ? AND kind = 'espera' AND status = 'pending' AND created_at >= ?",
      [shopId, since],
    ).map((o) => `${o.barber_id}|${o.starts_at}`),
  );
}

/**
 * Procura vaga para quem está esperando e oferece no WhatsApp. Roda a cada minuto (automações) e
 * logo depois de um cancelamento. Devolve quantas ofertas saíram.
 */
export async function offerFreedSlots(shop: ShopBot, now: Date = new Date(), opts: { dryRun?: boolean } = {}): Promise<number> {
  const n = shopNow(shop.id, now);
  // Dia que passou: o pedido acabou.
  run("UPDATE waitlist SET status = 'expired' WHERE barbershop_id = ? AND status = 'waiting' AND date < ?", [shop.id, n.date]);
  if (n.time < OFFER_FROM || n.time >= OFFER_UNTIL) return 0;
  const entries = all<WaitView>(`${SELECT} WHERE w.barbershop_id = ? AND w.status = 'waiting' AND w.offers < ? ORDER BY w.created_at`, [shop.id, MAX_OFFERS]);
  if (!entries.length) return 0;
  const held = heldSlots(shop.id, now);
  const recent = new Date(now.getTime() - OFFER_MINUTES * 60000).toISOString();
  let sent = 0;
  for (const w of entries) {
    // Já marcou nesse dia (por outro caminho): o pedido está atendido.
    if (get("SELECT 1 AS ok FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at >= ? AND starts_at < ?", [w.customer_id, `${w.date} 00:00`, `${addDays(w.date, 1)} 00:00`])) {
      run("UPDATE waitlist SET status = 'booked' WHERE id = ?", [w.id]);
      continue;
    }
    // Ainda está com uma oferta para responder.
    if (w.last_offer_at && w.last_offer_at >= recent) continue;
    const window = PERIODS[w.period];
    const offeredBefore = new Set(
      all<{ barber_id: number; starts_at: string }>("SELECT barber_id, starts_at FROM bot_offers WHERE customer_id = ? AND kind = 'espera'", [w.customer_id]).map(
        (o) => `${o.barber_id}|${o.starts_at}`,
      ),
    );
    let slot: { barberId: number; barberName: string; time: string } | null = null;
    for (const day of freeTimes(shop.id, w.date, { barberId: w.barber_id, serviceId: w.service_id, now, leadMin: LEAD_MIN })) {
      for (const time of day.times) {
        const key = `${day.barber.id}|${w.date} ${time}`;
        if (time < window.from || time >= window.to || held.has(key) || offeredBefore.has(key)) continue;
        if (!slot || time < slot.time) slot = { barberId: day.barber.id, barberName: day.barber.name, time };
        break;
      }
    }
    if (!slot) continue;
    const startsAt = `${w.date} ${slot.time}`;
    // Uma oferta por vez para o cliente: as anteriores deixam de valer.
    run("UPDATE bot_offers SET status = 'expired' WHERE customer_id = ? AND status = 'pending'", [w.customer_id]);
    run("INSERT INTO bot_offers (barbershop_id, customer_id, barber_id, service_id, starts_at, kind, created_at) VALUES (?, ?, ?, ?, ?, 'espera', ?)", [
      shop.id,
      w.customer_id,
      slot.barberId,
      w.service_id,
      startsAt,
      now.toISOString(),
    ]);
    run('UPDATE waitlist SET offers = offers + 1, last_offer_at = ? WHERE id = ?', [now.toISOString(), w.id]);
    held.add(`${slot.barberId}|${startsAt}`);
    const customer = get<{ wa_id: string | null }>('SELECT wa_id FROM customers WHERE id = ?', [w.customer_id]);
    const when = `${dayLabel(w.date)} às ${hourLabel(slot.time)}`;
    await sendMessage({
      shop,
      customerId: w.customer_id,
      phone: w.phone,
      waId: customer?.wa_id ?? null,
      kind: 'espera',
      text: `Oi, ${firstName(w.customer_name)}! Abriu uma vaga na ${shop.name}: *${when} com ${slot.barberName}*. 🎉 Quer? Responda *SIM* para marcar (guardo pra você por ${OFFER_MINUTES} minutos).`,
      template: { kind: 'espera', params: [firstName(w.customer_name), shop.name, when, slot.barberName] },
      dryRun: opts.dryRun,
    });
    sent++;
  }
  return sent;
}

/** Abriu vaga agora (cancelamento): oferece já para a fila, sem esperar a rodada do minuto. */
export function slotFreed(shopId: number): void {
  void offerFreedSlots(shopBot(shopId)).catch((err) => console.error('[lista de espera]', err));
}
