import {
  BarChart3,
  Boxes,
  Bot as BotIcon,
  CalendarDays,
  CreditCard,
  Crown,
  ExternalLink,
  HandCoins,
  Gift,
  Handshake,
  LayoutDashboard,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  Package,
  PackageCheck,
  Palette,
  Scissors,
  Sparkles,
  Star,
  Store,
  Ticket,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me } from '../App';
import { AccountModal } from '../components/Account';
import { PixConfirmModal } from '../components/Pix';
import { CrudPage, type Row } from '../components/CrudPage';
import { Badge, Button, ErrorText } from '../components/ui';
import { api } from '../lib/api';
import { date, money } from '../lib/format';
import { navigate, usePath } from '../lib/router';
import { Agenda } from './panel/Agenda';
import { Barbers } from './panel/Barbers';
import { Benefits } from './panel/Benefits';
import { Bot } from './panel/Bot';
import { Brand } from './panel/Brand';
import { Counter } from './panel/Counter';
import { Finance } from './panel/Finance';
import { Club } from './panel/Club';
import { Growth } from './panel/Growth';
import { Prepaid } from './panel/Prepaid';
import { Reports } from './panel/Reports';
import { Reviews } from './panel/Reviews';
import { Stock } from './panel/Stock';
import { Subscription } from './panel/Subscription';
import { Summary } from './panel/Summary';
import { PushBanner } from '../components/AppInstall';

const SECTIONS = [
  { id: '', label: 'Resumo', icon: LayoutDashboard },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'balcao', label: 'Balcão', icon: Store },
  { id: 'financeiro', label: 'Financeiro', icon: Wallet },
  { id: 'relatorios', label: 'Relatórios', icon: BarChart3 },
  { id: 'robo', label: 'Robô WhatsApp', icon: BotIcon },
  { id: 'avaliacoes', label: 'Avaliações', icon: Star },
  { id: 'clube', label: 'Clube de assinatura', icon: Crown },
  { id: 'pacotes', label: 'Pacotes e vale-presente', icon: PackageCheck },
  { id: 'campanhas', label: 'Campanhas', icon: Gift },
  { id: 'beneficios', label: 'Benefícios', icon: Ticket },
  { id: 'indicacoes', label: 'Indicação e promoções', icon: UserPlus },
  { id: 'parceiros', label: 'Parceiros', icon: Handshake },
  { id: 'anuncios', label: 'Anúncios', icon: Megaphone },
  { id: 'barbeiros', label: 'Barbeiros', icon: Users },
  { id: 'servicos', label: 'Serviços', icon: Scissors },
  { id: 'produtos', label: 'Produtos', icon: Package },
  { id: 'estoque', label: 'Estoque', icon: Boxes },
  { id: 'marca', label: 'Minha marca', icon: Palette },
  { id: 'mensalidade', label: 'Mensalidade', icon: CreditCard },
];

interface ShopStatus {
  active: boolean;
  blocked: boolean;
  blockOn: string | null;
  overdue: boolean;
  openInvoices: number;
  /** Conexão do WhatsApp da barbearia (null = simulador). */
  whatsapp: { status: 'ok' | 'down' | 'unknown'; since: string | null; error: string | null } | null;
  /** PIX do clube que os clientes avisaram que pagaram (ou mandaram o comprovante) e o dono ainda não conferiu. */
  pixToConfirm?: number;
  /** Desses, quantos vieram com o comprovante. */
  receiptsToConfirm?: number;
  announcements: { id: number; title: string; body: string; level: 'novidade' | 'aviso' | 'manutencao' }[];
}

/** Avisos do master já fechados neste navegador. */
function dismissed(): number[] {
  try {
    return JSON.parse(localStorage.getItem('avisos-fechados') ?? '[]');
  } catch {
    return [];
  }
}

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

  const [status, setStatus] = useState<ShopStatus | null>(null);
  const [account, setAccount] = useState(false);
  const [pixOpen, setPixOpen] = useState(false);
  const [pixRefresh, setPixRefresh] = useState(0);
  const [hidden, setHidden] = useState<number[]>(dismissed);

  const loadRefs = useCallback(() => {
    api<Row[]>('GET', '/api/shop/partners').then(setPartners, () => undefined);
    api<Row[]>('GET', '/api/shop/catalog').then(setProducts, () => undefined);
  }, []);

  // Situação do acesso (mensalidade) e avisos da plataforma; recarrega ao trocar de tela.
  const loadStatus = useCallback(() => {
    // Se a consulta falhar, abre o painel normalmente (cada tela mostra o próprio erro).
    api<ShopStatus>('GET', '/api/shop/status').then(setStatus, () =>
      setStatus((s) => s ?? { active: true, blocked: false, blockOn: null, overdue: false, openInvoices: 0, whatsapp: null, announcements: [] }),
    );
  }, []);
  useEffect(loadStatus, [section, loadStatus]);

  // Link do aviso de comprovante no WhatsApp (/painel?conferir=1): abre a conferência do PIX uma vez.
  const askedPix = useRef(new URLSearchParams(location.search).has('conferir'));
  useEffect(() => {
    if (!askedPix.current || !status) return;
    askedPix.current = false;
    history.replaceState(null, '', location.pathname);
    if (status.active && !status.blocked) setPixOpen(true);
  }, [status]);

  function hideAnnouncement(id: number) {
    const next = [...hidden, id];
    setHidden(next);
    try {
      localStorage.setItem('avisos-fechados', JSON.stringify(next));
    } catch {
      /* navegador sem armazenamento: some só nesta visita */
    }
  }

  const locked = Boolean(status?.blocked);
  // Bloqueado por mensalidade, qualquer endereço do painel abre a tela da mensalidade.
  const current = locked ? 'mensalidade' : section;
  // Cadastros de apoio só com o painel liberado (bloqueado, só a mensalidade funciona).
  const ready = Boolean(status && status.active && !locked);
  useEffect(() => {
    if (ready) loadRefs();
  }, [ready, loadRefs]);

  useEffect(() => {
    if (!path.startsWith('/painel')) history.replaceState(null, '', '/painel');
  }, [path]);

  const partnerOptions = [{ value: null, label: '— nenhum —' }, ...partners.map((p) => ({ value: p.id, label: p.name }))];
  const partnerName = (id: number | null) => partners.find((p) => p.id === id)?.name;

  let content;
  switch (current) {
    case 'financeiro':
      content = <Finance />;
      break;
    case 'mensalidade':
      content = <Subscription />;
      break;
    case 'estoque':
      content = <Stock />;
      break;
    case 'avaliacoes':
      content = <Reviews />;
      break;
    case 'relatorios':
      content = <Reports />;
      break;
    case 'pacotes':
      content = <Prepaid shopName={me.shop?.name ?? ''} />;
      break;
    case 'clube':
      content = <Club key={pixRefresh} />;
      break;
    case 'indicacoes':
      content = <Growth />;
      break;
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
              label: 'Produto ou serviço que dá carimbo (opcional)',
              hint: 'Ao fechar uma venda com esse item, o carimbo entra sozinho no cartão do cliente.',
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
            ...(kind === 'service'
              ? [{ key: 'duration_min', label: 'Duração (minutos)', type: 'number' as const }]
              : [
                  { key: 'cost_cents', label: 'Custo (R$, opcional)', type: 'money' as const, hint: 'Quanto você paga por unidade.' },
                  {
                    key: 'track_stock',
                    label: 'Controlar estoque',
                    type: 'checkbox' as const,
                    hint: 'A venda dá baixa sozinha; lance as compras na tela Estoque.',
                  },
                  { key: 'stock_min', label: 'Avisar quando tiver só (unidades)', type: 'number' as const, hint: 'Estoque mínimo para o aviso de reposição.' },
                ]),
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
                  {r.track_stock ? <span className={r.stock_qty <= (r.stock_min ?? 0) ? 'text-red-600' : 'text-zinc-500'}> · {r.stock_qty} em estoque</span> : ''}
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
      content = <Summary shopName={me.shop?.name ?? ''} onAccount={() => setAccount(true)} />;
  }

  // Espera saber se o acesso está liberado antes de abrir qualquer tela.
  if (!status) return null;
  // Primeiro acesso do dono: aceite dos termos de uso e da política de privacidade.
  if (!me.user?.termsAccepted) return <TermsGate onAccepted={onLogout} onLogout={() => api('POST', '/api/auth/logout').then(onLogout)} />;
  if (!status.active) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
        <div className="max-w-md space-y-3 rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-zinc-200">
          <Lock className="mx-auto size-10 text-zinc-400" />
          <p className="text-lg font-bold">Barbearia suspensa</p>
          <p className="text-sm text-zinc-500">O acesso a esta barbearia foi suspenso pelo administrador da plataforma. Fale com o suporte para reativar.</p>
          <button className="text-sm font-medium text-zinc-600 hover:text-zinc-900" onClick={() => api('POST', '/api/auth/logout').then(onLogout)}>
            Sair
          </button>
        </div>
      </div>
    );
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
              disabled={locked && id !== 'mensalidade'}
              onClick={() => {
                navigate(`/painel${id ? `/${id}` : ''}`);
                setMenuOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${current === id ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white'}`}
            >
              <Icon className="size-4" /> {label}
              {id === 'mensalidade' && status?.overdue && <span className="ml-auto size-2 rounded-full bg-red-500" aria-label="Fatura vencida" />}
            </button>
          ))}
        </nav>
        <div className="mt-6 space-y-1 border-t border-white/10 px-3 pt-4">
          {me.shop && (
            <a href={`/b/${me.shop.slug}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-white/5 hover:text-white">
              <ExternalLink className="size-4" /> Ver meu site
            </a>
          )}
          <button onClick={() => setAccount(true)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-white/5 hover:text-white">
            <UserCog className="size-4" /> Minha conta
          </button>
          <button
            onClick={() => api('POST', '/api/auth/logout').then(onLogout)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-white/5 hover:text-white"
          >
            <LogOut className="size-4" /> Sair
          </button>
        </div>
      </aside>
      {pixOpen && (
        <PixConfirmModal
          onClose={() => setPixOpen(false)}
          onChanged={() => {
            loadStatus();
            setPixRefresh((n) => n + 1);
          }}
        />
      )}
      {account && <AccountModal me={me} onClose={() => setAccount(false)} onSaved={onLogout} />}
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMenuOpen(false)} />}

      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 lg:hidden">
          <button onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
            <Menu className="size-5" />
          </button>
          <span className="font-semibold">{SECTIONS.find((s) => s.id === current)?.label ?? 'Resumo'}</span>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
          {status?.whatsapp?.status === 'down' && (
            <button
              onClick={() => navigate('/painel/robo')}
              className="mb-4 flex w-full items-start gap-2 rounded-xl bg-red-50 px-4 py-2.5 text-left text-sm text-red-900 ring-1 ring-red-200"
            >
              <WifiOff className="mt-0.5 size-4 shrink-0" />
              <span>
                <b>WhatsApp desconectado</b>
                {status.whatsapp.since && ` desde ${new Date(status.whatsapp.since).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`}: o robô e os lembretes estão parados.{' '}
                <u>Reconectar</u>
              </span>
            </button>
          )}
          {Boolean(status?.pixToConfirm) && !locked && (
            <button
              onClick={() => setPixOpen(true)}
              className="mb-4 flex w-full items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2.5 text-left text-sm text-emerald-950 ring-1 ring-emerald-200"
            >
              <HandCoins className="size-4 shrink-0" />
              <span>
                {status!.pixToConfirm === 1 ? '1 cliente avisou que pagou o PIX' : `${status!.pixToConfirm} clientes avisaram que pagaram o PIX`}
                {status!.receiptsToConfirm ? ` (${status!.receiptsToConfirm === 1 ? '1 com comprovante' : `${status!.receiptsToConfirm} com comprovante`})` : ''}.{' '}
                <b>Conferir</b>
              </span>
            </button>
          )}
          {status?.overdue && !locked && section !== 'mensalidade' && (
            <button
              onClick={() => navigate('/painel/mensalidade')}
              className="mb-4 flex w-full items-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-left text-sm text-amber-900 ring-1 ring-amber-200"
            >
              <CreditCard className="size-4 shrink-0" />
              <span>
                ⚠ Há mensalidade vencida{status.blockOn ? `. Pague até ${date(status.blockOn)} para não ter o acesso suspenso` : ''}. <b>Ver fatura</b>
              </span>
            </button>
          )}
          {status?.announcements
            .filter((a) => !hidden.includes(a.id))
            .map((a) => (
              <div key={a.id} className="mb-4 flex items-start gap-3 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-950 ring-1 ring-sky-200">
                <Sparkles className="mt-0.5 size-4 shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold">
                    {a.level === 'manutencao' ? 'Manutenção: ' : a.level === 'aviso' ? 'Aviso: ' : 'Novidade: '}
                    {a.title}
                  </p>
                  <p className="whitespace-pre-line">{a.body}</p>
                </div>
                <button onClick={() => hideAnnouncement(a.id)} className="rounded p-0.5 hover:bg-sky-100" aria-label="Fechar aviso">
                  <X className="size-4" />
                </button>
              </div>
            ))}
          {!locked && <PushBanner text="Receba no celular os horários que os clientes marcarem (pelo site e pelo robô) e os cancelados." />}
          {content}
        </main>
      </div>
    </div>
  );
}

/** Aceite dos termos de uso e da política de privacidade (uma vez por login). */
function TermsGate({ onAccepted, onLogout }: { onAccepted: () => void; onLogout: () => void }) {
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <div className="max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
        <p className="text-lg font-bold">Antes de começar</p>
        <p className="text-sm text-zinc-600">
          Leia os{' '}
          <a href="/termos" target="_blank" rel="noreferrer" className="font-medium text-zinc-900 underline">
            termos de uso
          </a>{' '}
          e a{' '}
          <a href="/privacidade" target="_blank" rel="noreferrer" className="font-medium text-zinc-900 underline">
            política de privacidade
          </a>
          . Pela LGPD, a barbearia é a responsável pelos dados dos clientes dela, e o sistema cuida deles em nome da barbearia.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-zinc-900" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          Li e aceito os termos de uso e a política de privacidade.
        </label>
        <ErrorText error={error} />
        <Button className="w-full" disabled={!checked} onClick={() => api('POST', '/api/auth/accept-terms').then(onAccepted, (e) => setError(e.message))}>
          Continuar
        </Button>
        <button className="w-full text-center text-sm text-zinc-500 hover:text-zinc-900" onClick={onLogout}>
          Sair
        </button>
      </div>
    </div>
  );
}
