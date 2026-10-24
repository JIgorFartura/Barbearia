import { useCallback, useEffect, useState } from 'react';
import { PixSettingsCard } from '../../components/Pix';
import { Badge, Button, ErrorText, Field, Input, Modal, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { centsToInput, parseMoney } from '../../lib/finance';
import { date, money, phone as fmtPhone } from '../../lib/format';

interface Settings {
  deposit_mode: 'off' | 'all' | 'no_show';
  deposit_cents: number;
  deposit_hold_min: number;
  deposit_credit_hours: number;
}

interface DepositRow {
  id: number;
  description: string;
  amount_cents: number;
  customer_name: string;
  phone: string;
  claimed_at: string | null;
  paid_at: string | null;
}

interface Overview {
  settings: Settings;
  hasPix: boolean;
  /** Aceita cartão (Cielo da barbearia, com baixa automática). */
  online: boolean;
  open: DepositRow[];
  credits: DepositRow[];
}

/** Sinal do horário nas listas (agenda, comanda). */
export interface DepositState {
  id: number;
  amount_cents: number;
  state: 'paid' | 'claimed' | 'open';
  expires_local: string | null;
}

export function DepositBadge({ deposit }: { deposit: DepositState | null | undefined }) {
  if (!deposit) return null;
  if (deposit.state === 'paid') return <Badge tone="green">Sinal pago {money(deposit.amount_cents)}</Badge>;
  if (deposit.state === 'claimed') return <Badge tone="gold">Sinal avisado: conferir</Badge>;
  return <Badge tone="gold">Esperando sinal{deposit.expires_local ? ` até ${deposit.expires_local.slice(11)}` : ''}</Badge>;
}

const HOLD = [
  { value: 30, label: '30 minutos' },
  { value: 60, label: '1 hora' },
  { value: 120, label: '2 horas' },
  { value: 180, label: '3 horas' },
];
const CREDIT = [
  { value: 2, label: '2 horas antes' },
  { value: 6, label: '6 horas antes' },
  { value: 12, label: '12 horas antes' },
  { value: 24, label: '24 horas antes' },
  { value: 48, label: '48 horas antes' },
];

/** Configuração do sinal via PIX ou cartão (contra falta) e os créditos de sinal dos clientes. */
export function DepositModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<Overview>('GET', '/api/shop/deposits').then((o) => {
        setData(o);
        setForm((f) => f ?? o.settings);
        setAmount((a) => a || centsToInput(o.settings.deposit_cents));
      }),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!data || !form) return null;

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setData(await api<Overview>('PUT', '/api/shop/deposits/settings', { ...form, deposit_cents: parseMoney(amount) }));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function refund(c: DepositRow) {
    if (!confirm(`Devolver ${money(c.amount_cents)} de sinal para ${c.customer_name}? Faça o PIX de volta para o cliente; aqui sai do caixa.`)) return;
    setError(null);
    try {
      await api('POST', `/api/shop/charges/${c.id}/refund`, { method: 'pix' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const set = (patch: Partial<Settings>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  return (
    <Modal title="Sinal para segurar o horário" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-zinc-500">
          Quem marca pelo site ou pelo WhatsApp paga um sinal por PIX{data.online ? ' ou cartão' : ''} para garantir a vaga. Sem o pagamento no prazo, o horário é
          liberado sozinho. No dia, o sinal é descontado na comanda. Assinantes do clube não pagam sinal.
        </p>
        {data.online && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">Cartão ligado: o cliente também pode pagar o sinal com cartão, e a baixa é automática.</p>
        )}
        {!data.hasPix && !data.online && <PixSettingsCard onSaved={() => load()} />}
        <div className="space-y-2">
          {(
            [
              ['off', 'Não cobrar sinal'],
              ['no_show', 'Só de quem já faltou (nos últimos 6 meses)'],
              ['all', 'De todos que marcam pelo site ou WhatsApp'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" checked={form.deposit_mode === value} onChange={() => set({ deposit_mode: value })} /> {label}
            </label>
          ))}
        </div>
        {form.deposit_mode !== 'off' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Valor do sinal (R$)">
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setSaved(false);
                  setAmount(e.target.value);
                }}
              />
            </Field>
            <Field label="Prazo para pagar">
              <select className={inputClass} value={form.deposit_hold_min} onChange={(e) => set({ deposit_hold_min: Number(e.target.value) })}>
                {HOLD.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Vira crédito se cancelar até">
              <select className={inputClass} value={form.deposit_credit_hours} onChange={(e) => set({ deposit_credit_hours: Number(e.target.value) })}>
                {CREDIT.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {form.deposit_mode !== 'off' && (
          <p className="text-xs text-zinc-500">Cancelou depois disso ou faltou: a barbearia fica com o sinal. Se a barbearia cancelar, o sinal sempre vira crédito.</p>
        )}
        <ErrorText error={error} />
        <div className="flex items-center gap-3">
          <Button loading={busy} onClick={save}>
            Salvar
          </Button>
          {saved && <span className="text-emerald-700">Salvo!</span>}
        </div>
        {!data.online && (
          <p className="text-xs text-zinc-500">
            Quer receber o sinal também no cartão? Ligue a sua conta Cielo em Clube de assinatura → Receber no cartão.
          </p>
        )}

        {data.open.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">Esperando o pagamento</p>
            <ul className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
              {data.open.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block font-medium">{c.customer_name}</span>
                    <span className="text-xs text-zinc-500">{c.description}</span>
                  </span>
                  <span className="text-right text-xs whitespace-nowrap">
                    <b className="block text-sm tabular-nums">{money(c.amount_cents)}</b>
                    {c.claimed_at ? 'avisou que pagou' : 'não pagou ainda'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.credits.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">Créditos de sinal</p>
            <p className="mb-2 text-xs text-zinc-500">Valem automaticamente no próximo horário do cliente.</p>
            <ul className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
              {data.credits.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block font-medium">{c.customer_name}</span>
                    <span className="text-xs text-zinc-500">
                      {fmtPhone(c.phone)} · pago em {date(c.paid_at)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <b className="tabular-nums">{money(c.amount_cents)}</b>
                    <button className="text-xs text-zinc-500 hover:text-red-600" onClick={() => refund(c)}>
                      Devolver
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
