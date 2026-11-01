import { platformSettings } from './billing.js';
import { shopNow } from './clock.js';
import { all, get, nowIso, run } from './db.js';
import { lastVisitDate } from './habits.js';
import { HttpError } from './http.js';
import { sendMessage, shopBot } from './messaging.js';
import { addDays } from './time.js';

/**
 * Promoções no WhatsApp para um grupo de clientes (todos, de um barbeiro, sumidos, aniversariantes do
 * mês ou assinantes do clube). Na API oficial cada uma é mensagem de marketing paga à Meta, então há
 * prévia com o custo, limite por mês e um intervalo mínimo entre promoções para o mesmo cliente.
 * Quem respondeu PARAR nunca recebe.
 */

export type Segment =
  | { type: 'todos' }
  | { type: 'barbeiro'; barberId: number }
  | { type: 'sumidos'; days: number }
  | { type: 'aniversariantes' }
  | { type: 'clube' };

/** Dias sem receber outra promoção antes de poder receber a próxima. */
export const BROADCAST_GAP_DAYS = 7;
const OPT_OUT = '(Para não receber promoções, responda PARAR.)';

interface Person {
  id: number;
  name: string;
  phone: string;
  wa_id: string | null;
}

const firstName = (name: string) => name.split(/\s+/)[0];

/** Quem recebe: o grupo, menos quem pediu para parar e quem recebeu promoção nos últimos dias. */
export function audience(shopId: number, segment: Segment, now?: Date): Person[] {
  const clock = shopNow(shopId, now);
  const since = new Date((now ?? new Date()).getTime() - BROADCAST_GAP_DAYS * 86400000).toISOString();
  const people = all<Person & { birth_date: string | null }>(
    `SELECT c.id, c.name, c.phone, c.wa_id, c.birth_date FROM customers c
      WHERE c.barbershop_id = ? AND c.anonymized_at IS NULL AND c.reminders_opt_out = 0 AND c.phone IS NOT NULL AND c.phone <> ''
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.barbershop_id = c.barbershop_id AND m.customer_id = c.id AND m.kind = 'campanha' AND m.created_at >= ?)
      ORDER BY c.id`,
    [shopId, since],
  );
  switch (segment.type) {
    case 'todos':
      return people;
    case 'barbeiro':
      // Quem cortou por último com ele.
      return people.filter(
        (p) =>
          get<{ barber_id: number }>("SELECT barber_id FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at < ? ORDER BY starts_at DESC LIMIT 1", [
            p.id,
            clock.stamp,
          ])?.barber_id === segment.barberId,
      );
    case 'sumidos': {
      const limit = addDays(clock.date, -segment.days);
      return people.filter((p) => {
        const last = lastVisitDate(p.id, now);
        return last != null && last <= limit;
      });
    }
    case 'aniversariantes':
      return people.filter((p) => p.birth_date?.slice(0, 2) === clock.date.slice(5, 7));
    case 'clube':
      return people.filter((p) => get("SELECT 1 AS ok FROM club_members WHERE customer_id = ? AND status = 'active'", [p.id]));
  }
}

/** Promoções enviadas no mês (para o limite) e quanto ainda cabe. */
export function broadcastUsage(shopId: number, now?: Date) {
  const month = shopNow(shopId, now).date.slice(0, 7);
  const used =
    get<{ n: number }>('SELECT COALESCE(SUM(recipients), 0) AS n FROM broadcasts WHERE barbershop_id = ? AND month = ?', [shopId, month])?.n ?? 0;
  const limit = platformSettings().broadcast_monthly_limit;
  return { month, used, limit, left: Math.max(0, limit - used) };
}

/** Custo estimado na Meta (só na API oficial; pelo QR Code não há cobrança por mensagem). */
export function estimatedCost(shopId: number, count: number): number | null {
  return shopBot(shopId).wa_provider === 'meta' ? count * platformSettings().marketing_msg_cost_cents : null;
}

export function previewBroadcast(shopId: number, segment: Segment, now?: Date) {
  const people = audience(shopId, segment, now);
  return { count: people.length, cost_cents: estimatedCost(shopId, people.length), sample: people.slice(0, 5).map((p) => firstName(p.name)), usage: broadcastUsage(shopId, now) };
}

export function segmentLabel(shopId: number, s: Segment): string {
  if (s.type === 'todos') return 'Todos os clientes';
  if (s.type === 'barbeiro') return `Clientes do ${get<{ name: string }>('SELECT name FROM barbers WHERE id = ?', [s.barberId])?.name ?? 'barbeiro'}`;
  if (s.type === 'sumidos') return `Sem vir há ${s.days} dias ou mais`;
  if (s.type === 'aniversariantes') return 'Aniversariantes do mês';
  return 'Assinantes do clube';
}

/** Registra a promoção (o grupo fica fixo agora) e devolve o número; o envio roda em seguida (runBroadcast). */
export function createBroadcast(input: { shopId: number; userId: number | null; segment: Segment; text: string; now?: Date }): number {
  const { shopId } = input;
  const text = input.text.trim();
  if (text.length < 10) throw new HttpError(400, 'Escreva a mensagem da promoção.');
  if (input.segment.type === 'barbeiro' && !get('SELECT 1 AS ok FROM barbers WHERE id = ? AND barbershop_id = ?', [input.segment.barberId, shopId])) {
    throw new HttpError(404, 'Barbeiro não encontrado.');
  }
  const people = audience(shopId, input.segment, input.now);
  if (!people.length) throw new HttpError(400, 'Ninguém nesse grupo pode receber agora (ou pediram para não receber, ou já receberam promoção nos últimos dias).');
  const usage = broadcastUsage(shopId, input.now);
  if (people.length > usage.left) {
    throw new HttpError(409, `Passa do limite de promoções do mês: sobram ${usage.left} mensagens de ${usage.limit}. Escolha um grupo menor.`);
  }
  return run(
    `INSERT INTO broadcasts (barbershop_id, segment, label, text, recipients, customer_ids, cost_cents, month, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    [
      shopId,
      JSON.stringify(input.segment),
      segmentLabel(shopId, input.segment),
      text,
      people.length,
      JSON.stringify(people.map((p) => p.id)),
      estimatedCost(shopId, people.length),
      usage.month,
      input.userId,
      nowIso(),
    ],
  ).lastInsertRowid;
}

/** Envia, uma por uma, com o nome de cada cliente. Roda uma vez só por promoção. */
export async function runBroadcast(id: number): Promise<void> {
  const { changes } = run("UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'queued'", [id]);
  if (!changes) return;
  const b = get<{ barbershop_id: number; text: string; customer_ids: string }>('SELECT barbershop_id, text, customer_ids FROM broadcasts WHERE id = ?', [id])!;
  const shop = shopBot(b.barbershop_id);
  let sent = 0;
  let failed = 0;
  for (const customerId of JSON.parse(b.customer_ids) as number[]) {
    // Quem pediu para parar no meio do caminho não recebe.
    const c = get<Person & { reminders_opt_out: number }>('SELECT id, name, phone, wa_id, reminders_opt_out FROM customers WHERE id = ?', [customerId]);
    if (!c || c.reminders_opt_out) continue;
    const body = b.text.replace(/\{nome\}/gi, firstName(c.name));
    const r = await sendMessage({
      shop,
      customerId: c.id,
      phone: c.phone,
      waId: c.wa_id,
      kind: 'campanha',
      text: `${body}\n\n${OPT_OUT}`,
      // Modelo de marketing da Meta: o texto da promoção vai numa variável (sem quebras de linha).
      template: { kind: 'campanha', params: [firstName(c.name), shop.name, body.replace(/\s*\n+\s*/g, ' ').slice(0, 900)] },
    });
    if (r.status === 'failed') failed++;
    else sent++;
    run('UPDATE broadcasts SET sent = ?, failed = ? WHERE id = ?', [sent, failed, id]);
  }
  run("UPDATE broadcasts SET status = 'sent', finished_at = ? WHERE id = ?", [nowIso(), id]);
}

export function listBroadcasts(shopId: number) {
  return all<{ id: number; label: string; text: string; recipients: number; sent: number; failed: number; cost_cents: number | null; status: string; created_at: string }>(
    'SELECT id, label, text, recipients, sent, failed, cost_cents, status, created_at FROM broadcasts WHERE barbershop_id = ? ORDER BY id DESC LIMIT 30',
    [shopId],
  );
}
