import { WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Sem internet: avisa que a tela mostra a última cópia guardada no aparelho. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <p className="flex items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-950">
      <WifiOff className="size-4 shrink-0" /> Sem internet: mostrando a última agenda guardada no aparelho. O que mudar aparece quando a internet voltar.
    </p>
  );
}
