import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyField } from '../../components/CopyField';
import { Badge, Button, Card, ErrorText, Field, Input, inputClass } from '../../components/ui';
import { api } from '../../lib/api';

interface AsaasView {
  env: 'sandbox' | 'production';
  hasKey: boolean;
  keyHint: string | null;
  webhookUrl: string;
  webhookToken: string | null;
  nfse: { enabled: boolean; serviceName: string; serviceCode: string; iss: number; observations: string };
  /** Último aviso válido do Asaas (mostra que o webhook está ligado). */
  webhookAt: string | null;
  shopsWithoutDocument: { id: number; name: string }[];
}

/** Asaas: mensalidade no PIX com baixa sozinha e nota fiscal (o cartão vai pela Cielo). */
export function AsaasCard() {
  const [data, setData] = useState<AsaasView | null>(null);
  const [form, setForm] = useState<{ env: AsaasView['env']; apiKey: string; nfse: AsaasView['nfse'] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (v: AsaasView) => {
    setData(v);
    setForm({ env: v.env, apiKey: '', nfse: v.nfse });
  };
  useEffect(() => {
    api<AsaasView>('GET', '/api/master/asaas').then(apply);
  }, []);
  if (!data || !form) return null;

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
    run(
      async () =>
        apply(
          await api<AsaasView>('PUT', '/api/master/asaas', {
            ...form,
            nfse: { ...form.nfse, iss: Number(form.nfse.iss) || 0 },
          }),
        ),
      'Salvo!',
    );
  const nfse = form.nfse;
  const setNfse = (patch: Partial<AsaasView['nfse']>) => setForm({ ...form, nfse: { ...nfse, ...patch } });

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">Asaas (opcional): PIX automático e nota fiscal</p>
          <p className="text-sm text-zinc-500">
            Cada mensalidade vira um PIX com QR Code próprio no Asaas: quando cai, a fatura é baixada sozinha, e a nota fiscal pode sair automática. Com a Cielo
            ligada, o cartão vai pela Cielo (taxa menor e cobrança automática); sem ela, a página do Asaas também aceita cartão e boleto. Sem o Asaas, vale o PIX
            acima com confirmação manual.
          </p>
        </div>
        <Badge tone={data.hasKey ? 'green' : 'zinc'}>{data.hasKey ? `Ligado (${data.env === 'production' ? 'produção' : 'testes'})` : 'Desligado'}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Ambiente">
          <select className={inputClass} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value as AsaasView['env'] })}>
            <option value="sandbox">Testes (sandbox)</option>
            <option value="production">Produção</option>
          </select>
        </Field>
        <Field label="Chave de API" hint="No Asaas: Integrações → Chaves de API. Deixe em branco para manter a atual.">
          <Input type="password" autoComplete="off" value={form.apiKey} placeholder={data.keyHint ?? '$aact_...'} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
        </Field>
      </div>

      {data.webhookToken && (
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3">
          <p className="text-sm font-medium">Aviso de pagamento (webhook)</p>
          <p className="text-xs text-zinc-500">
            No Asaas: Integrações → Webhooks → Adicionar. Cole a URL e o token abaixo e marque todos os eventos de cobranças e de notas fiscais.
          </p>
          <CopyField label="URL" value={data.webhookUrl} />
          <CopyField label="Token de autenticação" value={data.webhookToken} />
          <p className={`text-xs ${data.webhookAt ? 'text-emerald-700' : 'text-amber-700'}`}>
            {data.webhookAt
              ? `Funcionando: último aviso recebido em ${new Date(data.webhookAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`
              : 'Nenhum aviso recebido ainda. Depois de cadastrar, faça um pagamento de teste para conferir.'}
          </p>
          <button
            className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900"
            onClick={() =>
              confirm('Gerar outro token? O antigo para de valer: atualize no Asaas.') &&
              run(async () => apply(await api<AsaasView>('POST', '/api/master/asaas/token')), 'Novo token gerado. Atualize no Asaas.')
            }
          >
            <RefreshCw className="size-3.5" /> Gerar outro token
          </button>
        </div>
      )}

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={nfse.enabled} onChange={(e) => setNfse({ enabled: e.target.checked })} /> Emitir nota fiscal (NFS-e) de
          cada mensalidade paga
        </label>
        {nfse.enabled && (
          <>
            <p className="text-xs text-zinc-500">Antes, configure no Asaas os dados fiscais da sua empresa (Notas fiscais → Configurações).</p>
            <Field label="Serviço (como no cadastro da prefeitura)">
              <Input value={nfse.serviceName} placeholder="Licenciamento ou cessão de direito de uso de programas de computação" onChange={(e) => setNfse({ serviceName: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Código do serviço">
                <Input value={nfse.serviceCode} placeholder="1.05" onChange={(e) => setNfse({ serviceCode: e.target.value })} />
              </Field>
              <Field label="ISS (%)">
                <Input type="number" min={0} max={10} step={0.01} value={nfse.iss} onChange={(e) => setNfse({ iss: Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Observações na nota (opcional)">
              <Input value={nfse.observations} onChange={(e) => setNfse({ observations: e.target.value })} />
            </Field>
          </>
        )}
      </div>

      {data.hasKey && data.shopsWithoutDocument.length > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Sem CPF/CNPJ (o dono informa na tela Mensalidade): {data.shopsWithoutDocument.map((s) => s.name).join(', ')}.
        </p>
      )}
      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={save}>
          Salvar
        </Button>
        {data.hasKey && (
          <Button variant="ghost" disabled={busy} onClick={() => run(() => api('POST', '/api/master/asaas/test'), 'Conexão com o Asaas funcionando.')}>
            Testar conexão
          </Button>
        )}
      </div>
    </Card>
  );
}
