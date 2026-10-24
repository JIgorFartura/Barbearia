import { CreditCard, Lock } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { date, money } from '../lib/format';
import { CopyField } from './CopyField';
import { Badge, Button, Card, ErrorText, Field, Input } from './ui';

/** Formas e situações dos pagamentos online (cartão pela Cielo; PIX e boleto pelo Asaas). */
export const PAY_METHOD: Record<string, string> = {
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  PIX: 'PIX',
  BOLETO: 'Boleto',
  UNDEFINED: 'A escolher',
};

export const PAY_STATUS: Record<string, { label: string; tone: 'green' | 'gold' | 'red' | 'zinc' }> = {
  PENDING: { label: 'Aguardando', tone: 'gold' },
  AUTHORIZED: { label: 'Autorizado', tone: 'gold' },
  CONFIRMED: { label: 'Aprovado', tone: 'green' },
  RECEIVED: { label: 'Recebido', tone: 'green' },
  RECEIVED_IN_CASH: { label: 'Baixado à mão', tone: 'zinc' },
  OVERDUE: { label: 'Vencido', tone: 'red' },
  DENIED: { label: 'Recusado', tone: 'red' },
  EXPIRED: { label: 'Não concluído', tone: 'zinc' },
  CANCELLED: { label: 'Cancelado', tone: 'zinc' },
  DELETED: { label: 'Cancelado', tone: 'zinc' },
  REFUNDED: { label: 'Estornado', tone: 'zinc' },
  CHARGEBACK: { label: 'Contestado', tone: 'red' },
};

export const payStatus = (s: string) => PAY_STATUS[s] ?? { label: s, tone: 'zinc' as const };

/** Volta da página da Cielo pelo "voltar" do navegador (página restaurada da memória): recarrega. */
export function useReloadOnBack() {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && location.reload();
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);
}

/**
 * Pagar no cartão (na área do cliente): abre a página segura da Cielo. No sinal, pagamento avulso; no
 * clube, o cartão fica cadastrado e a Cielo cobra sozinha todo mês.
 */
export function OnlinePayButton({
  slug,
  chargeId,
  label = 'Pagar com cartão',
  hint = 'Página segura da Cielo. A confirmação é automática.',
}: {
  slug: string;
  chargeId: number;
  label?: string;
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReloadOnBack();

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>('POST', `/api/customer/${slug}/charges/${chargeId}/pay-online`, {});
      location.assign(r.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <ErrorText error={error} />
      <Button type="button" className="w-full" variant="ghost" loading={busy} onClick={pay}>
        <CreditCard className="size-4" /> {label}
      </Button>
      <p className="flex items-center justify-center gap-1 text-center text-xs text-zinc-500">
        <Lock className="size-3 shrink-0" /> {hint}
      </p>
    </div>
  );
}

// ---------- painel da barbearia

interface CardStatus {
  available: boolean;
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

interface CardSettings {
  clientId: string | null;
  secretHint: string | null;
  enabled: boolean;
  feePct: number;
  webhookUrl: string | null;
  returnUrl: string;
  webhookAt: string | null;
  status: CardStatus;
  payments: OnlineReceipt[];
}

const pct = (n: number) => String(n).replace('.', ',');

/**
 * Receber no cartão pela Cielo da barbearia: o cliente assina o clube no cartão (a Cielo cobra sozinha
 * todo mês) e paga o sinal. O dinheiro cai na conta Cielo da barbearia e a baixa aqui é automática.
 */
export function OnlineSettingsCard() {
  const [data, setData] = useState<CardSettings | null>(null);
  const [form, setForm] = useState({ clientId: '', clientSecret: '', enabled: false, feePct: '3,48' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const apply = (s: CardSettings) => {
    setData(s);
    setForm({ clientId: s.clientId ?? '', clientSecret: '', enabled: s.enabled, feePct: pct(s.feePct) });
  };
  useEffect(() => {
    api<CardSettings>('GET', '/api/shop/online').then(apply, () => undefined);
  }, []);
  if (!data) return null;
  const set = (patch: Partial<typeof form>) => {
    setMsg(null);
    setForm({ ...form, ...patch });
  };

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      apply(await api<CardSettings>('PUT', '/api/shop/online', { ...form, feePct: Number(form.feePct.replace(',', '.')) || 0 }));
    }, 'Salvo!');
  };

  const shown = all ? data.payments : data.payments.slice(0, 6);
  return (
    <Card className="space-y-3">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <div className="flex items-start justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold">
              <CreditCard className="size-4" /> Receber no cartão (Cielo)
            </p>
            <Badge tone={data.status.available ? 'green' : 'zinc'}>{data.status.available ? 'Ligado' : 'Desligado'}</Badge>
          </div>
          <p className="text-sm text-zinc-500">
            O cliente assina o clube no cartão (a Cielo cobra sozinha todo mês) e paga o sinal, numa página segura da Cielo. O dinheiro cai na sua conta Cielo em 1
            dia útil (com o Recebimento Automático ligado na Cielo) e a baixa aqui é automática.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ClientId">
            <Input value={form.clientId} autoComplete="off" spellCheck={false} className="font-mono text-xs" onChange={(e) => set({ clientId: e.target.value })} />
          </Field>
          <Field label="Client Secret" hint={data.secretHint ? 'Deixe em branco para manter o atual.' : undefined}>
            <Input
              type="password"
              value={form.clientSecret}
              autoComplete="off"
              placeholder={data.secretHint ?? ''}
              className="font-mono text-xs"
              onChange={(e) => set({ clientSecret: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-zinc-500">
          No site da Cielo, contrate o Link de Pagamento (sem mensalidade) e pegue as credenciais da API em Configurações. Lá mesmo, cole as URLs abaixo.
        </p>
        {data.webhookUrl && (
          <div className="space-y-2 rounded-xl bg-zinc-50 p-3">
            <CopyField label="URL de notificação e de mudança de status" value={data.webhookUrl} hint="Cole nos dois campos. É por ela que a Cielo avisa cada pagamento." />
            <CopyField label="URL de retorno" value={data.returnUrl} hint="Para onde o cliente volta depois de pagar." />
            <p className={`text-xs ${data.webhookAt ? 'text-emerald-700' : 'text-zinc-500'}`}>
              {data.webhookAt
                ? `Funcionando: último aviso da Cielo em ${new Date(data.webhookAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`
                : 'Nenhum aviso da Cielo ainda. Faça um pagamento de teste para conferir.'}
            </p>
          </div>
        )}
        <div className="grid items-end gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Taxa do cartão (%)">
            <Input inputMode="decimal" value={form.feePct} onChange={(e) => set({ feePct: e.target.value })} />
          </Field>
          <p className="pb-2 text-xs text-zinc-500">Lançada no caixa em cada pagamento, para o saldo bater com o que cai na conta. Confira a sua no app da Cielo.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Oferecer pagamento no cartão aos
          clientes
        </label>
        <ErrorText error={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={busy}>
            Salvar
          </Button>
          {data.clientId && data.secretHint && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => run(() => api('POST', '/api/shop/online/test'), 'Conexão com a Cielo funcionando.')}>
              Testar conexão
            </Button>
          )}
          {msg && <span className="text-sm text-emerald-700">{msg}</span>}
        </div>
      </form>

      {data.payments.length > 0 && (
        <div className="border-t border-zinc-100 pt-3">
          <p className="mb-1 text-sm font-semibold">Recebidos no cartão</p>
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
                  {p.paid && p.net_cents != null && <p className="text-xs text-zinc-500">Cai na sua conta cerca de {money(p.toShop)}, já sem a taxa.</p>}
                  {Boolean(p.duplicate) && (
                    <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900">
                      Pago duas vezes (ou depois de cancelar): devolva {money(p.value_cents)} ao cliente (estorno no site da Cielo ou PIX).
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
