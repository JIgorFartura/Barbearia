import '@fontsource-variable/inter';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Erro numa tela: avisa o servidor (o master vê na aba Sistema). No máximo 5 por página, sem repetir.
const sent = new Set<string>();
function report(message: string, stack?: string | null) {
  if (!message || sent.size >= 5 || sent.has(message)) return;
  // Ruído de navegador e de extensões, que não é do sistema.
  if (/ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:|Failed to fetch|NetworkError|Load failed/.test(`${message} ${stack ?? ''}`)) return;
  sent.add(message);
  void fetch('/api/client-errors', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: message.slice(0, 500), stack: stack?.slice(0, 3000) ?? null, path: location.pathname }),
    keepalive: true,
  }).catch(() => undefined);
}
window.addEventListener('error', (e) => report(e.message, e.error instanceof Error ? e.error.stack : null));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  // Falha de rede ou da API já aparece na tela para quem está usando: não é erro do programa.
  if (reason && typeof reason === 'object' && 'status' in reason) return;
  report(reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? reason.stack : null);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
