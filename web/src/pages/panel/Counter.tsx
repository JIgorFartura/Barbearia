import { Gift, Minus, Plus, Search, Undo2, UserPlus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { phone } from '../../lib/format';
import { StampCard, type Progress } from '../../components/StampCard';

interface Customer {
  id: number;
  name: string;
  phone: string;
  stamps_total?: number;
  last_visit?: string | null;
}

interface CardEntry {
  campaign: { id: number; name: string; unit_label: string; goal: number; reward: string };
  running: boolean;
  progress: Progress;
}

interface Detail {
  customer: Customer;
  card: CardEntry[];
  history: { id: number; kind: 'earn' | 'redeem'; qty: number; created_at: string; campaign: string; unit_label: string; reward: string }[];
}

/** Balcão: acha o cliente pelo nome/celular, lança carimbos e entrega prêmios. */
export function Counter() {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Customer[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const search = useCallback((term: string) => {
    api<Customer[]>('GET', `/api/shop/customers?q=${encodeURIComponent(term)}`).then(setList);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => search(q), 250);
    return () => clearTimeout(t);
  }, [q, search]);

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Balcão</h1>
          <p className="text-sm text-zinc-500">Ache o cliente pelo nome ou celular e lance o consumo das campanhas.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <UserPlus className="size-4" /> Novo cliente
        </Button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div>
          <div className="relative mb-3">
            <Search className="absolute top-2.5 left-3 size-4 text-zinc-400" />
            <Input className="pl-9" placeholder="Nome ou celular" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {list?.length === 0 && (
            <EmptyState
              icon={<Users className="size-6" />}
              title={q ? 'Ninguém encontrado' : 'Nenhum cliente ainda'}
              text="Cadastre pelo nome e celular: é com o celular que o cliente consulta o cartão no site."
            />
          )}
          <ul className="space-y-2">
            {list?.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c.id)}
                  className={`flex w-full items-center justify-between rounded-xl bg-white px-4 py-3 text-left ring-1 transition ${selected === c.id ? 'ring-2 ring-zinc-900' : 'ring-zinc-200 hover:ring-zinc-300'}`}
                >
                  <span>
                    <span className="block font-medium">{c.name}</span>
                    <span className="text-sm text-zinc-500">{phone(c.phone)}</span>
                  </span>
                  {!!c.stamps_total && <Badge tone="gold">{c.stamps_total} carimbos</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>{selected ? <CustomerDetail id={selected} onChange={() => search(q)} /> : <p className="text-sm text-zinc-500">Escolha um cliente na lista.</p>}</div>
      </div>

      {creating && (
        <NewCustomerModal
          onClose={() => setCreating(false)}
          onDone={(c) => {
            setCreating(false);
            setQ('');
            search('');
            setSelected(c.id);
          }}
        />
      )}
    </section>
  );
}

function CustomerDetail({ id, onChange }: { id: number; onChange: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Detail>('GET', `/api/shop/customers/${id}`).then(setData);
  }, [id]);
  useEffect(() => {
    setData(null);
    setFlash(null);
    setError(null);
    load();
  }, [load]);

  async function act(path: 'earn' | 'redeem', entry: CardEntry) {
    setError(null);
    setFlash(null);
    try {
      const n = qty[entry.campaign.id] ?? 1;
      const p = await api<Progress>('POST', `/api/shop/loyalty/${path}`, {
        campaignId: entry.campaign.id,
        customerId: id,
        ...(path === 'earn' ? { qty: n } : {}),
      });
      if (path === 'redeem') setFlash(`Prêmio entregue: ${entry.campaign.reward}.`);
      else if (p.available > entry.progress.available) setFlash(`${data?.customer.name.split(' ')[0]} ganhou: ${entry.campaign.reward}! 🎉`);
      else setFlash(`+${n} ${entry.campaign.unit_label}. Faltam ${p.goal - p.stamps} para o prêmio.`);
      setQty({ ...qty, [entry.campaign.id]: 1 });
      load();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function undo(eventId: number) {
    if (!confirm('Desfazer este lançamento?')) return;
    await api('DELETE', `/api/shop/loyalty/events/${eventId}`).catch((e) => alert(e.message));
    load();
    onChange();
  }

  if (!data) return null;
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-lg font-semibold">{data.customer.name}</p>
        <p className="text-sm text-zinc-500">{phone(data.customer.phone)}</p>
      </Card>
      {flash && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">{flash}</p>}
      <ErrorText error={error} />
      {data.card.length === 0 && <p className="text-sm text-zinc-500">Nenhuma campanha valendo. Crie uma em Campanhas.</p>}
      {data.card.map((entry) => {
        const n = qty[entry.campaign.id] ?? 1;
        return (
          <Card key={entry.campaign.id}>
            <StampCard name={entry.campaign.name} unit={entry.campaign.unit_label} reward={entry.campaign.reward} progress={entry.progress} />
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {entry.running && (
                <>
                  <div className="flex items-center rounded-lg ring-1 ring-zinc-200">
                    <button className="p-2" onClick={() => setQty({ ...qty, [entry.campaign.id]: Math.max(1, n - 1) })} aria-label="Menos">
                      <Minus className="size-4" />
                    </button>
                    <span className="w-8 text-center font-semibold tabular-nums">{n}</span>
                    <button className="p-2" onClick={() => setQty({ ...qty, [entry.campaign.id]: Math.min(50, n + 1) })} aria-label="Mais">
                      <Plus className="size-4" />
                    </button>
                  </div>
                  <Button onClick={() => act('earn', entry)}>
                    Lançar +{n}
                  </Button>
                </>
              )}
              {entry.progress.available > 0 && (
                <Button variant="gold" onClick={() => act('redeem', entry)}>
                  <Gift className="size-4" /> Entregar prêmio
                </Button>
              )}
            </div>
          </Card>
        );
      })}
      {data.history.length > 0 && (
        <Card>
          <p className="mb-2 font-semibold">Extrato</p>
          <ul className="divide-y divide-zinc-100 text-sm">
            {data.history.map((h) => (
              <li key={h.id} className="flex items-center justify-between py-2">
                <span>
                  {h.kind === 'earn' ? `+${h.qty} ${h.unit_label}` : `Retirou: ${h.reward}`}
                  <span className="text-zinc-500"> · {h.campaign}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-zinc-500">
                  {new Date(h.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  <button onClick={() => undo(h.id)} className="rounded p-1 hover:bg-zinc-100" title="Desfazer">
                    <Undo2 className="size-3.5" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function NewCustomerModal({ onClose, onDone }: { onClose: () => void; onDone: (c: Customer) => void }) {
  const [form, setForm] = useState({ name: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<Customer>('POST', '/api/shop/customers', form));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Novo cliente" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome">
          <Input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Celular (com DDD)">
          <Input required type="tel" inputMode="tel" placeholder="(11) 98888-7777" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Cadastrar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
