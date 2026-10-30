import { Copy, CreditCard, Lock } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useReloadOnBack } from '../../components/OnlinePay';
import { Badge, Button, Card, ErrorText, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { date, money } from '../../lib/format';

interface Invoice {
  id: number;
  reference: string;
  description: string;
  amount_cents: number;
  due_date: string;
  status: 'open' | 'paid' | 'cancelled';
  paid_at: string | null;
  informed_at: string | null;
  nfse_url: string | null;
  overdue: boolean;
}

interface SubscriptionData {
  plan: string | null;
  price_cents: number;
  billing_day: number;
  trial_until: string | null;
  courtesy: { since: string; until: string | null; note: string | null } | null;
  billing_cycle: 'mensal' | 'anual';
  /** Oferta do plano anual (12 mensalidades com desconto). */
  annual: { price_cents: number; per_month_cents: number; discount_pct: number } | null;
  /** Fatura anual em aberto: parcelas no cartão (com juros a partir de certa parcela). */
  card_options: { n: number; each_cents: number; total_cents: number; interest: boolean }[];
  /** Já escolheu pagar no cartão em N vezes (a página do Asaas está em current.payUrl). */
  installments: number | null;
  blocked: boolean;
  graceDays: number;
  blockOn: string | null;
  /**
   * Fatura em aberto. Com o Asaas: PIX com baixa automática (auto) e a página do Asaas. Sem ele: PIX do
   * master, confirmado à mão. byCard: será cobrada sozinha no cartão automático (Cielo).
   */
  current: (Invoice & { pix: { payload: string; qr: string; auto?: boolean } | null; payUrl: string | null; pixError: string | null; byCard: boolean }) | null;
  /** Cartão automático pela Cielo: a mensalidade é cobrada sozinha todo mês, no mesmo dia. */
  card: { available: boolean; active: boolean; amount_cents: number | null; since: string | null; last_paid_at: string | null; error: string | null };
  invoices: Invoice[];
  billing: { auto: boolean; needsDocument: boolean; billing_document: string | null; billing_name: string | null; billing_email: string | null };
}

/** Mensalidade da plataforma: fatura em aberto (PIX, cartão ou boleto) e histórico. */
export function Subscription() {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingInfo, setEditingInfo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [parcelas, setParcelas] = useState(1);
  const load = useCallback(() => {
    api<SubscriptionData>('GET', '/api/shop/subscription').then(setData, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useReloadOnBack();

  if (!data) return <ErrorText error={error} />;
  const cur = data.current;
  const card = data.card;
  // Pelo Asaas a fatura é baixada sozinha quando o pagamento cai (sem "Já paguei").
  const auto = Boolean(cur && (cur.payUrl || cur.pix?.auto));

  const annualCur = Boolean(cur?.reference.startsWith('anual:'));

  async function goAnnual() {
    if (!data?.annual || !confirm(`Passar para o plano anual por ${money(data.annual.price_cents)} por ano? A fatura anual sai agora.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/shop/subscription/annual');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Cartão de crédito (à vista ou parcelado) na página do Asaas. */
  async function payCardInstallments() {
    if (!cur) return;
    setBusy(true);
    setError(null);
    try {
      location.assign((await api<{ url: string }>('POST', `/api/shop/subscription/${cur.id}/card`, { installments: parcelas })).url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function resetCharge() {
    if (!cur) return;
    setError(null);
    try {
      await api('POST', `/api/shop/subscription/${cur.id}/reset-charge`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Abre a página da Cielo: paga a fatura em aberto e deixa o cartão cadastrado para os próximos meses. */
  async function payByCard() {
    setBusy(true);
    setError(null);
    try {
      location.assign((await api<{ url: string }>('POST', '/api/shop/subscription/card')).url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function stopCard() {
    if (!confirm('Desligar a cobrança automática no cartão? As próximas mensalidades você paga pelo PIX ou cadastra o cartão de novo.')) return;
    setError(null);
    try {
      await api('DELETE', '/api/shop/subscription/card');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const today = new Date().toLocaleDateString('en-CA');

  return (
    <section className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <CreditCard className="size-6" /> Mensalidade
        </h1>
        <p className="text-sm text-zinc-500">
          {data.plan ? `Plano ${data.plan} · ` : ''}
          {data.price_cents ? `${money(data.price_cents)} por mês, vence todo dia ${data.billing_day}` : 'Sem mensalidade definida'}
          {data.trial_until && data.trial_until >= today && ` · grátis até ${date(data.trial_until)}`}
        </p>
        {data.courtesy && (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">🎁 Sua barbearia está com <b>cortesia</b>: use tudo sem mensalidade.</p>
        )}
        {data.billing.auto && !data.billing.needsDocument && !editingInfo && (
          <button className="text-xs text-zinc-500 underline hover:text-zinc-900" onClick={() => setEditingInfo(true)}>
            Dados para a nota fiscal: {data.billing.billing_name}
          </button>
        )}
      </div>

      {data.blocked && (
        <div className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-red-900 ring-1 ring-red-200">
          <Lock className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">Acesso suspenso por mensalidade em atraso</p>
            <p className="text-sm">O site e a área dos clientes continuam no ar, mas o painel e o robô com IA ficam limitados até o pagamento ser confirmado.</p>
          </div>
        </div>
      )}

      {data.billing.auto && (data.billing.needsDocument || editingInfo) && (
        <BillingInfoCard
          info={data.billing}
          onSaved={() => {
            setEditingInfo(false);
            load();
          }}
        />
      )}

      {data.billing_cycle === 'mensal' && data.annual && (
        <Card className="max-w-xl space-y-2 ring-1 ring-amber-300">
          <p className="font-semibold">💰 Plano anual: {data.annual.discount_pct}% de desconto</p>
          <p className="text-sm text-zinc-600">
            {money(data.annual.price_cents)} por ano (equivale a {money(data.annual.per_month_cents)} por mês). Pague no PIX, no boleto ou no cartão em até 12x.
          </p>
          <Button variant="gold" loading={busy} onClick={goAnnual}>
            Passar para o anual
          </Button>
        </Card>
      )}

      {card.active && (
        <Card className="max-w-xl space-y-2">
          <p className="flex items-center gap-2 font-semibold">
            <CreditCard className="size-4 text-emerald-600" /> Cartão automático ligado
          </p>
          <p className="text-sm text-zinc-600">
            A Cielo cobra {card.amount_cents ? money(card.amount_cents) : 'a mensalidade'} todo mês, no vencimento (dia {data.billing_day}).
            {card.last_paid_at && ` Último pagamento: ${date(card.last_paid_at)}.`}
          </p>
          {card.error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{card.error}</p>}
          <button className="text-xs text-zinc-500 underline hover:text-red-600" onClick={stopCard}>
            Desligar o cartão automático
          </button>
        </Card>
      )}

      {cur ? (
        <Card className="max-w-xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">{cur.description}</p>
              <p className="text-sm text-zinc-500">Vencimento {date(cur.due_date)}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold tabular-nums">{money(cur.amount_cents)}</p>
              {cur.overdue ? <Badge tone="red">Vencida</Badge> : <Badge tone="gold">Em aberto</Badge>}
            </div>
          </div>
          {!data.blocked && cur.overdue && data.blockOn && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">⚠ Pague até {date(data.blockOn)} para não ter o acesso suspenso.</p>
          )}
          {cur.byCard && (
            <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <CreditCard className="size-4 shrink-0" /> Será cobrada sozinha no cartão, no vencimento ({date(cur.due_date)}).
            </p>
          )}
          {annualCur && data.installments && cur.payUrl && (
            <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
              <p className="text-sm font-medium">Cartão de crédito em {data.installments}x</p>
              <a
                href={cur.payUrl}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700"
              >
                <CreditCard className="size-4" /> Abrir a página de pagamento
              </a>
              <button className="text-xs text-zinc-500 underline hover:text-zinc-900" onClick={resetCharge}>
                Trocar a forma de pagamento (PIX ou boleto)
              </button>
            </div>
          )}
          {annualCur && !data.installments && data.card_options.length > 0 && (
            <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
              <p className="text-sm font-medium">Cartão de crédito</p>
              <select className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm" value={parcelas} onChange={(e) => setParcelas(Number(e.target.value))}>
                {data.card_options.map((o) => (
                  <option key={o.n} value={o.n}>
                    {o.n}x de {money(o.each_cents)}
                    {o.interest ? ` (total ${money(o.total_cents)}, com juros)` : ' sem juros'}
                  </option>
                ))}
              </select>
              <Button className="w-full" loading={busy} onClick={payCardInstallments}>
                <CreditCard className="size-4" /> Pagar no cartão
              </Button>
              <p className="text-center text-xs text-zinc-500">Página segura do Asaas: o cartão é digitado lá. Ou pague abaixo no PIX ou no boleto.</p>
            </div>
          )}
          {card.available && !cur.byCard && !annualCur && (
            <div className="space-y-1">
              <Button className="w-full" loading={busy} onClick={payByCard}>
                <CreditCard className="size-4" /> {card.active ? 'Usar outro cartão' : 'Pagar no cartão e deixar automático'}
              </Button>
              <p className="text-center text-xs text-zinc-500">
                Página segura da Cielo. Ela cobra o mesmo valor todo mês, no mesmo dia (a mensalidade passa a vencer nesse dia). Desligue quando quiser.
              </p>
            </div>
          )}
          {card.available && !cur.byCard && !annualCur && cur.pix && <p className="text-center text-xs text-zinc-400">ou pague este mês no PIX</p>}
          {cur.pix && (
            <div className="grid items-center gap-4 sm:grid-cols-[180px_1fr]">
              <img src={cur.pix.qr} alt="QR Code PIX" className="mx-auto size-44 rounded-lg ring-1 ring-zinc-200" />
              <div className="space-y-2">
                <p className="text-sm font-medium">PIX copia e cola</p>
                <textarea readOnly className="h-24 w-full resize-none rounded-lg border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px]" value={cur.pix.payload} onFocus={(e) => e.target.select()} />
                <Button
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(cur.pix!.payload);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Copy className="size-4" /> {copied ? 'Copiado!' : 'Copiar código'}
                </Button>
              </div>
            </div>
          )}
          {cur.payUrl && (!card.available || annualCur) && !data.installments && (
            <a
              href={cur.payUrl}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700"
            >
              <CreditCard className="size-4" /> {annualCur ? 'Pagar com boleto' : cur.pix ? 'Pagar com cartão ou boleto' : 'Pagar com cartão, boleto ou PIX'}
            </a>
          )}
          {!cur.pix && !cur.payUrl && !card.available && <p className="text-sm text-zinc-500">Fale com o administrador da plataforma para receber os dados de pagamento.</p>}
          {auto && !cur.byCard && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              A confirmação é automática: alguns minutos depois do pagamento, a fatura fica paga sozinha (no cartão, na hora da aprovação).
            </p>
          )}
          {cur.pixError && <p className="text-xs text-zinc-500">Cobrança automática indisponível agora ({cur.pixError}). Use o PIX acima.</p>}
          {!auto && (cur.pix || cur.informed_at) && (
            <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
              {cur.informed_at ? (
                <p className="text-sm text-emerald-700">Pagamento informado em {date(cur.informed_at)}. Assim que for confirmado, a fatura fica como paga.</p>
              ) : (
                <Button onClick={() => api('POST', `/api/shop/subscription/${cur.id}/inform`).then(load, (e) => setError(e.message))}>Já paguei</Button>
              )}
            </div>
          )}
          <ErrorText error={error} />
        </Card>
      ) : (
        <Card className="max-w-xl">
          <p className="font-semibold">Tudo em dia ✓</p>
          <p className="text-sm text-zinc-500">
            Nenhuma fatura em aberto.{card.available && !card.active ? ' Na próxima mensalidade, você pode pagar no cartão e deixar automático.' : ''}
          </p>
        </Card>
      )}

      {data.invoices.length > 0 && (
        <div className="max-w-xl">
          <p className="mb-2 font-semibold">Histórico</p>
          <Card className="!p-0">
            <ul className="divide-y divide-zinc-100 text-sm">
              {data.invoices.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span>
                    {i.description}
                    <span className="text-zinc-500"> · vence {date(i.due_date)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {i.nfse_url && (
                      <a href={i.nfse_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-zinc-600 underline">
                        Nota fiscal
                      </a>
                    )}
                    <span className="tabular-nums">{money(i.amount_cents)}</span>
                    <Badge tone={i.status === 'paid' ? 'green' : i.status === 'cancelled' ? 'zinc' : i.overdue ? 'red' : 'gold'}>
                      {i.status === 'paid' ? `Paga ${date(i.paid_at)}` : i.status === 'cancelled' ? 'Cancelada' : i.overdue ? 'Vencida' : 'Em aberto'}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </section>
  );
}

/** CPF/CNPJ e nome para a cobrança automática (Asaas) e a nota fiscal da mensalidade. */
function BillingInfoCard({ info, onSaved }: { info: SubscriptionData['billing']; onSaved: () => void }) {
  const [document, setDocument] = useState(info.billing_document ?? '');
  const [name, setName] = useState(info.billing_name ?? '');
  const [email, setEmail] = useState(info.billing_email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/api/shop/billing-info', { document, name, email });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <p className="font-semibold">Dados para a cobrança e a nota fiscal</p>
          <p className="text-sm text-zinc-500">Com eles, você paga a mensalidade por PIX, cartão ou boleto, com confirmação automática, e a nota fiscal vem no seu nome.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CPF ou CNPJ">
            <Input required inputMode="numeric" value={document} placeholder="00.000.000/0001-00" onChange={(e) => setDocument(e.target.value)} />
          </Field>
          <Field label="Nome ou razão social">
            <Input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label="E-mail para a nota (opcional)">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" loading={busy}>
          Salvar
        </Button>
      </form>
    </Card>
  );
}
