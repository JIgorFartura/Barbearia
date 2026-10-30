import { ArrowLeft, CalendarCheck, CalendarX, Camera, Clock, Download, Gift, History, LogOut, PackageCheck, Receipt, Repeat, Scissors, ShieldCheck, Ticket, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Section } from '../components/CustomerSection';
import { StampCard, type Progress } from '../components/StampCard';
import { ClubSection } from './CustomerClub';
import { BirthdaySection, ReferralSection } from './CustomerGrowth';
import { FeaturedAds, PartnersSection, StoreSection, useVitrine } from './CustomerStore';
import type { ReceiptInfo } from '../components/Receipt';
import { PhotoThumb, photoDate, type CutPhoto } from '../components/Profile';
import { AppSection } from '../components/AppInstall';
import { Button, ErrorText, Field, Input, Modal, inputClass } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { methodLabel } from '../lib/finance';
import { WEEKDAYS, WEEKDAYS_SHORT, addDays, cap, dayLabel, hourLabel, money, phone as fmtPhone, promoLabel, stampLabel, todayStr, weekdayOf } from '../lib/format';

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
  barber_id?: number;
  service_id?: number | null;
  barber_name: string;
  service_name: string;
  price_cents: number;
  starts_at: string;
  status: 'scheduled' | 'cancelled' | 'no_show';
  items?: { catalog_item_id: number; name: string; qty: number }[];
  /** Presença confirmada (pelo lembrete, aqui ou pela barbearia). */
  confirmed_at?: string | null;
  /** Desconto do horário vazio ou de volta (o preço já sai com ele). */
  promo_percent?: number | null;
  promo_kind?: 'vazio' | 'volta' | null;
}

type Period = 'qualquer' | 'manha' | 'tarde' | 'noite';
const PERIOD_LABEL: Record<Period, string> = { qualquer: 'qualquer horário', manha: 'de manhã', tarde: 'à tarde', noite: 'à noite' };

/** Dia em que ele está na lista de espera (o robô avisa no WhatsApp quando abrir vaga). */
interface WaitEntry {
  id: number;
  date: string;
  period: Period;
  barber_id: number | null;
  barber_name: string | null;
  service_name: string | null;
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

/** Um pagamento dele à barbearia: compra (balcão ou atendimento) ou mensalidade do clube. */
interface Payment {
  kind: 'compra' | 'clube';
  id: number;
  date: string;
  description: string;
  amount_cents: number;
  method: string | null;
  status: 'open' | 'claimed' | 'paid';
  /** Pago no cartão pela Cielo (automático). */
  card: boolean;
  receipt: ReceiptInfo | null;
  /** PDF da nota fiscal de serviço (quando a barbearia emite). */
  nfse_url: string | null;
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
  waitlist: WaitEntry[];
  history: Appointment[];
  /** Fotos dos cortes tiradas na barbearia. */
  photos: CutPhoto[];
  /** Desconto de volta (a barbearia mandou pelo recontato): entra sozinho no próximo horário. */
  comeback: { percent: number; valid_until: string } | null;
  /** Pacotes pré-pagos (os valendo e os dos últimos meses). */
  packages: { id: number; name: string; service_name: string | null; uses: number; used: number; left: number; expires_on: string; status: 'active' | 'used' | 'expired' | 'cancelled' }[];
  card: { id: number; name: string; unit_label: string; reward: string; progress: Progress }[];
  offers: Offer[];
  vouchers: Voucher[];
  /** Só os pagamentos dele: compras e clube. */
  payments: Payment[];
  /** Indique um amigo (null = a barbearia não ligou). */
  referral: { code: string; link: string; friend_gift: string | null; my_prize: string | null; joined: number; came: number } | null;
  birthday: { enabled: boolean; gift: string | null; value: string | null };
  barbers: { id: number; name: string }[];
  services: { id: number; name: string; price_cents: number; duration_min: number | null }[];
}

const firstName = (name: string) => name.split(/\s+/)[0];

/** Agendar já com o serviço, o barbeiro, o dia e a hora escolhidos (repetir o último corte). */
interface BookingPreset {
  serviceId?: number | null;
  barberId?: number | null;
  date?: string;
  time?: string;
}

/**
 * O último corte para repetir: mesmo serviço e mesmo barbeiro, no dia em que ele costuma voltar (o corte
 * mais o ritmo dele) ou no próximo dia útil. Mostra a foto do corte, se a barbearia tirou.
 */
function lastCutPreset(me: MeData): { appt: Appointment; preset: BookingPreset; photo: CutPhoto | null } | null {
  const appt = me.history.find((a) => a.status === 'scheduled');
  if (!appt) return null;
  const today = todayStr();
  let date: string | undefined;
  const interval = me.habit?.intervalDays;
  if (interval) {
    const due = addDays(appt.starts_at.slice(0, 10), interval);
    if (due >= today && due <= addDays(today, 13) && weekdayOf(due) !== 0) date = due;
  }
  const photo = me.photos.find((p) => p.created_at.slice(0, 10) >= appt.starts_at.slice(0, 10)) ?? null;
  return { appt, preset: { serviceId: appt.service_id ?? null, barberId: appt.barber_id ?? null, date, time: appt.starts_at.slice(11, 16) }, photo };
}

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
  // Veio pelo link de um amigo (?indicacao=CÓDIGO): mostra quem indicou e o presente.
  const referral = useMemo(() => new URLSearchParams(location.search).get('indicacao'), []);
  const [referrer, setReferrer] = useState<{ name: string; gift: string | null } | null>(null);
  useEffect(() => {
    if (referral) api<{ name: string; gift: string | null }>('GET', `/api/public/shops/${slug}/referral/${encodeURIComponent(referral)}`).then(setReferrer, () => undefined);
  }, [slug, referral]);

  async function requestCode(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ demoCode?: string; needsName?: boolean }>('POST', `/api/public/shops/${slug}/login/code`, {
        phone: phoneValue,
        name: needsName ? name : undefined,
        accept: needsName ? accept : undefined,
        referral: needsName && referrer ? referral : undefined,
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
      {referrer && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200">
          🙌 <b>{referrer.name}</b> te indicou!{referrer.gift ? ` Crie sua conta e ganhe ${referrer.gift}.` : ''}
        </p>
      )}
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
  /** Agendar (com o serviço, o barbeiro e o dia já escolhidos, no "repetir o último corte"). */
  const [booking, setBooking] = useState<false | BookingPreset>(false);
  const [prefs, setPrefs] = useState(false);
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accent = { background: brand.accent_color, color: '#09090b' };
  const habit = me.habit;
  const habitBarber = habit?.barberId ? me.barbers.find((b) => b.id === habit.barberId)?.name : null;
  const activeVouchers = me.vouchers.filter((v) => v.status === 'active');
  const repeat = me.upcoming.length === 0 && me.barbers.length > 0 ? lastCutPreset(me) : null;
  const vitrine = useVitrine(slug);

  async function cancelAppt(a: Appointment) {
    if (!confirm(`Cancelar ${stampLabel(a.starts_at)} com ${a.barber_name}?`)) return;
    setError(null);
    await api('POST', `/api/customer/${slug}/appointments/${a.id}/cancel`).catch((e) => setError(e.message));
    reload();
  }

  async function confirmAppt(a: Appointment) {
    setError(null);
    await api('POST', `/api/customer/${slug}/appointments/${a.id}/confirm`).then(reload, (e) => setError(e.message));
  }

  async function leaveWait(w: WaitEntry) {
    setError(null);
    await api('DELETE', `/api/customer/${slug}/waitlist/${w.id}`).then(reload, (e) => setError(e.message));
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
      {vitrine && <FeaturedAds ads={vitrine.ads} />}
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

      {me.comeback && me.upcoming.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-950 ring-1 ring-emerald-200">
          <p className="flex items-start gap-2">
            <Gift className="mt-0.5 size-4 shrink-0" />
            <span>
              Que bom te ver! Você tem <b>{me.comeback.percent}% de desconto</b> no próximo horário, marcando até{' '}
              {me.comeback.valid_until.slice(8, 10)}/{me.comeback.valid_until.slice(5, 7)}. O desconto entra sozinho.
            </span>
          </p>
          {me.barbers.length > 0 && (
            <Button className="!py-1.5" style={accent} onClick={() => setBooking({})}>
              Agendar com desconto
            </Button>
          )}
        </div>
      )}

      <Section
        icon={<CalendarCheck />}
        title="Meus horários"
        action={
          me.barbers.length > 0 && (
            <Button className="!py-1.5" style={accent} onClick={() => setBooking({})}>
              Agendar
            </Button>
          )
        }
      >
        {me.upcoming.length === 0 && me.waitlist.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhum horário marcado. {me.barbers.length ? 'Que tal agendar agora?' : ''}</p>
        ) : (
          <ul className="space-y-2">
            {me.upcoming.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 px-4 py-3">
                <div>
                  <p className="font-semibold">{cap(stampLabel(a.starts_at))}</p>
                  <p className="text-sm text-zinc-500">
                    {a.service_name} com {a.barber_name} · {money(a.price_cents)}
                    {a.promo_percent ? (
                      <span className="font-medium text-emerald-700">
                        {' '}
                        (−{a.promo_percent}% {promoLabel(a.promo_kind)})
                      </span>
                    ) : null}
                  </p>
                  {a.items && a.items.length > 0 && (
                    <p className="text-xs text-amber-800">🛍️ Separado pra você: {a.items.map((i) => `${i.qty} ${i.name.toLowerCase()}`).join(', ')}</p>
                  )}
                  {a.confirmed_at ? (
                    <p className="text-xs font-medium text-emerald-700">✓ Presença confirmada</p>
                  ) : (
                    <button className="mt-1 rounded-md px-2 py-0.5 text-xs font-semibold" style={accent} onClick={() => confirmAppt(a)}>
                      Confirmar presença
                    </button>
                  )}
                </div>
                <button onClick={() => cancelAppt(a)} className="flex items-center gap-1 text-sm text-red-600 hover:underline">
                  <CalendarX className="size-4" /> Cancelar
                </button>
              </li>
            ))}
            {me.waitlist.map((w) => (
              <li key={`w${w.id}`} className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 ring-1 ring-amber-200">
                <div>
                  <p className="font-semibold">⏳ Lista de espera · {cap(dayLabel(w.date))}</p>
                  <p className="text-sm text-zinc-500">
                    {cap(PERIOD_LABEL[w.period])}
                    {w.barber_name ? ` com ${w.barber_name}` : ', qualquer barbeiro'}. Abriu vaga, o {brand.bot_name} te avisa no WhatsApp.
                  </p>
                </div>
                <button onClick={() => leaveWait(w)} className="shrink-0 text-sm text-zinc-500 hover:text-red-600">
                  Sair
                </button>
              </li>
            ))}
          </ul>
        )}
        {repeat && (
          <div className="mt-3 flex items-center gap-3 rounded-xl p-3 ring-1 ring-zinc-200">
            {repeat.photo ? (
              <PhotoThumb url={`/api/customer/${slug}/photos/${repeat.photo.id}`} photo={repeat.photo} className="size-14" />
            ) : (
              <Scissors className="size-5 shrink-0 text-zinc-400" />
            )}
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold">Repetir o último corte</p>
              <p className="text-zinc-500">
                {repeat.appt.service_name} com {repeat.appt.barber_name} · {repeat.appt.starts_at.slice(8, 10)}/{repeat.appt.starts_at.slice(5, 7)}
              </p>
            </div>
            <Button className="!py-1.5" style={accent} onClick={() => setBooking(repeat.preset)}>
              Repetir
            </Button>
          </div>
        )}
      </Section>

      {vitrine && (
        <StoreSection
          slug={slug}
          products={vitrine.products}
          next={me.upcoming[0] ?? null}
          accent={brand.accent_color}
          onBook={() => me.barbers.length > 0 && setBooking({})}
          onReserved={reload}
        />
      )}

      <AppSection slug={slug} shopName={brand.name} accent={brand.accent_color} />

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

      <ClubSection slug={slug} accent={brand.accent_color} onPaid={reload} />
      {me.packages.length > 0 && (
        <Section icon={<PackageCheck />} title="Meus pacotes">
          <ul className="space-y-3">
            {me.packages.map((p) => (
              <li key={p.id} className={p.status === 'active' ? '' : 'opacity-60'}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <b>{p.name}</b>
                  <span className="text-zinc-500">
                    {p.status === 'active'
                      ? `${p.left} de ${p.uses} sobrando · até ${p.expires_on.slice(8, 10)}/${p.expires_on.slice(5, 7)}/${p.expires_on.slice(0, 4)}`
                      : p.status === 'used'
                        ? 'todos usados'
                        : p.status === 'expired'
                          ? 'venceu'
                          : 'cancelado'}
                  </span>
                </div>
                <div className="mt-1 flex gap-1" aria-hidden>
                  {Array.from({ length: p.uses }, (_, i) => (
                    <span key={i} className="h-2 flex-1 rounded-full" style={{ background: i < p.used ? '#e4e4e7' : brand.accent_color }} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">Na hora de pagar, o barbeiro marca “pelo pacote” e o uso sai daqui.</p>
        </Section>
      )}
      {me.referral && <ReferralSection referral={me.referral} shopName={brand.name} accent={brand.accent_color} />}
      {me.birthday.enabled && <BirthdaySection slug={slug} birthday={me.birthday} onSaved={reload} />}

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

      {vitrine && <PartnersSection partners={vitrine.partners} ads={vitrine.ads} />}

      {me.payments.length > 0 && <PaymentsSection slug={slug} payments={me.payments} />}

      {me.photos.length > 0 && <CutsSection slug={slug} photos={me.photos} onDeleted={reload} />}

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
          preset={booking}
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
const PAYMENT_STATUS: Record<Payment['status'], { label: string; className: string }> = {
  paid: { label: 'Pago', className: 'bg-emerald-100 text-emerald-800' },
  claimed: { label: 'A barbearia está conferindo', className: 'bg-amber-100 text-amber-900' },
  open: { label: 'Em aberto', className: 'bg-red-100 text-red-800' },
};

/** Meus pagamentos: só o que ele pagou (ou tem para pagar) à barbearia, com o comprovante que mandou. */
/** Fotos dos cortes: para mostrar no próximo horário e repetir (ou apagar, se não quiser guardar). */
function CutsSection({ slug, photos, onDeleted }: { slug: string; photos: CutPhoto[]; onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function remove(p: CutPhoto) {
    if (!confirm('Apagar esta foto? A barbearia também deixa de ver.')) return;
    setError(null);
    await api('DELETE', `/api/customer/${slug}/photos/${p.id}`).then(onDeleted, (e) => setError(e.message));
  }
  return (
    <Section icon={<Camera />} title="Meus cortes">
      <p className="mb-3 text-sm text-zinc-500">Fotos que a barbearia tirou no fim do corte. Toque para ampliar e mostre no próximo horário para repetir.</p>
      <ErrorText error={error} />
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {photos.map((p) => (
          <li key={p.id} className="min-w-0 text-xs text-zinc-500">
            <PhotoThumb url={`/api/customer/${slug}/photos/${p.id}`} photo={p} className="aspect-square w-full" />
            <p className="mt-1 flex items-center justify-between gap-1">
              <span className="truncate">
                {photoDate(p.created_at)}
                {p.barber_name ? ` · ${firstName(p.barber_name)}` : ''}
              </span>
              <button type="button" className="shrink-0 text-zinc-400 hover:text-red-600" onClick={() => remove(p)} aria-label="Apagar foto">
                <Trash2 className="size-3.5" />
              </button>
            </p>
            {p.note && <p className="line-clamp-2 text-zinc-600">{p.note}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PaymentsSection({ slug, payments }: { slug: string; payments: Payment[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? payments : payments.slice(0, 6);
  return (
    <Section icon={<Receipt />} title="Meus pagamentos">
      <ul className="divide-y divide-zinc-100 text-sm">
        {shown.map((p) => {
          const st = PAYMENT_STATUS[p.status];
          return (
            <li key={`${p.kind}${p.id}`} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="font-medium">{p.description}</p>
                <p className="text-xs text-zinc-500">
                  {p.status === 'paid' ? '' : 'Vence '}
                  {p.date.split('-').reverse().join('/')}
                  {p.kind === 'clube' && p.status === 'paid' && ` · ${p.card ? 'Cartão automático' : methodLabel(p.method)}`}
                  {p.kind === 'compra' && ` · ${methodLabel(p.method)}`}
                </p>
                {p.receipt && (
                  <a href={`/api/customer/${slug}/charges/${p.id}/receipt`} target="_blank" rel="noreferrer" className="text-xs font-medium text-zinc-700 underline">
                    Ver comprovante
                  </a>
                )}
                {p.nfse_url && (
                  <a href={p.nfse_url} target="_blank" rel="noreferrer" className="ml-3 text-xs font-medium text-zinc-700 underline">
                    Nota fiscal
                  </a>
                )}
                {p.status === 'open' && (
                  <a href="#clube" className="text-xs font-medium text-zinc-700 underline">
                    Pagar ou enviar o comprovante
                  </a>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums">{money(p.amount_cents)}</p>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.className}`}>{st.label}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {payments.length > shown.length && (
        <button className="mt-1 text-sm font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setAll(true)}>
          Ver todos
        </button>
      )}
    </Section>
  );
}

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

function BookingModal({
  slug,
  me,
  preset,
  accent,
  onClose,
  onDone,
}: {
  slug: string;
  me: MeData;
  preset: BookingPreset;
  accent: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const defaultService = me.services.find((s) => /^corte/i.test(s.name)) ?? me.services[0];
  const [serviceId, setServiceId] = useState<number | null>(
    preset.serviceId && me.services.some((s) => s.id === preset.serviceId) ? preset.serviceId : (defaultService?.id ?? null),
  );
  const [barberId, setBarberId] = useState<number | null>(
    preset.barberId !== undefined ? (me.barbers.some((b) => b.id === preset.barberId) ? preset.barberId : null) : (me.habit?.barberId ?? null),
  );
  const [date, setDate] = useState(() => {
    if (preset.date) return preset.date;
    let d = todayStr();
    for (let i = 0; i < 7 && weekdayOf(d) === 0; i++) d = addDays(d, 1);
    return d;
  });
  /** `promo`: horário vazio com desconto (só marcando hoje, dentro da faixa). */
  const [slots, setSlots] = useState<{ barber: { id: number; name: string }; times: string[]; promo: { percent: number; from: string; until: string } | null }[] | null>(null);
  const [choice, setChoice] = useState<{ time: string; barberId: number; barberName: string } | null>(null);
  const [period, setPeriod] = useState<Period>('qualquer');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(todayStr(), i)), []);

  /** Dia lotado: entra na lista de espera e o robô avisa quando abrir vaga. */
  async function joinWaitlist() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/customer/${slug}/waitlist`, { date, barber_id: barberId, service_id: serviceId, period });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setSlots(null);
    setChoice(null);
    const q = new URLSearchParams({ date, ...(barberId ? { barber_id: String(barberId) } : {}), ...(serviceId ? { service_id: String(serviceId) } : {}) });
    api<NonNullable<typeof slots>>('GET', `/api/customer/${slug}/availability?${q}`).then((s) => {
      setSlots(s);
      // Repetir o último corte: o mesmo horário já vem escolhido, se estiver livre nesse dia.
      const same = date === preset.date && preset.time ? s.find((d) => d.times.includes(preset.time!)) : undefined;
      if (same) setChoice({ time: preset.time!, barberId: same.barber.id, barberName: same.barber.name });
    }, (e) => setError(e.message));
  }, [slug, date, barberId, serviceId, preset.date, preset.time]);

  // O dia escolhido aparece na faixa de dias (quando vem do "repetir", pode estar fora da tela).
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (el && strip.current) strip.current.scrollLeft = el.offsetLeft - strip.current.clientWidth / 2 + el.clientWidth / 2;
  }, [date]);

  // Sem preferência de barbeiro: cada horário fica com o primeiro barbeiro livre.
  const times = useMemo(() => {
    const map = new Map<string, { barberId: number; barberName: string }>();
    for (const d of slots ?? []) for (const t of d.times) if (!map.has(t)) map.set(t, { barberId: d.barber.id, barberName: d.barber.name });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [slots]);
  const promo = slots?.[0]?.promo ?? null;
  const promoOn = (t: string) => Boolean(promo && t >= promo.from && t < promo.until);
  // Desconto de volta vale em qualquer horário; com o do horário vazio, fica o maior.
  const back = me.comeback?.percent ?? 0;
  const discountAt = (t: string) => Math.max(back, promoOn(t) ? promo!.percent : 0);
  const service = me.services.find((s) => s.id === serviceId);

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
      // Pergunta do consumo (ex.: "posso avisar o Paulo da sua cerveja?").
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
        {me.comeback && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
            🎁 Seu desconto de volta: <b>{back}%</b> no horário que você escolher
            {service ? ` (${service.name.toLowerCase()} por ${money(Math.round((service.price_cents * (100 - back)) / 100))})` : ''}, marcando até{' '}
            {me.comeback.valid_until.slice(8, 10)}/{me.comeback.valid_until.slice(5, 7)}.
          </p>
        )}
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
          <div ref={strip} className="relative -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {days.map((d) => (
              <button
                key={d}
                aria-pressed={date === d}
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
            <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950 ring-1 ring-amber-200">
              <p>Nenhum horário livre nesse dia{barberId ? ' com esse barbeiro' : ''}. Quer que a gente te avise se abrir uma vaga?</p>
              <div className="flex flex-wrap items-center gap-2">
                <select className={`${inputClass} !w-auto !py-1.5`} value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Período">
                  {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
                    <option key={p} value={p}>
                      {cap(PERIOD_LABEL[p])}
                    </option>
                  ))}
                </select>
                <Button className="!py-1.5" loading={busy} style={{ background: accent, color: '#09090b' }} onClick={joinWaitlist}>
                  Me avise se abrir vaga
                </Button>
              </div>
            </div>
          ) : (
            <>
              {promo && times.some(([t]) => promoOn(t)) && promo.percent > back && (
                <p className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
                  🔥 Horário vazio: marcando hoje, os horários com selo saem com <b>{promo.percent}% de desconto</b> no serviço
                  {service ? ` (${service.name.toLowerCase()} por ${money(Math.round((service.price_cents * (100 - promo.percent)) / 100))})` : ''}.
                </p>
              )}
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {times.map(([t, b]) => (
                  <button
                    key={t}
                    onClick={() => setChoice({ time: t, ...b })}
                    className={`relative rounded-lg py-2 text-sm font-semibold ring-1 ${choice?.time === t ? 'text-zinc-950 ring-transparent' : promoOn(t) ? 'ring-emerald-300 hover:bg-emerald-50' : 'ring-zinc-200 hover:bg-zinc-100'}`}
                    style={choice?.time === t ? { background: accent } : undefined}
                  >
                    {t}
                    {promoOn(t) && promo!.percent > back && (
                      <span className="absolute -top-2 -right-1 rounded-full bg-emerald-600 px-1.5 text-[10px] leading-4 font-bold text-white">−{promo!.percent}%</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <ErrorText error={error} />
        <Button className="w-full" disabled={!choice} loading={busy} onClick={confirmBooking}>
          <Scissors className="size-4" />
          {choice
            ? `Confirmar ${dayLabel(date)} às ${hourLabel(choice.time)} com ${choice.barberName}${discountAt(choice.time) ? ` (−${discountAt(choice.time)}%)` : ''}`
            : 'Escolha um horário'}
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
