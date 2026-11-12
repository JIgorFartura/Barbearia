import { ArrowLeft, Scissors } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { LoginCard } from './Home';

interface Brand {
  name: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
}

/**
 * Entrada da equipe pelo site da barbearia (/b/:slug/equipe): o barbeiro, o balcão e o dono entram
 * com a marca da barbearia, sem passar pela página de vendas da Bladr. Depois do login, cada um
 * cai na sua área (o painel, o app do barbeiro ou o balcão).
 */
export function TeamLogin({ slug }: { slug: string }) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api<Brand>('GET', `/api/public/shops/${slug}/brand`).then(
      (b) => {
        setBrand(b);
        document.title = `Equipe · ${b.name}`;
      },
      () => setMissing(true),
    );
  }, [slug]);
  if (missing) return <div className="flex min-h-screen items-center justify-center text-zinc-500">Barbearia não encontrada.</div>;
  if (!brand) return null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10" style={{ background: brand.primary_color }}>
      <div className="flex flex-col items-center gap-3 text-center text-white">
        {brand.logo_url ? (
          <img src={brand.logo_url} alt={brand.name} className="size-20 rounded-2xl bg-white object-contain p-1 shadow-lg" />
        ) : (
          <span className="flex size-20 items-center justify-center rounded-2xl shadow-lg" style={{ background: brand.accent_color }}>
            <Scissors className="size-9 text-zinc-950" />
          </span>
        )}
        <div>
          <p className="text-2xl font-bold">{brand.name}</p>
          <p className="text-sm opacity-80">Acesso da equipe: barbeiros, balcão e dono</p>
        </div>
      </div>
      <div className="w-full max-w-sm">
        {/* Recarrega a página inteira: o app abre a área certa para quem entrou. */}
        <LoginCard title="Entrar" onDone={() => location.assign('/')} />
      </div>
      <a href={`/b/${slug}`} className="inline-flex items-center gap-1 text-sm font-medium text-white/80 hover:text-white">
        <ArrowLeft className="size-4" /> Voltar para o site
      </a>
    </div>
  );
}
