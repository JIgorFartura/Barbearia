import { Activity, Bot, CalendarDays, ExternalLink, LogIn, LogOut, MessageSquare, Plus, Scissors, Store, Ticket, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Me } from '../App';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal } from '../components/ui';
import { api } from '../lib/api';
import { date } from '../lib/format';
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

const PROVIDER: Record<ShopRow['wa_provider'], string> = { simulador: 'Simulador', meta: 'WhatsApp oficial', evolution: 'Evolution API' };
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} mi` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n));

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
      <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">{icon}</div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-sm text-zinc-500">{label}</p>
    </div>
  );
}

const slugify = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

/** Painel do dono da plataforma: visão de tudo, cadastro das barbearias e acesso ao painel de cada uma. */
export function Master({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [shops, setShops] = useState<ShopRow[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api<ShopRow[]>('GET', '/api/master/shops').then(setShops);
    api<Overview>('GET', '/api/master/overview').then(setOverview);
  }, []);
  useEffect(load, [load]);

  async function toggle(shop: ShopRow) {
    await api('PUT', `/api/master/shops/${shop.id}`, { name: shop.name, slug: shop.slug, active: !shop.active });
    load();
  }

  async function enter(shop: ShopRow) {
    await api('POST', `/api/master/shops/${shop.id}/enter`);
    navigate('/painel');
    onLogout();
  }

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
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
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
              <p className="text-sm text-zinc-500">Cada barbearia tem seu site com a própria marca e um painel só dela. O sistema é o mesmo para todas.</p>
            </div>
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nova barbearia
            </Button>
          </div>

          {shops?.length === 0 && (
            <EmptyState icon={<Store className="size-6" />} title="Nenhuma barbearia ainda" text="Cadastre a primeira e entregue o login para o dono." />
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {shops?.map((s) => (
              <Card key={s.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{s.name}</p>
                    <a href={`/b/${s.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
                      /b/{s.slug} <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <Badge tone={s.active ? 'green' : 'red'}>{s.active ? 'Ativa' : 'Suspensa'}</Badge>
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
                  Robô {s.bot_name} · {PROVIDER[s.wa_provider]} · {s.barbers} barbeiro(s) · {s.campaigns} campanha(s)
                  {s.failed_week > 0 && <span className="text-red-600"> · {s.failed_week} mensagem(ns) com falha</span>}
                </p>
                <p className="text-xs text-zinc-500">
                  IA (30 dias): {compact(s.tokens_in_30d)} tokens de entrada, {compact(s.tokens_out_30d)} de saída · Login: {s.owners ?? '—'} · desde {date(s.created_at)}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button className="!py-1.5" onClick={() => enter(s)}>
                    <LogIn className="size-4" /> Abrir painel
                  </Button>
                  <Button variant={s.active ? 'danger' : 'ghost'} className="!py-1.5" onClick={() => toggle(s)}>
                    {s.active ? 'Suspender' : 'Reativar'}
                  </Button>
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
                  <li key={m.id} className="flex gap-3 px-4 py-2.5">
                    <span className="w-28 shrink-0 truncate font-medium">{m.shop}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-600">
                      {m.direction === 'in' ? '← ' : '→ '}
                      {m.body}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {m.status === 'failed' ? <span className="text-red-600">falhou</span> : new Date(m.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        )}
      </main>

      {creating && (
        <NewShopModal
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

function NewShopModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', slug: '', ownerName: '', ownerEmail: '', ownerPassword: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/master/shops', form);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nova barbearia" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome da barbearia">
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugTouched ? form.slug : slugify(e.target.value) })}
          />
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
