import { ImagePlus, Loader2, X } from 'lucide-react';
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { uploadImage } from '../lib/api';

export function Button({
  variant = 'primary',
  loading,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'gold'; loading?: boolean }) {
  const styles = {
    primary: 'bg-zinc-900 text-white hover:bg-zinc-700',
    gold: 'bg-gold text-zinc-950 hover:brightness-110',
    ghost: 'bg-white text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-100',
    danger: 'bg-white text-red-600 ring-1 ring-red-200 hover:bg-red-50',
  }[variant];
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${styles} ${className}`}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-zinc-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 ${className}`}>{children}</div>;
}

export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: 'zinc' | 'green' | 'gold' | 'red' }) {
  const styles = {
    zinc: 'bg-zinc-100 text-zinc-600',
    green: 'bg-emerald-100 text-emerald-700',
    gold: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:bg-zinc-100" aria-label="Fechar">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ImageInput({ value, onChange }: { value: string | null; onChange: (url: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      {value ? (
        <img src={value} alt="" className="size-16 rounded-lg object-cover ring-1 ring-zinc-200" />
      ) : (
        <div className="flex size-16 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400">
          <ImagePlus className="size-6" />
        </div>
      )}
      <div className="space-y-1">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-zinc-200 hover:bg-zinc-100">
          {busy && <Loader2 className="size-4 animate-spin" />}
          {value ? 'Trocar imagem' : 'Enviar imagem'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              setError(null);
              try {
                onChange(await uploadImage(file));
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {value && (
          <button type="button" className="block text-xs text-zinc-500 hover:text-red-600" onClick={() => onChange(null)}>
            Remover
          </button>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-zinc-200 px-6 py-12 text-center">
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">{icon}</div>
      <p className="font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
