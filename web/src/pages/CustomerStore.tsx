import { Handshake, Minus, Plus, ShoppingBag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Section } from '../components/CustomerSection';
import { Button, ErrorText, Modal } from '../components/ui';
import { api } from '../lib/api';
import { cap, instagramLink, money, stampLabel } from '../lib/format';

interface Product {
  id: number;
  name: string;
  description: string | null;
  price_cents: number;
  image_url: string | null;
  /** null = a barbearia não controla o estoque desse produto. */
  available: number | null;
}

interface Partner {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  benefit: string | null;
  instagram: string | null;
  website: string | null;
  logo_url: string | null;
}

interface Ad {
  id: number;
  title: string;
  body: string | null;
  image_url: string | null;
  hasLink: boolean;
  placement: 'destaque' | 'mural';
  partner: string | null;
}

export interface Vitrine {
  products: Product[];
  partners: Partner[];
  ads: Ad[];
}

interface NextAppt {
  id: number;
  starts_at: string;
  barber_name: string;
}

/** Vitrine do app: carrega uma vez (cada abertura conta uma visualização para os anunciantes). */
export function useVitrine(slug: string) {
  const [vitrine, setVitrine] = useState<Vitrine | null>(null);
  useEffect(() => {
    api<Vitrine>('GET', `/api/customer/${slug}/vitrine`).then(setVitrine, () => setVitrine(null));
  }, [slug]);
  return vitrine;
}

/** Anúncio em destaque, no topo da área do cliente. */
export function FeaturedAds({ ads }: { ads: Ad[] }) {
  const featured = ads.filter((a) => a.placement === 'destaque');
  if (!featured.length) return null;
  return (
    <div className="space-y-3">
      {featured.map((ad) => (
        <AdCard key={ad.id} ad={ad} big />
      ))}
    </div>
  );
}

/** Loja da barbearia: o cliente vê os produtos e pede para deixar separado no próximo horário (paga junto com o corte). */
export function StoreSection({
  slug,
  products,
  next,
  accent,
  onBook,
  onReserved,
}: {
  slug: string;
  products: Product[];
  next: NextAppt | null;
  accent: string;
  onBook: () => void;
  onReserved: () => void;
}) {
  const [picking, setPicking] = useState<Product | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!products.length) return null;
  return (
    <Section icon={<ShoppingBag />} title="Loja da barbearia" id="loja">
      <p className="mb-3 text-sm text-zinc-500">
        {next
          ? `Peça para deixar separado no seu horário de ${stampLabel(next.starts_at)}. Você paga junto com o corte.`
          : 'Marque um horário e peça para deixar separado. Você paga junto com o corte.'}
      </p>
      {done && <p className="mb-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900 ring-1 ring-emerald-200">{done}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {products.map((p) => {
          const soldOut = p.available != null && p.available <= 0;
          return (
            <div key={p.id} className="flex flex-col overflow-hidden rounded-xl ring-1 ring-zinc-200">
              {p.image_url ? (
                <img src={p.image_url} alt="" className="aspect-square w-full object-cover" />
              ) : (
                <div className="flex aspect-square items-center justify-center bg-zinc-100">
                  <ShoppingBag className="size-8 text-zinc-300" />
                </div>
              )}
              <div className="flex flex-1 flex-col p-3">
                <p className="text-sm font-semibold">{p.name}</p>
                {p.description && <p className="line-clamp-2 text-xs text-zinc-500">{p.description}</p>}
                <p className="mt-1 font-bold">{money(p.price_cents)}</p>
                <div className="mt-auto pt-2">
                  {soldOut ? (
                    <p className="text-xs font-medium text-zinc-400">Acabou por enquanto</p>
                  ) : (
                    <Button
                      className="!w-full !py-1.5 text-sm"
                      style={{ background: accent, color: '#09090b' }}
                      onClick={() => (next ? setPicking(p) : onBook())}
                    >
                      {next ? 'Separar pra mim' : 'Agendar'}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {picking && next && (
        <ReserveModal
          slug={slug}
          product={picking}
          next={next}
          accent={accent}
          onClose={() => setPicking(null)}
          onDone={(msg) => {
            setPicking(null);
            setDone(msg);
            onReserved();
          }}
        />
      )}
    </Section>
  );
}

function ReserveModal({
  slug,
  product,
  next,
  accent,
  onClose,
  onDone,
}: {
  slug: string;
  product: Product;
  next: NextAppt;
  accent: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const max = Math.min(5, product.available ?? 5);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function reserve() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ barber: string }>('POST', `/api/customer/${slug}/appointments/${next.id}/items`, { items: [{ product_id: product.id, qty }] });
      const what = qty === 1 ? `1 ${product.name.toLowerCase()}` : `${qty} unidades de ${product.name.toLowerCase()}`;
      onDone(`Pronto! O ${r.barber} vai deixar separado pra você: ${what}. ✅`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Deixar separado" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-3">
          {product.image_url && <img src={product.image_url} alt="" className="size-16 rounded-lg object-cover" />}
          <div>
            <p className="font-semibold">{product.name}</p>
            <p className="text-sm text-zinc-500">{money(product.price_cents)} cada</p>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-3">
          <span className="text-sm text-zinc-600">Quantidade</span>
          <div className="flex items-center gap-3">
            <button
              className="rounded-full p-1.5 ring-1 ring-zinc-300 disabled:opacity-30"
              disabled={qty <= 1}
              onClick={() => setQty(qty - 1)}
              aria-label="Menos"
            >
              <Minus className="size-4" />
            </button>
            <span className="w-5 text-center font-bold">{qty}</span>
            <button
              className="rounded-full p-1.5 ring-1 ring-zinc-300 disabled:opacity-30"
              disabled={qty >= max}
              onClick={() => setQty(qty + 1)}
              aria-label="Mais"
            >
              <Plus className="size-4" />
            </button>
          </div>
        </div>
        <p className="text-sm text-zinc-600">
          Fica separado para {cap(stampLabel(next.starts_at))} com {next.barber_name}. Total: <b>{money(product.price_cents * qty)}</b>, pago junto com o corte.
        </p>
        <ErrorText error={error} />
        <Button className="w-full" style={{ background: accent, color: '#09090b' }} disabled={busy} onClick={reserve}>
          Separar pra mim
        </Button>
      </div>
    </Modal>
  );
}

/** Parceiros da barbearia (com o benefício de quem é cliente) e o mural de anúncios. */
export function PartnersSection({ partners, ads }: { partners: Partner[]; ads: Ad[] }) {
  const mural = ads.filter((a) => a.placement === 'mural');
  if (!partners.length && !mural.length) return null;
  return (
    <Section icon={<Handshake />} title="Parceiros e ofertas">
      {mural.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          {mural.map((ad) => (
            <AdCard key={ad.id} ad={ad} />
          ))}
        </div>
      )}
      <ul className="space-y-2">
        {partners.map((p) => (
          <li key={p.id} className="flex gap-3 rounded-xl bg-zinc-50 px-4 py-3">
            {p.logo_url && <img src={p.logo_url} alt="" className="size-12 shrink-0 rounded-lg object-cover" />}
            <div className="min-w-0">
              <p className="font-semibold">{p.name}</p>
              {p.category && <p className="text-xs text-zinc-500">{p.category}</p>}
              {p.benefit && <p className="mt-0.5 text-sm font-medium text-emerald-700">Cliente ganha: {p.benefit}</p>}
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
          </li>
        ))}
      </ul>
    </Section>
  );
}

function AdCard({ ad, big }: { ad: Ad; big?: boolean }) {
  const content = (
    <div className="h-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200">
      {ad.image_url && <img src={ad.image_url} alt="" className={`w-full object-cover ${big ? 'h-40' : 'h-28'}`} />}
      <div className="p-4">
        <span className="text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">Anúncio{ad.partner ? ` · ${ad.partner}` : ''}</span>
        <p className={`font-bold ${big ? 'text-lg' : ''}`}>{ad.title}</p>
        {ad.body && <p className="text-sm text-zinc-600">{ad.body}</p>}
      </div>
    </div>
  );
  return ad.hasLink ? (
    <a href={`/api/public/ads/${ad.id}/click`} target="_blank" rel="noreferrer sponsored" className="block">
      {content}
    </a>
  ) : (
    content
  );
}
