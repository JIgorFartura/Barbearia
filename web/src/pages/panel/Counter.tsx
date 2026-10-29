import { CalendarCheck, Download, Gift, Link2, Minus, Plus, Receipt, Repeat, Search, Ticket, Trash2, Undo2, UserPlus, Users } from 'lucide-react';
import { CheckoutModal } from '../../components/Checkout';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { WEEKDAYS, hourLabel, phone, stampLabel, whatsappLink } from '../../lib/format';
import { StampCard, type Progress } from '../../components/StampCard';
import { useDesk } from '../../lib/role';

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

      <VoucherCheck />

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
                  {!!c.stamps_total && <Badge tone="gold">{c.stamps_total} {c.stamps_total === 1 ? 'carimbo' : 'carimbos'}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          {selected ? (
            <CustomerDetail
              id={selected}
              onChange={() => search(q)}
              onRemoved={() => {
                setSelected(null);
                search(q);
              }}
            />
          ) : (
            <p className="text-sm text-zinc-500">Escolha um cliente na lista.</p>
          )}
        </div>
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

function CustomerDetail({ id, onChange, onRemoved }: { id: number; onChange: () => void; onRemoved: () => void }) {
  const desk = useDesk();
  const [data, setData] = useState<Detail | null>(null);
  const [removing, setRemoving] = useState(false);
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
      else setFlash(`+${n} ${entry.campaign.unit_label}. ${p.goal - p.stamps === 1 ? 'Falta só 1' : `Faltam ${p.goal - p.stamps}`} para o prêmio.`);
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
        <CustomerAgenda
          customerId={id}
          name={data.customer.name}
          customerPhone={data.customer.phone}
          onSale={() => {
            // A venda pode ter dado carimbos: atualiza o cartão e a lista.
            load();
            onChange();
          }}
        />
        {/* LGPD (cópia e exclusão dos dados): só o dono. */}
        {!desk && (
          <p className="mt-3 flex flex-wrap gap-4 border-t border-zinc-100 pt-3 text-xs">
            <a href={`/api/shop/customers/${id}/export`} download className="inline-flex items-center gap-1 font-medium text-zinc-500 hover:text-zinc-900">
              <Download className="size-3.5" /> Exportar dados (LGPD)
            </a>
            <button className="inline-flex items-center gap-1 font-medium text-zinc-500 hover:text-red-600" onClick={() => setRemoving(true)}>
              <Trash2 className="size-3.5" /> Excluir dados a pedido do cliente
            </button>
          </p>
        )}
      </Card>
      {removing && <RemoveCustomerModal id={id} name={data.customer.name} onClose={() => setRemoving(false)} onDone={onRemoved} />}
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

interface Habit {
  weekday: number;
  time: string;
  barberId: number | null;
  intervalDays: number;
  source: 'cliente' | 'automatico';
}

/** Costume, próximos horários e link de acesso à área do cliente. */
function CustomerAgenda({ customerId, name, customerPhone, onSale }: { customerId: number; name: string; customerPhone: string; onSale: () => void }) {
  const [info, setInfo] = useState<{ habit: Habit | null; upcoming: { id: number; starts_at: string; barber_name: string; service_name: string }[] } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [selling, setSelling] = useState(false);
  useEffect(() => {
    setLink(null);
    api<typeof info>('GET', `/api/shop/customers/${customerId}/agenda`).then(setInfo);
  }, [customerId]);
  if (!info) return null;
  return (
    <div className="mt-3 space-y-1.5 border-t border-zinc-100 pt-3 text-sm">
      <p className="flex items-center gap-2 text-zinc-600">
        <Repeat className="size-4 text-zinc-400" />
        {info.habit
          ? `Costuma vir ${WEEKDAYS[info.habit.weekday]} às ${hourLabel(info.habit.time)}, a cada ${info.habit.intervalDays} dias (${info.habit.source === 'cliente' ? 'informado' : 'pelo histórico'})`
          : 'Sem horário de costume ainda'}
      </p>
      <p className="flex items-center gap-2 text-zinc-600">
        <CalendarCheck className="size-4 text-zinc-400" />
        {info.upcoming.length ? info.upcoming.map((a) => `${stampLabel(a.starts_at)} com ${a.barber_name}`).join(' · ') : 'Nenhum horário marcado'}
      </p>
      <button className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setSelling(true)}>
        <Receipt className="size-3.5" /> Registrar venda para {name.split(' ')[0]}
      </button>
      {selling && (
        <CheckoutModal
          customer={{ id: customerId, name }}
          onClose={() => setSelling(false)}
          onDone={() => {
            setSelling(false);
            onSale();
          }}
        />
      )}
      {link ? (
        <div className="space-y-1">
          <input readOnly value={link} className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <a
            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
            href={whatsappLink(customerPhone, `Oi, ${name.split(' ')[0]}! Este é o seu acesso à área do cliente (agenda, cartão fidelidade e vouchers): ${link}`)}
            target="_blank"
            rel="noreferrer"
          >
            Enviar pelo meu WhatsApp
          </a>
        </div>
      ) : (
        <button
          className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900"
          onClick={() => api<{ url: string }>('POST', `/api/shop/customers/${customerId}/access-link`).then((r) => setLink(r.url))}
        >
          <Link2 className="size-3.5" /> Gerar link de acesso à área do cliente
        </button>
      )}
    </div>
  );
}

interface VoucherInfo {
  code: string;
  status: 'active' | 'used' | 'expired';
  title: string;
  customer_name: string;
  expires_on: string;
}

/** Validação do voucher que o cliente mostra no balcão. */
function VoucherCheck() {
  const [code, setCode] = useState('');
  const [voucher, setVoucher] = useState<VoucherInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    setVoucher(null);
    try {
      setVoucher(await api<VoucherInfo>('GET', `/api/shop/vouchers/${encodeURIComponent(code.trim().toUpperCase())}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function redeem() {
    if (!voucher) return;
    setError(null);
    try {
      setVoucher(await api<VoucherInfo>('POST', '/api/shop/vouchers/redeem', { code: voucher.code }));
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card className="mb-5 !p-4">
      <form onSubmit={lookup} className="flex flex-wrap items-center gap-2">
        <Ticket className="size-5 text-zinc-400" />
        <span className="font-semibold">Validar voucher</span>
        <Input className="!w-44 font-mono uppercase" placeholder="NAV-ABC123" value={code} onChange={(e) => setCode(e.target.value)} />
        <Button type="submit" variant="ghost" disabled={code.trim().length < 3}>
          Conferir
        </Button>
      </form>
      {voucher && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-50 px-3 py-2 text-sm">
          <span>
            <b>{voucher.title}</b> · {voucher.customer_name} · vale até {voucher.expires_on.split('-').reverse().join('/')}
          </span>
          {voucher.status === 'active' ? (
            <Button variant="gold" className="!py-1.5" onClick={redeem}>
              Dar baixa
            </Button>
          ) : (
            <Badge tone={voucher.status === 'used' ? (done ? 'green' : 'red') : 'red'}>
              {voucher.status === 'used' ? (done ? 'Baixa feita ✓' : 'Já usado') : 'Vencido'}
            </Badge>
          )}
        </div>
      )}
      {error && <div className="mt-2"><ErrorText error={error} /></div>}
    </Card>
  );
}

/** LGPD: exclusão dos dados pessoais a pedido do cliente (as vendas ficam sem identificação). */
function RemoveCustomerModal({ id, name, onClose, onDone }: { id: number; name: string; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Excluir dados de ${name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Apaga nome, celular, mensagens, cartão fidelidade, vouchers e horários futuros. As vendas continuam no caixa, sem identificar o cliente. Use quando o
          próprio cliente pedir. Não pode ser desfeito.
        </p>
        <Field label="Para confirmar, digite EXCLUIR">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} />
        </Field>
        <ErrorText error={error} />
        <Button
          variant="danger"
          className="w-full"
          disabled={confirm !== 'EXCLUIR'}
          onClick={() => api('POST', `/api/shop/customers/${id}/anonymize`, { confirm }).then(onDone, (e) => setError(e.message))}
        >
          Excluir dados
        </Button>
      </div>
    </Modal>
  );
}
