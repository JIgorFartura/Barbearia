import crypto from 'node:crypto';
import { shopToday } from './clock.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { addDays } from './time.js';

/** Benefício que a barbearia oferece; o cliente "pega" e recebe um voucher com código único. */
export interface Offer {
  id: number;
  barbershop_id: number;
  title: string;
  description: string | null;
  partner_id: number | null;
  image_url: string | null;
  valid_days: number;
  max_total: number | null;
  per_customer: number;
  starts_on: string | null;
  ends_on: string | null;
  active: number;
}

export interface VoucherView {
  id: number;
  code: string;
  status: 'active' | 'used' | 'expired';
  expires_on: string;
  used_at: string | null;
  created_at: string;
  offer_id: number;
  title: string;
  description: string | null;
  partner: string | null;
  customer_id: number;
  customer_name: string;
  barbershop_id: number;
}

const VOUCHER_SELECT = `
  SELECT v.id, v.code, v.status, v.expires_on, v.used_at, v.created_at, o.id AS offer_id, o.title, o.description, o.barbershop_id,
         p.name AS partner, c.id AS customer_id, c.name AS customer_name
    FROM vouchers v
    JOIN offers o ON o.id = v.offer_id
    JOIN customers c ON c.id = v.customer_id
    LEFT JOIN partners p ON p.id = o.partner_id`;

/** "Vencido" é calculado: voucher ativo cuja validade já passou (no dia da barbearia). */
function withExpiry(v: VoucherView, day = shopToday(v.barbershop_id)): VoucherView {
  return v.status === 'active' && v.expires_on < day ? { ...v, status: 'expired' } : v;
}

export const isOfferRunning = (o: Pick<Offer, 'active' | 'starts_on' | 'ends_on'>, day: string) =>
  Boolean(o.active) && (!o.starts_on || o.starts_on <= day) && (!o.ends_on || o.ends_on >= day);

/** Benefícios valendo hoje, com o que o cliente ainda pode pegar. */
export function offersFor(shopId: number, customerId: number | null) {
  const day = shopToday(shopId);
  return all<Offer & { partner: string | null; issued: number; mine: number }>(
    `SELECT o.*, p.name AS partner,
            (SELECT COUNT(*) FROM vouchers v WHERE v.offer_id = o.id) AS issued,
            (SELECT COUNT(*) FROM vouchers v WHERE v.offer_id = o.id AND v.customer_id = ?) AS mine
       FROM offers o LEFT JOIN partners p ON p.id = o.partner_id
      WHERE o.barbershop_id = ? AND o.reward_only = 0 ORDER BY o.created_at DESC`,
    [customerId ?? 0, shopId],
  )
    .filter((o) => isOfferRunning(o, day))
    .map((o) => {
      const soldOut = o.max_total != null && o.issued >= o.max_total;
      const reachedLimit = o.mine >= o.per_customer;
      return {
        id: o.id,
        title: o.title,
        description: o.description,
        partner: o.partner,
        image_url: o.image_url,
        valid_days: o.valid_days,
        ends_on: o.ends_on,
        remaining: o.max_total == null ? null : Math.max(0, o.max_total - o.issued),
        canClaim: !soldOut && !reachedLimit,
        reason: soldOut ? 'Esgotado' : reachedLimit ? 'Você já pegou' : null,
      };
    });
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode(prefix: string): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return `${prefix}-${suffix}`;
}

/** Cliente pega o voucher (respeita estoque, limite por cliente e período). */
export function claimVoucher(shopId: number, offerId: number, customerId: number): VoucherView {
  return tx(() => {
    const offer = get<Offer & { reward_only: number }>('SELECT * FROM offers WHERE id = ? AND barbershop_id = ?', [offerId, shopId]);
    const day = shopToday(shopId);
    if (!offer || offer.reward_only || !isOfferRunning(offer, day)) throw new HttpError(404, 'Benefício não encontrado ou encerrado.');
    if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ?', [customerId, shopId])) throw new HttpError(404, 'Cliente não encontrado.');
    const issued = get<{ n: number }>('SELECT COUNT(*) AS n FROM vouchers WHERE offer_id = ?', [offerId])!.n;
    if (offer.max_total != null && issued >= offer.max_total) throw new HttpError(409, 'Esse benefício esgotou.');
    const mine = get<{ n: number }>('SELECT COUNT(*) AS n FROM vouchers WHERE offer_id = ? AND customer_id = ?', [offerId, customerId])!.n;
    if (mine >= offer.per_customer) throw new HttpError(409, 'Você já pegou esse benefício.');
    return issueVoucher(shopId, offer, customerId);
  });
}

/** Gera o voucher (código único e validade), sem conferir limites: usado também nos prêmios. */
export function issueVoucher(shopId: number, offer: Pick<Offer, 'id' | 'valid_days' | 'ends_on'>, customerId: number, day: string = shopToday(shopId)): VoucherView {
  return tx(() => {
    const offerId = offer.id;
    const slug = get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [shopId])!.slug;
    const prefix = slug.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'BB';
    let expires = addDays(day, offer.valid_days);
    if (offer.ends_on && offer.ends_on > day && offer.ends_on < expires) expires = offer.ends_on;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode(prefix);
      if (get('SELECT 1 AS ok FROM vouchers WHERE code = ?', [code])) continue;
      const { lastInsertRowid } = run('INSERT INTO vouchers (offer_id, customer_id, code, expires_on, created_at) VALUES (?, ?, ?, ?, ?)', [
        offerId,
        customerId,
        code,
        expires,
        nowIso(),
      ]);
      return withExpiry(get<VoucherView>(`${VOUCHER_SELECT} WHERE v.id = ?`, [lastInsertRowid])!);
    }
    throw new HttpError(500, 'Não foi possível gerar o código. Tente de novo.');
  });
}

export function customerVouchers(customerId: number): VoucherView[] {
  return all<VoucherView>(`${VOUCHER_SELECT} WHERE v.customer_id = ? ORDER BY v.id DESC LIMIT 50`, [customerId]).map((v) => withExpiry(v));
}

export function shopVouchers(shopId: number): VoucherView[] {
  return all<VoucherView>(`${VOUCHER_SELECT} WHERE o.barbershop_id = ? ORDER BY v.id DESC LIMIT 200`, [shopId]).map((v) => withExpiry(v));
}

export function findVoucher(shopId: number, code: string): VoucherView {
  const v = get<VoucherView>(`${VOUCHER_SELECT} WHERE v.code = ? AND o.barbershop_id = ?`, [code.trim().toUpperCase(), shopId]);
  if (!v) throw new HttpError(404, 'Voucher não encontrado nesta barbearia.');
  return withExpiry(v);
}

/** Balcão: dá baixa no voucher. */
export function redeemVoucher(shopId: number, code: string, userId: number): VoucherView {
  return tx(() => {
    const v = findVoucher(shopId, code);
    if (v.status === 'used') throw new HttpError(409, 'Esse voucher já foi usado.');
    if (v.status === 'expired') throw new HttpError(409, 'Esse voucher venceu.');
    run("UPDATE vouchers SET status = 'used', used_at = ?, used_by = ? WHERE id = ?", [nowIso(), userId, v.id]);
    return findVoucher(shopId, code);
  });
}
