import { Bot, CalendarDays, Eye, Gift, Handshake, Megaphone, MousePointerClick, Stamp, Trophy, Users } from 'lucide-react';
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

export function Summary({ shopName }: { shopName: string }) {
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={<CalendarDays className="size-5" />} label="Horários hoje" value={data.today.length} onClick={() => navigate('/painel/agenda')} />
        <Stat icon={<CalendarDays className="size-5" />} label="Horários nos próximos 7 dias" value={data.upcomingWeek} onClick={() => navigate('/painel/agenda')} />
        <Stat icon={<Bot className="size-5" />} label="Marcados pelo robô (7 dias)" value={data.bookedByBotWeek} onClick={() => navigate('/painel/robo')} />
        <Stat icon={<Bot className="size-5" />} label="Mensagens do robô (7 dias)" value={data.botMessagesWeek} onClick={() => navigate('/painel/robo')} />
        <Stat icon={<Users className="size-5" />} label="Membros" value={data.customers} onClick={() => navigate('/painel/balcao')} />
        <Stat icon={<Stamp className="size-5" />} label="Carimbos no mês" value={data.stampsThisMonth} />
        <Stat icon={<Gift className="size-5" />} label="Prêmios entregues no mês" value={data.rewardsThisMonth} />
        <Stat icon={<Gift className="size-5" />} label="Campanhas valendo" value={data.runningCampaigns} onClick={() => navigate('/painel/campanhas')} />
        <Stat icon={<Megaphone className="size-5" />} label="Anúncios no ar" value={data.runningAds} onClick={() => navigate('/painel/anuncios')} />
        <Stat icon={<Megaphone className="size-5" />} label="Receita dos anúncios no ar" value={money(data.adRevenueCents)} />
        <Stat icon={<Eye className="size-5" />} label="Visualizações de anúncios" value={data.adViews} />
        <Stat icon={<MousePointerClick className="size-5" />} label="Cliques em anúncios" value={data.adClicks} />
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
        <Card className="md:col-span-2">
          <p className="mb-3 flex items-center gap-2 font-semibold">
            <Handshake className="size-4 text-gold" /> Próximos passos
          </p>
          <ul className="grid gap-2 text-sm text-zinc-600 sm:grid-cols-2">
            <li>1. Em <b>Minha marca</b>, coloque logo, cores e WhatsApp.</li>
            <li>2. Cadastre os <b>barbeiros</b> com o expediente e os <b>serviços</b> com preço e duração.</li>
            <li>3. Na aba <b>Robô WhatsApp</b>, dê um nome ao robô e conecte o WhatsApp.</li>
            <li>4. Crie <b>campanhas</b> (tomou 5 cervejas, ganhou um copo) e <b>benefícios</b> com voucher.</li>
            <li>5. Traga <b>parceiros</b> do bairro e venda <b>anúncios</b> para eles.</li>
            <li>6. Divulgue a <b>área do cliente</b>: cada um entra pelo celular e agenda sozinho.</li>
          </ul>
        </Card>
      </div>
    </section>
  );
}
