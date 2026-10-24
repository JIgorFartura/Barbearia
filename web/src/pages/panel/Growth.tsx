import { Cake, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { date, phone as fmtPhone } from '../../lib/format';

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

interface GrowthData {
  settings: Settings;
  referrals: { friend: string; referrer: string; joined_at: string; rewarded_at: string | null }[];
  birthdays: { registered: number; upcoming: { id: number; name: string; phone: string; day: string }[] };
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

/** Indique um amigo e presente de aniversário: os prêmios viram vouchers, validados no Balcão. */
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
        <h1 className="text-2xl font-bold">Indicação e aniversário</h1>
        <p className="text-sm text-zinc-500">Os prêmios viram vouchers com código, validados no Balcão como qualquer benefício. Eles não aparecem na lista de benefícios.</p>
      </div>

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
          Salvar
        </Button>
        {saved && <span className="text-sm text-emerald-700">Salvo!</span>}
      </div>
    </section>
  );
}
