import crypto from 'node:crypto';
import { shopNow } from './clock.js';
import { all, get, run, tx } from './db.js';
import { createSale, normalizeGiftCode, type Method, type SaleResult } from './finance.js';
import { HttpError } from './http.js';
import { addDays } from './time.js';

/**
 * Pacotes pré-pagos e vale-presente.
 * - Pacote: o cliente paga, por exemplo, 5 cortes de uma vez (mais barato) e usa quando vier; na comanda
 *   o serviço sai por R$ 0 "pelo pacote" e o barbeiro recebe a comissão sobre o valor de cada uso.
 * - Vale-presente: alguém compra um valor (ex.: R$ 100) para presentear; o código paga atendimentos e
 *   produtos até acabar o saldo. O dinheiro entra no caixa quando o pacote ou o vale é vendido.
 */

export const PREPAID_CATEGORY = 'Pacotes e vale-presente';

export interface CustomerPackage {
  id: number;
  name: string;
  service_id: number;
  service_name: string | null;
  uses: number;
  used: number;
  left: number;
  price_cents: number;
  expires_on: string;
  status: 'active' | 'used' | 'expired' | 'cancelled';
  created_at: string;
}

const PACKAGE_SELECT = `SELECT p.id, p.name, p.service_id, s.name AS service_name, p.uses, p.used, p.uses - p.used AS left, p.price_cents, p.expires_on, p.status, p.created_at
                          FROM customer_packages p LEFT JOIN catalog_items s ON s.id = p.service_id`;

/** Vence os pacotes e vales que passaram da validade (chamado ao consultar). */
function expire(shopId: number, today: string): void {
  run("UPDATE customer_packages SET status = 'expired' WHERE barbershop_id = ? AND status = 'active' AND expires_on < ?", [shopId, today]);
  run("UPDATE gift_cards SET status = 'expired' WHERE barbershop_id = ? AND status = 'active' AND expires_on < ?", [shopId, today]);
}

/** Pacotes do cliente (ativos primeiro). */
export function customerPackages(shopId: number, customerId: number, opts: { activeOnly?: boolean; now?: Date } = {}): CustomerPackage[] {
  expire(shopId, shopNow(shopId, opts.now).date);
  return all<CustomerPackage>(
    `${PACKAGE_SELECT} WHERE p.barbershop_id = ? AND p.customer_id = ?${opts.activeOnly ? " AND p.status = 'active'" : ''}
      ORDER BY p.status = 'active' DESC, p.expires_on, p.id DESC LIMIT 20`,
    [shopId, customerId],
  );
}

/** Vende um pacote no balcão: entra no caixa e os usos ficam com o cliente. */
export function sellPackage(input: { shopId: number; customerId: number; packageId: number; method: Method; userId: number | null; now?: Date }): { sale: SaleResult; package: CustomerPackage } {
  return tx(() => {
    const p = get<{ id: number; name: string; service_id: number; uses: number; price_cents: number; valid_days: number; active: number }>(
      'SELECT id, name, service_id, uses, price_cents, valid_days, active FROM packages WHERE id = ? AND barbershop_id = ?',
      [input.packageId, input.shopId],
    );
    if (!p || !p.active) throw new HttpError(404, 'Pacote não encontrado.');
    if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ? AND anonymized_at IS NULL', [input.customerId, input.shopId])) {
      throw new HttpError(404, 'Cliente não encontrado.');
    }
    const sale = createSale({
      shopId: input.shopId,
      userId: input.userId,
      customerId: input.customerId,
      items: [{ name: `Pacote: ${p.name}`, kind: 'product', qty: 1, unit_price_cents: p.price_cents }],
      method: input.method,
      category: PREPAID_CATEGORY,
      now: input.now,
    });
    const today = shopNow(input.shopId, input.now).date;
    const id = run(
      `INSERT INTO customer_packages (barbershop_id, customer_id, package_id, name, service_id, uses, price_cents, expires_on, sale_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.shopId, input.customerId, p.id, p.name, p.service_id, p.uses, p.price_cents, addDays(today, p.valid_days), sale.sale.id, (input.now ?? new Date()).toISOString()],
    ).lastInsertRowid;
    return { sale, package: get<CustomerPackage>(`${PACKAGE_SELECT} WHERE p.id = ?`, [id])! };
  });
}

/** Valor de cada uso do pacote (a comissão do barbeiro é sobre ele). */
export const perUse = (p: { price_cents: number; uses: number }) => Math.round(p.price_cents / p.uses);

// ---------- vale-presente

export interface GiftCard {
  id: number;
  code: string;
  amount_cents: number;
  balance_cents: number;
  buyer_name: string | null;
  recipient_name: string | null;
  message: string | null;
  expires_on: string;
  status: 'active' | 'used' | 'expired' | 'cancelled';
  created_at: string;
}

const GIFT_SELECT = 'SELECT id, code, amount_cents, balance_cents, buyer_name, recipient_name, message, expires_on, status, created_at FROM gift_cards';
/** Sem 0/O e 1/I (ditado por telefone sem confusão). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => `VP-${Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')}`;

export function sellGiftCard(input: {
  shopId: number;
  amountCents: number;
  validDays: number;
  buyerName: string | null;
  recipientName: string | null;
  message: string | null;
  buyerCustomerId?: number | null;
  method: Method;
  userId: number | null;
  now?: Date;
}): { sale: SaleResult; card: GiftCard } {
  return tx(() => {
    if (input.amountCents < 1000 || input.amountCents > 500000) throw new HttpError(400, 'Vale-presente de R$ 10 a R$ 5.000.');
    let code = newCode();
    while (get('SELECT 1 AS ok FROM gift_cards WHERE code = ?', [code])) code = newCode();
    const sale = createSale({
      shopId: input.shopId,
      userId: input.userId,
      customerId: input.buyerCustomerId ?? null,
      items: [{ name: `Vale-presente ${code}`, kind: 'product', qty: 1, unit_price_cents: input.amountCents }],
      method: input.method,
      category: PREPAID_CATEGORY,
      now: input.now,
    });
    const today = shopNow(input.shopId, input.now).date;
    const id = run(
      `INSERT INTO gift_cards (barbershop_id, code, amount_cents, balance_cents, buyer_name, recipient_name, message, expires_on, sale_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.shopId,
        code,
        input.amountCents,
        input.amountCents,
        input.buyerName,
        input.recipientName,
        input.message,
        addDays(today, input.validDays),
        sale.sale.id,
        (input.now ?? new Date()).toISOString(),
      ],
    ).lastInsertRowid;
    return { sale, card: get<GiftCard>(`${GIFT_SELECT} WHERE id = ?`, [id])! };
  });
}

/** O vale pelo código (para conferir o saldo no balcão). */
export function giftCardByCode(shopId: number, code: string, now?: Date): GiftCard {
  expire(shopId, shopNow(shopId, now).date);
  const card = get<GiftCard>(`${GIFT_SELECT} WHERE barbershop_id = ? AND code = ?`, [shopId, normalizeGiftCode(code)]);
  if (!card) throw new HttpError(404, 'Vale-presente não encontrado. Confira o código.');
  return card;
}

export function shopGiftCards(shopId: number, now?: Date): GiftCard[] {
  expire(shopId, shopNow(shopId, now).date);
  return all<GiftCard>(`${GIFT_SELECT} WHERE barbershop_id = ? ORDER BY status = 'active' DESC, id DESC LIMIT 200`, [shopId]);
}

/** Pacotes vendidos (os ativos primeiro), com o cliente. */
export function shopPackages(shopId: number, now?: Date) {
  expire(shopId, shopNow(shopId, now).date);
  return all<CustomerPackage & { customer_id: number; customer_name: string; customer_phone: string }>(
    `SELECT p.id, p.name, p.service_id, s.name AS service_name, p.uses, p.used, p.uses - p.used AS left, p.price_cents, p.expires_on, p.status, p.created_at,
            c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone
       FROM customer_packages p JOIN customers c ON c.id = p.customer_id LEFT JOIN catalog_items s ON s.id = p.service_id
      WHERE p.barbershop_id = ? ORDER BY p.status = 'active' DESC, p.id DESC LIMIT 200`,
    [shopId],
  );
}
