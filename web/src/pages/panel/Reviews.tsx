import { MessageCircle, Star } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { stampLabel, whatsappLink } from '../../lib/format';

interface Settings {
  review_enabled: boolean;
  review_delay_min: number;
  review_link: string | null;
}

interface Overview {
  settings: Settings;
  days: number;
  count: number;
  asked: number;
  average: number | null;
  byBarber: { barber_id: number; name: string; n: number; avg: number }[];
  recent: { id: number; rating: number; comment: string | null; answered_local: string; customer: string; phone: string; barber: string | null }[];
}

const DELAYS = [
  { value: 30, label: '30 minutos depois' },
  { value: 60, label: '1 hora depois' },
  { value: 120, label: '2 horas depois' },
  { value: 180, label: '3 horas depois' },
  { value: 360, label: '6 horas depois' },
  { value: 1440, label: '24 horas depois' },
];

const one = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function Stars({ value, className = 'size-4' }: { value: number; className?: string }) {
  return (
    <span className="inline-flex shrink-0" role="img" aria-label={`${one(value)} de 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`${className} ${i <= Math.round(value) ? 'fill-amber-400 text-amber-400' : 'text-zinc-300'}`} />
      ))}
    </span>
  );
}

/** Avaliações depois do corte: a nota que os clientes dão pelo WhatsApp. */
export function Reviews() {
  const [data, setData] = useState<Overview | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (o: Overview) => {
    setData(o);
    setForm(o.settings);
  };
  useEffect(() => {
    api<Overview>('GET', '/api/shop/reviews').then(apply);
  }, []);
  if (!data || !form) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      apply(await api<Overview>('PUT', '/api/shop/reviews/settings', { ...form, review_link: form.review_link || null }));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (patch: Partial<Settings>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  const delays = DELAYS.some((d) => d.value === form.review_delay_min) ? DELAYS : [...DELAYS, { value: form.review_delay_min, label: `${form.review_delay_min} minutos depois` }];

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Avaliações</h1>
        <p className="text-sm text-zinc-500">
          Depois do atendimento, o robô pergunta ao cliente uma nota de 1 a 5. Nota 4 ou 5 recebe o link para avaliar no Google; nota baixa, o robô pergunta o que
          melhorar e o comentário chega no seu WhatsApp.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card className="!p-4">
          <p className="text-sm text-zinc-500">Nota média ({data.days} dias)</p>
          {data.average == null ? (
            <p className="mt-1 text-2xl font-bold text-zinc-400">—</p>
          ) : (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-bold tabular-nums">
              {one(data.average)} <Stars value={data.average} className="size-5" />
            </p>
          )}
        </Card>
        <Card className="!p-4">
          <p className="text-sm text-zinc-500">Avaliações recebidas</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.count}</p>
        </Card>
        <Card className="col-span-2 !p-4 md:col-span-1">
          <p className="text-sm text-zinc-500">Responderam ao pedido</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.asked ? `${Math.round((data.count / data.asked) * 100)}%` : '—'}</p>
          <p className="text-xs text-zinc-500">{data.asked} pedidos enviados</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card>
            <p className="mb-3 font-semibold">Últimas avaliações</p>
            {data.recent.length === 0 ? (
              <p className="text-sm text-zinc-500">As notas dos clientes aparecem aqui. O primeiro pedido sai depois do próximo atendimento.</p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {data.recent.map((r) => (
                  <li key={r.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Stars value={r.rating} />
                      <span className="font-medium">{r.customer}</span>
                      {r.rating <= 3 && <Badge tone="red">Nota baixa</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {r.barber ? `com ${r.barber} · ` : ''}
                      {stampLabel(r.answered_local)}
                    </p>
                    {r.comment && <p className="mt-1.5 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700">“{r.comment}”</p>}
                    {r.rating <= 3 && (
                      <a
                        href={whatsappLink(r.phone, `Oi, ${r.customer.split(' ')[0]}! Aqui é da barbearia. Vi sua avaliação e queria entender melhor o que aconteceu.`)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:underline"
                      >
                        <MessageCircle className="size-4" /> Chamar no WhatsApp
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <p className="mb-3 font-semibold">Por barbeiro ({data.days} dias)</p>
            {data.byBarber.length === 0 ? (
              <p className="text-sm text-zinc-500">Ainda sem notas.</p>
            ) : (
              <ul className="space-y-2">
                {data.byBarber.map((b) => (
                  <li key={b.barber_id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{b.name}</span>
                    <span className="flex items-center gap-2">
                      <Stars value={b.avg} />
                      <b className="tabular-nums">{one(b.avg)}</b>
                      <span className="text-xs text-zinc-500">
                        ({b.n} {b.n === 1 ? 'nota' : 'notas'})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <form onSubmit={save} className="space-y-4">
              <p className="font-semibold">Configurar</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={form.review_enabled} onChange={(e) => set({ review_enabled: e.target.checked })} />
                <span>
                  Pedir avaliação depois do atendimento
                  <span className="block text-xs text-zinc-500">Cada cliente recebe no máximo um pedido por mês. Marque a falta na agenda para quem não veio não receber.</span>
                </span>
              </label>
              <Field label="Quando perguntar" hint="Mensagens só saem das 8h às 21h; o que cair fora disso vai na manhã seguinte.">
                <select className={inputClass} value={form.review_delay_min} onChange={(e) => set({ review_delay_min: Number(e.target.value) })}>
                  {delays.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Link de avaliação no Google (opcional)"
                hint="No Perfil da Empresa no Google, toque em “Pedir avaliações” e copie o link. Quem der nota 4 ou 5 recebe esse link."
              >
                <Input type="url" placeholder="https://g.page/r/.../review" value={form.review_link ?? ''} onChange={(e) => set({ review_link: e.target.value })} />
              </Field>
              <ErrorText error={error} />
              <div className="flex items-center gap-3">
                <Button type="submit" loading={busy}>
                  Salvar
                </Button>
                {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
              </div>
            </form>
          </Card>
        </div>
      </div>
    </section>
  );
}
