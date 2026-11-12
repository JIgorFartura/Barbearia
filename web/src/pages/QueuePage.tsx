import { Clock, LogOut, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, ErrorText, Field, Input, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { hourLabel, minutesLabel } from '../lib/format';

interface Shop {
  slug: string;
  name: string;
  tagline: string | null;
  primary_color: string;
  accent_color: string;
  logo_url: string | null;
}

interface QueueInfo {
  shop: Shop;
  enabled: boolean;
  waiting?: number;
  next?: { expected_at: string | null; wait_min: number | null };
  barbers?: { id: number; name: string }[];
  services?: { id: number; name: string; duration_min: number }[];
}

interface Ticket {
  ticket: number;
  name: string;
  status: 'waiting' | 'called' | 'serving' | 'done' | 'left';
  position: number | null;
  ahead: number | null;
  expected_at: string | null;
  wait_min: number | null;
  barber: string | null;
  service: string | null;
}

const waitLabel = (min: number | null | undefined) => (min == null ? '' : min < 5 ? 'agora' : `~${minutesLabel(min)}`);

/** Fila de chegada pelo QR Code do balcão: o cliente entra, acompanha a senha e é chamado no WhatsApp. */
export function QueuePage({ slug }: { slug: string }) {
  const key = `fila:${slug}`;
  const [info, setInfo] = useState<QueueInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [token, setToken] = useState<string | null>(() => {
    const fromLink = new URLSearchParams(location.search).get('t');
    if (fromLink) return fromLink;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });
  const [ticket, setTicket] = useState<Ticket | null>(null);

  useEffect(() => {
    api<QueueInfo>('GET', `/api/public/shops/${slug}/queue`).then(
      (i) => {
        setInfo(i);
        document.title = `${i.shop.name} · Fila`;
      },
      () => setNotFound(true),
    );
  }, [slug]);

  const loadTicket = useCallback(() => {
    if (!token) return;
    api<Ticket>('GET', `/api/public/queue/${token}`).then(setTicket, () => {
      setToken(null);
      setTicket(null);
    });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    try {
      localStorage.setItem(key, token);
    } catch {
      /* sem armazenamento: a senha continua no link do WhatsApp */
    }
    loadTicket();
    const t = setInterval(loadTicket, 15000);
    return () => clearInterval(t);
  }, [token, key, loadTicket]);

  function forget() {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nada a limpar */
    }
    setToken(null);
    setTicket(null);
    history.replaceState(null, '', `/b/${slug}/fila`);
  }

  if (notFound) return <div className="flex min-h-screen items-center justify-center text-zinc-500">Barbearia não encontrada.</div>;
  if (!info) return null;
  const { shop } = info;
  const active = ticket && ['waiting', 'called', 'serving'].includes(ticket.status);

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="text-white" style={{ background: shop.primary_color }}>
        <div className="mx-auto flex max-w-md items-center gap-3 px-4 py-5">
          {shop.logo_url && <img src={shop.logo_url} alt="" className="size-11 rounded-xl bg-white object-contain p-0.5" />}
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{shop.name}</p>
            <p className="text-sm opacity-80">Fila de chegada</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-md space-y-4 px-4 py-6">
        {active ? (
          <TicketCard ticket={ticket!} token={token!} onLeft={forget} />
        ) : !info.enabled ? (
          <p className="rounded-2xl bg-white p-5 text-center text-zinc-600 shadow-sm ring-1 ring-zinc-200">
            A {shop.name} não está usando a fila de chegada agora.{' '}
            <a href={`/b/${slug}`} className="font-medium underline">
              Ver o site e agendar
            </a>
          </p>
        ) : (
          <>
            {ticket && !active && (
              <p className="rounded-xl bg-zinc-100 px-4 py-3 text-sm text-zinc-600">
                {ticket.status === 'done' ? 'Seu atendimento da senha ' + ticket.ticket + ' terminou. Valeu! 👊' : 'Você saiu da fila.'}{' '}
                <button className="font-medium underline" onClick={forget}>
                  Entrar de novo
                </button>
              </p>
            )}
            <JoinForm info={info} onJoined={setToken} />
          </>
        )}
        <p className="text-center text-xs text-zinc-400">
          <a href={`/b/${slug}`} className="hover:underline">
            Site da {shop.name}
          </a>{' '}
          ·{' '}
          <a href={`/b/${slug}/privacidade`} className="hover:underline">
            Privacidade
          </a>
        </p>
      </main>
    </div>
  );
}

function TicketCard({ ticket, token, onLeft }: { ticket: Ticket; token: string; onLeft: () => void }) {
  const [busy, setBusy] = useState(false);
  const called = ticket.status !== 'waiting';
  async function leave() {
    if (!confirm('Sair da fila? A sua senha vai para o próximo.')) return;
    setBusy(true);
    await api('POST', `/api/public/queue/${token}/leave`).catch(() => undefined);
    onLeft();
  }
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-zinc-200">
        <p className="text-sm text-zinc-500">Olá, {ticket.name}! Sua senha</p>
        <p className="my-2 text-7xl font-black tracking-tight" style={{ color: called ? '#047857' : undefined }}>
          {ticket.ticket}
        </p>
        {called ? (
          <p className="rounded-xl bg-emerald-50 px-4 py-3 text-lg font-bold text-emerald-800 ring-1 ring-emerald-200">
            É a sua vez! {ticket.barber ? `O ${ticket.barber} já vai te atender.` : ''} 💈
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-zinc-50 p-3">
              <Users className="mx-auto size-5 text-zinc-400" />
              <p className="mt-1 text-2xl font-bold">{ticket.ahead === 0 ? 'Próximo!' : ticket.ahead}</p>
              <p className="text-xs text-zinc-500">{ticket.ahead === 0 ? 'você é o próximo' : 'na sua frente'}</p>
            </div>
            <div className="rounded-xl bg-zinc-50 p-3">
              <Clock className="mx-auto size-5 text-zinc-400" />
              <p className="mt-1 text-2xl font-bold">{ticket.expected_at ? hourLabel(ticket.expected_at) : '—'}</p>
              <p className="text-xs text-zinc-500">previsão {waitLabel(ticket.wait_min)}</p>
            </div>
          </div>
        )}
        {!called && ticket.barber && <p className="mt-3 text-sm text-zinc-500">Com o {ticket.barber}</p>}
      </div>
      {!called && (
        <p className="text-center text-sm text-zinc-500">
          Pode dar uma volta: avisamos no seu WhatsApp quando for a sua vez. A previsão respeita quem tem horário marcado.
        </p>
      )}
      {!called && (
        <Button variant="ghost" className="w-full" disabled={busy} onClick={leave}>
          <LogOut className="size-4" /> Sair da fila
        </Button>
      )}
    </div>
  );
}

function JoinForm({ info, onJoined }: { info: QueueInfo; onJoined: (token: string) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [barberId, setBarberId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { shop } = info;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('POST', `/api/public/shops/${shop.slug}/queue`, {
        name,
        phone,
        barber_id: barberId ? Number(barberId) : null,
        service_id: serviceId ? Number(serviceId) : null,
        accept: accept || undefined,
      });
      onJoined(r.token);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-xl bg-zinc-50 p-3">
          <p className="text-2xl font-bold">{info.waiting}</p>
          <p className="text-xs text-zinc-500">esperando</p>
        </div>
        <div className="rounded-xl bg-zinc-50 p-3">
          <p className="text-2xl font-bold">{info.next?.expected_at ? hourLabel(info.next.expected_at) : '—'}</p>
          <p className="text-xs text-zinc-500">{info.next?.expected_at ? `previsão ${waitLabel(info.next.wait_min)}` : 'sem vaga hoje'}</p>
        </div>
      </div>
      <h1 className="text-xl font-bold">Entrar na fila</h1>
      <Field label="Seu nome">
        <Input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
      </Field>
      <Field label="Celular (WhatsApp)" hint="Para avisar quando for a sua vez.">
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" autoComplete="tel" placeholder="(11) 98888-7777" />
      </Field>
      {(info.barbers?.length ?? 0) > 1 && (
        <Field label="Barbeiro">
          <select className={inputClass} value={barberId} onChange={(e) => setBarberId(e.target.value)}>
            <option value="">O primeiro que estiver livre</option>
            {info.barbers!.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {(info.services?.length ?? 0) > 1 && (
        <Field label="Serviço">
          <select className={inputClass} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Corte</option>
            {info.services!.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.duration_min} min)
              </option>
            ))}
          </select>
        </Field>
      )}
      <label className="flex items-start gap-2 text-sm text-zinc-600">
        <input type="checkbox" className="mt-0.5 size-4" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
        <span>
          Li e aceito a{' '}
          <a href={`/b/${shop.slug}/privacidade`} target="_blank" rel="noreferrer" className="underline">
            política de privacidade
          </a>
          .
        </span>
      </label>
      <ErrorText error={error} />
      <Button type="submit" className="w-full" disabled={busy || !info.next?.expected_at} style={{ background: shop.accent_color, color: '#09090b' }}>
        Entrar na fila
      </Button>
    </form>
  );
}
