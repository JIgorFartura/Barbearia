import { config } from '../config.js';
import { issueAccessLink } from '../customerAuth.js';
import { get, run } from '../db.js';
import { HttpError } from '../http.js';
import { customerCard } from '../loyalty.js';
import { customerByPhone, recentHistory, recordInbound, sendMessage, shopBot, type CustomerRow, type ShopBot } from '../messaging.js';
import { book, cancel, freeTimes, upcomingFor } from '../scheduling.js';
import { shopNow } from '../clock.js';
import { addDays, dayLabel, hourLabel } from '../time.js';
import { localPhone } from '../whatsapp.js';
import { accessStatus } from '../billing.js';
import { askConsumption, describeItems, reserveItems, type Usual } from '../consumption.js';
import { handleReviewReply } from '../reviews.js';
import { claimLatest } from '../charges.js';
import { confirmAppointment } from '../attendance.js';
import { slotFreed } from '../waitlist.js';
import { llmEnabled, think, type CreateMessage } from './brain.js';

export interface InboundInput {
  shopId: number;
  /** Número de quem mandou (com ou sem 55). */
  from: string;
  text: string;
  name?: string | null;
  externalId?: string | null;
  /** Simulador do painel: responde sem mandar nada pelo WhatsApp. */
  dryRun?: boolean;
  now?: Date;
  /** Substitui a chamada ao Claude (testes). */
  create?: CreateMessage;
}

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const normalize = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const YES = new Set([
  'sim', 's', 'ss', 'sim sim', 'pode', 'pode sim', 'pode ser', 'pode marcar', 'sim pode', 'confirmo', 'confirmar', 'confirma', 'confirmado',
  'bora', 'fechado', 'fechou', 'ok', 'okay', 'quero', 'quero sim', 'sim quero', 'sim por favor', 'claro', 'beleza', 'blz', 'marca', 'marcar',
  'show', 'perfeito', 'combinado',
]);
const NO = new Set(['nao', 'n', 'nao quero', 'agora nao', 'nao obrigado', 'nao posso', 'nao vou', 'nao da', 'essa semana nao', 'negativo', 'dessa vez nao']);
const STOP = new Set(['parar', 'pare', 'sair', 'stop']);
const RESUME = new Set(['voltar', 'retomar']);
const CANCEL = new Set(['cancelar', 'cancela', 'desmarcar']);
const PAID = /^(ja )?(paguei|pago|ta pago|esta pago|fiz o pix|pix feito|pix enviado|mandei o pix|transferi)( ja)?$/;

const firstName = (name: string) => name.split(/\s+/)[0];

/**
 * Respostas certeiras que não precisam de IA: SIM/NÃO para a confirmação de presença do lembrete,
 * para o horário oferecido (costume, lista de espera...) ou para a pergunta do consumo ("posso avisar
 * o Paulo da sua cerveja?"), PARAR/VOLTAR, CANCELAR.
 */
async function quickReply(shop: ShopBot, customer: CustomerRow | null, text: string, now: Date, dryRun: boolean): Promise<string | null> {
  if (!customer) return null;
  const t = normalize(text);
  const nowStamp = shopNow(shop.id, now).stamp;

  if (STOP.has(t)) {
    run('UPDATE customers SET reminders_opt_out = 1 WHERE id = ?', [customer.id]);
    return 'Pronto, não vou mais mandar lembretes automáticos. O aviso de horário marcado continua. Se quiser voltar, responda VOLTAR.';
  }
  if (RESUME.has(t)) {
    run('UPDATE customers SET reminders_opt_out = 0 WHERE id = ?', [customer.id]);
    return `Feito, ${firstName(customer.name)}! Voltei a te lembrar do seu horário de costume. 👊`;
  }
  if (CANCEL.has(t)) {
    const next = upcomingFor(customer.id, now)[0];
    if (!next) return 'Você não tem nenhum horário marcado no momento.';
    cancel(shop.id, next.id, { customerId: customer.id, now });
    // A vaga vai na hora para quem está na lista de espera (no simulador, só na rodada das automações).
    if (!dryRun) slotFreed(shop.id);
    return `Cancelado: ${dayLabel(next.starts_at.slice(0, 10))} às ${hourLabel(next.starts_at.slice(11))} com ${next.barber_name}. Quando quiser remarcar, é só chamar.`;
  }
  // "Paguei": avisa a barbearia do PIX da mensalidade do clube em aberto (e lembra do comprovante).
  if (PAID.test(t)) {
    const c = claimLatest(shop.id, customer.id, now);
    if (c) {
      return `Anotado, ${firstName(customer.name)}! Assim que a barbearia conferir o PIX, fica tudo certo com o seu clube. Pode usar os benefícios normalmente. 👊\nSe quiser, mande o comprovante pela sua área, que ele vai direto para a barbearia: ${issueAccessLink(customer.id, shop.slug)}`;
    }
  }
  // Resposta ao pedido de avaliação (nota de 1 a 5 e, se baixa, o comentário).
  const review = await handleReviewReply(shop, customer, text, now);
  if (review) return review;
  if (!YES.has(t) && !NO.has(t)) return null;

  // Vale a pergunta mais recente: a confirmação do lembrete, a do consumo (feita depois de marcar) ou a oferta de horário.
  const question = get<{ id: number; kind: string; appointment_id: number; starts_at: string; payload: string; created_at: string }>(
    `SELECT q.id, q.kind, q.appointment_id, a.starts_at, q.payload, q.created_at FROM bot_questions q JOIN appointments a ON a.id = q.appointment_id
      WHERE q.customer_id = ? AND q.status = 'pending' AND a.status = 'scheduled' AND a.starts_at > ? ORDER BY q.id DESC LIMIT 1`,
    [customer.id, nowStamp],
  );
  const offer = get<{ id: number; kind: string; barber_id: number; service_id: number | null; starts_at: string; discount_percent: number | null; created_at: string }>(
    "SELECT id, kind, barber_id, service_id, starts_at, discount_percent, created_at FROM bot_offers WHERE customer_id = ? AND status = 'pending' AND starts_at > ? ORDER BY id DESC LIMIT 1",
    [customer.id, nowStamp],
  );

  if (question?.kind === 'presenca' && (!offer || question.created_at >= offer.created_at)) {
    const when = `${dayLabel(question.starts_at.slice(0, 10))} às ${hourLabel(question.starts_at.slice(11))}`;
    if (NO.has(t)) {
      run("UPDATE bot_questions SET status = 'no' WHERE id = ?", [question.id]);
      cancel(shop.id, question.appointment_id, { customerId: customer.id, now });
      if (!dryRun) slotFreed(shop.id);
      return `Tudo bem, ${firstName(customer.name)}: cancelei seu horário de ${when}. Obrigado por avisar! Quando quiser remarcar, é só me chamar. 👊`;
    }
    confirmAppointment(shop.id, question.appointment_id, { customerId: customer.id, now });
    // Confirmou: se ele costuma consumir algo, já pergunta se pode deixar separado.
    const ask = askConsumption(shop.id, question.appointment_id, now);
    return `Confirmado, ${firstName(customer.name)}! ✅ Te espero ${when}.${ask ? `\n${ask}` : ''}`;
  }

  if (question && (!offer || question.created_at >= offer.created_at)) {
    if (NO.has(t)) {
      run("UPDATE bot_questions SET status = 'no' WHERE id = ?", [question.id]);
      return 'Beleza! Até lá. 👊';
    }
    try {
      const items = (JSON.parse(question.payload) as Usual[]).map((u) => ({ productId: u.productId, qty: u.qty }));
      const r = await reserveItems(shop.id, question.appointment_id, items, 'whatsapp', { customerId: customer.id, dryRun, now });
      return `Fechado! ${r.barberNotified ? `Avisei o ${r.barber}` : `Anotei pro ${r.barber}`}: ${describeItems(r.items)} separado pra você. ✅`;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      run("UPDATE bot_questions SET status = 'expired' WHERE id = ?", [question.id]);
      return null;
    }
  }

  if (!offer) return null;
  if (NO.has(t)) {
    run("UPDATE bot_offers SET status = 'declined' WHERE id = ?", [offer.id]);
    return offer.kind === 'espera'
      ? 'Tudo bem! Você continua na lista de espera desse dia: se abrir outra vaga, eu aviso. 👊'
      : 'Tranquilo! Quando quiser marcar, é só me chamar. 👊';
  }
  const date = offer.starts_at.slice(0, 10);
  const time = offer.starts_at.slice(11);
  try {
    // Oferta do horário vazio: vale o desconto prometido (mesmo que o dono mude a regra depois).
    const promoPercent = offer.discount_percent ?? undefined;
    const a = book({ shopId: shop.id, customerId: customer.id, barberId: offer.barber_id, serviceId: offer.service_id, date, time, source: 'whatsapp', promoPercent, now });
    run("UPDATE bot_offers SET status = 'accepted', appointment_id = ? WHERE id = ?", [a.id, offer.id]);
    const ask = askConsumption(shop.id, a.id, now);
    const price = a.promo_percent ? `, com ${a.promo_percent}% de desconto: ${money(a.price_cents)}` : '';
    return `Fechado, ${firstName(customer.name)}! ✅ ${dayLabel(date)} às ${hourLabel(time)} com ${a.barber_name} (${a.service_name}${price}). Te espero!${ask ? `\n${ask}` : ''}`;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    run("UPDATE bot_offers SET status = 'expired' WHERE id = ?", [offer.id]);
    const alt = freeTimes(shop.id, date, { barberId: offer.barber_id, serviceId: offer.service_id, now }).flatMap((d) => d.times.map((x) => `${hourLabel(x)}`));
    return alt.length
      ? `Esse horário acabou de ser ocupado 😕. No mesmo dia ainda tenho: ${alt.slice(0, 4).join(', ')}. Qual prefere?`
      : `Esse horário acabou de ser ocupado 😕. Me diga outro dia e horário que eu vejo pra você.`;
  }
}

/**
 * Foto, áudio ou arquivo: o robô só lê texto. Com a mensalidade do clube em aberto, quase sempre é o
 * comprovante do PIX: manda o link da área do cliente, onde ele envia o arquivo para a barbearia.
 */
function mediaReply(shop: ShopBot, customer: CustomerRow | null): string {
  if (customer && get("SELECT 1 AS ok FROM charges WHERE customer_id = ? AND status = 'open'", [customer.id])) {
    return `Por aqui eu só consigo ler texto. 🙂 Se for o comprovante do PIX do clube, mande pela sua área, que ele vai direto para a barbearia: ${issueAccessLink(customer.id, shop.slug)}`;
  }
  return 'Por enquanto eu só entendo mensagens de texto. Pode escrever pra mim? 🙂';
}

/** Sem chave da Anthropic: menu simples por palavras-chave. */
function fallbackReply(shop: ShopBot, customer: CustomerRow | null, text: string, now: Date): string {
  const hello = `Oi${customer ? `, ${firstName(customer.name)}` : ''}! Aqui é o ${shop.bot_name}, da ${shop.name}. 💈`;
  if (!customer) return `${hello}\nPara agendar, ver seu cartão fidelidade e pegar benefícios, faça seu cadastro: ${config.appUrl}/b/${shop.slug}/conta`;
  const t = normalize(text);
  if (/cart|carimb|premio|fidelidade|falta|cerveja|ponto/.test(t)) {
    const card = customerCard(shop.id, customer.id);
    if (!card.length) return 'Não tem campanha de fidelidade valendo agora. Fique de olho!';
    return card
      .map(({ campaign: c, progress: p }) =>
        p.available > 0
          ? `*${c.name}*: você tem ${p.available} prêmio(s) para retirar: ${c.reward}! 🎉`
          : `*${c.name}*: ${p.stamps} de ${c.goal} ${c.unit_label}. ${c.goal - p.stamps === 1 ? 'Falta só 1' : `Faltam ${c.goal - p.stamps}`} para ganhar ${c.reward}.`,
      )
      .join('\n');
  }
  const link = issueAccessLink(customer.id, shop.slug);
  if (/horario|agenda|vaga|marcar|agendar|corte/.test(t)) {
    const today = shopNow(shop.id, now).date;
    const parts: string[] = [];
    for (const date of [today, addDays(today, 1)]) {
      const times = freeTimes(shop.id, date, { now }).flatMap((d) => d.times.map((x) => `${hourLabel(x)} (${d.barber.name})`));
      if (times.length) parts.push(`${dayLabel(date)}: ${times.slice(0, 5).join(', ')}`);
    }
    return `${parts.length ? `Horários livres:\n${parts.join('\n')}\n` : ''}Para marcar, escolha o horário na sua área: ${link}`;
  }
  return `${hello}\nResponda *CARTÃO* para ver seus carimbos, *HORÁRIOS* para ver vagas ou *CANCELAR* para desmarcar seu próximo horário.\nSua área (agenda e vouchers): ${link}`;
}

// Uma conversa por vez para cada celular: mensagens seguidas são respondidas em ordem.
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next);
  void next.finally(() => queues.get(key) === next && queues.delete(key)).catch(() => undefined);
  return next;
}

/** Mensagem que chegou no WhatsApp (ou no simulador): grava, decide a resposta e envia. */
export async function handleInbound(input: InboundInput): Promise<string | null> {
  const shop = shopBot(input.shopId);
  if (!shop.active) return null;
  const local = localPhone(input.from);
  if (local.length < 10 || local.length > 11) return null;
  const now = input.now ?? new Date();

  return serialize(`${shop.id}:${local.slice(-8)}`, async () => {
    let customer = customerByPhone(shop.id, local) ?? null;
    const phone = customer?.phone ?? local;
    const waId = input.dryRun ? null : input.from.replace(/\D/g, '');
    if (!recordInbound(shop.id, customer?.id ?? null, phone, input.text, input.externalId ?? null)) return null;
    if (customer && waId && customer.wa_id !== waId) {
      run('UPDATE customers SET wa_id = ? WHERE id = ?', [waId, customer.id]);
      customer = { ...customer, wa_id: waId };
    }

    let reply: string;
    let tokens: { in: number; out: number } | undefined;
    if (!input.text.trim()) {
      reply = mediaReply(shop, customer);
    } else {
      const quick = await quickReply(shop, customer, input.text, now, Boolean(input.dryRun));
      // Barbearia com mensalidade em atraso: o robô segue atendendo, mas só pelo menu (sem IA).
      const blocked = accessStatus(shop.id, now).blocked;
      if (quick) reply = quick;
      else if (!blocked && (llmEnabled() || input.create)) {
        const ctx = { shop, phone, waId, customer, profileName: input.name ?? null, now, dryRun: Boolean(input.dryRun) };
        const history = recentHistory(shop.id, phone).filter((h) => h.kind !== 'codigo');
        const r = await think(ctx, history, input.create);
        reply = r.text;
        tokens = { in: r.tokensIn, out: r.tokensOut };
        customer = ctx.customer;
      } else {
        reply = fallbackReply(shop, customer, input.text, now);
      }
    }
    await sendMessage({ shop, customerId: customer?.id ?? null, phone, waId: customer?.wa_id ?? waId, text: reply, kind: 'chat', dryRun: input.dryRun, tokens });
    return reply;
  });
}
