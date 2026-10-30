import { shopNow } from './clock.js';
import { all, get, run } from './db.js';
import { shopBot, waConfig } from './messaging.js';
import { notifyOwners } from './platform.js';
import { hourLabel } from './time.js';
import { probeConnection } from './whatsapp.js';

/**
 * Vigia a conexão do WhatsApp de cada barbearia. A sessão por QR Code (Evolution) às vezes cai e aí
 * lembretes e robô param sem ninguém perceber: o sistema confere a cada 10 minutos, mostra o aviso no
 * painel e manda uma mensagem para o dono pelo WhatsApp da plataforma.
 */

const CHECK_EVERY_MS = 10 * 60000;
/** Duas verificações seguidas com falha antes de avisar (evita alarme por uma oscilação de rede). */
const FAILS_TO_ALERT = 2;
const REALERT_MS = 24 * 3600000;
/** Avisos só neste horário (relógio da barbearia); de madrugada fica para a manhã. */
const ALERT_FROM = '07:00';
const ALERT_UNTIL = '22:00';

const fails = new Map<number, number>();

export interface ConnectionInfo {
  status: 'ok' | 'down' | 'unknown';
  since: string | null;
  checkedAt: string | null;
  error: string | null;
}

interface ShopConn {
  id: number;
  name: string;
  wa_provider: string;
  wa_status: 'ok' | 'down' | null;
  wa_status_at: string | null;
  wa_checked_at: string | null;
  wa_error: string | null;
  wa_alerted_at: string | null;
}

const shopConn = (shopId: number) =>
  get<ShopConn>('SELECT id, name, wa_provider, wa_status, wa_status_at, wa_checked_at, wa_error, wa_alerted_at FROM barbershops WHERE id = ?', [shopId]);

export function connectionInfo(shopId: number): ConnectionInfo | null {
  const s = shopConn(shopId);
  if (!s || s.wa_provider === 'simulador') return null;
  return { status: s.wa_status ?? 'unknown', since: s.wa_status_at, checkedAt: s.wa_checked_at, error: s.wa_error };
}

/** Canal trocado no painel: volta a "não verificado" e confere de novo. */
export function resetConnection(shopId: number): void {
  fails.delete(shopId);
  run('UPDATE barbershops SET wa_status = NULL, wa_status_at = NULL, wa_checked_at = NULL, wa_error = NULL, wa_alerted_at = NULL WHERE id = ?', [shopId]);
}

const withinAlertHours = (shopId: number, now: Date) => {
  const t = shopNow(shopId, now).time;
  return t >= ALERT_FROM && t < ALERT_UNTIL;
};

/** Registra o resultado de uma verificação (ou de um evento da Evolution) e avisa o dono se mudou. */
export async function setConnection(shopId: number, ok: boolean, detail: string, now: Date = new Date(), opts: { immediate?: boolean } = {}): Promise<void> {
  const s = shopConn(shopId);
  if (!s || s.wa_provider === 'simulador') return;
  const at = now.toISOString();
  run('UPDATE barbershops SET wa_checked_at = ? WHERE id = ?', [at, shopId]);

  if (ok) {
    fails.delete(shopId);
    if (s.wa_status !== 'ok') {
      run('UPDATE barbershops SET wa_status = ?, wa_status_at = ?, wa_error = NULL, wa_alerted_at = NULL WHERE id = ?', ['ok', at, shopId]);
      // Só avisa a volta para quem foi avisado da queda.
      if (s.wa_status === 'down' && s.wa_alerted_at && withinAlertHours(shopId, now)) {
        await notifyOwners(shopId, `✅ O WhatsApp da ${s.name} voltou a funcionar. O robô e os lembretes já estão rodando de novo.`);
      }
    }
    return;
  }

  const count = (fails.get(shopId) ?? 0) + 1;
  fails.set(shopId, count);
  if (count < FAILS_TO_ALERT && !opts.immediate && s.wa_status !== 'down') {
    run('UPDATE barbershops SET wa_error = ? WHERE id = ?', [detail, shopId]);
    return;
  }
  if (s.wa_status !== 'down') {
    run('UPDATE barbershops SET wa_status = ?, wa_status_at = ?, wa_error = ?, wa_alerted_at = NULL WHERE id = ?', ['down', at, detail, shopId]);
  } else {
    run('UPDATE barbershops SET wa_error = ? WHERE id = ?', [detail, shopId]);
  }
  const fresh = shopConn(shopId)!;
  const due = !fresh.wa_alerted_at || now.getTime() - new Date(fresh.wa_alerted_at).getTime() >= REALERT_MS;
  if (!due || !withinAlertHours(shopId, now)) return;
  const since = new Date(fresh.wa_status_at ?? at);
  const local = shopNow(shopId, since);
  const when = `${local.date.slice(8, 10)}/${local.date.slice(5, 7)} às ${hourLabel(local.time)}`;
  run('UPDATE barbershops SET wa_alerted_at = ? WHERE id = ?', [at, shopId]);
  await notifyOwners(
    shopId,
    `⚠ O WhatsApp da ${s.name} desconectou em ${when}. O robô e os lembretes estão parados até reconectar: Painel → Robô WhatsApp → aba WhatsApp. (${detail})`,
    { kind: 'alerta', params: [s.name, when] },
    { includeMaster: true },
  );
}

/** Confere agora a conexão de uma barbearia. */
export async function checkShopConnection(shopId: number, now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<ConnectionInfo | null> {
  const shop = shopBot(shopId);
  if (shop.wa_provider === 'simulador') return null;
  const r = await probeConnection(shop.wa_provider, waConfig(shop), fetchImpl);
  await setConnection(shopId, r.ok, r.detail, now, { immediate: true });
  return connectionInfo(shopId);
}

/** Chamado a cada minuto: confere as barbearias cuja última verificação passou de 10 minutos. */
export async function checkConnections(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<number> {
  const limit = new Date(now.getTime() - CHECK_EVERY_MS).toISOString();
  const due = all<{ id: number }>(
    "SELECT id FROM barbershops WHERE active = 1 AND wa_provider <> 'simulador' AND (wa_checked_at IS NULL OR wa_checked_at <= ?) ORDER BY id",
    [limit],
  );
  for (const { id } of due) {
    const shop = shopBot(id);
    const r = await probeConnection(shop.wa_provider, waConfig(shop), fetchImpl);
    await setConnection(id, r.ok, r.detail, now);
  }
  return due.length;
}

/** Barbearias com o WhatsApp fora do ar (painel master). */
export const downShops = () =>
  all<{ id: number; name: string; since: string | null; error: string | null }>(
    "SELECT id, name, wa_status_at AS since, wa_error AS error FROM barbershops WHERE active = 1 AND wa_provider <> 'simulador' AND wa_status = 'down' ORDER BY wa_status_at",
  );

