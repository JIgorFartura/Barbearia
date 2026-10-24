import { AtSign, CalendarCheck, Clock, Gift, Handshake, MapPin, MessageCircle, Package, Scissors, Sparkles, UserRound } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { instagramLink, money, whatsappLink } from '../lib/format';

interface PageData {
  shop: {
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
    bot_name: string;
  };
  loggedIn: boolean;
  canBook: boolean;
  services: { id: number; name: string; description: string | null; price_cents: number; duration_min: number | null; image_url: string | null }[];
  products: { id: number; name: string; description: string | null; price_cents: number; image_url: string | null }[];
  partners: { id: number; name: string; category: string | null; description: string | null; benefit: string | null; instagram: string | null; website: string | null; logo_url: string | null }[];
  campaigns: { id: number; name: string; description: string | null; unit_label: string; goal: number; reward: string; image_url: string | null; ends_on: string | null; partner: string | null }[];
  ads: { id: number; title: string; body: string | null; image_url: string | null; hasLink: boolean; placement: 'destaque' | 'mural'; partner: string | null }[];
}

/** Landing page da barbearia (/b/:slug): o mesmo modelo para todas, com a marca de cada uma. */
export function ShopLanding({ slug }: { slug: string }) {
  const [data, setData] = useState<PageData | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api<PageData>('GET', `/api/public/shops/${slug}`).then(
      (d) => {
        setData(d);
        document.title = d.shop.name;
      },
      () => setNotFound(true),
    );
  }, [slug]);

  if (notFound) return <div className="flex min-h-screen items-center justify-center text-zinc-500">Barbearia não encontrada.</div>;
  if (!data) return null;
  const { shop } = data;
  const accent = shop.accent_color;
  const featured = data.ads.filter((a) => a.placement === 'destaque');
  const mural = data.ads.filter((a) => a.placement === 'mural');

  return (
    <div className="min-h-screen bg-zinc-50" style={{ ['--accent' as string]: accent }}>
      <header className="relative overflow-hidden text-white" style={{ background: shop.primary_color }}>
        {shop.cover_url && <img src={shop.cover_url} alt="" className="absolute inset-0 size-full object-cover opacity-30" />}
        <div className="relative mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
          {shop.logo_url && <img src={shop.logo_url} alt={shop.name} className="mb-5 size-20 rounded-2xl bg-white object-contain p-1 shadow-lg" />}
          <h1 className="text-4xl font-extrabold sm:text-5xl">{shop.name}</h1>
          {shop.tagline && <p className="mt-2 text-lg opacity-90">{shop.tagline}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            {data.canBook ? (
              <a href={`/b/${slug}/conta`} className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-bold text-zinc-950 shadow" style={{ background: accent }}>
                <CalendarCheck className="size-5" /> Agendar horário
              </a>
            ) : (
              shop.whatsapp && (
                <a
                  href={whatsappLink(shop.whatsapp, `Olá, ${shop.name}! Quero agendar um horário.`)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-bold text-zinc-950 shadow"
                  style={{ background: accent }}
                >
                  <MessageCircle className="size-5" /> Agendar pelo WhatsApp
                </a>
              )
            )}
            <a href={`/b/${slug}/conta`} className="inline-flex items-center gap-2 rounded-full bg-white/15 px-5 py-2.5 font-semibold backdrop-blur hover:bg-white/25">
              <UserRound className="size-5" /> {data.loggedIn ? 'Minha área' : 'Entrar'}
            </a>
            {data.canBook && shop.whatsapp && (
              <a
                href={whatsappLink(shop.whatsapp, `Oi, ${shop.bot_name}!`)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-white/15 px-5 py-2.5 font-semibold backdrop-blur hover:bg-white/25"
              >
                <MessageCircle className="size-5" /> Falar com o {shop.bot_name}
              </a>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-14 px-4 py-10 sm:px-6">
        {featured.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {featured.map((ad) => (
              <AdCard key={ad.id} ad={ad} big />
            ))}
          </div>
        )}

        {data.campaigns.length > 0 && (
          <Section icon={<Sparkles />} title="Campanhas da comunidade" accent={accent}>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.campaigns.map((c) => (
                <div key={c.id} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200">
                  {c.image_url && <img src={c.image_url} alt="" className="h-36 w-full object-cover" />}
                  <div className="p-5">
                    <p className="text-lg font-bold">{c.name}</p>
                    <p className="mt-1">
                      Juntou <b>{c.goal}</b> {c.unit_label}, ganhou <b style={{ color: shop.primary_color }}>{c.reward}</b>
                    </p>
                    {c.description && <p className="mt-2 text-sm text-zinc-500">{c.description}</p>}
                    <p className="mt-2 text-xs text-zinc-400">
                      {c.partner && `Oferecimento: ${c.partner}. `}
                      {c.ends_on && `Válida até ${new Date(`${c.ends_on}T12:00:00`).toLocaleDateString('pt-BR')}.`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        <MemberCta slug={slug} accent={accent} botName={shop.bot_name} loggedIn={data.loggedIn} />

        {data.services.length > 0 && (
          <Section icon={<Scissors />} title="Serviços" accent={accent}>
            <ul className="divide-y divide-zinc-100 rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200">
              {data.services.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <p className="font-semibold">{s.name}</p>
                    {s.description && <p className="text-sm text-zinc-500">{s.description}</p>}
                    {s.duration_min && <p className="text-xs text-zinc-400">{s.duration_min} min</p>}
                  </div>
                  <p className="font-bold whitespace-nowrap">{money(s.price_cents)}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {data.products.length > 0 && (
          <Section icon={<Package />} title="Produtos" accent={accent}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {data.products.map((p) => (
                <div key={p.id} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200">
                  {p.image_url ? <img src={p.image_url} alt="" className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-zinc-100" />}
                  <div className="p-3">
                    <p className="text-sm font-semibold">{p.name}</p>
                    <p className="text-sm font-bold">{money(p.price_cents)}</p>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {(data.partners.length > 0 || mural.length > 0) && (
          <Section icon={<Handshake />} title="Parceiros da comunidade" accent={accent}>
            {mural.length > 0 && (
              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                {mural.map((ad) => (
                  <AdCard key={ad.id} ad={ad} />
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {data.partners.map((p) => (
                <div key={p.id} className="flex gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
                  {p.logo_url && <img src={p.logo_url} alt="" className="size-14 rounded-xl object-cover" />}
                  <div>
                    <p className="font-semibold">{p.name}</p>
                    {p.category && <p className="text-xs text-zinc-500">{p.category}</p>}
                    {p.benefit && <p className="mt-1 text-sm font-medium text-emerald-700">Membro ganha: {p.benefit}</p>}
                    <div className="mt-1 flex gap-3 text-xs text-zinc-500">
                      {p.instagram && (
                        <a href={instagramLink(p.instagram)} target="_blank" rel="noreferrer" className="hover:underline">
                          Instagram
                        </a>
                      )}
                      {p.website && (
                        <a href={p.website} target="_blank" rel="noreferrer" className="hover:underline">
                          Site
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {shop.about && (
          <Section icon={<Sparkles />} title="Sobre nós" accent={accent}>
            <p className="whitespace-pre-line text-zinc-700">{shop.about}</p>
          </Section>
        )}
      </main>

      <footer className="text-white" style={{ background: shop.primary_color }}>
        <div className="mx-auto grid max-w-5xl gap-3 px-4 py-8 text-sm sm:grid-cols-3 sm:px-6">
          {shop.address && (
            <p className="flex gap-2">
              <MapPin className="size-4 shrink-0" /> {shop.address}
            </p>
          )}
          {shop.hours && (
            <p className="flex gap-2">
              <Clock className="size-4 shrink-0" /> {shop.hours}
            </p>
          )}
          {shop.instagram && (
            <a href={instagramLink(shop.instagram)} target="_blank" rel="noreferrer" className="flex gap-2 hover:underline">
              <AtSign className="size-4 shrink-0" /> {shop.instagram}
            </a>
          )}
        </div>
        <p className="pb-6 text-center text-xs opacity-70">
          <a href={`/b/${slug}/privacidade`} className="hover:underline">
            Política de privacidade
          </a>
        </p>
      </footer>
    </div>
  );
}

function Section({ icon, title, accent, children }: { icon: ReactNode; title: string; accent: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 flex items-center gap-2 text-2xl font-bold">
        <span className="[&>svg]:size-6" style={{ color: accent }}>
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function AdCard({ ad, big }: { ad: PageData['ads'][number]; big?: boolean }) {
  const content = (
    <div className="relative h-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200 transition hover:shadow-md">
      {ad.image_url && <img src={ad.image_url} alt="" className={`w-full object-cover ${big ? 'h-44' : 'h-28'}`} />}
      <div className="p-4">
        <span className="text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">Anúncio{ad.partner ? ` · ${ad.partner}` : ''}</span>
        <p className={`font-bold ${big ? 'text-lg' : ''}`}>{ad.title}</p>
        {ad.body && <p className="text-sm text-zinc-600">{ad.body}</p>}
      </div>
    </div>
  );
  return ad.hasLink ? (
    <a href={`/api/public/ads/${ad.id}/click`} target="_blank" rel="noreferrer sponsored">
      {content}
    </a>
  ) : (
    content
  );
}

/** Convite para a área do cliente (agenda, cartão fidelidade e vouchers). */
function MemberCta({ slug, accent, botName, loggedIn }: { slug: string; accent: string; botName: string; loggedIn: boolean }) {
  return (
    <section id="cartao" className="scroll-mt-6 rounded-3xl bg-zinc-950 p-6 text-white sm:p-8">
      <h2 className="flex items-center gap-2 text-2xl font-bold">
        <Gift className="size-6" style={{ color: accent }} /> Área do cliente
      </h2>
      <p className="mt-2 max-w-2xl text-zinc-300">
        Entre com seu celular para agendar, acompanhar seu cartão fidelidade e pegar vouchers de desconto. O {botName}, nosso robô no WhatsApp, te lembra do
        seu horário de sempre.
      </p>
      <a href={`/b/${slug}/conta`} className="mt-5 inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-bold text-zinc-950" style={{ background: accent }}>
        <UserRound className="size-5" /> {loggedIn ? 'Abrir minha área' : 'Entrar com meu celular'}
      </a>
    </section>
  );
}
