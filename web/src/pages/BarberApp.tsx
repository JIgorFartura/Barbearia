import { CalendarDays, ChevronLeft, ChevronRight, LogOut, MessageCircle, Phone, Receipt, Star, UserCog, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Me } from '../App';
import { AccountModal } from '../components/Account';
import { CheckoutModal, type CheckoutEndpoints } from '../components/Checkout';
import { ProfileLine, ProfileModal, type ProfileSummary } from '../components/Profile';
import { PushBanner } from '../components/AppInstall';
import { Badge, Button, Card, ErrorText } from '../components/ui';
import { api } from '../lib/api';
import { addDays, cap, date as fmtDate, dayLabel, money, promoLabel, todayStr, whatsappLink } from '../lib/format';

interface BarberMe {
  barber: { id: number; name: string; photo_url: string | null };
  shop: { id: number; slug: string; name: string; primary_color: string; accent_color: string; logo_url: string | null };
  canClose: boolean;
  today: string;
  /** Nota média dos clientes nos últimos 90 dias. */
  rating: { n: number; avg: number | null };
}

interface Appointment {
  id: number;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  service_name: string;
  price_cents: number;
  starts_at: string;
  ends_at: string;
  status: 'scheduled' | 'cancelled' | 'no_show';
  items: { catalog_item_id: number; name: string; qty: number }[];
  /** Fechado: a comissão dele nesse atendimento. */
  sale: { id: number; commission_cents: number } | null;
  /** O cliente confirmou a presença. */
  confirmed_at: string | null;
  /** Ficha do cliente: o jeito que ele gosta e as fotos dos cortes. */
  profile: ProfileSummary;
  /** Desconto do horário vazio ou de volta (o preço já sai com ele). */
  promo_percent: number | null;
  promo_kind: 'vazio' | 'volta' | null;
}

interface Earnings {
  from: string;
  to: string;
  balance: { unpaid_cents: number; unpaid_items: number; since: string | null; lastPayout: { date: string; amount_cents: number } | null } | null;
  /** Só a parte dele: a comissão de cada item (o valor das vendas é da barbearia). */
  items: { date: string; customer: string | null; name: string; kind: string; qty: number; commission_cents: number; paid: boolean }[];
  commission: number;
  /** Atendimentos (serviços) feitos no período. */
  services: number;
  payouts: { id: number; date: string; amount_cents: number; items: number; until_date: string; method: string | null }[];
}

const ENDPOINTS: CheckoutEndpoints = {
  checkout: '/api/barber/checkout',
  sales: '/api/barber/sales',
  customers: '/api/barber/customers',
  club: '/api/barber/club',
  giftCards: '/api/barber/gift-cards',
};

/** Área do barbeiro (no celular): a agenda dele, fechar atendimento e as comissões. */
export function BarberApp({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [info, setInfo] = useState<BarberMe | null>(null);
  const [tab, setTab] = useState<'agenda' | 'ganhos'>('agenda');
  const [account, setAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<BarberMe>('GET', '/api/barber/me').then((d) => {
      setInfo(d);
      document.title = `${d.barber.name} · ${d.shop.name}`;
    }, (e) => setError(e.message));
  }, []);
  const logout = () => api('POST', '/api/auth/logout').then(onLogout);

  if (!info) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <ErrorText error={error} />
        {error && (
          <button className="text-sm text-zinc-500 hover:text-zinc-900" onClick={logout}>
            Sair
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="text-white" style={{ background: info.shop.primary_color }}>
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          {info.shop.logo_url && <img src={info.shop.logo_url} alt="" className="size-9 rounded-lg bg-white object-contain p-0.5" />}
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">{info.barber.name}</p>
            <p className="truncate text-xs opacity-80">
              {info.shop.name}
              {info.rating.avg != null && (
                <span title="Nota média dos clientes nos últimos 90 dias">
                  {' '}
                  · <Star className="mb-0.5 inline size-3 fill-current" /> {info.rating.avg.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} ({info.rating.n}{' '}
                  {info.rating.n === 1 ? 'nota' : 'notas'})
                </span>
              )}
            </p>
          </div>
          <button className="rounded-lg p-1.5 hover:bg-white/10" onClick={() => setAccount(true)} aria-label="Minha conta">
            <UserCog className="size-5" />
          </button>
          <button className="rounded-lg p-1.5 hover:bg-white/10" onClick={logout} aria-label="Sair">
            <LogOut className="size-5" />
          </button>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 px-4">
          {(
            [
              ['agenda', 'Minha agenda', CalendarDays],
              ['ganhos', 'Meus ganhos', Wallet],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium ${tab === id ? 'border-white' : 'border-transparent opacity-70 hover:opacity-100'}`}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-5">
        <PushBanner text="Receba no celular os horários novos e os cancelados da sua agenda." />
        {tab === 'agenda' ? <BarberAgenda info={info} /> : <EarningsTab />}
      </main>
      {account && <AccountModal me={me} onClose={() => setAccount(false)} onSaved={onLogout} />}
    </div>
  );
}

function BarberAgenda({ info }: { info: BarberMe }) {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<{ appointments: Appointment[]; blocks: { id: number; starts_at: string; ends_at: string; reason: string | null }[] } | null>(null);
  const [closing, setClosing] = useState<number | 'balcao' | null>(null);
  const [ficha, setFicha] = useState<Appointment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<typeof data>('GET', `/api/barber/agenda?date=${date}`).then(setData, (e) => setError(e.message));
  }, [date]);
  useEffect(load, [load]);

  const mark = (a: Appointment, status: 'scheduled' | 'no_show') => api('POST', `/api/barber/appointments/${a.id}/status`, { status }).then(load, (e) => setError(e.message));
  const isToday = date === todayStr();

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <button className="rounded-lg bg-white p-2 ring-1 ring-zinc-200" onClick={() => setDate(addDays(date, -1))} aria-label="Dia anterior">
          <ChevronLeft className="size-4" />
        </button>
        <p className="flex-1 text-center font-semibold">{isToday ? `Hoje, ${date.slice(8, 10)}/${date.slice(5, 7)}` : cap(dayLabel(date))}</p>
        <button className="rounded-lg bg-white p-2 ring-1 ring-zinc-200" onClick={() => setDate(addDays(date, 1))} aria-label="Próximo dia">
          <ChevronRight className="size-4" />
        </button>
      </div>
      <ErrorText error={error} />
      {data?.blocks.map((b) => (
        <p key={b.id} className="rounded-xl bg-zinc-100 px-4 py-2 text-sm text-zinc-600">
          Folga/bloqueio {b.starts_at.slice(11)}–{b.ends_at.slice(11)}
          {b.reason ? ` · ${b.reason}` : ''}
        </p>
      ))}
      {data && data.appointments.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">Nenhum horário marcado neste dia.</p>}
      <ul className="space-y-2">
        {data?.appointments.map((a) => (
          <li key={a.id}>
            <Card className={`!p-4 ${a.status !== 'scheduled' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-lg font-bold tabular-nums">
                    {a.starts_at.slice(11)} <span className="font-semibold">{a.customer_name}</span>
                  </p>
                  <p className="text-sm text-zinc-500">
                    {a.service_name} · {money(a.price_cents)}
                    {a.promo_percent ? (
                      <span className="font-medium text-emerald-700">
                        {' '}
                        (−{a.promo_percent}% {promoLabel(a.promo_kind)})
                      </span>
                    ) : null}
                  </p>
                </div>
                {a.status === 'cancelled' ? (
                  <Badge>Cancelado</Badge>
                ) : a.status === 'no_show' ? (
                  <Badge tone="red">Faltou</Badge>
                ) : a.sale ? (
                  <Badge tone="green">Pago</Badge>
                ) : null}
              </div>
              {a.status === 'scheduled' && !a.sale && a.confirmed_at && <p className="mt-1 text-sm font-medium text-emerald-700">✓ Presença confirmada</p>}
              {a.status !== 'cancelled' && <ProfileLine base="/api/barber" summary={a.profile} onOpen={() => setFicha(a)} />}
              {a.items.length > 0 && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900">
                  🛍️ Separar: {a.items.map((i) => `${i.qty} ${i.name.toLowerCase()}`).join(', ')}
                </p>
              )}
              {a.sale && (
                <p className="mt-2 text-sm text-emerald-700">
                  ✓ Atendimento fechado · sua parte: <b className="tabular-nums">{money(a.sale.commission_cents)}</b>
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {a.status === 'scheduled' && !a.sale && info.canClose && (
                  <Button className="!px-3 !py-1.5" onClick={() => setClosing(a.id)}>
                    <Receipt className="size-4" /> Fechar
                  </Button>
                )}
                {a.status === 'scheduled' && !a.sale && (
                  <button className="text-sm text-zinc-500 hover:text-zinc-900" onClick={() => mark(a, 'no_show')}>
                    Faltou
                  </button>
                )}
                {a.status === 'no_show' && (
                  <button className="text-sm text-zinc-500 hover:text-zinc-900" onClick={() => mark(a, 'scheduled')}>
                    Desfazer falta
                  </button>
                )}
                <span className="ml-auto flex gap-3">
                  <a href={`tel:+55${a.customer_phone}`} className="text-zinc-500 hover:text-zinc-900" aria-label="Ligar">
                    <Phone className="size-4" />
                  </a>
                  <a href={whatsappLink(a.customer_phone)} target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-emerald-700" aria-label="WhatsApp">
                    <MessageCircle className="size-4" />
                  </a>
                </span>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {info.canClose && (
        <Button variant="ghost" className="w-full" onClick={() => setClosing('balcao')}>
          Venda de balcão (sem horário)
        </Button>
      )}
      {ficha && (
        <ProfileModal
          base="/api/barber"
          customerId={ficha.customer_id}
          customerName={ficha.customer_name}
          appointmentId={ficha.id}
          onClose={() => setFicha(null)}
          onChanged={load}
        />
      )}
      {closing && (
        <CheckoutModal
          appointmentId={closing === 'balcao' ? undefined : closing}
          endpoints={ENDPOINTS}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function EarningsTab() {
  const today = todayStr();
  const presets = [
    { label: 'Este mês', from: `${today.slice(0, 7)}-01`, to: today },
    { label: 'Mês passado', from: `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`, to: addDays(`${today.slice(0, 7)}-01`, -1) },
    { label: '7 dias', from: addDays(today, -6), to: today },
  ];
  const [period, setPeriod] = useState(presets[0]);
  const [data, setData] = useState<Earnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Earnings>('GET', `/api/barber/earnings?from=${period.from}&to=${period.to}`).then(setData, (e) => setError(e.message));
  }, [period]);

  return (
    <section className="space-y-4">
      <ErrorText error={error} />
      {data?.balance && (
        <Card className="!p-4">
          <p className="text-sm text-zinc-500">Comissão a receber</p>
          <p className="text-3xl font-bold tabular-nums">{money(data.balance.unpaid_cents)}</p>
          <p className="text-xs text-zinc-500">
            {data.balance.unpaid_items} item(ns){data.balance.since ? ` desde ${fmtDate(data.balance.since)}` : ''}
            {data.balance.lastPayout ? ` · último pagamento ${money(data.balance.lastPayout.amount_cents)} em ${fmtDate(data.balance.lastPayout.date)}` : ''}
          </p>
        </Card>
      )}
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => setPeriod(p)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${period.label === p.label ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:bg-zinc-100'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card className="!p-4">
              <p className="text-sm text-zinc-500">Sua parte no período</p>
              <p className="text-xl font-bold tabular-nums">{money(data.commission)}</p>
            </Card>
            <Card className="!p-4">
              <p className="text-sm text-zinc-500">Atendimentos</p>
              <p className="text-xl font-bold tabular-nums">{data.services}</p>
            </Card>
          </div>
          {data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500">Nada no período.</p>
          ) : (
            <Card className="!p-0">
              <ul className="divide-y divide-zinc-100 text-sm">
                {data.items.map((i, n) => (
                  <li key={n} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0">
                      <span className="block">
                        {i.qty > 1 ? `${i.qty}× ` : ''}
                        {i.name}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {fmtDate(i.date)} · {i.customer ?? 'avulso'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <b className="tabular-nums">{money(i.commission_cents)}</b>
                      {i.paid && <Badge tone="green">pago</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {data.payouts.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold">Pagamentos recebidos</p>
              <Card className="!p-0">
                <ul className="divide-y divide-zinc-100 text-sm">
                  {data.payouts.map((p) => (
                    <li key={p.id} className="flex justify-between px-4 py-2.5">
                      <span>
                        {fmtDate(p.date)} <span className="text-zinc-500">· comissões até {fmtDate(p.until_date)}</span>
                      </span>
                      <b className="tabular-nums">{money(p.amount_cents)}</b>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}
          <p className="text-xs text-zinc-500">Dúvidas sobre os pagamentos: fale com o dono da barbearia.</p>
        </>
      )}
    </section>
  );
}
