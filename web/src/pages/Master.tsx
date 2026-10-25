import {
  Activity,
  Bug,
  Bot,
  CalendarDays,
  CheckCircle2,
  Circle,
  Copy,
  CreditCard,
  DatabaseBackup,
  ExternalLink,
  KeyRound,
  ListChecks,
  LogOut,
  Megaphone,
  Plus,
  Scissors,
  Server,
  ShieldCheck,
  Store,
  Smartphone,
  Unlock,
  UserCog,
  Wallet,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Me } from '../App';
import { AccountModal } from '../components/Account';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal, inputClass } from '../components/ui';
import { AsaasCard } from './master/AsaasCard';
import { CieloCard } from './master/CieloCard';
import { OnlinePaymentsCard } from './master/OnlinePayments';
import { api } from '../lib/api';
import { centsToInput, parseMoney } from '../lib/finance';
import { addDays, date, money, phone as fmtPhone, todayStr } from '../lib/format';

interface ShopRow {
  id: number;
  slug: string;
  name: string;
  active: number;
  created_at: string;
  bot_name: string;
  wa_provider: 'simulador' | 'meta' | 'evolution';
  wa_status: 'ok' | 'down' | null;
  wa_status_at: string | null;
  owners: string | null;
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

/** Visão geral da plataforma (sem dados de dentro das barbearias). */
interface Overview {
  shops: number;
  trial: number;
  overdue: number;
  blocked: number;
  whatsappDown: number;
  tokens30d: { in: number; out: number };
  llm: boolean;
  model: string | null;
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
  const [account, setAccount] = useState(false);
  return (
    <div className="min-h-screen">
      <header className="bg-zinc-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2 font-bold">
            <Scissors className="size-5 text-gold" /> Sistema Barbearia <Badge tone="gold">Master</Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <button className="flex items-center gap-1 text-zinc-300 hover:text-white" onClick={() => setAccount(true)}>
              <UserCog className="size-4" /> <span className="hidden sm:inline">{me.user?.name}</span>
            </button>
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
        {tab === 'barbearias' && <ShopsTab />}
        {tab === 'financeiro' && <BillingTab />}
        {tab === 'sistema' && <SystemTab />}
      </main>
      {account && <AccountModal me={me} onClose={() => setAccount(false)} onSaved={onLogout} />}
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

function ShopsTab() {
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

  return (
    <>
      {overview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat icon={<Store className="size-5" />} label="Barbearias ativas" value={overview.shops} />
            <Stat icon={<CalendarDays className="size-5" />} label="Em teste grátis" value={overview.trial} />
            <Stat
              icon={<CreditCard className="size-5" />}
              label="Com mensalidade vencida"
              value={overview.overdue}
              hint={overview.blocked ? <span className="text-red-600">{overview.blocked} com acesso suspenso</span> : undefined}
            />
            <Stat icon={<WifiOff className="size-5" />} label="WhatsApp desconectado" value={overview.whatsappDown} />
            <Stat
              icon={<Bot className="size-5" />}
              label="IA nos últimos 30 dias"
              value={`${compact(overview.tokens30d.in + overview.tokens30d.out)}`}
              hint="tokens (entrada + saída)"
            />
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
            <p className="text-sm text-zinc-500">
              Crie a barbearia, entregue o acesso ao dono e acompanhe a mensalidade. Agenda, barbeiros e clientes são da barbearia: só o dono vê.
            </p>
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
                <p className="mt-3 text-xs text-zinc-500">
                  {s.price_cents ? `${s.plan_name ? `Plano ${s.plan_name} · ` : ''}${money(s.price_cents)}/mês · vence dia ${s.billing_day}` : 'Sem mensalidade definida'}
                </p>
                <p className="text-xs text-zinc-500">
                  Robô {s.bot_name} · {PROVIDER[s.wa_provider]}
                  {s.failed_week > 0 && <span className="text-red-600"> · {s.failed_week} envio(s) com falha em 7 dias</span>}
                </p>
                {s.owners && <p className="text-xs text-zinc-500">Dono: {s.owners}</p>}
                {s.wa_status === 'down' && (
                  <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-700">
                    <WifiOff className="size-3.5" /> WhatsApp desconectado
                    {s.wa_status_at && ` desde ${new Date(s.wa_status_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`}
                  </p>
                )}
                <p className="text-xs text-zinc-500">
                  IA (30 dias): {compact(s.tokens_in_30d)} tokens de entrada, {compact(s.tokens_out_30d)} de saída · desde {date(s.created_at)}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button className="!py-1.5" onClick={() => setBilling(s)}>
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
  const [form, setForm] = useState({
    name: '',
    slug: '',
    ownerName: '',
    ownerEmail: '',
    ownerPhone: '',
    ownerPassword: '',
    plan_id: '' as string,
    price: '',
    billing_day: '10',
    trial_days: '14',
  });
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
        ownerPhone: form.ownerPhone || null,
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="E-mail">
            <Input type="email" required value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
          </Field>
          <Field label="Celular (WhatsApp)" hint="Para avisos e “esqueci minha senha”.">
            <Input type="tel" placeholder="(11) 98888-7777" value={form.ownerPhone} onChange={(e) => setForm({ ...form, ownerPhone: e.target.value })} />
          </Field>
        </div>
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
  const [owners, setOwners] = useState<{ id: number; name: string; email: string; phone: string | null }[]>([]);
  const [resetting, setResetting] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [phoneFor, setPhoneFor] = useState<number | null>(null);
  const [phoneValue, setPhoneValue] = useState('');
  const [form, setForm] = useState({ ownerName: '', ownerEmail: '', ownerPhone: '', ownerPassword: '' });
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
                  <span className={`block text-xs ${o.phone ? 'text-zinc-500' : 'text-amber-700'}`}>{o.phone ? fmtPhone(o.phone) : 'sem celular (não recebe avisos nem código de senha)'}</span>
                </span>
                <span className="flex shrink-0 gap-3">
                  <button
                    className="text-xs font-medium text-zinc-600 hover:text-zinc-900"
                    onClick={() => {
                      setPhoneFor(phoneFor === o.id ? null : o.id);
                      setPhoneValue(o.phone ? fmtPhone(o.phone) : '');
                    }}
                  >
                    Celular
                  </button>
                  <button className="text-xs font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setResetting(resetting === o.id ? null : o.id)}>
                    Nova senha
                  </button>
                </span>
              </div>
              {phoneFor === o.id && (
                <div className="mt-2 flex gap-2">
                  <Input type="tel" placeholder="(11) 98888-7777" value={phoneValue} onChange={(e) => setPhoneValue(e.target.value)} />
                  <Button
                    onClick={() =>
                      api('PUT', `/api/master/owners/${o.id}/phone`, { phone: phoneValue || null }).then(
                        () => {
                          setPhoneFor(null);
                          load();
                        },
                        (e) => setError(e.message),
                      )
                    }
                  >
                    Salvar
                  </Button>
                </div>
              )}
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
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Nome" value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
            <Input type="email" placeholder="E-mail" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
            <Input type="tel" placeholder="Celular (opcional)" value={form.ownerPhone} onChange={(e) => setForm({ ...form, ownerPhone: e.target.value })} />
            <Input placeholder="Senha" value={form.ownerPassword} onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })} />
          </div>
          <Button
            variant="ghost"
            onClick={() =>
              api('POST', `/api/master/shops/${shop.id}/owners`, form).then(
                () => {
                  setMsg(`Login ${form.ownerEmail} criado.`);
                  setForm({ ownerName: '', ownerEmail: '', ownerPhone: '', ownerPassword: '' });
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
  /** Cobrança no Asaas (baixa automática) e nota fiscal. */
  asaas: number;
  asaas_error: string | null;
  nfse_status: string | null;
  nfse_url: string | null;
  nfse_error: string | null;
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
  pix_type: 'cpf' | 'celular' | 'email' | 'aleatoria';
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
                      {Boolean(i.asaas) && ' · PIX Asaas (baixa automática)'}
                      {i.nfse_url && (
                        <>
                          {' · '}
                          <a href={i.nfse_url} target="_blank" rel="noreferrer" className="font-medium text-zinc-700 underline">
                            nota fiscal
                          </a>
                        </>
                      )}
                      {!i.nfse_url && i.nfse_status && ` · nota ${i.nfse_status.toLowerCase()}`}
                    </p>
                    {i.asaas_error && i.status === 'open' && <p className="text-xs text-red-600">Asaas: {i.asaas_error}</p>}
                    {i.nfse_error && (
                      <p className="text-xs text-red-600">
                        Nota fiscal: {i.nfse_error}{' '}
                        <button className="font-medium underline" onClick={() => api('POST', `/api/master/invoices/${i.id}/nfse`).then(load, (e) => alert(e.message))}>
                          Tentar de novo
                        </button>
                      </p>
                    )}
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

      <OnlinePaymentsCard />

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
      <CieloCard />
      <AsaasCard />

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
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Tipo de chave">
            <select className={inputClass} value={s.pix_type} onChange={(e) => set('pix_type', e.target.value as Settings['pix_type'])}>
              <option value="cpf">CPF ou CNPJ</option>
              <option value="celular">Celular</option>
              <option value="email">E-mail</option>
              <option value="aleatoria">Chave aleatória</option>
            </select>
          </Field>
          <Field label="Sua chave PIX" hint="As faturas mostram QR Code e PIX copia e cola com o valor certo (sem Asaas, você confirma à mão).">
            <Input value={s.pix_key} placeholder="Chave cadastrada no seu banco" onChange={(e) => set('pix_key', e.target.value)} />
          </Field>
        </div>
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
  counts: { shops: number };
  /** Erros inesperados do servidor e das telas (agrupados). */
  errors: { id: number; source: 'server' | 'web'; message: string; path: string; count: number; first_at: string; last_at: string }[];
}

interface BackupInfo {
  status: { at: string | null; file: string | null; bytes: number; remote: 'ok' | 'failed' | 'off'; error: string | null; uploadsSent: number };
  files: { name: string; bytes: number; at: string }[];
  remote: { bucket: string; endpoint: string; encrypted: boolean } | null;
  /** Baixar só criptografada (com BACKUP_PASSWORD no servidor): a cópia tem os dados das barbearias. */
  canDownload: boolean;
}

const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Cópias de segurança: última cópia, envio para fora do servidor e download. */
function BackupCard() {
  const [data, setData] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<BackupInfo>('GET', '/api/master/backups').then(setData, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  if (!data) return <ErrorText error={error} />;
  const s = data.status;
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <DatabaseBackup className="size-4" /> Cópias de segurança
        </p>
        <Button
          variant="ghost"
          className="!px-3 !py-1.5"
          loading={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            api('POST', '/api/master/backups')
              .then(load, (e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Fazer cópia agora
        </Button>
      </div>
      <p>
        {s.at ? (
          <>
            Última cópia: <b>{new Date(s.at).toLocaleString('pt-BR')}</b> · {kb(s.bytes)} · todo dia a partir das 3h
          </>
        ) : (
          <span className="text-amber-700">Nenhuma cópia ainda. A primeira sai hoje, a partir das 3h (ou clique em Fazer cópia agora).</span>
        )}
      </p>
      {data.remote ? (
        s.remote === 'failed' ? (
          <p className="text-red-700">
            ⚠ A última cópia não chegou ao armazenamento externo ({data.remote.bucket}): {s.error}
          </p>
        ) : (
          <p className="text-emerald-700">
            ✓ Enviada para fora do servidor ({data.remote.endpoint} · {data.remote.bucket}){data.remote.encrypted ? ', criptografada' : ''}.
          </p>
        )
      ) : (
        <p className="text-amber-700">
          ⚠ As cópias ficam só neste servidor. Configure um armazenamento externo (variáveis BACKUP_S3_ no servidor) para não perder nada se o servidor quebrar.
        </p>
      )}
      {data.files.length > 0 && (
        <ul className="space-y-0.5 text-xs text-zinc-500">
          {data.files.slice(0, 4).map((f) => (
            <li key={f.name}>
              {data.canDownload ? (
                <a className="font-medium text-zinc-700 underline-offset-2 hover:underline" href={`/api/master/backups/${f.name}`} download>
                  {f.name}.enc
                </a>
              ) : (
                <span className="font-medium text-zinc-700">{f.name}</span>
              )}{' '}
              · {kb(f.bytes)}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-500">
        {data.canDownload
          ? 'O download sai criptografado: guarde fora do servidor; ele só abre com a senha das cópias, no restaurador (npm run restore).'
          : 'Para baixar uma cópia, defina a senha das cópias (BACKUP_PASSWORD) no servidor: como ela tem os dados de dentro das barbearias, o download sai só criptografado.'}
      </p>
      <ErrorText error={error} />
    </Card>
  );
}

interface LegalInfo {
  company: string;
  document: string;
  email: string;
  address: string;
}

/** Dados da empresa que aparecem nos termos de uso e nas políticas de privacidade. */
function LegalCard() {
  const [form, setForm] = useState<LegalInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<LegalInfo>('GET', '/api/master/legal').then(setForm, (e) => setError(e.message));
  }, []);
  if (!form) return <ErrorText error={error} />;
  const set = (k: keyof LegalInfo, v: string) => {
    setSaved(false);
    setForm({ ...form, [k]: v });
  };
  return (
    <Card className="space-y-3 text-sm">
      <div>
        <p className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4" /> Termos e privacidade (LGPD)
        </p>
        <p className="text-zinc-500">
          Seus dados aparecem nos{' '}
          <a href="/termos" target="_blank" rel="noreferrer" className="underline">
            termos de uso
          </a>
          , na{' '}
          <a href="/privacidade" target="_blank" rel="noreferrer" className="underline">
            política de privacidade
          </a>{' '}
          e na política de cada barbearia. Os textos são um modelo: revise com um advogado.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Empresa (razão social ou nome)">
          <Input value={form.company} onChange={(e) => set('company', e.target.value)} />
        </Field>
        <Field label="CNPJ ou CPF">
          <Input value={form.document} onChange={(e) => set('document', e.target.value)} />
        </Field>
        <Field label="E-mail do encarregado de dados">
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Cidade / endereço">
          <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          onClick={() =>
            api<LegalInfo>('PUT', '/api/master/legal', form).then(
              (d) => {
                setForm(d);
                setSaved(true);
              },
              (e) => setError(e.message),
            )
          }
        >
          Salvar
        </Button>
        {saved && <span className="text-emerald-700">Salvo!</span>}
      </div>
      <ErrorText error={error} />
    </Card>
  );
}

interface PlatformWa {
  provider: 'simulador' | 'meta' | 'evolution';
  config: Record<string, string>;
  templates: { kind: string; field: string; label: string; category: string; body: string; example: string[] }[];
  down: { id: number; name: string; since: string | null; error: string | null }[];
  recent: { id: number; phone: string; kind: string; status: string; error: string | null; created_at: string }[];
}

const PLATFORM_KIND: Record<string, string> = { senha: 'Código de senha', alerta: 'Aviso', fatura: 'Mensalidade', aviso: 'Aviso', teste: 'Teste' };

/** WhatsApp da plataforma: fala com os donos (aviso de desconexão, código de senha). */
function PlatformWhatsAppCard() {
  const [data, setData] = useState<PlatformWa | null>(null);
  const [provider, setProvider] = useState<PlatformWa['provider']>('simulador');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [testPhone, setTestPhone] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = (d: PlatformWa) => {
    setData(d);
    setProvider(d.provider);
    setCfg(d.config);
  };
  useEffect(() => {
    api<PlatformWa>('GET', '/api/master/whatsapp').then(apply, (e) => setError(e.message));
  }, []);
  if (!data) return <ErrorText error={error} />;
  const field = (key: string, label: string, opts: { secret?: boolean; placeholder?: string } = {}) => (
    <Field label={label}>
      <Input type={opts.secret ? 'password' : 'text'} autoComplete="off" placeholder={opts.placeholder} value={cfg[key] ?? ''} onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })} />
    </Field>
  );
  const run = (p: Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    p.then(() => setMsg(ok), (e) => setError(e.message)).finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3">
      {data.down.length > 0 && (
        <Card className="space-y-1.5 text-sm ring-red-200">
          <p className="flex items-center gap-2 font-semibold text-red-700">
            <WifiOff className="size-4" /> WhatsApp desconectado em {data.down.length} barbearia(s)
          </p>
          {data.down.map((d) => (
            <p key={d.id}>
              <b>{d.name}</b>
              {d.since && <span className="text-zinc-500"> · desde {new Date(d.since).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>}
              {d.error && <span className="text-zinc-500"> · {d.error}</span>}
            </p>
          ))}
        </Card>
      )}
      <Card className="space-y-3 text-sm">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            <Smartphone className="size-4" /> WhatsApp da plataforma
          </p>
          <p className="text-zinc-500">
            O seu número: avisa o dono quando o WhatsApp da barbearia cai e manda o código de “esqueci minha senha”. Os donos precisam ter o celular cadastrado.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(['simulador', 'evolution', 'meta'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${provider === p ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
            >
              {PROVIDER[p]}
            </button>
          ))}
        </div>
        {provider === 'simulador' && <p className="text-amber-700">Sem WhatsApp: os avisos ficam só registrados abaixo (em demonstração, o código de senha aparece na tela).</p>}
        {provider === 'evolution' && (
          <div className="grid gap-3 sm:grid-cols-3">
            {field('baseUrl', 'Endereço da Evolution API', { placeholder: 'https://evolution.seudominio.com.br' })}
            {field('instance', 'Instância')}
            {field('apiKey', 'Chave (apikey)', { secret: true })}
          </div>
        )}
        {provider === 'meta' && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              {field('phoneNumberId', 'ID do número')}
              {field('token', 'Token de acesso', { secret: true })}
              {field('templateLang', 'Idioma dos modelos', { placeholder: 'pt_BR' })}
            </div>
            <p className="text-zinc-500">A plataforma não recebe respostas: na API oficial todas as mensagens saem por modelo aprovado.</p>
            {data.templates.map((t) => (
              <div key={t.kind} className="grid gap-2 sm:grid-cols-[1fr_14rem] sm:items-start">
                <div>
                  <p className="font-medium">{t.label}</p>
                  <p className="rounded-lg bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-700">{t.body}</p>
                </div>
                <Input placeholder="nome aprovado" value={cfg[t.field] ?? ''} onChange={(e) => setCfg({ ...cfg, [t.field]: e.target.value })} />
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button loading={busy} onClick={() => run(api<PlatformWa>('PUT', '/api/master/whatsapp', { provider, config: cfg }).then(apply), 'Salvo!')}>
            Salvar
          </Button>
          {data.provider !== 'simulador' && (
            <>
              <Input type="tel" className="!w-44" placeholder="Seu celular" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
              <Button variant="ghost" loading={busy} onClick={() => run(api('POST', '/api/master/whatsapp/test', { phone: testPhone }), 'Teste enviado! Confira o WhatsApp.')}>
                Enviar teste
              </Button>
            </>
          )}
        </div>
        {msg && <p className="text-emerald-700">{msg}</p>}
        <ErrorText error={error} />
        {data.recent.length > 0 && (
          <ul className="space-y-0.5 border-t border-zinc-100 pt-2 text-xs text-zinc-500">
            {data.recent.map((m) => (
              <li key={m.id}>
                {new Date(m.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · {PLATFORM_KIND[m.kind] ?? m.kind} para {fmtPhone(m.phone)} ·{' '}
                {m.status === 'failed' ? <span className="text-red-600">falhou{m.error ? `: ${m.error}` : ''}</span> : m.status === 'simulated' ? 'só registrado' : 'enviado'}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

interface Announcement {
  id: number;
  title: string;
  body: string;
  level: 'novidade' | 'aviso' | 'manutencao';
  active: number;
  created_at: string;
}

interface ReadinessItem {
  id: string;
  label: string;
  done: boolean;
  hint: string;
  optional?: boolean;
}

/** Pronto para o piloto? O que precisa estar certo antes da primeira barbearia de verdade. */
function ReadinessCard() {
  const [items, setItems] = useState<ReadinessItem[] | null>(null);
  useEffect(() => {
    api<ReadinessItem[]>('GET', '/api/master/readiness').then(setItems);
  }, []);
  if (!items) return null;
  const required = items.filter((i) => !i.optional);
  const done = required.filter((i) => i.done).length;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <ListChecks className="size-4" /> Pronto para o piloto?
        </p>
        <Badge tone={done === required.length ? 'green' : 'gold'}>
          {done === required.length ? 'Tudo pronto' : `${done} de ${required.length} prontos`}
        </Badge>
      </div>
      <ul className="grid gap-2 text-sm md:grid-cols-2">
        {items.map((i) => (
          <li key={i.id} className="flex items-start gap-2">
            {i.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 size-4 shrink-0 text-zinc-300" />}
            <span>
              <span className={i.done ? 'text-zinc-500' : 'font-medium'}>
                {i.label}
                {i.optional && <span className="font-normal text-zinc-400"> (recomendado)</span>}
              </span>
              {!i.done && <span className="block text-xs text-zinc-500">{i.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Erros inesperados (servidor e telas): o master recebe um aviso por hora no WhatsApp da plataforma. */
function ErrorsCard({ errors, onCleared }: { errors: SystemInfo['errors']; onCleared: () => void }) {
  const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Bug className="size-4" /> Erros do sistema
        </p>
        {errors.length > 0 && (
          <button className="text-xs font-medium text-zinc-500 hover:text-zinc-900" onClick={() => api('POST', '/api/master/errors/clear').then(onCleared)}>
            Limpar
          </button>
        )}
      </div>
      {errors.length === 0 ? (
        <p className="text-emerald-700">Nenhum erro registrado. 👍</p>
      ) : (
        <ul className="space-y-1.5">
          {errors.map((e) => (
            <li key={e.id} className="rounded-lg bg-red-50 px-3 py-2 text-red-900">
              <p className="font-medium break-words">{e.message}</p>
              <p className="text-xs text-red-800/80">
                {e.source === 'web' ? 'Tela' : 'Servidor'}
                {e.path && ` · ${e.path}`} · {e.count}× · último em {when(e.last_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-500">Com o seu celular em Minha conta, você recebe um aviso no WhatsApp (no máximo um por hora) quando aparecer erro novo.</p>
    </Card>
  );
}

function SystemTab() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [list, setList] = useState<Announcement[]>([]);
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);
  const load = useCallback(() => {
    api<SystemInfo>('GET', '/api/master/system').then(setInfo);
    api<Announcement[]>('GET', '/api/master/announcements').then(setList);
  }, []);
  useEffect(load, [load]);
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

  return (
    <>
      <ReadinessCard />
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
              Banco de dados: <b>{mb(info.database.bytes)}</b> · {info.counts.shops} barbearia(s)
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
          <ErrorsCard errors={info.errors} onCleared={load} />
          <BackupCard />
          <PlatformWhatsAppCard />
          <LegalCard />
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
