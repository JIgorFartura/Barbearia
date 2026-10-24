import { useEffect, useState } from 'react';
import { OnlinePayButton } from '../components/OnlinePay';
import { PixPay } from '../components/Pix';
import { Button, ErrorText, Modal } from '../components/ui';
import { api } from '../lib/api';
import { hourLabel, money } from '../lib/format';

/** Sinal de um horário, como o cliente vê. */
export interface CustomerDeposit {
  id: number;
  amount_cents: number;
  paid: boolean;
  claimed: boolean;
  /** Até quando o horário fica segurado ("AAAA-MM-DD HH:MM"). */
  expires_local: string | null;
}

interface DepositDetail extends CustomerDeposit {
  description: string;
  pix: { payload: string; qr: string } | null;
  /** A barbearia aceita cartão (página segura da Cielo). */
  online: boolean;
}

/** Pagar o sinal: PIX (QR Code e copia e cola) e "Já paguei", ou cartão. */
export function DepositPayModal({
  slug,
  depositId,
  accent,
  title = 'Sinal do horário',
  onClose,
}: {
  slug: string;
  depositId: number;
  accent: string;
  title?: string;
  onClose: () => void;
}) {
  const [d, setD] = useState<DepositDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<DepositDetail>('GET', `/api/customer/${slug}/deposits/${depositId}`).then(setD, (e) => setError(e.message));
  }, [slug, depositId]);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<CustomerDeposit>('POST', `/api/customer/${slug}/deposits/${depositId}/claim`);
      setD((x) => x && { ...x, ...r });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      {!d ? (
        <ErrorText error={error} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-zinc-600">{d.description}</p>
          <p className="text-3xl font-bold tabular-nums">{money(d.amount_cents)}</p>
          {d.paid ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">✅ Sinal pago. Ele é descontado no dia do atendimento.</p>
          ) : d.claimed ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">✅ Pagamento avisado. Seu horário está garantido; a barbearia confere o PIX.</p>
          ) : (
            <>
              <p className="text-zinc-600">
                Pague o sinal{d.expires_local ? ` até as ${hourLabel(d.expires_local.slice(11))}` : ''} para garantir o horário; sem ele, a vaga é liberada. O valor é
                descontado no dia.
              </p>
              {d.pix && (
                <>
                  <PixPay pix={d.pix} />
                  <ErrorText error={error} />
                  <Button className="w-full" loading={busy} style={{ background: accent, color: '#09090b' }} onClick={claim}>
                    Já paguei
                  </Button>
                </>
              )}
              {d.online && (
                <>
                  {d.pix && <p className="text-center text-xs text-zinc-400">ou</p>}
                  <OnlinePayButton slug={slug} chargeId={d.id} />
                </>
              )}
              {!d.pix && !d.online && <p className="text-zinc-600">Fale com a barbearia para pagar o sinal.</p>}
            </>
          )}
          {(d.paid || d.claimed) && (
            <Button variant="ghost" className="w-full" onClick={onClose}>
              Fechar
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
