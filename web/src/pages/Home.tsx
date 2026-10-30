import { BarChart3, Bot, CalendarCheck, Camera, Crown, MessageCircle, Smartphone, Wallet } from 'lucide-react';
import { BladrMark } from '../components/BladrMark';
import { useEffect, useState, type FormEvent } from 'react';
import type { Me } from '../App';
import { Button, ErrorText, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { LegalLinks } from './Legal';

const FEATURES = [
  { icon: Bot, title: 'Robô no WhatsApp', text: 'Com o nome que você escolher: agenda, confirma a presença, avisa quando abre vaga e cobra o clube.' },
  { icon: CalendarCheck, title: 'Agenda que se enche sozinha', text: 'Lembrete com confirmação, lista de espera, horário vazio com desconto e o robô chamando quem sumiu.' },
  { icon: MessageCircle, title: 'Gerente virtual', text: 'Pergunte no WhatsApp quanto entrou hoje e como está a agenda. Toda segunda, o resumo da semana.' },
  { icon: Wallet, title: 'Financeiro completo', text: 'Caixa, comissões, PIX e cartão, pacotes pré-pagos e vale-presente, tudo calculado na comanda.' },
  { icon: BarChart3, title: 'Relatórios que mostram o caminho', text: 'Ocupação por dia e hora, clientes que voltam, quem está sumindo e a previsão do mês.' },
  { icon: Crown, title: 'Clube e fidelidade', text: 'Assinatura mensal, cartão fidelidade, indique um amigo e presente de aniversário.' },
  { icon: Smartphone, title: 'App com a sua marca', text: 'O cliente instala o app da sua barbearia e recebe os avisos no celular. Barbeiro e recepção também têm o deles.' },
  { icon: Camera, title: 'Ficha do cliente', text: 'O jeito que ele gosta e as fotos do corte: na próxima visita, qualquer barbeiro repete igual.' },
];

/** Página do sistema (não da barbearia): apresentação + entrada. */
export function Home({ me, onLogin }: { me: Me; onLogin: () => void }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:py-20">
        <div>
          <div className="mb-8 flex items-center gap-2 text-lg font-bold">
            <BladrMark className="size-8 ring-1 ring-white/10 rounded-lg" /> Bladr
          </div>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">
            A agenda cheia e o caixa em dia: <span className="text-gold">o sistema trabalha por você</span> no WhatsApp.
          </h1>
          <p className="mt-4 max-w-xl text-lg text-zinc-400">
            Agenda, robô, financeiro, clube, relatórios e app com a sua marca, num painel só. Para a barbearia de uma cadeira e para a rede com várias unidades.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
                <Icon className="mb-2 size-5 text-gold" />
                <p className="font-semibold">{title}</p>
                <p className="text-sm text-zinc-400">{text}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="lg:pt-16">{me.setupNeeded ? <SetupCard onDone={onLogin} /> : <EntryCard onDone={onLogin} />}</div>
      </div>
      <LegalLinks className="pb-8 text-zinc-500" />
    </div>
  );
}

/** Entrar ou criar a barbearia (cadastro sozinho com os dias grátis, quando o master deixa aberto). */
function EntryCard({ onDone }: { onDone: () => void }) {
  const [signup, setSignup] = useState<{ enabled: boolean; trialDays: number } | null>(null);
  const [mode, setMode] = useState<'login' | 'signup'>(() => (location.hash === '#cadastro' ? 'signup' : 'login'));
  useEffect(() => {
    api<{ enabled: boolean; trialDays: number }>('GET', '/api/public/signup').then(setSignup, () => undefined);
  }, []);
  if (mode === 'signup' && signup?.enabled) return <SignupCard trialDays={signup.trialDays} onBack={() => setMode('login')} onDone={onDone} />;
  return (
    <div className="space-y-3">
      <LoginCard onDone={onDone} />
      {signup?.enabled && (
        <button
          type="button"
          onClick={() => setMode('signup')}
          className="w-full rounded-2xl bg-gold px-4 py-3 text-center font-semibold text-zinc-950 shadow-lg transition hover:brightness-110"
        >
          Criar minha barbearia{signup.trialDays > 0 ? ` · ${signup.trialDays} dias grátis` : ''}
        </button>
      )}
    </div>
  );
}

function SignupCard({ trialDays, onBack, onDone }: { trialDays: number; onBack: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ shop_name: '', name: '', phone: '', email: '', password: '' });
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/public/signup', { ...form, email: form.email || null, accept });
      // Primeira parada depois do cadastro: o assistente de marca.
      navigate('/painel/marca?assistente=1');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 text-zinc-900 shadow-2xl">
      <div>
        <h2 className="text-xl font-bold">Criar minha barbearia</h2>
        <p className="text-sm text-zinc-500">{trialDays > 0 ? `${trialDays} dias grátis, sem cartão. ` : ''}Em 2 minutos você já está no painel.</p>
      </div>
      <Field label="Nome da barbearia">
        <Input required value={form.shop_name} onChange={set('shop_name')} placeholder="Ex.: Barbearia do Zé" />
      </Field>
      <Field label="Seu nome">
        <Input required autoComplete="name" value={form.name} onChange={set('name')} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Celular (WhatsApp)" hint="É o seu login e onde chegam os avisos.">
          <Input required type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} placeholder="(11) 99999-0000" />
        </Field>
        <Field label="E-mail (opcional)">
          <Input type="email" autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
      </div>
      <Field label="Senha" hint="Pelo menos 8 caracteres.">
        <Input required type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
      </Field>
      <label className="flex items-start gap-2 text-sm text-zinc-600">
        <input type="checkbox" className="mt-0.5 size-4" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
        <span>
          Li e aceito os{' '}
          <a href="/termos" target="_blank" rel="noreferrer" className="font-medium underline">
            termos de uso
          </a>{' '}
          e a{' '}
          <a href="/privacidade" target="_blank" rel="noreferrer" className="font-medium underline">
            política de privacidade
          </a>
          .
        </span>
      </label>
      <ErrorText error={error} />
      <Button type="submit" loading={busy} disabled={!accept} className="w-full">
        Criar minha barbearia
      </Button>
      <button type="button" className="w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-900" onClick={onBack}>
        Já tenho conta: entrar
      </button>
    </form>
  );
}

function LoginCard({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/login', { login, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (forgot) return <ForgotCard initial={login} onBack={() => setForgot(false)} onDone={onDone} />;

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 text-zinc-900 shadow-2xl">
      <h2 className="text-xl font-bold">Entrar no painel</h2>
      <Field label="E-mail ou celular">
        <Input autoComplete="username" required value={login} onChange={(e) => setLogin(e.target.value)} />
      </Field>
      <Field label="Senha">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" loading={busy} className="w-full">
        Entrar
      </Button>
      <button type="button" className="w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-900" onClick={() => setForgot(true)}>
        Esqueci minha senha
      </button>
    </form>
  );
}

/** Esqueci minha senha: código no WhatsApp do celular cadastrado e nova senha. */
function ForgotCard({ initial, onBack, onDone }: { initial: string; onBack: () => void; onDone: () => void }) {
  const [login, setLogin] = useState(initial);
  const [sent, setSent] = useState<{ masked: string; demoCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(await api<{ masked: string; demoCode?: string }>('POST', '/api/auth/forgot', { login }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/reset', { login, code, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={sent ? reset : ask} className="space-y-4 rounded-2xl bg-white p-6 text-zinc-900 shadow-2xl">
      <div>
        <h2 className="text-xl font-bold">Criar uma nova senha</h2>
        <p className="text-sm text-zinc-500">
          {sent ? `Mandamos um código pelo WhatsApp para o celular ${sent.masked}.` : 'Enviamos um código para o WhatsApp do celular cadastrado no seu login.'}
        </p>
      </div>
      {!sent ? (
        <Field label="E-mail ou celular do login">
          <Input autoComplete="username" required value={login} onChange={(e) => setLogin(e.target.value)} />
        </Field>
      ) : (
        <>
          {sent.demoCode && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Demonstração (sem WhatsApp conectado): o código é <b className="tracking-widest">{sent.demoCode}</b>
            </p>
          )}
          <Field label="Código de 6 dígitos">
            <Input inputMode="numeric" autoComplete="one-time-code" required maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Nova senha" hint="Pelo menos 8 caracteres.">
            <Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </>
      )}
      <ErrorText error={error} />
      <Button type="submit" loading={busy} className="w-full">
        {sent ? 'Salvar nova senha e entrar' : 'Enviar código'}
      </Button>
      <button type="button" className="w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-900" onClick={onBack}>
        Voltar para o login
      </button>
    </form>
  );
}

function SetupCard({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/setup', form);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 text-zinc-900 shadow-2xl">
      <div>
        <h2 className="text-xl font-bold">Primeiro acesso</h2>
        <p className="text-sm text-zinc-500">Crie o login master: é você, o dono da plataforma, quem cadastra as barbearias.</p>
      </div>
      <Field label="Seu nome">
        <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="E-mail">
        <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <Field label="Senha" hint="Pelo menos 8 caracteres.">
        <Input type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" loading={busy} className="w-full">
        Criar master
      </Button>
    </form>
  );
}
