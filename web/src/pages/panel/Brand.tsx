import { ExternalLink, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Card, ErrorText, Field, ImageInput, Input, inputClass } from '../../components/ui';
import { api, uploadImage } from '../../lib/api';
import { drawLogo, LOGO_STYLES, logoFile, paletteFromLogo, PRESETS, type LogoStyle, type Palette } from '../../lib/brandKit';

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
  const [wizard, setWizard] = useState(() => new URLSearchParams(location.search).has('assistente'));

  useEffect(() => {
    api<Profile>('GET', '/api/shop/profile').then((r) => {
      setP(r);
      // Barbearia sem logo ainda: o assistente já abre.
      if (!r.logo_url) setWizard(true);
    });
  }, []);
  if (!p) return null;

  /** O assistente salva a marca de uma vez (logo, cores e frase). */
  async function saveBrand(patch: Partial<Profile>) {
    const { slug: _slug, ...body } = { ...p!, ...patch };
    setP(await api<Profile>('PUT', '/api/shop/profile', body));
    setWizard(false);
    setSaved(true);
  }

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

      {wizard ? (
        <BrandWizard p={p} onSave={saveBrand} onClose={() => setWizard(false)} />
      ) : (
        <button type="button" className="inline-flex items-center gap-2 text-sm font-medium text-amber-700 hover:text-amber-900" onClick={() => setWizard(true)}>
          <Sparkles className="size-4" /> Montar minha marca com o assistente
        </button>
      )}

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

const TAGLINES = ['Mais que um corte, uma comunidade.', 'Estilo e tradição na medida certa.', 'Seu estilo, nossa arte.'];

/**
 * Assistente de marca: o dono envia o logo (e as cores saem dele) ou o sistema desenha um com as
 * iniciais; escolhe a paleta e a frase e vê como o site fica antes de salvar.
 */
function BrandWizard({ p, onSave, onClose }: { p: Profile; onSave: (patch: Partial<Profile>) => Promise<void>; onClose: () => void }) {
  const [logo, setLogo] = useState<string | null>(p.logo_url);
  const [makeLogo, setMakeLogo] = useState(!p.logo_url);
  const [style, setStyle] = useState<LogoStyle>('circulo');
  const [fromLogo, setFromLogo] = useState<Palette | null>(null);
  const [palette, setPalette] = useState<Palette>({ id: 'atual', label: 'Atual', primary: p.primary_color, accent: p.accent_color });
  const [tagline, setTagline] = useState(p.tagline ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Logo enviado: as cores dele viram a primeira sugestão (e já ficam escolhidas).
  useEffect(() => {
    if (!logo || makeLogo) return;
    paletteFromLogo(logo).then(
      (pl) => {
        setFromLogo(pl);
        setPalette(pl);
      },
      () => setFromLogo(null),
    );
  }, [logo, makeLogo]);

  const drawn = useMemo(() => LOGO_STYLES.map((s) => ({ ...s, url: drawLogo(p.name, palette, s.id).toDataURL('image/png') })), [p.name, palette]);
  const shownLogo = makeLogo ? drawn.find((d) => d.id === style)!.url : logo;
  const palettes = [...(fromLogo ? [fromLogo] : []), ...PRESETS];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const logoUrl = makeLogo ? await uploadImage(await logoFile(drawLogo(p.name, palette, style))) : logo;
      await onSave({ logo_url: logoUrl, primary_color: palette.primary, accent_color: palette.accent, tagline: tagline.trim() || null });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-5 ring-1 ring-amber-300">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-lg font-bold">
            <Sparkles className="size-5 text-amber-500" /> Monte sua marca em 1 minuto
          </p>
          <p className="text-sm text-zinc-500">Logo, cores e frase: o seu site, o app e as mensagens ficam com a cara da sua barbearia.</p>
        </div>
        <button type="button" className="text-sm text-zinc-500 hover:text-zinc-900" onClick={onClose}>
          Fechar
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-semibold">1. Seu logo</p>
            <div className="flex gap-2">
              <Button type="button" variant={makeLogo ? 'ghost' : 'primary'} className="!py-1.5" onClick={() => setMakeLogo(false)}>
                Tenho logo
              </Button>
              <Button type="button" variant={makeLogo ? 'primary' : 'ghost'} className="!py-1.5" onClick={() => setMakeLogo(true)}>
                Criar um pra mim
              </Button>
            </div>
            {makeLogo ? (
              <div className="flex flex-wrap gap-3">
                {drawn.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setStyle(d.id)}
                    className={`rounded-xl p-1.5 text-xs font-medium ring-2 ${style === d.id ? 'ring-amber-500' : 'ring-transparent hover:ring-zinc-200'}`}
                  >
                    <img src={d.url} alt={`Logo ${d.label}`} className="size-20" />
                    {d.label}
                  </button>
                ))}
              </div>
            ) : (
              <ImageInput value={logo} onChange={setLogo} />
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold">2. Cores</p>
            <div className="flex flex-wrap gap-2">
              {palettes.map((pl) => (
                <button
                  key={pl.id}
                  type="button"
                  onClick={() => setPalette(pl)}
                  className={`flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm ring-2 ${palette.primary === pl.primary && palette.accent === pl.accent ? 'ring-amber-500' : 'ring-zinc-200 hover:ring-zinc-300'}`}
                >
                  <span className="flex">
                    <span className="size-6 rounded-full ring-2 ring-white" style={{ background: pl.primary }} />
                    <span className="-ml-2 size-6 rounded-full ring-2 ring-white" style={{ background: pl.accent }} />
                  </span>
                  {pl.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold">3. Frase</p>
            <Input value={tagline} placeholder="Mais que um corte, uma comunidade." maxLength={120} onChange={(e) => setTagline(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              {TAGLINES.map((t) => (
                <button key={t} type="button" className="rounded-full bg-zinc-100 px-3 py-1 text-xs hover:bg-zinc-200" onClick={() => setTagline(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-semibold">Como fica o seu site</p>
          <div className="overflow-hidden rounded-2xl shadow-sm ring-1 ring-zinc-200">
            <div className="flex flex-col items-center gap-3 px-5 py-8 text-center text-white" style={{ background: palette.primary }}>
              {shownLogo && <img src={shownLogo} alt="" className="size-20 rounded-2xl object-cover" />}
              <p className="text-xl font-bold">{p.name}</p>
              <p className="text-sm opacity-80">{tagline || 'Sua frase de efeito'}</p>
              <span className="rounded-full px-4 py-2 text-sm font-bold text-zinc-950" style={{ background: palette.accent }}>
                Agendar horário
              </span>
            </div>
            <div className="space-y-2 bg-white p-4">
              <div className="h-3 w-2/3 rounded bg-zinc-100" />
              <div className="h-3 w-1/2 rounded bg-zinc-100" />
            </div>
          </div>
        </div>
      </div>

      <ErrorText error={error} />
      <Button type="button" variant="gold" loading={busy} disabled={!makeLogo && !logo} onClick={save}>
        Usar esta marca
      </Button>
    </Card>
  );
}
