import { Building2, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';

interface UnitRow {
  id: number;
  name: string;
  slug: string;
  today: { income: number; services: number };
  month: { income: number; services: number; average: number };
  projected: number;
  lastMonthTotal: number;
  occupancy: number | null;
  activeCustomers: number;
  appointmentsToday: number;
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

/** Troca a unidade do painel (o dono de uma rede) e recarrega tudo. */
export async function switchUnit(id: number) {
  await api('POST', '/api/auth/units/switch', { shop_id: id });
  location.assign('/painel');
}

/** Rede com filiais: os números de cada unidade lado a lado e abrir uma unidade nova. */
export function Units() {
  const [data, setData] = useState<{ current: number; units: UnitRow[] } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<typeof data>('GET', '/api/shop/network').then(setData, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: number }>('POST', '/api/shop/units', { name });
      setCreated(r.id);
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const total = data?.units.reduce((s, u) => ({ today: s.today + u.today.income, month: s.month + u.month.income, projected: s.projected + u.projected }), { today: 0, month: 0, projected: 0 });
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Unidades</h1>
        <p className="text-sm text-zinc-500">
          Cada unidade tem a própria agenda, barbeiros, robô, caixa e mensalidade. Você troca de unidade no topo do menu; os avisos e o resumo da semana chegam
          de todas.
        </p>
      </div>
      <ErrorText error={error} />
      {data && data.units.length > 1 && total && (
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ['Hoje, na rede', total.today],
              ['No mês, na rede', total.month],
              ['Previsão do mês', total.projected],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
              <p className="text-sm text-zinc-500">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{money(v)}</p>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.units.map((u) => (
          <Card key={u.id} className="min-w-0 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <p className="flex items-center gap-2 font-semibold">
                <Building2 className="size-5 text-zinc-400" /> {u.name}
              </p>
              {u.id === data.current ? <Badge tone="green">Aberta agora</Badge> : null}
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-zinc-500">Hoje</dt>
              <dd className="text-right tabular-nums">
                <b>{money(u.today.income)}</b> · {u.appointmentsToday} horários
              </dd>
              <dt className="text-zinc-500">No mês</dt>
              <dd className="text-right tabular-nums">
                <b>{money(u.month.income)}</b> · {u.month.services} atend.
              </dd>
              <dt className="text-zinc-500">Previsão do mês</dt>
              <dd className="text-right tabular-nums">{money(u.projected)}</dd>
              <dt className="text-zinc-500">Agenda ocupada</dt>
              <dd className="text-right tabular-nums">{pct(u.occupancy)}</dd>
              <dt className="text-zinc-500">Clientes (90 dias)</dt>
              <dd className="text-right tabular-nums">{u.activeCustomers}</dd>
            </dl>
            {u.id !== data.current && (
              <Button variant="ghost" className="w-full" onClick={() => switchUnit(u.id)}>
                Abrir o painel desta unidade
              </Button>
            )}
          </Card>
        ))}
      </div>

      <Card className="space-y-3">
        <p className="flex items-center gap-2 font-semibold">
          <Plus className="size-5 text-zinc-400" /> Abrir nova unidade
        </p>
        <p className="text-sm text-zinc-500">Começa nos dias grátis, com as cores e o nome do robô desta unidade. Depois é só cadastrar os barbeiros e os serviços.</p>
        {created ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-950 ring-1 ring-emerald-200">
            ✅ Unidade criada!
            <Button className="!py-1.5" onClick={() => switchUnit(created)}>
              Ir para a nova unidade
            </Button>
          </div>
        ) : (
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <Field label="Nome da unidade">
              <Input className="!w-72" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Navalha de Ouro – Centro" />
            </Field>
            <Button loading={busy} disabled={name.trim().length < 2}>
              Criar unidade
            </Button>
          </form>
        )}
      </Card>
    </section>
  );
}
