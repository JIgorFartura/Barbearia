import { Cake, Check, Copy, MessageCircle, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Section } from '../components/CustomerSection';
import { Button, ErrorText, inputClass } from '../components/ui';
import { api } from '../lib/api';

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Indique um amigo: link para compartilhar e quantos amigos já vieram. */
export function ReferralSection({
  referral,
  shopName,
  accent,
}: {
  referral: { link: string; friend_gift: string | null; my_prize: string | null; joined: number; came: number };
  shopName: string;
  accent: string;
}) {
  const [copied, setCopied] = useState(false);
  const message = `Corta na ${shopName}! Entra pelo meu link${referral.friend_gift ? ` e ganha ${referral.friend_gift}` : ''}: ${referral.link}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(referral.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* sem acesso à área de transferência: o link está visível para copiar à mão */
    }
  }
  return (
    <Section icon={<UserPlus />} title="Indique um amigo">
      <p className="text-sm">
        {referral.my_prize && (
          <>
            Quando seu amigo vier pela primeira vez, você ganha <b>{referral.my_prize}</b>.
          </>
        )}
        {referral.friend_gift && <> Ele ganha {referral.friend_gift}.</>}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input readOnly value={referral.link} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} aria-label="Seu link de indicação" />
        <Button variant="ghost" className="shrink-0 !px-3" onClick={copy} aria-label="Copiar link">
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </Button>
      </div>
      <a
        href={`https://wa.me/?text=${encodeURIComponent(message)}`}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-zinc-950"
        style={{ background: accent }}
      >
        <MessageCircle className="size-4" /> Mandar no WhatsApp
      </a>
      {referral.joined > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          {referral.joined} {referral.joined === 1 ? 'amigo entrou' : 'amigos entraram'} pelo seu link · {referral.came} já {referral.came === 1 ? 'veio' : 'vieram'}
        </p>
      )}
    </Section>
  );
}

/** Aniversário (dia e mês) para o presente da barbearia. */
export function BirthdaySection({ slug, birthday, onSaved }: { slug: string; birthday: { gift: string | null; value: string | null }; onSaved: () => void }) {
  const [day, setDay] = useState(birthday.value ? Number(birthday.value.slice(3)) : 0);
  const [month, setMonth] = useState(birthday.value ? Number(birthday.value.slice(0, 2)) : 0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save() {
    setError(null);
    try {
      await api('PUT', `/api/customer/${slug}/birthday`, { day: day || null, month: month || null });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Section icon={<Cake />} title="Meu aniversário">
      <p className="text-sm text-zinc-600">{birthday.gift ? `No dia do seu aniversário você ganha ${birthday.gift}. 🎉` : 'Conte quando é seu aniversário.'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          className={`${inputClass} !w-24`}
          value={day}
          onChange={(e) => {
            setSaved(false);
            setDay(Number(e.target.value));
          }}
          aria-label="Dia"
        >
          <option value={0}>Dia</option>
          {Array.from({ length: 31 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
        <select
          className={`${inputClass} !w-40`}
          value={month}
          onChange={(e) => {
            setSaved(false);
            setMonth(Number(e.target.value));
          }}
          aria-label="Mês"
        >
          <option value={0}>Mês</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={save} disabled={!day || !month}>
          Salvar
        </Button>
        {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
      </div>
      <ErrorText error={error} />
    </Section>
  );
}
