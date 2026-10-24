import { CreditCard, Lock } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { date, money } from '../lib/format';
import { Badge, Button, Card, ErrorText, Field, Input } from './ui';

/** Formas e situações dos pagamentos online (como o Asaas devolve). */
export const PAY_METHOD: Record<string, string> = {
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  PIX: 'PIX',
  BOLETO: 'Boleto',
  UNDEFINED: 'A escolher',
};

export const PAY_STATUS: Record<string, { label: string; tone: 'green' | 'gold' | 'red' | 'zinc' }> = {
  PENDING: { label: 'Aguardando', tone: 'gold' },
  CONFIRMED: { label: 'Aprovado', tone: 'green' },
  RECEIVED: { label: 'Recebido', tone: 'green' },
  RECEIVED_IN_CASH: { label: 'Baixado à mão', tone: 'zinc' },
  OVERDUE: { label: 'Vencido', tone: 'red' },
  DELETED: { label: 'Cancelado', tone: 'zinc' },
  REFUNDED: { label: 'Estornado', tone: 'zinc' },
  CHARGEBACK: { label: 'Contestado', tone: 'red' },
};

export const payStatus = (s: string) => PAY_STATUS[s] ?? { label: s, tone: 'zinc' as const };

const cpfMask = (v: string) =>
  v
    .replace(/\D/g, '')
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');

/**
 * Pagar com cartão (na área do cliente): abre a página segura do Asaas. Na primeira vez pede o CPF,
 * que vai só para o Asaas (o banco exige).
 */
export function OnlinePayButton({ slug, chargeId, needsCpf, accent, label = 'Pagar com cartão' }: { slug: string; chargeId: number; needsCpf: boolean; accent: string; label?: string }) {
  const [askCpf, setAskCpf] = useState(false);
  const [cpf, setCpf] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Voltou da página do Asaas pelo "voltar" do navegador (página restaurada da memória): recarrega
  // para mostrar a situação atualizada.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && location.reload();
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  async function pay(e?: FormEvent) {
    e?.preventDefault();
    if (needsCpf && !askCpf) {
      setAskCpf(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>('POST', `/api/customer/${slug}/charges/${chargeId}/pay-online`, needsCpf ? { cpf } : {});
      location.assign(r.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={pay} className="space-y-2">
      {askCpf && (
        <Field label="Seu CPF" hint="O banco pede o CPF para pagamentos com cartão. Ele vai só para o Asaas, que processa o pagamento; a barbearia não guarda.">
          <Input autoFocus required inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" value={cpf} onChange={(e) => setCpf(cpfMask(e.target.value))} />
        </Field>
      )}
      <ErrorText error={error} />
      <Button type="submit" className="w-full" variant="ghost" loading={busy} style={askCpf ? { background: accent, color: '#09090b' } : undefined}>
        <CreditCard className="size-4" /> {askCpf ? 'Continuar para o pagamento' : label}
      </Button>
      <p className="flex items-center justify-center gap-1 text-center text-xs text-zinc-500">
        <Lock className="size-3" /> Página segura do Asaas. A confirmação é automática.
      </p>
    </form>
  );
}

// ---------- painel da barbearia

interface OnlineStatus {
  available: boolean;
  platform: boolean;
  feePct: number;
  reason: string | null;
}

interface OnlineReceipt {
  id: number;
  kind: 'clube' | 'sinal';
  customer: string | null;
  description: string | null;
  value_cents: number;
  net_cents: number | null;
  toShop: number;
  method: string | null;
  status: string;
  paid: boolean;
  duplicate: number;
  created_at: string;
  paid_at: string | null;
}

interface OnlineSettings {
  enabled: boolean;
  walletId: string | null;
  status: OnlineStatus;
  payments: OnlineReceipt[];
}

/**
 * Receber com cartão: a barbearia informa a carteira (Wallet ID) da conta Asaas dela, que recebe o
 * repasse de cada pagamento. Só aparece depois que a plataforma libera os pagamentos online.
 */
export function OnlineSettingsCard({ compact, onSaved }: { compact?: boolean; onSaved?: (available: boolean) => void }) {
  const [data, setData] = useState<OnlineSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [wallet, setWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const apply = (s: OnlineSettings) => {
    setData(s);
    setEnabled(s.enabled);
    setWallet(s.walletId ?? '');
  };
  useEffect(() => {
    api<OnlineSettings>('GET', '/api/shop/online').then(apply, () => undefined);
  }, []);
  if (!data?.status.platform) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const s = await api<OnlineSettings>('PUT', '/api/shop/online', { enabled, walletId: wallet });
      apply(s);
      setSaved(true);
      onSaved?.(s.status.available);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const fee = data.status.feePct;
  const shown = all ? data.payments : data.payments.slice(0, 6);
  return (
    <Card className="space-y-3">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <div className="flex items-start justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold">
              <CreditCard className="size-4" /> Receber com cartão
            </p>
            <Badge tone={data.status.available ? 'green' : 'zinc'}>{data.status.available ? 'Ligado' : 'Desligado'}</Badge>
          </div>
          <p className="text-sm text-zinc-500">
            Na área dele, o cliente paga a mensalidade do clube (cartão, boleto ou PIX) e o sinal (cartão) numa página segura do Asaas. O dinheiro vai para a sua
            conta Asaas, descontada a taxa do Asaas{fee > 0 ? ` e a da plataforma (${String(fee).replace('.', ',')}%)` : ''}, e o pagamento é baixado aqui sozinho.
          </p>
        </div>
        <Field label="Wallet ID da sua conta Asaas" hint="Abra sua conta no Asaas e, em Integrações, copie o Wallet ID (36 caracteres, com hífens).">
          <Input
            value={wallet}
            autoComplete="off"
            spellCheck={false}
            placeholder="1a2b3c4d-0000-0000-0000-000000000000"
            className="font-mono text-xs"
            onChange={(e) => {
              setSaved(false);
              setWallet(e.target.value);
            }}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={enabled}
            onChange={(e) => {
              setSaved(false);
              setEnabled(e.target.checked);
            }}
          />{' '}
          Oferecer pagamento com cartão aos clientes
        </label>
        <ErrorText error={error} />
        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy}>
            Salvar
          </Button>
          {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
        </div>
      </form>

      {!compact && data.payments.length > 0 && (
        <div className="border-t border-zinc-100 pt-3">
          <p className="mb-1 text-sm font-semibold">Recebidos online</p>
          <ul className="divide-y divide-zinc-100 text-sm">
            {shown.map((p) => {
              const st = payStatus(p.status);
              return (
                <li key={p.id} className="py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{p.customer ?? 'Cliente'}</span>
                      <span className="block text-xs text-zinc-500">
                        {p.kind === 'clube' ? 'Clube' : 'Sinal'} · {date(p.paid_at ?? p.created_at.slice(0, 10))}
                        {p.method && p.method !== 'UNDEFINED' && ` · ${PAY_METHOD[p.method] ?? p.method}`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <b className="block tabular-nums">{money(p.value_cents)}</b>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </span>
                  </div>
                  {p.paid && p.net_cents != null && <p className="text-xs text-zinc-500">Você recebe {money(p.toShop)} na conta Asaas.</p>}
                  {Boolean(p.duplicate) && (
                    <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900">
                      Pago duas vezes (online e de outro jeito): devolva {money(p.value_cents)} ao cliente por PIX.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {data.payments.length > shown.length && (
            <button className="mt-1 text-xs font-medium text-zinc-600 underline" onClick={() => setAll(true)}>
              Ver todos
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
