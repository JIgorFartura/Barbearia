import {
  Activity,
  Bot,
  CalendarDays,
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  KeyRound,
  LogIn,
  LogOut,
  Megaphone,
  MessageSquare,
  Plus,
  Scissors,
  Server,
  Store,
  Ticket,
  Unlock,
  Users,
  Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Me } from '../App';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { centsToInput, parseMoney } from '../lib/finance';
import { addDays, date, money, todayStr } from '../lib/format';
import { navigate } from '../lib/router';

interface ShopRow {
  id: number;
  slug: string;
  name: string;
  active: number;
  created_at: string;
  bot_name: string;
  wa_provider: 'simulador' | 'meta' | 'evolution';
  owners: string | null;
  customers: number;
  campaigns: number;
  barbers: number;
  appointments_week: number;
  messages_week: number;
  failed_week: number;
  tokens_in_30d: number;
  tokens_out_30d: number;
  plan_id: number | null;
  plan_name: string | null;
  monthly_price_cents: number | null;
  price_cents: number;
  billing_day: number;
  trial_until: string | null;
  released_until: string | null;
  blocked: boolean;
  open_invoices: number;
  overdue_invoices: number;
}

interface Overview {
  shops: number;
  customers: number;
  appointmentsToday: number;
  messagesWeek: number;
  vouchersWeek: number;
  llm: boolean;
  model: string | null;
  recentMessages: { id: number; shop: string; direction: 'in' | 'out'; kind: string; status: string; body: string; created_at: string }[];
}

interface Plan {
  id: number;
  name: string;
  price_cents: number;
  description: string | null;
  active: number;
  shops?: number;
}

const PROVIDER: Record<ShopRow['wa_provider'], string> = { simulador: 'Simulador', meta: 'WhatsApp oficial', evolution: 'Evolution API' };
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} mi` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n));

const slugify = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

function Stat({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
      <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">{icon}</div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-sm text-zinc-500">{label}</p>
      {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

const TABS = [
  { id: 'barbearias', label: 'Barbearias', icon: Store },
  { id: 'financeiro', label: 'Financeiro', icon: Wallet },
  { id: 'sistema', label: 'Sistema', icon: Server },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** Painel do dono da plataforma: barbearias, mensalidades e o sistema. */
export function Master({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('barbearias');
  return (
    <div className="min-h-screen">
      <header className="bg-zinc-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2 font-bold">
            <Scissors className="size-5 text-gold" /> Sistema Barbearia <Badge tone="gold">Master</Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-zinc-400 sm:inline">{me.user?.name}</span>
            <button className="flex items-center gap-1 text-zinc-300 hover:text-white" onClick={() => api('POST', '/api/auth/logout').then(onLogout)}>
              <LogOut className="size-4" /> Sair
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap ${tab === id ? 'border-gold text-white' : 'border-transparent text-zinc-400 hover:text-white'}`}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
        {tab === 'barbearias' && <ShopsTab onEnter={onLogout} />}
        {tab === 'financeiro' && <BillingTab />}
        {tab === 'sistema' && <SystemTab />}
      </main>
    </div>
  );
}

// ---------- Barbearias

function billingLine(s: ShopRow): { text: string; tone: 'green' | 'gold' | 'red' | 'zinc' } {
  const today = todayStr();
  if (!s.active) return { text: 'Suspensa', tone: 'red' };
  if (s.blocked) return { text: 'Bloqueada (mensalidade)', tone: 'red' };
  if (s.released_until && s.released_until >= today && s.overdue_invoices) return { text: `Liberada até ${date(s.released_until)}`, tone: 'gold' };
  if (s.trial_until && s.trial_until >= today) return { text: `Em teste até ${date(s.trial_until)}`, tone: 'gold' };
  if (s.overdue_invoices) return { text: `${s.overdue_invoices} fatura(s) vencida(s)`, tone: 'gold' };
  if (!s.price_cents) return { text: 'Sem mensalidade', tone: 'zinc' };
  return { text: 'Em dia', tone: 'green' };
}

function ShopsTab({ onEnter }: { onEnter: () => void }) {
  const [shops, setShops] = useState<ShopRow[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [creating, setCreating] = useState(false);
  const [billing, setBilling] = useState<ShopRow | null>(null);
  const [releasing, setReleasing] = useState<ShopRow | null>(null);
  const [owners, setOwners] = useState<ShopRow | null>(null);
  const load = useCallback(() => {
    api<ShopRow[]>('GET', '/api/master/shops').then(setShops);
    api<Overview>('GET', '/api/master/overview').then(setOverview);
    api<Plan[]>('GET', '/api/master/plans').then(setPlans);
  }, []);
  useEffect(load, [load]);

  async function toggle(shop: ShopRow) {
    if (shop.active && !confirm(`Suspender ${shop.name}? O site, o robô e o painel param até você reativar.`)) return;
    await api('PUT', `/api/master/shops/${shop.id}`, { name: shop.name, slug: shop.slug, active: !shop.active });
    load();
  }

  async function enter(shop: ShopRow) {
    await api('POST', `/api/master/shops/${shop.id}/enter`);
    navigate('/painel');
    onEnter();
  }

  return (
    <>
      {overview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat icon={<Store className="size-5" />} label="Barbearias ativas" value={overview.shops} />
            <Stat icon={<Users className="size-5" />} label="Clientes" value={overview.customers} />
            <Stat icon={<CalendarDays className="size-5" />} label="Horários hoje" value={overview.appointmentsToday} />
            <Stat icon={<MessageSquare className="size-5" />} label="Mensagens (7 dias)" value={overview.messagesWeek} />
            <Stat icon={<Ticket className="size-5" />} label="Vouchers (7 dias)" value={overview.vouchersWeek} />
          </div>
          <p className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm ${overview.llm ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}>
            <Bot className="size-4" />
            {overview.llm
              ? `Robôs com inteligência artificial ligada (${overview.model}).`
              : 'Robôs sem inteligência artificial: defina ANTHROPIC_API_KEY no servidor para conversa livre. Sem ela, respondem por menu.'}
          </p>
        </div>
      )}

      <div>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Barbearias</h1>
            <p className="text-sm text-zinc-500">Crie a barbearia, entregue o acesso ao dono e acompanhe a mensalidade de cada uma.</p>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Nova barbearia
          </Button>
        </div>

        {shops?.length === 0 && <EmptyState icon={<Store className="size-6" />} title="Nenhuma barbearia ainda" text="Cadastre a primeira e entregue o login para o dono." />}
        <div className="grid gap-3 md:grid-cols-2">
          {shops?.map((s) => {
            const b = billingLine(s);
            return (
              <Card key={s.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{s.name}</p>
                    <a href={`/b/${s.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
                      /b/{s.slug} <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <Badge tone={b.tone}>{b.text}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
                  <div className="rounded-lg bg-zinc-50 py-2">
                    <p className="font-bold tabular-nums">{s.customers}</p>
                    <p className="text-xs text-zinc-500">clientes</p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 py-2">
                    <p className="font-bold tabular-nums">{s.appointments_week}</p>
                    <p className="text-xs text-zinc-500">horários 7 dias</p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 py-2">
                    <p className="font-bold tabular-nums">{s.messages_week}</p>
                    <p className="text-xs text-zinc-500">mensagens 7 dias</p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                  {s.price_cents ? `${s.plan_name ? `Plano ${s.plan_name} · ` : ''}${money(s.price_cents)}/mês · vence dia ${s.billing_day}` : 'Sem mensalidade definida'}
                </p>
                <p className="text-xs text-zinc-500">
                  Robô {s.bot_name} · {PROVIDER[s.wa_provider]} · {s.barbers} barbeiro(s)
                  {s.failed_week > 0 && <span className="text-red-600"> · {s.failed_week} mensagem(ns) com falha</span>}
                </p>
                <p className="text-xs text-zinc-500">
                  IA (30 dias): {compact(s.tokens_in_30d)} tokens de entrada, {compact(s.tokens_out_30d)} de saída · desde {date(s.created_at)}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button className="!py-1.5" onClick={() => enter(s)}>
                    <LogIn className="size-4" /> Abrir painel
                  </Button>
                  <Button variant="ghost" className="!py-1.5" onClick={() => setBilling(s)}>
                    <CreditCard className="size-4" /> Mensalidade
                  </Button>
                  {(s.blocked || s.overdue_invoices > 0) && (
                    <Button variant="ghost" className="!py-1.5" onClick={() => setReleasing(s)}>
                      <Unlock className="size-4" /> Liberar acesso
                    </Button>
                  )}
                  <Button variant="ghost" className="!py-1.5" onClick={() => setOwners(s)}>
                    <KeyRound className="size-4" /> Logins
                  </Button>
                  <Button variant={s.active ? 'danger' : 'ghost'} className="!py-1.5" onClick={() => toggle(s)}>
                    {s.active ? 'Suspender' : 'Reativar'}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {creating && <NewShopModal plans={plans} onClose={() => setCreating(false)} onDone={load} />}
      {billing && (
        <ShopBillingModal
          shop={billing}
          plans={plans}
          onClose={() => setBilling(null)}
          onDone={() => {
            setBilling(null);
            load();
          }}
        />
      )}
      {releasing && (
        <ReleaseModal
          shop={releasing}
          onClose={() => setReleasing(null)}
          onDone={() => {
            setReleasing(null);
            load();
          }}
        />
      )}
      {owners && <OwnersModal shop={owners} onClose={() => setOwners(null)} />}
    </>
  );
}

function NewShopModal({ plans, onClose, onDone }: { plans: Plan[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', slug: '', ownerName: '', ownerEmail: '', ownerPassword: '', plan_id: '' as string, price: '', billing_day: '10', trial_days: '14' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/master/shops', {
        name: form.name,
        slug: form.slug,
        ownerName: form.ownerName,
        ownerEmail: form.ownerEmail,
        ownerPassword: form.ownerPassword,
        plan_id: form.plan_id ? Number(form.plan_id) : null,
        monthly_price_cents: form.price ? parseMoney(form.price) : null,
        billing_day: Number(form.billing_day) || 10,
        trial_days: Number(form.trial_days) || 0,
      });
      // Mensagem pronta para entregar o acesso ao dono.
      setCreated(
        `Olá, ${form.ownerName.split(' ')[0]}! A ${form.name} já está no Sistema Barbearia.\n\nPainel: ${location.origin}\nE-mail: ${form.ownerEmail}\nSenha inicial: ${form.ownerPassword}\n\nSite da barbearia: ${location.origin}/b/${form.slug}`,
      );
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal title="Barbearia criada e liberada ✓" onClose={onClose}>
        <div className="space-y-3">
          <p className="text-sm text-zinc-600">Envie o acesso para o dono:</p>
          <textarea readOnly className="h-44 w-full rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm" value={created} />
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(created);
                setCopied(true);
              }}
            >
              <Copy className="size-4" /> {copied ? 'Copiado!' : 'Copiar mensagem'}
            </Button>
            <a
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
              href={`https://wa.me/?text=${encodeURIComponent(created)}`}
              target="_blank"
              rel="noreferrer"
            >
              Enviar pelo WhatsApp
            </a>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Nova barbearia" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome da barbearia">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugTouched ? form.slug : slugify(e.target.value) })} />
        </Field>
        <Field label="Endereço do site" hint={`O site fica em ${location.origin}/b/${form.slug || '...'}`}>
          <Input
            required
            value={form.slug}
            onChange={(e) => {
              setSlugTouched(true);
              setForm({ ...form, slug: slugify(e.target.value) });
            }}
          />
        </Field>
        <hr className="border-zinc-100" />
        <p className="text-sm font-semibold">Login do dono</p>
        <Field label="Nome">
          <Input required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
        </Field>
        <Field label="E-mail">
          <Input type="email" required value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
        </Field>
        <Field label="Senha inicial" hint="Pelo menos 8 caracteres. O dono pode trocar depois.">
          <Input required minLength={8} value={form.ownerPassword} onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })} />
        </Field>
        <hr className="border-zinc-100" />
        <p className="text-sm font-semibold">Mensalidade</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plano">
            <select className={inputClass} value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })}>
              <option value="">— sem plano —</option>
              {plans
                .filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {money(p.price_cents)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Valor combinado (R$)" hint="Vazio = preço do plano.">
            <Input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="Dia do vencimento">
            <Input type="number" min={1} max={31} value={form.billing_day} onChange={(e) => setForm({ ...form, billing_day: e.target.value })} />
          </Field>
          <Field label="Dias grátis (teste)">
            <Input type="number" min={0} max={365} value={form.trial_days} onChange={(e) => setForm({ ...form, trial_days: e.target.value })} />
          </Field>
        </div>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Criar e liberar acesso
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ShopBillingModal({ shop, plans, onClose, onDone }: { shop: ShopRow; plans: Plan[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    plan_id: shop.plan_id ? String(shop.plan_id) : '',
    price: shop.monthly_price_cents != null ? centsToInput(shop.monthly_price_cents) : '',
    billing_day: String(shop.billing_day),
    trial_until: shop.trial_until ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('PUT', `/api/master/shops/${shop.id}/billing`, {
        plan_id: form.plan_id ? Number(form.plan_id) : null,
        monthly_price_cents: form.price ? parseMoney(form.price) : null,
        billing_day: Number(form.billing_day) || 10,
        trial_until: form.trial_until || null,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal title={`Mensalidade · ${shop.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Plano">
          <select className={inputClass} value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })}>
            <option value="">— sem plano —</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {money(p.price_cents)}
                {!p.active ? ' (inativo)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor combinado (R$)" hint="Vazio = preço do plano.">
            <Input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="Dia do vencimento">
            <Input type="number" min={1} max={31} value={form.billing_day} onChange={(e) => setForm({ ...form, billing_day: e.target.value })} />
          </Field>
        </div>
        <Field label="Grátis até (teste)">
          <Input type="date" value={form.trial_until} onChange={(e) => setForm({ ...form, trial_until: e.target.value })} />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit">Salvar</Button>
        </div>
      </form>
    </Modal>
  );
}

function ReleaseModal({ shop, onClose, onDone }: { shop: ShopRow; onClose: () => void; onDone: () => void }) {
  const [until, setUntil] = useState(addDays(todayStr(), 5));
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Liberar acesso · ${shop.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600">Mesmo com mensalidade em atraso, o painel e o robô funcionam normalmente até a data abaixo.</p>
        <Field label="Liberado até">
          <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          {shop.released_until && (
            <Button variant="danger" onClick={() => api('POST', `/api/master/shops/${shop.id}/release`, { until: null }).then(onDone, (e) => setError(e.message))}>
              Tirar liberação
            </Button>
          )}
          <Button onClick={() => api('POST', `/api/master/shops/${shop.id}/release`, { until }).then(onDone, (e) => setError(e.message))}>Liberar</Button>
        </div>
      </div>
    </Modal>
  );
}

function OwnersModal({ shop, onClose }: { shop: ShopRow; onClose: () => void }) {
  const [owners, setOwners] = useState<{ id: number; name: string; email: string }[]>([]);
  const [resetting, setResetting] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [form, setForm] = useState({ ownerName: '', ownerEmail: '', ownerPassword: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<typeof owners>('GET', `/api/master/shops/${shop.id}/owners`).then(setOwners);
  }, [shop.id]);
  useEffect(load, [load]);

  return (
    <Modal title={`Logins · ${shop.name}`} onClose={onClose}>
      <div className="space-y-4">
        <ul className="divide-y divide-zinc-100 text-sm">
          {owners.map((o) => (
            <li key={o.id} className="py-2">
              <div className="flex items-center justify-between gap-2">
                <span>
                  <b>{o.name}</b> <span className="text-zinc-500">{o.email}</span>
                </span>
                <button className="text-xs font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setResetting(resetting === o.id ? null : o.id)}>
                  Nova senha
                </button>
              </div>
              {resetting === o.id && (
                <div className="mt-2 flex gap-2">
                  <Input placeholder="Nova senha (mín. 8)" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <Button
                    onClick={() =>
                      api('PUT', `/api/master/owners/${o.id}/password`, { password }).then(
                        () => {
                          setMsg(`Senha de ${o.email} trocada. Envie a nova senha ao dono.`);
                          setResetting(null);
                          setPassword('');
                        },
                        (e) => setError(e.message),
                      )
                    }
                  >
                    Salvar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3">
          <p className="text-sm font-semibold">Novo login (sócio, gerente)</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input placeholder="Nome" value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
            <Input type="email" placeholder="E-mail" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
            <Input placeholder="Senha" value={form.ownerPassword} onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })} />
          </div>
          <Button
            variant="ghost"
            onClick={() =>
              api('POST', `/api/master/shops/${shop.id}/owners`, form).then(
                () => {
                  setMsg(`Login ${form.ownerEmail} criado.`);
                  setForm({ ownerName: '', ownerEmail: '', ownerPassword: '' });
                  load();
                },
                (e) => setError(e.message),
              )
            }
          >
            Criar login
          </Button>
        </div>
        {msg && <p className="text-sm text-emerald-700">{msg}</p>}
        <ErrorText error={error} />
      </div>
    </Modal>
  );
}

// ---------- Financeiro da plataforma

interface Invoice {
  id: number;
  barbershop_id: number;
  shop_name: string;
  description: string;
  amount_cents: number;
  due_date: string;
  status: 'open' | 'paid' | 'cancelled';
  paid_at: string | null;
  method: string | null;
  informed_at: string | null;
  overdue: boolean;
}

interface Revenue {
  mrr: number;
  payingShops: number;
  trialShops: number;
  receivedThisMonth: number;
  open: number;
  overdue: number;
  informed: number;
  byMonth: { month: string; total: number }[];
}

interface Settings {
  grace_days: number;
  trial_days: number;
  pix_key: string;
  pix_name: string;
  pix_city: string;
}

function BillingTab() {
  const [data, setData] = useState<{ revenue: Revenue; invoices: Invoice[] } | null>(null);
  const [status, setStatus] = useState<'' | 'open' | 'paid' | 'cancelled'>('open');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [shops, setShops] = useState<{ id: number; name: string }[]>([]);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [newInvoice, setNewInvoice] = useState(false);
  const [plan, setPlan] = useState<Partial<Plan> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api<typeof data>('GET', `/api/master/billing${status ? `?status=${status}` : ''}`).then(setData);
    api<Plan[]>('GET', '/api/master/plans').then(setPlans);
    api<{ id: number; name: string }[]>('GET', '/api/master/shops').then(setShops);
  }, [status]);
  useEffect(load, [load]);

  if (!data) return null;
  const r = data.revenue;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Wallet className="size-5" />} label="Receita mensal recorrente" value={money(r.mrr)} hint={`${r.payingShops} pagante(s) · ${r.trialShops} em teste`} />
        <Stat icon={<CheckCircle2 className="size-5" />} label="Recebido este mês" value={money(r.receivedThisMonth)} />
        <Stat icon={<CreditCard className="size-5" />} label="A receber (no prazo)" value={money(r.open)} />
        <Stat
          icon={<CreditCard className="size-5" />}
          label="Vencido"
          value={money(r.overdue)}
          hint={r.informed ? <span className="font-medium text-emerald-700">{r.informed} pagamento(s) informado(s) para conferir</span> : undefined}
        />
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Faturas</h2>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['open', 'Em aberto'],
                ['paid', 'Pagas'],
                ['cancelled', 'Canceladas'],
                ['', 'Todas'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setStatus(id)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${status === id ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:bg-zinc-100'}`}
              >
                {label}
              </button>
            ))}
            <Button variant="ghost" className="!py-1.5" onClick={() => api<{ created: number }>('POST', '/api/master/billing/generate').then((x) => { setMsg(`${x.created} fatura(s) gerada(s).`); load(); }, (e) => alert(e.message))}>
              Gerar faturas do mês
            </Button>
            <Button className="!py-1.5" onClick={() => setNewInvoice(true)}>
              <Plus className="size-4" /> Cobrança avulsa
            </Button>
          </div>
        </div>
        {msg && <p className="mb-2 text-sm text-emerald-700">{msg}</p>}
        {data.invoices.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhuma fatura aqui. As mensalidades são geradas sozinhas no começo de cada mês.</p>
        ) : (
          <Card className="!p-0">
            <ul className="divide-y divide-zinc-100 text-sm">
              {data.invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
                  <div className="min-w-0 flex-1 basis-56">
                    <p>
                      <b>{i.shop_name}</b> · {i.description}
                    </p>
                    <p className="text-xs text-zinc-500">
                      vence {date(i.due_date)}
                      {i.informed_at && i.status === 'open' && <span className="text-emerald-700"> · pagamento informado {date(i.informed_at)}</span>}
                    </p>
                  </div>
                  <span className="flex items-center gap-2">
                    <b className="whitespace-nowrap tabular-nums">{money(i.amount_cents)}</b>
                    <Badge tone={i.status === 'paid' ? 'green' : i.status === 'cancelled' ? 'zinc' : i.overdue ? 'red' : 'gold'}>
                      {i.status === 'paid' ? `Paga ${date(i.paid_at)}` : i.status === 'cancelled' ? 'Cancelada' : i.overdue ? 'Vencida' : 'Em aberto'}
                    </Badge>
                  </span>
                  {i.status === 'open' && (
                    <span className="flex items-center gap-2">
                      <Button className="!px-2.5 !py-1" onClick={() => setPaying(i)}>
                        Confirmar pagamento
                      </Button>
                      <button
                        className="text-xs text-zinc-500 hover:text-red-600"
                        onClick={() => confirm('Cancelar esta fatura?') && api('POST', `/api/master/invoices/${i.id}/cancel`).then(load, (e) => alert(e.message))}
                      >
                        Cancelar
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <p className="font-semibold">Planos</p>
            <Button variant="ghost" className="!py-1.5" onClick={() => setPlan({ active: 1 })}>
              <Plus className="size-4" /> Novo plano
            </Button>
          </div>
          {plans.length === 0 && <p className="text-sm text-zinc-500">Crie os planos que você vende (ex.: Comunidade, R$ 149,90/mês).</p>}
          <ul className="divide-y divide-zinc-100 text-sm">
            {plans.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <b>{p.name}</b> {!p.active && <Badge>Inativo</Badge>}
                  <span className="block text-xs text-zinc-500">
                    {p.shops ?? 0} barbearia(s){p.description ? ` · ${p.description}` : ''}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <b className="tabular-nums">{money(p.price_cents)}</b>
                  <button className="text-xs text-zinc-500 hover:text-zinc-900" onClick={() => setPlan(p)}>
                    Editar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <SettingsCard />
      </div>

      {paying && (
        <PayInvoiceModal
          invoice={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            load();
          }}
        />
      )}
      {newInvoice && (
        <NewInvoiceModal
          shops={shops}
          onClose={() => setNewInvoice(false)}
          onDone={() => {
            setNewInvoice(false);
            load();
          }}
        />
      )}
      {plan && (
        <PlanModal
          plan={plan}
          onClose={() => setPlan(null)}
          onDone={() => {
            setPlan(null);
            load();
          }}
        />
      )}
    </>
  );
}

function SettingsCard() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Settings>('GET', '/api/master/settings').then(setS);
  }, []);
  if (!s) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSaved(false);
    setS({ ...s, [k]: v });
  };
  return (
    <Card>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          api<Settings>('PUT', '/api/master/settings', s).then(
            (x) => {
              setS(x);
              setSaved(true);
            },
            (err) => setError(err.message),
          );
        }}
      >
        <p className="font-semibold">Recebimento e regras</p>
        <Field label="Sua chave PIX" hint="As faturas mostram QR Code e PIX copia e cola com o valor certo.">
          <Input value={s.pix_key} placeholder="CPF/CNPJ, e-mail, celular ou chave aleatória" onChange={(e) => set('pix_key', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nome do recebedor">
            <Input value={s.pix_name} onChange={(e) => set('pix_name', e.target.value)} />
          </Field>
          <Field label="Cidade">
            <Input value={s.pix_city} onChange={(e) => set('pix_city', e.target.value)} />
          </Field>
          <Field label="Carência (dias)" hint="Depois do vencimento, até bloquear.">
            <Input type="number" min={0} max={60} value={s.grace_days} onChange={(e) => set('grace_days', Number(e.target.value))} />
          </Field>
          <Field label="Teste grátis (dias)" hint="Padrão para barbearias novas.">
            <Input type="number" min={0} max={365} value={s.trial_days} onChange={(e) => set('trial_days', Number(e.target.value))} />
          </Field>
        </div>
        <ErrorText error={error} />
        <div className="flex items-center gap-3">
          <Button type="submit">Salvar</Button>
          {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
        </div>
      </form>
    </Card>
  );
}

function PayInvoiceModal({ invoice, onClose, onDone }: { invoice: Invoice; onClose: () => void; onDone: () => void }) {
  const [paidAt, setPaidAt] = useState(todayStr());
  const [method, setMethod] = useState('pix');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Confirmar pagamento" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm">
          <b>{invoice.shop_name}</b> · {invoice.description} · <b>{money(invoice.amount_cents)}</b>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pago em">
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
          <Field label="Forma">
            <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="pix">PIX</option>
              <option value="boleto">Boleto</option>
              <option value="cartao">Cartão</option>
              <option value="transferencia">Transferência</option>
              <option value="dinheiro">Dinheiro</option>
              <option value="outro">Outro</option>
            </select>
          </Field>
        </div>
        <Field label="Observação">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="text-xs text-zinc-500">Ao confirmar, o acesso é liberado e a saída entra no caixa da barbearia como “Mensalidade do sistema”.</p>
        <ErrorText error={error} />
        <Button className="w-full" onClick={() => api('POST', `/api/master/invoices/${invoice.id}/pay`, { paid_at: paidAt, method, notes: notes || null }).then(onDone, (e) => setError(e.message))}>
          Confirmar {money(invoice.amount_cents)}
        </Button>
      </div>
    </Modal>
  );
}

function NewInvoiceModal({ shops, onClose, onDone }: { shops: { id: number; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ barbershop_id: shops[0] ? String(shops[0].id) : '', description: '', amount: '', due_date: addDays(todayStr(), 5) });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Cobrança avulsa" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          api('POST', '/api/master/invoices', {
            barbershop_id: Number(form.barbershop_id),
            description: form.description,
            amount_cents: parseMoney(form.amount),
            due_date: form.due_date,
          }).then(onDone, (err) => setError(err.message));
        }}
      >
        <Field label="Barbearia">
          <select className={inputClass} value={form.barbershop_id} onChange={(e) => setForm({ ...form, barbershop_id: e.target.value })}>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Descrição">
          <Input required placeholder="Ex.: implantação e treinamento" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor (R$)">
            <Input required inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Vencimento">
            <Input type="date" required value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </Field>
        </div>
        <ErrorText error={error} />
        <div className="flex justify-end">
          <Button type="submit">Criar cobrança</Button>
        </div>
      </form>
    </Modal>
  );
}

function PlanModal({ plan, onClose, onDone }: { plan: Partial<Plan>; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: plan.name ?? '', price: plan.price_cents != null ? centsToInput(plan.price_cents) : '', description: plan.description ?? '', active: plan.active !== 0 });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={plan.id ? 'Editar plano' : 'Novo plano'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const body = { name: form.name, price_cents: parseMoney(form.price), description: form.description || null, active: form.active };
          api(plan.id ? 'PUT' : 'POST', plan.id ? `/api/master/plans/${plan.id}` : '/api/master/plans', body).then(onDone, (err) => setError(err.message));
        }}
      >
        <Field label="Nome">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Preço por mês (R$)">
          <Input required inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </Field>
        <Field label="Descrição">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Plano disponível para novas barbearias
        </label>
        <ErrorText error={error} />
        <div className="flex justify-end">
          <Button type="submit">Salvar</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Sistema (atualizações, avisos, saúde)

interface SystemInfo {
  version: string;
  node: string;
  startedAt: string;
  database: { file: string; bytes: number };
  automations: { enabled: boolean; lastRun: string | null; lastSummary: { reminders: number; habits: number; winbacks: number } | null; lastInvoices: number };
  llm: { enabled: boolean; model: string | null; effort: string };
  publicUrl: string | null;
  failures24h: { shop: string; failed: number; last_error: string | null }[];
  counts: { shops: number; customers: number; appointments: number; sales: number; messages: number };
}

interface Announcement {
  id: number;
  title: string;
  body: string;
  level: 'novidade' | 'aviso' | 'manutencao';
  active: number;
  created_at: string;
}

function SystemTab() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [list, setList] = useState<Announcement[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);
  const load = useCallback(() => {
    api<SystemInfo>('GET', '/api/master/system').then(setInfo);
    api<Announcement[]>('GET', '/api/master/announcements').then(setList);
    api<Overview>('GET', '/api/master/overview').then(setOverview);
  }, []);
  useEffect(load, [load]);
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

  return (
    <>
      {info && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-1.5 text-sm">
            <p className="mb-2 flex items-center gap-2 font-semibold">
              <Server className="size-4" /> Servidor
            </p>
            <p>
              Versão do sistema <b>{info.version}</b> · Node {info.node}
            </p>
            <p>No ar desde {new Date(info.startedAt).toLocaleString('pt-BR')}</p>
            <p>
              Banco de dados: <b>{mb(info.database.bytes)}</b> · {info.counts.customers} clientes · {info.counts.appointments} horários · {info.counts.sales} vendas ·{' '}
              {info.counts.messages} mensagens
            </p>
            <p>Endereço público: {info.publicUrl ?? <span className="text-amber-700">não definido (PUBLIC_URL)</span>}</p>
          </Card>
          <Card className="space-y-1.5 text-sm">
            <p className="mb-2 flex items-center gap-2 font-semibold">
              <Activity className="size-4" /> Robôs e automações
            </p>
            <p>
              IA: {info.llm.enabled ? <b>ligada ({info.llm.model}, esforço {info.llm.effort})</b> : <span className="text-amber-700">desligada (respostas por menu)</span>}
            </p>
            <p>
              Automações: {info.automations.enabled ? 'ligadas' : 'desligadas'}
              {info.automations.lastRun && ` · última rodada ${new Date(info.automations.lastRun).toLocaleString('pt-BR')}`}
            </p>
            {info.automations.lastSummary && (
              <p className="text-zinc-500">
                Última rodada: {info.automations.lastSummary.reminders} lembrete(s), {info.automations.lastSummary.habits} oferta(s) de horário, {info.automations.lastSummary.winbacks}{' '}
                recontato(s)
              </p>
            )}
            {info.failures24h.length === 0 ? (
              <p className="text-emerald-700">Nenhuma falha de envio de WhatsApp nas últimas 24h.</p>
            ) : (
              info.failures24h.map((f) => (
                <p key={f.shop} className="text-red-700">
                  ⚠ {f.shop}: {f.failed} falha(s) · {f.last_error}
                </p>
              ))
            )}
          </Card>
        </div>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Megaphone className="size-5" /> Avisos e atualizações
            </h2>
            <p className="text-sm text-zinc-500">Aparecem no topo do painel de todas as barbearias (novidades, manutenções, avisos).</p>
          </div>
          <Button className="shrink-0" onClick={() => setEditing({ level: 'novidade', active: 1 })}>
            <Plus className="size-4" /> Novo aviso
          </Button>
        </div>
        {list.length === 0 && <p className="text-sm text-zinc-500">Nenhum aviso publicado.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((a) => (
            <Card key={a.id} className="!p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{a.title}</p>
                <Badge tone={a.active ? 'green' : 'zinc'}>{a.active ? 'Publicado' : 'Oculto'}</Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {a.level === 'novidade' ? 'Novidade' : a.level === 'aviso' ? 'Aviso' : 'Manutenção'} · {date(a.created_at)}
              </p>
              <p className="mt-2 text-sm whitespace-pre-line text-zinc-700">{a.body}</p>
              <div className="mt-3 flex gap-3 text-xs">
                <button className="font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setEditing(a)}>
                  Editar
                </button>
                <button className="text-red-600 hover:underline" onClick={() => confirm('Excluir este aviso?') && api('DELETE', `/api/master/announcements/${a.id}`).then(load, (e) => alert(e.message))}>
                  Excluir
                </button>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {overview && overview.recentMessages.length > 0 && (
        <div>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
            <Activity className="size-5" /> Atividade recente dos robôs
          </h2>
          <Card className="!p-0">
            <ul className="divide-y divide-zinc-100 text-sm">
              {overview.recentMessages.map((m) => (
                <li key={m.id} className="px-4 py-2.5 sm:flex sm:gap-3">
                  {/* No celular: barbearia e hora em cima, mensagem embaixo. */}
                  <div className="flex items-center justify-between gap-3 sm:contents">
                    <span className="truncate font-medium sm:w-28 sm:shrink-0">{m.shop}</span>
                    <span className="shrink-0 text-xs text-zinc-400 sm:order-last">
                      {m.status === 'failed' ? <span className="text-red-600">falhou</span> : new Date(m.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-zinc-600 sm:min-w-0 sm:flex-1 sm:truncate">
                    {m.direction === 'in' ? '← ' : '→ '}
                    {m.body}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {editing && (
        <AnnouncementModal
          item={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function AnnouncementModal({ item, onClose, onDone }: { item: Partial<Announcement>; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ title: item.title ?? '', body: item.body ?? '', level: item.level ?? 'novidade', active: item.active !== 0 });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={item.id ? 'Editar aviso' : 'Novo aviso'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          api(item.id ? 'PUT' : 'POST', item.id ? `/api/master/announcements/${item.id}` : '/api/master/announcements', form).then(onDone, (err) => setError(err.message));
        }}
      >
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ['novidade', 'Novidade'],
              ['aviso', 'Aviso'],
              ['manutencao', 'Manutenção'],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              onClick={() => setForm({ ...form, level: id })}
              className={`rounded-lg py-2 text-sm font-medium ring-1 ${form.level === id ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <Field label="Título">
          <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Mensagem">
          <textarea className={inputClass} rows={4} required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Publicado (aparece no painel das barbearias)
        </label>
        <ErrorText error={error} />
        <div className="flex justify-end">
          <Button type="submit">Salvar</Button>
        </div>
      </form>
    </Modal>
  );
}
