import { ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, ErrorText, Field, ImageInput, Input, inputClass } from '../../components/ui';
import { api } from '../../lib/api';

interface Profile {
  slug: string;
  name: string;
  tagline: string | null;
  about: string | null;
  primary_color: string;
  accent_color: string;
  logo_url: string | null;
  cover_url: string | null;
  whatsapp: string | null;
  instagram: string | null;
  address: string | null;
  hours: string | null;
  timezone: string | null;
}

/** Fusos do Brasil: a agenda, os lembretes e o caixa seguem o relógio da barbearia. */
const TIMEZONES = [
  { id: 'America/Sao_Paulo', label: 'Horário de Brasília (SP, RJ, MG, Sul, Nordeste, GO, DF, PA, TO, AP)' },
  { id: 'America/Manaus', label: 'Uma hora a menos (AM, MT, MS, RO, RR)' },
  { id: 'America/Rio_Branco', label: 'Duas horas a menos (Acre)' },
  { id: 'America/Noronha', label: 'Uma hora a mais (Fernando de Noronha)' },
];

/** Identidade visual da barbearia: é isso que deixa o mesmo sistema com "a cara" de cada uma. */
export function Brand() {
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Profile>('GET', '/api/shop/profile').then(setP);
  }, []);
  if (!p) return null;

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setSaved(false);
    setP({ ...p, [key]: value });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const { slug: _slug, ...body } = p;
      setP(await api<Profile>('PUT', '/api/shop/profile', body));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const text = (key: keyof Profile, label: string, placeholder?: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input value={(p[key] as string) ?? ''} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Minha marca</h1>
          <p className="text-sm text-zinc-500">Logo, cores e contatos que aparecem no seu site.</p>
        </div>
        <a href={`/b/${p.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-zinc-600 hover:text-zinc-900">
          Abrir meu site <ExternalLink className="size-4" />
        </a>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card className="space-y-4">
          {text('name', 'Nome da barbearia')}
          {text('tagline', 'Frase de efeito', 'Mais que um corte, uma comunidade.')}
          <Field label="Sobre a barbearia">
            <textarea className={inputClass} rows={4} value={p.about ?? ''} onChange={(e) => set('about', e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {text('whatsapp', 'WhatsApp', '(11) 98888-7777')}
            {text('instagram', 'Instagram', '@suabarbearia')}
          </div>
          {text('address', 'Endereço', 'Rua Exemplo, 123 - Centro')}
          {text('hours', 'Horário de funcionamento', 'Ter a Sáb, 9h às 20h')}
          <Field label="Fuso horário" hint="Vale para a agenda, os lembretes do robô e as datas do caixa.">
            <select className={inputClass} value={p.timezone ?? 'America/Sao_Paulo'} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </Card>

        <div className="space-y-5">
          <Card className="space-y-4">
            <Field label="Logo">
              <ImageInput value={p.logo_url} onChange={(v) => set('logo_url', v)} />
            </Field>
            <Field label="Foto de capa" hint="Uma foto do ambiente fica ótima.">
              <ImageInput value={p.cover_url} onChange={(v) => set('cover_url', v)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cor principal">
                <input type="color" className="h-10 w-full cursor-pointer rounded-lg" value={p.primary_color} onChange={(e) => set('primary_color', e.target.value)} />
              </Field>
              <Field label="Cor de destaque">
                <input type="color" className="h-10 w-full cursor-pointer rounded-lg" value={p.accent_color} onChange={(e) => set('accent_color', e.target.value)} />
              </Field>
            </div>
          </Card>
          <div className="overflow-hidden rounded-2xl shadow-sm ring-1 ring-zinc-200">
            <div className="p-5 text-white" style={{ background: p.primary_color }}>
              <p className="text-lg font-bold">{p.name}</p>
              <p className="text-sm opacity-80">{p.tagline || 'Sua frase de efeito'}</p>
              <span className="mt-3 inline-block rounded-full px-3 py-1 text-xs font-bold text-zinc-950" style={{ background: p.accent_color }}>
                Prévia das cores
              </span>
            </div>
          </div>
        </div>
      </div>

      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" loading={busy}>
          Salvar marca
        </Button>
        {saved && <span className="text-sm text-emerald-700">Salvo! Seu site já está atualizado.</span>}
      </div>
    </form>
  );
}
