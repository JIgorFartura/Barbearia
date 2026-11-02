import crypto from 'node:crypto';
import { shopNow } from './clock.js';
import { config } from './config.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { customerByPhone, sendMessage, shopBot } from './messaging.js';
import { pushTo } from './push.js';
import { busyRanges, durationOf, resolveService, workRanges, type Range } from './scheduling.js';
import { fromMinutes, toMinutes } from './time.js';

/**
 * Fila de chegada: quem vem sem horário marcado. Corre ao lado da agenda e nunca mexe nela: quem tem
 * horário mantém o horário dele, e a espera de cada um da fila é calculada só com os intervalos livres
 * de cada barbeiro (expediente menos horários marcados e bloqueios). O barbeiro chama o próximo quando
 * está livre; o atendimento fecha pela comanda, como qualquer outro.
 */

export type QueueStatus = 'waiting' | 'called' | 'serving' | 'done' | 'left';
const ACTIVE: QueueStatus[] = ['waiting', 'called', 'serving'];

export interface QueueRow {
  id: number;
  ticket: number;
  customer_id: number | null;
  name: string;
  phone: string | null;
  barber_id: number | null;
  barber_name: string | null;
  service_id: number | null;
  service_name: string | null;
  served_by: number | null;
  served_by_name: string | null;
  status: QueueStatus;
  source: 'qr' | 'balcao';
  token: string;
  created_at: string;
  called_at: string | null;
  started_at: string | null;
}

export interface QueueEntryView extends QueueRow {
  /** Posição entre os que esperam (1 = o próximo). */
  position: number | null;
  /** Previsão de início (HH:MM) e espera em minutos; null = hoje não dá mais tempo. */
  expected_at: string | null;
  wait_min: number | null;
}

export interface BarberQueueInfo {
  id: number;
  name: string;
  /** Quem ele está atendendo (ou chamou) agora, da fila. */
  current: { id: number; ticket: number; name: string; status: QueueStatus } | null;
  /** O próximo horário marcado de hoje: a fila não passa por cima dele. */
  next_appointment: { time: string; customer: string } | null;
  /** Até o próximo horário marcado (ou o fim do expediente), em minutos. */
  free_min: number;
}

const SELECT = `SELECT q.id, q.ticket, q.customer_id, q.name, q.phone, q.barber_id, b.name AS barber_name, q.service_id, s.name AS service_name,
  q.served_by, sb.name AS served_by_name, q.status, q.source, q.token, q.created_at, q.called_at, q.started_at
  FROM queue_entries q
  LEFT JOIN barbers b ON b.id = q.barber_id
  LEFT JOIN barbers sb ON sb.id = q.served_by
  LEFT JOIN catalog_items s ON s.id = q.service_id`;

const firstName = (name: string) => name.split(/\s+/)[0];

export const queueEnabled = (shopId: number) => Boolean(get<{ queue_enabled: number }>('SELECT queue_enabled FROM barbershops WHERE id = ?', [shopId])?.queue_enabled);

export function setQueueEnabled(shopId: number, enabled: boolean): void {
  run('UPDATE barbershops SET queue_enabled = ? WHERE id = ?', [enabled ? 1 : 0, shopId]);
}

export const queueLink = (slug: string) => `${config.appUrl}/b/${slug}/fila`;

/** Duração prevista do serviço (sem serviço escolhido, o corte padrão da barbearia). */
function serviceMinutes(shopId: number, serviceId: number | null): number {
  try {
    return durationOf(resolveService(shopId, serviceId));
  } catch {
    return durationOf(null);
  }
}

/** Minutos desde 00:00 a partir de um ISO, no relógio da barbearia. */
const minutesOf = (shopId: number, iso: string) => toMinutes(shopNow(shopId, new Date(iso)).time);

interface Lane {
  id: number;
  name: string;
  work: Range[];
  busy: Range[];
  freeAt: number;
}

/** Primeiro início possível a partir de `from`, dentro do expediente e sem encostar em horário marcado. */
function earliestStart(lane: Lane, from: number, duration: number): number | null {
  let t = from;
  for (let guard = 0; guard < 200; guard++) {
    const work = lane.work.find((w) => w.end - duration >= t && w.end > t);
    if (!work) return null;
    if (t < work.start) t = work.start;
    if (t + duration > work.end) {
      t = work.end;
      continue;
    }
    const clash = lane.busy.filter((b) => b.start < t + duration && t < b.end).sort((a, b) => b.end - a.end)[0];
    if (!clash) return t;
    t = clash.end;
  }
  return null;
}

function lanes(shopId: number, date: string, nowMin: number): Lane[] {
  const barbers = all<{ id: number; name: string }>('SELECT id, name FROM barbers WHERE barbershop_id = ? AND active = 1 ORDER BY name COLLATE NOCASE', [shopId]);
  return barbers
    .map((b) => ({ id: b.id, name: b.name, work: workRanges(b.id, date), busy: busyRanges(b.id, date), freeAt: nowMin }))
    .filter((l) => l.work.some((w) => w.end > nowMin));
}

/**
 * A fila de hoje com a previsão de cada um. Simula a ordem de chegada: cada um vai para o barbeiro
 * (o preferido, se escolheu) que puder começar antes, sem passar por cima de ninguém com horário marcado.
 */
export function queueView(shopId: number, now?: Date): { entries: QueueEntryView[]; barbers: BarberQueueInfo[]; nextFree: { expected_at: string | null; wait_min: number | null } } {
  const clock = shopNow(shopId, now);
  const nowMin = toMinutes(clock.time);
  const rows = all<QueueRow>(`${SELECT} WHERE q.barbershop_id = ? AND q.date = ? AND q.status IN ('waiting', 'called', 'serving') ORDER BY q.ticket`, [shopId, clock.date]);
  const ls = lanes(shopId, clock.date, nowMin);
  const byId = new Map(ls.map((l) => [l.id, l]));

  // Quem já foi chamado ou está na cadeira ocupa o barbeiro até terminar o serviço.
  for (const r of rows.filter((r) => r.status !== 'waiting' && r.served_by)) {
    const lane = byId.get(r.served_by!);
    if (!lane) continue;
    const begin = r.started_at ? minutesOf(shopId, r.started_at) : nowMin;
    lane.freeAt = Math.max(lane.freeAt, begin + serviceMinutes(shopId, r.service_id));
  }

  let position = 0;
  const entries: QueueEntryView[] = rows.map((r) => {
    if (r.status !== 'waiting') return { ...r, position: null, expected_at: null, wait_min: null };
    position++;
    const duration = serviceMinutes(shopId, r.service_id);
    const options = r.barber_id ? ls.filter((l) => l.id === r.barber_id) : ls;
    let best: { lane: Lane; start: number } | null = null;
    for (const lane of options) {
      const start = earliestStart(lane, lane.freeAt, duration);
      if (start != null && (!best || start < best.start)) best = { lane, start };
    }
    if (!best) return { ...r, position, expected_at: null, wait_min: null };
    best.lane.freeAt = best.start + duration;
    return { ...r, position, expected_at: fromMinutes(best.start), wait_min: Math.max(0, best.start - nowMin) };
  });

  // Quem chegar agora: o primeiro intervalo livre depois de todos que já estão esperando.
  const duration = serviceMinutes(shopId, null);
  let next: number | null = null;
  for (const lane of ls) {
    const start = earliestStart(lane, lane.freeAt, duration);
    if (start != null && (next == null || start < next)) next = start;
  }

  const barbers: BarberQueueInfo[] = ls.map((lane) => {
    const current = rows.find((r) => r.status !== 'waiting' && r.served_by === lane.id);
    const upcoming = get<{ starts_at: string; customer: string }>(
      `SELECT a.starts_at, c.name AS customer FROM appointments a JOIN customers c ON c.id = a.customer_id
        WHERE a.barber_id = ? AND a.status = 'scheduled' AND a.starts_at >= ? AND a.starts_at < ? ORDER BY a.starts_at LIMIT 1`,
      [lane.id, clock.stamp, `${clock.date} 24:00`],
    );
    const workEnd = Math.max(...lane.work.map((w) => w.end));
    const until = upcoming ? toMinutes(upcoming.starts_at.slice(11)) : workEnd;
    return {
      id: lane.id,
      name: lane.name,
      current: current ? { id: current.id, ticket: current.ticket, name: current.name, status: current.status } : null,
      next_appointment: upcoming ? { time: upcoming.starts_at.slice(11), customer: firstName(upcoming.customer) } : null,
      free_min: Math.max(0, until - nowMin),
    };
  });

  return { entries, barbers, nextFree: { expected_at: next == null ? null : fromMinutes(next), wait_min: next == null ? null : Math.max(0, next - nowMin) } };
}

export interface JoinInput {
  shopId: number;
  name: string;
  phone?: string | null;
  barberId?: number | null;
  serviceId?: number | null;
  source: 'qr' | 'balcao';
  /** Aceite da política de privacidade (entrada pelo QR, cliente novo). */
  privacyAccepted?: boolean;
  now?: Date;
}

/** Entra na fila de hoje. O cliente é achado (ou cadastrado) pelo celular, para o histórico e a fidelidade. */
export async function joinQueue(input: JoinInput): Promise<QueueEntryView> {
  const { shopId } = input;
  if (!queueEnabled(shopId)) throw new HttpError(409, 'Esta barbearia não está usando a fila de chegada.');
  const clock = shopNow(shopId, input.now);
  if (input.barberId && !get('SELECT 1 AS ok FROM barbers WHERE id = ? AND barbershop_id = ? AND active = 1', [input.barberId, shopId])) {
    throw new HttpError(404, 'Barbeiro não encontrado.');
  }
  if (input.serviceId) resolveService(shopId, input.serviceId);
  // Sem nenhum intervalo livre hoje, nem entra (não gasta senha).
  if (!input.barberId && queueView(shopId, input.now).nextFree.expected_at == null) {
    throw new HttpError(409, 'Hoje não dá mais tempo de atender pela fila. Que tal marcar um horário?');
  }

  const entry = tx(() => {
    let customerId: number | null = null;
    if (input.phone) {
      const existing = customerByPhone(shopId, input.phone);
      if (existing) {
        customerId = existing.id;
        if (get("SELECT 1 AS ok FROM queue_entries WHERE barbershop_id = ? AND date = ? AND customer_id = ? AND status IN ('waiting', 'called', 'serving')", [shopId, clock.date, customerId])) {
          throw new HttpError(409, 'Você já está na fila de hoje.');
        }
      } else {
        customerId = run('INSERT INTO customers (barbershop_id, name, phone, privacy_accepted_at, created_at) VALUES (?, ?, ?, ?, ?)', [
          shopId,
          input.name,
          input.phone,
          input.privacyAccepted ? nowIso() : null,
          nowIso(),
        ]).lastInsertRowid;
      }
    }
    const ticket = (get<{ n: number }>('SELECT COALESCE(MAX(ticket), 0) AS n FROM queue_entries WHERE barbershop_id = ? AND date = ?', [shopId, clock.date])?.n ?? 0) + 1;
    const id = run(
      `INSERT INTO queue_entries (barbershop_id, date, ticket, customer_id, name, phone, barber_id, service_id, source, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [shopId, clock.date, ticket, customerId, input.name, input.phone ?? null, input.barberId ?? null, input.serviceId ?? null, input.source, crypto.randomBytes(16).toString('base64url'), nowIso()],
    ).lastInsertRowid;
    return id;
  });

  const view = queueView(shopId, input.now).entries.find((e) => e.id === entry)!;
  if (view.expected_at == null) {
    // Hoje não cabe mais ninguém: sai da fila e avisa.
    run("UPDATE queue_entries SET status = 'left', finished_at = ? WHERE id = ?", [nowIso(), entry]);
    throw new HttpError(409, 'Hoje não dá mais tempo de atender pela fila. Que tal marcar um horário?');
  }
  if (input.phone && input.source === 'qr') {
    const shop = shopBot(shopId);
    await sendMessage({
      shop,
      customerId: view.customer_id,
      phone: input.phone,
      kind: 'fila',
      text: `Oi, ${firstName(input.name)}! Você entrou na fila da ${shop.name}: senha ${view.ticket}, ${view.position === 1 ? 'você é o próximo' : `${view.position! - 1} na sua frente`} (previsão ${view.expected_at}). Te aviso aqui quando for a sua vez. Acompanhe: ${queueLink(shop.slug)}?t=${view.token}`,
      template: { kind: 'fila', params: [firstName(input.name), shop.name, String(view.ticket), view.expected_at] },
    });
  }
  return view;
}

function entryOf(shopId: number, id: number): QueueRow {
  const row = get<QueueRow>(`${SELECT} WHERE q.id = ? AND q.barbershop_id = ?`, [id, shopId]);
  if (!row) throw new HttpError(404, 'Ninguém com essa senha na fila.');
  return row;
}

/** O barbeiro chama o próximo da fila (o primeiro que escolheu ele ou qualquer barbeiro). */
export async function callNext(shopId: number, barberId: number, now?: Date): Promise<QueueEntryView | null> {
  const clock = shopNow(shopId, now);
  const barber = get<{ id: number; name: string }>('SELECT id, name FROM barbers WHERE id = ? AND barbershop_id = ? AND active = 1', [barberId, shopId]);
  if (!barber) throw new HttpError(404, 'Barbeiro não encontrado.');
  if (get("SELECT 1 AS ok FROM queue_entries WHERE barbershop_id = ? AND date = ? AND served_by = ? AND status IN ('called', 'serving')", [shopId, clock.date, barberId])) {
    throw new HttpError(409, `O ${barber.name} ainda está com alguém da fila. Feche a comanda (ou marque que não veio) antes de chamar o próximo.`);
  }
  const next = get<{ id: number }>(
    "SELECT id FROM queue_entries WHERE barbershop_id = ? AND date = ? AND status = 'waiting' AND (barber_id IS NULL OR barber_id = ?) ORDER BY ticket LIMIT 1",
    [shopId, clock.date, barberId],
  );
  if (!next) return null;
  run("UPDATE queue_entries SET status = 'called', served_by = ?, called_at = ? WHERE id = ?", [barberId, nowIso(), next.id]);
  const entry = entryOf(shopId, next.id);
  const shop = shopBot(shopId);
  if (entry.phone) {
    await sendMessage({
      shop,
      customerId: entry.customer_id,
      phone: entry.phone,
      kind: 'fila',
      text: `${firstName(entry.name)}, é a sua vez na ${shop.name}! O ${barber.name} já vai te atender (senha ${entry.ticket}). 💈`,
      template: { kind: 'fila_vez', params: [firstName(entry.name), shop.name, barber.name, String(entry.ticket)] },
    });
  }
  if (entry.customer_id) {
    await pushTo({ shopId, customerId: entry.customer_id }, { title: 'É a sua vez! 💈', body: `O ${barber.name} já vai te atender (senha ${entry.ticket}).`, url: `/b/${shop.slug}/fila?t=${entry.token}`, tag: `fila-${entry.id}` });
  }
  return { ...entry, position: null, expected_at: null, wait_min: null };
}

/** Na cadeira: começou o atendimento (a previsão dos próximos passa a contar daqui). */
export function startEntry(shopId: number, id: number, barberId?: number): QueueRow {
  const e = entryOf(shopId, id);
  if (barberId && e.served_by && e.served_by !== barberId) throw new HttpError(404, 'Esse cliente da fila está com outro barbeiro.');
  if (e.status === 'waiting') {
    if (!barberId) throw new HttpError(400, 'Escolha o barbeiro que vai atender.');
    run("UPDATE queue_entries SET status = 'serving', served_by = ?, called_at = ?, started_at = ? WHERE id = ?", [barberId, nowIso(), nowIso(), id]);
  } else if (e.status === 'called') {
    run("UPDATE queue_entries SET status = 'serving', started_at = ? WHERE id = ?", [nowIso(), id]);
  } else if (e.status !== 'serving') {
    throw new HttpError(409, 'Esse atendimento já terminou.');
  }
  return entryOf(shopId, id);
}

/** Saiu da fila: desistiu, não respondeu quando foi chamado ou cancelou pelo link. */
export function leaveQueue(shopId: number, id: number, barberId?: number): void {
  const e = entryOf(shopId, id);
  if (barberId && e.served_by && e.served_by !== barberId) throw new HttpError(404, 'Esse cliente da fila está com outro barbeiro.');
  if (!ACTIVE.includes(e.status)) return;
  run("UPDATE queue_entries SET status = 'left', finished_at = ? WHERE id = ?", [nowIso(), id]);
}

/** Volta para a fila (chamado, mas foi ao banheiro / chegou depois): mantém a senha original. */
export function backToQueue(shopId: number, id: number): void {
  const e = entryOf(shopId, id);
  if (e.status !== 'called') throw new HttpError(409, 'Só quem foi chamado e ainda não sentou volta para a fila.');
  run("UPDATE queue_entries SET status = 'waiting', served_by = NULL, called_at = NULL WHERE id = ?", [id]);
}

/** Comanda fechada: o atendimento da fila termina junto (chamado de dentro da venda). */
export function finishFromSale(shopId: number, id: number, saleId: number, barberId?: number): { customerId: number | null } {
  const e = entryOf(shopId, id);
  if (barberId && e.served_by && e.served_by !== barberId) throw new HttpError(404, 'Esse cliente da fila está com outro barbeiro.');
  if (!ACTIVE.includes(e.status)) throw new HttpError(409, 'Esse atendimento da fila já foi fechado.');
  run("UPDATE queue_entries SET status = 'done', sale_id = ?, finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?", [saleId, nowIso(), nowIso(), id]);
  return { customerId: e.customer_id };
}

/** O que o cliente vê pelo link da senha. */
export function publicEntry(token: string, now?: Date) {
  const row = get<{ id: number; barbershop_id: number }>('SELECT id, barbershop_id FROM queue_entries WHERE token = ?', [token]);
  if (!row) throw new HttpError(404, 'Senha não encontrada.');
  const e = entryOf(row.barbershop_id, row.id);
  const view = ACTIVE.includes(e.status) ? queueView(row.barbershop_id, now).entries.find((x) => x.id === e.id) : null;
  return {
    ticket: e.ticket,
    name: firstName(e.name),
    status: e.status,
    position: view?.position ?? null,
    ahead: view?.position != null ? view.position - 1 : null,
    expected_at: view?.expected_at ?? null,
    wait_min: view?.wait_min ?? null,
    barber: e.status === 'waiting' ? e.barber_name : e.served_by_name,
    service: e.service_name,
  };
}

export function leaveByToken(token: string): void {
  const row = get<{ id: number; barbershop_id: number }>('SELECT id, barbershop_id FROM queue_entries WHERE token = ?', [token]);
  if (!row) throw new HttpError(404, 'Senha não encontrada.');
  leaveQueue(row.barbershop_id, row.id);
}
