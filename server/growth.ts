import crypto from 'node:crypto';
import { shopNow } from './clock.js';
import { config } from './config.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { sendMessage, shopBot, type ShopBot } from './messaging.js';
import { issueVoucher, type VoucherView } from './offers.js';
import { addDays } from './time.js';

/**
 * Indique um amigo e presente de aniversário. Os prêmios são vouchers de benefícios "só prêmio"
 * (não aparecem para o cliente pegar), validados no balcão como qualquer voucher.
 * Indicação: o amigo entra pelo link de quem indicou (e pode ganhar um presente de boas-vindas);
 * quem indicou ganha o prêmio quando o amigo vem pela primeira vez (venda fechada).
 */

export interface RewardInput {
  title: string;
  valid_days: number;
}

interface RewardRow {
  id: number;
  title: string;
  valid_days: number;
  ends_on: string | null;
}

interface GrowthRow {
  referral_enabled: number;
  referral_friend_offer_id: number | null;
  referral_reward_offer_id: number | null;
  birthday_enabled: number;
  birthday_offer_id: number | null;
}

const firstName = (name: string) => name.split(/\s+/)[0];
const br = (date: string) => date.split('-').reverse().join('/');

const reward = (offerId: number | null) => (offerId ? (get<RewardRow>('SELECT id, title, valid_days, ends_on FROM offers WHERE id = ?', [offerId]) ?? null) : null);
const growthRow = (shopId: number) =>
  get<GrowthRow>('SELECT referral_enabled, referral_friend_offer_id, referral_reward_offer_id, birthday_enabled, birthday_offer_id FROM barbershops WHERE id = ?', [shopId])!;

export function growthSettings(shopId: number) {
  const g = growthRow(shopId);
  const view = (offerId: number | null) => {
    const r = reward(offerId);
    return r ? { title: r.title, valid_days: r.valid_days } : null;
  };
  return {
    referral_enabled: Boolean(g.referral_enabled),
    friend_reward: view(g.referral_friend_offer_id),
    referrer_reward: view(g.referral_reward_offer_id),
    birthday_enabled: Boolean(g.birthday_enabled),
    birthday_reward: view(g.birthday_offer_id),
  };
}

/** Cria ou atualiza o benefício "só prêmio" por trás de cada presente. */
function upsertReward(shopId: number, currentId: number | null, r: RewardInput | null, description: string): number | null {
  if (!r) return null;
  if (currentId && get('SELECT 1 AS ok FROM offers WHERE id = ? AND barbershop_id = ?', [currentId, shopId])) {
    run('UPDATE offers SET title = ?, valid_days = ?, active = 1 WHERE id = ?', [r.title, r.valid_days, currentId]);
    return currentId;
  }
  return run(
    'INSERT INTO offers (barbershop_id, title, description, valid_days, per_customer, active, reward_only, created_at) VALUES (?, ?, ?, ?, 1, 1, 1, ?)',
    [shopId, r.title, description, r.valid_days, nowIso()],
  ).lastInsertRowid;
}

export function saveGrowthSettings(
  shopId: number,
  s: { referral_enabled: boolean; friend_reward: RewardInput | null; referrer_reward: RewardInput | null; birthday_enabled: boolean; birthday_reward: RewardInput | null },
) {
  if (s.referral_enabled && !s.referrer_reward) throw new HttpError(400, 'Diga o que quem indica ganha quando o amigo vier.');
  if (s.birthday_enabled && !s.birthday_reward) throw new HttpError(400, 'Diga qual é o presente de aniversário.');
  return tx(() => {
    const g = growthRow(shopId);
    run('UPDATE barbershops SET referral_enabled = ?, referral_friend_offer_id = ?, referral_reward_offer_id = ?, birthday_enabled = ?, birthday_offer_id = ? WHERE id = ?', [
      s.referral_enabled ? 1 : 0,
      upsertReward(shopId, g.referral_friend_offer_id, s.friend_reward, 'Presente de boas-vindas para quem veio por indicação.'),
      upsertReward(shopId, g.referral_reward_offer_id, s.referrer_reward, 'Prêmio por indicar um amigo.'),
      s.birthday_enabled ? 1 : 0,
      upsertReward(shopId, g.birthday_offer_id, s.birthday_reward, 'Presente de aniversário.'),
      shopId,
    ]);
    return growthSettings(shopId);
  });
}

// ---------- indicação

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Código de indicação do cliente (nome + 3 letras), criado na primeira vez que ele precisa. */
export function referralCode(customerId: number): string {
  const c = get<{ barbershop_id: number; name: string; referral_code: string | null }>('SELECT barbershop_id, name, referral_code FROM customers WHERE id = ?', [customerId]);
  if (!c) throw new HttpError(404, 'Cliente não encontrado.');
  if (c.referral_code) return c.referral_code;
  const base =
    firstName(c.name)
      .normalize('NFD')
      .replace(/[^A-Za-z]/g, '')
      .toUpperCase()
      .slice(0, 6) || 'AMIGO';
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = '';
    for (let i = 0; i < 3; i++) suffix += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    const code = `${base}${suffix}`;
    if (get('SELECT 1 AS ok FROM customers WHERE barbershop_id = ? AND referral_code = ?', [c.barbershop_id, code])) continue;
    run('UPDATE customers SET referral_code = ? WHERE id = ?', [code, customerId]);
    return code;
  }
  throw new HttpError(500, 'Não foi possível gerar o código de indicação.');
}

export const referralLink = (slug: string, code: string) => `${config.appUrl}/b/${slug}/conta?indicacao=${code}`;

/** Quem é o dono deste código (para mostrar "João te indicou"). */
export function referrerByCode(shopId: number, code: string) {
  if (!growthRow(shopId).referral_enabled) return null;
  return get<{ id: number; name: string }>('SELECT id, name FROM customers WHERE barbershop_id = ? AND referral_code = ? AND anonymized_at IS NULL', [
    shopId,
    code.trim().toUpperCase(),
  ]) ?? null;
}

/** Cliente novo veio por indicação: guarda quem indicou (só na criação da conta). */
export function setReferrer(shopId: number, customerId: number, code: string | null | undefined): boolean {
  if (!code) return false;
  const ref = referrerByCode(shopId, code);
  if (!ref || ref.id === customerId) return false;
  run('UPDATE customers SET referred_by = ? WHERE id = ? AND referred_by IS NULL', [ref.id, customerId]);
  return true;
}

/** Presente de boas-vindas do amigo indicado (uma vez, depois que ele confirmou o celular). */
export function welcomeReferred(shopId: number, customerId: number): VoucherView | null {
  const c = get<{ referred_by: number | null }>('SELECT referred_by FROM customers WHERE id = ?', [customerId]);
  const g = growthRow(shopId);
  const gift = reward(g.referral_friend_offer_id);
  if (!c?.referred_by || !g.referral_enabled || !gift) return null;
  if (get('SELECT 1 AS ok FROM vouchers WHERE offer_id = ? AND customer_id = ?', [gift.id, customerId])) return null;
  return issueVoucher(shopId, gift, customerId);
}

/**
 * Primeira visita paga de quem veio indicado: quem indicou ganha o prêmio e recebe pelo WhatsApp.
 * Chamado ao fechar uma venda (dentro da transação); a mensagem sai depois, sem travar a venda.
 */
export function rewardReferrer(shopId: number, customerId: number): VoucherView | null {
  const c = get<{ name: string; referred_by: number | null; referral_rewarded_at: string | null }>('SELECT name, referred_by, referral_rewarded_at FROM customers WHERE id = ?', [
    customerId,
  ]);
  const g = growthRow(shopId);
  const prize = reward(g.referral_reward_offer_id);
  if (!c?.referred_by || c.referral_rewarded_at || !g.referral_enabled || !prize) return null;
  const referrer = get<{ id: number; name: string; phone: string; wa_id: string | null; anonymized_at: string | null }>(
    'SELECT id, name, phone, wa_id, anonymized_at FROM customers WHERE id = ?',
    [c.referred_by],
  );
  run('UPDATE customers SET referral_rewarded_at = ? WHERE id = ?', [nowIso(), customerId]);
  if (!referrer || referrer.anonymized_at) return null;
  const v = issueVoucher(shopId, prize, referrer.id);
  const shop = shopBot(shopId);
  void sendMessage({
    shop,
    customerId: referrer.id,
    phone: referrer.phone,
    waId: referrer.wa_id,
    kind: 'indicacao',
    text: `Oi, ${firstName(referrer.name)}! ${firstName(c.name)} veio à ${shop.name} por indicação sua. 🙌 Seu prêmio: ${prize.title}. Mostre o código *${v.code}* no balcão até ${br(v.expires_on)}.`,
    template: { kind: 'indicacao', params: [firstName(referrer.name), firstName(c.name), shop.name, prize.title, v.code, br(v.expires_on)] },
  });
  return v;
}

/** Área do cliente: link, presente do amigo e quantos amigos já vieram. */
export function customerReferral(shopId: number, customerId: number) {
  const g = growthRow(shopId);
  if (!g.referral_enabled) return null;
  const slug = get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [shopId])!.slug;
  const code = referralCode(customerId);
  const counts = get<{ joined: number; came: number }>(
    'SELECT COUNT(*) AS joined, COUNT(referral_rewarded_at) AS came FROM customers WHERE referred_by = ?',
    [customerId],
  )!;
  return {
    code,
    link: referralLink(slug, code),
    friend_gift: reward(g.referral_friend_offer_id)?.title ?? null,
    my_prize: reward(g.referral_reward_offer_id)?.title ?? null,
    ...counts,
  };
}

/** Painel: indicações recentes. */
export function referralsOverview(shopId: number) {
  return all<{ friend: string; referrer: string; joined_at: string; rewarded_at: string | null }>(
    `SELECT f.name AS friend, r.name AS referrer, f.created_at AS joined_at, f.referral_rewarded_at AS rewarded_at
       FROM customers f JOIN customers r ON r.id = f.referred_by
      WHERE f.barbershop_id = ? ORDER BY f.id DESC LIMIT 50`,
    [shopId],
  );
}

// ---------- aniversário

/** "MM-DD" do aniversário a partir de dia e mês. */
export function birthdayKey(day: number, month: number): string | null {
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Manda o presente no dia do aniversário (de manhã, uma vez por ano). Quem nasceu em 29/02 ganha em 28/02 nos outros anos. */
export async function birthdayGifts(shop: ShopBot, now: Date): Promise<number> {
  const g = growthRow(shop.id);
  const gift = reward(g.birthday_offer_id);
  if (!g.birthday_enabled || !gift) return 0;
  const today = shopNow(shop.id, now).date;
  const year = Number(today.slice(0, 4));
  const keys = [today.slice(5)];
  if (today.slice(5) === '02-28' && !isLeap(year)) keys.push('02-29');
  const due = all<{ id: number; name: string; phone: string; wa_id: string | null }>(
    `SELECT id, name, phone, wa_id FROM customers
      WHERE barbershop_id = ? AND substr(birth_date, -5) IN (${keys.map(() => '?').join(', ')})
        AND (birthday_sent_year IS NULL OR birthday_sent_year < ?) AND reminders_opt_out = 0 AND anonymized_at IS NULL`,
    [shop.id, ...keys, year],
  );
  let sent = 0;
  for (const c of due) {
    run('UPDATE customers SET birthday_sent_year = ? WHERE id = ?', [year, c.id]);
    const v = issueVoucher(shop.id, gift, c.id, today);
    const r = await sendMessage({
      shop,
      customerId: c.id,
      phone: c.phone,
      waId: c.wa_id,
      kind: 'aniversario',
      text: `Feliz aniversário, ${firstName(c.name)}! 🎉 A ${shop.name} preparou um presente pra você: ${gift.title}. Mostre o código *${v.code}* no balcão até ${br(v.expires_on)}.`,
      template: { kind: 'aniversario', params: [firstName(c.name), shop.name, gift.title, v.code, br(v.expires_on)] },
    });
    if (r.status !== 'failed') sent++;
  }
  return sent;
}

/** Painel: aniversariantes dos próximos 30 dias. */
export function upcomingBirthdays(shopId: number, now: Date = new Date()) {
  const today = shopNow(shopId, now).date;
  const keys = Array.from({ length: 31 }, (_, i) => addDays(today, i).slice(5));
  const rows = all<{ id: number; name: string; phone: string; birth_date: string }>(
    `SELECT id, name, phone, birth_date FROM customers WHERE barbershop_id = ? AND anonymized_at IS NULL AND birth_date IS NOT NULL AND substr(birth_date, -5) IN (${keys
      .map(() => '?')
      .join(', ')})`,
    [shopId, ...keys],
  );
  const order = (b: string) => keys.indexOf(b.slice(-5));
  return {
    registered: get<{ n: number }>('SELECT COUNT(*) AS n FROM customers WHERE barbershop_id = ? AND birth_date IS NOT NULL AND anonymized_at IS NULL', [shopId])!.n,
    upcoming: rows.sort((a, b) => order(a.birth_date) - order(b.birth_date)).map((r) => ({ ...r, day: r.birth_date.slice(-5) })),
  };
}
