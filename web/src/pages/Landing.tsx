import '@fontsource/anton/400.css';
import '@fontsource-variable/bricolage-grotesque';
import {
  ArrowRight,
  AtSign,
  Bot,
  CalendarCheck,
  ChartLine,
  CircleCheck,
  Crown,
  LogIn,
  MessageCircle,
  Plus,
  QrCode,
  RefreshCw,
  Scissors,
  Smartphone,
  UserPlus,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { BladrMark } from '../components/BladrMark';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { EntryCard } from './Home';

/** WhatsApp comercial da Bladr (o botão "Chamar no WhatsApp" da página). */
const SALES_WHATSAPP = '5521981718320';
const SALES_PHONE_LABEL = '(21) 98171-8320';
const INSTAGRAM = 'https://instagram.com/bladr';
const whatsLink = (text: string) => `https://wa.me/${SALES_WHATSAPP}?text=${encodeURIComponent(text)}`;

interface Pricing {
  trialDays: number;
  signupEnabled: boolean;
  plans: { name: string; price_cents: number; description: string | null }[];
  network: { minPerUnitCents: number; plans: number } | null;
  discounts: { trimestral: number; semestral: number; anual: number };
  setupFeeCents: number;
  setupFreeFromSemester: boolean;
}

type AuthMode = 'login' | 'signup';
const modeFromHash = (): AuthMode | null => (location.hash === '#cadastro' ? 'signup' : location.hash === '#entrar' ? 'login' : null);

/**
 * Página de vendas da Bladr (a página inicial do sistema): a mesma linguagem da landing feita no Framer,
 * com os preços vindos do master. Entrar e criar a barbearia abrem numa janela; os links
 * /#entrar e /#cadastro abrem direto nela.
 */
export function Landing({ onLogin }: { onLogin: () => void }) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [auth, setAuth] = useState<AuthMode | null>(modeFromHash);
  useEffect(() => {
    document.title = 'Bladr · Sua barbearia no automático';
    api<Pricing>('GET', '/api/public/pricing').then(setPricing, () => undefined);
    const onHash = () => setAuth(modeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const trial = pricing?.trialDays ?? 7;
  const open = (mode: AuthMode) => () => setAuth(mode);

  return (
    <div className="min-h-screen bg-[#0b0b0c] font-brico text-[#f5f2ea] selection:bg-brand selection:text-black">
      {/* Com a janela aberta, o resto da página fica inativo (teclado e leitores de tela ficam nela). */}
      <div inert={Boolean(auth)}>
        <Nav onEnter={open('login')} onSignup={open('signup')} />
        <Hero trial={trial} onSignup={open('signup')} />
        <Ticker />
        <Features />
        <Steps trial={trial} />
        <Plans pricing={pricing} onSignup={open('signup')} />
        <Faq trial={trial} />
        <FinalCta trial={trial} onSignup={open('signup')} />
        <Footer onEnter={open('login')} onSignup={open('signup')} />
      </div>
      {auth && (
        <AuthDialog
          mode={auth}
          onClose={() => {
            setAuth(null);
            if (location.hash) history.replaceState(null, '', location.pathname);
          }}
          onDone={onLogin}
        />
      )}
    </div>
  );
}

// ---------- peças

const Wrap = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`mx-auto w-full max-w-[1160px] px-5 sm:px-8 ${className}`}>{children}</div>
);

const Label = ({ children, center = false }: { children: ReactNode; center?: boolean }) => (
  <p className={`text-[13px] font-bold tracking-[0.14em] text-brand uppercase ${center ? 'text-center' : ''}`}>{children}</p>
);

const Title = ({ children, center = false }: { children: ReactNode; center?: boolean }) => (
  <h2 className={`font-display text-[44px] leading-[0.95] text-balance uppercase sm:text-6xl lg:text-[76px] ${center ? 'text-center' : ''}`}>{children}</h2>
);

function CtaButton({ children, onClick, href, variant = 'primary', icon: Icon = ArrowRight, className = '' }: { children: ReactNode; onClick?: () => void; href?: string; variant?: 'primary' | 'ghost' | 'dark'; icon?: LucideIcon; className?: string }) {
  const look = {
    primary: 'bg-brand text-[#0b0b0c] hover:brightness-110',
    ghost: 'bg-white/5 text-[#f5f2ea] ring-1 ring-white/20 hover:bg-white/10',
    dark: 'bg-[#0b0b0c] text-brand hover:bg-black',
  }[variant];
  const cls = `inline-flex items-center justify-center gap-2.5 rounded-full px-7 py-4 text-base font-bold transition active:scale-[0.97] ${look} ${className}`;
  const body = (
    <>
      {children}
      <Icon className="size-[18px]" />
    </>
  );
  if (href)
    return (
      <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className={cls}>
        {body}
      </a>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

function Logo() {
  return (
    <a href="#inicio" className="flex items-center gap-2.5" aria-label="Bladr, início">
      <BladrMark className="size-9 rounded-lg ring-1 ring-white/10" />
      <span className="hidden text-[26px] leading-none font-extrabold tracking-tight min-[380px]:inline">bladr.</span>
    </a>
  );
}

// ---------- menu

function Nav({ onEnter, onSignup }: { onEnter: () => void; onSignup: () => void }) {
  return (
    <nav className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#0b0b0c]/75 backdrop-blur-lg">
      <Wrap className="flex items-center justify-between py-3.5">
        <Logo />
        <div className="hidden items-center gap-8 md:flex">
          {[
            ['Recursos', '#recursos'],
            ['Como começar', '#comecar'],
            ['Planos', '#planos'],
            ['Dúvidas', '#duvidas'],
          ].map(([label, href]) => (
            <a key={href} href={href} className="text-[15px] font-semibold text-[#a3a3a8] transition hover:text-brand">
              {label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onEnter} className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-[15px] font-semibold ring-1 ring-white/20 transition hover:bg-white/10">
            <LogIn className="size-4" /> Entrar
          </button>
          <button type="button" onClick={onSignup} className="rounded-full bg-brand px-4 py-2.5 text-[15px] font-bold text-[#0b0b0c] transition hover:brightness-110 sm:px-5">
            Testar grátis
          </button>
        </div>
      </Wrap>
    </nav>
  );
}

// ---------- abertura

function Hero({ trial, onSignup }: { trial: number; onSignup: () => void }) {
  return (
    <header id="inicio" className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute -top-64 -right-48 size-[760px] rounded-full bg-[radial-gradient(closest-side,rgba(255,176,32,0.22),transparent)]" />
      <Wrap className="relative grid items-center gap-14 py-16 lg:grid-cols-[1fr_440px] lg:py-24">
        <div className="space-y-7">
          <p className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-3.5 py-2 text-sm font-bold text-brand ring-1 ring-brand/35">
            <Scissors className="size-4" /> Feito pra barbearia que não para
          </p>
          <h1 className="font-display text-[58px] leading-[0.92] uppercase sm:text-[78px] lg:text-[100px]">
            Agenda cheia. <span className="text-brand">Caixa em dia.</span> Você só corta.
          </h1>
          <p className="max-w-[600px] text-lg leading-relaxed text-pretty text-[#a3a3a8] sm:text-xl">
            A Bladr coloca um robô no WhatsApp da sua barbearia: ele marca, lembra, confirma e ainda chama de volta quem sumiu. Agenda, fila, caixa e app com a
            sua marca, tudo num lugar só.
          </p>
          <div className="flex flex-wrap gap-3">
            <CtaButton onClick={onSignup}>Testar {trial} dias grátis</CtaButton>
            <CtaButton variant="ghost" href={whatsLink('Oi! Quero conhecer a Bladr.')} icon={MessageCircle}>
              Chamar no WhatsApp
            </CtaButton>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-semibold">
            {['Sem cartão', 'Pronto em 2 minutos', 'App com a sua marca'].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <CircleCheck className="size-[18px] text-brand" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <ChatPhone />
      </Wrap>
    </header>
  );
}

/** O robô conversando no WhatsApp (no estilo do aplicativo, modo escuro). */
function ChatPhone() {
  const bubbles: { me?: boolean; text: string; time: string }[] = [
    { text: 'Fala, Lucas! Já faz 30 dias do seu último corte 💈 Sexta às 18h tá livre com o Gui. Bora marcar?', time: '09:12' },
    { me: true, text: 'Bora! Marca aí 🔥', time: '09:15' },
    { text: 'Fechado ✅ Sexta, 18h, corte + barba com o Gui. Na véspera eu te lembro por aqui!', time: '09:15' },
  ];
  return (
    <div className="relative mx-auto w-full max-w-[340px] rotate-2 lg:max-w-none" aria-label="Exemplo de conversa do robô no WhatsApp">
      <div className="overflow-hidden rounded-[44px] bg-[#0b141a] p-2.5 shadow-[0_30px_80px_rgba(0,0,0,0.55)] ring-1 ring-white/15">
        <div className="overflow-hidden rounded-[36px] bg-[#0b141a]">
          <div className="flex items-center gap-3 bg-[#1f2c34] px-4 py-3.5">
            <span className="flex size-10 items-center justify-center rounded-full bg-brand text-[#0b0b0c]">
              <Scissors className="size-5" />
            </span>
            <div className="leading-tight">
              <p className="text-[15px] font-bold">Barbearia do Gui</p>
              <p className="text-xs text-[#8696a0]">online</p>
            </div>
          </div>
          <div className="flex min-h-[380px] flex-col gap-2.5 bg-[radial-gradient(rgba(255,255,255,0.035)_1px,transparent_1px)] [background-size:14px_14px] px-3 py-5">
            <p className="mx-auto mb-1 rounded-lg bg-[#182229] px-3 py-1 text-[11px] font-semibold tracking-wide text-[#8696a0] uppercase">Hoje</p>
            {bubbles.map((b, i) => (
              <div
                key={i}
                style={{ animationDelay: `${0.3 + i * 0.6}s` }}
                className={`motion-safe:animate-rise max-w-[84%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-snug shadow ${b.me ? 'self-end rounded-tr-md bg-[#005c4b]' : 'self-start rounded-tl-md bg-[#202c33]'}`}
              >
                {!b.me && i === 0 && <p className="mb-0.5 text-xs font-bold text-brand">Robô da barbearia</p>}
                {b.text}
                <span className="ml-2 align-bottom text-[11px] text-[#8696a0]">{b.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ animationDelay: '2.2s' }} className="motion-safe:animate-rise absolute -bottom-5 -left-3 flex -rotate-3 items-center gap-3 rounded-full bg-[#0b0b0c] py-2.5 pr-5 pl-2.5 shadow-xl ring-1 ring-brand/50 sm:-left-8">
        <span className="flex size-9 items-center justify-center rounded-full bg-brand text-[#0b0b0c]">
          <CalendarCheck className="size-5" />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-bold">Horário confirmado</span>
          <span className="block text-[13px] text-[#a3a3a8]">Sex · 18:00 · Corte + barba</span>
        </span>
      </div>
    </div>
  );
}

// ---------- faixa

function Ticker() {
  const words = ['Agenda cheia', 'Robô no WhatsApp', 'Caixa em dia', 'Fila pelo celular', 'App com a sua marca', 'Clube de assinatura', 'Cliente voltando'];
  const row = (hidden: boolean) => (
    <div className="flex shrink-0 items-center gap-9 pr-9" aria-hidden={hidden || undefined}>
      {words.map((w) => (
        <span key={w} className="flex items-center gap-9">
          <span className="font-display text-[26px] whitespace-nowrap uppercase sm:text-[34px]">{w}</span>
          <Scissors className="size-7" />
        </span>
      ))}
    </div>
  );
  return (
    <div className="overflow-hidden bg-brand py-5 text-[#0b0b0c]">
      <div className="flex w-max motion-safe:animate-marquee">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

// ---------- recursos

const FEATURES: { icon: LucideIcon; title: string; text: string; wide?: boolean; hot?: boolean }[] = [
  {
    icon: Bot,
    title: 'Seu robô atende 24h no WhatsApp',
    text: 'Com o nome que você escolher, ele marca, remarca, cancela, manda lembrete e pede confirmação. Até de madrugada, enquanto você dorme.',
    wide: true,
    hot: true,
  },
  { icon: RefreshCw, title: 'Chama de volta quem sumiu', text: 'Respeita o ritmo de cada cliente e manda um desconto de volta. Você vê quem voltou e quanto gastou.' },
  { icon: QrCode, title: 'Agenda e fila juntas', text: 'Quem marcou não espera. Quem chegou entra na fila pelo QR Code do balcão e é avisado na vez.' },
  { icon: Wallet, title: 'Caixa e comissão no automático', text: 'Cada atendimento cai no caixa com PIX, cartão, gorjeta e a comissão de cada barbeiro calculada.' },
  { icon: Crown, title: 'Clube de assinatura', text: 'Dinheiro entrando todo mês: o cliente assina e paga no PIX automático ou no cartão.' },
  {
    icon: Smartphone,
    title: 'App com a cara da sua barbearia',
    text: 'Seu cliente instala, agenda, junta carimbo no cartão fidelidade, vê os parceiros e compra na sua loja.',
    wide: true,
  },
  { icon: ChartLine, title: 'Relatórios que mostram o caminho', text: 'Quanto entrou, ticket médio, previsão do mês e os horários mais vazios da semana.' },
];

function Features() {
  return (
    <section id="recursos" className="scroll-mt-20 py-24 sm:py-28">
      <Wrap className="space-y-12">
        <div className="grid items-end gap-6 lg:grid-cols-2 lg:gap-10">
          <div className="space-y-4">
            <Label>Tudo num app só</Label>
            <Title>Feito pro corre da barbearia</Title>
          </div>
          <p className="text-lg leading-relaxed text-pretty text-[#a3a3a8] sm:text-xl">
            Chega de caderno, planilha e mensagem esquecida. A Bladr cuida do que tira o seu tempo, e você fica na cadeira fazendo o que sabe.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text, wide, hot }) => (
            <article
              key={title}
              className={`flex min-h-[250px] flex-col justify-between gap-8 rounded-[28px] p-7 sm:p-8 ${wide ? 'md:col-span-2' : ''} ${hot ? 'bg-brand text-[#0b0b0c]' : 'bg-[#161618] ring-1 ring-white/[0.08]'}`}
            >
              <span className={`flex size-[52px] items-center justify-center rounded-2xl ${hot ? 'bg-[#0b0b0c] text-brand' : 'bg-brand/12 text-brand'}`}>
                <Icon className="size-[26px]" />
              </span>
              <div className="space-y-2.5">
                <h3 className={`font-bold tracking-tight text-balance ${hot ? 'text-3xl leading-[1.05] sm:text-4xl' : 'text-2xl leading-tight'}`}>{title}</h3>
                <p className={`text-pretty ${hot ? 'max-w-[620px] text-lg leading-relaxed text-[#0b0b0c]/80' : 'leading-relaxed text-[#a3a3a8]'}`}>{text}</p>
              </div>
            </article>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

// ---------- como começar

function Steps({ trial }: { trial: number }) {
  const steps: [string, string, LucideIcon][] = [
    ['Cria a conta', `Nome, celular e senha. ${trial} dias grátis, sem cartão, e a marca montada em um minuto: logo, cores e frase.`, UserPlus],
    ['Traz seus clientes', 'Importa a planilha do Excel ou do sistema antigo. Ninguém fica de fora do recontato.', Users],
    ['Liga o WhatsApp', 'Segue os primeiros passos do painel e o robô começa a trabalhar no mesmo dia.', MessageCircle],
  ];
  return (
    <section id="comecar" className="scroll-mt-20 pb-24 sm:pb-28">
      <Wrap className="space-y-12">
        <div className="max-w-[680px] space-y-4">
          <Label>Como começar</Label>
          <Title>Começar é rapidinho</Title>
          <p className="text-lg leading-relaxed text-pretty text-[#a3a3a8] sm:text-xl">
            Três passos e a sua barbearia já está no automático. E se quiser, a gente faz a implantação junto com você.
          </p>
        </div>
        <ol className="grid gap-4 lg:grid-cols-3">
          {steps.map(([title, text, Icon], i) => (
            <li key={title} className="space-y-7 rounded-[28px] border border-dashed border-white/[0.16] bg-white/[0.02] p-7 sm:p-8">
              <div className="flex items-center justify-between">
                <span className="font-display text-[88px] leading-none text-brand">0{i + 1}</span>
                <Icon className="size-8" />
              </div>
              <div className="space-y-2.5">
                <h3 className="text-2xl font-bold tracking-tight">{title}</h3>
                <p className="leading-relaxed text-pretty text-[#a3a3a8]">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Wrap>
    </section>
  );
}

// ---------- planos (preços do master)

function Plans({ pricing, onSignup }: { pricing: Pricing | null; onSignup: () => void }) {
  const d = pricing?.discounts;
  const setup = pricing?.setupFeeCents ?? 0;
  return (
    <section id="planos" className="scroll-mt-20 border-y border-white/[0.06] bg-[#111113] py-24 sm:py-28">
      <Wrap className="space-y-12">
        <div className="mx-auto max-w-[760px] space-y-4 text-center">
          <Label center>Planos</Label>
          <Title center>Preço justo, tudo incluso</Title>
          <p className="text-lg leading-relaxed text-balance text-[#a3a3a8] sm:text-xl">
            Todos os planos com robô com IA, recontato, fila de chegada, app com a sua marca, loja, clube, PIX automático e relatórios.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(pricing?.plans ?? []).map((p) => {
            const hot = p.name === 'Equipe';
            return (
              <article
                key={p.name}
                className={`flex flex-col justify-between gap-8 rounded-[28px] px-7 py-8 ${hot ? 'bg-brand text-[#0b0b0c] shadow-[0_20px_60px_rgba(255,176,32,0.25)]' : 'bg-[#161618] ring-1 ring-white/[0.08]'}`}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-2xl font-bold tracking-tight">{p.name}</h3>
                    {hot && <span className="rounded-full bg-[#0b0b0c] px-2.5 py-1.5 text-[13px] font-medium text-brand">Mais escolhido</span>}
                  </div>
                  <p className="flex items-end gap-1.5">
                    <span className="mb-2 text-sm font-bold">R$</span>
                    <span className="font-display text-[56px] leading-none tabular-nums">{money(p.price_cents).replace(/^R\$\s?/, '')}</span>
                    <span className={`mb-2 text-[13px] ${hot ? 'text-[#0b0b0c]/70' : 'text-[#a3a3a8]'}`}>/mês</span>
                  </p>
                  {p.description && (
                    <p className="flex items-center gap-2 text-[15px] font-semibold">
                      <Scissors className={`size-[18px] shrink-0 ${hot ? '' : 'text-brand'}`} /> {p.description.replace(/\s*·\s*tudo incluso$/i, '')}
                    </p>
                  )}
                </div>
                <CtaButton variant={hot ? 'dark' : 'ghost'} onClick={onSignup} className="w-full">
                  Testar grátis
                </CtaButton>
              </article>
            );
          })}
        </div>
        {pricing && (
          <div className="space-y-2.5 text-center">
            <p className="text-balance text-[#a3a3a8]">
              {d && `Trimestral ${d.trimestral}% · Semestral ${d.semestral}% · Anual ${d.anual}% de desconto. `}
              {setup > 0
                ? `Implantação de ${money(setup)}${pricing.setupFreeFromSemester ? ' no mensal e no trimestral, grátis no semestral e no anual' : ''}.`
                : 'Sem taxa de implantação.'}
            </p>
            {pricing.network && (
              <p className="text-[15px] font-semibold text-balance text-brand">
                Tem rede? Barbeiros ilimitados em cada unidade, a partir de {money(pricing.network.minPerUnitCents)} por unidade.
              </p>
            )}
          </div>
        )}
      </Wrap>
    </section>
  );
}

// ---------- dúvidas

function Faq({ trial }: { trial: number }) {
  const items: [string, string][] = [
    ['Preciso de cartão pra testar?', `Não. São ${trial} dias grátis, sem cartão. A cobrança só vence depois do último dia do teste, e você escolhe se quer continuar.`],
    [
      'O robô funciona no WhatsApp da minha barbearia?',
      'Funciona. Ele atende com o nome que você escolher, marca, remarca, cancela e manda lembrete. Antes de ligar, você testa a conversa no simulador.',
    ],
    ['Atendo por ordem de chegada. A Bladr serve pra mim?', 'Serve. Você usa a agenda, a fila de chegada pelo QR Code ou as duas juntas. Quem marcou horário não perde a vez.'],
    ['Consigo trazer os clientes do sistema antigo?', 'Consegue. É só importar a planilha do Excel ou a exportação do sistema que você usa hoje.'],
    ['E se eu tiver mais de uma unidade?', 'Tem plano de rede, com barbeiros ilimitados em cada unidade e os números de todas lado a lado no mesmo painel.'],
  ];
  return (
    <section id="duvidas" className="scroll-mt-20 py-24 sm:py-28">
      <Wrap className="max-w-[860px] space-y-12">
        <div className="space-y-4 text-center">
          <Label center>Dúvidas</Label>
          <Title center>Ficou alguma dúvida?</Title>
        </div>
        <div className="space-y-2.5">
          {items.map(([q, a]) => (
            <details key={q} className="group rounded-[20px] bg-[#161618] ring-1 ring-white/[0.08] open:ring-brand/40">
              <summary className="flex cursor-pointer list-none items-center gap-5 px-6 py-5 text-[19px] leading-snug font-bold select-none [&::-webkit-details-marker]:hidden">
                <span className="flex-1">{q}</span>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-[#0b0b0c] transition group-open:rotate-45">
                  <Plus className="size-[18px]" />
                </span>
              </summary>
              <p className="px-6 pb-6 leading-relaxed text-pretty text-[#a3a3a8]">{a}</p>
            </details>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

// ---------- chamada final e rodapé

function FinalCta({ trial, onSignup }: { trial: number; onSignup: () => void }) {
  return (
    <section className="pb-24 sm:pb-28">
      <Wrap>
        <div className="relative overflow-hidden rounded-[40px] bg-[#161618] px-6 py-20 ring-1 ring-white/[0.08] sm:px-10 sm:py-24">
          {/* Listras de barbearia, bem de leve. */}
          <div aria-hidden className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,176,32,0.07)_0_22px,transparent_22px_44px)]" />
          <div aria-hidden className="absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_100%,rgba(255,176,32,0.18),transparent)]" />
          <div className="relative mx-auto max-w-[760px] space-y-6 text-center">
            <h2 className="font-display text-[58px] leading-[0.92] uppercase sm:text-[78px] lg:text-[100px]">
              Bora encher <span className="text-brand">essa agenda?</span>
            </h2>
            <p className="text-lg leading-relaxed text-balance sm:text-xl">
              Crie a conta da sua barbearia agora e teste tudo por {trial} dias, sem cartão. Ficou com dúvida? Chama a gente no WhatsApp.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <CtaButton onClick={onSignup}>Criar minha barbearia</CtaButton>
              <CtaButton variant="ghost" href={whatsLink('Oi! Quero conhecer a Bladr.')} icon={MessageCircle}>
                {SALES_PHONE_LABEL}
              </CtaButton>
            </div>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

function Footer({ onEnter, onSignup }: { onEnter: () => void; onSignup: () => void }) {
  const link = 'text-left text-[15px] font-semibold text-[#a3a3a8] transition hover:text-brand';
  const col = (title: string, items: ReactNode) => (
    <div className="space-y-3">
      <Label>{title}</Label>
      <ul className="space-y-2.5">{items}</ul>
    </div>
  );
  return (
    <footer className="border-t border-white/[0.07] py-14">
      <Wrap className="space-y-10">
        <div className="flex flex-col justify-between gap-10 lg:flex-row">
          <div className="max-w-[300px] space-y-4">
            <Logo />
            <p className="leading-relaxed text-[#a3a3a8]">Robô no WhatsApp, agenda, fila, caixa e app com a sua marca. Pra barbearia que não para.</p>
          </div>
          <div className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-4">
            {col(
              'Acessos',
              <>
                <li>
                  <button type="button" onClick={onEnter} className={link}>
                    Entrar (dono e equipe)
                  </button>
                </li>
                <li>
                  <button type="button" onClick={onSignup} className={link}>
                    Criar minha barbearia
                  </button>
                </li>
                <li>
                  <a href="/barbearias" className={link}>
                    Sou cliente: achar minha barbearia
                  </a>
                </li>
              </>,
            )}
            {col(
              'Produto',
              [
                ['Recursos', '#recursos'],
                ['Como começar', '#comecar'],
                ['Planos', '#planos'],
                ['Dúvidas', '#duvidas'],
              ].map(([l, h]) => (
                <li key={h}>
                  <a href={h} className={link}>
                    {l}
                  </a>
                </li>
              )),
            )}
            {col(
              'Fala com a gente',
              <>
                <li>
                  <a href={whatsLink('Oi! Quero conhecer a Bladr.')} target="_blank" rel="noreferrer" className={`${link} inline-flex items-center gap-1.5`}>
                    <MessageCircle className="size-4" /> WhatsApp
                  </a>
                </li>
                <li>
                  <a href={INSTAGRAM} target="_blank" rel="noreferrer" className={`${link} inline-flex items-center gap-1.5`}>
                    <AtSign className="size-4" /> Instagram
                  </a>
                </li>
              </>,
            )}
            {col(
              'Legal',
              <>
                <li>
                  <a href="/termos" className={link}>
                    Termos de uso
                  </a>
                </li>
                <li>
                  <a href="/privacidade" className={link}>
                    Privacidade
                  </a>
                </li>
              </>,
            )}
          </div>
        </div>
        <div className="flex flex-col justify-between gap-2 border-t border-white/[0.07] pt-6 text-[13px] text-[#a3a3a8] sm:flex-row">
          <p>© {new Date().getFullYear()} Bladr. Todos os direitos reservados.</p>
          <p className="inline-flex items-center gap-1.5">
            Feito com <Scissors className="size-3.5" /> pra barbearia brasileira
          </p>
        </div>
      </Wrap>
    </footer>
  );
}

// ---------- entrar e criar a barbearia (janela)

function AuthDialog({ mode, onClose, onDone }: { mode: AuthMode; onClose: () => void; onDone: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/75 px-4 py-10 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={mode === 'signup' ? 'Criar minha barbearia' : 'Entrar'} className="relative w-full max-w-md font-sans" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="absolute -top-12 right-0 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <X className="size-5" />
        </button>
        {/* key: trocar de "entrar" para "criar" pelo menu reabre no modo certo. */}
        <EntryCard key={mode} initialMode={mode} onDone={onDone} />
      </div>
    </div>
  );
}
