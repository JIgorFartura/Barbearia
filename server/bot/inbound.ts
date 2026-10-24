import { config } from '../config.js';
import { issueAccessLink } from '../customerAuth.js';
import { get, run } from '../db.js';
import { HttpError } from '../http.js';
import { customerCard } from '../loyalty.js';
import { customerByPhone, recentHistory, recordInbound, sendMessage, shopBot, type CustomerRow, type ShopBot } from '../messaging.js';
import { book, cancel, freeTimes, upcomingFor } from '../scheduling.js';
import { addDays, dayLabel, hourLabel, localNow } from '../time.js';
import { localPhone } from '../whatsapp.js';
import { accessStatus } from '../billing.js';
import { askConsumption, describeItems, reserveItems, type Usual } from '../consumption.js';
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

const firstName = (name: string) => name.split(/\s+/)[0];

/**
 * Respostas certeiras que não precisam de IA: SIM/NÃO para o horário oferecido ou para a pergunta
 * do consumo ("posso avisar o Paulo da sua cerveja?"), PARAR/VOLTAR, CANCELAR.
 */
async function quickReply(shop: ShopBot, customer: CustomerRow | null, text: string, now: Date, dryRun: boolean): Promise<string | null> {
  if (!customer) return null;
  const t = normalize(text);
  const nowStamp = localNow(now).stamp;

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
    return `Cancelado: ${dayLabel(next.starts_at.slice(0, 10))} às ${hourLabel(next.starts_at.slice(11))} com ${next.barber_name}. Quando quiser remarcar, é só chamar.`;
  }
  if (!YES.has(t) && !NO.has(t)) return null;

  // Vale a pergunta mais recente: a do consumo (feita depois de marcar) ou a oferta de horário.
  const question = get<{ id: number; appointment_id: number; payload: string; created_at: string }>(
    `SELECT q.id, q.appointment_id, q.payload, q.created_at FROM bot_questions q JOIN appointments a ON a.id = q.appointment_id
      WHERE q.customer_id = ? AND q.status = 'pending' AND a.status = 'scheduled' AND a.starts_at > ? ORDER BY q.id DESC LIMIT 1`,
    [customer.id, nowStamp],
  );
  const offer = get<{ id: number; barber_id: number; service_id: number | null; starts_at: string; created_at: string }>(
    "SELECT id, barber_id, service_id, starts_at, created_at FROM bot_offers WHERE customer_id = ? AND status = 'pending' AND starts_at > ? ORDER BY id DESC LIMIT 1",
    [customer.id, nowStamp],
  );

  if (question && (!offer || question.created_at >= offer.created_at)) {
    if (NO.has(t)) {
      run("UPDATE bot_questions SET status = 'no' WHERE id = ?", [question.id]);
      return 'Beleza! Até lá. 👊';
    }
    try {
      const items = (JSON.parse(question.payload) as Usual[]).map((u) => ({ productId: u.productId, qty: u.qty }));
      const r = await reserveItems(shop.id, question.appointment_id, items, 'whatsapp', { customerId: customer.id, dryRun, now });
      return `Fechado! ${r.barberNotified ? `Avisei o ${r.barber}` : `Anotei pro ${r.barber}`}: ${describeItems(r.items)} separado pra você. 🍺`;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      run("UPDATE bot_questions SET status = 'expired' WHERE id = ?", [question.id]);
      return null;
    }
  }

  if (!offer) return null;
  if (NO.has(t)) {
    run("UPDATE bot_offers SET status = 'declined' WHERE id = ?", [offer.id]);
    return 'Tranquilo! Quando quiser marcar, é só me chamar. 👊';
  }
  const date = offer.starts_at.slice(0, 10);
  const time = offer.starts_at.slice(11);
  try {
    const a = book({ shopId: shop.id, customerId: customer.id, barberId: offer.barber_id, serviceId: offer.service_id, date, time, source: 'whatsapp', now });
    run("UPDATE bot_offers SET status = 'accepted', appointment_id = ? WHERE id = ?", [a.id, offer.id]);
    const ask = askConsumption(shop.id, a.id, now);
    return `Fechado, ${firstName(customer.name)}! ✅ ${dayLabel(date)} às ${hourLabel(time)} com ${a.barber_name} (${a.service_name}). Te espero!${ask ? `\n${ask}` : ''}`;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    run("UPDATE bot_offers SET status = 'expired' WHERE id = ?", [offer.id]);
    const alt = freeTimes(shop.id, date, { barberId: offer.barber_id, serviceId: offer.service_id, now }).flatMap((d) => d.times.map((x) => `${hourLabel(x)}`));
    return alt.length
      ? `Esse horário acabou de ser ocupado 😕. No mesmo dia ainda tenho: ${alt.slice(0, 4).join(', ')}. Qual prefere?`
      : `Esse horário acabou de ser ocupado 😕. Me diga outro dia e horário que eu vejo pra você.`;
  }
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
    const today = localNow(now).date;
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
      reply = 'Por enquanto eu só entendo mensagens de texto. Pode escrever pra mim? 🙂';
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
