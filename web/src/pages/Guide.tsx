import { ListOrdered, MapPin, Search, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BladrMark } from '../components/BladrMark';
import { api } from '../lib/api';

interface GuideShop {
  slug: string;
  name: string;
  tagline: string | null;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  address: string | null;
  city: string;
  district: string | null;
  queue_enabled: number;
  rating: { n: number; avg: number | null };
}

/** Guia público de barbearias que usam a Bladr (só as que pediram para aparecer). */
export function Guide() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ cities: string[]; shops: GuideShop[] } | null>(null);
  useEffect(() => {
    document.title = 'Barbearias · Bladr';
    const t = setTimeout(() => api<typeof data>('GET', `/api/public/guide?q=${encodeURIComponent(q)}`).then(setData, () => undefined), 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-zinc-950 text-white">
        <div className="mx-auto max-w-4xl px-4 py-8">
          <a href="/" className="inline-flex items-center gap-2">
            <BladrMark className="size-8" />
            <span className="text-lg font-bold">bladr.</span>
          </a>
          <h1 className="mt-6 text-3xl font-extrabold">Ache uma barbearia e agende pelo celular</h1>
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-zinc-900">
            <Search className="size-5 text-zinc-400" />
            <input className="w-full outline-none" placeholder="Cidade, bairro ou nome" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {data && data.cities.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {data.cities.map((c) => (
                <button key={c} className="rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20" onClick={() => setQ(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto grid max-w-4xl gap-3 px-4 py-6 sm:grid-cols-2">
        {data?.shops.length === 0 && <p className="text-zinc-500">Nenhuma barbearia encontrada{q ? ` para “${q}”` : ''}.</p>}
        {data?.shops.map((s) => (
          <a key={s.slug} href={`/b/${s.slug}`} className="flex gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 transition hover:shadow-md">
            {s.logo_url ? (
              <img src={s.logo_url} alt="" className="size-14 shrink-0 rounded-xl object-contain" style={{ background: s.primary_color }} />
            ) : (
              <span className="flex size-14 shrink-0 items-center justify-center rounded-xl text-xl font-bold" style={{ background: s.primary_color, color: s.accent_color }}>
                {s.name.charAt(0)}
              </span>
            )}
            <div className="min-w-0">
              <p className="font-semibold">{s.name}</p>
              <p className="flex items-center gap-1 text-sm text-zinc-500">
                <MapPin className="size-3.5" /> {s.district ? `${s.district}, ` : ''}
                {s.city}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                {s.rating.avg != null && s.rating.n >= 3 && (
                  <span className="flex items-center gap-0.5">
                    <Star className="size-3.5 fill-amber-400 text-amber-400" /> {s.rating.avg.toLocaleString('pt-BR')} ({s.rating.n})
                  </span>
                )}
                {Boolean(s.queue_enabled) && (
                  <span className="flex items-center gap-0.5">
                    <ListOrdered className="size-3.5" /> Fila pelo celular
                  </span>
                )}
                <span className="font-semibold text-zinc-900">Agendar →</span>
              </p>
            </div>
          </a>
        ))}
      </main>
    </div>
  );
}
