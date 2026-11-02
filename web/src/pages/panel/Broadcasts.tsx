import { Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorText, Field, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';

type Segment = { type: 'todos' } | { type: 'barbeiro'; barberId: number } | { type: 'sumidos'; days: number } | { type: 'aniversariantes' } | { type: 'clube' };

interface Usage {
  month: string;
  used: number;
  limit: number;
  left: number;
}

interface Data {
  usage: Usage;
  barbers: { id: number; name: string }[];
  history: { id: number; label: string; text: string; recipients: number; sent: number; failed: number; cost_cents: number | null; status: string; created_at: string }[];
}

interface Preview {
  count: number;
  cost_cents: number | null;
  sample: string[];
  usage: Usage;
}

const GROUPS: { id: Segment['type']; label: string }[] = [
  { id: 'todos', label: 'Todos os clientes' },
  { id: 'barbeiro', label: 'Clientes de um barbeiro' },
  { id: 'sumidos', label: 'Quem não vem há um tempo' },
  { id: 'aniversariantes', label: 'Aniversariantes do mês' },
  { id: 'clube', label: 'Assinantes do clube' },
];

/** Promoção no WhatsApp para um grupo de clientes, com prévia do alcance e do custo. */
export function Broadcasts() {
  const [data, setData] = useState<Data | null>(null);
  const [type, setType] = useState<Segment['type']>('todos');
  const [barberId, setBarberId] = useState('');
  const [days, setDays] = useState(45);
  const [text, setText] = useState('Oi {nome}! ');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => api<Data>('GET', '/api/shop/broadcasts').then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  const segment: Segment | null =
    type === 'barbeiro' ? (barberId ? { type, barberId: Number(barberId) } : null) : type === 'sumidos' ? { type, days } : ({ type } as Segment);

  useEffect(() => {
    setPreview(null);
    if (!segment) return;
    const t = setTimeout(() => api<Preview>('POST', '/api/shop/broadcasts/preview', { segment }).then(setPreview, () => undefined), 250);
    return () => clearTimeout(t);
    // O grupo é recalculado só quando muda a escolha (segment é derivado delas).
  }, [type, barberId, days]);

  async function send() {
    if (!segment || !preview) return;
    if (!confirm(`Mandar para ${preview.count} ${preview.count === 1 ? 'cliente' : 'clientes'}${preview.cost_cents ? ` (custo estimado de ${money(preview.cost_cents)} na Meta)` : ''}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/shop/broadcasts', { segment, text });
      setDone(`Enviando para ${preview.count} ${preview.count === 1 ? 'cliente' : 'clientes'}. Acompanhe abaixo.`);
      setText('Oi {nome}! ');
      setTimeout(load, 1500);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <ErrorText error={error} />;
  const example = text.replace(/\{nome\}/gi, preview?.sample[0] ?? 'João');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Promoções no WhatsApp</h1>
        <p className="text-sm text-zinc-500">
          Mande uma promoção para um grupo de clientes. Quem respondeu PARAR não recebe, e cada cliente recebe no máximo uma promoção por semana.
        </p>
      </div>
      <Card>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <Field label="Para quem">
              <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as Segment['type'])}>
                {GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </Field>
            {type === 'barbeiro' && (
              <Field label="Barbeiro" hint="Quem cortou por último com ele.">
                <select className={inputClass} value={barberId} onChange={(e) => setBarberId(e.target.value)}>
                  <option value="">Escolha</option>
                  {data.barbers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {type === 'sumidos' && (
              <Field label="Sem vir há pelo menos">
                <select className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {[30, 45, 60, 90, 180].map((d) => (
                    <option key={d} value={d}>
                      {d} dias
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Mensagem" hint="{nome} vira o primeiro nome de cada cliente. O aviso para parar de receber vai no fim, sozinho.">
              <textarea className={inputClass} rows={5} maxLength={700} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </div>
          <div className="space-y-3">
            <p className="text-sm font-medium text-zinc-700">Como chega</p>
            <div className="rounded-2xl bg-[#e7ddd3] p-4">
              <p className="max-w-xs rounded-xl rounded-tl-none bg-white px-3 py-2 text-sm whitespace-pre-line shadow-sm">
                {example}
                {'\n\n'}
                <span className="text-zinc-500">(Para não receber promoções, responda PARAR.)</span>
              </p>
            </div>
            <div className="rounded-xl bg-zinc-50 px-4 py-3 text-sm">
              {preview ? (
                <>
                  <p>
                    <b>{preview.count}</b> {preview.count === 1 ? 'cliente recebe' : 'clientes recebem'}
                    {preview.sample.length > 0 && <span className="text-zinc-500"> ({preview.sample.join(', ')}{preview.count > preview.sample.length ? '…' : ''})</span>}
                  </p>
                  <p className="text-zinc-500">
                    {preview.cost_cents != null ? `Custo estimado na Meta: ${money(preview.cost_cents)}` : 'Pelo QR Code não há custo por mensagem (mande com moderação para não ter o número bloqueado).'}
                  </p>
                </>
              ) : (
                <p className="text-zinc-500">Escolha o grupo para ver quantos recebem.</p>
              )}
              <p className="mt-1 text-xs text-zinc-500">
                Limite do mês: {data.usage.used} de {data.usage.limit} mensagens usadas.
              </p>
            </div>
            <ErrorText error={error} />
            {done && <p className="rounded-xl bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900 ring-1 ring-emerald-200">{done}</p>}
            <Button className="w-full" loading={busy} disabled={!preview?.count || text.trim().length < 10 || preview.count > data.usage.left} onClick={send}>
              <Send className="size-4" /> Mandar promoção
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">Enviadas</h2>
        {data.history.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhuma promoção enviada ainda.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {data.history.map((h) => (
              <li key={h.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{h.label}</p>
                  <span className="text-xs text-zinc-500">{new Date(h.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
                <p className="line-clamp-2 text-sm text-zinc-600">{h.text}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <Badge tone={h.status === 'sent' ? 'green' : 'gold'}>{h.status === 'sent' ? 'Enviada' : 'Enviando'}</Badge>
                  {h.sent} de {h.recipients} entregues ao WhatsApp{h.failed ? ` · ${h.failed} com falha` : ''}
                  {h.cost_cents != null ? ` · ~${money(h.cost_cents)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
