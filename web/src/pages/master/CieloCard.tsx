import { CreditCard } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyField } from '../../components/CopyField';
import { Badge, Button, Card, ErrorText, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';

interface CieloView {
  clientId: string | null;
  secretHint: string | null;
  ready: boolean;
  feePct: number;
  webhookUrl: string | null;
  returnUrl: string;
  webhookAt: string | null;
}

const pct = (n: number) => String(n).replace('.', ',');

/**
 * Cartão pela Cielo: as barbearias pagam a mensalidade no cartão automático (a Cielo cobra todo mês,
 * no mesmo dia). Taxa menor e dinheiro em 1 dia útil, com o Recebimento Automático ligado na Cielo.
 */
export function CieloCard() {
  const [data, setData] = useState<CieloView | null>(null);
  const [form, setForm] = useState({ clientId: '', clientSecret: '', feePct: '3,48' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (v: CieloView) => {
    setData(v);
    setForm({ clientId: v.clientId ?? '', clientSecret: '', feePct: pct(v.feePct) });
  };
  useEffect(() => {
    api<CieloView>('GET', '/api/master/cielo').then(apply);
  }, []);
  if (!data) return null;

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
  const save = () =>
    run(async () => apply(await api<CieloView>('PUT', '/api/master/cielo', { ...form, feePct: Number(form.feePct.replace(',', '.')) || 0 })), 'Salvo!');

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            <CreditCard className="size-4" /> Cartão (Cielo)
          </p>
          <p className="text-sm text-zinc-500">
            A barbearia paga a mensalidade no cartão uma vez e a Cielo cobra sozinha todo mês, no mesmo dia; a fatura é baixada aqui automaticamente. A menor
            taxa entre as plataformas com cobrança recorrente (3,48% no crédito à vista na tabela da Cielo) e o dinheiro em 1 dia útil.
          </p>
        </div>
        <Badge tone={data.ready ? 'green' : 'zinc'}>{data.ready ? 'Ligado' : 'Desligado'}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ClientId">
          <Input value={form.clientId} autoComplete="off" spellCheck={false} className="font-mono text-xs" onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
        </Field>
        <Field label="Client Secret" hint={data.secretHint ? 'Deixe em branco para manter o atual.' : undefined}>
          <Input
            type="password"
            autoComplete="off"
            value={form.clientSecret}
            placeholder={data.secretHint ?? ''}
            className="font-mono text-xs"
            onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
          />
        </Field>
      </div>
      <p className="text-xs text-zinc-500">
        No site da Cielo: contrate o Link de Pagamento (sem mensalidade), ligue o Recebimento Automático (dinheiro em 1 dia útil) e pegue as credenciais da API
        em Configurações. Cole lá as URLs abaixo. Para testar sem cobrar ninguém, use o modo de teste da loja na Cielo.
      </p>

      {data.webhookUrl && (
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3">
          <CopyField label="URL de notificação e de mudança de status" value={data.webhookUrl} hint="Cole nos dois campos. É por ela que a Cielo avisa cada pagamento." />
          <CopyField label="URL de retorno" value={data.returnUrl} hint="Para onde a barbearia volta depois de pagar." />
          <p className={`text-xs ${data.webhookAt ? 'text-emerald-700' : 'text-amber-700'}`}>
            {data.webhookAt
              ? `Funcionando: último aviso recebido em ${new Date(data.webhookAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`
              : 'Nenhum aviso recebido ainda. Depois de cadastrar, faça um pagamento de teste para conferir.'}
          </p>
        </div>
      )}

      <div className="grid items-end gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Taxa do cartão (%)">
          <Input inputMode="decimal" value={form.feePct} onChange={(e) => setForm({ ...form, feePct: e.target.value })} />
        </Field>
        <p className="pb-2 text-xs text-zinc-500">Usada para mostrar o valor líquido na lista de pagamentos. Confira a sua no app da Cielo.</p>
      </div>

      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={save}>
          Salvar
        </Button>
        {data.ready && (
          <Button variant="ghost" disabled={busy} onClick={() => run(() => api('POST', '/api/master/cielo/test'), 'Conexão com a Cielo funcionando.')}>
            Testar conexão
          </Button>
        )}
      </div>
    </Card>
  );
}
