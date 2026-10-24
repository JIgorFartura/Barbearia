import { Ban, Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, ImageInput, Input, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { WEEKDAYS, WEEKDAYS_SHORT, cap, hourLabel, stampLabel, todayStr } from '../../lib/format';

interface Hours {
  weekday: number;
  start_time: string;
  end_time: string;
}

interface Barber {
  id: number;
  name: string;
  photo_url: string | null;
  active: number;
  hours: Hours[];
  blocks: { id: number; starts_at: string; ends_at: string; reason: string | null }[];
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Barber[]>('GET', '/api/shop/barbers').then(setList, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

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
    </section>
  );
}

function BarberModal({ barber, onClose, onDone }: { barber: Partial<Barber>; onClose: () => void; onDone: (list: Barber[]) => void }) {
  const [name, setName] = useState(barber.name ?? '');
  const [photo, setPhoto] = useState<string | null>(barber.photo_url ?? null);
  const [active, setActive] = useState(barber.active !== 0);
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
      const body = { name, photo_url: photo, active, hours: fromForm(days) };
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
