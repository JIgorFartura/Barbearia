import { api } from './api';

/**
 * App instalável e avisos no celular. O navegador oferece a instalação (Android/Chrome) por um evento
 * que guardamos aqui; no iPhone a instalação é pelo menu Compartilhar → Adicionar à Tela de Início, e
 * os avisos só funcionam com o app instalado (iOS 16.4 ou mais novo).
 */

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let installEvent: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

export function startPwa(): void {
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e as InstallPrompt;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    changed();
  });
}

export const onPwaChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const canInstall = () => Boolean(installEvent);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function install(): Promise<boolean> {
  if (!installEvent) return false;
  await installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  changed();
  return outcome === 'accepted';
}

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

const keyBytes = (b64url: string) => {
  const raw = atob(b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '='));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Pede a permissão, inscreve o aparelho e manda a inscrição para `url` (POST). */
export async function enablePush(url: string): Promise<PushState> {
  if (!pushSupported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api<{ key: string }>('GET', '/api/public/push-key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  }
  await api('POST', url, sub.toJSON());
  return 'on';
}

/** Desliga os avisos neste aparelho (e avisa o servidor em `url`, DELETE). */
export async function disablePush(url: string): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('DELETE', url, { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'off';
}

/** Avisos já ligados: confirma a inscrição no servidor (a pessoa pode ter trocado de conta neste aparelho). */
export async function syncPush(url: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await api('POST', url, sub.toJSON()).catch(() => undefined);
}
