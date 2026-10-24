import { charge, chargePayload, confirmCharge, type ChargeView } from './charges.js';
import { shopNow } from './clock.js';
import { all, get, run, tx } from './db.js';
import type { Method } from './finance.js';
import { HttpError } from './http.js';
import { sendMessage, sendsTemplate, type ShopBot } from './messaging.js';
import { addDays, daysBetween } from './time.js';

/**
 * Clube de assinatura: o cliente paga um valor por mês (PIX direto para a barbearia) e usa os
 * serviços do plano sem pagar na hora, até o limite do mês. A mensalidade do mês seguinte sai
 * pelo WhatsApp alguns dias antes de vencer; sem pagamento, os benefícios ficam pausados.
 */

/** A próxima mensalidade sai alguns dias antes de vencer. */
const ADVANCE_DAYS = 3;
/** Assinatura que nunca foi paga (o cliente desistiu no meio) é cancelada depois de alguns dias. */
const PENDING_DAYS = 7;

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const firstName = (name: string) => name.split(/\s+/)[0];
/** "Ouro" → "clube Ouro"; "Plano Ouro" e "Clube VIP" ficam como estão. */
export const clubLabel = (planName: string) => (/^(clube|plano)\b/i.test(planName) ? planName : `clube ${planName}`);
const planTitle = (planName: string) => (/^(clube|plano)\b/i.test(planName) ? planName : `Clube ${planName}`);

// ---------- planos

export interface PlanInput {
  name: string;
  description: string | null;
  price_cents: number;
  /** Usos por mês (null = à vontade). */
  uses_per_month: number | null;
  active: boolean;
  item_ids: number[];
}

export interface PlanView {
  id: number;
  name: string;
  description: string | null;
  price_cents: number;
  uses_per_month: number | null;
  active: boolean;
  items: { id: number; name: string; kind: 'service' | 'product'; price_cents: number }[];
  /** Assinantes (sem contar os cancelados). */
  members: number;
}

const planItems = (planId: number) =>
  all<PlanView['items'][number]>(
    'SELECT c.id, c.name, c.kind, c.price_cents FROM club_plan_items i JOIN catalog_items c ON c.id = i.catalog_item_id WHERE i.plan_id = ? ORDER BY c.kind DESC, c.name COLLATE NOCASE',
    [planId],
  );

export function listPlans(shopId: number, opts: { activeOnly?: boolean } = {}): PlanView[] {
  return all<Omit<PlanView, 'items' | 'active'> & { active: number }>(
    `SELECT p.id, p.name, p.description, p.price_cents, p.uses_per_month, p.active,
            (SELECT COUNT(*) FROM club_members m WHERE m.plan_id = p.id AND m.status <> 'cancelled') AS members
       FROM club_plans p WHERE p.barbershop_id = ?${opts.activeOnly ? ' AND p.active = 1' : ''} ORDER BY p.price_cents, p.id`,
    [shopId],
  ).map((p) => ({ ...p, active: Boolean(p.active), items: planItems(p.id) }));
}

export function savePlan(shopId: number, id: number | null, input: PlanInput): PlanView {
  return tx(() => {
    const items = [...new Set(input.item_ids)];
    if (!items.length) throw new HttpError(400, 'Escolha pelo menos um serviço ou produto que o plano inclui.');
    for (const itemId of items) {
      if (!get('SELECT 1 AS ok FROM catalog_items WHERE id = ? AND barbershop_id = ?', [itemId, shopId])) throw new HttpError(404, 'Item do catálogo não encontrado.');
    }
    const values = [input.name, input.description, input.price_cents, input.uses_per_month, input.active ? 1 : 0];
    let planId = id;
    if (planId) {
      const { changes } = run('UPDATE club_plans SET name = ?, description = ?, price_cents = ?, uses_per_month = ?, active = ? WHERE id = ? AND barbershop_id = ?', [
        ...values,
        planId,
        shopId,
      ]);
      if (!changes) throw new HttpError(404, 'Plano não encontrado.');
      run('DELETE FROM club_plan_items WHERE plan_id = ?', [planId]);
    } else {
      planId = run('INSERT INTO club_plans (barbershop_id, name, description, price_cents, uses_per_month, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        shopId,
        ...values,
        new Date().toISOString(),
      ]).lastInsertRowid;
    }
    for (const itemId of items) run('INSERT INTO club_plan_items (plan_id, catalog_item_id) VALUES (?, ?)', [planId, itemId]);
    return listPlans(shopId).find((p) => p.id === planId)!;
  });
}

export function deletePlan(shopId: number, id: number): void {
  if (get('SELECT 1 AS ok FROM club_members WHERE plan_id = ?', [id])) throw new HttpError(409, 'Esse plano já teve assinantes. Desative em vez de excluir.');
  const { changes } = run('DELETE FROM club_plans WHERE id = ? AND barbershop_id = ?', [id, shopId]);
  if (!changes) throw new HttpError(404, 'Plano não encontrado.');
}

// ---------- períodos

const pad = (n: number) => String(n).padStart(2, '0');

/** Próximo dia de cobrança a pelo menos 28 dias de `from` (nenhum mês fica curto demais). */
export function nextBilling(from: string, billingDay: number): string {
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const candidate = `${y}-${pad(m)}-${pad(billingDay)}`;
    if (daysBetween(from, candidate) >= 28) return candidate;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
}

// ---------- assinantes

interface MemberRow {
  id: number;
  barbershop_id: number;
  customer_id: number;
  plan_id: number;
  status: 'pending' | 'active' | 'cancelled';
  billing_day: number;
  paid_until: string | null;
  created_at: string;
  cancelled_at: string | null;
}

export interface MemberView extends MemberRow {
  customer_name: string;
  phone: string;
  plan: { id: number; name: string; price_cents: number; uses_per_month: number | null };
  /** pending: esperando o 1º pagamento · ok: em dia · late: mensalidade atrasada · ending: cancelou, vale até paid_until · ended */
  state: 'pending' | 'ok' | 'late' | 'ending' | 'ended';
  /** Mês em uso hoje (pago ou com pagamento avisado). */
  period: { start: string; end: string } | null;
  used: number;
  open_charge: ChargeView | null;
}

/** Mês coberto hoje: pago, ou com o PIX avisado pelo cliente (vale enquanto a barbearia confere). */
function coveringCharge(memberId: number, date: string) {
  return get<{ period_start: string; period_end: string }>(
    `SELECT period_start, period_end FROM charges
      WHERE club_member_id = ? AND period_start <= ? AND period_end >= ? AND (status = 'paid' OR (status = 'open' AND claimed_at IS NOT NULL))
      ORDER BY id DESC LIMIT 1`,
    [memberId, date, date],
  );
}

const usedIn = (memberId: number, start: string, end: string) =>
  get<{ n: number }>(
    "SELECT COALESCE(SUM(i.qty), 0) AS n FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE i.club_member_id = ? AND s.status = 'closed' AND s.date >= ? AND s.date <= ?",
    [memberId, start, end],
  )!.n;

export function memberView(memberId: number, now: Date = new Date()): MemberView {
  const m = get<MemberRow & { customer_name: string; phone: string; plan_name: string; price_cents: number; uses_per_month: number | null }>(
    `SELECT m.*, c.name AS customer_name, c.phone, p.name AS plan_name, p.price_cents, p.uses_per_month
       FROM club_members m JOIN customers c ON c.id = m.customer_id JOIN club_plans p ON p.id = m.plan_id WHERE m.id = ?`,
    [memberId],
  );
  if (!m) throw new HttpError(404, 'Assinante não encontrado.');
  const { plan_name, price_cents, uses_per_month, ...row } = m;
  const today = shopNow(m.barbershop_id, now).date;
  const cover = coveringCharge(m.id, today);
  const open = get<{ id: number }>("SELECT id FROM charges WHERE club_member_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [m.id]);
  const state: MemberView['state'] =
    m.status === 'cancelled' ? (cover ? 'ending' : 'ended') : m.status === 'pending' ? (cover ? 'ok' : 'pending') : cover ? 'ok' : 'late';
  return {
    ...row,
    plan: { id: m.plan_id, name: plan_name, price_cents, uses_per_month },
    state,
    period: cover ? { start: cover.period_start, end: cover.period_end } : null,
    used: cover ? usedIn(m.id, cover.period_start, cover.period_end) : 0,
    open_charge: open ? charge(open.id) : null,
  };
}

/** A assinatura que vale para o cliente: a ativa (ou pendente), ou a cancelada que ainda tem mês pago. */
function currentMember(customerId: number, today: string): MemberRow | undefined {
  return get<MemberRow>("SELECT * FROM club_members WHERE customer_id = ? AND (status <> 'cancelled' OR paid_until >= ?) ORDER BY id DESC LIMIT 1", [customerId, today]);
}

export function customerMembership(shopId: number, customerId: number, now: Date = new Date()): MemberView | null {
  const m = currentMember(customerId, shopNow(shopId, now).date);
  return m && m.barbershop_id === shopId ? memberView(m.id, now) : null;
}

export function listMembers(shopId: number, now: Date = new Date()): MemberView[] {
  const today = shopNow(shopId, now).date;
  // Cancelados só enquanto o mês pago vale (e mais 30 dias, para o dono ver quem saiu).
  return all<{ id: number }>(
    "SELECT m.id FROM club_members m JOIN customers c ON c.id = m.customer_id WHERE m.barbershop_id = ? AND (m.status <> 'cancelled' OR m.paid_until >= ?) ORDER BY c.name COLLATE NOCASE",
    [shopId, addDays(today, -30)],
  ).map((m) => memberView(m.id, now));
}

function createClubCharge(memberId: number, periodStart: string, now: Date): number {
  const m = get<MemberRow & { plan_name: string; price_cents: number }>(
    'SELECT m.*, p.name AS plan_name, p.price_cents FROM club_members m JOIN club_plans p ON p.id = m.plan_id WHERE m.id = ?',
    [memberId],
  )!;
  const end = addDays(nextBilling(periodStart, m.billing_day), -1);
  return run(
    `INSERT INTO charges (barbershop_id, customer_id, kind, description, amount_cents, club_member_id, period_start, period_end, due_date, created_at)
     VALUES (?, ?, 'clube', ?, ?, ?, ?, ?, ?, ?)`,
    [m.barbershop_id, m.customer_id, `${planTitle(m.plan_name)} · ${br(periodStart)} a ${br(end)}`, m.price_cents, memberId, periodStart, end, periodStart, now.toISOString()],
  ).lastInsertRowid;
}

/**
 * Assina um plano. O primeiro mês começa hoje e já sai a cobrança; com `paidMethod`
 * (pagou no balcão), ela já entra confirmada no caixa.
 */
export function subscribe(shopId: number, customerId: number, planId: number, opts: { now?: Date; userId?: number | null; paidMethod?: Method | null } = {}): MemberView {
  return tx(() => {
    const now = opts.now ?? new Date();
    const today = shopNow(shopId, now).date;
    if (!get('SELECT 1 AS ok FROM club_plans WHERE id = ? AND barbershop_id = ? AND active = 1', [planId, shopId])) throw new HttpError(404, 'Plano não encontrado.');
    if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ? AND anonymized_at IS NULL', [customerId, shopId])) {
      throw new HttpError(404, 'Cliente não encontrado.');
    }
    const current = currentMember(customerId, today);
    if (current && current.status !== 'cancelled') throw new HttpError(409, 'Já é assinante do clube.');
    if (current) {
      // Cancelou, mas o mês pago ainda vale: volta a assinar (a próxima mensalidade sai normalmente).
      run("UPDATE club_members SET status = 'active', cancelled_at = NULL, plan_id = ? WHERE id = ?", [planId, current.id]);
      return memberView(current.id, now);
    }
    const day = Number(today.slice(8, 10));
    const memberId = run("INSERT INTO club_members (barbershop_id, customer_id, plan_id, status, billing_day, created_at) VALUES (?, ?, ?, 'pending', ?, ?)", [
      shopId,
      customerId,
      planId,
      day > 28 ? 1 : day,
      now.toISOString(),
    ]).lastInsertRowid;
    const chargeId = createClubCharge(memberId, today, now);
    if (opts.paidMethod) confirmCharge(shopId, chargeId, { method: opts.paidMethod, userId: opts.userId ?? null, now });
    return memberView(memberId, now);
  });
}

/** Cancela: o mês já pago continua valendo; mensalidade em aberto (não avisada) é cancelada. */
export function cancelMembership(shopId: number, memberId: number, now: Date = new Date()): MemberView {
  return tx(() => {
    const m = get<MemberRow>('SELECT * FROM club_members WHERE id = ? AND barbershop_id = ?', [memberId, shopId]);
    if (!m) throw new HttpError(404, 'Assinatura não encontrada.');
    if (m.status === 'cancelled') throw new HttpError(409, 'Essa assinatura já foi cancelada.');
    run("UPDATE club_members SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [now.toISOString(), memberId]);
    run("UPDATE charges SET status = 'cancelled' WHERE club_member_id = ? AND status = 'open' AND claimed_at IS NULL", [memberId]);
    return memberView(memberId, now);
  });
}

// ---------- uso no balcão

export interface ClubCoverage {
  memberId: number;
  plan: string;
  itemIds: number[];
  /** Limite do mês (null = à vontade). */
  limit: number | null;
  used: number;
  /** Quantos usos ainda tem no mês (null = à vontade). */
  left: number | null;
  periodEnd: string;
  /** % do preço normal que vira base da comissão do barbeiro. */
  commissionPct: number;
}

/** O que o clube cobre hoje para este cliente (null = não é assinante ou está com a mensalidade atrasada). */
export function clubCoverage(shopId: number, customerId: number, date: string): ClubCoverage | null {
  const m = currentMember(customerId, date);
  if (!m || m.barbershop_id !== shopId) return null;
  const cover = coveringCharge(m.id, date);
  if (!cover) return null;
  const plan = get<{ name: string; uses_per_month: number | null }>('SELECT name, uses_per_month FROM club_plans WHERE id = ?', [m.plan_id])!;
  const used = usedIn(m.id, cover.period_start, cover.period_end);
  return {
    memberId: m.id,
    plan: plan.name,
    itemIds: planItems(m.plan_id).map((i) => i.id),
    limit: plan.uses_per_month,
    used,
    left: plan.uses_per_month == null ? null : Math.max(0, plan.uses_per_month - used),
    periodEnd: cover.period_end,
    commissionPct: get<{ club_commission_pct: number }>('SELECT club_commission_pct FROM barbershops WHERE id = ?', [shopId])!.club_commission_pct,
  };
}

// ---------- cobrança pelo WhatsApp

/** Manda a mensalidade com o PIX copia e cola (em mensagem separada, fácil de copiar). */
export async function sendClubCharge(shop: ShopBot, chargeId: number, opts: { late?: boolean } = {}): Promise<boolean> {
  const c = charge(chargeId, shop.id);
  const payload = chargePayload(c);
  // Sem chave PIX cadastrada, a barbearia cobra no balcão.
  if (!payload || !c.club_member_id || !c.due_date) return false;
  const plan = get<{ name: string }>('SELECT p.name FROM club_members m JOIN club_plans p ON p.id = m.plan_id WHERE m.id = ?', [c.club_member_id])!.name;
  const first = firstName(c.customer_name);
  const label = clubLabel(plan);
  const text = opts.late
    ? `Oi, ${first}! A mensalidade do ${label} (${money(c.amount_cents)}) venceu em ${br(c.due_date)} e o pagamento ainda não apareceu aqui. Enquanto isso, os benefícios do clube ficam pausados. O PIX copia e cola vai na próxima mensagem; depois de pagar, é só responder *paguei*.`
    : `Oi, ${first}! Aqui é o ${shop.bot_name}, da ${shop.name}. A mensalidade do ${label} (${money(c.amount_cents)}) vence em ${br(c.due_date)}. O PIX copia e cola vai na próxima mensagem; depois de pagar, é só responder *paguei*. 💈`;
  // Na API oficial fora da janela de 24h só vai o modelo aprovado, que já leva o PIX.
  const viaTemplate = sendsTemplate(shop, c.phone);
  const sentText = await sendMessage({
    shop,
    customerId: c.customer_id,
    phone: c.phone,
    waId: c.wa_id,
    kind: 'assinatura',
    text,
    template: { kind: 'assinatura', params: [first, label, money(c.amount_cents), br(c.due_date), payload] },
  });
  if (sentText.status === 'failed') return false;
  if (!viaTemplate) await sendMessage({ shop, customerId: c.customer_id, phone: c.phone, waId: c.wa_id, kind: 'assinatura', text: payload });
  return true;
}

/** Roda com as automações: próxima mensalidade, lembrete de atraso e limpeza de assinatura nunca paga. */
export async function clubBilling(shop: ShopBot, now: Date): Promise<number> {
  const today = shopNow(shop.id, now).date;
  let sent = 0;

  // Próxima mensalidade de quem está com o mês pago acabando (uma cobrança por vez).
  const renewing = all<{ id: number; paid_until: string }>(
    `SELECT m.id, m.paid_until FROM club_members m
      WHERE m.barbershop_id = ? AND m.status = 'active' AND m.paid_until IS NOT NULL AND m.paid_until <= ?
        AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.club_member_id = m.id AND (c.status = 'open' OR c.period_start > m.paid_until))`,
    [shop.id, addDays(today, ADVANCE_DAYS)],
  );
  for (const m of renewing) {
    const chargeId = createClubCharge(m.id, addDays(m.paid_until, 1), now);
    if (await sendClubCharge(shop, chargeId)) sent++;
  }

  // Venceu e o cliente não avisou que pagou: um lembrete só.
  const late = all<{ id: number }>(
    "SELECT id FROM charges WHERE barbershop_id = ? AND kind = 'clube' AND status = 'open' AND claimed_at IS NULL AND reminded_at IS NULL AND due_date < ?",
    [shop.id, today],
  );
  for (const c of late) {
    run('UPDATE charges SET reminded_at = ? WHERE id = ?', [now.toISOString(), c.id]);
    if (await sendClubCharge(shop, c.id, { late: true })) sent++;
  }

  // Assinou e nunca pagou nem avisou: some depois de alguns dias.
  const stale = all<{ id: number }>(
    `SELECT m.id FROM club_members m WHERE m.barbershop_id = ? AND m.status = 'pending' AND m.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.club_member_id = m.id AND (c.claimed_at IS NOT NULL OR c.status = 'paid'))`,
    [shop.id, new Date(now.getTime() - PENDING_DAYS * 86400000).toISOString()],
  );
  for (const m of stale) {
    run("UPDATE club_members SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [now.toISOString(), m.id]);
    run("UPDATE charges SET status = 'cancelled' WHERE club_member_id = ? AND status = 'open'", [m.id]);
  }
  return sent;
}

// ---------- painel

export function clubOverview(shopId: number, now: Date = new Date()) {
  const members = listMembers(shopId, now);
  const paying = members.filter((m) => m.status !== 'cancelled' && m.state !== 'pending');
  return {
    settings: get<{ pix_key: string | null; pix_name: string | null; pix_city: string | null; club_commission_pct: number }>(
      'SELECT pix_key, pix_name, pix_city, club_commission_pct FROM barbershops WHERE id = ?',
      [shopId],
    )!,
    plans: listPlans(shopId),
    members,
    /** Receita mensal prevista: quem está assinando e já pagou ao menos uma vez. */
    monthly_cents: paying.reduce((t, m) => t + m.plan.price_cents, 0),
    active: paying.length,
  };
}
