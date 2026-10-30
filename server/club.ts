import { charge, chargePayload, confirmCharge, type ChargeView } from './charges.js';
import { shopNow } from './clock.js';
import { shopCardStatus } from './cardSettings.js';
import { issueAccessLink } from './customerAuth.js';
import { all, get, run, tx } from './db.js';
import type { Method } from './finance.js';
import { HttpError } from './http.js';
import { sendMessage, sendsTemplate, type ShopBot } from './messaging.js';
import { addDays, daysBetween } from './time.js';
import { PIX_AUTO_ADVANCE_DAYS, asaasChargePix, cancelAsaasChargeOf, cancelPixAuto, schedulePixAutoCharge } from './shopAsaas.js';

/**
 * Clube de assinatura: o cliente paga um valor por mês e usa os serviços do plano sem pagar na hora,
 * até o limite do mês. No PIX (direto para a barbearia), a mensalidade do mês seguinte sai pelo
 * WhatsApp alguns dias antes de vencer. No cartão automático (Cielo), a Cielo cobra sozinha todo mês,
 * no dia do primeiro pagamento. Sem pagamento, os benefícios ficam pausados.
 */

/** A próxima mensalidade sai alguns dias antes de vencer. */
const ADVANCE_DAYS = 3;
/** Assinatura que nunca foi paga (o cliente desistiu no meio) é cancelada depois de alguns dias. */
const PENDING_DAYS = 7;
/** No cartão automático, a Cielo pode cobrar um pouco depois (e tenta de novo se o cartão recusar). */
const CARD_GRACE_DAYS = 3;

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
  /** Cartão automático (Cielo): ligado, e o último problema (recusa ou falha ao cancelar). */
  card: { active: boolean; error: string | null };
}

/** O assinante paga no cartão automático (a Cielo cobra todo mês). */
export const cardActive = (memberId: number) =>
  Boolean(get("SELECT 1 AS ok FROM card_links WHERE club_member_id = ? AND recurrent = 1 AND status = 'active'", [memberId]));

/**
 * Mês coberto hoje: pago, ou com o PIX avisado pelo cliente (vale enquanto a barbearia confere). No
 * cartão automático, o mês pago vale mais alguns dias, até a Cielo cobrar o seguinte.
 */
function coveringCharge(memberId: number, date: string) {
  const covering = (until: string) =>
    get<{ period_start: string; period_end: string }>(
      `SELECT period_start, period_end FROM charges
        WHERE club_member_id = ? AND period_start <= ? AND period_end >= ? AND (status = 'paid' OR (status = 'open' AND claimed_at IS NOT NULL))
        ORDER BY id DESC LIMIT 1`,
      [memberId, date, until],
    );
  const hit = covering(date);
  return hit || !cardActive(memberId) ? hit : covering(addDays(date, -CARD_GRACE_DAYS));
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
    card: (() => {
      const l = get<{ status: string; error: string | null }>(
        "SELECT status, error FROM card_links WHERE club_member_id = ? AND kind = 'clube' AND status IN ('open', 'active') ORDER BY id DESC LIMIT 1",
        [m.id],
      );
      return { active: l?.status === 'active', error: l?.error ?? null };
    })(),
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

const setBillingDay = (memberId: number, date: string) => run('UPDATE club_members SET billing_day = ? WHERE id = ?', [Math.min(Number(date.slice(8, 10)), 28), memberId]);

/**
 * A Cielo cobrou o cartão do assinante: a mensalidade que esse pagamento paga (a em aberto ou a do
 * mês seguinte). Sem o clube valendo hoje (1º pagamento ou atraso), o mês começa hoje, no dia em que o
 * cartão passou: é nesse dia que a Cielo cobra os próximos. Vale o valor cobrado no cartão (quem
 * assinou no cartão segue no preço da assinatura).
 */
export function chargeForCardPayment(memberId: number, amountCents: number, now: Date): number {
  const m = get<MemberRow & { plan_name: string }>('SELECT m.*, p.name AS plan_name FROM club_members m JOIN club_plans p ON p.id = m.plan_id WHERE m.id = ?', [memberId])!;
  const today = shopNow(m.barbershop_id, now).date;
  const open = get<{ id: number; period_start: string }>("SELECT id, period_start FROM charges WHERE club_member_id = ? AND status = 'open' ORDER BY period_start LIMIT 1", [
    memberId,
  ]);
  const covered = Boolean(get("SELECT 1 AS ok FROM charges WHERE club_member_id = ? AND status = 'paid' AND period_start <= ? AND period_end >= ?", [memberId, today, today]));
  let chargeId: number;
  if (open) {
    chargeId = open.id;
    if (!covered && open.period_start < today) {
      setBillingDay(memberId, today);
      const end = addDays(nextBilling(today, Math.min(Number(today.slice(8, 10)), 28)), -1);
      run('UPDATE charges SET period_start = ?, period_end = ?, due_date = ?, description = ? WHERE id = ?', [
        today,
        end,
        today,
        `${planTitle(m.plan_name)} · ${br(today)} a ${br(end)}`,
        chargeId,
      ]);
    }
  } else {
    const start = m.paid_until && m.paid_until >= today ? addDays(m.paid_until, 1) : today;
    if (start === today) setBillingDay(memberId, today);
    chargeId = createClubCharge(memberId, start, now);
  }
  run('UPDATE charges SET amount_cents = ? WHERE id = ?', [amountCents, chargeId]);
  return chargeId;
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
    const open = all<{ id: number }>("SELECT id FROM charges WHERE club_member_id = ? AND status = 'open' AND claimed_at IS NULL", [memberId]);
    run("UPDATE charges SET status = 'cancelled' WHERE club_member_id = ? AND status = 'open' AND claimed_at IS NULL", [memberId]);
    // No Asaas também: a cobrança em aberto e o débito automático (depois da transação, sem travar).
    queueMicrotask(() => {
      for (const c of open) void cancelAsaasChargeOf(c.id);
      void cancelPixAuto(memberId);
    });
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

/**
 * Manda a mensalidade com o PIX copia e cola (em mensagem separada, fácil de copiar) e, se a barbearia
 * aceita cartão, o link da área do cliente para pagar no cartão.
 */
export async function sendClubCharge(shop: ShopBot, chargeId: number, opts: { late?: boolean; cardFailed?: boolean } = {}): Promise<boolean> {
  const c = charge(chargeId, shop.id);
  if (!c.club_member_id || !c.due_date) return false;
  // Com o Asaas da barbearia, o PIX tem baixa automática (o cliente nem precisa avisar que pagou).
  const auto = await asaasChargePix(c);
  const autoPayload = auto && 'payload' in auto ? auto.payload : null;
  const payload = autoPayload ?? chargePayload(c);
  const area = shopCardStatus(shop.id).available ? issueAccessLink(c.customer_id, shop.slug) : null;
  // Sem chave PIX e sem cartão, a barbearia cobra no balcão.
  if (!payload && !area) return false;
  // Na API oficial fora da janela de 24h só vai o modelo aprovado, que leva o PIX.
  const viaTemplate = sendsTemplate(shop, c.phone);
  if (!payload && viaTemplate) return false;
  const plan = get<{ name: string }>('SELECT p.name FROM club_members m JOIN club_plans p ON p.id = m.plan_id WHERE m.id = ?', [c.club_member_id])!.name;
  const first = firstName(c.customer_name);
  const label = clubLabel(plan);
  const how = payload
    ? `O PIX copia e cola vai na próxima mensagem; ${autoPayload ? 'assim que você pagar, o clube é liberado sozinho.' : 'depois de pagar, é só responder *paguei*.'}${
        area ? `\nPrefere cartão? Pague pela sua área: ${area}` : ''
      }`
    : `Pague com cartão pela sua área: ${area}`;
  const text = opts.cardFailed
    ? `Oi, ${first}! A cobrança da mensalidade do ${label} (${money(c.amount_cents)}) no cartão não passou. Enquanto isso, os benefícios do clube ficam pausados. ${how}`
    : opts.late
      ? `Oi, ${first}! A mensalidade do ${label} (${money(c.amount_cents)}) venceu em ${br(c.due_date)} e o pagamento ainda não apareceu aqui. Enquanto isso, os benefícios do clube ficam pausados. ${how}`
      : `Oi, ${first}! Aqui é o ${shop.bot_name}, da ${shop.name}. 💈 A mensalidade do ${label} (${money(c.amount_cents)}) vence em ${br(c.due_date)}. ${how}`;
  const sentText = await sendMessage({
    shop,
    customerId: c.customer_id,
    phone: c.phone,
    waId: c.wa_id,
    kind: 'assinatura',
    text,
    template: payload ? { kind: 'assinatura', params: [first, label, money(c.amount_cents), br(c.due_date), payload] } : undefined,
  });
  if (sentText.status === 'failed') return false;
  if (payload && !viaTemplate) await sendMessage({ shop, customerId: c.customer_id, phone: c.phone, waId: c.wa_id, kind: 'assinatura', text: payload });
  return true;
}

/** Roda com as automações: próxima mensalidade, lembrete de atraso e limpeza de assinatura nunca paga. */
export async function clubBilling(shop: ShopBot, now: Date): Promise<number> {
  const today = shopNow(shop.id, now).date;
  let sent = 0;

  // Próxima mensalidade de quem está com o mês pago acabando (uma cobrança por vez). No cartão
  // automático quem cobra é a Cielo.
  const withoutNext = `AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.club_member_id = m.id AND (c.status = 'open' OR c.period_start > m.paid_until))`;
  const onCard = `EXISTS (SELECT 1 FROM card_links l WHERE l.club_member_id = m.id AND l.recurrent = 1 AND l.status = 'active')`;
  const renewing = all<{ id: number; paid_until: string }>(
    `SELECT m.id, m.paid_until FROM club_members m
      WHERE m.barbershop_id = ? AND m.status = 'active' AND m.paid_until IS NOT NULL AND m.paid_until <= ? AND NOT ${onCard}
        AND COALESCE(m.pix_auto_status, '') <> 'ACTIVE' ${withoutNext}`,
    [shop.id, addDays(today, ADVANCE_DAYS)],
  );
  for (const m of renewing) {
    const chargeId = createClubCharge(m.id, addDays(m.paid_until, 1), now);
    if (await sendClubCharge(shop, chargeId)) sent++;
  }

  // Pix Automático: a cobrança vai para o Asaas uns dias antes (o banco agenda o débito e ele cai no
  // vencimento). Se o agendamento falhar, a mensalidade sai pelo WhatsApp como sempre.
  const onPixAuto = all<{ id: number; paid_until: string }>(
    `SELECT m.id, m.paid_until FROM club_members m
      WHERE m.barbershop_id = ? AND m.status = 'active' AND m.pix_auto_status = 'ACTIVE' AND m.paid_until IS NOT NULL AND m.paid_until <= ?
        AND NOT ${onCard} ${withoutNext}`,
    [shop.id, addDays(today, PIX_AUTO_ADVANCE_DAYS)],
  );
  for (const m of onPixAuto) {
    const chargeId = createClubCharge(m.id, addDays(m.paid_until, 1), now);
    if (await schedulePixAutoCharge(chargeId)) {
      const c = charge(chargeId, shop.id);
      const r = await sendMessage({
        shop,
        customerId: c.customer_id,
        phone: c.phone,
        waId: c.wa_id,
        kind: 'assinatura',
        text: `Oi, ${firstName(c.customer_name)}! A mensalidade do clube (${money(c.amount_cents)}) vai ser debitada sozinha pelo Pix Automático em ${br(c.due_date!)}. Não precisa fazer nada. 👊`,
      });
      if (r.status !== 'failed') sent++;
    } else if (await sendClubCharge(shop, chargeId)) sent++;
  }

  // Cartão que não passou (a Cielo tenta de novo por alguns dias): depois disso, a mensalidade vai
  // pelo WhatsApp com o PIX (já como lembrete de atraso).
  const cardLate = all<{ id: number; paid_until: string }>(
    `SELECT m.id, m.paid_until FROM club_members m
      WHERE m.barbershop_id = ? AND m.status = 'active' AND m.paid_until IS NOT NULL AND m.paid_until < ? AND ${onCard} ${withoutNext}`,
    [shop.id, addDays(today, -CARD_GRACE_DAYS)],
  );
  for (const m of cardLate) {
    const chargeId = createClubCharge(m.id, addDays(m.paid_until, 1), now);
    run('UPDATE charges SET reminded_at = ? WHERE id = ?', [now.toISOString(), chargeId]);
    if (await sendClubCharge(shop, chargeId, { late: true, cardFailed: true })) sent++;
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
