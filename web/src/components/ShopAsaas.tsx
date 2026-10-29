import { Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CopyField } from './CopyField';
import { Badge, Button, Card, ErrorText, Field, Input, inputClass } from './ui';

interface AsaasView {
  connected: boolean;
  env: 'sandbox' | 'production';
  pixAuto: boolean;
  webhookUrl: string | null;
  webhookToken: string | null;
  webhookAt: string | null;
}

/**
 * Asaas da própria barbearia (o dinheiro cai na conta dela): a mensalidade do clube sai com PIX de
 * baixa automática e, se o Asaas liberar na conta, com o Pix Automático (débito sozinho todo mês).
 */
export function ShopAsaasCard() {
  const [data, setData] = useState<AsaasView | null>(null);
  const [form, setForm] = useState({ env: 'sandbox' as AsaasView['env'], apiKey: '', pixAuto: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (d: AsaasView) => {
    setData(d);
    setForm({ env: d.env, apiKey: '', pixAuto: d.pixAuto });
  };
  useEffect(() => {
    api<AsaasView>('GET', '/api/shop/asaas').then(apply, (e) => setError(e.message));
  }, []);

  async function run(p: Promise<unknown>, ok: string, after?: (r: unknown) => void) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await p;
      after?.(r);
      setMsg(ok);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <ErrorText error={error} />;
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Zap className="size-5 text-zinc-400" /> PIX com baixa automática (Asaas)
        </p>
        <Badge tone={data.connected ? 'green' : 'zinc'}>{data.connected ? 'Ligado' : 'Desligado'}</Badge>
      </div>
      <p className="text-sm text-zinc-500">
        Com a sua conta Asaas, o PIX da mensalidade do clube é conferido sozinho: o cliente paga, o clube é liberado e o valor entra no caixa, sem você olhar o
        extrato. O dinheiro cai direto na sua conta Asaas.
      </p>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Ambiente">
          <select className={inputClass} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value as AsaasView['env'] })}>
            <option value="sandbox">Testes (sandbox)</option>
            <option value="production">Produção</option>
          </select>
        </Field>
        <Field label="Chave de API" hint={data.connected ? 'Já salva. Cole outra só para trocar de conta.' : 'Asaas → Integrações → Chave de API.'}>
          <Input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={data.connected ? '••••••••' : '$aact_...'} />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={form.pixAuto} onChange={(e) => setForm({ ...form, pixAuto: e.target.checked })} />
        <span>
          <b>Oferecer o Pix Automático</b> no clube: o cliente autoriza uma vez (pagando o 1º mês) e, nos meses seguintes, a mensalidade é debitada sozinha no
          vencimento. O Asaas precisa liberar o Pix Automático na sua conta: teste antes no ambiente de testes.
        </span>
      </label>
      {data.webhookUrl && data.webhookToken && (
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3">
          <p className="text-sm font-medium">No Asaas, em Integrações → Webhooks, crie um webhook com:</p>
          <CopyField label="URL" value={data.webhookUrl} />
          <CopyField label="Token de autenticação" value={data.webhookToken} hint="Eventos: cobranças (pagamento recebido/confirmado) e Pix Automático." />
          <p className="text-xs text-zinc-500">
            {data.webhookAt ? `Último aviso do Asaas: ${new Date(data.webhookAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.` : 'Ainda não chegou nenhum aviso do Asaas.'}
          </p>
        </div>
      )}
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      <ErrorText error={error} />
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={() => run(api<AsaasView>('PUT', '/api/shop/asaas', { ...form, apiKey: form.apiKey || null }), 'Salvo!', (r) => apply(r as AsaasView))}>
          Salvar
        </Button>
        {data.connected && (
          <>
            <Button variant="ghost" loading={busy} onClick={() => run(api('POST', '/api/shop/asaas/test'), 'Chave conferida: o Asaas respondeu. ✅')}>
              Testar a conexão
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                confirm('Desligar o Asaas? A mensalidade do clube volta a ser o PIX da sua chave, conferido por você.') &&
                run(api<AsaasView>('PUT', '/api/shop/asaas', { ...form, apiKey: null, disconnect: true }), 'Desligado.', (r) => apply(r as AsaasView))
              }
            >
              Desligar
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
