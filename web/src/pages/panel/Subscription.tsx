import { Copy, CreditCard, Lock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorText } from '../../components/ui';
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
  overdue: boolean;
}

interface SubscriptionData {
  plan: string | null;
  price_cents: number;
  billing_day: number;
  trial_until: string | null;
  blocked: boolean;
  graceDays: number;
  blockOn: string | null;
  current: (Invoice & { pix: { payload: string; qr: string } | null }) | null;
  invoices: Invoice[];
}

/** Mensalidade da plataforma: fatura em aberto com PIX e histórico. */
export function Subscription() {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<SubscriptionData>('GET', '/api/shop/subscription').then(setData, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (!data) return <ErrorText error={error} />;
  const cur = data.current;
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
          {cur.pix ? (
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
          ) : (
            <p className="text-sm text-zinc-500">Fale com o administrador da plataforma para receber os dados de pagamento.</p>
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
            {cur.informed_at ? (
              <p className="text-sm text-emerald-700">Pagamento informado em {date(cur.informed_at)}. Assim que for confirmado, a fatura fica como paga.</p>
            ) : (
              <Button onClick={() => api('POST', `/api/shop/subscription/${cur.id}/inform`).then(load, (e) => setError(e.message))}>Já paguei</Button>
            )}
          </div>
          <ErrorText error={error} />
        </Card>
      ) : (
        <Card className="max-w-xl">
          <p className="font-semibold">Tudo em dia ✓</p>
          <p className="text-sm text-zinc-500">Nenhuma fatura em aberto.</p>
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
