import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Button, EmptyState, ErrorText, Field, ImageInput, Input, Modal, inputClass } from './ui';

export type FieldDef =
  | { key: string; label: string; type: 'text' | 'textarea' | 'date' | 'url'; hint?: string; required?: boolean; placeholder?: string }
  | { key: string; label: string; type: 'money' | 'number'; hint?: string; required?: boolean; placeholder?: string }
  | { key: string; label: string; type: 'checkbox'; hint?: string }
  | { key: string; label: string; type: 'image'; hint?: string }
  | { key: string; label: string; type: 'select'; hint?: string; options: { value: string | number | null; label: string }[] };

export type Row = Record<string, any> & { id: number };

interface Props {
  title: string;
  description: string;
  endpoint: string;
  newLabel: string;
  fields: FieldDef[];
  defaults: Record<string, unknown>;
  empty: { icon: ReactNode; title: string; text: string };
  renderItem: (row: Row) => ReactNode;
  /** Filtra a lista (ex.: só serviços). */
  filter?: (row: Row) => boolean;
  onChange?: () => void;
}

/** Tela padrão de cadastro: lista em cartões + formulário em janela. */
export function CrudPage({ title, description, endpoint, newLabel, fields, defaults, empty, renderItem, filter, onChange }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<Row[]>('GET', endpoint).then(setRows, (e) => setError(e.message));
  }, [endpoint]);
  useEffect(load, [load]);

  const visible = rows?.filter(filter ?? (() => true));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { ...defaults };
    for (const f of fields) body[f.key] = editing[f.key] ?? null;
    for (const f of fields) {
      if (f.type === 'money') body[f.key] = Math.round(Number(String(editing[f.key] ?? '0').replace(',', '.')) * 100) || 0;
      if (f.type === 'number') body[f.key] = editing[f.key] === '' || editing[f.key] == null ? null : Number(editing[f.key]);
      if (f.type === 'checkbox') body[f.key] = Boolean(editing[f.key]);
    }
    try {
      await api(editing.id ? 'PUT' : 'POST', editing.id ? `${endpoint}/${editing.id}` : endpoint, body);
      setEditing(null);
      load();
      onChange?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: Row) {
    if (!confirm('Excluir este item? Essa ação não pode ser desfeita.')) return;
    await api('DELETE', `${endpoint}/${row.id}`).catch((e) => alert(e.message));
    load();
    onChange?.();
  }

  function open(row?: Row) {
    setError(null);
    const base: Record<string, any> = { ...defaults, ...(row ?? {}) };
    for (const f of fields) if (f.type === 'money') base[f.key] = ((base[f.key] ?? 0) / 100).toFixed(2).replace('.', ',');
    setEditing(base);
  }

  const set = (key: string, value: unknown) => setEditing((v) => ({ ...v, [key]: value }));

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-zinc-500">{description}</p>
        </div>
        <Button onClick={() => open()}>
          <Plus className="size-4" /> {newLabel}
        </Button>
      </div>

      {!editing && <ErrorText error={error} />}
      {visible && visible.length === 0 && (
        <EmptyState {...empty} action={<Button onClick={() => open()}>{newLabel}</Button>} />
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible?.map((row) => (
          <div key={row.id} className="group relative rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
            {renderItem(row)}
            <div className="mt-3 flex gap-2 border-t border-zinc-100 pt-3">
              <Button variant="ghost" className="!px-3 !py-1.5" onClick={() => open(row)}>
                <Pencil className="size-3.5" /> Editar
              </Button>
              <Button variant="danger" className="!px-3 !py-1.5" onClick={() => remove(row)}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Modal title={editing.id ? 'Editar' : newLabel} onClose={() => setEditing(null)}>
          <form onSubmit={save} className="space-y-4">
            {fields.map((f) => (
              <FieldInput key={f.key} field={f} value={editing[f.key]} onChange={(v) => set(f.key, v)} />
            ))}
            <ErrorText error={error} />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
              <Button type="submit" loading={saving}>
                Salvar
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function FieldInput({ field: f, value, onChange }: { field: FieldDef; value: any; onChange: (v: unknown) => void }) {
  switch (f.type) {
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {f.label}
        </label>
      );
    case 'image':
      return (
        <Field label={f.label} hint={f.hint}>
          <ImageInput value={value ?? null} onChange={onChange} />
        </Field>
      );
    case 'textarea':
      return (
        <Field label={f.label} hint={f.hint}>
          <textarea className={inputClass} rows={3} value={value ?? ''} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    case 'select':
      return (
        <Field label={f.label} hint={f.hint}>
          <select
            className={inputClass}
            value={value ?? ''}
            onChange={(e) => {
              const opt = f.options.find((o) => String(o.value ?? '') === e.target.value);
              onChange(opt ? opt.value : null);
            }}
          >
            {f.options.map((o) => (
              <option key={String(o.value)} value={String(o.value ?? '')}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      );
    default:
      return (
        <Field label={f.label} hint={f.hint}>
          <Input
            type={f.type === 'money' ? 'text' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : f.type}
            inputMode={f.type === 'money' ? 'decimal' : undefined}
            required={'required' in f && f.required}
            placeholder={'placeholder' in f ? f.placeholder : f.type === 'url' ? 'https://' : undefined}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );
  }
}
