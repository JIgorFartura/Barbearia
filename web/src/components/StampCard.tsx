import { Check, Gift } from 'lucide-react';

export interface Progress {
  earned: number;
  redeemed: number;
  stamps: number;
  goal: number;
  available: number;
}

/** Cartão de carimbos: usado no balcão e no "Meu cartão" do site. A cor de destaque vem da marca. */
export function StampCard({ name, unit, reward, progress, accent = '#d4a017' }: { name: string; unit: string; reward: string; progress: Progress; accent?: string }) {
  const missing = progress.goal - progress.stamps;
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold">{name}</p>
        {progress.available > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold text-zinc-950" style={{ background: accent }}>
            <Gift className="size-3" /> {progress.available} prêmio{progress.available > 1 ? 's' : ''} para retirar
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {Array.from({ length: progress.goal }, (_, i) => {
          const filled = i < progress.stamps;
          return (
            <span
              key={i}
              className={`flex size-9 items-center justify-center rounded-full border-2 ${filled ? 'text-zinc-950' : 'border-dashed border-zinc-300 text-zinc-300'}`}
              style={filled ? { background: accent, borderColor: accent } : undefined}
            >
              {filled ? <Check className="size-4" /> : i === progress.goal - 1 ? <Gift className="size-4" /> : null}
            </span>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-zinc-500">
        {missing === progress.goal && progress.available === 0
          ? `Junte ${progress.goal} ${unit} e ganhe: ${reward}.`
          : `Faltam ${missing} ${unit} para ganhar: ${reward}.`}
      </p>
    </div>
  );
}
