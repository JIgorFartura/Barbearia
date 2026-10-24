import { Check, Copy, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input, inputClass } from '../../components/ui';
import { api } from '../../lib/api';

interface AsaasView {
  env: 'sandbox' | 'production';
  hasKey: boolean;
  keyHint: string | null;
  webhookUrl: string;
  webhookToken: string | null;
  nfse: { enabled: boolean; serviceName: string; serviceCode: string; iss: number; observations: string };
  /** Pagamentos online dos clientes das barbearias (cartão), com repasse e a taxa da plataforma (%). */
  online: { enabled: boolean; feePct: number };
  /** Último aviso válido do Asaas (mostra que o webhook está ligado). */
  webhookAt: string | null;
  shopsWithoutDocument: { id: number; name: string }[];
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input readOnly value={value} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="ghost"
          className="shrink-0 !px-3"
          aria-label={`Copiar ${label}`}
          onClick={() =>
            navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </Field>
  );
}

/** Asaas: mensalidade com baixa sozinha (PIX, cartão ou boleto), nota fiscal e pagamento com cartão dos clientes das barbearias. */
export function AsaasCard() {
  const [data, setData] = useState<AsaasView | null>(null);
  const [form, setForm] = useState<{ env: AsaasView['env']; apiKey: string; nfse: AsaasView['nfse']; online: AsaasView['online'] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (v: AsaasView) => {
    setData(v);
    setForm({ env: v.env, apiKey: '', nfse: v.nfse, online: v.online });
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
            online: { ...form.online, feePct: Math.min(30, Math.max(0, Number(form.online.feePct) || 0)) },
          }),
        ),
      'Salvo!',
    );
  const nfse = form.nfse;
  const setNfse = (patch: Partial<AsaasView['nfse']>) => setForm({ ...form, nfse: { ...nfse, ...patch } });
  const online = form.online;
  const setOnline = (patch: Partial<AsaasView['online']>) => setForm({ ...form, online: { ...online, ...patch } });

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">Pagamentos online (Asaas)</p>
          <p className="text-sm text-zinc-500">
            Cada mensalidade vira uma cobrança no Asaas: a barbearia paga com PIX, cartão de crédito ou boleto e, quando o pagamento cai, a fatura é baixada
            sozinha. Sem o Asaas, vale o PIX acima com confirmação manual.
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

      <div className="space-y-3 border-t border-zinc-100 pt-4">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={online.enabled} onChange={(e) => setOnline({ enabled: e.target.checked })} />
          <span>
            <span className="font-medium">Liberar pagamento com cartão para os clientes das barbearias</span>
            <span className="block text-xs text-zinc-500">
              Mensalidade do clube (cartão, boleto ou PIX) e sinal do horário (cartão), numa página segura do Asaas, sem passar dados de cartão pelo sistema. O
              valor cai na sua conta Asaas e é repassado sozinho para a conta Asaas da barbearia quando o Asaas libera o dinheiro (cada uma informa o Wallet ID
              dela na tela Clube).
            </span>
          </span>
        </label>
        {online.enabled && (
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr] sm:items-start">
            <Field label="Taxa da plataforma (%)">
              <Input type="number" min={0} max={30} step={0.1} value={online.feePct} onChange={(e) => setOnline({ feePct: Number(e.target.value) })} />
            </Field>
            <p className="text-xs text-zinc-500 sm:pt-7">
              Do valor líquido de cada pagamento (depois da taxa do Asaas), essa parte fica com você; o resto vai para a barbearia. Use 0 para repassar tudo.
            </p>
          </div>
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
