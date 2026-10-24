import { Bot, CalendarCheck, Gift, Handshake, Megaphone, Scissors, Ticket, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Me } from '../App';
import { Button, ErrorText, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { LegalLinks } from './Legal';

const FEATURES = [
  { icon: Bot, title: 'Robô no WhatsApp', text: 'Cada barbearia dá um nome ao seu robô. Ele agenda, consulta o cartão e entrega vouchers.' },
  { icon: CalendarCheck, title: 'Lembretes que trazem o cliente', text: 'Lembra o horário marcado, oferece o horário de costume toda semana e chama quem sumiu.' },
  { icon: Gift, title: 'Campanhas de fidelidade', text: 'Tomou 5 cervejas, ganhou um copo. Cartão digital na área do cliente.' },
  { icon: Ticket, title: 'Benefícios com voucher', text: 'O cliente pega o voucher na área dele e mostra no balcão ou no parceiro.' },
  { icon: Handshake, title: 'Parceiros', text: 'Comércios do bairro oferecem benefícios aos membros da comunidade.' },
  { icon: Megaphone, title: 'Espaço de propaganda', text: 'Venda anúncios no site da barbearia e acompanhe visualizações e cliques.' },
  { icon: Users, title: 'Comunidade', text: 'O cliente não vive só o corte: vive a experiência e se sente parte do grupo.' },
];

/** Página do sistema (não da barbearia): apresentação + entrada. */
export function Home({ me, onLogin }: { me: Me; onLogin: () => void }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:py-20">
        <div>
          <div className="mb-8 flex items-center gap-2 text-lg font-bold">
            <Scissors className="size-6 text-gold" /> Sistema Barbearia
          </div>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">
            Mais que um corte: <span className="text-gold">uma comunidade</span> em volta da sua barbearia.
          </h1>
          <p className="mt-4 max-w-xl text-lg text-zinc-400">
            Site com a sua marca, catálogo de serviços e produtos, parceiros, anúncios e campanhas de fidelidade, tudo num painel só.
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
        <div className="lg:pt-16">{me.setupNeeded ? <SetupCard onDone={onLogin} /> : <LoginCard onDone={onLogin} />}</div>
      </div>
      <LegalLinks className="pb-8 text-zinc-500" />
    </div>
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
