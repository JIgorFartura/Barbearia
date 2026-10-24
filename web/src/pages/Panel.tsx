import { Bot as BotIcon, CalendarDays, ExternalLink, Gift, Handshake, LayoutDashboard, LogOut, Megaphone, Menu, Package, Palette, Scissors, Store, Ticket, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Me } from '../App';
import { CrudPage, type Row } from '../components/CrudPage';
import { Badge } from '../components/ui';
import { api } from '../lib/api';
import { date, money } from '../lib/format';
import { navigate, usePath } from '../lib/router';
import { Agenda } from './panel/Agenda';
import { Barbers } from './panel/Barbers';
import { Benefits } from './panel/Benefits';
import { Bot } from './panel/Bot';
import { Brand } from './panel/Brand';
import { Counter } from './panel/Counter';
import { Summary } from './panel/Summary';

const SECTIONS = [
  { id: '', label: 'Resumo', icon: LayoutDashboard },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'balcao', label: 'Balcão', icon: Store },
  { id: 'robo', label: 'Robô WhatsApp', icon: BotIcon },
  { id: 'campanhas', label: 'Campanhas', icon: Gift },
  { id: 'beneficios', label: 'Benefícios', icon: Ticket },
  { id: 'parceiros', label: 'Parceiros', icon: Handshake },
  { id: 'anuncios', label: 'Anúncios', icon: Megaphone },
  { id: 'barbeiros', label: 'Barbeiros', icon: Users },
  { id: 'servicos', label: 'Serviços', icon: Scissors },
  { id: 'produtos', label: 'Produtos', icon: Package },
  { id: 'marca', label: 'Minha marca', icon: Palette },
];

const today = () => new Date().toLocaleDateString('en-CA');
const running = (r: Row) => Boolean(r.active) && (!r.starts_on || r.starts_on <= today()) && (!r.ends_on || r.ends_on >= today());
const period = (r: Row) =>
  r.starts_on || r.ends_on ? `${r.starts_on ? date(r.starts_on) : 'já'} até ${r.ends_on ? date(r.ends_on) : 'sem fim'}` : 'Sem data de término';

/** Painel do dono da barbearia. */
export function Panel({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const path = usePath();
  const section = path.replace(/^\/painel\/?/, '').split('/')[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const [partners, setPartners] = useState<Row[]>([]);
  const [products, setProducts] = useState<Row[]>([]);

  const loadRefs = useCallback(() => {
    api<Row[]>('GET', '/api/shop/partners').then(setPartners);
    api<Row[]>('GET', '/api/shop/catalog').then(setProducts);
  }, []);
  useEffect(loadRefs, [loadRefs]);

  useEffect(() => {
    if (!path.startsWith('/painel')) history.replaceState(null, '', '/painel');
  }, [path]);

  const partnerOptions = [{ value: null, label: '— nenhum —' }, ...partners.map((p) => ({ value: p.id, label: p.name }))];
  const partnerName = (id: number | null) => partners.find((p) => p.id === id)?.name;

  let content;
  switch (section) {
    case 'agenda':
      content = <Agenda />;
      break;
    case 'barbeiros':
      content = <Barbers />;
      break;
    case 'robo':
      content = <Bot />;
      break;
    case 'beneficios':
      content = <Benefits partners={partners} />;
      break;
    case 'balcao':
      content = <Counter />;
      break;
    case 'campanhas':
      content = (
        <CrudPage
          title="Campanhas de fidelidade"
          description="Junte N, ganhe 1. Ex.: tomou 5 cervejas, ganhou um copo. Os carimbos são lançados no Balcão."
          endpoint="/api/shop/campaigns"
          newLabel="Nova campanha"
          defaults={{ active: true, goal: 5, catalog_item_id: null, partner_id: null }}
          empty={{ icon: <Gift className="size-6" />, title: 'Nenhuma campanha ainda', text: 'Crie a primeira: o cliente junta carimbos e ganha um prêmio.' }}
          fields={[
            { key: 'name', label: 'Nome da campanha', type: 'text', required: true, placeholder: 'Clube da cerveja' },
            { key: 'unit_label', label: 'O cliente junta...', type: 'text', required: true, placeholder: 'cervejas', hint: 'No plural: cervejas, cortes, barbas.' },
            { key: 'goal', label: 'Quantos para ganhar o prêmio?', type: 'number', required: true },
            { key: 'reward', label: 'Prêmio', type: 'text', required: true, placeholder: 'Copo personalizado da barbearia' },
            { key: 'description', label: 'Regras / descrição', type: 'textarea' },
            {
              key: 'catalog_item_id',
              label: 'Produto ou serviço da campanha (opcional)',
              type: 'select',
              options: [{ value: null, label: '— nenhum —' }, ...products.map((p) => ({ value: p.id, label: p.name }))],
            },
            { key: 'partner_id', label: 'Patrocinada por um parceiro (opcional)', type: 'select', options: partnerOptions },
            { key: 'image_url', label: 'Imagem', type: 'image' },
            { key: 'starts_on', label: 'Começa em', type: 'date' },
            { key: 'ends_on', label: 'Termina em', type: 'date' },
            { key: 'active', label: 'Campanha ativa', type: 'checkbox' },
          ]}
          renderItem={(r) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{r.name}</p>
                <Badge tone={running(r) ? 'green' : 'zinc'}>{running(r) ? 'Valendo' : 'Fora do ar'}</Badge>
              </div>
              <p className="mt-1 text-sm">
                Juntou <b>{r.goal}</b> {r.unit_label}, ganhou <b>{r.reward}</b>
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {period(r)}
                {partnerName(r.partner_id) && ` · patrocínio: ${partnerName(r.partner_id)}`}
              </p>
            </>
          )}
        />
      );
      break;
    case 'parceiros':
      content = (
        <CrudPage
          title="Parceiros"
          description="Comércios que dão benefícios para a comunidade e podem anunciar no seu site."
          endpoint="/api/shop/partners"
          newLabel="Novo parceiro"
          defaults={{ active: true }}
          onChange={loadRefs}
          empty={{ icon: <Handshake className="size-6" />, title: 'Nenhum parceiro ainda', text: 'Hamburgueria, academia, loja de roupas: quem atende o mesmo público que você.' }}
          fields={[
            { key: 'name', label: 'Nome', type: 'text', required: true },
            { key: 'category', label: 'Ramo', type: 'text', placeholder: 'Hamburgueria, academia...' },
            { key: 'benefit', label: 'Benefício para membros', type: 'text', placeholder: '10% de desconto mostrando o cartão' },
            { key: 'description', label: 'Descrição', type: 'textarea' },
            { key: 'phone', label: 'Telefone / WhatsApp', type: 'text' },
            { key: 'instagram', label: 'Instagram', type: 'text', placeholder: '@parceiro' },
            { key: 'website', label: 'Site', type: 'url' },
            { key: 'logo_url', label: 'Logo', type: 'image' },
            { key: 'active', label: 'Aparece no site', type: 'checkbox' },
          ]}
          renderItem={(r) => (
            <div className="flex gap-3">
              {r.logo_url && <img src={r.logo_url} alt="" className="size-12 rounded-lg object-cover" />}
              <div>
                <p className="font-semibold">
                  {r.name} {!r.active && <Badge>Oculto</Badge>}
                </p>
                <p className="text-xs text-zinc-500">{r.category}</p>
                {r.benefit && <p className="mt-1 text-sm text-emerald-700">{r.benefit}</p>}
              </div>
            </div>
          )}
        />
      );
      break;
    case 'anuncios':
      content = (
        <CrudPage
          title="Anúncios"
          description="Espaço de propaganda vendido no seu site: destaque no topo ou no mural da comunidade."
          endpoint="/api/shop/ads"
          newLabel="Novo anúncio"
          defaults={{ active: true, placement: 'mural', partner_id: null }}
          empty={{ icon: <Megaphone className="size-6" />, title: 'Nenhum anúncio ainda', text: 'Venda o espaço para um parceiro e acompanhe visualizações e cliques.' }}
          fields={[
            { key: 'partner_id', label: 'Anunciante', type: 'select', options: partnerOptions },
            { key: 'title', label: 'Título', type: 'text', required: true },
            { key: 'body', label: 'Texto', type: 'textarea' },
            { key: 'image_url', label: 'Imagem', type: 'image' },
            { key: 'link_url', label: 'Link ao clicar', type: 'url' },
            {
              key: 'placement',
              label: 'Posição',
              type: 'select',
              options: [
                { value: 'destaque', label: 'Destaque (topo do site)' },
                { value: 'mural', label: 'Mural da comunidade' },
              ],
            },
            { key: 'price_cents', label: 'Valor cobrado pelo período (R$)', type: 'money' },
            { key: 'starts_on', label: 'Começa em', type: 'date' },
            { key: 'ends_on', label: 'Termina em', type: 'date' },
            { key: 'active', label: 'Anúncio ativo', type: 'checkbox' },
          ]}
          renderItem={(r) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{r.title}</p>
                <Badge tone={running(r) ? 'green' : 'zinc'}>{running(r) ? 'No ar' : 'Fora do ar'}</Badge>
              </div>
              <p className="text-xs text-zinc-500">
                {partnerName(r.partner_id) ?? 'Sem anunciante'} · {r.placement === 'destaque' ? 'Destaque' : 'Mural'} · {money(r.price_cents)}
              </p>
              <p className="mt-2 text-sm text-zinc-600">
                {r.views} visualizações · {r.clicks} cliques
              </p>
              <p className="text-xs text-zinc-500">{period(r)}</p>
            </>
          )}
        />
      );
      break;
    case 'servicos':
    case 'produtos': {
      const kind = section === 'servicos' ? 'service' : 'product';
      content = (
        <CrudPage
          key={kind}
          title={kind === 'service' ? 'Serviços' : 'Produtos'}
          description={kind === 'service' ? 'Corte, barba, sobrancelha... aparecem no site com o preço.' : 'Pomadas, bebidas, acessórios: o que você vende na barbearia.'}
          endpoint="/api/shop/catalog"
          filter={(r) => r.kind === kind}
          newLabel={kind === 'service' ? 'Novo serviço' : 'Novo produto'}
          defaults={{ kind, active: true }}
          onChange={loadRefs}
          empty={{
            icon: kind === 'service' ? <Scissors className="size-6" /> : <Package className="size-6" />,
            title: 'Nada cadastrado ainda',
            text: 'Cadastre para aparecer no site da barbearia.',
          }}
          fields={[
            { key: 'name', label: 'Nome', type: 'text', required: true },
            { key: 'price_cents', label: 'Preço (R$)', type: 'money' },
            ...(kind === 'service' ? [{ key: 'duration_min', label: 'Duração (minutos)', type: 'number' as const }] : []),
            { key: 'description', label: 'Descrição', type: 'textarea' },
            { key: 'image_url', label: 'Foto', type: 'image' },
            { key: 'active', label: 'Aparece no site', type: 'checkbox' },
          ]}
          renderItem={(r) => (
            <div className="flex gap-3">
              {r.image_url && <img src={r.image_url} alt="" className="size-12 rounded-lg object-cover" />}
              <div>
                <p className="font-semibold">
                  {r.name} {!r.active && <Badge>Oculto</Badge>}
                </p>
                <p className="text-sm">
                  {money(r.price_cents)}
                  {r.duration_min ? ` · ${r.duration_min} min` : ''}
                </p>
              </div>
            </div>
          )}
        />
      );
      break;
    }
    case 'marca':
      content = <Brand />;
      break;
    default:
      content = <Summary shopName={me.shop?.name ?? ''} />;
  }

  return (
    <div className="min-h-screen lg:flex">
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 transform bg-zinc-950 text-zinc-300 transition lg:static lg:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center justify-between px-5 py-5">
          <div className="font-bold text-white">
            <Scissors className="mr-2 inline size-5 text-gold" />
            {me.shop?.name}
          </div>
          <button className="lg:hidden" onClick={() => setMenuOpen(false)} aria-label="Fechar menu">
            <X className="size-5" />
          </button>
        </div>
        <nav className="space-y-1 px-3">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                navigate(`/painel${id ? `/${id}` : ''}`);
                setMenuOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${section === id ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white'}`}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
        <div className="mt-6 space-y-1 border-t border-white/10 px-3 pt-4">
          {me.shop && (
            <a href={`/b/${me.shop.slug}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-white/5 hover:text-white">
              <ExternalLink className="size-4" /> Ver meu site
            </a>
          )}
          <button
            onClick={() => api('POST', '/api/auth/logout').then(onLogout)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-white/5 hover:text-white"
          >
            <LogOut className="size-4" /> Sair
          </button>
        </div>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMenuOpen(false)} />}

      <div className="min-w-0 flex-1">
        {me.user?.acting && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-300 px-4 py-2 text-sm text-amber-950">
            <span>
              Você está no painel da <b>{me.shop?.name}</b> como master.
            </span>
            <button
              className="rounded-md bg-amber-950 px-3 py-1 text-xs font-semibold text-amber-50"
              onClick={() =>
                api('POST', '/api/master/exit').then(() => {
                  history.replaceState(null, '', '/');
                  onLogout();
                })
              }
            >
              Voltar ao painel master
            </button>
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 lg:hidden">
          <button onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
            <Menu className="size-5" />
          </button>
          <span className="font-semibold">{SECTIONS.find((s) => s.id === section)?.label ?? 'Resumo'}</span>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">{content}</main>
      </div>
    </div>
  );
}
