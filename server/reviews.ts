import { shopNow, shopTz } from './clock.js';
import { all, get, run } from './db.js';
import { sendMessage, type CustomerRow, type ShopBot } from './messaging.js';
import { notifyOwners } from './platform.js';
import { addMinutes, isoToLocal } from './time.js';

/**
 * Avaliação depois do corte. Um tempo depois do horário (padrão 2h), o robô pergunta a nota de 1 a 5.
 * Nota 4 ou 5: agradece e manda o link de avaliação no Google (se a barbearia cadastrou).
 * Nota 1 a 3: pergunta o que dá para melhorar e passa o comentário para o dono.
 */

/** No máximo um pedido de avaliação por cliente a cada 30 dias (quem vem toda semana não é incomodado). */
const MIN_DAYS_BETWEEN = 30;
/** A pergunta vale por 2 dias; o comentário da nota baixa, por 1 dia. */
const ANSWER_HOURS = 48;
const COMMENT_HOURS = 24;

const firstName = (name: string) => name.split(/\s+/)[0];

interface Due {
  appt_id: number;
  ends_at: string;
  barber_id: number;
  barber_name: string;
  id: number;
  name: string;
  phone: string;
  wa_id: string | null;
}

/** Manda os pedidos de avaliação dos atendimentos que terminaram há pelo menos `review_delay_min`. */
export async function askReviews(shop: ShopBot, now: Date): Promise<number> {
  const s = get<{ review_enabled: number; review_delay_min: number }>('SELECT review_enabled, review_delay_min FROM barbershops WHERE id = ?', [shop.id])!;
  if (!s.review_enabled) return 0;
  const n = shopNow(shop.id, now);
  // Terminou há pelo menos o tempo de espera; até 1 dia depois disso (o que caiu à noite vai de manhã).
  const until = addMinutes(n.stamp, -s.review_delay_min);
  const since = addMinutes(until, -24 * 60);
  const recent = new Date(now.getTime() - MIN_DAYS_BETWEEN * 86400000).toISOString();
  const due = all<Due>(
    `SELECT a.id AS appt_id, a.ends_at, a.barber_id, b.name AS barber_name, c.id, c.name, c.phone, c.wa_id
       FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN barbers b ON b.id = a.barber_id
      WHERE a.barbershop_id = ? AND a.status = 'scheduled' AND a.ends_at <= ? AND a.ends_at >= ?
        AND c.reminders_opt_out = 0 AND c.anonymized_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.customer_id = c.id AND r.asked_at >= ?)
      ORDER BY a.ends_at`,
    [shop.id, until, since, recent],
  );
  let sent = 0;
  const asked = new Set<number>();
  for (const d of due) {
    if (asked.has(d.id)) continue;
    asked.add(d.id);
    run("UPDATE reviews SET status = 'expired' WHERE customer_id = ? AND status IN ('asked', 'comment')", [d.id]);
    run('INSERT INTO reviews (barbershop_id, customer_id, appointment_id, barber_id, asked_at) VALUES (?, ?, ?, ?, ?)', [shop.id, d.id, d.appt_id, d.barber_id, now.toISOString()]);
    await sendMessage({
      shop,
      customerId: d.id,
      phone: d.phone,
      waId: d.wa_id,
      kind: 'avaliacao',
      text: `Oi, ${firstName(d.name)}! Aqui é o ${shop.bot_name}, da ${shop.name}. Obrigado pela visita! 💈 Como foi seu atendimento com o ${d.barber_name}? Responda com uma nota de 1 a 5 ⭐`,
      template: { kind: 'avaliacao', params: [firstName(d.name), shop.name, d.barber_name] },
    });
    sent++;
  }
  return sent;
}

/** "5", "nota 4", "5 estrelas", "⭐⭐⭐⭐" → nota; outra coisa → null. */
export function parseRating(text: string): number | null {
  const stars = (text.match(/⭐/g) ?? []).length;
  if (stars >= 1 && stars <= 5 && !/\d/.test(text)) return stars;
  const t = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[⭐!.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(?:nota\s*)?([1-5])(?:\s*(?:estrelas?|de 5|\/5))?$/.exec(t);
  return m ? Number(m[1]) : null;
}

interface Pending {
  id: number;
  status: 'asked' | 'comment';
  rating: number | null;
  asked_at: string;
  answered_at: string | null;
  barber_name: string | null;
}

/** Resposta do cliente a um pedido de avaliação (nota ou comentário). Devolve a resposta do robô, ou null. */
export async function handleReviewReply(shop: ShopBot, customer: CustomerRow, text: string, now: Date): Promise<string | null> {
  const p = get<Pending>(
    `SELECT r.id, r.status, r.rating, r.asked_at, r.answered_at, b.name AS barber_name FROM reviews r LEFT JOIN barbers b ON b.id = r.barber_id
      WHERE r.customer_id = ? AND r.status IN ('asked', 'comment') ORDER BY r.id DESC LIMIT 1`,
    [customer.id],
  );
  if (!p) return null;
  const hoursSince = (iso: string) => (now.getTime() - new Date(iso).getTime()) / 3600000;

  if (p.status === 'asked') {
    if (hoursSince(p.asked_at) > ANSWER_HOURS) {
      run("UPDATE reviews SET status = 'expired' WHERE id = ?", [p.id]);
      return null;
    }
    const rating = parseRating(text);
    if (rating == null) return null;
    // Só vale como nota se a última mensagem do robô foi o pedido de avaliação (um "2" pode ser a escolha de um horário).
    const last = get<{ kind: string }>("SELECT kind FROM messages WHERE barbershop_id = ? AND customer_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", [shop.id, customer.id]);
    if (last?.kind !== 'avaliacao') return null;
    const link = get<{ review_link: string | null }>('SELECT review_link FROM barbershops WHERE id = ?', [shop.id])?.review_link;
    if (rating >= 4) {
      run("UPDATE reviews SET rating = ?, status = 'done', answered_at = ? WHERE id = ?", [rating, now.toISOString(), p.id]);
      return `Valeu demais, ${firstName(customer.name)}! 🙏${link ? `\nSe puder, deixa essa avaliação no Google também, ajuda muito a barbearia: ${link}` : ''}`;
    }
    run("UPDATE reviews SET rating = ?, status = 'comment', answered_at = ? WHERE id = ?", [rating, now.toISOString(), p.id]);
    return 'Poxa, sinto muito. 😕 O que a gente pode melhorar? Pode escrever aqui que eu passo direto para o dono da barbearia.';
  }

  // Nota baixa: a próxima mensagem é o comentário (vale por 1 dia).
  if (hoursSince(p.answered_at ?? p.asked_at) > COMMENT_HOURS || parseRating(text) != null) {
    run("UPDATE reviews SET status = 'done' WHERE id = ?", [p.id]);
    return null;
  }
  const plain = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim();
  // Mudou de assunto (quer marcar, cancelar...): segue o atendimento normal.
  if (/marc|agend|horari|cancel|vaga|cartao|voucher|parar/.test(plain)) {
    run("UPDATE reviews SET status = 'done' WHERE id = ?", [p.id]);
    return null;
  }
  if (['nao', 'n', 'nada', 'nao obrigado', 'tudo bem', 'ok', 'deixa', 'deixa pra la'].includes(plain)) {
    run("UPDATE reviews SET status = 'done' WHERE id = ?", [p.id]);
    return 'Tudo bem! Obrigado pela nota, ela ajuda a gente a melhorar. 👊';
  }
  run("UPDATE reviews SET comment = ?, status = 'done' WHERE id = ?", [text.trim().slice(0, 1000), p.id]);
  const who = `${customer.name}${p.barber_name ? ` (atendido pelo ${p.barber_name})` : ''}`;
  const said = text.trim().slice(0, 300);
  await notifyOwners(shop.id, `Avaliação ${p.rating}/5 na ${shop.name}: ${who} escreveu: "${said}". Vale um contato com o cliente.`, {
    kind: 'nota_baixa',
    params: [String(p.rating), shop.name, who, said],
  });
  return 'Obrigado por contar. Já passei para o dono da barbearia, e a gente vai caprichar ainda mais na próxima. 👊';
}

/** Painel: média geral, por barbeiro e as avaliações recentes. */
export function reviewsOverview(shopId: number, days = 90) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const tz = shopTz(shopId);
  const settings = get<{ review_enabled: number; review_delay_min: number; review_link: string | null }>(
    'SELECT review_enabled, review_delay_min, review_link FROM barbershops WHERE id = ?',
    [shopId],
  )!;
  const totals = get<{ n: number; avg: number | null; asked: number }>(
    `SELECT COUNT(rating) AS n, AVG(rating) AS avg, COUNT(*) AS asked FROM reviews WHERE barbershop_id = ? AND asked_at >= ?`,
    [shopId, since],
  )!;
  return {
    settings: { ...settings, review_enabled: Boolean(settings.review_enabled) },
    days,
    count: totals.n,
    asked: totals.asked,
    average: totals.avg == null ? null : Math.round(totals.avg * 10) / 10,
    byBarber: all<{ barber_id: number; name: string; n: number; avg: number }>(
      `SELECT b.id AS barber_id, b.name, COUNT(r.rating) AS n, ROUND(AVG(r.rating), 1) AS avg
         FROM reviews r JOIN barbers b ON b.id = r.barber_id
        WHERE r.barbershop_id = ? AND r.rating IS NOT NULL AND r.asked_at >= ? GROUP BY b.id ORDER BY avg DESC`,
      [shopId, since],
    ),
    recent: all<{ id: number; rating: number; comment: string | null; answered_at: string; customer: string; phone: string; barber: string | null }>(
      `SELECT r.id, r.rating, r.comment, r.answered_at, c.name AS customer, c.phone, b.name AS barber
         FROM reviews r JOIN customers c ON c.id = r.customer_id LEFT JOIN barbers b ON b.id = r.barber_id
        WHERE r.barbershop_id = ? AND r.rating IS NOT NULL ORDER BY r.answered_at DESC LIMIT 50`,
      [shopId],
    ).map((r) => ({ ...r, answered_local: isoToLocal(r.answered_at, tz) })),
  };
}

const ninetyDaysAgo = () => new Date(Date.now() - 90 * 86400000).toISOString();

/** Nota média de um barbeiro (área do barbeiro). */
export const barberRating = (barberId: number) =>
  get<{ n: number; avg: number | null }>('SELECT COUNT(rating) AS n, ROUND(AVG(rating), 1) AS avg FROM reviews WHERE barber_id = ? AND asked_at >= ?', [barberId, ninetyDaysAgo()])!;

/** Nota média da barbearia (resumo do painel). */
export const shopRating = (shopId: number) =>
  get<{ n: number; avg: number | null }>('SELECT COUNT(rating) AS n, ROUND(AVG(rating), 1) AS avg FROM reviews WHERE barbershop_id = ? AND asked_at >= ?', [shopId, ninetyDaysAgo()])!;

