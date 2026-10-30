import { Check, CreditCard, Crown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Section } from '../components/CustomerSection';
import { OnlinePayButton } from '../components/OnlinePay';
import { PixPay } from '../components/Pix';
import { ReceiptUpload, type ReceiptInfo } from '../components/Receipt';
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
    /** No cartão automático: a Cielo cobra sozinha todo mês. */
    card: boolean;
    /** Pix Automático: ACTIVE = débito sozinho todo mês; CREATED = falta pagar o PIX que autoriza. */
    pixAuto: string | null;
  } | null;
  /** A barbearia oferece o débito automático (Pix Automático). */
  pixAutoOffered: boolean;
  charge: {
    id: number;
    description: string;
    amount_cents: number;
    due_date: string | null;
    claimed: boolean;
    /** Comprovante do PIX que ele mandou (a barbearia recebe uma cópia). */
    receipt: ReceiptInfo | null;
    /** auto: PIX com baixa automática (Asaas da barbearia). needsCpf: falta o CPF para gerar esse PIX. */
    pix: { payload: string | null; qr: string | null; auto: boolean; needsCpf: boolean } | null;
  } | null;
  /** A barbearia aceita cartão (página segura da Cielo). */
  online: boolean;
}

const br = (d: string | null | undefined) => (d ? d.split('-').reverse().slice(0, 2).join('/') : '');

/** Clube de assinatura na área do cliente: assinar, pagar a mensalidade (PIX com comprovante ou cartão) e acompanhar o uso. */
export function ClubSection({ slug, accent, onPaid }: { slug: string; accent: string; onPaid?: () => void }) {
  const [data, setData] = useState<ClubData | null>(null);
  const [joining, setJoining] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cpf, setCpf] = useState('');
  const [askCpf, setAskCpf] = useState(false);
  const [autoStart, setAutoStart] = useState<{ payload: string; qr: string } | null>(null);
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
      onPaid?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function saveCpf() {
    setError(null);
    try {
      setData(await api<ClubData>('PUT', `/api/customer/${slug}/cpf`, { cpf }));
      setAskCpf(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function pixAuto(on: boolean) {
    setError(null);
    try {
      if (!on) {
        if (!confirm('Desligar o débito automático? As próximas mensalidades chegam pelo WhatsApp com o PIX.')) return;
        setData(await api<ClubData>('DELETE', `/api/customer/${slug}/club/pix-auto`));
        return;
      }
      const r = await api<ClubData & { pixAutoStart: { payload: string; qr: string } | null; needsCpf: boolean }>('POST', `/api/customer/${slug}/club/pix-auto`);
      setData(r);
      if (r.needsCpf) setAskCpf(true);
      else setAutoStart(r.pixAutoStart);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const cpfForm = (
    <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-zinc-200">
      <p className="text-sm text-zinc-700">Para o PIX com confirmação automática, o banco pede o seu CPF (só uma vez).</p>
      <div className="flex gap-2">
        <input
          inputMode="numeric"
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          placeholder="000.000.000-00"
          value={cpf}
          onChange={(e) => setCpf(e.target.value)}
          aria-label="CPF"
        />
        <Button className="shrink-0" style={style} disabled={cpf.replace(/\D/g, '').length !== 11} onClick={saveCpf}>
          Salvar
        </Button>
      </div>
    </div>
  );

  // Comprovante enviado: atualiza o clube e a lista de pagamentos.
  const receiptDone = (d: ClubData) => {
    setData(d);
    onPaid?.();
  };

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
          {m.state === 'late' && (
            <p className="text-sm text-red-700">
              {m.card ? 'A cobrança no cartão não passou. ' : ''}Os benefícios do clube voltam assim que o pagamento cair.
            </p>
          )}
          {m.card && m.status !== 'cancelled' && !c && (
            <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <CreditCard className="size-4 shrink-0" /> Cartão cadastrado: a mensalidade é cobrada sozinha todo mês.
            </p>
          )}
          {m.state === 'ending' && m.period && <p className="text-sm text-zinc-600">Você cancelou. O clube vale até {br(m.period.end)}.</p>}
          {m.pixAuto === 'ACTIVE' && m.status !== 'cancelled' && (
            <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <span>⚡ Pix Automático ligado: a mensalidade é debitada sozinha no vencimento.</span>
              <button className="text-xs text-emerald-800 underline" onClick={() => pixAuto(false)}>
                Desligar
              </button>
            </p>
          )}

          {c && (
            <div className="rounded-xl bg-zinc-50 p-4">
              <p className="text-sm font-medium">{c.description}</p>
              <p className="text-2xl font-bold tabular-nums">{money(c.amount_cents)}</p>
              {c.due_date && <p className="text-xs text-zinc-500">Vencimento {br(c.due_date)}</p>}
              {c.claimed ? (
                <div className="mt-2 space-y-1 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                  <p>✅ {c.receipt ? 'Comprovante enviado para a barbearia.' : 'Pagamento avisado.'} A barbearia confere e confirma; enquanto isso, o clube já vale.</p>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {c.receipt && (
                      <a href={`/api/customer/${slug}/charges/${c.id}/receipt`} target="_blank" rel="noreferrer" className="font-medium underline">
                        Ver comprovante
                      </a>
                    )}
                    <ReceiptUpload<ClubData>
                      url={`/api/customer/${slug}/club/charges/${c.id}/receipt`}
                      label={c.receipt ? 'Trocar comprovante' : 'Enviar o comprovante'}
                      link
                      onDone={receiptDone}
                      onError={setError}
                    />
                  </p>
                </div>
              ) : c.pix?.needsCpf && !c.pix.payload ? (
                <div className="mt-3">{cpfForm}</div>
              ) : c.pix?.auto && c.pix.payload && c.pix.qr ? (
                <div className="mt-3 space-y-3">
                  <PixPay pix={{ payload: c.pix.payload, qr: c.pix.qr }} />
                  <p className="text-center text-xs font-medium text-emerald-700">⚡ Confirmação automática: assim que você pagar, o clube é liberado.</p>
                  {data.pixAutoOffered && !m.card && m.pixAuto !== 'ACTIVE' && (
                    <button className="w-full rounded-lg px-4 py-2 text-sm font-semibold ring-1 ring-zinc-300 hover:bg-zinc-100" onClick={() => pixAuto(true)}>
                      Prefiro o débito automático todo mês (Pix Automático)
                    </button>
                  )}
                  {data.online && (
                    <OnlinePayButton slug={slug} chargeId={c.id} label="Pagar no cartão (automático)" hint="Página segura da Cielo. Ela cobra sozinha todo mês; cancele quando quiser." />
                  )}
                </div>
              ) : (c.pix?.payload && c.pix.qr) || data.online ? (
                <div className="mt-3 space-y-3">
                  {c.pix?.needsCpf &&
                    (askCpf ? (
                      cpfForm
                    ) : (
                      <button className="w-full rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 ring-1 ring-emerald-200" onClick={() => setAskCpf(true)}>
                        ⚡ Quer que o clube seja liberado sozinho quando você pagar? Informe seu CPF
                      </button>
                    ))}
                  {c.pix?.payload && c.pix.qr && (
                    <>
                      <PixPay pix={{ payload: c.pix.payload, qr: c.pix.qr }} />
                      <ReceiptUpload<ClubData>
                        url={`/api/customer/${slug}/club/charges/${c.id}/receipt`}
                        label="Paguei: enviar comprovante"
                        style={style}
                        onDone={receiptDone}
                        onError={setError}
                      />
                      <p className="text-center text-xs text-zinc-500">
                        Foto, print ou PDF do comprovante: vai direto para a barbearia.{' '}
                        <button className="font-medium text-zinc-700 underline" onClick={() => act(`charges/${c.id}/claim`)}>
                          Já paguei, sem comprovante
                        </button>
                      </p>
                    </>
                  )}
                  {data.online && (
                    <>
                      {c.pix?.payload && <p className="text-center text-xs text-zinc-400">ou</p>}
                      <OnlinePayButton
                        slug={slug}
                        chargeId={c.id}
                        label={m.card ? 'Usar outro cartão' : 'Pagar no cartão (automático)'}
                        hint="Página segura da Cielo. Ela cobra sozinha todo mês; cancele quando quiser."
                      />
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
              A primeira mensalidade é hoje.{' '}
              {data.online
                ? 'No cartão, a cobrança é automática todo mês; no PIX, ela chega no seu WhatsApp todo mês, no mesmo dia.'
                : 'Depois, a cobrança chega no seu WhatsApp todo mês, no mesmo dia.'}{' '}
              Cancele quando quiser: o mês pago continua valendo.
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
      {autoStart && (
        <Modal title="Débito automático (Pix Automático)" onClose={() => setAutoStart(null)}>
          <div className="space-y-3">
            <p className="text-sm text-zinc-600">
              Pague este PIX para autorizar o débito automático. No app do banco, confirme a autorização: nos próximos meses a mensalidade cai sozinha no
              vencimento, e você cancela quando quiser (aqui ou no banco).
            </p>
            <PixPay pix={autoStart} />
            <Button className="w-full" style={style} onClick={() => setAutoStart(null)}>
              Pronto
            </Button>
          </div>
        </Modal>
      )}
    </Section>
  );
}
