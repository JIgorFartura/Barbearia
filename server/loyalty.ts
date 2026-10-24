import { today } from './config.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';

export interface Campaign {
  id: number;
  barbershop_id: number;
  name: string;
  description: string | null;
  unit_label: string;
  goal: number;
  reward: string;
  image_url: string | null;
  starts_on: string | null;
  ends_on: string | null;
  active: number;
}

export interface Progress {
  /** Total de carimbos já ganhos na campanha. */
  earned: number;
  /** Prêmios já entregues. */
  redeemed: number;
  /** Carimbos no cartão atual (0 até goal - 1). */
  stamps: number;
  goal: number;
  /** Prêmios conquistados e ainda não retirados. */
  available: number;
}

/** "Junte N, ganhe 1": a cada `goal` carimbos o cliente ganha um prêmio; o cartão recomeça. */
export function progressFor(goal: number, earned: number, redeemed: number): Progress {
  return { earned, redeemed, goal, stamps: earned % goal, available: Math.floor(earned / goal) - redeemed };
}

export function isRunning(c: Pick<Campaign, 'active' | 'starts_on' | 'ends_on'>, day = today()): boolean {
  return Boolean(c.active) && (!c.starts_on || c.starts_on <= day) && (!c.ends_on || c.ends_on >= day);
}

function campaignOf(shopId: number, campaignId: number): Campaign {
  const c = get<Campaign>('SELECT * FROM campaigns WHERE id = ? AND barbershop_id = ?', [campaignId, shopId]);
  if (!c) throw new HttpError(404, 'Campanha não encontrada.');
  return c;
}

function assertCustomer(shopId: number, customerId: number): void {
  if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ?', [customerId, shopId])) {
    throw new HttpError(404, 'Cliente não encontrado.');
  }
}

function totals(campaignId: number, customerId: number): { earned: number; redeemed: number } {
  const row = get<{ earned: number; redeemed: number }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'earn' THEN qty END), 0) AS earned,
            COALESCE(SUM(CASE WHEN kind = 'redeem' THEN qty END), 0) AS redeemed
       FROM loyalty_events WHERE campaign_id = ? AND customer_id = ?`,
    [campaignId, customerId],
  );
  return { earned: row?.earned ?? 0, redeemed: row?.redeemed ?? 0 };
}

export function progress(campaign: Campaign, customerId: number): Progress {
  const t = totals(campaign.id, customerId);
  return progressFor(campaign.goal, t.earned, t.redeemed);
}

/** Registra consumo (ex.: 2 cervejas) e devolve o cartão atualizado. */
export function addStamps(shopId: number, campaignId: number, customerId: number, qty: number, userId: number | null): Progress {
  return tx(() => {
    const c = campaignOf(shopId, campaignId);
    assertCustomer(shopId, customerId);
    if (!isRunning(c)) throw new HttpError(400, 'Esta campanha não está valendo hoje.');
    run('INSERT INTO loyalty_events (campaign_id, customer_id, kind, qty, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      c.id,
      customerId,
      'earn',
      qty,
      userId,
      nowIso(),
    ]);
    return progress(c, customerId);
  });
}

/** Entrega um prêmio conquistado. Vale mesmo depois do fim da campanha: prêmio ganho é do cliente. */
export function redeemReward(shopId: number, campaignId: number, customerId: number, userId: number | null): Progress {
  return tx(() => {
    const c = campaignOf(shopId, campaignId);
    assertCustomer(shopId, customerId);
    if (progress(c, customerId).available < 1) throw new HttpError(400, 'O cliente ainda não tem prêmio para retirar.');
    run('INSERT INTO loyalty_events (campaign_id, customer_id, kind, qty, user_id, created_at) VALUES (?, ?, ?, 1, ?, ?)', [
      c.id,
      customerId,
      'redeem',
      userId,
      nowIso(),
    ]);
    return progress(c, customerId);
  });
}

/** Cartão do cliente: campanhas valendo + campanhas encerradas onde ele ainda tem prêmio a retirar. */
export function customerCard(shopId: number, customerId: number) {
  const campaigns = all<Campaign>('SELECT * FROM campaigns WHERE barbershop_id = ? ORDER BY created_at DESC', [shopId]);
  return campaigns
    .map((c) => ({ campaign: c, running: isRunning(c), progress: progress(c, customerId) }))
    .filter((x) => x.running || x.progress.available > 0);
}
