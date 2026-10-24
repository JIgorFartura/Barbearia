import { Bot as BotIcon, CheckCircle2, Copy, MessageSquare, RefreshCw, Send, Smartphone, UserX, WifiOff, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { WEEKDAYS, date as fmtDate, phone as fmtPhone } from '../../lib/format';

interface Settings {
  bot_name: string;
  bot_persona: string | null;
  wa_provider: 'simulador' | 'meta' | 'evolution';
  wa_config: Record<string, string>;
  webhooks: { meta: string; evolution: string };
  slot_step_min: number;
  reminder_hours: number;
  habit_enabled: boolean;
  habit_weekday: number;
  habit_time: string;
  winback_enabled: boolean;
  winback_days: number;
  winback_message: string | null;
  llm: boolean;
  connection: Connection | null;
  templates: TemplateInfo[];
}

interface Connection {
  status: 'ok' | 'down' | 'unknown';
  since: string | null;
  checkedAt: string | null;
  error: string | null;
}

interface TemplateInfo {
  kind: string;
  field: string;
  label: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  body: string;
  example: string[];
}

const CATEGORY_LABEL = { UTILITY: 'Utilidade', MARKETING: 'Marketing', AUTHENTICATION: 'Autenticação' };

interface Msg {
  id: number;
  direction: 'in' | 'out';
  kind: string;
  body: string;
  status: string;
  error: string | null;
  created_at: string;
}

const TABS = [
  { id: 'robo', label: 'Robô' },
  { id: 'lembretes', label: 'Lembretes' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'simulador', label: 'Simulador' },
  { id: 'conversas', label: 'Conversas' },
  { id: 'sumidos', label: 'Sumidos' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const KIND_LABEL: Record<string, string> = {
  lembrete: 'Lembrete',
  costume: 'Horário de costume',
  sumido: 'Recontato',
  codigo: 'Código de acesso',
  teste: 'Teste',
  manual: 'Manual',
  barbeiro: 'Aviso ao barbeiro',
  avaliacao: 'Avaliação',
  aniversario: 'Aniversário',
  indicacao: 'Indicação',
  sinal: 'Sinal',
  assinatura: 'Clube',
  aviso: 'Aviso',
};

/** Robô do WhatsApp: nome, automações, conexão, simulador e conversas. */
export function Bot() {
  const [tab, setTab] = useState<Tab>('robo');
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Settings>('GET', '/api/shop/bot').then(setS, (e) => setError(e.message));
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setS((v) => (v ? { ...v, [key]: value } : v));
  };

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      setS(await api<Settings>('PUT', '/api/shop/bot', s));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <ErrorText error={error} />;
  const settingsTab = tab === 'robo' || tab === 'lembretes' || tab === 'whatsapp';

  return (
    <section>
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <BotIcon className="size-6" /> {s.bot_name}, o robô da barbearia
        </h1>
        <p className="text-sm text-zinc-500">Atende no WhatsApp, marca horários, lembra os clientes e chama quem sumiu.</p>
      </div>
      <div className="-mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${tab === t.id ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {settingsTab && (
        <form onSubmit={save} className="space-y-5">
          {tab === 'robo' && <RobotTab s={s} set={set} />}
          {tab === 'lembretes' && <RemindersTab s={s} set={set} />}
          {tab === 'whatsapp' && <WhatsAppTab s={s} set={set} onConnection={(c) => setS((v) => (v ? { ...v, connection: c } : v))} />}
          <ErrorText error={error} />
          <div className="flex items-center gap-3">
            <Button type="submit" loading={busy}>
              Salvar
            </Button>
            {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
          </div>
        </form>
      )}
      {tab === 'simulador' && <Simulator botName={s.bot_name} />}
      {tab === 'conversas' && <Conversations />}
      {tab === 'sumidos' && <Away days={s.winback_days} />}
    </section>
  );
}

type SetFn = <K extends keyof Settings>(key: K, value: Settings[K]) => void;

function RobotTab({ s, set }: { s: Settings; set: SetFn }) {
  return (
    <Card className="max-w-2xl space-y-4">
      <div className={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm ${s.llm ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}>
        <Zap className="mt-0.5 size-4 shrink-0" />
        {s.llm
          ? 'Inteligência artificial ligada: o robô entende mensagens livres ("João, tem vaga sexta 19h com o Paulo?") e usa a agenda, o cartão e os benefícios para responder.'
          : 'Robô sem inteligência artificial: responde por menu (CARTÃO, HORÁRIOS, CANCELAR) e entende SIM/NÃO nas ofertas. Para conversa livre, o administrador da plataforma precisa ligar a IA.'}
      </div>
      <Field label="Nome do robô" hint="É assim que ele se apresenta e que os clientes chamam: “João, quantas cervejas faltam pro meu prêmio?”">
        <Input required maxLength={30} value={s.bot_name} onChange={(e) => set('bot_name', e.target.value)} />
      </Field>
      <Field label="Jeito de falar e orientações (opcional)" hint="Ex.: fale de forma descontraída; aos sábados só atendemos até 14h; o Paulo não faz barba.">
        <textarea className={inputClass} rows={4} maxLength={800} value={s.bot_persona ?? ''} onChange={(e) => set('bot_persona', e.target.value)} />
      </Field>
      <Field label="Intervalo da agenda" hint="De quanto em quanto tempo os horários livres são oferecidos.">
        <select className={inputClass} value={s.slot_step_min} onChange={(e) => set('slot_step_min', Number(e.target.value))}>
          {[15, 20, 30, 60].map((m) => (
            <option key={m} value={m}>
              A cada {m} minutos
            </option>
          ))}
        </select>
      </Field>
    </Card>
  );
}

function RemindersTab({ s, set }: { s: Settings; set: SetFn }) {
  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card className="space-y-3">
        <p className="font-semibold">Lembrete do horário marcado</p>
        <p className="text-sm text-zinc-500">Todo agendamento (site, WhatsApp ou balcão) recebe um aviso antes, com a opção de responder CANCELAR.</p>
        <select className={inputClass} value={s.reminder_hours} onChange={(e) => set('reminder_hours', Number(e.target.value))}>
          <option value={0}>Desligado</option>
          {[2, 3, 6, 12, 24, 48].map((h) => (
            <option key={h} value={h}>
              {h} horas antes
            </option>
          ))}
        </select>
      </Card>
      <Card className="space-y-3">
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={s.habit_enabled} onChange={(e) => set('habit_enabled', e.target.checked)} />
          Oferecer o horário de costume toda semana
        </label>
        <p className="text-sm text-zinc-500">
          O robô descobre o dia e a hora em que cada cliente costuma vir (ou usa o que o cliente informou) e, no dia abaixo, oferece: “Separei sexta às 17h com
          o Paulo. Responda SIM para confirmar”. Respeita o ritmo de cada um (toda semana, a cada 15 dias...).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Enviar na">
            <select className={inputClass} value={s.habit_weekday} onChange={(e) => set('habit_weekday', Number(e.target.value))}>
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field label="A partir das">
            <Input type="time" value={s.habit_time} onChange={(e) => set('habit_time', e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card className="space-y-3 lg:col-span-2">
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={s.winback_enabled} onChange={(e) => set('winback_enabled', e.target.checked)} />
          Chamar quem sumiu
        </label>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <Field label="Sem vir há">
            <select className={inputClass} value={s.winback_days} onChange={(e) => set('winback_days', Number(e.target.value))}>
              {[21, 30, 45, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d} dias
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mensagem (opcional)" hint="Use {nome}, {dias}, {barbearia} e {robo}. O robô acrescenta a sugestão de horário e a opção PARAR.">
            <textarea
              className={inputClass}
              rows={3}
              maxLength={600}
              placeholder="Oi, {nome}! Aqui é o {robo}, da {barbearia}. Faz {dias} dias que você não aparece por aqui... aconteceu alguma coisa?"
              value={s.winback_message ?? ''}
              onChange={(e) => set('winback_message', e.target.value)}
            />
          </Field>
        </div>
      </Card>
      <p className="text-xs text-zinc-500 lg:col-span-2">
        Mensagens automáticas só saem das 8h às 21h, uma vez por cliente, e quem responder PARAR deixa de recebê-las.
      </p>
    </div>
  );
}

function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Copy className="size-4" /> {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
    </Field>
  );
}

/** Situação da conexão (o sistema confere sozinho a cada 10 minutos e avisa o dono se cair). */
function ConnectionCard({ connection, onChange }: { connection: Connection | null; onChange: (c: Connection | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const down = connection?.status === 'down';
  return (
    <Card className={`flex flex-wrap items-center justify-between gap-3 ${down ? 'ring-red-200' : ''}`}>
      <div className="flex items-start gap-3 text-sm">
        {down ? <WifiOff className="mt-0.5 size-5 shrink-0 text-red-600" /> : <CheckCircle2 className={`mt-0.5 size-5 shrink-0 ${connection?.status === 'ok' ? 'text-emerald-600' : 'text-zinc-400'}`} />}
        <div>
          <p className="font-semibold">
            {connection?.status === 'ok' ? 'WhatsApp conectado' : down ? 'WhatsApp desconectado' : 'Conexão ainda não verificada'}
          </p>
          <p className="text-zinc-500">
            {down && connection?.error ? `${connection.error}. ` : ''}
            {connection?.checkedAt ? `Última verificação: ${when(connection.checkedAt)}.` : 'O sistema confere a cada 10 minutos.'}
            {down && ' Reconecte (na Evolution, leia o QR Code de novo) e clique em Verificar agora.'}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          api<{ connection: Connection | null }>('POST', '/api/shop/bot/check')
            .then((r) => onChange(r.connection), (e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <RefreshCw className="size-4" /> Verificar agora
      </Button>
      <ErrorText error={error} />
    </Card>
  );
}

/** Modelos da Meta: um por tipo de mensagem automática, com o texto sugerido para cadastrar. */
function TemplatesCard({ templates, cfg, setCfg }: { templates: TemplateInfo[]; cfg: Record<string, string>; setCfg: (key: string, value: string) => void }) {
  return (
    <Card className="space-y-3">
      <div>
        <p className="font-semibold">Modelos de mensagem (mensagens automáticas)</p>
        <p className="text-sm text-zinc-500">
          Fora da janela de 24h depois da última mensagem do cliente, a Meta só entrega modelos aprovados. Cadastre cada texto abaixo no WhatsApp Manager (Modelos
          de mensagem, idioma Português BR) e escreva aqui o nome aprovado. Sem o modelo, aquele tipo de mensagem só chega para quem falou com o robô nas últimas
          24h.
        </p>
      </div>
      <ul className="divide-y divide-zinc-100">
        {templates.map((t) => (
          <li key={t.kind} className="grid gap-2 py-3 sm:grid-cols-[1fr_14rem] sm:items-start">
            <div className="text-sm">
              <p className="font-medium">
                {t.label} <span className="text-xs font-normal text-zinc-500">· categoria {CATEGORY_LABEL[t.category]}</span>
              </p>
              <p className="mt-1 rounded-lg bg-zinc-50 px-2 py-1.5 font-mono text-xs text-zinc-700">{t.body}</p>
              <p className="mt-1 text-xs text-zinc-500">Exemplo das variáveis: {t.example.map((e, i) => `{{${i + 1}}} = ${e}`).join(' · ')}</p>
            </div>
            <Input placeholder="nome aprovado (ex.: lembrete_horario)" value={cfg[t.field] ?? ''} onChange={(e) => setCfg(t.field, e.target.value)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function WhatsAppTab({ s, set, onConnection }: { s: Settings; set: SetFn; onConnection: (c: Connection | null) => void }) {
  const cfg = s.wa_config;
  const setCfg = (key: string, value: string) => set('wa_config', { ...cfg, [key]: value });
  const text = (key: string, label: string, opts: { secret?: boolean; hint?: string; placeholder?: string } = {}) => (
    <Field label={label} hint={opts.hint}>
      <Input
        type={opts.secret ? 'password' : 'text'}
        autoComplete="off"
        placeholder={opts.placeholder}
        value={cfg[key] ?? ''}
        onChange={(e) => setCfg(key, e.target.value)}
      />
    </Field>
  );
  const options: { id: Settings['wa_provider']; title: string; text: string }[] = [
    { id: 'simulador', title: 'Simulador', text: 'Nada sai pelo WhatsApp: as mensagens ficam em Conversas. Bom para testar.' },
    { id: 'evolution', title: 'Evolution API', text: 'Conecta o WhatsApp da barbearia lendo um QR Code. Mais simples de começar.' },
    { id: 'meta', title: 'WhatsApp oficial (Meta)', text: 'API oficial do WhatsApp Business. Exige conta verificada na Meta.' },
  ];

  return (
    <div className="max-w-3xl space-y-4">
      {s.wa_provider !== 'simulador' && s.connection && <ConnectionCard connection={s.connection} onChange={onConnection} />}
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((o) => (
          <button
            type="button"
            key={o.id}
            onClick={() => set('wa_provider', o.id)}
            className={`rounded-2xl p-4 text-left ring-1 transition ${s.wa_provider === o.id ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:ring-zinc-300'}`}
          >
            <p className="font-semibold">{o.title}</p>
            <p className={`mt-1 text-xs ${s.wa_provider === o.id ? 'text-zinc-300' : 'text-zinc-500'}`}>{o.text}</p>
          </button>
        ))}
      </div>

      {s.wa_provider === 'evolution' && (
        <Card className="space-y-4">
          {text('baseUrl', 'Endereço da Evolution API', { placeholder: 'https://evolution.seudominio.com.br' })}
          <div className="grid gap-4 sm:grid-cols-2">
            {text('instance', 'Nome da instância')}
            {text('apiKey', 'Chave (apikey)', { secret: true })}
          </div>
          <CopyField
            label="URL do webhook"
            value={s.webhooks.evolution}
            hint="Na Evolution, configure o webhook da instância com esta URL e ative os eventos MESSAGES_UPSERT e CONNECTION_UPDATE (avisa na hora se o WhatsApp cair)."
          />
        </Card>
      )}

      {s.wa_provider === 'meta' && (
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {text('phoneNumberId', 'ID do número de telefone')}
            {text('token', 'Token de acesso', { secret: true })}
            {text('appSecret', 'App Secret (confere a assinatura)', { secret: true })}
            {text('verifyToken', 'Token de verificação do webhook', { hint: 'Invente uma senha e use a mesma na Meta.' })}
          </div>
          <CopyField label="URL de retorno (webhook)" value={s.webhooks.meta} hint="Na Meta: WhatsApp > Configuração > Webhook. Assine o campo “messages”." />
          <div className="grid gap-4 sm:grid-cols-2">
            {text('templateLang', 'Idioma dos modelos', { placeholder: 'pt_BR' })}
            {text('templateName', 'Modelo genérico (opcional)', {
              hint: 'Usado para os tipos sem modelo próprio: um modelo com uma variável {{1}} que recebe a mensagem inteira.',
            })}
          </div>
        </Card>
      )}
      {s.wa_provider === 'meta' && <TemplatesCard templates={s.templates} cfg={cfg} setCfg={setCfg} />}

      {s.wa_provider !== 'simulador' && <TestSend />}
    </div>
  );
}

function TestSend() {
  const [phoneValue, setPhone] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="space-y-3">
      <p className="flex items-center gap-2 font-semibold">
        <Smartphone className="size-4" /> Testar envio
      </p>
      <p className="text-sm text-zinc-500">Salve as configurações e mande uma mensagem de teste para o seu celular.</p>
      <div className="flex gap-2">
        <Input type="tel" placeholder="(11) 98888-7777" value={phoneValue} onChange={(e) => setPhone(e.target.value)} />
        <Button
          type="button"
          className="shrink-0"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setResult(null);
            try {
              await api('POST', '/api/shop/bot/test', { phone: phoneValue });
              setResult('Mensagem enviada! Confira o WhatsApp.');
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Enviar teste
        </Button>
      </div>
      {result && <p className="text-sm text-emerald-700">{result}</p>}
      <ErrorText error={error} />
    </Card>
  );
}

/** Mostra o *negrito* do WhatsApp como no celular. */
function whatsappText(text: string): ReactNode[] {
  return text.split(/(\*[^*\n]+\*)/g).map((part, i) => (/^\*[^*\n]+\*$/.test(part) ? <b key={i}>{part.slice(1, -1)}</b> : part));
}

function Thread({ messages, botName, footer }: { messages: Msg[]; botName: string; footer?: ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  // Chaves de propósito: no Chrome novo scrollIntoView devolve uma Promise, e o React não aceita isso como limpeza.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages]);
  return (
    <div className="flex h-[60vh] flex-col overflow-hidden rounded-2xl bg-[#efeae2] ring-1 ring-zinc-200">
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && <p className="pt-10 text-center text-sm text-zinc-500">Nenhuma mensagem ainda.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'in' ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm ${m.direction === 'in' ? 'bg-white' : 'bg-[#d9fdd3]'}`}>
              {m.direction === 'out' && m.kind !== 'chat' && <p className="mb-0.5 text-[10px] font-semibold text-emerald-700 uppercase">{KIND_LABEL[m.kind] ?? m.kind}</p>}
              <p className="whitespace-pre-line">{whatsappText(m.body)}</p>
              <p className="mt-1 text-right text-[10px] text-zinc-500">
                {m.direction === 'out' && `${botName} · `}
                {new Date(m.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                {m.status === 'failed' && <span className="text-red-600"> · não enviada{m.error ? `: ${m.error}` : ''}</span>}
              </p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {footer}
    </div>
  );
}

function Simulator({ botName }: { botName: string }) {
  const [customers, setCustomers] = useState<{ id: number; name: string; phone: string }[]>([]);
  const [phoneValue, setPhone] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const digits = phoneValue.replace(/\D/g, '');

  useEffect(() => {
    api<typeof customers>('GET', '/api/shop/customers').then((list) => {
      setCustomers(list);
      if (list[0]) setPhone(list[0].phone);
    });
  }, []);

  const load = useCallback(() => {
    if (digits.length < 10) setMessages([]);
    else api<Msg[]>('GET', `/api/shop/messages?phone=${digits}`).then(setMessages);
  }, [digits]);
  useEffect(load, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const sent = text;
    setText('');
    setMessages((m) => [...m, { id: -Date.now(), direction: 'in', kind: 'chat', body: sent, status: 'received', error: null, created_at: new Date().toISOString() }]);
    try {
      await api('POST', '/api/shop/bot/simulate', { phone: phoneValue, text: sent });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card className="space-y-3 self-start">
        <p className="text-sm text-zinc-600">
          Converse com o {botName} como se fosse um cliente. Nada é enviado pelo WhatsApp, mas os agendamentos e vouchers são de verdade.
        </p>
        <Field label="Falar como">
          <select className={inputClass} value={customers.some((c) => c.phone === phoneValue) ? phoneValue : ''} onChange={(e) => setPhone(e.target.value)}>
            <option value="">Número novo (não cadastrado)</option>
            {customers.map((c) => (
              <option key={c.id} value={c.phone}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Celular">
          <Input type="tel" value={phoneValue} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 90000-0000" />
        </Field>
        <p className="text-xs text-zinc-500">Experimente: “{botName}, quantas cervejas faltam pro meu prêmio?” ou “tem vaga sexta 19h com o Paulo?”</p>
      </Card>
      <Thread
        messages={messages}
        botName={botName}
        footer={
          <form onSubmit={send} className="flex gap-2 border-t border-zinc-200 bg-white p-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={digits.length >= 10 ? 'Escreva uma mensagem' : 'Informe o celular ao lado'} disabled={digits.length < 10} />
            <Button type="submit" loading={busy} disabled={digits.length < 10 || !text.trim()} aria-label="Enviar">
              <Send className="size-4" />
            </Button>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </form>
        }
      />
    </div>
  );
}

interface Conversation {
  phone: string;
  customer: string | null;
  last_body: string;
  last_direction: 'in' | 'out';
  last_at: string;
  total: number;
}

function Conversations() {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);

  useEffect(() => {
    api<Conversation[]>('GET', '/api/shop/messages').then(setList);
  }, []);
  useEffect(() => {
    if (selected) api<Msg[]>('GET', `/api/shop/messages?phone=${selected}`).then(setMessages);
  }, [selected]);

  if (list?.length === 0) {
    return <EmptyState icon={<MessageSquare className="size-6" />} title="Nenhuma conversa ainda" text="As mensagens do robô (recebidas e enviadas) aparecem aqui." />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
        {list?.map((c) => (
          <li key={c.phone}>
            <button
              onClick={() => setSelected(c.phone)}
              className={`w-full rounded-xl px-3 py-2 text-left ring-1 ${selected === c.phone ? 'bg-white ring-2 ring-zinc-900' : 'bg-white ring-zinc-200 hover:ring-zinc-300'}`}
            >
              <div className="flex justify-between gap-2">
                <span className="truncate font-medium">{c.customer ?? fmtPhone(c.phone)}</span>
                <span className="text-xs whitespace-nowrap text-zinc-400">{fmtDate(c.last_at)}</span>
              </div>
              <p className="truncate text-xs text-zinc-500">
                {c.last_direction === 'out' ? '↪ ' : ''}
                {c.last_body}
              </p>
            </button>
          </li>
        ))}
      </ul>
      {selected ? <Thread messages={messages} botName="Robô" /> : <p className="text-sm text-zinc-500">Escolha uma conversa.</p>}
    </div>
  );
}

interface AwayCustomer {
  id: number;
  name: string;
  phone: string;
  lastVisit: string;
  days: number;
  contacted: boolean;
  optOut: boolean;
}

function Away({ days }: { days: number }) {
  const [list, setList] = useState<AwayCustomer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ customers: AwayCustomer[] }>('GET', '/api/shop/winback').then((r) => setList(r.customers));
  }, []);
  useEffect(load, [load]);

  async function call(c: AwayCustomer) {
    setError(null);
    try {
      await api('POST', `/api/shop/winback/${c.id}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">Clientes que não vêm há {days} dias ou mais e não têm horário marcado. O robô chama cada um uma vez, automaticamente.</p>
      <ErrorText error={error} />
      {list?.length === 0 && <EmptyState icon={<UserX className="size-6" />} title="Ninguém sumido" text="Todos os clientes vieram recentemente ou já têm horário marcado. 👏" />}
      <div className="grid gap-2 md:grid-cols-2">
        {list?.map((c) => (
          <Card key={c.id} className="!p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{c.name}</p>
                <p className="text-sm text-zinc-500">
                  {fmtPhone(c.phone)} · última visita {fmtDate(c.lastVisit)} ({c.days} dias)
                </p>
              </div>
              {c.optOut ? <Badge tone="red">Pediu para parar</Badge> : c.contacted ? <Badge tone="green">Já chamado</Badge> : <Badge tone="gold">Na fila</Badge>}
            </div>
            {!c.optOut && (
              <Button variant="ghost" className="mt-3 !py-1.5" onClick={() => call(c)}>
                <Send className="size-3.5" /> {c.contacted ? 'Chamar de novo' : 'Chamar agora'}
              </Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
