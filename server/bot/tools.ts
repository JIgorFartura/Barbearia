import { z } from 'zod';
import { askConsumption, describeItems, reserveItems } from '../consumption.js';
import { config } from '../config.js';
import { issueAccessLink } from '../customerAuth.js';
import { all, get, nowIso, run } from '../db.js';
import { HttpError, normalizePhone } from '../http.js';
import { customerCard } from '../loyalty.js';
import { birthdayKey, customerReferral, setReferrer, welcomeReferred } from '../growth.js';
import type { CustomerRow, ShopBot } from '../messaging.js';
import { claimVoucher, customerVouchers, offersFor } from '../offers.js';
import { book, cancel, freeTimes, upcomingFor, type AppointmentView } from '../scheduling.js';
import { confirmAppointment } from '../attendance.js';
import { PERIOD_IDS, PERIODS, customerWaitlist, describeWait, joinWaitlist, slotFreed } from '../waitlist.js';
import { dayLabel, hourLabel, isTime, WEEKDAYS } from '../time.js';

/** O que o robô sabe sobre a conversa atual. Todas as ferramentas ficam presas a esta barbearia e a este celular. */
export interface BotContext {
  shop: ShopBot;
  /** Celular com DDD (sem 55). */
  phone: string;
  waId: string | null;
  customer: CustomerRow | null;
  /** Nome do perfil no WhatsApp (ajuda no cadastro). */
  profileName: string | null;
  now: Date;
  /** Simulador do painel: nada sai pelo WhatsApp (nem o aviso ao barbeiro). */
  dryRun: boolean;
}

interface ToolDef<S extends z.ZodObject> {
  description: string;
  schema: S;
  /** Precisa do cliente cadastrado. */
  needsCustomer?: boolean;
  run: (ctx: BotContext, input: z.infer<S>) => unknown | Promise<unknown>;
}

const tool = <S extends z.ZodObject>(def: ToolDef<S>) => def;

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data no formato AAAA-MM-DD (use o calendário do contexto).');
const zTime = z.string().refine(isTime, 'Hora no formato HH:MM').describe('Hora no formato HH:MM (24h), ex.: 17:00.');
const zId = z.number().int().positive();

const describeAppointment = (a: AppointmentView) => ({
  id: a.id,
  dia: dayLabel(a.starts_at.slice(0, 10)),
  data: a.starts_at.slice(0, 10),
  hora: a.starts_at.slice(11),
  barbeiro: a.barber_name,
  servico: a.service_name,
  preco: (a.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  presenca_confirmada: Boolean(a.confirmed_at),
});

export const TOOLS = {
  ver_horarios_livres: tool({
    description:
      'Lista os horários livres de um dia, por barbeiro. Use para responder "tem vaga?", "o Paulo tem horário sexta?" e antes de sugerir horários. Não revela quem marcou os horários ocupados.',
    schema: z.object({
      data: zDate,
      barbeiro_id: zId.optional().describe('Só deste barbeiro (opcional).'),
      servico_id: zId.optional().describe('Serviço desejado; define a duração (opcional, padrão: corte).'),
    }),
    run: (ctx, input) => {
      const days = freeTimes(ctx.shop.id, input.data, { barberId: input.barbeiro_id, serviceId: input.servico_id, now: ctx.now });
      return {
        dia: dayLabel(input.data),
        barbeiros: days.map((d) => ({ id: d.barber.id, nome: d.barber.name, horarios_livres: d.times.slice(0, 20) })),
        aviso: days.every((d) => !d.times.length) ? 'Nenhum horário livre nesse dia.' : undefined,
      };
    },
  }),

  agendar: tool({
    description: 'Marca o horário do cliente desta conversa. Use quando ele já escolheu dia, hora e barbeiro (e o serviço, se não for corte).',
    needsCustomer: true,
    schema: z.object({ data: zDate, hora: zTime, barbeiro_id: zId, servico_id: zId.optional() }),
    run: (ctx, input) => {
      const a = book({
        shopId: ctx.shop.id,
        customerId: ctx.customer!.id,
        barberId: input.barbeiro_id,
        serviceId: input.servico_id,
        date: input.data,
        time: input.hora,
        source: 'whatsapp',
        now: ctx.now,
      });
      // Se o cliente costuma consumir algo (ex.: 1 cerveja), já deixa a pergunta pronta para o SIM/NÃO.
      const pergunta = askConsumption(ctx.shop.id, a.id, ctx.now);
      return { ok: true, agendamento: describeAppointment(a), pergunta_consumo: pergunta ?? undefined };
    },
  }),

  reservar_consumo: tool({
    description:
      'Pede para o barbeiro deixar algo separado para o horário do cliente (ex.: uma cerveja) e avisa o barbeiro. Use quando o cliente aceitar ou pedir.',
    needsCustomer: true,
    schema: z.object({
      agendamento_id: zId,
      itens: z.array(z.object({ produto_id: zId, quantidade: z.number().int().min(1).max(10) })).min(1).max(5),
    }),
    run: async (ctx, input) => {
      const r = await reserveItems(
        ctx.shop.id,
        input.agendamento_id,
        input.itens.map((i) => ({ productId: i.produto_id, qty: i.quantidade })),
        'whatsapp',
        { customerId: ctx.customer!.id, dryRun: ctx.dryRun, now: ctx.now },
      );
      return { ok: true, separado: describeItems(r.items), barbeiro: r.barber, barbeiro_avisado: r.barberNotified };
    },
  }),

  meus_horarios: tool({
    description: 'Mostra os próximos horários marcados do cliente desta conversa.',
    needsCustomer: true,
    schema: z.object({}),
    run: (ctx) => ({ horarios: upcomingFor(ctx.customer!.id, ctx.now).map(describeAppointment) }),
  }),

  cancelar_horario: tool({
    description: 'Cancela um horário do cliente desta conversa (pegue o id em meus_horarios). Confirme com o cliente antes.',
    needsCustomer: true,
    schema: z.object({ agendamento_id: zId }),
    run: (ctx, input) => {
      const a = cancel(ctx.shop.id, input.agendamento_id, { customerId: ctx.customer!.id, now: ctx.now });
      // A vaga vai na hora para quem está na lista de espera.
      if (!ctx.dryRun) slotFreed(ctx.shop.id);
      return { ok: true, cancelado: describeAppointment(a) };
    },
  }),

  confirmar_presenca: tool({
    description: 'Confirma a presença do cliente num horário marcado (pegue o id em meus_horarios). Use quando ele disser que vai vir.',
    needsCustomer: true,
    schema: z.object({ agendamento_id: zId }),
    run: (ctx, input) => ({ ok: true, confirmado: describeAppointment(confirmAppointment(ctx.shop.id, input.agendamento_id, { customerId: ctx.customer!.id, now: ctx.now })) }),
  }),

  entrar_lista_espera: tool({
    description:
      'Coloca o cliente na lista de espera de um dia sem horário livre (com barbeiro e período, se ele quiser). Quando abrir vaga, o robô oferece no WhatsApp e o SIM marca.',
    needsCustomer: true,
    schema: z.object({
      data: zDate,
      barbeiro_id: zId.optional().describe('Só com este barbeiro (opcional; vazio = qualquer um).'),
      servico_id: zId.optional(),
      periodo: z.enum(PERIOD_IDS as [string, ...string[]]).optional().describe('manha, tarde, noite ou qualquer (padrão).'),
    }),
    run: (ctx, input) => {
      const w = joinWaitlist({
        shopId: ctx.shop.id,
        customerId: ctx.customer!.id,
        date: input.data,
        barberId: input.barbeiro_id,
        serviceId: input.servico_id,
        period: (input.periodo as keyof typeof PERIODS | undefined) ?? 'qualquer',
        source: 'whatsapp',
        now: ctx.now,
      });
      return { ok: true, lista_de_espera: describeWait(w), pedidos: customerWaitlist(ctx.customer!.id, ctx.now).map(describeWait) };
    },
  }),

  ver_cartao_fidelidade: tool({
    description: 'Mostra o cartão fidelidade do cliente: quanto já juntou em cada campanha, quanto falta e os prêmios disponíveis.',
    needsCustomer: true,
    schema: z.object({}),
    run: (ctx) => ({
      campanhas: customerCard(ctx.shop.id, ctx.customer!.id).map(({ campaign, progress }) => ({
        campanha: campaign.name,
        junta: campaign.unit_label,
        meta: campaign.goal,
        no_cartao: progress.stamps,
        faltam: campaign.goal - progress.stamps,
        premio: campaign.reward,
        premios_para_retirar: progress.available,
      })),
    }),
  }),

  ver_beneficios: tool({
    description: 'Lista os benefícios (vouchers de desconto/brinde) disponíveis e os vouchers que o cliente já pegou.',
    schema: z.object({}),
    run: (ctx) => ({
      beneficios: offersFor(ctx.shop.id, ctx.customer?.id ?? null).map((o) => ({
        id: o.id,
        titulo: o.title,
        descricao: o.description,
        parceiro: o.partner,
        pode_pegar: o.canClaim,
        motivo: o.reason,
      })),
      meus_vouchers: ctx.customer
        ? customerVouchers(ctx.customer.id)
            .filter((v) => v.status === 'active')
            .map((v) => ({ codigo: v.code, beneficio: v.title, valido_ate: v.expires_on }))
        : [],
    }),
  }),

  pegar_voucher: tool({
    description: 'Gera o voucher de um benefício para o cliente (código para mostrar no balcão).',
    needsCustomer: true,
    schema: z.object({ beneficio_id: zId }),
    run: (ctx, input) => {
      const v = claimVoucher(ctx.shop.id, input.beneficio_id, ctx.customer!.id);
      return { ok: true, codigo: v.code, beneficio: v.title, valido_ate: v.expires_on };
    },
  }),

  ver_parceiros: tool({
    description: 'Lista os parceiros da barbearia e o benefício de cada um para os membros.',
    schema: z.object({}),
    run: (ctx) => ({
      parceiros: all('SELECT name AS nome, category AS ramo, benefit AS beneficio, instagram FROM partners WHERE barbershop_id = ? AND active = 1 ORDER BY name', [
        ctx.shop.id,
      ]),
    }),
  }),

  definir_horario_costume: tool({
    description:
      'Salva o dia e a hora em que o cliente costuma vir (ex.: "costumo ir às sextas 19h"). O robô usa isso para lembrar e oferecer o horário toda semana.',
    needsCustomer: true,
    schema: z.object({
      dia_semana: z.number().int().min(0).max(6).describe('0 = domingo, 1 = segunda ... 6 = sábado.'),
      hora: zTime,
      barbeiro_id: zId.optional(),
      frequencia_dias: z.number().int().min(7).max(60).optional().describe('De quantos em quantos dias vem: 7 (toda semana), 14, 21, 30...'),
    }),
    run: (ctx, input) => {
      if (input.barbeiro_id && !get('SELECT 1 AS ok FROM barbers WHERE id = ? AND barbershop_id = ?', [input.barbeiro_id, ctx.shop.id])) {
        throw new HttpError(404, 'Barbeiro não encontrado.');
      }
      run('UPDATE customers SET pref_weekday = ?, pref_time = ?, pref_barber_id = ?, pref_interval_days = ?, reminders_opt_out = 0 WHERE id = ?', [
        input.dia_semana,
        input.hora,
        input.barbeiro_id ?? null,
        input.frequencia_dias ?? 7,
        ctx.customer!.id,
      ]);
      return { ok: true, costume: `${WEEKDAYS[input.dia_semana]} às ${hourLabel(input.hora)}` };
    },
  }),

  lembretes: tool({
    description: 'Liga ou desliga os lembretes automáticos (oferta semanal do horário de costume e recontato). O lembrete de horário marcado continua.',
    needsCustomer: true,
    schema: z.object({ receber: z.boolean() }),
    run: (ctx, input) => {
      run('UPDATE customers SET reminders_opt_out = ? WHERE id = ?', [input.receber ? 0 : 1, ctx.customer!.id]);
      return { ok: true, recebe_lembretes: input.receber };
    },
  }),

  cadastrar_cliente: tool({
    description: 'Cadastra quem está falando (número desta conversa) como cliente da barbearia. Pergunte o nome antes.',
    schema: z.object({
      nome: z.string().trim().min(2).max(80),
      codigo_indicacao: z.string().trim().max(20).optional().describe('Código de quem indicou, se o cliente disser que veio por indicação (ex.: JOAO7K2).'),
    }),
    run: (ctx, input) => {
      if (ctx.customer) return { ok: true, ja_cadastrado: true, nome: ctx.customer.name };
      const phone = normalizePhone(ctx.phone);
      // LGPD: o cadastro pelo WhatsApp vem com o aviso da política de privacidade (o robô manda o link).
      const { lastInsertRowid } = run('INSERT INTO customers (barbershop_id, name, phone, wa_id, privacy_notice_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        ctx.shop.id,
        input.nome,
        phone,
        ctx.waId,
        nowIso(),
        nowIso(),
      ]);
      ctx.customer = { id: lastInsertRowid, barbershop_id: ctx.shop.id, name: input.nome, phone, wa_id: ctx.waId, reminders_opt_out: 0 };
      // Veio por indicação: guarda quem indicou e já dá o presente de boas-vindas (o celular é o desta conversa).
      const indicado = setReferrer(ctx.shop.id, lastInsertRowid, input.codigo_indicacao);
      const presente = indicado ? welcomeReferred(ctx.shop.id, lastInsertRowid) : null;
      return {
        ok: true,
        nome: input.nome,
        politica_privacidade: `${config.appUrl}/b/${ctx.shop.slug}/privacidade`,
        indicacao: input.codigo_indicacao ? (indicado ? 'registrada' : 'código não encontrado') : undefined,
        presente_boas_vindas: presente ? { presente: presente.title, codigo: presente.code, validade: presente.expires_on } : undefined,
      };
    },
  }),

  link_indicacao: tool({
    description: 'Link de indicação do cliente para mandar aos amigos (indique um amigo), com o que ele e o amigo ganham.',
    needsCustomer: true,
    schema: z.object({}),
    run: (ctx) => {
      const r = customerReferral(ctx.shop.id, ctx.customer!.id);
      if (!r) return { ok: false, erro: 'A barbearia não está com o indique um amigo ligado.' };
      return { ok: true, link: r.link, voce_ganha: r.my_prize, amigo_ganha: r.friend_gift, amigos_que_vieram: r.came };
    },
  }),

  definir_aniversario: tool({
    description: 'Salva o dia e o mês do aniversário do cliente (para o presente de aniversário da barbearia).',
    needsCustomer: true,
    schema: z.object({ dia: z.number().int().min(1).max(31), mes: z.number().int().min(1).max(12) }),
    run: (ctx, input) => {
      const key = birthdayKey(input.dia, input.mes);
      if (!key) return { ok: false, erro: 'Data inválida.' };
      run('UPDATE customers SET birth_date = ? WHERE id = ?', [key, ctx.customer!.id]);
      return { ok: true, aniversario: `${String(input.dia).padStart(2, '0')}/${String(input.mes).padStart(2, '0')}` };
    },
  }),

  enviar_link_area: tool({
    description: 'Gera o link de acesso à área do cliente no site (agenda, cartão fidelidade, vouchers). Vale por 3 dias e entra sem senha.',
    needsCustomer: true,
    schema: z.object({}),
    run: (ctx) => ({ link: issueAccessLink(ctx.customer!.id, ctx.shop.slug) }),
  }),
};

export type ToolName = keyof typeof TOOLS;

/** Definições no formato da API (JSON Schema gerado a partir do zod, em ordem fixa para o cache). */
export function toolDefinitions() {
  return (Object.keys(TOOLS) as ToolName[]).map((name) => {
    const { $schema: _ignored, ...input_schema } = z.toJSONSchema(TOOLS[name].schema) as Record<string, unknown>;
    return { name, description: TOOLS[name].description, input_schema: input_schema as { type: 'object'; [k: string]: unknown } };
  });
}

/** Executa uma ferramenta com a entrada validada. Erros voltam como texto para o modelo explicar ao cliente. */
export async function runTool(ctx: BotContext, name: string, input: unknown): Promise<{ ok: boolean; content: string }> {
  const def = TOOLS[name as ToolName] as ToolDef<z.ZodObject> | undefined;
  if (!def) return { ok: false, content: `Ferramenta desconhecida: ${name}` };
  const parsed = def.schema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, content: `Entrada inválida: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  if (def.needsCustomer && !ctx.customer) {
    return { ok: false, content: 'Este número ainda não é cliente. Pergunte o nome e use cadastrar_cliente antes.' };
  }
  try {
    return { ok: true, content: JSON.stringify(await def.run(ctx, parsed.data)) };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, content: err.message };
    console.error('[bot] erro na ferramenta', name, err);
    return { ok: false, content: 'Erro interno ao executar a ferramenta.' };
  }
}
