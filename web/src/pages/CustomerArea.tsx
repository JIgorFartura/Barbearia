import { ArrowLeft, CalendarCheck, CalendarX, Clock, Download, Gift, History, LogOut, Receipt, Repeat, Scissors, ShieldCheck, Ticket, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Section } from '../components/CustomerSection';
import { StampCard, type Progress } from '../components/StampCard';
import { ClubSection } from './CustomerClub';
import { Button, ErrorText, Field, Input, Modal, inputClass } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { WEEKDAYS, WEEKDAYS_SHORT, addDays, cap, dayLabel, hourLabel, money, phone as fmtPhone, stampLabel, todayStr, weekdayOf } from '../lib/format';

interface Brand {
  slug: string;
  name: string;
  tagline: string | null;
  primary_color: string;
  accent_color: string;
  logo_url: string | null;
  bot_name: string;
  whatsapp: string | null;
  connected: boolean;
  loggedIn: boolean;
}

interface Appointment {
  id: number;
  barber_name: string;
  service_name: string;
  price_cents: number;
  starts_at: string;
  status: 'scheduled' | 'cancelled' | 'no_show';
  items?: { catalog_item_id: number; name: string; qty: number }[];
}

interface Suggestion {
  items: { productId: number; name: string; qty: number }[];
  barber: string;
  question: string;
}

interface Habit {
  weekday: number;
  time: string;
  barberId: number | null;
  serviceId: number | null;
  intervalDays: number;
  source: 'cliente' | 'automatico';
}

interface Offer {
  id: number;
  title: string;
  description: string | null;
  partner: string | null;
  valid_days: number;
  canClaim: boolean;
  reason: string | null;
}

interface Voucher {
  id: number;
  code: string;
  title: string;
  partner: string | null;
  status: 'active' | 'used' | 'expired';
  expires_on: string;
}

interface MeData {
  customer: {
    id: number;
    name: string;
    phone: string;
    pref_weekday: number | null;
    pref_time: string | null;
    pref_barber_id: number | null;
    pref_service_id: number | null;
    pref_interval_days: number | null;
    reminders_opt_out: number;
    birth_date: string | null;
  };
  /** Já aceitou a política de privacidade da barbearia. */
  privacyAccepted: boolean;
  habit: Habit | null;
  upcoming: Appointment[];
  history: Appointment[];
  card: { id: number; name: string; unit_label: string; reward: string; progress: Progress }[];
  offers: Offer[];
  vouchers: Voucher[];
  purchases: { id: number; date: string; total_cents: number; items: { name: string; qty: number; total_cents: number }[] }[];
  barbers: { id: number; name: string }[];
  services: { id: number; name: string; price_cents: number; duration_min: number | null }[];
}

const firstName = (name: string) => name.split(/\s+/)[0];

/** Área logada do cliente: /b/:slug/conta. */
export function CustomerArea({ slug }: { slug: string }) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [me, setMe] = useState<MeData | 'anon' | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    api<MeData>('GET', `/api/customer/${slug}/me`).then(setMe, (e) => (e instanceof ApiError && e.status === 401 ? setMe('anon') : setNotFound(true)));
  }, [slug]);

  useEffect(() => {
    // Link de acesso enviado pelo robô: /b/:slug/conta?t=...
    const token = new URLSearchParams(location.search).get('t');
    if (token) history.replaceState(null, '', `/b/${slug}/conta`);
    const login = token ? api('POST', `/api/public/shops/${slug}/login/link`, { token }).catch(() => undefined) : Promise.resolve();
    login
      .then(() => api<Brand>('GET', `/api/public/shops/${slug}/brand`))
      .then(
        (b) => {
          setBrand(b);
          document.title = `${b.name} · Minha área`;
          if (b.loggedIn) load();
          else setMe('anon');
        },
        () => setNotFound(true),
      );
  }, [slug, load]);

  if (notFound) return <div className="flex min-h-screen items-center justify-center text-zinc-500">Barbearia não encontrada.</div>;
  if (!brand || !me) return null;

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="text-white" style={{ background: brand.primary_color }}>
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <a href={`/b/${slug}`} className="rounded-full p-1 hover:bg-white/10" aria-label="Voltar ao site">
            <ArrowLeft className="size-5" />
          </a>
          {brand.logo_url && <img src={brand.logo_url} alt="" className="size-9 rounded-lg bg-white object-contain p-0.5" />}
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">{brand.name}</p>
            <p className="text-xs opacity-80">Área do cliente</p>
          </div>
          {me !== 'anon' && (
            <button
              className="flex items-center gap-1 text-sm opacity-90 hover:opacity-100"
              onClick={() => api('POST', `/api/customer/${slug}/logout`).then(() => setMe('anon'))}
            >
              <LogOut className="size-4" /> Sair
            </button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        {me === 'anon' ? <Login slug={slug} brand={brand} onDone={load} /> : <Dashboard slug={slug} brand={brand} me={me} reload={load} />}
      </main>
    </div>
  );
}

function Login({ slug, brand, onDone }: { slug: string; brand: Brand; onDone: () => void }) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phoneValue, setPhone] = useState('');
  const [name, setName] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [accept, setAccept] = useState(false);
  const [code, setCode] = useState('');
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ demoCode?: string; needsName?: boolean }>('POST', `/api/public/shops/${slug}/login/code`, {
        phone: phoneValue,
        name: needsName ? name : undefined,
        accept: needsName ? accept : undefined,
      });
      // Número novo: pede o nome e o aceite da política para criar a conta.
      if (r.needsName) {
        setNeedsName(true);
        return;
      }
      setDemoCode(r.demoCode ?? null);
      setStep('code');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/public/shops/${slug}/login/verify`, { phone: phoneValue, code });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const accentButton = { background: brand.accent_color, color: '#09090b' };

  return (
    <div className="mx-auto max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
      <div>
        <h1 className="text-xl font-bold">Entre com seu celular</h1>
        <p className="text-sm text-zinc-500">
          Agende, acompanhe seu cartão fidelidade e pegue vouchers. {brand.connected ? `O ${brand.bot_name} manda um código no seu WhatsApp.` : ''}
        </p>
      </div>
      {step === 'phone' ? (
        <form onSubmit={requestCode} className="space-y-4">
          <Field label="Celular com DDD">
            <Input type="tel" inputMode="tel" autoComplete="tel" required placeholder="(11) 98888-7777" value={phoneValue} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          {needsName && (
            <>
              <Field label="Seu nome" hint="Primeira vez por aqui: vamos criar sua conta.">
                <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <label className="flex items-start gap-2 text-sm text-zinc-600">
                <input type="checkbox" required className="mt-0.5 size-4 shrink-0 accent-zinc-900" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                <span>
                  Li e aceito a{' '}
                  <a href={`/b/${slug}/privacidade`} target="_blank" rel="noreferrer" className="font-medium text-zinc-900 underline">
                    política de privacidade
                  </a>{' '}
                  da {brand.name}.
                </span>
              </label>
            </>
          )}
          <ErrorText error={error} />
          <Button type="submit" loading={busy} className="w-full" style={accentButton}>
            {brand.connected ? 'Receber código no WhatsApp' : 'Continuar'}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-4">
          <p className="text-sm text-zinc-600">
            {demoCode ? 'Digite o código de acesso.' : `Enviamos um código para o WhatsApp ${fmtPhone(phoneValue)}.`}
          </p>
          {demoCode && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Modo demonstração (WhatsApp da barbearia não conectado): seu código é <b className="tracking-widest">{demoCode}</b>
            </p>
          )}
          <Field label="Código de 6 dígitos">
            <Input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center text-2xl tracking-[0.5em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <ErrorText error={error} />
          <Button type="submit" loading={busy} className="w-full" style={accentButton}>
            Entrar
          </Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="text-zinc-500 hover:text-zinc-900" onClick={() => setStep('phone')}>
              Trocar número
            </button>
            <button type="button" className="text-zinc-500 hover:text-zinc-900" onClick={() => requestCode()}>
              Reenviar código
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Dashboard({ slug, brand, me, reload }: { slug: string; brand: Brand; me: MeData; reload: () => void }) {
  const [booking, setBooking] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accent = { background: brand.accent_color, color: '#09090b' };
  const habit = me.habit;
  const habitBarber = habit?.barberId ? me.barbers.find((b) => b.id === habit.barberId)?.name : null;
  const activeVouchers = me.vouchers.filter((v) => v.status === 'active');

  async function cancelAppt(a: Appointment) {
    if (!confirm(`Cancelar ${stampLabel(a.starts_at)} com ${a.barber_name}?`)) return;
    setError(null);
    await api('POST', `/api/customer/${slug}/appointments/${a.id}/cancel`).catch((e) => setError(e.message));
    reload();
  }

  async function claim(o: Offer) {
    setError(null);
    try {
      setVoucher(await api<Voucher>('POST', `/api/customer/${slug}/offers/${o.id}/claim`));
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Olá, {firstName(me.customer.name)}! 👊</h1>
        <p className="text-sm text-zinc-500">Bem-vindo à comunidade {brand.name}.</p>
      </div>
      <ErrorText error={error} />
      {!me.privacyAccepted && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-sky-50 px-4 py-3 text-sm text-sky-950 ring-1 ring-sky-200">
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              Veja como a {brand.name} cuida dos seus dados na{' '}
              <a href={`/b/${slug}/privacidade`} target="_blank" rel="noreferrer" className="font-medium underline">
                política de privacidade
              </a>
              .
            </span>
          </p>
          <Button className="!py-1.5" style={accent} onClick={() => api('POST', `/api/customer/${slug}/privacy/accept`).then(reload, (e) => setError(e.message))}>
            Li e aceito
          </Button>
        </div>
      )}

      <Section
        icon={<CalendarCheck />}
        title="Meus horários"
        action={
          me.barbers.length > 0 && (
            <Button className="!py-1.5" style={accent} onClick={() => setBooking(true)}>
              Agendar
            </Button>
          )
        }
      >
        {me.upcoming.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhum horário marcado. {me.barbers.length ? 'Que tal agendar agora?' : ''}</p>
        ) : (
          <ul className="space-y-2">
            {me.upcoming.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 px-4 py-3">
                <div>
                  <p className="font-semibold">{cap(stampLabel(a.starts_at))}</p>
                  <p className="text-sm text-zinc-500">
                    {a.service_name} com {a.barber_name} · {money(a.price_cents)}
                  </p>
                  {a.items && a.items.length > 0 && (
                    <p className="text-xs text-amber-800">🍺 Separado pra você: {a.items.map((i) => `${i.qty} ${i.name.toLowerCase()}`).join(', ')}</p>
                  )}
                </div>
                <button onClick={() => cancelAppt(a)} className="flex items-center gap-1 text-sm text-red-600 hover:underline">
                  <CalendarX className="size-4" /> Cancelar
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        icon={<Repeat />}
        title="Meu horário de costume"
        action={
          <button className="text-sm font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setPrefs(true)}>
            Ajustar
          </button>
        }
      >
        {habit ? (
          <p className="text-sm">
            Você costuma vir <b>{WEEKDAYS[habit.weekday]}</b> às <b>{hourLabel(habit.time)}</b>
            {habitBarber && <> com <b>{habitBarber}</b></>}, {habit.intervalDays === 7 ? 'toda semana' : `a cada ${habit.intervalDays} dias`}.
            <span className="text-zinc-500"> {habit.source === 'automatico' ? '(descobrimos pelo seu histórico)' : '(você informou)'}</span>
          </p>
        ) : (
          <p className="text-sm text-zinc-500">Conte quando você costuma vir e o {brand.bot_name} te lembra no WhatsApp, oferecendo o seu horário de sempre.</p>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          {me.customer.reminders_opt_out
            ? `Lembretes automáticos desligados.`
            : `O ${brand.bot_name} manda a sugestão de horário no começo da semana e um lembrete antes de cada horário.`}
        </p>
      </Section>

      <ClubSection slug={slug} accent={brand.accent_color} />

      {me.card.length > 0 && (
        <Section icon={<Gift />} title="Cartão fidelidade">
          <div className="space-y-4">
            {me.card.map((c) => (
              <StampCard key={c.id} name={c.name} unit={c.unit_label} reward={c.reward} progress={c.progress} accent={brand.accent_color} />
            ))}
          </div>
        </Section>
      )}

      {(me.offers.length > 0 || activeVouchers.length > 0) && (
        <Section icon={<Ticket />} title="Benefícios">
          {activeVouchers.length > 0 && (
            <div className="mb-4 space-y-2">
              {activeVouchers.map((v) => (
                <button key={v.id} onClick={() => setVoucher(v)} className="flex w-full items-center justify-between rounded-xl border-2 border-dashed px-4 py-3 text-left" style={{ borderColor: brand.accent_color }}>
                  <span className="min-w-0">
                    <span className="block font-semibold">{v.title}</span>
                    <span className="text-xs text-zinc-500">Válido até {v.expires_on.split('-').reverse().join('/')}</span>
                  </span>
                  <span className="font-mono font-bold tracking-wider whitespace-nowrap">{v.code}</span>
                </button>
              ))}
            </div>
          )}
          <ul className="space-y-2">
            {me.offers.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 px-4 py-3">
                <div>
                  <p className="font-semibold">{o.title}</p>
                  {o.description && <p className="text-sm text-zinc-500">{o.description}</p>}
                  {o.partner && <p className="text-xs text-zinc-400">Parceiro: {o.partner}</p>}
                </div>
                {o.canClaim ? (
                  <Button className="!py-1.5 whitespace-nowrap" style={accent} onClick={() => claim(o)}>
                    Pegar voucher
                  </Button>
                ) : (
                  <span className="text-xs whitespace-nowrap text-zinc-400">{o.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {me.purchases.length > 0 && (
        <Section icon={<Receipt />} title="Minhas compras">
          <ul className="divide-y divide-zinc-100 text-sm">
            {me.purchases.map((p) => (
              <li key={p.id} className="flex justify-between gap-3 py-2">
                <span>
                  <span className="text-zinc-500">{p.date.split('-').reverse().join('/')}</span> · {p.items.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ''}${i.name}`).join(', ')}
                </span>
                <span className="font-medium whitespace-nowrap tabular-nums">{money(p.total_cents)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {me.history.length > 0 && (
        <Section icon={<History />} title="Histórico">
          <ul className="divide-y divide-zinc-100 text-sm">
            {me.history.map((a) => (
              <li key={a.id} className="flex justify-between py-2">
                <span>{cap(stampLabel(a.starts_at))}</span>
                <span className="text-zinc-500">
                  {a.status === 'cancelled' ? 'Cancelado' : a.status === 'no_show' ? 'Faltou' : `${a.service_name} · ${a.barber_name}`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section icon={<ShieldCheck />} title="Meus dados">
        <p className="text-sm text-zinc-500">
          Seus dados seguem a{' '}
          <a href={`/b/${slug}/privacidade`} target="_blank" rel="noreferrer" className="font-medium text-zinc-700 underline">
            política de privacidade
          </a>{' '}
          da {brand.name}.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={`/api/customer/${slug}/my-data`}
            download
            className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-100"
          >
            <Download className="size-4" /> Baixar meus dados
          </a>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            <Trash2 className="size-4" /> Excluir minha conta
          </Button>
        </div>
      </Section>

      {deleting && <DeleteAccountModal slug={slug} shopName={brand.name} onClose={() => setDeleting(false)} />}
      {booking && (
        <BookingModal
          slug={slug}
          me={me}
          accent={brand.accent_color}
          onClose={() => setBooking(false)}
          onDone={() => {
            setBooking(false);
            reload();
          }}
        />
      )}
      {prefs && (
        <PrefsModal
          slug={slug}
          me={me}
          botName={brand.bot_name}
          onClose={() => setPrefs(false)}
          onDone={() => {
            setPrefs(false);
            reload();
          }}
        />
      )}
      {voucher && (
        <Modal title="Seu voucher" onClose={() => setVoucher(null)}>
          <div className="space-y-3 text-center">
            <p className="font-semibold">{voucher.title}</p>
            <p className="rounded-2xl border-2 border-dashed py-6 font-mono text-3xl font-extrabold tracking-widest" style={{ borderColor: brand.accent_color }}>
              {voucher.code}
            </p>
            <p className="text-sm text-zinc-500">
              Mostre este código no balcão{voucher.partner ? ` ou no parceiro ${voucher.partner}` : ''}. Válido até {voucher.expires_on.split('-').reverse().join('/')}.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Exclui a conta: apaga os dados pessoais (a barbearia mantém só as vendas, sem identificação). */
function DeleteAccountModal({ slug, shopName, onClose }: { slug: string; shopName: string; onClose: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Excluir minha conta" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Vamos apagar seu nome, celular, mensagens, cartão fidelidade, vouchers e horários futuros na {shopName}. As compras ficam no caixa da barbearia, sem
          identificar você, porque a lei exige. Isso não pode ser desfeito.
        </p>
        <Field label="Para confirmar, digite EXCLUIR">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} />
        </Field>
        <ErrorText error={error} />
        <Button
          variant="danger"
          className="w-full"
          loading={busy}
          disabled={confirm !== 'EXCLUIR'}
          onClick={() => {
            setBusy(true);
            api('POST', `/api/customer/${slug}/delete-account`, { confirm })
              .then(() => location.assign(`/b/${slug}`))
              .catch((e) => {
                setError(e.message);
                setBusy(false);
              });
          }}
        >
          Excluir definitivamente
        </Button>
      </div>
    </Modal>
  );
}

function BookingModal({ slug, me, accent, onClose, onDone }: { slug: string; me: MeData; accent: string; onClose: () => void; onDone: () => void }) {
  const defaultService = me.services.find((s) => /^corte/i.test(s.name)) ?? me.services[0];
  const [serviceId, setServiceId] = useState<number | null>(defaultService?.id ?? null);
  const [barberId, setBarberId] = useState<number | null>(me.habit?.barberId ?? null);
  const [date, setDate] = useState(() => {
    let d = todayStr();
    for (let i = 0; i < 7 && weekdayOf(d) === 0; i++) d = addDays(d, 1);
    return d;
  });
  const [slots, setSlots] = useState<{ barber: { id: number; name: string }; times: string[] }[] | null>(null);
  const [choice, setChoice] = useState<{ time: string; barberId: number; barberName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(todayStr(), i)), []);

  useEffect(() => {
    setSlots(null);
    setChoice(null);
    const q = new URLSearchParams({ date, ...(barberId ? { barber_id: String(barberId) } : {}), ...(serviceId ? { service_id: String(serviceId) } : {}) });
    api<typeof slots>('GET', `/api/customer/${slug}/availability?${q}`).then(setSlots, (e) => setError(e.message));
  }, [slug, date, barberId, serviceId]);

  // Sem preferência de barbeiro: cada horário fica com o primeiro barbeiro livre.
  const times = useMemo(() => {
    const map = new Map<string, { barberId: number; barberName: string }>();
    for (const d of slots ?? []) for (const t of d.times) if (!map.has(t)) map.set(t, { barberId: d.barber.id, barberName: d.barber.name });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [slots]);

  const [booked, setBooked] = useState<{ id: number; suggestion: Suggestion | null } | null>(null);

  async function confirmBooking() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const a = await api<{ id: number; suggestion: Suggestion | null }>('POST', `/api/customer/${slug}/appointments`, {
        barber_id: choice.barberId,
        service_id: serviceId,
        date,
        time: choice.time,
      });
      // Se ele costuma tomar algo (ex.: uma cerveja), pergunta se pode avisar o barbeiro.
      if (a.suggestion) setBooked(a);
      else onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (booked?.suggestion) {
    const s = booked.suggestion;
    return (
      <Modal title="Horário marcado! ✅" onClose={onDone}>
        <div className="space-y-4">
          <p className="text-sm text-zinc-600">
            {dayLabel(date)} às {hourLabel(choice!.time)} com {choice!.barberName}.
          </p>
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-amber-950">
            🍺 Quer que o {s.barber} deixe {s.items.map((i) => `${i.qty} ${i.name.toLowerCase()}`).join(' e ')} separado pra você?
          </p>
          <ErrorText error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={onDone}>
              Não, obrigado
            </Button>
            <Button
              loading={busy}
              style={{ background: accent, color: '#09090b' }}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('POST', `/api/customer/${slug}/appointments/${booked.id}/items`, { items: s.items.map((i) => ({ product_id: i.productId, qty: i.qty })) });
                  onDone();
                } catch (err) {
                  setError((err as Error).message);
                  setBusy(false);
                }
              }}
            >
              Sim, pode avisar
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Agendar horário" onClose={onClose}>
      <div className="space-y-4">
        {me.services.length > 0 && (
          <Field label="Serviço">
            <select className={inputClass} value={serviceId ?? ''} onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}>
              {me.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {money(s.price_cents)}
                  {s.duration_min ? ` · ${s.duration_min} min` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-700">Barbeiro</p>
          <div className="flex flex-wrap gap-2">
            {[{ id: null as number | null, name: 'Qualquer um' }, ...me.barbers].map((b) => (
              <button
                key={b.id ?? 0}
                onClick={() => setBarberId(b.id)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${barberId === b.id ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-700">Dia</p>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {days.map((d) => (
              <button
                key={d}
                onClick={() => setDate(d)}
                className={`flex min-w-14 flex-col items-center rounded-xl px-2 py-2 text-sm ring-1 ${date === d ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
              >
                <span className="text-xs uppercase opacity-70">{WEEKDAYS_SHORT[weekdayOf(d)]}</span>
                <span className="font-bold">{d.slice(8, 10)}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 flex items-center gap-1 text-sm font-medium text-zinc-700">
            <Clock className="size-4" /> Horários livres · {dayLabel(date)}
          </p>
          {slots === null ? (
            <p className="text-sm text-zinc-400">Carregando...</p>
          ) : times.length === 0 ? (
            <p className="text-sm text-zinc-500">Nenhum horário livre nesse dia. Tente outro dia ou outro barbeiro.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {times.map(([t, b]) => (
                <button
                  key={t}
                  onClick={() => setChoice({ time: t, ...b })}
                  className={`rounded-lg py-2 text-sm font-semibold ring-1 ${choice?.time === t ? 'text-zinc-950 ring-transparent' : 'ring-zinc-200 hover:bg-zinc-100'}`}
                  style={choice?.time === t ? { background: accent } : undefined}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
        <ErrorText error={error} />
        <Button className="w-full" disabled={!choice} loading={busy} onClick={confirmBooking}>
          <Scissors className="size-4" />
          {choice ? `Confirmar ${dayLabel(date)} às ${hourLabel(choice.time)} com ${choice.barberName}` : 'Escolha um horário'}
        </Button>
      </div>
    </Modal>
  );
}

function PrefsModal({ slug, me, botName, onClose, onDone }: { slug: string; me: MeData; botName: string; onClose: () => void; onDone: () => void }) {
  const c = me.customer;
  const [form, setForm] = useState({
    name: c.name,
    pref_weekday: c.pref_weekday ?? me.habit?.weekday ?? null,
    pref_time: c.pref_time ?? me.habit?.time ?? '',
    pref_barber_id: c.pref_barber_id ?? me.habit?.barberId ?? null,
    pref_service_id: c.pref_service_id ?? null,
    pref_interval_days: c.pref_interval_days ?? me.habit?.intervalDays ?? 7,
    reminders: !c.reminders_opt_out,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const hasHabit = form.pref_weekday != null && form.pref_time;
    try {
      await api('PUT', `/api/customer/${slug}/preferences`, {
        name: form.name,
        pref_weekday: hasHabit ? form.pref_weekday : null,
        pref_time: hasHabit ? form.pref_time : null,
        pref_barber_id: hasHabit ? form.pref_barber_id : null,
        pref_service_id: hasHabit ? form.pref_service_id : null,
        pref_interval_days: hasHabit ? form.pref_interval_days : null,
        reminders_opt_out: !form.reminders,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Meu horário de costume" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Seu nome">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Costumo ir">
            <select
              className={inputClass}
              value={form.pref_weekday ?? ''}
              onChange={(e) => setForm({ ...form, pref_weekday: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">— não sei —</option>
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Por volta de">
            <Input type="time" step={900} value={form.pref_time} onChange={(e) => setForm({ ...form, pref_time: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Com">
            <select
              className={inputClass}
              value={form.pref_barber_id ?? ''}
              onChange={(e) => setForm({ ...form, pref_barber_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Qualquer barbeiro</option>
              {me.barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Frequência">
            <select className={inputClass} value={form.pref_interval_days} onChange={(e) => setForm({ ...form, pref_interval_days: Number(e.target.value) })}>
              <option value={7}>Toda semana</option>
              <option value={14}>A cada 15 dias</option>
              <option value={21}>A cada 3 semanas</option>
              <option value={30}>Uma vez por mês</option>
            </select>
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-zinc-900" checked={form.reminders} onChange={(e) => setForm({ ...form, reminders: e.target.checked })} />
          <span>
            Quero que o {botName} me lembre no WhatsApp e ofereça meu horário de sempre.
            <span className="block text-xs text-zinc-500">O lembrete dos horários já marcados continua chegando.</span>
          </span>
        </label>
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
