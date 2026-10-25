import { Cake, Flame, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { WEEKDAYS_SHORT, date, money, phone as fmtPhone } from '../../lib/format';

interface Reward {
  title: string;
  valid_days: number;
}

interface Settings {
  referral_enabled: boolean;
  friend_reward: Reward | null;
  referrer_reward: Reward | null;
  birthday_enabled: boolean;
  birthday_reward: Reward | null;
}

/** Horário vazio com desconto (percent null = desligado). */
interface IdleSettings {
  percent: number | null;
  weekdays: number[];
  from: string;
  until: string;
}

interface GrowthData {
  settings: Settings;
  referrals: { friend: string; referrer: string; joined_at: string; rewarded_at: string | null }[];
  birthdays: { registered: number; upcoming: { id: number; name: string; phone: string; day: string }[] };
  idle: { settings: IdleSettings; stats: { month: string; booked: number; revenue_cents: number; offers: number }; perDay: number };
}

/** Presente editável: texto e validade do voucher. */
function RewardFields({ label, hint, value, onChange }: { label: string; hint?: string; value: Reward | null; onChange: (r: Reward | null) => void }) {
  return (
    <div className="grid grid-cols-[1fr_7rem] gap-3">
      <Field label={label} hint={hint}>
        <Input
          value={value?.title ?? ''}
          placeholder="Ex.: corte grátis, 1 cerveja, R$ 10 de desconto"
          onChange={(e) => onChange(e.target.value ? { title: e.target.value, valid_days: value?.valid_days ?? 30 } : null)}
        />
      </Field>
      <Field label="Vale por (dias)">
        <Input
          type="number"
          min={1}
          max={365}
          value={value?.valid_days ?? 30}
          disabled={!value}
          onChange={(e) => value && onChange({ ...value, valid_days: Number(e.target.value) || 1 })}
        />
      </Field>
    </div>
  );
}

/**
 * Horário vazio com desconto: nos dias e horários fracos, a vaga do dia sai mais barata para quem marcar
 * no mesmo dia; de manhã o robô oferece as vagas para quem já está na hora de cortar.
 */
function IdleCard({ idle, onSaved }: { idle: GrowthData['idle']; onSaved: (d: GrowthData) => void }) {
  const [on, setOn] = useState(Boolean(idle.settings.percent));
  const [form, setForm] = useState({ ...idle.settings, percent: idle.settings.percent ?? 20 });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  const toggleDay = (d: number) => set({ weekdays: form.weekdays.includes(d) ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d] });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<GrowthData>('PUT', '/api/shop/growth/idle', { ...form, percent: on ? form.percent : null }));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = idle.stats;
  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Flame className="size-5 text-zinc-400" /> Horário vazio com desconto
        </p>
        <Badge tone={idle.settings.percent ? 'green' : 'zinc'}>{idle.settings.percent ? `Ligado · ${idle.settings.percent}%` : 'Desligado'}</Badge>
      </div>
      <p className="text-sm text-zinc-500">
        Nos dias e horários mais fracos, a vaga livre do dia sai mais barata para quem marcar <b>no mesmo dia</b>, pela sua página ou pelo robô. Marcando antes, o
        preço é o normal: assim ninguém aprende a esperar o desconto, e o horário que ia ficar parado vira dinheiro.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={on}
          onChange={(e) => {
            setSaved(false);
            setOn(e.target.checked);
          }}
        />{' '}
        Ligar o horário vazio com desconto
      </label>
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <Field label="Desconto (%)" hint="De 5% a 50%, no serviço.">
          <Input type="number" min={5} max={50} value={form.percent} disabled={!on} onChange={(e) => set({ percent: Number(e.target.value) || 0 })} />
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-700">Nos dias</p>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS_SHORT.map((label, d) => (
              <button
                key={d}
                type="button"
                disabled={!on}
                onClick={() => toggleDay(d)}
                aria-pressed={form.weekdays.includes(d)}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 disabled:opacity-50 ${form.weekdays.includes(d) ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Das">
          <Input type="time" value={form.from} disabled={!on} onChange={(e) => set({ from: e.target.value })} />
        </Field>
        <Field label="Até">
          <Input type="time" value={form.until} disabled={!on} onChange={(e) => set({ until: e.target.value })} />
        </Field>
      </div>
      <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
        Às 9h desses dias, o robô oferece as vagas do dia (daqui a pelo menos 2 horas) para até {idle.perDay} clientes que já estão na hora de cortar, cada um com
        uma vaga diferente e, quando dá, com o barbeiro de costume. Quem responde SIM já fica marcado com o desconto. Cada cliente recebe no máximo uma oferta por
        semana.
      </p>
      <p className="text-sm">
        <b>Este mês:</b> {s.booked} {s.booked === 1 ? 'horário preenchido' : 'horários preenchidos'} com desconto
        {s.booked > 0 && ` (${money(s.revenue_cents)})`} · {s.offers} {s.offers === 1 ? 'oferta' : 'ofertas'} do robô
      </p>
      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <Button loading={busy} onClick={save}>
          Salvar horário vazio
        </Button>
        {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
      </div>
    </Card>
  );
}

/** Indique um amigo, presente de aniversário e horário vazio: os prêmios viram vouchers, validados no Balcão. */
export function Growth() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<GrowthData>('GET', '/api/shop/growth').then((d) => {
      setData(d);
      setForm(d.settings);
    });
  }, []);
  if (!data || !form) return null;

  const set = (patch: Partial<Settings>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const d = await api<GrowthData>('PUT', '/api/shop/growth/settings', form);
      setData(d);
      setForm(d.settings);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const came = data.referrals.filter((r) => r.rewarded_at).length;
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Indicação e promoções</h1>
        <p className="text-sm text-zinc-500">
          Indique um amigo e aniversário: os prêmios viram vouchers com código, validados no Balcão como qualquer benefício. Horário vazio: o desconto já entra no
          preço do horário.
        </p>
      </div>

      <IdleCard idle={data.idle} onSaved={(d) => setData(d)} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4">
          <div className="flex items-start justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold">
              <UserPlus className="size-5 text-zinc-400" /> Indique um amigo
            </p>
            <Badge tone={form.referral_enabled ? 'green' : 'zinc'}>{form.referral_enabled ? 'Ligado' : 'Desligado'}</Badge>
          </div>
          <p className="text-sm text-zinc-500">
            Cada cliente tem um link para mandar aos amigos (na área do cliente ou pedindo ao robô). Quem indicou ganha o prêmio quando o amigo vem pela primeira vez.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={form.referral_enabled} onChange={(e) => set({ referral_enabled: e.target.checked })} /> Ligar o indique um
            amigo
          </label>
          <RewardFields label="Quem indicou ganha" value={form.referrer_reward} onChange={(r) => set({ referrer_reward: r })} />
          <RewardFields
            label="O amigo ganha (opcional)"
            hint="Presente de boas-vindas, já na criação da conta."
            value={form.friend_reward}
            onChange={(r) => set({ friend_reward: r })}
          />
          {data.referrals.length > 0 && (
            <div>
              <p className="mb-1 text-sm font-medium">
                {data.referrals.length} {data.referrals.length === 1 ? 'indicação' : 'indicações'} · {came} {came === 1 ? 'veio' : 'vieram'}
              </p>
              <ul className="max-h-60 divide-y divide-zinc-100 overflow-y-auto text-sm">
                {data.referrals.map((r, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      {r.friend} <span className="text-zinc-500">por {r.referrer}</span>
                    </span>
                    <Badge tone={r.rewarded_at ? 'green' : 'zinc'}>{r.rewarded_at ? `veio ${date(r.rewarded_at)}` : 'ainda não veio'}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="space-y-4">
          <div className="flex items-start justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold">
              <Cake className="size-5 text-zinc-400" /> Aniversário
            </p>
            <Badge tone={form.birthday_enabled ? 'green' : 'zinc'}>{form.birthday_enabled ? 'Ligado' : 'Desligado'}</Badge>
          </div>
          <p className="text-sm text-zinc-500">
            No dia do aniversário, de manhã, o robô manda os parabéns com o presente pelo WhatsApp. O cliente informa o aniversário na área dele ou conta ao robô.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={form.birthday_enabled} onChange={(e) => set({ birthday_enabled: e.target.checked })} /> Mandar presente
            de aniversário
          </label>
          <RewardFields label="Presente" value={form.birthday_reward} onChange={(r) => set({ birthday_reward: r })} />
          <div>
            <p className="mb-1 text-sm font-medium">
              {data.birthdays.registered} {data.birthdays.registered === 1 ? 'cliente informou' : 'clientes informaram'} o aniversário
            </p>
            {data.birthdays.upcoming.length === 0 ? (
              <p className="text-sm text-zinc-500">Nenhum aniversário nos próximos 30 dias.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm">
                {data.birthdays.upcoming.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      {b.name} <span className="text-zinc-500">{fmtPhone(b.phone)}</span>
                    </span>
                    <b className="tabular-nums">{b.day.slice(3)}/{b.day.slice(0, 2)}</b>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <Button loading={busy} onClick={save}>
          Salvar indicação e aniversário
        </Button>
        {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
      </div>
    </section>
  );
}
