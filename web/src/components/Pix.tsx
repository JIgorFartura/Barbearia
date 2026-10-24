import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { METHODS, type Method } from '../lib/finance';
import { date, money, phone as fmtPhone } from '../lib/format';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, inputClass } from './ui';

type PixType = 'cpf' | 'celular' | 'email' | 'aleatoria';

interface PixSettings {
  pix_type: PixType | null;
  pix_key: string | null;
  pix_name: string | null;
  pix_city: string | null;
}

const TYPES: { id: PixType; label: string; placeholder: string }[] = [
  { id: 'cpf', label: 'CPF ou CNPJ', placeholder: 'Só os números' },
  { id: 'celular', label: 'Celular', placeholder: '(11) 98888-7777' },
  { id: 'email', label: 'E-mail', placeholder: 'pix@suabarbearia.com' },
  { id: 'aleatoria', label: 'Chave aleatória', placeholder: '1a2b3c4d-....' },
];

/** Como a chave salva aparece no campo (celular sem o +55). */
const keyForInput = (s: PixSettings) => (s.pix_type === 'celular' && s.pix_key ? fmtPhone(s.pix_key.slice(3)) : (s.pix_key ?? ''));

/** Chave PIX da barbearia: o cliente paga direto na conta dela (clube de assinatura e sinal). */
export function PixSettingsCard({ onSaved }: { onSaved?: (hasKey: boolean) => void }) {
  const [form, setForm] = useState<{ pix_type: PixType; pix_key: string; pix_name: string; pix_city: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PixSettings>('GET', '/api/shop/pix').then((s) =>
      setForm({ pix_type: s.pix_type ?? 'cpf', pix_key: keyForInput(s), pix_name: s.pix_name ?? '', pix_city: s.pix_city ?? '' }),
    );
  }, []);
  if (!form) return null;
  const set = (patch: Partial<typeof form>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api<PixSettings>('PUT', '/api/shop/pix', form);
      setForm({ pix_type: s.pix_type ?? form.pix_type, pix_key: keyForInput(s), pix_name: s.pix_name ?? '', pix_city: s.pix_city ?? '' });
      setSaved(true);
      onSaved?.(Boolean(s.pix_key));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const type = TYPES.find((t) => t.id === form.pix_type)!;
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <p className="font-semibold">Receber por PIX</p>
          <p className="text-sm text-zinc-500">
            O cliente paga direto na sua conta, sem taxa da plataforma. Você confere no extrato do banco e confirma aqui. Sem chave, o cliente paga no balcão.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Tipo de chave">
            <select className={inputClass} value={form.pix_type} onChange={(e) => set({ pix_type: e.target.value as PixType })}>
              {TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Chave PIX">
            <Input value={form.pix_key} placeholder={type.placeholder} onChange={(e) => set({ pix_key: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome que aparece no PIX" hint="Até 25 letras, sem acento.">
            <Input value={form.pix_name} maxLength={25} placeholder="Barbearia Navalha" onChange={(e) => set({ pix_name: e.target.value })} />
          </Field>
          <Field label="Cidade" hint="Até 15 letras.">
            <Input value={form.pix_city} maxLength={15} placeholder="Sao Paulo" onChange={(e) => set({ pix_city: e.target.value })} />
          </Field>
        </div>
        <ErrorText error={error} />
        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy}>
            Salvar chave
          </Button>
          {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
        </div>
      </form>
    </Card>
  );
}

/** QR Code e PIX copia e cola para o cliente pagar. */
export function PixPay({ pix }: { pix: { payload: string; qr: string } }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(pix.payload);
    } catch {
      // Navegador sem acesso à área de transferência: seleciona o texto para copiar à mão.
      const el = document.getElementById('pix-payload') as HTMLTextAreaElement | null;
      el?.select();
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }
  return (
    <div className="space-y-2 text-center">
      <img src={pix.qr} alt="QR Code do PIX" className="mx-auto size-48 rounded-lg ring-1 ring-zinc-200" />
      <textarea id="pix-payload" readOnly value={pix.payload} rows={3} className="w-full resize-none rounded-lg bg-zinc-50 p-2 font-mono text-[11px] break-all text-zinc-600 ring-1 ring-zinc-200" />
      <Button type="button" variant="ghost" className="w-full" onClick={copy}>
        {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        {copied ? 'Copiado!' : 'Copiar PIX copia e cola'}
      </Button>
    </div>
  );
}

export interface ChargeRow {
  id: number;
  kind: 'clube' | 'sinal';
  customer_name: string;
  phone: string;
  description: string;
  amount_cents: number;
  due_date: string | null;
  claimed_at: string | null;
}

/** PIX que os clientes avisaram que pagaram: o dono confere no banco e confirma (ou não). */
export function PixConfirmModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<ChargeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>('pix');
  const load = () => api<ChargeRow[]>('GET', '/api/shop/charges/to-confirm').then(setRows, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function act(c: ChargeRow, action: 'confirm' | 'reject') {
    setError(null);
    try {
      await api('POST', `/api/shop/charges/${c.id}/${action}`, action === 'confirm' ? { method } : undefined);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title="PIX para conferir" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-zinc-500">Os clientes avisaram que pagaram. Confira no extrato do banco: se caiu, confirme e o valor entra no caixa.</p>
        <ErrorText error={error} />
        {rows && rows.length > 0 && (
          <Field label="Recebido como">
            <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {rows?.length === 0 && <p className="py-4 text-center text-sm text-zinc-500">Tudo conferido. 👍</p>}
        <ul className="space-y-2">
          {rows?.map((c) => (
            <li key={c.id} className="rounded-xl px-3 py-2.5 ring-1 ring-zinc-200">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{c.customer_name}</p>
                  <p className="text-xs text-zinc-500">
                    {c.description} · avisou em {date(c.claimed_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold whitespace-nowrap tabular-nums">{money(c.amount_cents)}</p>
                  <Badge tone={c.kind === 'clube' ? 'gold' : 'zinc'}>{c.kind === 'clube' ? 'Clube' : 'Sinal'}</Badge>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <Button className="flex-1 !py-1.5" onClick={() => act(c, 'confirm')}>
                  Caiu na conta
                </Button>
                <Button variant="ghost" className="flex-1 !py-1.5" onClick={() => act(c, 'reject')}>
                  Não caiu
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
