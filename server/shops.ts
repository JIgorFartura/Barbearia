import { z } from 'zod';
import { platformSettings } from './billing.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { addDays, localNow } from './time.js';

/**
 * Cadastro de barbearias (unidades): pelo master, pelo próprio dono (cadastro com teste grátis) e pelo
 * dono que abre mais uma unidade da rede. Um dono pode ter várias unidades: a primeira é a "casa" dele
 * (users.barbershop_id) e as outras ficam em shop_members; no painel ele troca de unidade.
 */

export const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'Endereço só com letras minúsculas, números e hífen (ex.: barbearia-do-ze).');

export function assertFreePhone(phone: string | null, exceptId = 0): void {
  if (phone && get('SELECT 1 AS ok FROM users WHERE phone = ? AND id <> ?', [phone, exceptId])) throw new HttpError(409, 'Esse celular já está em outro login.');
}

export function assertFreeSlug(slug: string, exceptId = 0): void {
  if (get('SELECT 1 AS ok FROM barbershops WHERE slug = ? AND id <> ?', [slug, exceptId])) {
    throw new HttpError(409, 'Esse endereço já é usado por outra barbearia.');
  }
}

export function assertFreeEmail(email: string): void {
  if (get('SELECT 1 AS ok FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Já existe um usuário com esse e-mail.');
}

/** "Barbearia do Zé – Centro" → "barbearia-do-ze-centro" (com número no fim se já existir). */
export function suggestSlug(name: string): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'barbearia';
  let slug = base.length < 3 ? `${base}-barbearia` : base;
  for (let i = 2; get('SELECT 1 AS ok FROM barbershops WHERE slug = ?', [slug]); i++) slug = `${base}-${i}`;
  return slug;
}

/** Cria a barbearia (com os dias grátis da plataforma, se não vier outro prazo). Quem chama cuida da transação. */
export function createShop(input: { name: string; slug: string; planId?: number | null; monthlyPriceCents?: number | null; billingDay?: number; trialDays?: number | null; copyFrom?: number | null }): number {
  assertFreeSlug(input.slug);
  const trialDays = input.trialDays ?? platformSettings().trial_days;
  const trialUntil = trialDays > 0 ? addDays(localNow().date, trialDays) : null;
  // Unidade nova de uma rede: herda o plano, as cores e o fuso da unidade de origem.
  const from = input.copyFrom
    ? get<{ plan_id: number | null; primary_color: string; accent_color: string; timezone: string | null; bot_name: string }>(
        'SELECT plan_id, primary_color, accent_color, timezone, bot_name FROM barbershops WHERE id = ?',
        [input.copyFrom],
      )
    : undefined;
  const id = run('INSERT INTO barbershops (slug, name, plan_id, monthly_price_cents, billing_day, trial_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    input.slug,
    input.name,
    input.planId ?? from?.plan_id ?? null,
    input.monthlyPriceCents ?? null,
    input.billingDay ?? 10,
    trialUntil,
    nowIso(),
  ]).lastInsertRowid;
  if (from) {
    run('UPDATE barbershops SET primary_color = ?, accent_color = ?, timezone = ?, bot_name = ? WHERE id = ?', [from.primary_color, from.accent_color, from.timezone, from.bot_name, id]);
  }
  return id;
}

// ---------- redes: um dono, várias unidades

export interface Unit {
  id: number;
  name: string;
  slug: string;
  active: number;
}

/** Unidades do dono: a casa dele e as ligadas a ele. */
export function ownerUnits(userId: number): Unit[] {
  return all<Unit>(
    `SELECT s.id, s.name, s.slug, s.active FROM barbershops s
      WHERE s.id = (SELECT barbershop_id FROM users WHERE id = :u AND role = 'owner')
         OR s.id IN (SELECT barbershop_id FROM shop_members WHERE user_id = :u)
      ORDER BY s.name COLLATE NOCASE`,
    { u: userId },
  );
}

export const isUnitOf = (userId: number, shopId: number) => ownerUnits(userId).some((u) => u.id === shopId);

export function linkOwner(userId: number, shopId: number): void {
  run('INSERT OR IGNORE INTO shop_members (user_id, barbershop_id, created_at) VALUES (?, ?, ?)', [userId, shopId, nowIso()]);
}

/** Donos de uma unidade (a casa deles ou ligados a ela): avisos, resumo da semana, notificações. */
export const shopOwnerIds = (shopId: number) =>
  all<{ id: number }>(
    "SELECT id FROM users WHERE role = 'owner' AND (barbershop_id = :s OR id IN (SELECT user_id FROM shop_members WHERE barbershop_id = :s))",
    { s: shopId },
  ).map((u) => u.id);
