import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { defaultCreate, llmEnabled, logAgentError, runAgent, type CreateMessage } from './bot/brain.js';
import { shopNow } from './clock.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { monthForecast, periodNumbers, retention, weekSummary, type PeriodNumbers, type WeekSummary } from './insights.js';
import { sendPlatformMessage } from './platform.js';
import type { TemplateUse } from './templates.js';
import { dayAgenda, freeTimes } from './scheduling.js';
import { shopWaitlist } from './waitlist.js';
import { addDays, dayLabel, hourLabel, isDate, isTime, relativeDay, weekdayOf, WEEKDAYS } from './time.js';
import { localPhone } from './whatsapp.js';

/**
 * Gerente virtual: o dono manda mensagem para o WhatsApp do sistema (o mesmo que avisa da mensalidade e
 * do WhatsApp desconectado) e pergunta como está a barbearia: hoje, semana, mês com previsão, agenda,
 * clientes sumindo; ou pede para bloquear a agenda de um barbeiro. Com a IA ligada entende frases
 * livres; sem ela, responde às palavras-chave. O barbeiro pergunta da agenda dele e do que já ganhou.
 * Toda segunda de manhã chega o resumo da semana (dá para desligar no painel).
 */

export interface Staff {
  id: number;
  name: string;
  role: 'owner' | 'barber';
  shopId: number;
  shopName: string;
  barberId: number | null;
}

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/** "74%"; abaixo de 10%, com uma casa ("0,4%"). */
const pct = (v: number | null) =>
  v == null ? '—' : v > 0 && v < 0.1 ? `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : `${Math.round(v * 100)}%`;
const firstName = (name: string) => name.split(/\s+/)[0];
const ddmm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** "+12%", "−5%" ou "igual" em relação ao período anterior. */
function change(now: number, before: number): string {
  if (!before) return now ? 'sem comparação (antes: R$ 0)' : 'igual';
  const p = Math.round(((now - before) / before) * 100);
  return p === 0 ? 'igual' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
}
const normalize = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Dono ou barbeiro com este celular (login no sistema), de barbearia ativa. */
export function staffByPhone(rawPhone: string): Staff | null {
  const local = localPhone(rawPhone);
  if (local.length < 10) return null;
  const u = get<{ id: number; name: string; role: 'owner' | 'barber'; barbershop_id: number; barber_id: number | null; shop_name: string }>(
    `SELECT u.id, u.name, u.role, u.barbershop_id, u.barber_id, s.name AS shop_name FROM users u JOIN barbershops s ON s.id = u.barbershop_id
      WHERE u.role IN ('owner', 'barber') AND s.active = 1 AND substr(u.phone, 1, 2) = ? AND substr(u.phone, -8) = ?
      ORDER BY u.role = 'owner' DESC, u.id LIMIT 1`,
    [local.slice(0, 2), local.slice(-8)],
  );
  if (!u) return null;
  if (u.role === 'barber' && !get('SELECT 1 AS ok FROM barbers WHERE id = ? AND active = 1', [u.barber_id])) return null;
  return { id: u.id, name: u.name, role: u.role, shopId: u.barbershop_id, shopName: u.shop_name, barberId: u.barber_id };
}

// ---------- relatórios em texto (respostas por palavra-chave e o resumo da semana)

function numbersLine(p: PeriodNumbers): string {
  return `Entrou *${money(p.income)}* · ${p.services} ${p.services === 1 ? 'atendimento' : 'atendimentos'} · ticket médio ${money(p.average)}`;
}

export function dayReport(shopId: number, date: string, today: string): string {
  const p = periodNumbers(shopId, date, date);
  const lastWeek = periodNumbers(shopId, addDays(date, -7), addDays(date, -7));
  const label = date === today ? 'Hoje' : date === addDays(today, -1) ? 'Ontem' : dayLabel(date);
  return `📊 *${label}* (${ddmm(date)})\n${numbersLine(p)}\nNo mesmo dia da semana passada (${WEEKDAYS[weekdayOf(date)]}): ${money(lastWeek.income)} (${change(p.income, lastWeek.income)}).`;
}

export function weekToDateReport(shopId: number, today: string): string {
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const p = periodNumbers(shopId, monday, today);
  const before = periodNumbers(shopId, addDays(monday, -7), addDays(today, -7));
  return `📊 *Semana* (${ddmm(monday)} a ${ddmm(today)})\n${numbersLine(p)}\nNos mesmos dias da semana passada: ${money(before.income)} (${change(p.income, before.income)}).`;
}

export function monthReport(shopId: number, now: Date): string {
  const f = monthForecast(shopId, now);
  const [y, m] = f.month.split('-');
  return [
    `📊 *Mês ${m}/${y}*`,
    `Entrou até agora: *${money(f.soFar)}* (no mesmo ponto do mês passado: ${money(f.lastMonthSamePoint)}, ${change(f.soFar, f.lastMonthSamePoint)}).`,
    `Horários marcados até o fim do mês: ${money(f.scheduled)}.`,
    `📈 Previsão do mês: *${money(f.projected)}* (mês passado fechou em ${money(f.lastMonthTotal)}).`,
  ].join('\n');
}

export function agendaReport(shopId: number, date: string, today: string, now: Date, barberId?: number | null): string {
  const appts = dayAgenda(shopId, date).filter((a) => a.status === 'scheduled' && (!barberId || a.barber_id === barberId));
  const free = freeTimes(shopId, date, { now, leadMin: 0 }).filter((d) => !barberId || d.barber.id === barberId);
  const title = `🗓️ *Agenda de ${relativeDay(date, today)}*${relativeDay(date, today) === dayLabel(date) ? '' : ` (${ddmm(date)})`}`;
  if (!appts.length && !free.some((d) => d.times.length)) return `${title}\nNinguém trabalhando ou nenhum horário neste dia.`;
  const lines = [title];
  const barbers = [...new Set([...appts.map((a) => a.barber_name), ...free.map((d) => d.barber.name)])];
  for (const name of barbers) {
    const mine = appts.filter((a) => a.barber_name === name);
    const freeCount = free.find((d) => d.barber.name === name)?.times.length ?? 0;
    lines.push(
      `*${name}*: ${mine.length ? mine.map((a) => `${hourLabel(a.starts_at.slice(11))} ${firstName(a.customer_name)}${a.confirmed_at ? ' ✅' : ''}`).join(', ') : 'nenhum horário'}${freeCount ? ` · ${freeCount} ${freeCount === 1 ? 'vaga livre' : 'vagas livres'}` : ''}`,
    );
  }
  const waiting = barberId ? [] : shopWaitlist(shopId, date);
  if (waiting.length) lines.push(`⏳ ${waiting.length} na lista de espera.`);
  if (!barberId) lines.push(`Total: ${appts.length} ${appts.length === 1 ? 'horário' : 'horários'} (✅ = presença confirmada).`);
  return lines.join('\n');
}

export function customersReport(shopId: number, now: Date): string {
  const r = retention(shopId, now);
  const lines = [
    `👥 *Clientes*`,
    `${r.active} atendidos nos últimos 90 dias · ${r.newThisMonth} novos neste mês.`,
    r.returnRate != null ? `Voltaram em até 45 dias: *${pct(r.returnRate)}* (${r.returned} de ${r.cohort}).` : '',
    r.atRisk.length
      ? `⚠️ Passando do tempo de voltar: ${r.atRisk
          .slice(0, 5)
          .map((c) => `${firstName(c.name)} (${c.days} dias)`)
          .join(', ')}${r.atRisk.length > 5 ? ` e mais ${r.atRisk.length - 5}` : ''}.`
      : 'Ninguém passando do tempo de voltar. 👏',
    r.away ? `${r.away} ${r.away === 1 ? 'sumido' : 'sumidos'}: o robô chama de volta (painel, Robô WhatsApp → Clientes sumidos).` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Texto do resumo da semana (segunda de manhã ou quando o dono responde MAIS). */
export function weekSummaryText(shopName: string, w: WeekSummary): string {
  const c = w.current;
  return [
    `📊 *Resumo da semana* da ${shopName} (${ddmm(w.from)} a ${ddmm(w.to)})`,
    `💰 Entrou *${money(c.income)}* (${change(c.income, w.previous.income)} em relação à semana anterior)`,
    `✂️ ${c.services} ${c.services === 1 ? 'atendimento' : 'atendimentos'} · ticket médio ${money(c.average)}`,
    `🗓️ Agenda ${pct(w.occupancy)} ocupada · ${w.noShows} ${w.noShows === 1 ? 'falta' : 'faltas'}`,
    w.idleFilled ? `🔥 ${w.idleFilled} ${w.idleFilled === 1 ? 'horário vazio preenchido' : 'horários vazios preenchidos'} com desconto` : '',
    `🆕 ${w.newCustomers} ${w.newCustomers === 1 ? 'cliente novo' : 'clientes novos'}`,
    w.rating.n ? `⭐ Nota dos clientes: ${String(w.rating.avg).replace('.', ',')} (${w.rating.n} ${w.rating.n === 1 ? 'avaliação' : 'avaliações'})` : '',
    w.topBarber ? `🏆 Quem mais atendeu: ${w.topBarber.name} (${w.topBarber.services})` : '',
    `📅 Para esta semana já tem ${w.nextWeekBooked} ${w.nextWeekBooked === 1 ? 'horário marcado' : 'horários marcados'}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Segunda-feira da semana passada. */
const lastWeekStart = (today: string) => addDays(today, -((weekdayOf(today) + 6) % 7) - 7);

// ---------- bloquear a agenda ("bloquear Paulo amanhã das 14h às 16h")

const clock = (h: string, m?: string) => `${h.padStart(2, '0')}:${(m ?? '00').padStart(2, '0')}`;

export function createBlock(shopId: number, barberId: number, date: string, from: string, until: string, reason: string | null): string {
  if (!isDate(date) || !isTime(from) || !isTime(until)) throw new HttpError(400, 'Data ou hora inválida.');
  if (until <= from) throw new HttpError(400, 'O fim do bloqueio deve ser depois do início.');
  const barber = get<{ id: number; name: string }>('SELECT id, name FROM barbers WHERE id = ? AND barbershop_id = ?', [barberId, shopId]);
  if (!barber) throw new HttpError(404, 'Barbeiro não encontrado.');
  run('INSERT INTO barber_blocks (barber_id, starts_at, ends_at, reason, created_at) VALUES (?, ?, ?, ?, ?)', [barber.id, `${date} ${from}`, `${date} ${until}`, reason, nowIso()]);
  const clash = all<{ starts_at: string; name: string }>(
    `SELECT a.starts_at, c.name FROM appointments a JOIN customers c ON c.id = a.customer_id
      WHERE a.barber_id = ? AND a.status = 'scheduled' AND a.starts_at < ? AND a.ends_at > ? ORDER BY a.starts_at`,
    [barber.id, `${date} ${until}`, `${date} ${from}`],
  );
  return `✅ Agenda do ${barber.name} bloqueada ${dayLabel(date)}, das ${hourLabel(from)} às ${hourLabel(until)}.${
    clash.length ? `\n⚠️ Já tinha horário marcado nesse período: ${clash.map((a) => `${hourLabel(a.starts_at.slice(11))} ${firstName(a.name)}`).join(', ')}. Avise o cliente ou remarque pelo painel.` : ''
  }`;
}

/** Entende "bloquear Paulo amanhã das 14h às 16h" / "bloqueia o Marcos dia 30/10 de 9:30 a 12". */
function parseBlock(shopId: number, text: string, today: string): { barberId: number; date: string; from: string; until: string } | string {
  const t = normalize(text);
  const barbers = all<{ id: number; name: string }>('SELECT id, name FROM barbers WHERE barbershop_id = ? AND active = 1', [shopId]);
  const barber = barbers.find((b) => t.includes(normalize(firstName(b.name))));
  if (!barber) return `De qual barbeiro? Ex.: *bloquear ${barbers[0] ? firstName(barbers[0].name) : 'Paulo'} amanhã das 14h às 16h*.`;
  let date: string | null = null;
  if (/\bhoje\b/.test(t)) date = today;
  else if (/\bamanha\b/.test(t)) date = addDays(today, 1);
  else {
    const dm = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
    if (dm) {
      const year = Number(today.slice(0, 4));
      let d = `${year}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
      if (isDate(d) && d < today) d = `${year + 1}${d.slice(4)}`;
      if (isDate(d)) date = d;
    } else {
      const wd = WEEKDAYS.findIndex((w) => t.includes(normalize(w)));
      if (wd >= 0) for (let i = 0; i < 7 && !date; i++) if (weekdayOf(addDays(today, i)) === wd) date = addDays(today, i);
    }
  }
  if (!date) return 'Para qual dia? Diga *hoje*, *amanhã*, o dia da semana ou a data (ex.: 30/10).';
  const times = [...t.matchAll(/\b(\d{1,2})(?:h|:)(\d{2})?\b|\b(?:das|de|as|a|ate)\s+(\d{1,2})\b/g)].map((m) => (m[1] ? clock(m[1], m[2]) : clock(m[3]!)));
  if (/dia (todo|inteiro)|o dia todo/.test(t)) return { barberId: barber.id, date, from: '00:00', until: '23:59' };
  if (times.length < 2) return 'Qual horário? Ex.: *das 14h às 16h* (ou *o dia todo*).';
  const [from, until] = times;
  if (!isTime(from) || !isTime(until)) return 'Não entendi o horário. Ex.: *das 14h às 16h*.';
  return { barberId: barber.id, date, from, until };
}

// ---------- respostas por palavra-chave

const OWNER_MENU = (s: Staff) =>
  `Oi, ${firstName(s.name)}! Sou o gerente virtual da ${s.shopName}. 📊\nPergunte: *hoje*, *ontem*, *semana*, *mês* (com a previsão), *agenda*, *amanhã*, *clientes* ou *resumo* (a semana passada).\nPara folga: *bloquear Paulo amanhã das 14h às 16h*.`;

function ownerKeywords(s: Staff, text: string, now: Date): string {
  const t = normalize(text);
  const n = shopNow(s.shopId, now);
  if (/^(mais|resumo)\b/.test(t)) return weekSummaryText(s.shopName, weekSummary(s.shopId, lastWeekStart(n.date)));
  if (/bloque/.test(t)) {
    const b = parseBlock(s.shopId, text, n.date);
    return typeof b === 'string' ? b : createBlock(s.shopId, b.barberId, b.date, b.from, b.until, 'pelo WhatsApp');
  }
  if (/amanha/.test(t)) return agendaReport(s.shopId, addDays(n.date, 1), n.date, now);
  if (/agenda|horarios|marcad/.test(t)) return agendaReport(s.shopId, n.date, n.date, now);
  if (/\bmes\b|previs/.test(t)) return monthReport(s.shopId, now);
  if (/semana/.test(t)) return weekToDateReport(s.shopId, n.date);
  if (/ontem/.test(t)) return dayReport(s.shopId, addDays(n.date, -1), n.date);
  if (/hoje|caixa|fatur|vend|entrou/.test(t)) return dayReport(s.shopId, n.date, n.date);
  if (/client|sumid|risco|retorn/.test(t)) return customersReport(s.shopId, now);
  return OWNER_MENU(s);
}

function barberKeywords(s: Staff, text: string, now: Date): string {
  const t = normalize(text);
  const n = shopNow(s.shopId, now);
  if (/amanha/.test(t)) return agendaReport(s.shopId, addDays(n.date, 1), n.date, now, s.barberId);
  if (/agenda|hoje|horario/.test(t)) return agendaReport(s.shopId, n.date, n.date, now, s.barberId);
  if (/ganh|comiss|parte|receb/.test(t)) {
    const monthStart = `${n.date.slice(0, 8)}01`;
    const r = get<{ total: number | null; services: number | null }>(
      `SELECT SUM(i.commission_cents) AS total, SUM(CASE WHEN i.kind = 'service' THEN i.qty ELSE 0 END) AS services
         FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE i.barber_id = ? AND s.status = 'closed' AND s.date >= ? AND s.date <= ?`,
      [s.barberId, monthStart, n.date],
    )!;
    return `💈 *Seus ganhos no mês*: ${money(r.total ?? 0)} (${r.services ?? 0} ${r.services === 1 ? 'atendimento' : 'atendimentos'}). O extrato completo fica no app, em Meus ganhos.`;
  }
  return `Oi, ${firstName(s.name)}! Aqui é o sistema da ${s.shopName}. Pergunte *agenda*, *amanhã* ou *ganhos*.`;
}

// ---------- com IA: ferramentas do gerente

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data AAAA-MM-DD (use o calendário do contexto).');

interface ManagerTool<S extends z.ZodObject> {
  description: string;
  schema: S;
  run: (s: Staff, input: z.infer<S>, now: Date) => unknown;
}
const tool = <S extends z.ZodObject>(t: ManagerTool<S>) => t;

const TOOLS = {
  numeros: tool({
    description: 'Quanto entrou, atendimentos e ticket médio de um período (com a comparação com o período anterior do mesmo tamanho).',
    schema: z.object({ de: zDate, ate: zDate }),
    run: (s, i) => {
      const days = Math.round((Date.parse(i.ate) - Date.parse(i.de)) / 86400000) + 1;
      if (days < 1 || days > 400) throw new HttpError(400, 'Período inválido.');
      const p = periodNumbers(s.shopId, i.de, i.ate);
      const before = periodNumbers(s.shopId, addDays(i.de, -days), addDays(i.de, -1));
      return { ...p, entrou: money(p.income), ticket_medio: money(p.average), periodo_anterior: { entrou: money(before.income), atendimentos: before.services } };
    },
  }),
  previsao_mes: tool({
    description: 'Mês atual: quanto entrou até agora, horários marcados até o fim do mês, previsão de fechamento e comparação com o mês passado.',
    schema: z.object({}),
    run: (s, _i, now) => {
      const f = monthForecast(s.shopId, now);
      return { mes: f.month, entrou_ate_agora: money(f.soFar), marcados_ate_o_fim: money(f.scheduled), previsao: money(f.projected), mes_passado_mesmo_ponto: money(f.lastMonthSamePoint), mes_passado_total: money(f.lastMonthTotal) };
    },
  }),
  agenda: tool({
    description: 'Agenda de um dia: horários de cada barbeiro (primeiro nome do cliente, presença confirmada), vagas livres e lista de espera.',
    schema: z.object({ data: zDate }),
    run: (s, i, now) => agendaReport(s.shopId, i.data, shopNow(s.shopId, now).date, now),
  }),
  clientes: tool({
    description: 'Retorno dos clientes: atendidos nos últimos 90 dias, novos no mês, taxa de retorno, quem está passando do tempo de voltar e quantos sumiram.',
    schema: z.object({}),
    run: (s, _i, now) => {
      const r = retention(s.shopId, now);
      return { ...r, atRisk: r.atRisk.slice(0, 10).map((c) => ({ nome: c.name, dias_sem_vir: c.days, ritmo_dias: c.interval })) };
    },
  }),
  resumo_semana: tool({
    description: 'Resumo completo de uma semana (segunda a domingo). Para "a semana passada", use a segunda da semana passada.',
    schema: z.object({ segunda: zDate }),
    run: (s, i) => weekSummaryText(s.shopName, weekSummary(s.shopId, i.segunda)),
  }),
  bloquear_agenda: tool({
    description: 'Bloqueia a agenda de um barbeiro num dia (folga, médico, compromisso). Confirme com o dono o barbeiro, o dia e o horário antes.',
    schema: z.object({
      barbeiro_id: z.number().int().positive(),
      data: zDate,
      das: z.string().refine(isTime, 'HH:MM').describe('Início HH:MM'),
      ate: z.string().refine(isTime, 'HH:MM').describe('Fim HH:MM (dia todo: 00:00 a 23:59)'),
      motivo: z.string().max(120).optional(),
    }),
    run: (s, i) => createBlock(s.shopId, i.barbeiro_id, i.data, i.das, i.ate, i.motivo ?? 'pelo WhatsApp'),
  }),
};

type ToolName = keyof typeof TOOLS;

function toolDefinitions(): Anthropic.Beta.Messages.BetaToolUnion[] {
  return (Object.keys(TOOLS) as ToolName[]).map((name) => {
    const { $schema: _ignored, ...input_schema } = z.toJSONSchema(TOOLS[name].schema) as Record<string, unknown>;
    return { name, description: TOOLS[name].description, input_schema: input_schema as { type: 'object'; [k: string]: unknown } };
  });
}

async function runManagerTool(s: Staff, name: string, input: unknown, now: Date): Promise<{ ok: boolean; content: string }> {
  const def = TOOLS[name as ToolName] as ManagerTool<z.ZodObject> | undefined;
  if (!def) return { ok: false, content: `Ferramenta desconhecida: ${name}` };
  const parsed = def.schema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, content: `Entrada inválida: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
  try {
    const out = def.run(s, parsed.data, now);
    return { ok: true, content: typeof out === 'string' ? out : JSON.stringify(out) };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, content: err.message };
    console.error('[gerente] erro na ferramenta', name, err);
    return { ok: false, content: 'Erro interno ao executar a ferramenta.' };
  }
}

const INSTRUCTIONS = `Você é o gerente virtual de uma barbearia e conversa com o DONO pelo WhatsApp do sistema. Responda em português do Brasil, curto e direto (até 8 linhas), com números em reais. Pode usar *negrito* do WhatsApp e poucos emojis.
- Use as ferramentas para qualquer número, agenda ou cliente. Nunca invente valores.
- Datas: converta "hoje", "ontem", "sexta", "semana passada", "este mês" usando o CALENDÁRIO do contexto.
- Para bloquear a agenda, confirme barbeiro, dia e horário se o dono não disse tudo; depois use bloquear_agenda e repita o que foi feito.
- Você não altera preços, não apaga nada e não mexe em pagamentos: para isso, oriente a usar o painel.
- Se perguntarem algo fora da gestão da barbearia, diga em uma frase que cuida dos números e da agenda.`;

function managerContext(s: Staff, now: Date): string {
  const n = shopNow(s.shopId, now);
  const barbers = all<{ id: number; name: string }>('SELECT id, name FROM barbers WHERE barbershop_id = ? AND active = 1 ORDER BY name COLLATE NOCASE', [s.shopId]);
  const calendar = Array.from({ length: 21 }, (_, i) => {
    const d = addDays(n.date, i - 7);
    return `${dayLabel(d)} = ${d}${i === 7 ? ' (hoje)' : ''}`;
  });
  return [
    'CONTEXTO',
    `Barbearia: ${s.shopName}. Quem fala: ${s.name} (dono).`,
    `Agora: ${WEEKDAYS[n.weekday]}, ${ddmm(n.date)}/${n.date.slice(0, 4)}, ${n.time}.`,
    `CALENDÁRIO: ${calendar.join('; ')}.`,
    `Barbeiros: ${barbers.map((b) => `${b.name} (id ${b.id})`).join(', ') || 'nenhum'}.`,
  ].join('\n');
}

/** Conversa recente com esta pessoa no WhatsApp da plataforma (últimas 24h). */
function history(phone: string, now: Date): Anthropic.Beta.Messages.BetaMessageParam[] {
  const rows = all<{ direction: string; body: string }>(
    "SELECT direction, body FROM platform_messages WHERE phone = ? AND kind IN ('gerente', 'resumo') AND created_at >= ? AND created_at <= ? ORDER BY id DESC LIMIT 12",
    [phone, new Date(now.getTime() - 86400000).toISOString(), now.toISOString()],
  ).reverse();
  const out: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    // Mensagens seguidas do mesmo lado viram uma só (a API alterna os papéis).
    const last = out[out.length - 1];
    if (last?.role === role) last.content = `${last.content as string}\n${r.body}`;
    else out.push({ role, content: r.body });
  }
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}

async function ownerAi(s: Staff, phone: string, now: Date, create: CreateMessage): Promise<string | null> {
  const messages = history(phone, now);
  if (!messages.length) return null;
  try {
    const r = await runAgent({
      system: [
        { type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: managerContext(s, now) },
      ],
      tools: toolDefinitions(),
      messages,
      runTool: (name, input) => runManagerTool(s, name, input, now),
      create,
    });
    return r.text;
  } catch (err) {
    logAgentError('gerente', err);
    return null;
  }
}

// ---------- entrada pelo WhatsApp da plataforma

/** Quem não é dono nem barbeiro recebe esta explicação no máximo uma vez por dia. */
const STRANGER_REPLY =
  'Olá! Este é o WhatsApp do sistema das barbearias e só atende os donos e barbeiros cadastrados. Para marcar horário, fale com o WhatsApp da sua barbearia. 💈';

export interface PlatformInbound {
  from: string;
  text: string;
  externalId?: string | null;
  now?: Date;
  /** Substitui a chamada ao Claude (testes). */
  create?: CreateMessage;
}

/** Mensagem recebida no WhatsApp da plataforma: responde como gerente virtual (dono) ou com a agenda (barbeiro). */
export async function handlePlatformInbound(input: PlatformInbound): Promise<string | null> {
  const phone = localPhone(input.from);
  if (phone.length < 10 || phone.length > 11 || !input.text.trim()) return null;
  const now = input.now ?? new Date();
  const staff = staffByPhone(phone);
  try {
    run('INSERT INTO platform_messages (barbershop_id, user_id, phone, kind, body, status, direction, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      staff?.shopId ?? null,
      staff?.id ?? null,
      phone,
      'gerente',
      input.text.slice(0, 2000),
      'received',
      'in',
      input.externalId ?? null,
      now.toISOString(),
    ]);
  } catch (err) {
    // A Meta reenviou a mesma mensagem: já respondida.
    if (input.externalId && String(err).includes('UNIQUE')) return null;
    throw err;
  }
  let reply: string | null;
  if (!staff) {
    const told = get("SELECT 1 AS ok FROM platform_messages WHERE phone = ? AND kind = 'gerente' AND direction = 'out' AND created_at >= ?", [
      phone,
      new Date(now.getTime() - 86400000).toISOString(),
    ]);
    reply = told ? null : STRANGER_REPLY;
  } else if (staff.role === 'barber') {
    reply = barberKeywords(staff, input.text, now);
  } else {
    reply = (llmEnabled() || input.create ? await ownerAi(staff, phone, now, input.create ?? defaultCreate()) : null) ?? ownerKeywords(staff, input.text, now);
  }
  if (reply) await sendPlatformMessage({ phone, text: reply, kind: 'gerente', userId: staff?.id ?? null, shopId: staff?.shopId ?? null, reply: true, now });
  return reply;
}

// ---------- resumo da semana (segunda de manhã)

export interface WeeklyMessage {
  text: string;
  template: TemplateUse;
  push: { title: string; body: string };
}

/** Segunda a partir das 8h: o resumo da semana passada (uma vez; nada se a barbearia não teve movimento). */
export function weeklySummary(shop: { id: number; name: string; weekly_summary: number }, now: Date): WeeklyMessage | null {
  if (!shop.weekly_summary) return null;
  const n = shopNow(shop.id, now);
  if (n.weekday !== 1 || n.time < '08:00') return null;
  const from = lastWeekStart(n.date);
  if (get("SELECT 1 AS ok FROM automation_log WHERE barbershop_id = ? AND kind = 'resumo_semana' AND ref = ?", [shop.id, from])) return null;
  run("INSERT INTO automation_log (barbershop_id, customer_id, kind, ref, created_at) VALUES (?, NULL, 'resumo_semana', ?, ?)", [shop.id, from, nowIso()]);
  const w = weekSummary(shop.id, from);
  // Barbearia sem movimento nenhum (ainda começando): sem resumo vazio.
  if (!w.current.sales && !w.previous.sales && !w.nextWeekBooked && !w.occupancy) return null;
  const c = w.current;
  return {
    text: `${weekSummaryText(shop.name, w)}\n\nPergunte o que quiser por aqui: *hoje*, *agenda*, *mês*, *clientes*...`,
    template: { kind: 'resumo', params: [shop.name, `${ddmm(w.from)} a ${ddmm(w.to)}`, money(c.income), change(c.income, w.previous.income), String(c.services), pct(w.occupancy)] },
    push: { title: 'Resumo da semana', body: `Entrou ${money(c.income)} (${change(c.income, w.previous.income)}) · ${c.services} atendimentos · agenda ${pct(w.occupancy)} ocupada` },
  };
}
