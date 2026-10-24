import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { get } from '../db.js';
import { customerHabit } from '../habits.js';
import type { HistoryItem } from '../messaging.js';
import { activeBarbers, services, upcomingFor } from '../scheduling.js';
import { addDays, dayLabel, hourLabel, localNow, WEEKDAYS } from '../time.js';
import { runTool, toolDefinitions, type BotContext } from './tools.js';

/** Instruções iguais para todas as barbearias (ficam em cache junto com as ferramentas). */
const INSTRUCTIONS = `Você é o robô de atendimento de uma barbearia no WhatsApp. Seu nome, o nome da barbearia e os dados de quem está falando estão no bloco CONTEXTO.

Como falar:
- Português do Brasil, simpático e direto, como um bom atendente de barbearia.
- Mensagens curtas (até 5 linhas), sem markdown. Pode usar *negrito* do WhatsApp com moderação e no máximo um emoji.
- Trate o cliente pelo primeiro nome quando souber.

O que você faz: agendamentos, horários livres, cancelamentos, cartão fidelidade (carimbos e prêmios), benefícios e vouchers, parceiros, horário de costume e link da área do cliente.

Regras:
- Use as ferramentas para tudo que envolve agenda, cartão, benefícios e parceiros. Nunca invente horários livres, preços, carimbos ou códigos.
- Datas: converta "sexta", "amanhã", "dia 31" usando o CALENDÁRIO do contexto. Horas no formato HH:MM.
- Para marcar: se o cliente já disse dia, hora e barbeiro (ou "qualquer um"), confira com ver_horarios_livres e marque com agendar. Se faltar algo, pergunte só o que falta. Sem barbeiro preferido, escolha um que esteja livre no horário pedido.
- Se o horário pedido estiver ocupado, ofereça os 2 ou 3 horários livres mais próximos.
- Se existir OFERTA PENDENTE no contexto e o cliente aceitar ou pedir ajuste, use agendar com os dados dela (ou com o ajuste pedido).
- Antes de cancelar, confirme qual horário. Depois de marcar ou cancelar, confirme dia, hora, barbeiro e serviço.
- Quem não é cliente: antes de marcar ou pegar voucher, pergunte o nome e use cadastrar_cliente.
- Você só vê e altera dados do cliente desta conversa. Nunca diga quem marcou um horário nem passe dados de outros clientes; para "a agenda do Paulo" mostre apenas os horários livres dele.
- Quando o cliente contar o dia e a hora em que costuma vir, salve com definir_horario_costume.
- Se pedir para não receber mais mensagens automáticas, use lembretes com receber=false.
- Se pedir para falar com uma pessoa, diga que vai avisar a equipe e passe o WhatsApp ou o endereço da barbearia.
- Assuntos fora da barbearia: responda em uma frase que você cuida do atendimento da barbearia.`;

function money(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Parte que muda a cada conversa: barbearia, agora, calendário, cliente e oferta pendente. */
export function buildContext(ctx: BotContext): string {
  const now = localNow(ctx.now);
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

  if (ctx.customer) {
    const c = ctx.customer;
    lines.push(`Quem está falando: ${c.name}, cliente cadastrado.`);
    const habit = customerHabit(c.id, ctx.now);
    if (habit) {
      const barber = barbers.find((b) => b.id === habit.barberId)?.name;
      lines.push(
        `Costume: ${WEEKDAYS[habit.weekday]} às ${hourLabel(habit.time)}${barber ? ` com ${barber}` : ''}, a cada ${habit.intervalDays} dias (${habit.source === 'cliente' ? 'informado pelo cliente' : 'descoberto pelo histórico'}).`,
      );
    }
    const upcoming = upcomingFor(c.id, ctx.now);
    lines.push(
      `Próximos horários: ${upcoming.length ? upcoming.map((a) => `${dayLabel(a.starts_at.slice(0, 10))} às ${hourLabel(a.starts_at.slice(11))} com ${a.barber_name} (${a.service_name}, id ${a.id})`).join('; ') : 'nenhum'}.`,
    );
    if (c.reminders_opt_out) lines.push('Ele pediu para não receber lembretes automáticos.');
    const offer = get<{ starts_at: string; barber: string; barber_id: number; service_id: number | null }>(
      `SELECT o.starts_at, b.name AS barber, o.barber_id, o.service_id FROM bot_offers o JOIN barbers b ON b.id = o.barber_id
        WHERE o.customer_id = ? AND o.status = 'pending' AND o.starts_at > ? ORDER BY o.id DESC LIMIT 1`,
      [c.id, now.stamp],
    );
    if (offer) {
      lines.push(
        `OFERTA PENDENTE (você ofereceu): ${dayLabel(offer.starts_at.slice(0, 10))} às ${hourLabel(offer.starts_at.slice(11))} com ${offer.barber} — data ${offer.starts_at.slice(0, 10)}, hora ${offer.starts_at.slice(11)}, barbeiro_id ${offer.barber_id}${offer.service_id ? `, servico_id ${offer.service_id}` : ''}.`,
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
function defaultCreate(): CreateMessage {
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
  const tools = toolDefinitions();
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await create({
        model: config.botModel,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: config.botEffort },
        system,
        tools,
        messages,
      });
      const u = response.usage;
      tokensIn += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      tokensOut += u.output_tokens ?? 0;

      if (response.stop_reason === 'refusal') return { text: REFUSAL_REPLY, tokensIn, tokensOut };

      const toolUses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
      if (response.stop_reason === 'tool_use' && toolUses.length) {
        // Devolve o conteúdo inteiro (inclusive blocos de raciocínio) sem alterar, e todos os resultados numa mensagem só.
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: toolUses.map((t) => {
            const result = runTool(ctx, t.name, t.input);
            return { type: 'tool_result' as const, tool_use_id: t.id, content: result.content, is_error: !result.ok };
          }),
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
      return { text: text || ERROR_REPLY, tokensIn, tokensOut };
    }
    return { text: ERROR_REPLY, tokensIn, tokensOut };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn('[bot] limite de uso da API atingido');
    else if (err instanceof Anthropic.AuthenticationError) console.error('[bot] chave da Anthropic inválida (ANTHROPIC_API_KEY)');
    else if (err instanceof Anthropic.APIError) console.error(`[bot] erro da API ${err.status}:`, err.message);
    else console.error('[bot] erro inesperado', err);
    return { text: ERROR_REPLY, tokensIn, tokensOut };
  }
}
