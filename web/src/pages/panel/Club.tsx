import { CreditCard, Crown, Pencil, Plus, Search, Send } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { OnlineSettingsCard } from '../../components/OnlinePay';
import { PixSettingsCard } from '../../components/Pix';
import { ReceiptPreview } from '../../components/Receipt';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { METHODS, centsToInput, parseMoney, type Method } from '../../lib/finance';
import { date, money, phone as fmtPhone } from '../../lib/format';

interface Plan {
  id: number;
  name: string;
  description: string | null;
  price_cents: number;
  uses_per_month: number | null;
  active: boolean;
  items: { id: number; name: string; kind: 'service' | 'product'; price_cents: number }[];
  members: number;
}

interface OpenCharge {
  id: number;
  description: string;
  amount_cents: number;
  due_date: string | null;
  claimed_at: string | null;
  /** Comprovante do PIX que o cliente mandou pela área dele. */
  receipt_type: string | null;
  receipt_at: string | null;
}

interface Member {
  id: number;
  customer_id: number;
  customer_name: string;
  phone: string;
  plan: { id: number; name: string; price_cents: number; uses_per_month: number | null };
  status: 'pending' | 'active' | 'cancelled';
  state: 'pending' | 'ok' | 'late' | 'ending' | 'ended';
  paid_until: string | null;
  period: { start: string; end: string } | null;
  used: number;
  open_charge: OpenCharge | null;
  /** Cartão automático (Cielo): ligado, e o último problema (recusa ou falha ao cancelar). */
  card: { active: boolean; error: string | null };
}

interface Overview {
  settings: { pix_key: string | null; club_commission_pct: number };
  plans: Plan[];
  members: Member[];
  monthly_cents: number;
  active: number;
}

const STATE: Record<Member['state'], { label: string; tone: 'green' | 'gold' | 'red' | 'zinc' }> = {
  ok: { label: 'Em dia', tone: 'green' },
  pending: { label: 'Esperando o 1º pagamento', tone: 'gold' },
  late: { label: 'Mensalidade atrasada', tone: 'red' },
  ending: { label: 'Cancelou', tone: 'zinc' },
  ended: { label: 'Encerrado', tone: 'zinc' },
};

const COMMISSION = [
  { value: 100, label: 'Comissão normal (sobre o preço do serviço)' },
  { value: 50, label: 'Metade da comissão' },
  { value: 0, label: 'Sem comissão nos usos do clube' },
];

/** Clube de assinatura: planos, assinantes e mensalidades (PIX direto na conta da barbearia ou cartão pelo Asaas). */
export function Club() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | 'new' | null>(null);
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Member | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<Overview>('GET', '/api/shop/club').then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <ErrorText error={error} />;

  async function act<T>(fn: () => Promise<T>, done?: string | ((r: T) => string)) {
    setError(null);
    setMsg(null);
    try {
      const r = await fn();
      if (done) setMsg(typeof done === 'function' ? done(r) : done);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const activePlans = data.plans.filter((p) => p.active);
  return (
    <section className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Crown className="size-6" /> Clube de assinatura
        </h1>
        <p className="text-sm text-zinc-500">
          O cliente paga um valor fixo por mês e usa os serviços do plano sem pagar na hora. A mensalidade sai sozinha pelo WhatsApp, com o PIX, 3 dias antes de
          vencer; atrasou, os benefícios pausam até o pagamento.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card className="!p-4">
          <p className="text-sm text-zinc-500">Assinantes</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.active}</p>
        </Card>
        <Card className="!p-4">
          <p className="text-sm text-zinc-500">Receita mensal prevista</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{money(data.monthly_cents)}</p>
        </Card>
        <Card className="col-span-2 !p-4 md:col-span-1">
          <p className="text-sm text-zinc-500">Mensalidades atrasadas</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.members.filter((m) => m.state === 'late').length}</p>
        </Card>
      </div>

      <ErrorText error={error} />
      {msg && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="font-semibold">Assinantes</p>
              {activePlans.length > 0 && (
                <Button className="!py-1.5" onClick={() => setAdding(true)}>
                  <Plus className="size-4" /> Adicionar
                </Button>
              )}
            </div>
            {data.members.length === 0 ? (
              <p className="text-sm text-zinc-500">
                {activePlans.length ? 'Os clientes assinam pela área do cliente (ou você adiciona aqui no balcão).' : 'Crie o primeiro plano para abrir o clube.'}
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {data.members.map((m) => {
                  const st = STATE[m.state];
                  return (
                    <li key={m.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {m.customer_name} <span className="text-sm font-normal text-zinc-500">· {m.plan.name}</span>
                          </p>
                          <p className="text-xs text-zinc-500">
                            {fmtPhone(m.phone)}
                            {m.period && ` · vale até ${date(m.period.end)}`}
                            {m.period && (m.plan.uses_per_month ? ` · usou ${m.used} de ${m.plan.uses_per_month}` : ` · usou ${m.used} no mês`)}
                          </p>
                          {m.card.active && m.status !== 'cancelled' && (
                            <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-emerald-700">
                              <CreditCard className="size-3.5" /> Cartão automático (Cielo)
                            </p>
                          )}
                        </div>
                        <Badge tone={st.tone}>{m.state === 'ending' && m.paid_until ? `Cancelou · vale até ${date(m.paid_until)}` : st.label}</Badge>
                      </div>
                      {m.card.error && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{m.card.error}</p>}
                      {m.open_charge && (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm">
                          <span>
                            {m.open_charge.claimed_at ? (m.open_charge.receipt_at ? 'Comprovante enviado pelo cliente' : 'PIX avisado pelo cliente') : 'Em aberto'}:{' '}
                            <b className="tabular-nums">{money(m.open_charge.amount_cents)}</b>
                            {m.open_charge.due_date && <span className="text-zinc-500"> · vence {date(m.open_charge.due_date)}</span>}
                          </span>
                          <span className="flex gap-2">
                            {!m.open_charge.claimed_at && data.settings.pix_key && (
                              <button
                                className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900"
                                onClick={() => act(() => api('POST', `/api/shop/club/members/${m.id}/send-pix`), `PIX enviado para ${m.customer_name} no WhatsApp.`)}
                              >
                                <Send className="size-3.5" /> Mandar PIX
                              </button>
                            )}
                            <Button className="!px-3 !py-1 text-xs" onClick={() => setPaying(m)}>
                              Recebi
                            </Button>
                          </span>
                          {m.open_charge.receipt_type && m.open_charge.receipt_at && (
                            <div className="w-full">
                              <ReceiptPreview
                                url={`/api/shop/charges/${m.open_charge.id}/receipt`}
                                receipt={{ type: m.open_charge.receipt_type, at: m.open_charge.receipt_at }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                      {m.status !== 'cancelled' && (
                        <button
                          className="mt-1 text-xs text-zinc-400 hover:text-red-600"
                          onClick={() =>
                            confirm(`Cancelar a assinatura de ${m.customer_name}? O que já foi pago continua valendo até o fim do mês.`) &&
                            act(
                              () => api<{ warning: string | null }>('POST', `/api/shop/club/members/${m.id}/cancel`),
                              (r) => {
                                // A Cielo não parou a cobrança no cartão: o dono precisa cancelar lá.
                                if (r.warning) setError(r.warning);
                                return 'Assinatura cancelada.';
                              },
                            )
                          }
                        >
                          Cancelar assinatura
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="font-semibold">Planos</p>
              <Button variant="ghost" className="!py-1.5" onClick={() => setPlan('new')}>
                <Plus className="size-4" /> Novo plano
              </Button>
            </div>
            {data.plans.length === 0 ? (
              <EmptyState
                icon={<Crown className="size-6" />}
                title="Nenhum plano ainda"
                text="Ex.: Plano Corte, R$ 89,90 por mês com até 4 cortes. Ou Corte + Barba à vontade."
              />
            ) : (
              <ul className="space-y-2">
                {data.plans.map((p) => (
                  <li key={p.id} className="rounded-xl px-3 py-2.5 ring-1 ring-zinc-200">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">
                          {p.name} {!p.active && <Badge>Fora do ar</Badge>}
                        </p>
                        <p className="text-sm">
                          <b className="tabular-nums">{money(p.price_cents)}</b>/mês · {p.uses_per_month ? `até ${p.uses_per_month} usos` : 'à vontade'}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {p.items.map((i) => i.name).join(', ')} · {p.members} {p.members === 1 ? 'assinante' : 'assinantes'}
                        </p>
                      </div>
                      <button className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800" onClick={() => setPlan(p)} aria-label={`Editar ${p.name}`}>
                        <Pencil className="size-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <PixSettingsCard onSaved={() => load()} />
          <OnlineSettingsCard />

          <Card>
            <Field label="Comissão do barbeiro nos usos do clube" hint="O serviço do clube sai por R$ 0 na comanda; a comissão é calculada sobre o preço normal.">
              <select
                className={inputClass}
                value={data.settings.club_commission_pct}
                onChange={(e) => act(() => api('PUT', '/api/shop/club/settings', { club_commission_pct: Number(e.target.value) }), 'Comissão do clube salva.')}
              >
                {COMMISSION.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </Card>
        </div>
      </div>

      {plan && (
        <PlanModal
          plan={plan === 'new' ? null : plan}
          onClose={() => setPlan(null)}
          onSaved={() => {
            setPlan(null);
            load();
          }}
        />
      )}
      {adding && (
        <AddMemberModal
          plans={activePlans}
          hasPix={Boolean(data.settings.pix_key)}
          onClose={() => setAdding(false)}
          onDone={(text) => {
            setAdding(false);
            setMsg(text);
            load();
          }}
        />
      )}
      {paying?.open_charge && (
        <PaidModal
          member={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            setMsg('Pagamento confirmado: entrou no caixa.');
            load();
          }}
        />
      )}
    </section>
  );
}

function PlanModal({ plan, onClose, onSaved }: { plan: Plan | null; onClose: () => void; onSaved: () => void }) {
  const [catalog, setCatalog] = useState<{ id: number; kind: 'service' | 'product'; name: string; price_cents: number; active: number }[]>([]);
  const [name, setName] = useState(plan?.name ?? '');
  const [price, setPrice] = useState(plan ? centsToInput(plan.price_cents) : '');
  const [uses, setUses] = useState(plan?.uses_per_month ? String(plan.uses_per_month) : '');
  const [items, setItems] = useState<number[]>(plan?.items.map((i) => i.id) ?? []);
  const [description, setDescription] = useState(plan?.description ?? '');
  const [active, setActive] = useState(plan?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<typeof catalog>('GET', '/api/shop/catalog').then(setCatalog);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, price_cents: parseMoney(price), uses_per_month: uses ? Number(uses) : null, item_ids: items, description: description || null, active };
      await api(plan ? 'PUT' : 'POST', plan ? `/api/shop/club/plans/${plan.id}` : '/api/shop/club/plans', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!plan || !confirm(`Excluir o plano ${plan.name}?`)) return;
    try {
      await api('DELETE', `/api/shop/club/plans/${plan.id}`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const toggle = (id: number) => setItems((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const listed = catalog.filter((c) => c.active || items.includes(c.id));
  return (
    <Modal title={plan ? `Editar ${plan.name}` : 'Novo plano'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome do plano">
          <Input value={name} required placeholder="Plano Corte" onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Preço por mês (R$)">
            <Input inputMode="decimal" required placeholder="89,90" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Usos por mês" hint="Vazio = à vontade.">
            <Input type="number" min={1} max={100} placeholder="4" value={uses} onChange={(e) => setUses(e.target.value)} />
          </Field>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-700">O que o plano inclui</p>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg p-2 ring-1 ring-zinc-200">
            {listed.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-zinc-50">
                <input type="checkbox" className="size-4" checked={items.includes(c.id)} onChange={() => toggle(c.id)} />
                <span className="flex-1">{c.name}</span>
                <span className="text-xs text-zinc-500 tabular-nums">{money(c.price_cents)}</span>
              </label>
            ))}
            {listed.length === 0 && <p className="p-2 text-sm text-zinc-500">Cadastre os serviços primeiro.</p>}
          </div>
          <p className="mt-1 text-xs text-zinc-500">Cada item usado conta 1 no limite do mês (ex.: corte + barba no mesmo dia = 2 usos).</p>
        </div>
        <Field label="Descrição (aparece no site)">
          <Input value={description} placeholder="Corte sempre em dia, sem se preocupar com a conta." onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aceitando novos assinantes
        </label>
        {plan && <p className="text-xs text-zinc-500">Mudou o preço? O novo valor vale a partir da próxima mensalidade de cada assinante.</p>}
        <ErrorText error={error} />
        <div className="flex items-center justify-between gap-3">
          {plan ? (
            <button type="button" className="text-sm text-zinc-500 hover:text-red-600" onClick={remove}>
              Excluir plano
            </button>
          ) : (
            <span />
          )}
          <Button type="submit" loading={busy}>
            Salvar plano
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AddMemberModal({ plans, hasPix, onClose, onDone }: { plans: Plan[]; hasPix: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: number; name: string; phone: string }[]>([]);
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(null);
  const [planId, setPlanId] = useState(plans[0]?.id ?? 0);
  const [payment, setPayment] = useState<'now' | 'whatsapp' | 'later'>('now');
  const [method, setMethod] = useState<Method>('pix');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (customer || !q.trim()) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => api<typeof found>('GET', `/api/shop/customers?q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 5))), 250);
    return () => clearTimeout(t);
  }, [q, customer]);

  async function submit() {
    if (!customer) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sent: boolean }>('POST', '/api/shop/club/members', {
        customer_id: customer.id,
        plan_id: planId,
        paid_method: payment === 'now' ? method : null,
        send_pix: payment === 'whatsapp',
      });
      onDone(
        payment === 'now'
          ? `${customer.name} entrou no clube. A mensalidade entrou no caixa.`
          : payment === 'whatsapp' && r.sent
            ? `${customer.name} entrou no clube. O PIX foi pelo WhatsApp.`
            : `${customer.name} entrou no clube, esperando o primeiro pagamento.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const plan = plans.find((p) => p.id === planId);
  return (
    <Modal title="Adicionar assinante" onClose={onClose}>
      <div className="space-y-4">
        {customer ? (
          <div className="flex items-center justify-between rounded-xl bg-zinc-50 px-3 py-2 text-sm">
            <b>{customer.name}</b>
            <button className="text-zinc-500 hover:text-zinc-900" onClick={() => setCustomer(null)}>
              Trocar
            </button>
          </div>
        ) : (
          <Field label="Cliente">
            <div className="relative">
              <Search className="absolute top-2.5 left-3 size-4 text-zinc-400" />
              <Input className="pl-9" placeholder="Nome ou celular" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            </div>
            {found.map((c) => (
              <button key={c.id} type="button" onClick={() => setCustomer(c)} className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-zinc-100">
                {c.name} <span className="text-zinc-500">{fmtPhone(c.phone)}</span>
              </button>
            ))}
          </Field>
        )}
        <Field label="Plano">
          <select className={inputClass} value={planId} onChange={(e) => setPlanId(Number(e.target.value))}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {money(p.price_cents)}/mês
              </option>
            ))}
          </select>
        </Field>
        <div className="space-y-2 text-sm">
          <p className="font-medium text-zinc-700">Primeira mensalidade{plan ? ` (${money(plan.price_cents)})` : ''}</p>
          <label className="flex items-center gap-2">
            <input type="radio" checked={payment === 'now'} onChange={() => setPayment('now')} /> Pagou agora, no balcão
          </label>
          {payment === 'now' && (
            <div className="flex flex-wrap gap-2 pl-6">
              {METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMethod(m.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${method === m.id ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {hasPix && (
            <label className="flex items-center gap-2">
              <input type="radio" checked={payment === 'whatsapp'} onChange={() => setPayment('whatsapp')} /> Mandar o PIX pelo WhatsApp
            </label>
          )}
          <label className="flex items-center gap-2">
            <input type="radio" checked={payment === 'later'} onChange={() => setPayment('later')} /> Vai pagar depois
          </label>
        </div>
        <ErrorText error={error} />
        <Button className="w-full" loading={busy} disabled={!customer || !planId} onClick={submit}>
          Adicionar ao clube
        </Button>
      </div>
    </Modal>
  );
}

function PaidModal({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<Method>('pix');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const charge = member.open_charge!;
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/shop/charges/${charge.id}/confirm`, { method });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Registrar pagamento" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm">
          <b>{member.customer_name}</b> · {charge.description}
        </p>
        <p className="text-3xl font-bold tabular-nums">{money(charge.amount_cents)}</p>
        <div className="flex flex-wrap gap-2">
          {METHODS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMethod(m.id)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${method === m.id ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <ErrorText error={error} />
        <Button className="w-full" loading={busy} onClick={submit}>
          Confirmar {money(charge.amount_cents)}
        </Button>
      </div>
    </Modal>
  );
}
