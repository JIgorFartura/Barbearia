import { Ban, Copy, KeyRound, Pencil, Plus, Smartphone, Trash2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, ImageInput, Input, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { centsToInput, parseMoney } from '../../lib/finance';
import { WEEKDAYS, WEEKDAYS_SHORT, cap, hourLabel, phone, stampLabel, todayStr, whatsappLink } from '../../lib/format';

interface Hours {
  weekday: number;
  start_time: string;
  end_time: string;
}

interface Rate {
  service_id: number;
  mode: 'percent' | 'fixed';
  /** percent: %; fixed: centavos por serviço. */
  value: number;
}

interface Barber {
  id: number;
  name: string;
  photo_url: string | null;
  active: number;
  phone: string | null;
  service_commission: number;
  product_commission: number;
  rates: Rate[];
  hours: Hours[];
  blocks: { id: number; starts_at: string; ends_at: string; reason: string | null }[];
  /** Login do barbeiro no sistema (agenda própria e comissões). */
  access: { user_id: number; phone: string | null; email: string | null } | null;
}

/** Um dia do expediente no formulário: início, fim e (opcional) uma pausa no meio. */
interface DayForm {
  on: boolean;
  start: string;
  end: string;
  breakStart: string;
  breakEnd: string;
}

function toForm(hours: Hours[]): DayForm[] {
  return Array.from({ length: 7 }, (_, d) => {
    const ranges = hours.filter((h) => h.weekday === d).sort((a, b) => a.start_time.localeCompare(b.start_time));
    if (!ranges.length) return { on: false, start: '09:00', end: '19:00', breakStart: '', breakEnd: '' };
    const last = ranges[ranges.length - 1];
    return {
      on: true,
      start: ranges[0].start_time,
      end: last.end_time,
      breakStart: ranges.length > 1 ? ranges[0].end_time : '',
      breakEnd: ranges.length > 1 ? ranges[1].start_time : '',
    };
  });
}

function fromForm(days: DayForm[]): Hours[] {
  return days.flatMap((d, weekday) => {
    if (!d.on) return [];
    if (d.breakStart && d.breakEnd) {
      return [
        { weekday, start_time: d.start, end_time: d.breakStart },
        { weekday, start_time: d.breakEnd, end_time: d.end },
      ];
    }
    return [{ weekday, start_time: d.start, end_time: d.end }];
  });
}

function summary(hours: Hours[]): string {
  if (!hours.length) return 'Sem expediente';
  const byDay = toForm(hours);
  return byDay
    .map((d, i) => (d.on ? `${WEEKDAYS_SHORT[i]} ${hourLabel(d.start)}–${hourLabel(d.end)}` : null))
    .filter(Boolean)
    .join(' · ');
}

/** Barbeiros, expediente semanal e folgas. */
export function Barbers() {
  const [list, setList] = useState<Barber[] | null>(null);
  const [editing, setEditing] = useState<Partial<Barber> | null>(null);
  const [blocking, setBlocking] = useState<Barber | null>(null);
  const [access, setAccess] = useState<{ barber: Barber; reset: boolean } | null>(null);
  const [canClose, setCanClose] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Barber[]>('GET', '/api/shop/barbers').then(setList, (e) => setError(e.message));
    api<{ barber_can_close: number }>('GET', '/api/shop/barber-settings').then((s) => setCanClose(Boolean(s.barber_can_close)));
  }, []);
  useEffect(load, [load]);

  async function removeAccess(b: Barber) {
    if (!confirm(`Tirar o acesso de ${b.name} ao sistema?`)) return;
    setList(await api<Barber[]>('DELETE', `/api/shop/barbers/${b.id}/access`));
  }

  async function remove(b: Barber) {
    if (!confirm(`Excluir ${b.name}?`)) return;
    setError(null);
    try {
      setList(await api<Barber[]>('DELETE', `/api/shop/barbers/${b.id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeBlock(id: number) {
    setList(await api<Barber[]>('DELETE', `/api/shop/blocks/${id}`));
  }

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Barbeiros</h1>
          <p className="text-sm text-zinc-500">Quem atende e em que horários. É daqui que saem os horários livres do site e do robô.</p>
        </div>
        <Button onClick={() => setEditing({ name: '', active: 1, hours: [] })}>
          <Plus className="size-4" /> Novo barbeiro
        </Button>
      </div>
      <ErrorText error={error} />
      {canClose !== null && list && list.some((b) => b.access) && (
        <label className="mb-4 flex items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-zinc-200">
          <input
            type="checkbox"
            className="size-4 accent-zinc-900"
            checked={canClose}
            onChange={(e) => {
              setCanClose(e.target.checked);
              void api('PUT', '/api/shop/barber-settings', { barber_can_close: e.target.checked });
            }}
          />
          Barbeiros podem fechar os próprios atendimentos (lançar a venda e a forma de pagamento pelo celular)
        </label>
      )}
      {list?.length === 0 && (
        <EmptyState icon={<Users className="size-6" />} title="Nenhum barbeiro ainda" text="Cadastre quem atende e o expediente de cada um." />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {list?.map((b) => (
          <Card key={b.id} className="!p-4">
            <div className="flex items-start gap-3">
              {b.photo_url ? (
                <img src={b.photo_url} alt="" className="size-12 rounded-full object-cover" />
              ) : (
                <div className="flex size-12 items-center justify-center rounded-full bg-zinc-100 font-bold text-zinc-500">{b.name[0]}</div>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {b.name} {!b.active && <Badge tone="red">Inativo</Badge>}
                </p>
                <p className="text-sm text-zinc-500">{summary(b.hours)}</p>
                <p className="text-xs text-zinc-500">
                  Comissão: {b.service_commission}% nos serviços
                  {b.rates.length ? ` (+${b.rates.length} regra${b.rates.length > 1 ? 's' : ''} por serviço)` : ''} · {b.product_commission}% nos produtos
                  {b.phone ? ` · ${phone(b.phone)}` : ''}
                </p>
              </div>
            </div>
            {b.blocks.length > 0 && (
              <ul className="mt-3 space-y-1">
                {b.blocks.map((k) => (
                  <li key={k.id} className="flex items-center justify-between rounded-lg bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
                    <span>
                      {cap(stampLabel(k.starts_at))} até {stampLabel(k.ends_at)}
                      {k.reason && ` · ${k.reason}`}
                    </span>
                    <button onClick={() => removeBlock(k.id)} className="text-zinc-400 hover:text-red-600" aria-label="Remover bloqueio">
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs">
              <Smartphone className="size-3.5 text-zinc-400" />
              {b.access ? (
                <>
                  <span className="text-zinc-600">
                    Acesso ao sistema: <b>{b.access.phone ? phone(b.access.phone) : b.access.email}</b>
                  </span>
                  <button className="font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setAccess({ barber: b, reset: true })}>
                    Nova senha
                  </button>
                  <button className="font-medium text-zinc-500 hover:text-red-600" onClick={() => removeAccess(b)}>
                    Remover acesso
                  </button>
                </>
              ) : (
                <button className="font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setAccess({ barber: b, reset: false })}>
                  Dar acesso ao sistema (agenda e comissões no celular dele)
                </button>
              )}
            </div>
            <div className="mt-3 flex gap-2 border-t border-zinc-100 pt-3">
              <Button variant="ghost" className="!px-3 !py-1.5" onClick={() => setEditing(b)}>
                <Pencil className="size-3.5" /> Editar
              </Button>
              <Button variant="ghost" className="!px-3 !py-1.5" onClick={() => setBlocking(b)}>
                <Ban className="size-3.5" /> Folga / bloqueio
              </Button>
              <Button variant="danger" className="!px-3 !py-1.5" onClick={() => remove(b)}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {editing && (
        <BarberModal
          barber={editing}
          onClose={() => setEditing(null)}
          onDone={(l) => {
            setEditing(null);
            setList(l);
          }}
        />
      )}
      {access && (
        <AccessModal
          barber={access.barber}
          reset={access.reset}
          onClose={() => setAccess(null)}
          onDone={(l) => setList(l)}
        />
      )}
      {blocking && (
        <BlockModal
          barber={blocking}
          onClose={() => setBlocking(null)}
          onDone={(l) => {
            setBlocking(null);
            setList(l);
          }}
        />
      )}
      <ReceptionCard />
    </section>
  );
}

interface DeskUser {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
}

/** Logins da recepção: agenda, balcão e comanda, sem o financeiro, os relatórios e as configurações. */
function ReceptionCard() {
  const [list, setList] = useState<DeskUser[] | null>(null);
  const [form, setForm] = useState<{ name: string; phone: string; email: string; password: string } | null>(null);
  const [reset, setReset] = useState<{ user: DeskUser; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<DeskUser[]>('GET', '/api/shop/reception').then(setList, (e) => setError(e.message));
  }, []);

  async function run(p: Promise<DeskUser[]>, after: () => void) {
    setBusy(true);
    setError(null);
    try {
      setList(await p);
      after();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    await run(api<DeskUser[]>('POST', '/api/shop/reception', { ...form, email: form.email || null }), () => setForm(null));
  }

  return (
    <Card className="mt-6 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            <KeyRound className="size-5 text-zinc-400" /> Recepção
          </p>
          <p className="text-sm text-zinc-500">
            Login para quem fica no balcão: agenda, clientes, carimbos, comanda e venda de pacote e vale-presente. Não vê o caixa, os relatórios, as comissões
            nem as configurações.
          </p>
        </div>
        {!form && (
          <Button variant="ghost" onClick={() => setForm({ name: '', phone: '', email: '', password: '' })}>
            <Plus className="size-4" /> Novo login da recepção
          </Button>
        )}
      </div>
      {form && (
        <form onSubmit={add} className="grid gap-3 rounded-xl bg-zinc-50 p-3 sm:grid-cols-2">
          <Field label="Nome">
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Celular (é o login)">
            <Input required type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(11) 99999-0000" />
          </Field>
          <Field label="E-mail (opcional)">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Senha" hint="Pelo menos 8 caracteres.">
            <Input required type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <div className="flex gap-2 sm:col-span-2">
            <Button loading={busy}>Criar login</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
      <ErrorText error={error} />
      {list && list.length === 0 && !form && <p className="text-sm text-zinc-400">Nenhum login da recepção ainda.</p>}
      <ul className="divide-y divide-zinc-100 text-sm">
        {list?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <b>{u.name}</b> <span className="text-zinc-500">· {u.phone ? phone(u.phone) : u.email}</span>
            </span>
            <span className="flex items-center gap-3 text-xs">
              <button className="text-zinc-500 hover:text-zinc-900" onClick={() => setReset({ user: u, password: '' })}>
                Trocar senha
              </button>
              <button
                className="text-red-600 hover:underline"
                onClick={() => confirm(`Tirar o acesso de ${u.name}?`) && run(api<DeskUser[]>('DELETE', `/api/shop/reception/${u.id}`), () => undefined)}
              >
                Tirar acesso
              </button>
            </span>
          </li>
        ))}
      </ul>
      {reset && (
        <Modal title={`Nova senha de ${reset.user.name}`} onClose={() => setReset(null)}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(api<DeskUser[]>('PUT', `/api/shop/reception/${reset.user.id}/password`, { password: reset.password }), () => setReset(null));
            }}
          >
            <Field label="Nova senha" hint="Pelo menos 8 caracteres. Quem estava logado precisa entrar de novo.">
              <Input type="password" autoComplete="new-password" value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} />
            </Field>
            <Button loading={busy} disabled={reset.password.length < 8}>
              Salvar
            </Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}

function BarberModal({ barber, onClose, onDone }: { barber: Partial<Barber>; onClose: () => void; onDone: (list: Barber[]) => void }) {
  const [name, setName] = useState(barber.name ?? '');
  const [photo, setPhoto] = useState<string | null>(barber.photo_url ?? null);
  const [active, setActive] = useState(barber.active !== 0);
  const [barberPhone, setBarberPhone] = useState(barber.phone ?? '');
  const [serviceCommission, setServiceCommission] = useState(String(barber.service_commission ?? 0));
  const [productCommission, setProductCommission] = useState(String(barber.product_commission ?? 0));
  const [rates, setRates] = useState<{ service_id: number; mode: 'percent' | 'fixed'; value: string }[]>(
    (barber.rates ?? []).map((r) => ({ service_id: r.service_id, mode: r.mode, value: r.mode === 'fixed' ? centsToInput(r.value) : String(r.value) })),
  );
  const [services, setServices] = useState<{ id: number; name: string; price_cents: number }[]>([]);
  useEffect(() => {
    api<{ id: number; name: string; price_cents: number; kind: string }[]>('GET', '/api/shop/catalog').then((l) => setServices(l.filter((i) => i.kind === 'service')));
  }, []);
  const [days, setDays] = useState<DayForm[]>(() => {
    const form = toForm(barber.hours ?? []);
    // Barbeiro novo: já vem de segunda a sábado, 9h às 19h.
    return barber.id ? form : form.map((d, i) => ({ ...d, on: i >= 1 && i <= 6 }));
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setDay = (i: number, patch: Partial<DayForm>) => setDays(days.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const num = (v: string) => Number(v.replace(',', '.')) || 0;
      const body = {
        name,
        photo_url: photo,
        active,
        hours: fromForm(days),
        phone: barberPhone || null,
        service_commission: num(serviceCommission),
        product_commission: num(productCommission),
        rates: rates.map((r) => ({ service_id: r.service_id, mode: r.mode, value: r.mode === 'fixed' ? parseMoney(r.value) : num(r.value) })),
      };
      onDone(await api<Barber[]>(barber.id ? 'PUT' : 'POST', barber.id ? `/api/shop/barbers/${barber.id}` : '/api/shop/barbers', body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={barber.id ? `Editar ${barber.name}` : 'Novo barbeiro'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Foto">
          <ImageInput value={photo} onChange={setPhoto} />
        </Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700">Expediente</span>
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-zinc-900"
              onClick={() => setDays(days.map((d, i) => (i === 0 ? d : { ...days[1], on: d.on })))}
            >
              Copiar segunda para os outros dias
            </button>
          </div>
          <div className="space-y-1.5">
            {days.map((d, i) => (
              <div key={i} className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-sm">
                <label className="flex items-center gap-1.5 font-medium capitalize">
                  <input type="checkbox" className="size-4 accent-zinc-900" checked={d.on} onChange={(e) => setDay(i, { on: e.target.checked })} />
                  {WEEKDAYS[i]}
                </label>
                {d.on ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <input type="time" className="rounded-md border border-zinc-300 px-1.5 py-1" value={d.start} onChange={(e) => setDay(i, { start: e.target.value })} />
                    <span>às</span>
                    <input type="time" className="rounded-md border border-zinc-300 px-1.5 py-1" value={d.end} onChange={(e) => setDay(i, { end: e.target.value })} />
                    <span className="ml-1 text-xs text-zinc-500">pausa</span>
                    <input
                      type="time"
                      className="rounded-md border border-zinc-300 px-1.5 py-1 text-xs"
                      value={d.breakStart}
                      onChange={(e) => setDay(i, { breakStart: e.target.value })}
                    />
                    <input
                      type="time"
                      className="rounded-md border border-zinc-300 px-1.5 py-1 text-xs"
                      value={d.breakEnd}
                      onChange={(e) => setDay(i, { breakEnd: e.target.value })}
                    />
                  </div>
                ) : (
                  <span className="text-zinc-400">Folga</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3 rounded-xl bg-zinc-50 p-3">
          <p className="text-sm font-semibold">Pagamento do barbeiro (comissão)</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="% nos serviços">
              <Input inputMode="decimal" value={serviceCommission} onChange={(e) => setServiceCommission(e.target.value)} />
            </Field>
            <Field label="% na venda de produtos">
              <Input inputMode="decimal" value={productCommission} onChange={(e) => setProductCommission(e.target.value)} />
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">Regras por serviço (ex.: corte R$ 25,00 fixo; barba 60%):</p>
            {rates.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  className="min-w-0 flex-1 rounded-md border border-zinc-300 px-1.5 py-1 text-sm"
                  value={r.service_id}
                  onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, service_id: Number(e.target.value) } : x)))}
                >
                  {services.map((sv) => (
                    <option key={sv.id} value={sv.id}>
                      {sv.name}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-md border border-zinc-300 px-1.5 py-1 text-sm"
                  value={r.mode}
                  onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, mode: e.target.value as 'percent' | 'fixed' } : x)))}
                >
                  <option value="percent">%</option>
                  <option value="fixed">R$ fixo</option>
                </select>
                <input
                  className="w-20 rounded-md border border-zinc-300 px-1.5 py-1 text-sm"
                  inputMode="decimal"
                  value={r.value}
                  onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <button type="button" onClick={() => setRates(rates.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-600" aria-label="Remover regra">
                  <X className="size-4" />
                </button>
              </div>
            ))}
            {services.length > 0 && (
              <button
                type="button"
                className="text-xs font-medium text-zinc-600 hover:text-zinc-900"
                onClick={() => setRates([...rates, { service_id: services[0].id, mode: 'fixed', value: '' }])}
              >
                + Regra para um serviço
              </button>
            )}
          </div>
        </div>
        <Field label="Celular do barbeiro (opcional)" hint="O robô avisa por WhatsApp quando um cliente pede para deixar algo separado (ex.: a cerveja).">
          <Input type="tel" placeholder="(11) 98888-7777" value={barberPhone} onChange={(e) => setBarberPhone(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Atendendo (aparece no site e no robô)
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

function BlockModal({ barber, onClose, onDone }: { barber: Barber; onClose: () => void; onDone: (list: Barber[]) => void }) {
  const [form, setForm] = useState({ date: todayStr(), start_time: '09:00', end_date: todayStr(), end_time: '19:00', reason: '' });
  const [allDay, setAllDay] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = allDay ? { ...form, start_time: '00:00', end_time: '23:59' } : form;
      onDone(await api<Barber[]>('POST', `/api/shop/barbers/${barber.id}/blocks`, body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Folga ou bloqueio · ${barber.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          Dia(s) inteiro(s)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="De">
            <Input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value, end_date: e.target.value > form.end_date ? e.target.value : form.end_date })} />
          </Field>
          <Field label="Até">
            <Input type="date" required value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </Field>
          {!allDay && (
            <>
              <Field label="Das">
                <Input type="time" required value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
              </Field>
              <Field label="Às">
                <Input type="time" required value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <Field label="Motivo (opcional)">
          <Input placeholder="Férias, curso, consulta..." value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Bloquear
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Senha inicial fácil de ditar: 4 letras + 4 números. */
function suggestPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${pick(letters, 4)}${pick('23456789', 4)}`;
}

/** Cria (ou troca a senha do) acesso do barbeiro e prepara a mensagem para mandar a ele. */
function AccessModal({ barber, reset, onClose, onDone }: { barber: Barber; reset: boolean; onClose: () => void; onDone: (list: Barber[]) => void }) {
  const [phoneValue, setPhoneValue] = useState(phone(barber.access?.phone ?? barber.phone ?? ''));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(suggestPassword);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const list = reset
        ? await api<Barber[]>('PUT', `/api/shop/barbers/${barber.id}/access`, { password })
        : await api<Barber[]>('POST', `/api/shop/barbers/${barber.id}/access`, { phone: phoneValue, email: email || null, password });
      onDone(list);
      const login = reset ? phone(barber.access?.phone ?? '') || barber.access?.email : phoneValue;
      setMessage(
        `Olá, ${barber.name.split(' ')[0]}! ${reset ? 'Sua nova senha' : 'Seu acesso à agenda da barbearia'}:\n\n${location.origin}\nLogin: ${login}\nSenha: ${password}\n\nLá você vê seus horários, o que cada cliente pediu para separar, fecha os atendimentos e acompanha suas comissões.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const target = (barber.access?.phone ?? phoneValue).replace(/\D/g, '');
  return (
    <Modal title={reset ? `Nova senha · ${barber.name}` : `Acesso de ${barber.name}`} onClose={onClose}>
      {message ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600">Pronto! Mande o acesso para o barbeiro:</p>
          <textarea readOnly className="h-44 w-full rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm" value={message} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(message);
                setCopied(true);
              }}
            >
              <Copy className="size-4" /> {copied ? 'Copiado!' : 'Copiar'}
            </Button>
            {target.length >= 10 && (
              <a
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                href={whatsappLink(target, message)}
                target="_blank"
                rel="noreferrer"
              >
                Enviar pelo WhatsApp
              </a>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!reset && (
            <>
              <Field label="Celular do barbeiro (é o login)">
                <Input type="tel" required placeholder="(11) 98888-7777" value={phoneValue} onChange={(e) => setPhoneValue(e.target.value)} />
              </Field>
              <Field label="E-mail (opcional)" hint="Também pode entrar com ele.">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            </>
          )}
          <Field label={reset ? 'Nova senha' : 'Senha inicial'} hint="Ele pode trocar depois em Minha conta.">
            <Input required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <p className="flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />O barbeiro vê só a agenda dele, o que os clientes pediram para separar e as próprias comissões. Não vê o
            caixa nem os ganhos dos colegas.
          </p>
          <ErrorText error={error} />
          <Button type="submit" loading={busy} className="w-full">
            {reset ? 'Salvar nova senha' : 'Criar acesso'}
          </Button>
        </form>
      )}
    </Modal>
  );
}
