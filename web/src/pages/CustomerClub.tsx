import { Check, Crown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Section } from '../components/CustomerSection';
import { OnlinePayButton } from '../components/OnlinePay';
import { PixPay } from '../components/Pix';
import { Button, ErrorText, Modal } from '../components/ui';
import { api } from '../lib/api';
import { money } from '../lib/format';

interface Plan {
  id: number;
  name: string;
  description: string | null;
  price_cents: number;
  uses_per_month: number | null;
  items: string[];
}

interface ClubData {
  plans: Plan[];
  member: {
    id: number;
    plan: { id: number; name: string; price_cents: number; uses_per_month: number | null };
    status: 'pending' | 'active' | 'cancelled';
    state: 'pending' | 'ok' | 'late' | 'ending' | 'ended';
    period: { start: string; end: string } | null;
    used: number;
    paid_until: string | null;
  } | null;
  charge: {
    id: number;
    description: string;
    amount_cents: number;
    due_date: string | null;
    claimed: boolean;
    pix: { payload: string; qr: string } | null;
  } | null;
  /** A barbearia aceita cartão (página segura do Asaas); na primeira vez o cliente informa o CPF. */
  online: boolean;
  needsCpf: boolean;
}

const br = (d: string | null | undefined) => (d ? d.split('-').reverse().slice(0, 2).join('/') : '');

/** Clube de assinatura na área do cliente: assinar, pagar a mensalidade (PIX ou cartão) e acompanhar o uso. */
export function ClubSection({ slug, accent }: { slug: string; accent: string }) {
  const [data, setData] = useState<ClubData | null>(null);
  const [joining, setJoining] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<ClubData>('GET', `/api/customer/${slug}/club`).then(setData, () => undefined), [slug]);
  useEffect(() => {
    load();
  }, [load]);

  // Veio do site pelo "Quero assinar" de um plano: abre a confirmação.
  useEffect(() => {
    if (!data || data.member) return;
    const wanted = Number(new URLSearchParams(location.search).get('clube'));
    const plan = data.plans.find((p) => p.id === wanted);
    if (plan) {
      setJoining(plan);
      history.replaceState(null, '', location.pathname);
    }
  }, [data]);

  if (!data || (!data.member && data.plans.length === 0)) return null;
  const style = { background: accent, color: '#09090b' };

  async function act(path: string, body?: unknown) {
    setError(null);
    try {
      setData(await api<ClubData>('POST', `/api/customer/${slug}/club/${path}`, body));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const m = data.member;
  const c = data.charge;
  return (
    <Section id="clube" icon={<Crown />} title="Clube de assinatura">
      <ErrorText error={error} />
      {m ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{m.plan.name}</p>
              <p className="text-sm text-zinc-500">{money(m.plan.price_cents)} por mês</p>
            </div>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                m.state === 'ok' ? 'bg-emerald-100 text-emerald-800' : m.state === 'late' ? 'bg-red-100 text-red-800' : 'bg-zinc-100 text-zinc-700'
              }`}
            >
              {{ ok: 'Em dia', pending: 'Falta o 1º pagamento', late: 'Mensalidade em aberto', ending: 'Cancelado', ended: 'Encerrado' }[m.state]}
            </span>
          </div>
          {m.state === 'ok' && m.period && (
            <p className="text-sm">
              Vale até <b>{br(m.period.end)}</b>.{' '}
              {m.plan.uses_per_month ? (
                <>
                  Você usou <b>{m.used}</b> de <b>{m.plan.uses_per_month}</b> neste mês.
                </>
              ) : (
                'Use à vontade.'
              )}
            </p>
          )}
          {m.state === 'late' && <p className="text-sm text-red-700">Os benefícios do clube voltam assim que o pagamento cair.</p>}
          {m.state === 'ending' && m.period && <p className="text-sm text-zinc-600">Você cancelou. O clube vale até {br(m.period.end)}.</p>}

          {c && (
            <div className="rounded-xl bg-zinc-50 p-4">
              <p className="text-sm font-medium">{c.description}</p>
              <p className="text-2xl font-bold tabular-nums">{money(c.amount_cents)}</p>
              {c.due_date && <p className="text-xs text-zinc-500">Vencimento {br(c.due_date)}</p>}
              {c.claimed ? (
                <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">✅ Pagamento avisado. A barbearia confere e confirma; enquanto isso, o clube já vale.</p>
              ) : c.pix || data.online ? (
                <div className="mt-3 space-y-3">
                  {c.pix && (
                    <>
                      <PixPay pix={c.pix} />
                      <Button className="w-full" style={style} onClick={() => act(`charges/${c.id}/claim`)}>
                        Já paguei
                      </Button>
                    </>
                  )}
                  {data.online && (
                    <>
                      {c.pix && <p className="text-center text-xs text-zinc-400">ou</p>}
                      <OnlinePayButton slug={slug} chargeId={c.id} needsCpf={data.needsCpf} accent={accent} label="Pagar com cartão ou boleto" />
                    </>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-sm text-zinc-600">Pague no balcão da barbearia na sua próxima visita.</p>
              )}
            </div>
          )}

          {m.status === 'cancelled' ? (
            <Button variant="ghost" onClick={() => act('subscribe', { plan_id: m.plan.id })}>
              Voltar a assinar
            </Button>
          ) : (
            <button
              className="text-xs text-zinc-400 hover:text-red-600"
              onClick={() => confirm('Cancelar sua assinatura? O que você já pagou continua valendo até o fim do mês.') && act('cancel')}
            >
              Cancelar assinatura
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">Pague um valor fixo por mês e venha sem se preocupar com a conta.</p>
          {data.plans.map((p) => (
            <div key={p.id} className="rounded-xl p-4 ring-1 ring-zinc-200">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{p.name}</p>
                  <p className="text-sm text-zinc-600">
                    {p.items.join(' + ')} · {p.uses_per_month ? `até ${p.uses_per_month} por mês` : 'à vontade'}
                  </p>
                  {p.description && <p className="mt-1 text-xs text-zinc-500">{p.description}</p>}
                </div>
                <p className="text-right whitespace-nowrap">
                  <b className="text-lg tabular-nums">{money(p.price_cents)}</b>
                  <span className="block text-xs text-zinc-500">por mês</span>
                </p>
              </div>
              <Button className="mt-3 w-full !py-1.5" style={style} onClick={() => setJoining(p)}>
                Assinar
              </Button>
            </div>
          ))}
        </div>
      )}

      {joining && (
        <Modal title={`Assinar o ${joining.name}`} onClose={() => setJoining(null)}>
          <div className="space-y-3 text-sm">
            <p className="text-3xl font-bold tabular-nums">
              {money(joining.price_cents)} <span className="text-base font-normal text-zinc-500">por mês</span>
            </p>
            <ul className="space-y-1">
              {joining.items.map((i) => (
                <li key={i} className="flex items-center gap-2">
                  <Check className="size-4 text-emerald-600" /> {i}
                </li>
              ))}
              <li className="flex items-center gap-2">
                <Check className="size-4 text-emerald-600" /> {joining.uses_per_month ? `Até ${joining.uses_per_month} usos por mês` : 'Use à vontade'}
              </li>
            </ul>
            <p className="text-zinc-500">
              A primeira mensalidade é hoje, por PIX{data.online ? ' ou cartão' : ''}. Depois, a cobrança chega no seu WhatsApp todo mês, no mesmo dia. Cancele quando quiser: o mês pago continua valendo.
            </p>
            <Button
              className="w-full"
              style={style}
              onClick={async () => {
                await act('subscribe', { plan_id: joining.id });
                setJoining(null);
                document.getElementById('clube')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              Assinar e pagar
            </Button>
          </div>
        </Modal>
      )}
    </Section>
  );
}
