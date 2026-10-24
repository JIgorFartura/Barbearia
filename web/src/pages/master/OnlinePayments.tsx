import { CreditCard } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PAY_METHOD, payStatus } from '../../components/OnlinePay';
import { Badge, Card, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { addDays, date, money, todayStr } from '../../lib/format';

type Kind = 'mensalidade' | 'clube' | 'sinal';

interface Item {
  id: number;
  provider: 'asaas' | 'cielo';
  shop: string | null;
  kind: Kind;
  value_cents: number;
  net_cents: number | null;
  net: number;
  platform: number;
  toShop: number;
  platform_fee_pct: number;
  method: string | null;
  status: string;
  paid: boolean;
  duplicate: number;
  created_at: string;
  paid_at: string | null;
}

interface Payments {
  /** O Asaas está configurado (chave de API). */
  asaas: boolean;
  /** A Cielo da plataforma está configurada (mensalidade no cartão). */
  cielo: boolean;
  from: string;
  to: string;
  items: Item[];
  totals: {
    processed: number;
    fees: number;
    monthly: number;
    customers: number;
    platformShare: number;
    toShops: number;
    count: number;
    byMethod: { method: string; total: number }[];
  };
}

const KIND: Record<Kind, string> = { mensalidade: 'Mensalidade', clube: 'Clube', sinal: 'Sinal' };

function period(id: 'month' | 'last' | '30d'): { from: string; to: string } {
  const today = todayStr();
  const monthStart = `${today.slice(0, 7)}-01`;
  if (id === 'month') return { from: monthStart, to: today };
  if (id === '30d') return { from: addDays(today, -29), to: today };
  const lastEnd = addDays(monthStart, -1);
  return { from: `${lastEnd.slice(0, 7)}-01`, to: lastEnd };
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

/**
 * Pagamentos online: mensalidades das barbearias (cartão pela Cielo; PIX pelo Asaas) e o que os clientes
 * delas pagaram no cartão (clube e sinal, direto na Cielo de cada barbearia). Sem dados dos clientes.
 */
export function OnlinePaymentsCard() {
  const [range, setRange] = useState<'month' | 'last' | '30d' | 'custom'>('month');
  const [custom, setCustom] = useState(() => period('month'));
  const [kind, setKind] = useState<Kind | ''>('');
  const [data, setData] = useState<Payments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { from, to } = range === 'custom' ? custom : period(range);

  useEffect(() => {
    if (!from || !to) return;
    const q = new URLSearchParams({ from, to, ...(kind ? { kind } : {}) });
    api<Payments>('GET', `/api/master/payments?${q}`).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(e.message),
    );
  }, [from, to, kind]);

  const t = data?.totals;
  return (
    <Card className="space-y-4">
      <div>
        <p className="flex items-center gap-2 font-semibold">
          <CreditCard className="size-4" /> Pagamentos online
        </p>
        <p className="text-sm text-zinc-500">
          Mensalidades das barbearias (cartão pela Cielo, PIX pelo Asaas) e o que os clientes delas pagaram no cartão (clube e sinal, direto na conta Cielo de cada
          barbearia). Sem dados dos clientes.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm" value={range} onChange={(e) => setRange(e.target.value as typeof range)} aria-label="Período">
          <option value="month">Este mês</option>
          <option value="last">Mês passado</option>
          <option value="30d">Últimos 30 dias</option>
          <option value="custom">Escolher datas</option>
        </select>
        {range === 'custom' && (
          <span className="flex items-center gap-1 text-sm">
            <Input type="date" className="!w-auto !py-1.5" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="De" />
            até
            <Input type="date" className="!w-auto !py-1.5" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="Até" />
          </span>
        )}
        <span className="flex flex-wrap gap-1.5">
          {(
            [
              ['', 'Todos'],
              ['mensalidade', 'Mensalidades'],
              ['clube', 'Clube'],
              ['sinal', 'Sinal'],
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
        </span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {t && (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Tile label="Pago no período" value={money(t.processed)} hint={`${t.count} pagamento(s)`} />
            <Tile label="Mensalidades (líquido)" value={money(t.monthly)} />
            <Tile
              label="Clientes → barbearias"
              value={money(t.customers)}
              hint={t.platformShare > 0 ? `sua parte: ${money(t.platformShare)}` : 'direto na conta de cada barbearia'}
            />
            <Tile label="Taxas (estimadas)" value={money(t.fees)} hint="cartão e PIX" />
          </div>
          {t.byMethod.length > 0 && (
            <p className="text-xs text-zinc-500">
              Por forma:{' '}
              {[...t.byMethod]
                .sort((a, b) => b.total - a.total)
                .map((m) => `${PAY_METHOD[m.method] ?? m.method} ${money(m.total)}`)
                .join(' · ')}
            </p>
          )}
        </>
      )}

      {data && data.items.length === 0 && (
        <p className="text-sm text-zinc-500">
          {data.asaas || data.cielo ? 'Nenhum pagamento online nesse período.' : 'Ligue a Cielo logo abaixo para receber as mensalidades no cartão automático.'}
        </p>
      )}
      {data && data.items.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-xl text-sm ring-1 ring-zinc-200">
          {data.items.map((i) => {
            const st = payStatus(i.status);
            return (
              <li key={i.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-2.5">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate">
                    <b>{i.shop ?? 'Barbearia removida'}</b> · {KIND[i.kind]}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {date(i.paid_at ?? i.created_at)}
                    {i.method && i.method !== 'UNDEFINED' && ` · ${PAY_METHOD[i.method] ?? i.method}`}
                    {` · ${i.provider === 'cielo' ? 'Cielo' : 'Asaas'}`}
                  </p>
                  {Boolean(i.duplicate) && (
                    <p className="text-xs text-amber-700">
                      {i.kind === 'mensalidade' ? 'Pago em dobro: devolva à barbearia (estorno na Cielo ou no Asaas).' : 'Pago em dobro: a barbearia devolve ao cliente.'}
                    </p>
                  )}
                </div>
                <div className="sm:text-right">
                  <p className="flex items-center gap-2 sm:justify-end">
                    <b className="tabular-nums">{money(i.value_cents)}</b>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </p>
                  {i.paid && i.net_cents != null && (
                    <p className="text-xs text-zinc-500 tabular-nums">
                      {i.kind === 'mensalidade' || !i.platform ? `líquido ${money(i.net)}` : `você ${money(i.platform)} · barbearia ${money(i.toShop)}`}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
