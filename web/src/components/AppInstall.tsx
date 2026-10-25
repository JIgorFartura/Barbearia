import { BellRing, Download, Share, Smartphone, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { canInstall, disablePush, enablePush, install, isIos, isStandalone, onPwaChange, pushState, syncPush, type PushState } from '../lib/pwa';
import { Section } from './CustomerSection';

/** Estado do app (instalar) e dos avisos neste aparelho. */
function usePwa(pushUrl: string) {
  const [push, setPush] = useState<PushState | null>(null);
  const [installable, setInstallable] = useState(canInstall());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onPwaChange(() => setInstallable(canInstall())), []);
  useEffect(() => {
    void pushState().then((s) => {
      setPush(s);
      // Avisos já ligados: confirma no servidor que este aparelho é desta conta.
      if (s === 'on') void syncPush(pushUrl);
    });
  }, [pushUrl]);

  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      setPush(await (on ? enablePush(pushUrl) : disablePush(pushUrl)));
    } catch (err) {
      setError((err as Error).message || 'Não foi possível ligar os avisos neste aparelho.');
    } finally {
      setBusy(false);
    }
  }
  return { push, installable, busy, error, toggle };
}

const IosSteps = ({ what }: { what: string }) => (
  <p className="text-sm text-zinc-600">
    No iPhone: toque em <Share className="mb-0.5 inline size-4" /> <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>. Abra pelo ícone para {what}.
  </p>
);

/** Área do cliente: instalar o app da barbearia e ligar o lembrete no celular. */
export function AppSection({ slug, shopName, accent }: { slug: string; shopName: string; accent: string }) {
  const { push, installable, busy, error, toggle } = usePwa(`/api/customer/${slug}/push`);
  const standalone = isStandalone();
  if (push === null || (standalone && (push === 'on' || push === 'unsupported'))) return null;
  return (
    <Section icon={<Smartphone />} title="App no celular">
      <div className="space-y-3">
        {!standalone && (
          <>
            <p className="text-sm text-zinc-500">Instale o app da {shopName}: abre direto na sua área, com seus horários, cartão fidelidade e benefícios.</p>
            {installable ? (
              <button
                type="button"
                onClick={() => void install()}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-zinc-950"
                style={{ background: accent }}
              >
                <Download className="size-4" /> Instalar o app
              </button>
            ) : isIos() ? (
              <IosSteps what="receber os avisos" />
            ) : (
              <p className="text-sm text-zinc-500">No menu do navegador, toque em “Instalar app” ou “Adicionar à tela inicial”.</p>
            )}
          </>
        )}
        {push === 'off' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggle(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-100 disabled:opacity-50"
          >
            <BellRing className="size-4" /> {busy ? 'Ligando…' : 'Receber o lembrete do horário no celular'}
          </button>
        )}
        {push === 'on' && (
          <p className="text-sm text-emerald-700">
            ✓ Avisos ligados neste celular.{' '}
            <button type="button" className="text-zinc-500 underline" disabled={busy} onClick={() => void toggle(false)}>
              Desligar
            </button>
          </p>
        )}
        {push === 'denied' && <p className="text-sm text-zinc-500">Os avisos estão bloqueados para este site. Para ligar, libere as notificações nas configurações do navegador.</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Section>
  );
}

const DISMISS_KEY = 'avisos-depois';

/** Painel e app do barbeiro: faixa para ligar os avisos de horário novo e cancelado neste celular. */
export function PushBanner({ text }: { text: string }) {
  const { push, installable, busy, error, toggle } = usePwa('/api/auth/push');
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* navegador sem armazenamento: só nesta visita */
    }
  };
  if (dismissed || !push || !['off', 'needs-install'].includes(push)) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-950 ring-1 ring-sky-200">
      <BellRing className="size-5 shrink-0 text-sky-700" />
      <div className="min-w-0 flex-1">
        <p>{text}</p>
        {push === 'needs-install' && <IosSteps what="ligar os avisos" />}
        {error && <p className="text-red-600">{error}</p>}
      </div>
      {push === 'off' && (
        <button type="button" disabled={busy} onClick={() => void toggle(true)} className="rounded-lg bg-sky-700 px-3 py-1.5 font-semibold text-white hover:bg-sky-800 disabled:opacity-50">
          {busy ? 'Ligando…' : 'Ativar avisos'}
        </button>
      )}
      {installable && (
        <button type="button" onClick={() => void install()} className="rounded-lg bg-white px-3 py-1.5 font-semibold text-sky-800 ring-1 ring-sky-200 hover:bg-sky-100">
          Instalar o app
        </button>
      )}
      <button type="button" onClick={dismiss} className="rounded-lg p-1 text-sky-700 hover:bg-sky-100" aria-label="Agora não">
        <X className="size-4" />
      </button>
    </div>
  );
}
