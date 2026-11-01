import { useEffect, useState } from 'react';
import { Button, Card, ErrorText, Field, Input, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { centsToInput, parseMoney } from '../../lib/finance';

interface DepositSettings {
  deposit_no_shows: number;
  deposit_cents: number;
  deposit_hold_min: number;
}

/** Sinal só para quem falta: o cliente que já faltou paga um sinal no PIX ao marcar sozinho. */
export function DepositCard() {
  const [s, setS] = useState<DepositSettings | null>(null);
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<DepositSettings>('GET', '/api/shop/deposit-settings').then((d) => {
      setS(d);
      setAmount(centsToInput(d.deposit_cents));
    }, (e) => setError(e.message));
  }, []);
  if (!s) return <ErrorText error={error} />;

  async function save() {
    setMsg(null);
    setError(null);
    try {
      const d = await api<DepositSettings>('PUT', '/api/shop/deposit-settings', { ...s, deposit_cents: parseMoney(amount) });
      setS(d);
      setMsg('Salvo.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card className="space-y-3">
      <p className="font-semibold">Sinal para quem costuma faltar</p>
      <p className="text-sm text-zinc-500">
        Quem confirma pelo WhatsApp continua sem pagar nada. Só o cliente que já faltou paga um sinal no PIX quando marca sozinho (site, app ou robô); sem
        pagar no prazo, a vaga é liberada. O sinal é descontado no dia. Cancelando com 24 horas ou mais, vira crédito; faltando, fica com a barbearia.
        Horários marcados no balcão e assinantes do clube em dia não pagam.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Pedir sinal de quem faltou">
          <select className={inputClass} value={s.deposit_no_shows} onChange={(e) => setS({ ...s, deposit_no_shows: Number(e.target.value) })}>
            <option value={0}>Desligado</option>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'vez' : 'vezes'} em 6 meses
              </option>
            ))}
          </select>
        </Field>
        <Field label="Valor do sinal (R$)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Prazo para pagar">
          <select className={inputClass} value={s.deposit_hold_min} onChange={(e) => setS({ ...s, deposit_hold_min: Number(e.target.value) })}>
            {[30, 60, 120, 240].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutos` : `${m / 60} ${m === 60 ? 'hora' : 'horas'}`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      <Button type="button" onClick={save}>
        Salvar sinal
      </Button>
    </Card>
  );
}
