import { BarChart3, MessageCircle, TrendingUp, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '../../components/ui';
import { api } from '../../lib/api';
import { WEEKDAYS, WEEKDAYS_SHORT, money, phone, whatsappLink } from '../../lib/format';

type Period = 'mes' | 'mes_passado' | '30' | '90';
const PERIODS: [Period, string][] = [
  ['mes', 'Este mês'],
  ['mes_passado', 'Mês passado'],
  ['30', 'Últimos 30 dias'],
  ['90', 'Últimos 90 dias'],
];

interface Numbers {
  income: number;
  sales: number;
  services: number;
  average: number;
}

interface ReportData {
  from: string;
  to: string;
  numbers: Numbers;
  previous: Numbers;
  occupancy: {
    rate: number | null;
    byBarber: { id: number; name: string; rate: number | null; open_min: number; booked_min: number }[];
    heat: { weekday: number; hour: number; open_min: number; booked_min: number }[];
  };
  retention: {
    active: number;
    newThisMonth: number;
    cohort: number;
    returned: number;
    returnRate: number | null;
    avgInterval: number | null;
    atRisk: { id: number; name: string; phone: string; days: number; interval: number | null; robotIn: number | null }[];
    away: number;
  };
  forecast: { month: string; soFar: number; scheduled: number; projected: number; lastMonthSamePoint: number; lastMonthTotal: number; daysLeft: number };
  manager: { weekly_summary: boolean; phone: string | null; connected: boolean };
}

/** "74%"; abaixo de 10%, com uma casa ("0,4%"), para não virar zero. */
const pct = (v: number | null) =>
  v == null ? '—' : v > 0 && v < 0.1 ? `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : `${Math.round(v * 100)}%`;
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** "+12%" / "−5%" contra o período anterior (verde quando sobe). */
function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return null;
  const p = Math.round(((now - before) / before) * 100);
  if (!p) return <span className="text-zinc-500">igual ao período anterior</span>;
  return (
    <span className={p > 0 ? 'font-medium text-emerald-700' : 'font-medium text-red-700'}>
      {p > 0 ? '▲' : '▼'} {Math.abs(p)}% <span className="font-normal text-zinc-500">vs. período anterior</span>
    </span>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs">{hint}</p>}
    </div>
  );
}

/** Rampa sequencial azul (clara = agenda vazia, escura = cheia). */
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const shade = (rate: number) => RAMP[Math.min(RAMP.length - 1, Math.floor(rate * RAMP.length))];

/** Mapa de calor da ocupação: dia da semana × hora (só as horas em que a barbearia abre). */
function Heatmap({ heat }: { heat: ReportData['occupancy']['heat'] }) {
  const [hover, setHover] = useState<(typeof heat)[number] | null>(null);
  const [table, setTable] = useState(false);
  if (!heat.length) return <p className="text-sm text-zinc-500">Cadastre o expediente dos barbeiros para ver a ocupação.</p>;
  const hours = [...new Set(heat.map((c) => c.hour))].sort((a, b) => a - b);
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => heat.some((c) => c.weekday === d));
  const cell = (d: number, h: number) => heat.find((c) => c.weekday === d && c.hour === h);
  if (table) {
    return (
      <div>
        <button className="mb-2 text-xs text-zinc-500 underline" onClick={() => setTable(false)}>
          Ver o mapa
        </button>
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr>
                <th className="p-1 text-left font-medium text-zinc-500">Hora</th>
                {days.map((d) => (
                  <th key={d} className="p-1 text-right font-medium text-zinc-500">
                    {WEEKDAYS_SHORT[d]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hours.map((h) => (
                <tr key={h} className="border-t border-zinc-100">
                  <td className="p-1 text-zinc-500">{h}h</td>
                  {days.map((d) => {
                    const c = cell(d, h);
                    return (
                      <td key={d} className="p-1 text-right">
                        {c ? pct(c.booked_min / c.open_min) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="overflow-x-auto">
        <div className="inline-grid gap-[2px]" style={{ gridTemplateColumns: `2.25rem repeat(${hours.length}, minmax(1.6rem, 1fr))` }} onMouseLeave={() => setHover(null)}>
          <span />
          {hours.map((h) => (
            <span key={h} className="text-center text-[10px] text-zinc-500">
              {h}h
            </span>
          ))}
          {days.map((d) => (
            <div key={d} className="contents">
              <span className="self-center text-xs text-zinc-500">{WEEKDAYS_SHORT[d]}</span>
              {hours.map((h) => {
                const c = cell(d, h);
                const rate = c ? c.booked_min / c.open_min : null;
                return (
                  <span
                    key={h}
                    onMouseEnter={() => setHover(c ?? null)}
                    onClick={() => setHover(c ?? null)}
                    title={c ? `${WEEKDAYS[d]}, ${h}h: ${pct(rate)} ocupada` : `${WEEKDAYS[d]}, ${h}h: fechado`}
                    className={`h-6 rounded-[3px] ${c ? 'cursor-default' : 'bg-zinc-50'}`}
                    style={c ? { background: shade(rate!) } : undefined}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5">
          vazia
          <span className="flex">
            {RAMP.filter((_, i) => i % 2 === 0).map((c) => (
              <span key={c} className="h-2.5 w-4" style={{ background: c }} />
            ))}
          </span>
          cheia
        </span>
        <span className="min-h-4 text-zinc-700">
          {hover ? (
            <>
              <b>
                {WEEKDAYS[hover.weekday]}, {hover.hour}h
              </b>
              : {pct(hover.booked_min / hover.open_min)} ocupada ({Math.round(hover.booked_min / 60)}h de {Math.round(hover.open_min / 60)}h de agenda)
            </>
          ) : (
            'Passe o dedo ou o mouse nos quadrados.'
          )}
        </span>
        <button className="underline" onClick={() => setTable(true)}>
          Ver em tabela
        </button>
      </div>
    </div>
  );
}

/** Relatórios do dono: o que entrou, a agenda, os clientes e a previsão do mês. */
export function Reports() {
  const [period, setPeriod] = useState<Period>('mes');
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api<ReportData>('GET', `/api/shop/reports?period=${period}`).then(setData, (e) => setError(e.message));
  }, [period]);

  async function toggleSummary(on: boolean) {
    if (!data) return;
    setData({ ...data, manager: { ...data.manager, weekly_summary: on } });
    await api('PUT', '/api/shop/manager', { weekly_summary: on }).catch((e) => setError(e.message));
  }

  const f = data?.forecast;
  const r = data?.retention;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Relatórios</h1>
          <p className="text-sm text-zinc-500">
            {data ? `De ${ddmm(data.from)} a ${ddmm(data.to)}.` : ' '} Ocupação da agenda, clientes voltando e a previsão do mês.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setPeriod(id)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${period === id ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:bg-zinc-100'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {data && f && r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Entrou" value={money(data.numbers.income)} hint={<Delta now={data.numbers.income} before={data.previous.income} />} />
            <Tile label="Atendimentos" value={String(data.numbers.services)} hint={<Delta now={data.numbers.services} before={data.previous.services} />} />
            <Tile label="Ticket médio" value={money(data.numbers.average)} hint={<span className="text-zinc-500">{data.numbers.sales} vendas</span>} />
            <Tile label="Agenda ocupada" value={pct(data.occupancy.rate)} hint={<span className="text-zinc-500">do tempo aberto foi marcado</span>} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="min-w-0 space-y-3 lg:col-span-1">
              <p className="flex items-center gap-2 font-semibold">
                <TrendingUp className="size-5 text-zinc-400" /> Previsão do mês
              </p>
              <p className="text-3xl font-bold tabular-nums">{money(f.projected)}</p>
              <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100" aria-hidden>
                <div className="flex h-full">
                  <div style={{ width: `${f.projected ? (f.soFar / f.projected) * 100 : 0}%`, background: '#2a78d6' }} />
                  <div style={{ width: `${f.projected ? (f.scheduled / f.projected) * 100 : 0}%`, background: '#86b6ef' }} className="border-l-2 border-white" />
                  <div style={{ width: `${f.projected ? (Math.max(0, f.projected - f.soFar - f.scheduled) / f.projected) * 100 : 0}%`, background: '#cde2fb' }} className="border-l-2 border-white" />
                </div>
              </div>
              <ul className="space-y-1 text-sm">
                <li className="flex justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{ background: '#2a78d6' }} /> Entrou até hoje
                  </span>
                  <b className="tabular-nums">{money(f.soFar)}</b>
                </li>
                <li className="flex justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{ background: '#86b6ef' }} /> Horários marcados até o fim do mês
                  </span>
                  <b className="tabular-nums">{money(f.scheduled)}</b>
                </li>
                <li className="flex justify-between gap-2 text-zinc-500">
                  <span className="flex items-start gap-1.5">
                    <span className="mt-1 size-2.5 shrink-0 rounded-sm" style={{ background: '#cde2fb' }} /> Balcão, produtos e clube (média por dia × {f.daysLeft} dias)
                  </span>
                  <span className="tabular-nums">{money(Math.max(0, f.projected - f.soFar - f.scheduled))}</span>
                </li>
              </ul>
              <p className="text-xs text-zinc-500">
                No mesmo ponto do mês passado: {money(f.lastMonthSamePoint)} · o mês passado fechou em {money(f.lastMonthTotal)}.
              </p>
            </Card>

            <Card className="min-w-0 space-y-3 lg:col-span-2">
              <p className="flex items-center gap-2 font-semibold">
                <BarChart3 className="size-5 text-zinc-400" /> Ocupação da agenda por dia e hora
              </p>
              <Heatmap heat={data.occupancy.heat} />
              {data.occupancy.byBarber.length > 1 && (
                <ul className="space-y-2 border-t border-zinc-100 pt-3 text-sm">
                  {data.occupancy.byBarber.map((b) => (
                    <li key={b.id} className="grid grid-cols-[6rem_1fr_3rem] items-center gap-2">
                      <span className="truncate">{b.name}</span>
                      <span className="h-2 rounded-full bg-zinc-100">
                        <span className="block h-2 rounded-full" style={{ width: `${(b.rate ?? 0) * 100}%`, background: '#2a78d6' }} />
                      </span>
                      <b className="text-right tabular-nums">{pct(b.rate)}</b>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-zinc-500">Horários claros são os mais vazios: bons para o horário vazio com desconto (em Indicação e promoções).</p>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 space-y-3">
              <p className="flex items-center gap-2 font-semibold">
                <Users className="size-5 text-zinc-400" /> Clientes
              </p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-zinc-50 p-2">
                  <p className="text-xl font-bold tabular-nums">{r.active}</p>
                  <p className="text-xs text-zinc-500">atendidos em 90 dias</p>
                </div>
                <div className="rounded-xl bg-zinc-50 p-2">
                  <p className="text-xl font-bold tabular-nums">{r.newThisMonth}</p>
                  <p className="text-xs text-zinc-500">novos neste mês</p>
                </div>
                <div className="rounded-xl bg-zinc-50 p-2">
                  <p className="text-xl font-bold tabular-nums">{pct(r.returnRate)}</p>
                  <p className="text-xs text-zinc-500">voltaram em até 45 dias</p>
                </div>
              </div>
              <p className="text-sm text-zinc-600">
                {r.avgInterval ? `Em média, o cliente volta a cada ${r.avgInterval} dias. ` : ''}
                {r.away ? `${r.away} ${r.away === 1 ? 'cliente sumiu' : 'clientes sumiram'}: o robô chama de volta (Robô WhatsApp → Clientes sumidos).` : ''}
              </p>
              <div>
                <p className="mb-1 text-sm font-medium">Passando do tempo de voltar {r.atRisk.length > 0 && <span className="text-zinc-500">({r.atRisk.length})</span>}</p>
                {r.atRisk.length === 0 ? (
                  <p className="text-sm text-zinc-500">Ninguém agora. 👏</p>
                ) : (
                  <ul className="max-h-64 divide-y divide-zinc-100 overflow-y-auto text-sm">
                    {r.atRisk.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="min-w-0">
                          <b>{c.name}</b>{' '}
                          <span className="text-zinc-500">
                            · {c.days} dias sem vir{c.interval ? ` (costuma voltar em ${c.interval})` : ''}
                            {c.robotIn != null && ` · o robô chama ${c.robotIn <= 1 ? 'amanhã' : `em ${c.robotIn} dias`}`}
                          </span>
                        </span>
                        <a
                          href={whatsappLink(c.phone, `Oi, ${c.name.split(/\s+/)[0]}! Tudo bem? Faz um tempinho que você não aparece. Bora marcar seu horário?`)}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-zinc-500 hover:text-emerald-700"
                          aria-label={`WhatsApp de ${c.name} (${phone(c.phone)})`}
                        >
                          <MessageCircle className="size-4" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card className="min-w-0 space-y-3">
              <p className="flex items-center gap-2 font-semibold">
                <MessageCircle className="size-5 text-zinc-400" /> Gerente virtual no WhatsApp
              </p>
              <p className="text-sm text-zinc-600">
                Pergunte pelo WhatsApp {data.manager.phone ? <b>{phone(data.manager.phone)}</b> : 'do sistema (o mesmo que manda os avisos da mensalidade)'}, do celular cadastrado
                no seu login:
              </p>
              <ul className="grid grid-cols-2 gap-1.5 text-sm">
                {['“Quanto entrou hoje?”', '“Como está a agenda amanhã?”', '“Previsão do mês”', '“Quem está sumindo?”', '“Bloquear o Paulo amanhã das 14h às 16h”', '“Resumo da semana”'].map((q) => (
                  <li key={q} className="rounded-lg bg-zinc-50 px-2.5 py-1.5 text-zinc-700">
                    {q}
                  </li>
                ))}
              </ul>
              {data.manager.phone && (
                <a href={whatsappLink(data.manager.phone, 'Oi! Quanto entrou hoje?')} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-emerald-700 underline">
                  Abrir a conversa
                </a>
              )}
              <label className="flex items-start gap-2 border-t border-zinc-100 pt-3 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={data.manager.weekly_summary} onChange={(e) => void toggleSummary(e.target.checked)} />
                <span>
                  <b>Resumo da semana</b> toda segunda às 8h: quanto entrou (comparando com a semana anterior), atendimentos, ocupação, faltas, clientes novos e
                  a nota dos clientes.
                </span>
              </label>
              {!data.manager.connected && <p className="text-xs text-amber-700">O WhatsApp do sistema ainda não foi ligado pelo administrador da plataforma.</p>}
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
