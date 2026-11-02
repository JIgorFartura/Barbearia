import { all, get, run } from './db.js';
import { sendPlatformMessage } from './platform.js';

/**
 * Erros inesperados do servidor e das telas. Ficam registrados (agrupados: o mesmo erro só soma na
 * contagem) para o master ver na aba Sistema, e o master recebe no máximo um aviso por hora no
 * WhatsApp da plataforma. Números e e-mails são mascarados: o registro não guarda dados de clientes.
 */

export type ErrorSource = 'server' | 'web';

const ALERT_EVERY_MS = 3600000;

/** Tira celulares, documentos e e-mails do texto do erro. */
const mask = (text: string) => text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '•••@•••').replace(/\d{8,}/g, '•••');

export function recordError(source: ErrorSource, message: string, opts: { detail?: string | null; path?: string | null; now?: Date } = {}): void {
  try {
    const at = (opts.now ?? new Date()).toISOString();
    const msg = mask(message || 'Erro sem mensagem').slice(0, 300);
    const path = opts.path ? mask(opts.path.split('?')[0]).slice(0, 200) : '';
    const detail = opts.detail ? mask(opts.detail).slice(0, 2000) : null;
    run(
      `INSERT INTO error_log (source, message, path, detail, count, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (source, message, path) DO UPDATE SET count = count + 1, last_at = excluded.last_at, detail = COALESCE(excluded.detail, detail)`,
      [source, msg, path, detail, at, at],
    );
  } catch (err) {
    // O registro de erros nunca pode derrubar o sistema.
    console.error('[erros] não deu para registrar:', err);
  }
}

/** Últimos erros (aba Sistema do master). */
export function recentErrors(limit = 20) {
  return all<{ id: number; source: ErrorSource; message: string; path: string; count: number; first_at: string; last_at: string }>(
    'SELECT id, source, message, path, count, first_at, last_at FROM error_log ORDER BY last_at DESC LIMIT ?',
    [limit],
  );
}

export function clearErrors(): void {
  run('DELETE FROM error_log');
}

let lastAlert = 0;

/** Avisa o master (no máximo de hora em hora) quando aparecem erros novos. Chamado pelas automações. */
export async function errorAlerts(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastAlert < ALERT_EVERY_MS) return 0;
  const fresh = all<{ id: number; message: string; count: number; first_at: string }>(
    'SELECT id, message, count, first_at FROM error_log WHERE alerted_at IS NULL OR last_at > alerted_at ORDER BY last_at DESC',
  );
  if (!fresh.length) return 0;
  lastAlert = now.getTime();
  const total = fresh.reduce((n, e) => n + e.count, 0);
  const since = fresh.reduce((min, e) => (e.first_at < min ? e.first_at : min), fresh[0].first_at);
  const sinceLabel = new Date(since).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
  const first = fresh[0].message.slice(0, 120);
  const text = `⚠️ Bladr: ${total} erro(s) desde ${sinceLabel}. O mais recente: "${first}". Veja em Master, aba Sistema.`;
  const masters = all<{ id: number; phone: string }>("SELECT id, phone FROM users WHERE role = 'master' AND phone IS NOT NULL");
  let sent = 0;
  for (const m of masters) {
    const r = await sendPlatformMessage({ phone: m.phone, text, kind: 'alerta', userId: m.id, template: { kind: 'sistema', params: [String(total), sinceLabel, first] } });
    if (r.status !== 'failed') sent++;
  }
  run('UPDATE error_log SET alerted_at = ? WHERE id IN (SELECT id FROM error_log WHERE alerted_at IS NULL OR last_at > alerted_at)', [now.toISOString()]);
  return sent;
}

/** Para os testes. */
export const resetErrorAlerts = () => {
  lastAlert = 0;
};

export const errorCount = () => get<{ n: number }>('SELECT COALESCE(SUM(count), 0) AS n FROM error_log')!.n;

