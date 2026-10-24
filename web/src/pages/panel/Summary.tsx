import { Eye, Gift, Handshake, Megaphone, MousePointerClick, Stamp, Trophy, Users } from 'lucide-react';
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
        <p className="text-sm text-zinc-500">Como está a sua comunidade este mês.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
                <span className="font-semibold tabular-nums">{c.stamps} carimbos</span>
              </li>
            ))}
          </ol>
        </Card>
        <Card>
          <p className="mb-3 flex items-center gap-2 font-semibold">
            <Handshake className="size-4 text-gold" /> Próximos passos
          </p>
          <ul className="space-y-2 text-sm text-zinc-600">
            <li>1. Em <b>Minha marca</b>, coloque logo, cores e WhatsApp.</li>
            <li>2. Cadastre <b>serviços e produtos</b> com preço.</li>
            <li>3. Crie uma <b>campanha</b>: tomou 5 cervejas, ganhou um copo.</li>
            <li>4. Traga <b>parceiros</b> do bairro e venda <b>anúncios</b> para eles.</li>
            <li>5. No <b>Balcão</b>, cadastre o cliente pelo celular e lance os carimbos.</li>
          </ul>
        </Card>
      </div>
    </section>
  );
}
