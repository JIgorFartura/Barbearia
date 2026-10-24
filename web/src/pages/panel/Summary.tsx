import { AlertTriangle, Bot, CalendarDays, CheckCircle2, Circle, Eye, Gift, ListChecks, Megaphone, Stamp, Star, Trophy, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { navigate } from '../../lib/router';

interface SummaryData {
  customers: number;
  partners: number;
  runningCampaigns: number;
  runningAds: number;
  adRevenueCents: number;
  adViews: number;
  adClicks: number;
  stampsThisMonth: number;
  rewardsThisMonth: number;
  topCustomers: { id: number; name: string; stamps: number }[];
  today: { id: number; time: string; customer: string; barber: string; service: string }[];
  upcomingWeek: number;
  botMessagesWeek: number;
  bookedByBotWeek: number;
  lowStock: { id: number; name: string; stock_qty: number; stock_min: number | null }[];
  rating: { n: number; avg: number | null };
  setup: { id: string; label: string; done: boolean; link: string; optional?: boolean }[];
}

function Stat({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-zinc-200 transition hover:ring-zinc-300">
      <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">{icon}</div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-sm text-zinc-500">{label}</p>
    </button>
  );
}

/** Primeiros passos: o que falta para a barbearia rodar de verdade. */
function SetupCard({ steps, onAccount }: { steps: SummaryData['setup']; onAccount: () => void }) {
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  if (done === required.length && steps.every((s) => s.done)) return null;
  const open = (link: string) => {
    if (link === 'conta') onAccount();
    else if (link.startsWith('/b/')) window.open(link, '_blank');
    else navigate(link);
  };
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <ListChecks className="size-4 text-gold" /> Primeiros passos
        </p>
        <span className="text-sm text-zinc-500">
          {done} de {required.length} prontos
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-zinc-100" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={required.length}>
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${(done / required.length) * 100}%` }} />
      </div>
      <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.id}>
            <button onClick={() => open(s.link)} className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-50 ${s.done ? 'text-zinc-400' : ''}`}>
              {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 size-4 shrink-0 text-zinc-300" />}
              <span className={s.done ? 'line-through' : ''}>
                {s.label}
                {s.optional && !s.done && <span className="text-zinc-400"> (opcional)</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Summary({ shopName, onAccount }: { shopName: string; onAccount: () => void }) {
  const [data, setData] = useState<SummaryData | null>(null);
  useEffect(() => {
    api<SummaryData>('GET', '/api/shop/summary').then(setData);
  }, []);
  if (!data) return null;

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Olá, {shopName}!</h1>
        <p className="text-sm text-zinc-500">Como está a sua comunidade.</p>
      </div>

      <SetupCard steps={data.setup} onAccount={onAccount} />

      {data.lowStock.length > 0 && (
        <button
          onClick={() => navigate('/painel/estoque')}
          className="flex w-full items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-left text-sm text-amber-900 ring-1 ring-amber-200"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <b>Estoque acabando:</b> {data.lowStock.map((p) => `${p.name} (${p.stock_qty})`).join(', ')}. <u>Ver estoque</u>
          </span>
        </button>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={<CalendarDays className="size-5" />} label="Horários hoje" value={data.today.length} onClick={() => navigate('/painel/agenda')} />
        <Stat icon={<CalendarDays className="size-5" />} label="Horários nos próximos 7 dias" value={data.upcomingWeek} onClick={() => navigate('/painel/agenda')} />
        <Stat icon={<Bot className="size-5" />} label="Marcados pelo robô (7 dias)" value={data.bookedByBotWeek} onClick={() => navigate('/painel/robo')} />
        <Stat icon={<Bot className="size-5" />} label="Mensagens do robô (7 dias)" value={data.botMessagesWeek} onClick={() => navigate('/painel/robo')} />
        <Stat
          icon={<Star className="size-5" />}
          label={`Nota dos clientes (${data.rating.n} ${data.rating.n === 1 ? 'nota' : 'notas'})`}
          value={data.rating.avg == null ? '—' : data.rating.avg.toLocaleString('pt-BR', { minimumFractionDigits: 1 })}
          onClick={() => navigate('/painel/avaliacoes')}
        />
        <Stat icon={<Users className="size-5" />} label="Membros" value={data.customers} onClick={() => navigate('/painel/balcao')} />
        <Stat icon={<Stamp className="size-5" />} label="Carimbos no mês" value={data.stampsThisMonth} />
        <Stat icon={<Gift className="size-5" />} label="Prêmios entregues no mês" value={data.rewardsThisMonth} />
        <Stat icon={<Gift className="size-5" />} label="Campanhas valendo" value={data.runningCampaigns} onClick={() => navigate('/painel/campanhas')} />
        <Stat icon={<Megaphone className="size-5" />} label="Anúncios no ar" value={data.runningAds} onClick={() => navigate('/painel/anuncios')} />
        <Stat icon={<Megaphone className="size-5" />} label="Receita dos anúncios no ar" value={money(data.adRevenueCents)} />
        <Stat
          icon={<Eye className="size-5" />}
          label="Visualizações e cliques nos anúncios"
          value={
            <>
              {data.adViews} <span className="text-base font-medium text-zinc-400">/</span> {data.adClicks}
            </>
          }
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <p className="mb-3 flex items-center gap-2 font-semibold">
            <CalendarDays className="size-4 text-gold" /> Hoje na agenda
          </p>
          {data.today.length === 0 && <p className="text-sm text-zinc-500">Nenhum horário marcado para hoje.</p>}
          <ul className="space-y-2">
            {data.today.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-sm">
                <span>
                  <b className="tabular-nums">{a.time}</b> {a.customer}
                </span>
                <span className="text-zinc-500">
                  {a.service} · {a.barber}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <p className="mb-3 flex items-center gap-2 font-semibold">
            <Trophy className="size-4 text-gold" /> Membros mais ativos (30 dias)
          </p>
          {data.topCustomers.length === 0 && <p className="text-sm text-zinc-500">Os carimbos lançados no Balcão aparecem aqui.</p>}
          <ol className="space-y-2">
            {data.topCustomers.map((c, i) => (
              <li key={c.id} className="flex items-center justify-between text-sm">
                <span>
                  <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-zinc-100 text-xs font-bold">{i + 1}</span>
                  {c.name}
                </span>
                <span className="font-semibold tabular-nums">{c.stamps} {c.stamps === 1 ? 'carimbo' : 'carimbos'}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </section>
  );
}
