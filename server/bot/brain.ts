import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { describeItems, usualConsumption } from '../consumption.js';
import { availableQty } from '../stock.js';
import { customerMembership, listPlans } from '../club.js';
import { growthSettings } from '../growth.js';
import { all, get } from '../db.js';
import { customerHabit } from '../habits.js';
import type { HistoryItem } from '../messaging.js';
import { activeBarbers, services, upcomingFor } from '../scheduling.js';
import { customerWaitlist, describeWait } from '../waitlist.js';
import { idleWindow } from '../promo.js';
import { shopNow } from '../clock.js';
import { addDays, dayLabel, hourLabel, WEEKDAYS } from '../time.js';
import { runTool, toolDefinitions, type BotContext } from './tools.js';

/** Instruções iguais para todas as barbearias (ficam em cache junto com as ferramentas). */
const INSTRUCTIONS = `Você é o robô de atendimento de uma barbearia no WhatsApp. Seu nome, o nome da barbearia e os dados de quem está falando estão no bloco CONTEXTO.

Como falar:
- Português do Brasil, simpático e direto, como um bom atendente de barbearia.
- Mensagens curtas (até 5 linhas), sem markdown. Pode usar *negrito* do WhatsApp com moderação e no máximo um emoji.
- Trate o cliente pelo primeiro nome quando souber.

O que você faz: agendamentos, horários livres, cancelamentos, cartão fidelidade (carimbos e prêmios), benefícios e vouchers, parceiros, clube de assinatura, horário de costume e link da área do cliente.

Regras:
- Use as ferramentas para tudo que envolve agenda, cartão, benefícios e parceiros. Nunca invente horários livres, preços, carimbos ou códigos.
- Datas: converta "sexta", "amanhã", "dia 31" usando o CALENDÁRIO do contexto. Horas no formato HH:MM.
- Para marcar: se o cliente já disse dia, hora e barbeiro (ou "qualquer um"), confira com ver_horarios_livres e marque com agendar. Se faltar algo, pergunte só o que falta. Sem barbeiro preferido, escolha um que esteja livre no horário pedido.
- Se o horário pedido estiver ocupado, ofereça os 2 ou 3 horários livres mais próximos. Se o dia estiver lotado (ou o cliente só puder naquele dia), ofereça a lista de espera (entrar_lista_espera): quando abrir vaga, você avisa e o SIM marca.
- Se o cliente disser que vai vir no horário marcado, confirme a presença com confirmar_presenca.
- Se existir OFERTA PENDENTE no contexto e o cliente aceitar ou pedir ajuste, use agendar com os dados dela (ou com o ajuste pedido).
- Antes de cancelar, confirme qual horário. Depois de marcar ou cancelar, confirme dia, hora, barbeiro e serviço.
- Quem não é cliente: antes de marcar ou pegar voucher, pergunte o nome e use cadastrar_cliente. Na mensagem seguinte ao cadastro, avise em uma frase curta que os dados dele seguem a política de privacidade da barbearia e mande o link politica_privacidade.
- Você só vê e altera dados do cliente desta conversa. Nunca diga quem marcou um horário nem passe dados de outros clientes; para "a agenda do Paulo" mostre apenas os horários livres dele.
- Quando o cliente contar o dia e a hora em que costuma vir, salve com definir_horario_costume.
- Se pedir para não receber mais mensagens automáticas, use lembretes com receber=false.
- Depois de marcar, se o resultado de agendar trouxer pergunta_consumo, termine a confirmação com essa pergunta.
- Se o cliente pedir para deixar algo separado para o horário dele (ex.: "separa uma cerveja"), use reservar_consumo.
- Indique um amigo: se estiver ligado no CONTEXTO e o cliente perguntar (ou quiser indicar alguém), mande o link com link_indicacao. Se alguém disser que veio por indicação, peça o código e passe em cadastrar_cliente (codigo_indicacao).
- Se o cliente contar o dia do aniversário, salve com definir_aniversario.
- Clube de assinatura: quando o cliente perguntar (ou fizer sentido, sem insistir), explique os planos do CONTEXTO. Para assinar, pagar a mensalidade ou mandar o comprovante do PIX (foto ou PDF, que vai direto para a barbearia), mande o link da área do cliente (enviar_link_area). Nunca diga que um pagamento foi confirmado: quem confere o PIX é a barbearia.
- Se pedir para falar com uma pessoa, diga que vai avisar a equipe e passe o WhatsApp ou o endereço da barbearia.
- O cliente só tem acesso ao que é dele e ao que é público: horários, cartão, vouchers, benefícios, preços e endereço. Nunca fale de faturamento, caixa, comissões, quanto os barbeiros ganham ou dados de outros clientes.
- Assuntos fora da barbearia: responda em uma frase que você cuida do atendimento da barbearia.`;

function money(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Parte que muda a cada conversa: barbearia, agora, calendário, cliente e oferta pendente. */
export function buildContext(ctx: BotContext): string {
  const now = shopNow(ctx.shop.id, ctx.now);
  const shop = ctx.shop;
  const lines: string[] = ['CONTEXTO'];
  lines.push(`Seu nome: ${shop.bot_name}. Barbearia: ${shop.name}.`);
  if (shop.address) lines.push(`Endereço: ${shop.address}.`);
  if (shop.hours) lines.push(`Funcionamento: ${shop.hours}.`);
  if (shop.whatsapp) lines.push(`WhatsApp da equipe: ${shop.whatsapp}.`);
  lines.push(`Agora: ${WEEKDAYS[now.weekday]}, ${now.date.slice(8, 10)}/${now.date.slice(5, 7)}/${now.date.slice(0, 4)}, ${now.time}.`);
  const calendar = Array.from({ length: 15 }, (_, i) => {
    const d = addDays(now.date, i);
    return `${dayLabel(d)} = ${d}${i === 0 ? ' (hoje)' : i === 1 ? ' (amanhã)' : ''}`;
  });
  lines.push(`CALENDÁRIO: ${calendar.join('; ')}.`);

  const barbers = activeBarbers(shop.id);
  lines.push(`Barbeiros: ${barbers.length ? barbers.map((b) => `${b.name} (id ${b.id})`).join(', ') : 'nenhum cadastrado (não é possível agendar)'}.`);
  const svc = services(shop.id);
  if (svc.length) lines.push(`Serviços: ${svc.map((s) => `${s.name} (id ${s.id}, ${money(s.price_cents)}${s.duration_min ? `, ${s.duration_min} min` : ''})`).join('; ')}.`);
  const products = all<{ id: number; name: string; price_cents: number }>(
    "SELECT id, name, price_cents FROM catalog_items WHERE barbershop_id = ? AND kind = 'product' AND active = 1 ORDER BY name COLLATE NOCASE",
    [shop.id],
  );
  if (products.length) {
    const left = (id: number) => availableQty(shop.id, id, { now: ctx.now });
    lines.push(`Produtos: ${products.map((p) => `${p.name} (produto_id ${p.id}, ${money(p.price_cents)}${left(p.id) !== null && left(p.id)! <= 0 ? ', ESGOTADO: não ofereça' : ''})`).join('; ')}.`);
  }

  const plans = listPlans(shop.id, { activeOnly: true });
  if (plans.length) {
    lines.push(
      `Clube de assinatura (mensalidade por PIX, assina pela área do cliente): ${plans
        .map((p) => `${p.name}, ${money(p.price_cents)} por mês, inclui ${p.items.map((i) => i.name).join(' e ')}${p.uses_per_month ? ` (até ${p.uses_per_month} usos por mês)` : ' (à vontade)'}`)
        .join('; ')}.`,
    );
  }

  const growth = growthSettings(shop.id);
  if (growth.referral_enabled && growth.referrer_reward) {
    lines.push(
      `Indique um amigo (ligado): quem indica ganha ${growth.referrer_reward.title} quando o amigo vier pela primeira vez${growth.friend_reward ? `; o amigo ganha ${growth.friend_reward.title}` : ''}.`,
    );
  }
  if (growth.birthday_enabled && growth.birthday_reward) lines.push(`Aniversário: no dia, o cliente cadastrado ganha ${growth.birthday_reward.title}.`);
  const idle = idleWindow(shop.id, now.date, ctx.now);
  if (idle) {
    lines.push(
      `Horário vazio (promoção de hoje): marcando hoje para hoje, horários livres das ${hourLabel(idle.from)} às ${hourLabel(idle.until)} saem com ${idle.percent}% de desconto no serviço (o desconto entra sozinho ao agendar). Pode mencionar quando o cliente quiser horário hoje. Para outros dias, preço normal.`,
    );
  }

  if (ctx.customer) {
    const c = ctx.customer;
    lines.push(`Quem está falando: ${c.name}, cliente cadastrado.`);
    const club = customerMembership(shop.id, c.id, ctx.now);
    if (club) {
      const until = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
      const state = {
        ok: `em dia até ${until(club.period?.end)}${club.plan.uses_per_month ? `, já usou ${club.used} de ${club.plan.uses_per_month} neste mês` : ''}`,
        pending: 'esperando o primeiro pagamento (PIX)',
        late: 'mensalidade atrasada: os benefícios ficam pausados até o pagamento',
        ending: `cancelou a assinatura; vale até ${until(club.period?.end)}`,
        ended: 'assinatura encerrada',
      }[club.state];
      lines.push(`Clube: assinante do plano ${club.plan.name}, ${state}.`);
    }
    const habit = customerHabit(c.id, ctx.now);
    if (habit) {
      const barber = barbers.find((b) => b.id === habit.barberId)?.name;
      lines.push(
        `Costume: ${WEEKDAYS[habit.weekday]} às ${hourLabel(habit.time)}${barber ? ` com ${barber}` : ''}, a cada ${habit.intervalDays} dias (${habit.source === 'cliente' ? 'informado pelo cliente' : 'descoberto pelo histórico'}).`,
      );
    }
    const upcoming = upcomingFor(c.id, ctx.now);
    lines.push(
      `Próximos horários: ${upcoming.length ? upcoming.map((a) => `${dayLabel(a.starts_at.slice(0, 10))} às ${hourLabel(a.starts_at.slice(11))} com ${a.barber_name} (${a.service_name}, id ${a.id}${a.confirmed_at ? ', presença confirmada' : ''})`).join('; ') : 'nenhum'}.`,
    );
    const waiting = customerWaitlist(c.id, ctx.now);
    if (waiting.length) lines.push(`Na lista de espera: ${waiting.map(describeWait).join('; ')}.`);
    if (c.reminders_opt_out) lines.push('Ele pediu para não receber lembretes automáticos.');
    const usual = usualConsumption(c.id);
    if (usual.length) lines.push(`Consumo de costume quando vem: ${usual.map((u) => `${u.qty} ${u.name} (produto_id ${u.productId})`).join('; ')}.`);
    const question = get<{ kind: string; appointment_id: number; payload: string }>(
      "SELECT kind, appointment_id, payload FROM bot_questions WHERE customer_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      [c.id],
    );
    if (question?.kind === 'presenca') {
      lines.push(
        `PERGUNTA PENDENTE (o lembrete perguntou): o cliente confirma a presença no horário (agendamento_id ${question.appointment_id})? Se ele disser que vem, use confirmar_presenca; se não puder vir, cancelar_horario (a vaga vai para a lista de espera).`,
      );
    } else if (question) {
      lines.push(
        `PERGUNTA PENDENTE (você perguntou): posso avisar o barbeiro para separar ${describeItems(JSON.parse(question.payload))} (agendamento_id ${question.appointment_id})? Se o cliente aceitar ou ajustar, use reservar_consumo.`,
      );
    }
    const offer = get<{ starts_at: string; barber: string; barber_id: number; service_id: number | null; discount_percent: number | null }>(
      `SELECT o.starts_at, b.name AS barber, o.barber_id, o.service_id, o.discount_percent FROM bot_offers o JOIN barbers b ON b.id = o.barber_id
        WHERE o.customer_id = ? AND o.status = 'pending' AND o.starts_at > ? ORDER BY o.id DESC LIMIT 1`,
      [c.id, now.stamp],
    );
    if (offer) {
      lines.push(
        `OFERTA PENDENTE (você ofereceu): ${dayLabel(offer.starts_at.slice(0, 10))} às ${hourLabel(offer.starts_at.slice(11))} com ${offer.barber} — data ${offer.starts_at.slice(0, 10)}, hora ${offer.starts_at.slice(11)}, barbeiro_id ${offer.barber_id}${offer.service_id ? `, servico_id ${offer.service_id}` : ''}${offer.discount_percent ? `, com ${offer.discount_percent}% de desconto (horário vazio; o desconto entra sozinho ao agendar)` : ''}.`,
      );
    }
  } else {
    lines.push(`Quem está falando ainda não é cliente${ctx.profileName ? ` (nome no WhatsApp: ${ctx.profileName})` : ''}.`);
  }
  if (shop.bot_persona) lines.push(`Orientações da barbearia: ${shop.bot_persona}`);
  return lines.join('\n');
}

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type CreateMessage = (params: CreateParams) => Promise<Anthropic.Beta.Messages.BetaMessage>;

let client: Anthropic | null = null;
export function defaultCreate(): CreateMessage {
  client ??= new Anthropic({ apiKey: config.anthropicKey, timeout: 60_000, maxRetries: 2 });
  return (params) => client!.beta.messages.create(params);
}

export const llmEnabled = () => Boolean(config.anthropicKey);

const MAX_STEPS = 6;
const REFUSAL_REPLY = 'Desculpe, nisso não consigo ajudar. Posso ver horários, seu cartão fidelidade e benefícios. 😉';
const ERROR_REPLY = 'Tive um probleminha agora. Pode repetir em instantes? Se preferir, fale com a equipe da barbearia.';

export interface BrainReply {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface AgentOptions {
  system: Anthropic.Beta.Messages.BetaTextBlockParam[];
  tools: Anthropic.Beta.Messages.BetaToolUnion[];
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  runTool: (name: string, input: unknown) => Promise<{ ok: boolean; content: string }>;
  create: CreateMessage;
}

/**
 * Laço de ferramentas com o Claude até a resposta final (robô do cliente e gerente virtual do dono).
 * `text` null: sem resposta (recusa ou passos demais). Erros da API sobem para quem chamou.
 */
export async function runAgent(o: AgentOptions): Promise<{ text: string | null; refused: boolean; tokensIn: number; tokensOut: number }> {
  const messages = [...o.messages];
  let tokensIn = 0;
  let tokensOut = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await o.create({
      model: config.botModel,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: config.botEffort },
      system: o.system,
      tools: o.tools,
      messages,
    });
    const u = response.usage;
    tokensIn += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    tokensOut += u.output_tokens ?? 0;

    if (response.stop_reason === 'refusal') return { text: null, refused: true, tokensIn, tokensOut };

    const toolUses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && toolUses.length) {
      // Devolve o conteúdo inteiro (inclusive blocos de raciocínio) sem alterar, e todos os resultados numa mensagem só.
      messages.push({ role: 'assistant', content: response.content });
      const results = await Promise.all(toolUses.map((t) => o.runTool(t.name, t.input)));
      messages.push({
        role: 'user',
        content: toolUses.map((t, i) => ({ type: 'tool_result' as const, tool_use_id: t.id, content: results[i].content, is_error: !results[i].ok })),
      });
      continue;
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { text: text || null, refused: false, tokensIn, tokensOut };
  }
  return { text: null, refused: false, tokensIn, tokensOut };
}

/** Registra no log o tipo de falha da API (chave inválida, limite de uso...). */
export function logAgentError(tag: string, err: unknown): void {
  if (err instanceof Anthropic.RateLimitError) console.warn(`[${tag}] limite de uso da API atingido`);
  else if (err instanceof Anthropic.AuthenticationError) console.error(`[${tag}] chave da Anthropic inválida (ANTHROPIC_API_KEY)`);
  else if (err instanceof Anthropic.APIError) console.error(`[${tag}] erro da API ${err.status}:`, err.message);
  else console.error(`[${tag}] erro inesperado`, err);
}

/** Conversa com o Claude usando as ferramentas da barbearia até ter a resposta final. */
export async function think(ctx: BotContext, history: HistoryItem[], create: CreateMessage = defaultCreate()): Promise<BrainReply> {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = history.map((h) =>
    h.direction === 'in' ? { role: 'user', content: h.body || '(mensagem sem texto)' } : { role: 'assistant', content: h.body },
  );
  // A API exige começar pelo cliente; mensagens automáticas da barbearia podem ter aberto a conversa.
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: '(conversa iniciada pela barbearia)' });

  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
    { type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildContext(ctx) },
  ];
  try {
    const r = await runAgent({ system, tools: toolDefinitions(), messages, runTool: (name, input) => runTool(ctx, name, input), create });
    return { text: r.refused ? REFUSAL_REPLY : (r.text ?? ERROR_REPLY), tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  } catch (err) {
    logAgentError('bot', err);
    return { text: ERROR_REPLY, tokensIn: 0, tokensOut: 0 };
  }
}
