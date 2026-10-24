import { asaasEnabled, asaasSettings, cancelAsaasCharge, issueNfse } from './asaas.js';
import { markInvoicePaid, monthlyPrice, nextMonthlyInvoice, shopBilling } from './billing.js';
import {
  markCieloSeen,
  platformCardReady,
  platformCielo,
  platformCieloCreds,
  receiverByToken,
  shopCardStatus,
  shopCielo,
  shopCieloCreds,
  type CardReceiver,
} from './cardSettings.js';
import { charge, confirmCharge } from './charges.js';
import {
  CieloError,
  cieloCall,
  cieloMethod,
  cieloStatus,
  createLink,
  deactivateRecurrence,
  deleteLink,
  getOrder,
  linkOrders,
  pick,
  type CardStatus,
  type CieloCredentials,
} from './cielo.js';
import { chargeForCardPayment } from './club.js';
import { shopNow } from './clock.js';
import { all, get, nowIso, run, tx } from './db.js';
import type { Method } from './finance.js';
import { gatewayPayment, upsertCardPayment } from './gatewayPayments.js';
import { HttpError } from './http.js';
import { addDays, localNow } from './time.js';

/**
 * Cartão pela Cielo: a mensalidade do sistema (a barbearia paga a plataforma, no cartão automático) e,
 * dos clientes, o clube (cartão automático) e o sinal (avulso). O dinheiro cai na conta Cielo de quem
 * recebe. A baixa é automática pelo aviso da Cielo, sempre conferido na própria Cielo.
 */

export interface CardLink {
  id: number;
  receiver: 'platform' | 'shop';
  barbershop_id: number;
  kind: 'mensalidade' | 'clube' | 'sinal';
  recurrent: number;
  link_id: string;
  sku: string;
  url: string;
  amount_cents: number;
  charge_id: number | null;
  club_member_id: number | null;
  status: 'open' | 'active' | 'paid' | 'cancelled';
  recurrent_payment_id: string | null;
  last_paid_at: string | null;
  error: string | null;
  checked_at: string | null;
  created_at: string;
  cancelled_at: string | null;
}

const cardLink = (id: number) => get<CardLink>('SELECT * FROM card_links WHERE id = ?', [id])!;
/** Link ainda não usado (um cartão recusado pode deixar o link de uso único sem valer): dá para mandar de novo. */
const reusable = (l: CardLink | undefined, amountCents: number): l is CardLink =>
  Boolean(l && l.status === 'open' && l.amount_cents === amountCents && !get('SELECT 1 AS ok FROM gateway_payments WHERE card_link_id = ?', [l.id]));
const credsOf = (l: Pick<CardLink, 'receiver' | 'barbershop_id'>): CieloCredentials | null =>
  l.receiver === 'platform' ? platformCieloCreds() : shopCieloCreds(l.barbershop_id);
const feeOf = (l: Pick<CardLink, 'receiver' | 'barbershop_id'>) => (l.receiver === 'platform' ? platformCielo().feePct : shopCielo(l.barbershop_id).feePct);

const inFlight = new Set<string>();

/** Cria o link na Cielo e guarda (um pedido de cada vez por cobrança). */
async function newLink(input: {
  receiver: CardLink['receiver'];
  shopId: number;
  kind: CardLink['kind'];
  recurrent: boolean;
  amountCents: number;
  name: string;
  description: string;
  sku: string;
  chargeId?: number | null;
  memberId?: number | null;
  expirationDate?: string | null;
}): Promise<CardLink> {
  const creds = input.receiver === 'platform' ? platformCieloCreds() : shopCieloCreds(input.shopId);
  if (!creds) throw new HttpError(409, 'Pagamento com cartão indisponível.');
  if (inFlight.has(input.sku)) throw new HttpError(409, 'Já estamos gerando o pagamento. Tente de novo em alguns segundos.');
  inFlight.add(input.sku);
  try {
    const l = await createLink(creds, {
      name: input.name,
      description: input.description,
      amountCents: input.amountCents,
      sku: input.sku,
      recurrent: input.recurrent,
      expirationDate: input.expirationDate,
    });
    const id = run(
      `INSERT INTO card_links (receiver, barbershop_id, kind, recurrent, link_id, sku, url, amount_cents, charge_id, club_member_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.receiver, input.shopId, input.kind, input.recurrent ? 1 : 0, l.id, input.sku, l.url, input.amountCents, input.chargeId ?? null, input.memberId ?? null, nowIso()],
    ).lastInsertRowid;
    return cardLink(id);
  } catch (err) {
    if (err instanceof CieloError) throw new HttpError(502, `Não deu para gerar o pagamento no cartão agora: ${err.message}`);
    throw err;
  } finally {
    inFlight.delete(input.sku);
  }
}

/**
 * Tira o link do ar: no automático já ligado, para a cobrança mensal na Cielo; no que ainda não foi
 * pago, apaga o link. Se a Cielo falhar, guarda o erro e devolve a mensagem (tenta de novo depois).
 */
export async function cancelLink(l: CardLink): Promise<string | null> {
  if (l.status === 'cancelled' || l.status === 'paid') return null;
  const creds = credsOf(l);
  try {
    if (!creds) throw new CieloError('a conta Cielo foi desligada no sistema', 0);
    if (l.status === 'active') {
      if (!l.recurrent_payment_id) throw new CieloError('a Cielo não informou o código da recorrência', 0);
      await deactivateRecurrence(creds, l.recurrent_payment_id);
    } else await deleteLink(creds, l.link_id);
    run("UPDATE card_links SET status = 'cancelled', cancelled_at = ?, error = NULL WHERE id = ?", [nowIso(), l.id]);
    return null;
  } catch (err) {
    if (!(err instanceof CieloError)) throw err;
    const msg = `Não deu para cancelar a cobrança no cartão (${err.message}). Cancele no site da Cielo, em Link de Pagamento → Recorrência.`;
    run('UPDATE card_links SET error = ? WHERE id = ?', [msg.slice(0, 300), l.id]);
    return msg;
  }
}

// ---------- mensalidade do sistema (a barbearia paga a plataforma)

const subscriptionLink = (shopId: number) =>
  get<CardLink>("SELECT * FROM card_links WHERE receiver = 'platform' AND barbershop_id = ? AND kind = 'mensalidade' AND status IN ('open', 'active') ORDER BY id DESC LIMIT 1", [shopId]);

/** Como está o cartão automático da mensalidade (para a tela Mensalidade). */
export function subscriptionCardState(shopId: number) {
  const l = subscriptionLink(shopId);
  return {
    available: platformCardReady(),
    active: l?.status === 'active',
    amount_cents: l?.amount_cents ?? null,
    since: l?.status === 'active' ? l.created_at : null,
    last_paid_at: l?.last_paid_at ?? null,
    error: l?.error ?? null,
  };
}

/**
 * Cartão automático da mensalidade: paga a fatura em aberto agora e a Cielo cobra o mesmo valor todo
 * mês, no mesmo dia (a mensalidade passa a vencer nesse dia).
 */
export async function subscriptionCardLink(shopId: number): Promise<{ url: string }> {
  if (!platformCardReady()) throw new HttpError(409, 'A plataforma ainda não recebe a mensalidade no cartão.');
  const s = shopBilling(shopId);
  const amount = monthlyPrice(s);
  if (amount <= 0) throw new HttpError(409, 'Sem mensalidade definida. Fale com o administrador da plataforma.');
  if (!get("SELECT 1 AS ok FROM invoices WHERE barbershop_id = ? AND status = 'open'", [shopId])) {
    throw new HttpError(409, 'Nenhuma mensalidade em aberto agora. O cartão é cadastrado no pagamento da próxima.');
  }
  const current = subscriptionLink(shopId);
  if (current?.status === 'active') {
    const overdue = get("SELECT 1 AS ok FROM invoices WHERE barbershop_id = ? AND status = 'open' AND due_date < ?", [shopId, localNow().date]);
    if (!overdue) throw new HttpError(409, 'O cartão já está cadastrado: a mensalidade é cobrada sozinha todo mês.');
    // O cartão não passou: troca por outro (a cobrança antiga para).
    const error = await cancelLink(current);
    if (error) throw new HttpError(502, error);
  } else if (reusable(current, amount)) return { url: current.url };
  else if (current) await cancelLink(current);
  const l = await newLink({
    receiver: 'platform',
    shopId,
    kind: 'mensalidade',
    recurrent: true,
    amountCents: amount,
    name: `Mensalidade${s.plan_name ? ` · ${s.plan_name}` : ''}`,
    description: `Sistema da ${s.name}: cobrado no cartão todo mês, no mesmo dia.`,
    sku: `m${shopId}`,
  });
  return { url: l.url };
}

export async function cancelSubscriptionCard(shopId: number): Promise<void> {
  const l = subscriptionLink(shopId);
  if (!l) throw new HttpError(404, 'Nenhum cartão cadastrado para a mensalidade.');
  const error = await cancelLink(l);
  if (error) throw new HttpError(502, error);
}

/** Barbearia suspensa: para de cobrar a mensalidade no cartão (devolve o aviso se a Cielo falhar). */
export async function stopSubscriptionCard(shopId: number): Promise<string | null> {
  const l = subscriptionLink(shopId);
  return l ? cancelLink(l) : null;
}

/** O valor da mensalidade mudou: o cartão automático (no valor antigo) é desligado, e a barbearia cadastra de novo. */
export async function subscriptionPriceChanged(shopId: number): Promise<void> {
  const l = subscriptionLink(shopId);
  if (l && l.amount_cents !== monthlyPrice(shopBilling(shopId))) await cancelLink(l);
}

// ---------- clientes da barbearia: clube (automático) e sinal (avulso)

const memberLink = (memberId: number) =>
  get<CardLink>("SELECT * FROM card_links WHERE club_member_id = ? AND kind = 'clube' AND status IN ('open', 'active') ORDER BY id DESC LIMIT 1", [memberId]);

/**
 * Clube no cartão automático: paga a mensalidade em aberto agora e a Cielo cobra todo mês. Com o cartão
 * recusado (mensalidade atrasada), dá para cadastrar outro cartão.
 */
async function clubCardLink(shopId: number, customerId: number, memberId: number): Promise<{ url: string }> {
  const m = get<{ id: number; status: string; plan_name: string; price_cents: number }>(
    'SELECT m.id, m.status, p.name AS plan_name, p.price_cents FROM club_members m JOIN club_plans p ON p.id = m.plan_id WHERE m.id = ? AND m.barbershop_id = ? AND m.customer_id = ?',
    [memberId, shopId, customerId],
  );
  if (!m || m.status === 'cancelled') throw new HttpError(404, 'Assinatura não encontrada.');
  const open = get<{ id: number; amount_cents: number }>("SELECT id, amount_cents FROM charges WHERE club_member_id = ? AND status = 'open' ORDER BY period_start LIMIT 1", [m.id]);
  const current = memberLink(m.id);
  if (current?.status === 'active') {
    if (!open) throw new HttpError(409, 'O cartão já está cadastrado: a mensalidade é cobrada sozinha todo mês.');
    // O cartão não passou: troca por outro (a cobrança antiga para).
    const error = await cancelLink(current);
    if (error) throw new HttpError(502, error);
  }
  const amount = open?.amount_cents ?? m.price_cents;
  const pending = memberLink(m.id);
  if (reusable(pending, amount)) return { url: pending.url };
  if (pending) await cancelLink(pending);
  const shop = get<{ name: string }>('SELECT name FROM barbershops WHERE id = ?', [shopId])!;
  const l = await newLink({
    receiver: 'shop',
    shopId,
    kind: 'clube',
    recurrent: true,
    amountCents: amount,
    name: /^(clube|plano)\b/i.test(m.plan_name) ? m.plan_name : `Clube ${m.plan_name}`,
    description: `${shop.name}: cobrado no cartão todo mês, no mesmo dia. Cancele quando quiser pela sua área.`,
    sku: `c${m.id}`,
    memberId: m.id,
  });
  return { url: l.url };
}

/** O cliente quer pagar no cartão: o sinal (avulso) ou a mensalidade do clube (automático todo mês). */
export async function payChargeByCard(shopId: number, customerId: number, chargeId: number): Promise<{ url: string }> {
  const status = shopCardStatus(shopId);
  if (!status.available) throw new HttpError(409, status.reason ?? 'Pagamento com cartão indisponível.');
  const c = charge(chargeId, shopId);
  if (c.customer_id !== customerId) throw new HttpError(404, 'Cobrança não encontrada.');
  if (c.status !== 'open') throw new HttpError(409, 'Essa cobrança não está mais em aberto.');
  if (c.kind === 'clube' && c.club_member_id) return clubCardLink(shopId, customerId, c.club_member_id);
  const current = get<CardLink>("SELECT * FROM card_links WHERE charge_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [c.id]);
  if (reusable(current, c.amount_cents)) return { url: current.url };
  if (current) await cancelLink(current);
  const shop = get<{ name: string }>('SELECT name FROM barbershops WHERE id = ?', [shopId])!;
  const l = await newLink({
    receiver: 'shop',
    shopId,
    kind: 'sinal',
    recurrent: false,
    amountCents: c.amount_cents,
    name: c.description,
    description: `${shop.name}: o sinal é descontado no dia do atendimento.`,
    sku: `s${c.id}`,
    chargeId: c.id,
    // A Cielo só aceita data: o prazo do sinal (em minutos) quem controla é o sistema.
    expirationDate: addDays(shopNow(shopId).date, 1),
  });
  return { url: l.url };
}

/** O assinante cancelou: a Cielo para de cobrar o cartão (se falhar, devolve o aviso para o dono). */
export async function cancelMemberCard(memberId: number): Promise<string | null> {
  const l = memberLink(memberId);
  return l ? cancelLink(l) : null;
}

// ---------- avisos da Cielo

/** Acha o link do pagamento (pelo id do link, pela recorrência ou pelo nosso código). */
function findLink(who: CardReceiver, data: unknown): CardLink | undefined {
  const mine = (l: CardLink | undefined) =>
    l && (who.receiver === 'platform' ? l.receiver === 'platform' : l.receiver === 'shop' && l.barbershop_id === who.shopId) ? l : undefined;
  const productId = pick(data, 'product_id', 'productId', 'ProductId');
  const byProduct = productId ? mine(get<CardLink>('SELECT * FROM card_links WHERE link_id = ?', [productId])) : undefined;
  if (byProduct) return byProduct;
  const recurrent = pick(data, 'recurrent_payment_id', 'pagador_recurrent_payment_id', 'RecurrentPaymentId', 'recurrentPaymentId');
  const byRecurrence = recurrent ? mine(get<CardLink>('SELECT * FROM card_links WHERE recurrent_payment_id = ? ORDER BY id DESC LIMIT 1', [recurrent])) : undefined;
  if (byRecurrence) return byRecurrence;
  const sku = pick(data, 'product_sku', 'sku', 'ProductSku');
  return sku ? mine(get<CardLink>("SELECT * FROM card_links WHERE sku = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 1", [sku])) : undefined;
}

/**
 * Aviso da Cielo (pagamento finalizado ou mudança de situação). Cada recebedor tem a sua URL, com um
 * segredo. O aviso não é assinado: a situação que vale é a da consulta do pedido na Cielo.
 */
export async function handleCieloNotice(token: string, body: unknown): Promise<{ ok: true; note?: string }> {
  const who = receiverByToken(token);
  if (!who) throw new HttpError(404, 'Não encontrado.');
  markCieloSeen(who);
  const creds = who.receiver === 'platform' ? platformCieloCreds() : shopCieloCreds(who.shopId);
  if (!creds) return { ok: true, note: 'conta Cielo desligada' };
  let data: unknown = body ?? {};
  // Aviso em JSON: vem só o endereço para buscar os dados do pagamento na Cielo.
  const url = pick(data, 'URL');
  if (url && !pick(data, 'checkout_cielo_order_number')) data = await cieloCall<Record<string, unknown>>(creds, 'GET', url);
  const orderNumber = pick(data, 'checkout_cielo_order_number', 'checkoutCieloOrderNumber', 'CheckoutCieloOrderNumber');
  if (!orderNumber) return { ok: true, note: 'aviso sem pedido' };
  const link = findLink(who, data);
  if (!link) return { ok: true, note: 'pagamento de outro link' };
  return processOrder(link, orderNumber, data);
}

/** Confere o pedido na Cielo e dá a baixa (o mesmo caminho do aviso e da conferência periódica). */
async function processOrder(link: CardLink, orderNumber: string, hint: unknown = {}): Promise<{ ok: true; note?: string }> {
  const creds = credsOf(link);
  if (!creds) return { ok: true, note: 'conta Cielo desligada' };
  let order: Awaited<ReturnType<typeof getOrder>>;
  try {
    order = await getOrder(creds, orderNumber);
  } catch (err) {
    if (err instanceof CieloError && err.status === 404) return { ok: true, note: 'pedido não encontrado na Cielo' };
    throw err;
  }
  const status: CardStatus = order.status !== 'UNKNOWN' ? order.status : cieloStatus(pick(hint, 'payment_status'));
  const recurrent = order.recurrentPaymentId ?? pick(hint, 'recurrent_payment_id', 'pagador_recurrent_payment_id', 'RecurrentPaymentId');
  if (recurrent && !link.recurrent_payment_id) run('UPDATE card_links SET recurrent_payment_id = ? WHERE id = ?', [recurrent, link.id]);
  const hintedAmount = pick(hint, 'amount');
  return applyOrder(cardLink(link.id), {
    orderNumber,
    status,
    method: order.method ?? cieloMethod(pick(hint, 'payment_method_type')) ?? 'CREDIT_CARD',
    amountCents: order.amountCents ?? (hintedAmount && /^\d+$/.test(hintedAmount) ? Number(hintedAmount) : link.amount_cents),
  });
}

const CASH_METHOD: Record<string, Method> = { CREDIT_CARD: 'credito', DEBIT_CARD: 'debito', PIX: 'pix' };

/** Taxa do cartão no caixa da barbearia, para o saldo bater com o que cai na conta Cielo. */
function cardFeeEntry(shopId: number, chargeId: number, fee: number, now: Date) {
  if (fee <= 0) return;
  const c = charge(chargeId);
  run(
    `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, charge_id, created_at)
     VALUES (?, 'out', 'Impostos e taxas', ?, ?, NULL, ?, 'paid', ?, ?)`,
    [shopId, `Taxa do cartão (Cielo) · ${c.description}`, fee, shopNow(shopId, now).date, chargeId, nowIso()],
  );
}

interface PaidOrder {
  orderNumber: string;
  status: CardStatus;
  method: string;
  amountCents: number;
}

function applyOrder(link: CardLink, o: PaidOrder, now: Date = new Date()): { ok: true; note?: string } {
  const fee = Math.round((o.amountCents * feeOf(link)) / 100);
  const base = {
    externalId: `cielo:${o.orderNumber}`,
    shopId: link.barbershop_id,
    kind: link.kind,
    cardLinkId: link.id,
    valueCents: o.amountCents,
    netCents: o.amountCents - fee,
    method: o.method,
    status: o.status,
  };
  if (o.status !== 'RECEIVED') {
    const before = gatewayPayment(base.externalId);
    upsertCardPayment({ ...base, chargeId: link.charge_id });
    if (o.status === 'DENIED' && link.recurrent) run('UPDATE card_links SET error = ? WHERE id = ?', ['O cartão recusou a última cobrança.', link.id]);
    // Estorno ou contestação depois da baixa: o valor volta para o cliente.
    if (before?.applied && !before.refunded && ['CANCELLED', 'REFUNDED', 'CHARGEBACK'].includes(o.status)) reverse(link, before.charge_id, o.amountCents - fee, now);
    return { ok: true, note: `situação ${o.status}` };
  }
  // O aviso de pagamento e o de mudança de situação chegam os dois: só o primeiro dá baixa.
  if (gatewayPayment(base.externalId)?.applied) return { ok: true, note: 'já aplicado' };
  const ref = tx(() => {
    const r: { invoiceId?: number; chargeId?: number; duplicate?: boolean } =
      link.kind === 'mensalidade' ? payInvoice(link, o, now) : link.kind === 'clube' ? payClub(link, o, fee, now) : payDeposit(link, o, fee, now);
    upsertCardPayment({ ...base, ...r, applied: true, paidAt: localNow(now).date });
    run(
      `UPDATE card_links SET status = CASE WHEN status = 'cancelled' THEN status WHEN recurrent = 1 THEN 'active' ELSE 'paid' END,
              last_paid_at = ?, error = NULL WHERE id = ?`,
      [nowIso(), link.id],
    );
    return r;
  });
  if (ref.invoiceId) void afterInvoicePaid(ref.invoiceId);
  return { ok: true, ...(ref.duplicate ? { note: 'pago em duplicidade' } : {}) };
}

/** Mensalidade paga no cartão: a fatura em aberto mais antiga (do mesmo valor) ou a do mês seguinte. */
function payInvoice(link: CardLink, o: PaidOrder, now: Date): { invoiceId?: number; duplicate?: boolean } {
  const shopId = link.barbershop_id;
  const today = localNow(now).date;
  const open = all<{ id: number; amount_cents: number; reference: string }>(
    "SELECT id, amount_cents, reference FROM invoices WHERE barbershop_id = ? AND status = 'open' ORDER BY due_date, id",
    [shopId],
  );
  const inv = open.find((i) => i.amount_cents === o.amountCents) ?? open.find((i) => /^\d{4}-\d{2}$/.test(i.reference)) ?? nextMonthlyInvoice(shopId, now);
  if (!inv) return { duplicate: true };
  // 1º pagamento: a mensalidade passa a vencer no dia em que a Cielo cobra o cartão.
  if (link.status === 'open') run('UPDATE barbershops SET billing_day = ? WHERE id = ?', [Math.min(Number(today.slice(8, 10)), 28), shopId]);
  markInvoicePaid(inv.id, { paid_at: today, method: 'cartao', notes: 'Cartão (Cielo): cobrança automática todo mês.' });
  return { invoiceId: inv.id };
}

/** Fatura paga no cartão: some a cobrança do Asaas (para não pagar duas vezes) e sai a nota fiscal. */
async function afterInvoicePaid(invoiceId: number): Promise<void> {
  try {
    if (asaasEnabled()) {
      // Se a cobrança do Asaas não sair agora, ela continua ligada à fatura (aparece o erro para o master).
      if (await cancelAsaasCharge(invoiceId)) {
        run('UPDATE invoices SET asaas_payment_id = NULL, asaas_pix_payload = NULL, asaas_pix_qr = NULL, asaas_invoice_url = NULL WHERE id = ?', [invoiceId]);
      }
      if (asaasSettings().nfse.enabled) await issueNfse(invoiceId);
    }
  } catch (err) {
    console.error('[cielo] depois da mensalidade paga:', (err as Error).message);
  }
}

function payClub(link: CardLink, o: PaidOrder, fee: number, now: Date): { chargeId?: number; duplicate?: boolean } {
  const m = link.club_member_id ? get<{ id: number; status: string }>('SELECT id, status FROM club_members WHERE id = ?', [link.club_member_id]) : undefined;
  // Cancelou e o cartão foi cobrado mesmo assim: fica marcado para a barbearia devolver.
  if (!m || m.status === 'cancelled') return { duplicate: true };
  const chargeId = chargeForCardPayment(m.id, o.amountCents, now);
  confirmCharge(link.barbershop_id, chargeId, { method: CASH_METHOD[o.method] ?? 'credito', userId: null, now });
  cardFeeEntry(link.barbershop_id, chargeId, fee, now);
  return { chargeId };
}

function payDeposit(link: CardLink, o: PaidOrder, fee: number, now: Date): { chargeId?: number; duplicate?: boolean } {
  const c = charge(link.charge_id!);
  // Já tinha sido pago de outro jeito (ex.: PIX direto): a barbearia devolve.
  if (c.status === 'paid') return { chargeId: c.id, duplicate: true };
  // Pagou depois de a vaga ser liberada: o sinal vira crédito para o próximo horário.
  if (c.status === 'cancelled') run("UPDATE charges SET status = 'open', expires_at = NULL, appointment_id = NULL WHERE id = ?", [c.id]);
  confirmCharge(c.barbershop_id, c.id, { method: CASH_METHOD[o.method] ?? 'credito', userId: null, now });
  cardFeeEntry(c.barbershop_id, c.id, fee, now);
  return { chargeId: c.id };
}

/** Estornado na Cielo depois da baixa: sai do caixa da barbearia o que tinha ficado com ela. */
function reverse(link: CardLink, chargeId: number | null, kept: number, now: Date) {
  tx(() => {
    run("UPDATE gateway_payments SET refunded = 1 WHERE card_link_id = ? AND charge_id IS ? AND applied = 1 AND refunded = 0", [link.id, chargeId]);
    if (link.receiver !== 'shop' || !chargeId) return;
    const c = charge(chargeId);
    run(
      `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, charge_id, created_at)
       VALUES (?, 'out', 'Outras saídas', ?, ?, 'credito', ?, 'paid', ?, ?)`,
      [c.barbershop_id, `Estorno do cartão (Cielo) · ${c.description}`, kept, shopNow(c.barbershop_id, now).date, c.id, nowIso()],
    );
    if (c.kind === 'sinal' && !c.sale_id && !c.refunded_at) run('UPDATE charges SET refunded_at = ?, appointment_id = NULL WHERE id = ?', [nowIso(), c.id]);
  });
}

// ---------- conferência periódica

/**
 * Roda de hora em hora: apaga os links que não valem mais (sinal pago de outro jeito ou vencido,
 * assinatura cancelada, link nunca pago há uma semana), insiste em parar a cobrança de quem cancelou
 * (e de barbearia suspensa) e confere na Cielo os pagamentos cujo aviso não chegou.
 */
export async function syncCardLinks(now: Date = new Date()): Promise<{ removed: number; applied: number }> {
  let removed = 0;
  let applied = 0;
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const stale = all<CardLink>(
    `SELECT l.* FROM card_links l LEFT JOIN charges c ON c.id = l.charge_id LEFT JOIN club_members m ON m.id = l.club_member_id
      WHERE (l.status = 'open' AND (l.created_at < ? OR (l.kind = 'sinal' AND c.status <> 'open') OR (l.kind = 'clube' AND m.status = 'cancelled')))
         OR (l.status = 'active' AND l.kind = 'clube' AND m.status = 'cancelled')
         OR (l.status = 'active' AND l.kind = 'mensalidade' AND EXISTS (SELECT 1 FROM barbershops b WHERE b.id = l.barbershop_id AND b.active = 0))
      LIMIT 30`,
    [weekAgo],
  );
  for (const l of stale) {
    // Antes de apagar, confere se não pagou (aviso perdido).
    applied += await checkLink(l);
    const fresh = cardLink(l.id);
    if (fresh.status === 'open' || fresh.status === 'active') {
      if (!(await cancelLink(fresh))) removed++;
    }
  }
  const check = all<CardLink>(
    `SELECT * FROM card_links WHERE status IN ('open', 'active') AND (checked_at IS NULL OR checked_at < ?)
      ORDER BY COALESCE(checked_at, created_at) LIMIT 20`,
    [new Date(now.getTime() - 3600000).toISOString()],
  );
  for (const l of check) applied += await checkLink(l);
  return { removed, applied };
}

/** Pedidos do link pagos na Cielo que ainda não deram baixa aqui. */
async function checkLink(l: CardLink): Promise<number> {
  const creds = credsOf(l);
  if (!creds) return 0;
  run('UPDATE card_links SET checked_at = ? WHERE id = ?', [nowIso(), l.id]);
  let applied = 0;
  try {
    for (const o of await linkOrders(creds, l.link_id)) {
      if (o.status !== 'RECEIVED' || gatewayPayment(`cielo:${o.orderNumber}`)?.applied) continue;
      await processOrder(cardLink(l.id), o.orderNumber);
      applied++;
    }
  } catch (err) {
    console.warn('[cielo] conferir link:', (err as Error).message);
  }
  return applied;
}
