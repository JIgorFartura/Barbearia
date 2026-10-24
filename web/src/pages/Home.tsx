import { Bot, CalendarCheck, Gift, Handshake, Megaphone, Scissors, Ticket, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Me } from '../App';
import { Button, ErrorText, Field, Input } from '../components/ui';
import { api } from '../lib/api';

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
    </div>
  );
}

function LoginCard({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/login', { email, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 text-zinc-900 shadow-2xl">
      <h2 className="text-xl font-bold">Entrar no painel</h2>
      <Field label="E-mail">
        <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Senha">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" loading={busy} className="w-full">
        Entrar
      </Button>
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
