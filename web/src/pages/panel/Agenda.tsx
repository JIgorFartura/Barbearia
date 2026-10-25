import { CalendarDays, ChevronLeft, ChevronRight, Clock, MessageCircle, Plus, Search, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckoutModal } from '../../components/Checkout';
import { ProfileLine, ProfileModal, type ProfileSummary } from '../../components/Profile';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal, inputClass } from '../../components/ui';
import { methodLabel } from '../../lib/finance';
import { api } from '../../lib/api';
import { addDays, cap, dayLabel, hourLabel, money, phone, todayStr, weekdayOf, whatsappLink } from '../../lib/format';
import { navigate } from '../../lib/router';

interface Appointment {
  id: number;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  barber_id: number;
  barber_name: string;
  service_name: string;
  price_cents: number;
  starts_at: string;
  ends_at: string;
  status: 'scheduled' | 'cancelled' | 'no_show';
  source: 'painel' | 'cliente' | 'whatsapp';
  /** O que o cliente pediu para deixar separado (ex.: 1 cerveja). */
  items: { catalog_item_id: number; name: string; qty: number }[];
  /** Venda que fechou o atendimento. */
  sale: { id: number; total_cents: number; method: string } | null;
  /** O cliente confirmou a presença. */
  confirmed_at: string | null;
  /** O lembrete pediu a confirmação e a resposta ainda não veio. */
  awaiting: boolean;
  /** Ficha do cliente: anotações e fotos do corte. */
  profile: ProfileSummary;
  /** Desconto do horário vazio (o preço já sai com ele). */
  promo_percent: number | null;
}

type Period = 'qualquer' | 'manha' | 'tarde' | 'noite';
const PERIOD_LABEL: Record<Period, string> = { qualquer: 'qualquer horário', manha: 'de manhã', tarde: 'à tarde', noite: 'à noite' };

interface WaitItem {
  id: number;
  customer_name: string;
  phone: string;
  barber_name: string | null;
  service_name: string | null;
  period: Period;
  offers: number;
  created_at: string;
}

interface BarberRow {
  id: number;
  name: string;
  hours: { weekday: number; start_time: string; end_time: string }[];
}

interface AgendaData {
  date: string;
  barbers: BarberRow[];
  appointments: Appointment[];
  blocks: { id: number; barber_id: number; starts_at: string; ends_at: string; reason: string | null }[];
  /** Lista de espera do dia (na ordem de chegada). */
  waitlist: WaitItem[];
}

const SOURCE: Record<Appointment['source'], string> = { painel: 'Balcão', cliente: 'Site', whatsapp: 'WhatsApp' };

/** Agenda do dia, uma coluna por barbeiro. */
export function Agenda() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<AgendaData | null>(null);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<number | null>(null);
  const [ficha, setFicha] = useState<Appointment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<AgendaData>('GET', `/api/shop/agenda?date=${date}`).then(setData, (e) => setError(e.message));
  }, [date]);
  useEffect(load, [load]);

  async function act(a: Appointment, action: 'cancel' | 'no_show' | 'scheduled' | 'confirm') {
    setError(null);
    if (action === 'cancel' && !confirm(`Cancelar o horário de ${a.customer_name} (${a.starts_at.slice(11)})? Se tiver alguém na lista de espera, a vaga é oferecida.`)) return;
    try {
      if (action === 'cancel') await api('POST', `/api/shop/appointments/${a.id}/cancel`);
      else if (action === 'confirm') await api('POST', `/api/shop/appointments/${a.id}/confirm`, { confirmed: true });
      else await api('POST', `/api/shop/appointments/${a.id}/status`, { status: action });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeWait(w: WaitItem) {
    if (!confirm(`Tirar ${w.customer_name} da lista de espera?`)) return;
    await api('DELETE', `/api/shop/waitlist/${w.id}`).then(load, (e) => setError(e.message));
  }

  const weekday = weekdayOf(date);
  const isToday = date === todayStr();

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Agenda</h1>
          <p className="text-sm text-zinc-500">Horários marcados no balcão, no site e pelo robô do WhatsApp.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Novo horário
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="!px-2" onClick={() => setDate(addDays(date, -1))} aria-label="Dia anterior">
          <ChevronLeft className="size-4" />
        </Button>
        <p className="min-w-44 text-center font-semibold">{isToday ? `Hoje, ${dayLabel(date).split(', ')[1]}` : cap(dayLabel(date))}</p>
        <Button variant="ghost" className="!px-2" onClick={() => setDate(addDays(date, 1))} aria-label="Próximo dia">
          <ChevronRight className="size-4" />
        </Button>
        {!isToday && (
          <Button variant="ghost" onClick={() => setDate(todayStr())}>
            Hoje
          </Button>
        )}
        <input type="date" className={`${inputClass} !w-auto`} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </div>
      <ErrorText error={error} />

      {data && data.barbers.length === 0 && (
        <EmptyState
          icon={<Users className="size-6" />}
          title="Nenhum barbeiro cadastrado"
          text="Cadastre os barbeiros e o expediente de cada um para abrir a agenda no site e no WhatsApp."
          action={<Button onClick={() => navigate('/painel/barbeiros')}>Cadastrar barbeiros</Button>}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.barbers.map((b) => {
          const hours = b.hours.filter((h) => h.weekday === weekday);
          const items = [
            ...data.appointments.filter((a) => a.barber_id === b.id).map((a) => ({ at: a.starts_at, appt: a })),
            ...data.blocks.filter((k) => k.barber_id === b.id).map((k) => ({ at: k.starts_at < `${date} 00:00` ? `${date} 00:00` : k.starts_at, block: k })),
          ].sort((x, y) => x.at.localeCompare(y.at));
          return (
            <Card key={b.id} className="!p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-semibold">{b.name}</p>
                <span className="text-xs text-zinc-500">
                  {hours.length ? hours.map((h) => `${hourLabel(h.start_time)}–${hourLabel(h.end_time)}`).join(' · ') : 'Folga'}
                </span>
              </div>
              {items.length === 0 && <p className="text-sm text-zinc-400">Nenhum horário marcado.</p>}
              <ul className="space-y-2">
                {items.map((item) =>
                  'appt' in item && item.appt ? (
                    <li
                      key={`a${item.appt.id}`}
                      className={`rounded-xl px-3 py-2 ring-1 ${item.appt.status === 'scheduled' ? 'bg-white ring-zinc-200' : 'bg-zinc-50 ring-zinc-100 opacity-60'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold tabular-nums">
                            {item.appt.starts_at.slice(11)} <span className="font-normal">{item.appt.customer_name}</span>
                          </p>
                          <p className="text-xs text-zinc-500">
                            {item.appt.service_name} · {money(item.appt.price_cents)}
                            {item.appt.promo_percent ? <span className="font-medium text-emerald-700"> (−{item.appt.promo_percent}%)</span> : null} ·{' '}
                            {phone(item.appt.customer_phone)}
                          </p>
                        </div>
                        <Badge tone={item.appt.status === 'scheduled' ? (item.appt.source === 'whatsapp' ? 'green' : 'zinc') : 'red'}>
                          {item.appt.status === 'cancelled' ? 'Cancelado' : item.appt.status === 'no_show' ? 'Faltou' : SOURCE[item.appt.source]}
                        </Badge>
                      </div>
                      {item.appt.status === 'scheduled' &&
                        !item.appt.sale &&
                        (item.appt.confirmed_at ? (
                          <p className="mt-1 text-xs font-medium text-emerald-700">✓ Presença confirmada</p>
                        ) : (
                          item.appt.awaiting && <p className="mt-1 text-xs font-medium text-amber-700">Aguardando a confirmação do cliente</p>
                        ))}
                      {item.appt.status !== 'cancelled' && <ProfileLine base="/api/shop" summary={item.appt.profile} onOpen={() => setFicha(item.appt!)} />}
                      {item.appt.items.length > 0 && (
                        <p className="mt-1 text-xs font-medium text-amber-800">🍺 Separar: {item.appt.items.map((i) => `${i.qty} ${i.name.toLowerCase()}`).join(', ')}</p>
                      )}
                      {item.appt.sale && (
                        <p className="mt-1 text-xs font-medium text-emerald-700">
                          ✓ Pago {money(item.appt.sale.total_cents)} · {methodLabel(item.appt.sale.method)}
                        </p>
                      )}
                      {item.appt.status !== 'cancelled' && !item.appt.sale && (
                        <div className="mt-1 flex items-center gap-3 text-xs">
                          {item.appt.status === 'scheduled' ? (
                            <>
                              <button className="rounded-md bg-zinc-900 px-2 py-0.5 font-semibold text-white hover:bg-zinc-700" onClick={() => setClosing(item.appt!.id)}>
                                Fechar
                              </button>
                              {!item.appt.confirmed_at && (
                                <button className="text-zinc-500 hover:text-zinc-900" onClick={() => act(item.appt!, 'confirm')} title="O cliente confirmou por telefone ou mensagem">
                                  Confirmou
                                </button>
                              )}
                              <button className="text-zinc-500 hover:text-zinc-900" onClick={() => act(item.appt!, 'no_show')}>
                                Faltou
                              </button>
                              <button className="text-red-600 hover:underline" onClick={() => act(item.appt!, 'cancel')}>
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <button className="text-zinc-500 hover:text-zinc-900" onClick={() => act(item.appt!, 'scheduled')}>
                              Desfazer falta
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ) : (
                    'block' in item &&
                    item.block && (
                      <li key={`b${item.block.id}`} className="rounded-xl bg-zinc-100 px-3 py-2 text-sm text-zinc-500">
                        Bloqueado {item.block.starts_at.slice(0, 10) === date ? item.block.starts_at.slice(11) : '00:00'}–
                        {item.block.ends_at.slice(0, 10) === date ? item.block.ends_at.slice(11) : '24:00'}
                        {item.block.reason && ` · ${item.block.reason}`}
                      </li>
                    )
                  ),
                )}
              </ul>
            </Card>
          );
        })}
      </div>

      {data && data.barbers.length > 0 && (
        <Card className="mt-4 !p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold">
              <Clock className="size-4" /> Lista de espera do dia {data.waitlist.length > 0 && <Badge tone="gold">{data.waitlist.length}</Badge>}
            </p>
            <span className="text-xs text-zinc-500">Abriu vaga, o robô oferece no WhatsApp na ordem da fila (30 minutos para cada um responder).</span>
          </div>
          {data.waitlist.length === 0 ? (
            <p className="text-sm text-zinc-400">Ninguém esperando vaga neste dia. Para pôr alguém, use Novo horário num dia sem vaga.</p>
          ) : (
            <ol className="divide-y divide-zinc-100 text-sm">
              {data.waitlist.map((w, i) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <b>
                      {i + 1}. {w.customer_name}
                    </b>{' '}
                    <span className="text-zinc-500">
                      · {PERIOD_LABEL[w.period]}
                      {w.barber_name ? ` · com ${w.barber_name}` : ''}
                      {w.offers > 0 ? ` · ${w.offers} vaga(s) oferecida(s)` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 text-xs">
                    <a href={whatsappLink(w.phone)} target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-emerald-700" aria-label={`WhatsApp de ${w.customer_name}`}>
                      <MessageCircle className="size-4" />
                    </a>
                    <button className="text-red-600 hover:underline" onClick={() => removeWait(w)}>
                      Tirar
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {closing && (
        <CheckoutModal
          appointmentId={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            load();
          }}
        />
      )}

      {ficha && (
        <ProfileModal
          base="/api/shop"
          customerId={ficha.customer_id}
          customerName={ficha.customer_name}
          appointmentId={ficha.id}
          onClose={() => setFicha(null)}
          onChanged={load}
        />
      )}

      {creating && data && (
        <NewAppointmentModal
          date={date}
          barbers={data.barbers}
          onClose={() => setCreating(false)}
          onDone={(d) => {
            setCreating(false);
            if (d === date) load();
            else setDate(d);
          }}
        />
      )}
    </section>
  );
}

interface CustomerLite {
  id: number;
  name: string;
  phone: string;
}

function NewAppointmentModal({ date: initialDate, barbers, onClose, onDone }: { date: string; barbers: BarberRow[]; onClose: () => void; onDone: (date: string) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<CustomerLite[]>([]);
  const [customer, setCustomer] = useState<CustomerLite | null>(null);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '' });
  const [services, setServices] = useState<{ id: number; name: string; price_cents: number; kind: string; active: number }[]>([]);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [barberId, setBarberId] = useState<number>(barbers[0]?.id ?? 0);
  const [date, setDate] = useState(initialDate);
  const [times, setTimes] = useState<string[]>([]);
  const [time, setTime] = useState('');
  const [period, setPeriod] = useState<Period>('qualquer');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<typeof services>('GET', '/api/shop/catalog').then((list) => {
      const s = list.filter((i) => i.kind === 'service' && i.active);
      setServices(s);
      setServiceId((s.find((i) => /^corte/i.test(i.name)) ?? s[0])?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!q.trim() || customer) return;
    const t = setTimeout(() => api<CustomerLite[]>('GET', `/api/shop/customers?q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 6))), 250);
    return () => clearTimeout(t);
  }, [q, customer]);

  useEffect(() => {
    if (!barberId) return;
    const params = new URLSearchParams({ date, barber_id: String(barberId), ...(serviceId ? { service_id: String(serviceId) } : {}) });
    api<{ times: string[] }[]>('GET', `/api/shop/availability?${params}`).then((r) => setTimes(r[0]?.times ?? []), () => setTimes([]));
  }, [date, barberId, serviceId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let c = customer;
      if (!c) c = await api<CustomerLite>('POST', '/api/shop/customers', newCustomer);
      await api('POST', '/api/shop/appointments', { customer_id: c.id, barber_id: barberId, service_id: serviceId, date, time });
      onDone(date);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Dia lotado: o cliente entra na lista de espera e o robô avisa quando abrir vaga. */
  async function wait() {
    setBusy(true);
    setError(null);
    try {
      let c = customer;
      if (!c) c = await api<CustomerLite>('POST', '/api/shop/customers', newCustomer);
      await api('POST', '/api/shop/waitlist', { customer_id: c.id, barber_id: barberId, service_id: serviceId, date, period });
      onDone(date);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Novo horário" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {customer ? (
          <div className="flex items-center justify-between rounded-xl bg-zinc-50 px-3 py-2">
            <span>
              <span className="font-semibold">{customer.name}</span> <span className="text-sm text-zinc-500">{phone(customer.phone)}</span>
            </span>
            <button type="button" className="text-sm text-zinc-500 hover:text-zinc-900" onClick={() => setCustomer(null)}>
              Trocar
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <Field label="Cliente">
              <div className="relative">
                <Search className="absolute top-2.5 left-3 size-4 text-zinc-400" />
                <Input className="pl-9" placeholder="Buscar por nome ou celular" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </Field>
            {found.map((c) => (
              <button type="button" key={c.id} onClick={() => setCustomer(c)} className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-zinc-100">
                {c.name} <span className="text-zinc-500">{phone(c.phone)}</span>
              </button>
            ))}
            <p className="pt-1 text-xs font-medium text-zinc-500">Ou cadastre um cliente novo:</p>
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Nome" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />
              <Input type="tel" placeholder="Celular" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Barbeiro">
            <select className={inputClass} value={barberId} onChange={(e) => setBarberId(Number(e.target.value))}>
              {barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Serviço">
            <select className={inputClass} value={serviceId ?? ''} onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}>
              {services.length === 0 && <option value="">Atendimento</option>}
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {money(s.price_cents)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dia">
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Hora" hint="Pode encaixar fora dos horários livres.">
            <Input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        {times.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {times.map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTime(t)}
                className={`rounded-md px-2 py-1 text-xs font-semibold ring-1 ${time === t ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        {times.length === 0 && (
          <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950 ring-1 ring-amber-200">
            <p className="flex items-center gap-1">
              <CalendarDays className="size-4 shrink-0" /> Sem horários livres nesse dia para esse barbeiro. Dá para encaixar mesmo assim (hora acima) ou pôr na
              lista de espera: abriu vaga, o robô oferece no WhatsApp.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select className={`${inputClass} !w-auto !py-1.5`} value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Período">
                {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
                  <option key={p} value={p}>
                    {cap(PERIOD_LABEL[p])}
                  </option>
                ))}
              </select>
              <Button type="button" variant="ghost" className="!py-1.5" loading={busy} disabled={!customer && (!newCustomer.name || !newCustomer.phone)} onClick={wait}>
                <Clock className="size-4" /> Pôr na lista de espera
              </Button>
            </div>
          </div>
        )}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy} disabled={!time || (!customer && (!newCustomer.name || !newCustomer.phone))}>
            Marcar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
