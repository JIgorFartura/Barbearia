import { ArrowDownCircle, ArrowUpCircle, Ban, HandCoins, Pencil, Plus, Receipt, Trash2, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { CheckoutModal } from '../../components/Checkout';
import { ReceiptPreview, type ReceiptInfo } from '../../components/Receipt';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { IN_CATEGORIES, METHODS, OUT_CATEGORIES, centsToInput, compactMoney, methodLabel, parseMoney } from '../../lib/finance';
import { addDays, date as fmtDate, money, todayStr } from '../../lib/format';

// Cores das séries (validadas para daltonismo): entradas = azul, saídas = laranja.
const SERIES = { in: '#2a78d6', out: '#eb6834' };

const TABS = [
  { id: 'resumo', label: 'Resumo' },
  { id: 'caixa', label: 'Caixa' },
  { id: 'vendas', label: 'Vendas' },
  { id: 'recebimentos', label: 'Recebimentos' },
  { id: 'comissoes', label: 'Comissões' },
] as const;
type Tab = (typeof TABS)[number]['id'];

interface Period {
  from: string;
  to: string;
}

function presets(): { id: string; label: string; period: Period }[] {
  const today = todayStr();
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  return [
    { id: 'hoje', label: 'Hoje', period: { from: today, to: today } },
    { id: '7d', label: '7 dias', period: { from: addDays(today, -6), to: today } },
    { id: 'mes', label: 'Este mês', period: { from: monthStart, to: today } },
    { id: 'passado', label: 'Mês passado', period: { from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd } },
  ];
}

function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const list = presets();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {list.map((p) => (
        <button
          key={p.id}
          onClick={() => onChange(p.period)}
          className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${p.period.from === value.from && p.period.to === value.to ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:bg-zinc-100'}`}
        >
          {p.label}
        </button>
      ))}
      <span className="flex items-center gap-1 text-sm">
        <input type="date" className="rounded-md border border-zinc-300 px-2 py-1" value={value.from} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
        até
        <input type="date" className="rounded-md border border-zinc-300 px-2 py-1" value={value.to} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
      </span>
    </div>
  );
}

/** Financeiro da barbearia: resumo, caixa, vendas e comissões. */
export function Finance() {
  const [tab, setTab] = useState<Tab>('resumo');
  const [period, setPeriod] = useState<Period>(() => presets()[2].period);
  return (
    <section>
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Wallet className="size-6" /> Financeiro
        </h1>
        <p className="text-sm text-zinc-500">Faturamento, gastos, caixa e comissões — tudo ligado à agenda e ao balcão.</p>
      </div>
      <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${tab === t.id ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab !== 'comissoes' && (
        <div className="mb-5">
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      )}
      {tab === 'resumo' && <SummaryTab period={period} />}
      {tab === 'caixa' && <CashTab period={period} />}
      {tab === 'vendas' && <SalesTab period={period} />}
      {tab === 'recebimentos' && <ReceivedTab period={period} />}
      {tab === 'comissoes' && <CommissionsTab />}
    </section>
  );
}

// ---------- Resumo

interface SummaryData {
  income: number;
  expenses: number;
  result: number;
  salesCount: number;
  salesTotal: number;
  discounts: number;
  averageTicket: number;
  pendingOut: number;
  overdueOut: number;
  byMethod: { method: string; total: number; count: number }[];
  byBarber: { barber_id: number; name: string; services: number; products: number; revenue: number; commission: number }[];
  topItems: { name: string; kind: string; qty: number; total: number }[];
  expensesByCategory: { category: string; total: number }[];
  byDay: { date: string; in: number; out: number }[];
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

function SummaryTab({ period }: { period: Period }) {
  const [data, setData] = useState<SummaryData | null>(null);
  useEffect(() => {
    setData(null);
    api<SummaryData>('GET', `/api/shop/finance/summary?from=${period.from}&to=${period.to}`).then(setData);
  }, [period]);
  if (!data) return null;
  const maxBarber = Math.max(1, ...data.byBarber.map((b) => b.revenue));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Faturamento (entradas)" value={money(data.income)} hint={`${data.salesCount} venda(s) · ticket médio ${money(data.averageTicket)}`} />
        <Tile label="Gastos (saídas)" value={money(data.expenses)} hint={data.discounts ? `Descontos dados: ${money(data.discounts)}` : undefined} />
        <Tile label={data.result >= 0 ? 'Resultado (lucro)' : 'Resultado (prejuízo)'} value={`${data.result < 0 ? '−\u00a0' : ''}${money(Math.abs(data.result))}`} hint="Entradas menos saídas pagas" />
        <Tile
          label="Contas a pagar"
          value={money(data.pendingOut)}
          hint={data.overdueOut ? <span className="font-medium text-red-700">⚠ {money(data.overdueOut)} vencidas</span> : 'Nenhuma vencida'}
        />
      </div>

      <Card>
        <DailyChart days={data.byDay} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="mb-3 font-semibold">Por barbeiro</p>
          {data.byBarber.length === 0 && <p className="text-sm text-zinc-500">As vendas fechadas aparecem aqui.</p>}
          <ul className="space-y-3">
            {data.byBarber.map((b) => (
              <li key={b.barber_id} className="text-sm">
                <div className="flex justify-between">
                  <span className="font-medium">{b.name}</span>
                  <span className="tabular-nums">{money(b.revenue)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-zinc-100">
                  <div className="h-2 rounded-full bg-zinc-800" style={{ width: `${(b.revenue / maxBarber) * 100}%` }} />
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {b.services} serviço(s) · {b.products} produto(s) · comissão {money(b.commission)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <p className="mb-3 font-semibold">Formas de pagamento</p>
          {data.byMethod.length === 0 && <p className="text-sm text-zinc-500">Sem vendas no período.</p>}
          <ul className="space-y-1.5 text-sm">
            {data.byMethod.map((m) => (
              <li key={m.method} className="flex justify-between">
                <span>
                  {methodLabel(m.method)} <span className="text-zinc-500">({m.count})</span>
                </span>
                <span className="font-semibold tabular-nums">{money(m.total)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 mb-2 font-semibold">Mais vendidos</p>
          <ul className="space-y-1.5 text-sm">
            {data.topItems.map((i) => (
              <li key={`${i.kind}${i.name}`} className="flex justify-between">
                <span>
                  {i.name} <span className="text-zinc-500">× {i.qty}</span>
                </span>
                <span className="tabular-nums">{money(i.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="lg:col-span-2">
          <p className="mb-3 font-semibold">Gastos por categoria</p>
          {data.expensesByCategory.length === 0 && <p className="text-sm text-zinc-500">Nenhum gasto pago no período.</p>}
          <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {data.expensesByCategory.map((c) => (
              <li key={c.category} className="flex justify-between">
                <span>{c.category}</span>
                <span className="tabular-nums">{money(c.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/** Colunas por dia: entradas e saídas lado a lado, com dica ao passar o mouse e versão em tabela. */
function DailyChart({ days }: { days: SummaryData['byDay'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(1, ...days.map((d) => Math.max(d.in, d.out)));
  // Escala com números redondos para as linhas de grade.
  const step = useMemo(() => {
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  }, [max]);
  const top = step * 4;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const label = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">Entradas e saídas por dia</p>
        <div className="flex items-center gap-4 text-xs text-zinc-600">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: SERIES.in }} /> Entradas
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: SERIES.out }} /> Saídas
          </span>
          <button className="font-medium text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline" onClick={() => setAsTable(!asTable)}>
            {asTable ? 'Ver gráfico' : 'Ver tabela'}
          </button>
        </div>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="py-1 font-medium">Dia</th>
                <th className="py-1 text-right font-medium">Entradas</th>
                <th className="py-1 text-right font-medium">Saídas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {days.map((d) => (
                <tr key={d.date}>
                  <td className="py-1">{label(d.date)}</td>
                  <td className="py-1 text-right tabular-nums">{money(d.in)}</td>
                  <td className="py-1 text-right tabular-nums">{money(d.out)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative h-52 pl-12" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <div key={t} className="absolute right-0 left-12 border-t border-zinc-100" style={{ bottom: `${(t / top) * 100}%` }}>
              <span className="absolute -top-2 -left-12 w-10 text-right text-[10px] text-zinc-400 tabular-nums">{compactMoney(t)}</span>
            </div>
          ))}
          <div className="absolute inset-0 left-12 flex items-end">
            {days.map((d, i) => (
              <div key={d.date} className="flex h-full flex-1 items-end justify-center gap-[2px]" onMouseEnter={() => setHover(i)}>
                {(['in', 'out'] as const).map((k) => (
                  <div
                    key={k}
                    className="w-full max-w-3 rounded-t"
                    style={{ height: `${(d[k] / top) * 100}%`, minHeight: d[k] ? 2 : 0, background: SERIES[k], opacity: hover === null || hover === i ? 1 : 0.45 }}
                  />
                ))}
              </div>
            ))}
            {hover !== null && <DayTip day={days[hover]} at={(hover + 0.5) / days.length} />}
          </div>
        </div>
      )}
      {!asTable && (
        <div className="mt-1 flex justify-between pl-12 text-[10px] text-zinc-400">
          <span>{label(days[0].date)}</span>
          {days.length > 2 && <span>{label(days[Math.floor(days.length / 2)].date)}</span>}
          <span>{label(days[days.length - 1].date)}</span>
        </div>
      )}
    </div>
  );
}

/** Dica do dia no topo do gráfico; perto das bordas ela se alinha para dentro e não vaza do cartão. */
function DayTip({ day, at }: { day: SummaryData['byDay'][number]; at: number }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 w-36 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-white shadow-lg"
      style={{ left: `${at * 100}%`, transform: `translateX(-${at * 100}%)` }}
    >
      <p className="font-semibold">{fmtDate(day.date)}</p>
      <p className="flex justify-between">
        <span>Entradas</span> <span className="tabular-nums">{money(day.in)}</span>
      </p>
      <p className="flex justify-between">
        <span>Saídas</span> <span className="tabular-nums">{money(day.out)}</span>
      </p>
    </div>
  );
}

// ---------- Caixa

interface Entry {
  id: number;
  type: 'in' | 'out';
  category: string;
  description: string | null;
  amount_cents: number;
  method: string | null;
  date: string;
  status: 'paid' | 'pending';
  manual: boolean;
  sale_id: number | null;
}

function CashTab({ period }: { period: Period }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [editing, setEditing] = useState<Partial<Entry> | null>(null);
  const [paying, setPaying] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Entry[]>('GET', `/api/shop/finance/entries?from=${period.from}&to=${period.to}`).then(setEntries, (e) => setError(e.message));
  }, [period]);
  useEffect(load, [load]);

  const paidIn = entries?.filter((e) => e.type === 'in' && e.status === 'paid' && e.date >= period.from && e.date <= period.to).reduce((s, e) => s + e.amount_cents, 0) ?? 0;
  const paidOut = entries?.filter((e) => e.type === 'out' && e.status === 'paid' && e.date >= period.from && e.date <= period.to).reduce((s, e) => s + e.amount_cents, 0) ?? 0;
  const pending = entries?.filter((e) => e.status === 'pending') ?? [];

  async function remove(e: Entry) {
    if (!confirm('Excluir este lançamento?')) return;
    await api('DELETE', `/api/shop/finance/entries/${e.id}`).catch((err) => setError(err.message));
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          Entradas <b className="tabular-nums">{money(paidIn)}</b> · Saídas <b className="tabular-nums">{money(paidOut)}</b> · Saldo do período{' '}
          <b className="tabular-nums">{`${paidIn < paidOut ? '−\u00a0' : ''}${money(Math.abs(paidIn - paidOut))}`}</b>
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setEditing({ type: 'in', status: 'paid', date: todayStr(), category: IN_CATEGORIES[2] })}>
            <ArrowDownCircle className="size-4" /> Entrada
          </Button>
          <Button onClick={() => setEditing({ type: 'out', status: 'paid', date: todayStr(), category: OUT_CATEGORIES[2] })}>
            <ArrowUpCircle className="size-4" /> Saída / conta
          </Button>
        </div>
      </div>
      <ErrorText error={error} />

      {pending.length > 0 && (
        <Card className="!p-4">
          <p className="mb-2 font-semibold">Contas a pagar</p>
          <ul className="divide-y divide-zinc-100 text-sm">
            {pending.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="break-words">{e.description || e.category}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    vence {fmtDate(e.date)}
                    {e.date < todayStr() && <Badge tone="red">Vencida</Badge>}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <b className="tabular-nums">{money(e.amount_cents)}</b>
                  <Button variant="ghost" className="!px-2.5 !py-1" onClick={() => setPaying(e)}>
                    Paguei
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {entries?.length === 0 && <EmptyState icon={<Wallet className="size-6" />} title="Nenhum lançamento no período" text="As vendas entram sozinhas. Lance aqui aluguel, contas, compras de produtos e outras entradas." />}
      {entries && entries.length > 0 && (
        <Card className="!p-0">
          <ul className="divide-y divide-zinc-100 text-sm">
            {entries
              .filter((e) => e.status === 'paid')
              .map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                  {e.type === 'in' ? (
                    <ArrowDownCircle className="size-4 shrink-0 text-emerald-600" aria-label="Entrada" />
                  ) : (
                    <ArrowUpCircle className="size-4 shrink-0 text-red-600" aria-label="Saída" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{e.description || e.category}</p>
                    <p className="text-xs text-zinc-500">
                      {fmtDate(e.date)} · {e.category}
                      {e.method ? ` · ${methodLabel(e.method)}` : ''}
                    </p>
                  </div>
                  <b className={`shrink-0 whitespace-nowrap tabular-nums ${e.type === 'out' ? 'text-zinc-700' : ''}`}>
                    {e.type === 'out' ? '− ' : '+ '}
                    {money(e.amount_cents)}
                  </b>
                  {e.manual ? (
                    <span className="flex shrink-0 gap-1">
                      <button className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800" onClick={() => setEditing(e)} aria-label="Editar">
                        <Pencil className="size-3.5" />
                      </button>
                      <button className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600" onClick={() => remove(e)} aria-label="Excluir">
                        <Trash2 className="size-3.5" />
                      </button>
                    </span>
                  ) : (
                    <span className="hidden w-[3.25rem] shrink-0 text-right text-[10px] text-zinc-400 uppercase sm:block">auto</span>
                  )}
                </li>
              ))}
          </ul>
        </Card>
      )}

      {editing && (
        <EntryModal
          entry={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {paying && (
        <PayModal
          entry={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function EntryModal({ entry, onClose, onDone }: { entry: Partial<Entry>; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    type: entry.type ?? 'out',
    category: entry.category ?? '',
    description: entry.description ?? '',
    amount: entry.amount_cents ? centsToInput(entry.amount_cents) : '',
    method: entry.method ?? '',
    date: entry.date ?? todayStr(),
    status: entry.status ?? 'paid',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = form.type === 'in' ? IN_CATEGORIES : OUT_CATEGORIES;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      type: form.type,
      category: form.category,
      description: form.description || null,
      amount_cents: parseMoney(form.amount),
      method: form.status === 'paid' ? form.method || null : null,
      date: form.date,
      status: form.status,
    };
    try {
      await api(entry.id ? 'PUT' : 'POST', entry.id ? `/api/shop/finance/entries/${entry.id}` : '/api/shop/finance/entries', body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={entry.id ? 'Editar lançamento' : form.type === 'in' ? 'Nova entrada' : 'Nova saída'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(['in', 'out'] as const).map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setForm({ ...form, type: t, category: (t === 'in' ? IN_CATEGORIES : OUT_CATEGORIES)[0] })}
              className={`rounded-lg py-2 text-sm font-semibold ring-1 ${form.type === t ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200'}`}
            >
              {t === 'in' ? 'Entrada' : 'Saída'}
            </button>
          ))}
        </div>
        <Field label="Categoria">
          <select className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {!categories.includes(form.category) && form.category && <option value={form.category}>{form.category}</option>}
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Descrição">
          <Input value={form.description} placeholder={form.type === 'out' ? 'Ex.: conta de luz de novembro' : 'Ex.: anúncio da Brasa Burger'} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor (R$)">
            <Input required inputMode="decimal" placeholder="0,00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label={form.status === 'pending' ? 'Vencimento' : 'Data'}>
            <Input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
        </div>
        {form.type === 'out' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-zinc-900" checked={form.status === 'pending'} onChange={(e) => setForm({ ...form, status: e.target.checked ? 'pending' : 'paid' })} />
            Ainda vou pagar (conta a pagar)
          </label>
        )}
        {form.status === 'paid' && (
          <Field label="Forma">
            <select className={inputClass} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              <option value="">—</option>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PayModal({ entry, onClose, onDone }: { entry: Entry; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayStr());
  const [method, setMethod] = useState('pix');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Pagar: ${entry.description || entry.category}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-2xl font-bold">{money(entry.amount_cents)}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pago em">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Forma">
            <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <ErrorText error={error} />
        <Button
          className="w-full"
          onClick={() =>
            api('POST', `/api/shop/finance/entries/${entry.id}/pay`, { date, method }).then(onDone, (e) => setError(e.message))
          }
        >
          Confirmar pagamento
        </Button>
      </div>
    </Modal>
  );
}

// ---------- Vendas

interface Sale {
  id: number;
  date: string;
  customer_name: string | null;
  total_cents: number;
  discount_cents: number;
  method: string;
  status: 'closed' | 'cancelled';
  appointment_id: number | null;
  items: { id: number; name: string; qty: number; total_cents: number; barber_name: string | null; commission_cents: number; paid: boolean }[];
}

function SalesTab({ period }: { period: Period }) {
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Sale[]>('GET', `/api/shop/finance/sales?from=${period.from}&to=${period.to}`).then(setSales, (e) => setError(e.message));
  }, [period]);
  useEffect(load, [load]);

  async function cancel(s: Sale) {
    if (!confirm(`Cancelar a venda #${s.id} de ${money(s.total_cents)}? Ela sai do caixa e os carimbos são retirados.`)) return;
    setError(null);
    await api('POST', `/api/shop/finance/sales/${s.id}/cancel`).catch((e) => setError(e.message));
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Nova venda
        </Button>
      </div>
      <ErrorText error={error} />
      {sales?.length === 0 && (
        <EmptyState icon={<Receipt className="size-6" />} title="Nenhuma venda no período" text="Feche os atendimentos pela Agenda (botão Fechar) ou registre uma venda de balcão." />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {sales?.map((s) => (
          <Card key={s.id} className={`!p-4 ${s.status === 'cancelled' ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">
                  #{s.id} · {s.customer_name ?? 'Cliente avulso'}
                </p>
                <p className="text-xs text-zinc-500">
                  {fmtDate(s.date)} · {methodLabel(s.method)}
                  {s.appointment_id ? ' · da agenda' : ''}
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold tabular-nums">{money(s.total_cents)}</p>
                {s.status === 'cancelled' && <Badge tone="red">Cancelada</Badge>}
              </div>
            </div>
            <ul className="mt-2 space-y-0.5 text-sm text-zinc-600">
              {s.items.map((i) => (
                <li key={i.id} className="flex justify-between gap-2">
                  <span>
                    {i.qty}× {i.name}
                    {i.barber_name && <span className="text-zinc-400"> · {i.barber_name}</span>}
                  </span>
                  <span className="text-xs text-zinc-500 tabular-nums">comissão {money(i.commission_cents)}</span>
                </li>
              ))}
            </ul>
            {s.discount_cents > 0 && <p className="mt-1 text-xs text-zinc-500">Desconto de {money(s.discount_cents)}</p>}
            {s.status === 'closed' && (
              <button onClick={() => cancel(s)} className="mt-2 inline-flex items-center gap-1 text-xs text-red-600 hover:underline">
                <Ban className="size-3.5" /> Cancelar venda
              </button>
            )}
          </Card>
        ))}
      </div>
      {creating && (
        <CheckoutModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------- Recebimentos: o que os clientes pagaram (só a barbearia vê a lista de todos)

interface Received {
  items: {
    kind: 'compra' | 'clube';
    id: number;
    date: string;
    description: string;
    amount_cents: number;
    method: string | null;
    /** Clube pago no cartão automático (Cielo). */
    card: boolean;
    receipt: ReceiptInfo | null;
    customer: string | null;
  }[];
  totals: { total: number; count: number; counter: number; club: number; receipts: number };
}

function ReceivedTab({ period }: { period: Period }) {
  const [data, setData] = useState<Received | null>(null);
  const [kind, setKind] = useState<'' | 'compra' | 'clube'>('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Received>('GET', `/api/shop/finance/received?from=${period.from}&to=${period.to}`).then(setData, (e) => setError(e.message));
  }, [period]);
  const items = data?.items.filter((i) => !kind || i.kind === kind) ?? [];

  return (
    <div className="space-y-4">
      <ErrorText error={error} />
      {data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile label="Recebido dos clientes" value={money(data.totals.total)} hint={`${data.totals.count} pagamento(s)`} />
          <Tile label="Vendas (agenda e balcão)" value={money(data.totals.counter)} />
          <Tile
            label="Clube de assinatura"
            value={money(data.totals.club)}
            hint={data.totals.receipts ? `${data.totals.receipts} com comprovante do PIX` : undefined}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['', 'Todos'],
            ['compra', 'Vendas'],
            ['clube', 'Clube'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setKind(id)}
            className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ${kind === id ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:bg-zinc-100'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {data && items.length === 0 && (
        <EmptyState
          icon={<HandCoins className="size-6" />}
          title="Nenhum pagamento no período"
          text="As vendas da agenda e do balcão e as mensalidades do clube aparecem aqui assim que entram no caixa."
        />
      )}
      {items.length > 0 && (
        <Card className="!p-0">
          <ul className="divide-y divide-zinc-100 text-sm">
            {items.map((p) => (
              <li key={`${p.kind}${p.id}`} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{p.customer ?? 'Cliente avulso'}</p>
                    <p className="text-xs text-zinc-500">
                      {fmtDate(p.date)} · {p.card ? 'Cartão automático (Cielo)' : methodLabel(p.method)}
                    </p>
                    <p className="truncate text-xs text-zinc-500">{p.description}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-bold tabular-nums">{money(p.amount_cents)}</p>
                    <Badge tone={p.kind === 'clube' ? 'gold' : 'zinc'}>{p.kind === 'clube' ? 'Clube' : 'Venda'}</Badge>
                  </div>
                </div>
                {p.receipt && (
                  <div className="mt-2">
                    <ReceiptPreview url={`/api/shop/charges/${p.id}/receipt`} receipt={p.receipt} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-zinc-500">
        Só a barbearia vê os pagamentos de todos os clientes. Cada cliente vê só os dele, na área do cliente; a administração do sistema não vê nenhum.
      </p>
    </div>
  );
}

// ---------- Comissões

interface Balance {
  barber_id: number;
  name: string;
  active: number;
  unpaid_cents: number;
  unpaid_items: number;
  since: string | null;
  lastPayout: { date: string; amount_cents: number } | null;
}

function CommissionsTab() {
  const [list, setList] = useState<Balance[] | null>(null);
  const [paying, setPaying] = useState<Balance | null>(null);
  const [statement, setStatement] = useState<Balance | null>(null);
  const load = useCallback(() => {
    api<Balance[]>('GET', '/api/shop/finance/commissions').then(setList);
  }, []);
  useEffect(load, [load]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        A comissão é calculada em cada venda pelas regras do barbeiro (aba Barbeiros: % nos serviços, valor fixo por serviço e % nos produtos). Ao pagar, sai do caixa como
        “Comissões”.
      </p>
      {list?.length === 0 && <EmptyState icon={<Wallet className="size-6" />} title="Nenhum barbeiro" text="Cadastre os barbeiros e as regras de comissão." />}
      <div className="grid gap-3 md:grid-cols-2">
        {list?.map((b) => (
          <Card key={b.barber_id} className="!p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold">
                  {b.name} {!b.active && <Badge>Inativo</Badge>}
                </p>
                <p className="text-xs text-zinc-500">
                  {b.lastPayout ? `Último pagamento: ${money(b.lastPayout.amount_cents)} em ${fmtDate(b.lastPayout.date)}` : 'Nenhum pagamento ainda'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold tabular-nums">{money(b.unpaid_cents)}</p>
                <p className="text-xs text-zinc-500">{b.unpaid_items ? `a pagar · ${b.unpaid_items} item(ns) desde ${fmtDate(b.since)}` : 'nada em aberto'}</p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button className="!py-1.5" disabled={!b.unpaid_cents} onClick={() => setPaying(b)}>
                Pagar comissão
              </Button>
              <Button variant="ghost" className="!py-1.5" onClick={() => setStatement(b)}>
                Extrato
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {paying && (
        <PayoutModal
          balance={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            load();
          }}
        />
      )}
      {statement && <StatementModal balance={statement} onClose={() => setStatement(null)} />}
    </div>
  );
}

function PayoutModal({ balance, onClose, onDone }: { balance: Balance; onClose: () => void; onDone: () => void }) {
  const [until, setUntil] = useState(todayStr());
  const [method, setMethod] = useState('pix');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Pagar comissão · ${balance.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600">
          Em aberto: <b>{money(balance.unpaid_cents)}</b> ({balance.unpaid_items} item(ns)). Paga tudo o que foi vendido até a data abaixo.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendas até">
            <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          <Field label="Forma">
            <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <ErrorText error={error} />
        <Button
          className="w-full"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api('POST', '/api/shop/finance/payouts', { barber_id: balance.barber_id, until, method, notes: null });
              onDone();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Registrar pagamento
        </Button>
      </div>
    </Modal>
  );
}

function StatementModal({ balance, onClose }: { balance: Balance; onClose: () => void }) {
  const [period, setPeriod] = useState<Period>(() => presets()[2].period);
  const [data, setData] = useState<{
    items: { date: string; sale_id: number; customer: string | null; name: string; qty: number; total_cents: number; commission_cents: number; paid: boolean }[];
    revenue: number;
    commission: number;
  } | null>(null);
  useEffect(() => {
    api<typeof data>('GET', `/api/shop/finance/commissions/${balance.barber_id}?from=${period.from}&to=${period.to}`).then(setData);
  }, [balance.barber_id, period]);
  return (
    <Modal title={`Extrato · ${balance.name}`} onClose={onClose}>
      <div className="space-y-3">
        <PeriodPicker value={period} onChange={setPeriod} />
        {data && (
          <>
            <p className="text-sm">
              Vendeu <b>{money(data.revenue)}</b> · comissão <b>{money(data.commission)}</b>
            </p>
            <ul className="max-h-80 divide-y divide-zinc-100 overflow-y-auto text-sm">
              {data.items.map((i, idx) => (
                <li key={idx} className="flex justify-between gap-2 py-1.5">
                  <span>
                    {fmtDate(i.date)} · {i.qty}× {i.name}
                    <span className="text-zinc-500"> · {i.customer ?? 'avulso'}</span>
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {money(i.commission_cents)}
                    <Badge tone={i.paid ? 'green' : 'gold'}>{i.paid ? 'pago' : 'a pagar'}</Badge>
                  </span>
                </li>
              ))}
              {data.items.length === 0 && <li className="py-2 text-zinc-500">Nada no período.</li>}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
