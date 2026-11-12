import { shopNow } from './clock.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { sendMessage, sendsTemplate, type ShopBot } from './messaging.js';
import { appointment, type AppointmentView } from './scheduling.js';
import { addMinutes, dayLabel, hourLabel } from './time.js';

/**
 * Confirmação de presença (no lugar do sinal, para diminuir as faltas): o lembrete pede SIM para
 * confirmar ou NÃO para liberar a vaga, que vai na hora para a lista de espera. Se a barbearia
 * quiser, quem não responde até X horas antes tem o horário liberado sozinho.
 */

/** Liberação automática só neste horário (do relógio da barbearia): ninguém recebe mensagem de madrugada. */
const RELEASE_FROM = '07:00';
const RELEASE_UNTIL = '22:00';
/** O cliente precisa ter tido pelo menos este tempo para responder antes de o horário ser liberado. */
const MIN_ANSWER_MINUTES = 60;

const firstName = (name: string) => name.split(/\s+/)[0];
const when = (startsAt: string) => `${dayLabel(startsAt.slice(0, 10))} às ${hourLabel(startsAt.slice(11, 16))}`;

/** Guarda a pergunta do lembrete para o próximo SIM/NÃO do cliente no WhatsApp. */
export function askPresence(shopId: number, customerId: number, appointmentId: number, now: Date = new Date()): void {
  run("UPDATE bot_questions SET status = 'expired' WHERE customer_id = ? AND status = 'pending'", [customerId]);
  run("INSERT INTO bot_questions (barbershop_id, customer_id, appointment_id, kind, payload, created_at) VALUES (?, ?, ?, 'presenca', '{}', ?)", [
    shopId,
    customerId,
    appointmentId,
    now.toISOString(),
  ]);
}

/** Confirma a presença (cliente pela área ou pelo WhatsApp; o dono pelo painel, quando o cliente avisa de outro jeito). */
export function confirmAppointment(shopId: number, appointmentId: number, opts: { customerId?: number; confirmed?: boolean; now?: Date } = {}): AppointmentView {
  const a = appointment(appointmentId);
  const owned = a && get('SELECT 1 AS ok FROM appointments WHERE id = ? AND barbershop_id = ?', [appointmentId, shopId]);
  if (!a || !owned || (opts.customerId && a.customer_id !== opts.customerId)) throw new HttpError(404, 'Horário não encontrado.');
  if (a.status !== 'scheduled') throw new HttpError(409, 'Esse horário foi cancelado.');
  if (a.starts_at < shopNow(shopId, opts.now).stamp) throw new HttpError(409, 'Esse horário já passou.');
  const confirmed = opts.confirmed ?? true;
  run('UPDATE appointments SET confirmed_at = ? WHERE id = ?', [confirmed ? (opts.now ?? new Date()).toISOString() : null, appointmentId]);
  // A pergunta do lembrete fica respondida.
  if (confirmed) run("UPDATE bot_questions SET status = 'yes' WHERE appointment_id = ? AND kind = 'presenca' AND status = 'pending'", [appointmentId]);
  return appointment(appointmentId)!;
}

/**
 * Quem não confirmou até `confirm_release_hours` antes do horário tem a vaga liberada (só se o lembrete
 * pediu a confirmação e a pergunta ainda está sem resposta). Na mesma rodada das automações, a vaga é
 * oferecida para a lista de espera.
 */
export async function releaseUnconfirmed(shop: ShopBot & { confirm_release_hours?: number | null }, now: Date = new Date()): Promise<number> {
  const hours = shop.confirm_release_hours;
  if (!hours) return 0;
  const n = shopNow(shop.id, now);
  if (n.time < RELEASE_FROM || n.time >= RELEASE_UNTIL) return 0;
  const askedBefore = new Date(now.getTime() - MIN_ANSWER_MINUTES * 60000).toISOString();
  const due = all<{ id: number; customer_id: number; name: string; phone: string; wa_id: string | null; starts_at: string }>(
    `SELECT a.id, a.customer_id, c.name, c.phone, c.wa_id, a.starts_at
       FROM appointments a JOIN customers c ON c.id = a.customer_id
      WHERE a.barbershop_id = ? AND a.status = 'scheduled' AND a.confirmed_at IS NULL AND a.starts_at > ? AND a.starts_at <= ?
        AND EXISTS (SELECT 1 FROM bot_questions q WHERE q.appointment_id = a.id AND q.kind = 'presenca' AND q.status = 'pending' AND q.created_at <= ?)`,
    [shop.id, n.stamp, addMinutes(n.stamp, hours * 60), askedBefore],
  );
  for (const a of due) {
    run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, notes = COALESCE(notes || ' · ', '') || 'Liberado: sem confirmação' WHERE id = ?", [
      nowIso(),
      a.id,
    ]);
    run("UPDATE bot_questions SET status = 'expired' WHERE appointment_id = ? AND status = 'pending'", [a.id]);
    await sendMessage({
      shop,
      customerId: a.customer_id,
      phone: a.phone,
      waId: a.wa_id,
      kind: 'liberado',
      text: `Oi, ${firstName(a.name)}! Como não recebemos a sua confirmação, liberamos o horário de ${when(a.starts_at)} na ${shop.name}. Se ainda quiser vir, me chame que eu vejo outro horário pra você. 👊`,
      template: { kind: 'liberado', params: [firstName(a.name), when(a.starts_at), shop.name] },
    });
  }
  return due.length;
}

/** O lembrete pode pedir a confirmação pelo texto livre ou pelo modelo aprovado (que também pede SIM). */
export const presenceText = (shop: ShopBot, phone: string) =>
  sendsTemplate(shop, phone) ? '' : ' Você confirma? Responda *SIM* para confirmar ou *NÃO* se não puder vir.';
