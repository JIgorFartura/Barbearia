import { charge, chargePayload, pixSettings, type ChargeView } from './charges.js';
import { clubCoverage } from './club.js';
import { shopNow, shopTz } from './clock.js';
import { all, get, run, tx } from './db.js';
import { HttpError } from './http.js';
import { sendMessage, sendsTemplate, type ShopBot } from './messaging.js';
import { addDays, addMinutes, dayLabel, hourLabel, isoToLocal } from './time.js';

/**
 * Sinal via PIX para segurar o horário (contra falta). Quem marca pelo site ou pelo WhatsApp paga um
 * sinal em até `deposit_hold_min` minutos; sem pagamento, a vaga é liberada. O sinal é abatido no
 * fechamento do atendimento. Cancelou com antecedência (ou foi a barbearia que cancelou): vira crédito
 * para o próximo horário. Cancelou em cima da hora ou faltou: a barbearia fica com o sinal.
 */

export type DepositMode = 'off' | 'all' | 'no_show';

export interface DepositSettings {
  deposit_mode: DepositMode;
  deposit_cents: number;
  deposit_hold_min: number;
  deposit_credit_hours: number;
}

/** "Quem já faltou": alguma falta nos últimos 6 meses. */
const NO_SHOW_DAYS = 180;

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const firstName = (name: string) => name.split(/\s+/)[0];
const when = (stamp: string) => `${dayLabel(stamp.slice(0, 10))} às ${hourLabel(stamp.slice(11, 16))}`;

export const depositSettings = (shopId: number) =>
  get<DepositSettings>('SELECT deposit_mode, deposit_cents, deposit_hold_min, deposit_credit_hours FROM barbershops WHERE id = ?', [shopId])!;

export function saveDepositSettings(shopId: number, s: DepositSettings): DepositSettings {
  run('UPDATE barbershops SET deposit_mode = ?, deposit_cents = ?, deposit_hold_min = ?, deposit_credit_hours = ? WHERE id = ?', [
    s.deposit_mode,
    s.deposit_cents,
    s.deposit_hold_min,
    s.deposit_credit_hours,
    shopId,
  ]);
  return depositSettings(shopId);
}

/** Este cliente precisa pagar sinal para um horário que começa em `startsAt`? */
export function needsDeposit(shopId: number, customerId: number, startsAt: string, now: Date = new Date()): boolean {
  const s = depositSettings(shopId);
  if (s.deposit_mode === 'off' || s.deposit_cents <= 0) return false;
  // Sem chave PIX não tem como cobrar.
  if (!pixSettings(shopId).pix_key) return false;
  const n = shopNow(shopId, now);
  // Horário em cima da hora (não daria tempo de pagar): sem sinal.
  if (startsAt < addMinutes(n.stamp, s.deposit_hold_min + 30)) return false;
  // Assinante do clube em dia não paga sinal.
  if (clubCoverage(shopId, customerId, n.date)) return false;
  if (s.deposit_mode === 'all') return true;
  return Boolean(
    get("SELECT 1 AS ok FROM appointments WHERE customer_id = ? AND status = 'no_show' AND starts_at >= ? LIMIT 1", [customerId, `${addDays(n.date, -NO_SHOW_DAYS)} 00:00`]),
  );
}

/** Sinal do horário (pago, avisado ou esperando pagamento). */
export function appointmentDeposit(appointmentId: number): ChargeView | null {
  const c = get<{ id: number }>("SELECT id FROM charges WHERE appointment_id = ? AND kind = 'sinal' AND status <> 'cancelled' ORDER BY id DESC LIMIT 1", [appointmentId]);
  return c ? charge(c.id) : null;
}

/** Crédito de sinal do cliente (de um horário cancelado com antecedência). */
const creditOf = (customerId: number) =>
  get<{ id: number }>(
    "SELECT id FROM charges WHERE customer_id = ? AND kind = 'sinal' AND status = 'paid' AND appointment_id IS NULL AND sale_id IS NULL AND forfeited_at IS NULL AND refunded_at IS NULL ORDER BY id LIMIT 1",
    [customerId],
  );

/**
 * Logo depois de marcar (site ou WhatsApp): usa o crédito de sinal, se tiver, ou cria a cobrança do sinal.
 * null = esse horário não precisa de sinal.
 */
export function requireDeposit(shopId: number, appointmentId: number, now: Date = new Date()): ChargeView | null {
  const a = get<{ customer_id: number; starts_at: string; barber_name: string }>(
    'SELECT a.customer_id, a.starts_at, b.name AS barber_name FROM appointments a JOIN barbers b ON b.id = a.barber_id WHERE a.id = ? AND a.barbershop_id = ?',
    [appointmentId, shopId],
  );
  if (!a || !needsDeposit(shopId, a.customer_id, a.starts_at, now)) return null;
  const description = `Sinal · ${when(a.starts_at)} com ${a.barber_name}`;
  return tx(() => {
    const credit = creditOf(a.customer_id);
    if (credit) {
      run('UPDATE charges SET appointment_id = ?, description = ? WHERE id = ?', [appointmentId, description, credit.id]);
      return charge(credit.id);
    }
    const s = depositSettings(shopId);
    const id = run(
      `INSERT INTO charges (barbershop_id, customer_id, kind, description, amount_cents, appointment_id, expires_at, created_at)
       VALUES (?, ?, 'sinal', ?, ?, ?, ?, ?)`,
      [shopId, a.customer_id, description, s.deposit_cents, appointmentId, new Date(now.getTime() + s.deposit_hold_min * 60000).toISOString(), now.toISOString()],
    ).lastInsertRowid;
    return charge(id);
  });
}

export type DepositOutcome = 'credit' | 'kept' | 'cancelled' | null;

/**
 * O horário foi cancelado. Sinal pago: vira crédito se o cliente cancelou com antecedência (ou se foi a
 * barbearia que cancelou); em cima da hora, fica com a barbearia. Sinal ainda não pago: cancelado.
 */
export function depositOnCancel(shopId: number, appointmentId: number, opts: { byCustomer: boolean; now?: Date }): DepositOutcome {
  const c = appointmentDeposit(appointmentId);
  if (!c || c.sale_id) return null;
  const now = opts.now ?? new Date();
  if (c.status === 'open') {
    // Avisou que pagou e cancelou: se o PIX cair, vira crédito.
    if (c.claimed_at) {
      run('UPDATE charges SET appointment_id = NULL, expires_at = NULL WHERE id = ?', [c.id]);
      return 'credit';
    }
    run("UPDATE charges SET status = 'cancelled' WHERE id = ?", [c.id]);
    return 'cancelled';
  }
  const startsAt = get<{ starts_at: string }>('SELECT starts_at FROM appointments WHERE id = ?', [appointmentId])!.starts_at;
  const s = depositSettings(shopId);
  const early = startsAt >= addMinutes(shopNow(shopId, now).stamp, s.deposit_credit_hours * 60);
  if (!opts.byCustomer || early) {
    run('UPDATE charges SET appointment_id = NULL WHERE id = ?', [c.id]);
    return 'credit';
  }
  run('UPDATE charges SET forfeited_at = ? WHERE id = ?', [now.toISOString(), c.id]);
  return 'kept';
}

/** Frase para o cliente sobre o que aconteceu com o sinal ao cancelar. */
export function depositOutcomeText(outcome: DepositOutcome, amountCents?: number): string {
  if (outcome === 'credit') return `O sinal${amountCents ? ` de ${money(amountCents)}` : ''} fica de crédito para o seu próximo horário.`;
  if (outcome === 'kept') return 'Como o cancelamento foi em cima da hora, o sinal fica com a barbearia.';
  return '';
}

/** PIX do sinal + texto explicando o prazo (WhatsApp e área do cliente). */
export function depositMessage(shop: { id: number; name: string }, c: ChargeView): { text: string; payload: string | null } {
  if (c.status === 'paid') return { text: `Você já tem ${money(c.amount_cents)} de sinal pago: vale para esse horário. 👍`, payload: null };
  const payload = chargePayload(c);
  const until = c.expires_at ? hourLabel(isoToLocal(c.expires_at, shopTz(shop.id)).slice(11, 16)) : null;
  return {
    text: `Para garantir o horário, falta o sinal de ${money(c.amount_cents)} pelo PIX${until ? ` até as ${until}` : ''}; sem o sinal, a vaga é liberada. O código PIX vai na próxima mensagem. Depois de pagar, é só responder *paguei*.`,
    payload,
  };
}

/**
 * Marcou pelo site: o pedido do sinal também vai pelo WhatsApp (o PIX numa mensagem separada, fácil
 * de copiar; na API oficial fora da janela de 24h, vai o modelo aprovado com o PIX dentro).
 */
export async function sendDepositRequest(shop: ShopBot, c: ChargeView): Promise<boolean> {
  if (c.status !== 'open' || c.claimed_at || !c.appointment_id) return false;
  const payload = chargePayload(c);
  const a = get<{ starts_at: string }>('SELECT starts_at FROM appointments WHERE id = ?', [c.appointment_id]);
  if (!payload || !a) return false;
  const first = firstName(c.customer_name);
  const until = c.expires_at ? hourLabel(isoToLocal(c.expires_at, shopTz(shop.id)).slice(11, 16)) : null;
  const viaTemplate = sendsTemplate(shop, c.phone);
  const r = await sendMessage({
    shop,
    customerId: c.customer_id,
    phone: c.phone,
    waId: c.wa_id,
    kind: 'sinal',
    text: `Oi, ${first}! Seu horário na ${shop.name} (${when(a.starts_at)}) está reservado. Para confirmar, pague o sinal de ${money(c.amount_cents)} pelo PIX${until ? ` até as ${until}` : ''}; o código vai na próxima mensagem. Depois de pagar, é só responder *paguei*.`,
    template: { kind: 'sinal', params: [first, shop.name, when(a.starts_at), money(c.amount_cents), payload] },
  });
  if (r.status === 'failed') return false;
  if (!viaTemplate) await sendMessage({ shop, customerId: c.customer_id, phone: c.phone, waId: c.wa_id, kind: 'sinal', text: payload });
  return true;
}

/** Vaga segurada e o sinal não veio: libera o horário e avisa o cliente. */
export async function expireDeposits(shop: ShopBot, now: Date): Promise<number> {
  const due = all<{ id: number }>(
    "SELECT id FROM charges WHERE barbershop_id = ? AND kind = 'sinal' AND status = 'open' AND claimed_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?",
    [shop.id, now.toISOString()],
  );
  let released = 0;
  for (const { id } of due) {
    const c = charge(id);
    const a = c.appointment_id
      ? get<{ id: number; starts_at: string; status: string }>('SELECT id, starts_at, status FROM appointments WHERE id = ?', [c.appointment_id])
      : undefined;
    const free = Boolean(a && a.status === 'scheduled' && a.starts_at > shopNow(shop.id, now).stamp);
    tx(() => {
      run("UPDATE charges SET status = 'cancelled' WHERE id = ?", [id]);
      if (free) run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [now.toISOString(), a!.id]);
    });
    if (!free) continue;
    released++;
    // Na API oficial, fora da janela de 24h, não dá para mandar texto livre: a área do cliente mostra.
    if (sendsTemplate(shop, c.phone)) continue;
    await sendMessage({
      shop,
      customerId: c.customer_id,
      phone: c.phone,
      waId: c.wa_id,
      kind: 'sinal',
      text: `Oi, ${firstName(c.customer_name)}! O sinal do horário de ${when(a!.starts_at)} não chegou a tempo, então liberei a vaga. Se ainda quiser, é só me chamar que eu vejo outro horário. 👊`,
    });
  }
  return released;
}

/** O que o cliente vê do sinal (área do cliente). */
export function depositPublic(shopId: number, c: ChargeView | null) {
  if (!c) return null;
  return {
    id: c.id,
    amount_cents: c.amount_cents,
    paid: c.status === 'paid',
    claimed: Boolean(c.claimed_at),
    /** Até quando o horário fica segurado esperando o PIX ("AAAA-MM-DD HH:MM", horário da barbearia). */
    expires_local: c.status === 'open' && c.expires_at && !c.claimed_at ? isoToLocal(c.expires_at, shopTz(shopId)) : null,
  };
}

/** Na comanda: sinal pago deste horário que ainda não foi abatido. */
export function prepaidFor(appointmentId: number): { id: number; amount_cents: number } | null {
  return (
    get<{ id: number; amount_cents: number }>(
      "SELECT id, amount_cents FROM charges WHERE appointment_id = ? AND kind = 'sinal' AND status = 'paid' AND sale_id IS NULL AND forfeited_at IS NULL AND refunded_at IS NULL ORDER BY id LIMIT 1",
      [appointmentId],
    ) ?? null
  );
}

/** Sinal do horário para a agenda e a comanda: pago (abate no fechamento), avisado pelo cliente ou esperando. */
export function depositState(shopId: number, appointmentId: number) {
  const c = appointmentDeposit(appointmentId);
  if (!c || c.sale_id || c.forfeited_at || c.refunded_at) return null;
  return {
    id: c.id,
    amount_cents: c.amount_cents,
    state: (c.status === 'paid' ? 'paid' : c.claimed_at ? 'claimed' : 'open') as 'paid' | 'claimed' | 'open',
    expires_local: c.status === 'open' && c.expires_at && !c.claimed_at ? isoToLocal(c.expires_at, shopTz(shopId)) : null,
  };
}

/** Devolve o sinal ao cliente (sai do caixa). */
export function refundDeposit(shopId: number, chargeId: number, opts: { userId: number | null; method: string; now?: Date }): ChargeView {
  return tx(() => {
    const c = charge(chargeId, shopId);
    if (c.kind !== 'sinal' || c.status !== 'paid') throw new HttpError(409, 'Só dá para devolver um sinal pago.');
    if (c.sale_id) throw new HttpError(409, 'Esse sinal já foi abatido numa venda.');
    if (c.refunded_at) throw new HttpError(409, 'Esse sinal já foi devolvido.');
    const now = opts.now ?? new Date();
    run('UPDATE charges SET refunded_at = ?, appointment_id = NULL WHERE id = ?', [now.toISOString(), chargeId]);
    run(
      `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, charge_id, created_by, created_at)
       VALUES (?, 'out', 'Outras saídas', ?, ?, ?, ?, 'paid', ?, ?, ?)`,
      [shopId, `Devolução de sinal · ${c.customer_name}`, c.amount_cents, opts.method, shopNow(shopId, now).date, chargeId, opts.userId, now.toISOString()],
    );
    return charge(chargeId);
  });
}

/** Sinais para o painel: esperando pagamento, créditos e os que a barbearia ficou. */
export function depositsOverview(shopId: number) {
  const SELECT = `SELECT ch.id, ch.description, ch.amount_cents, ch.status, ch.claimed_at, ch.paid_at, ch.expires_at, ch.appointment_id, ch.sale_id,
                         ch.forfeited_at, ch.refunded_at, c.name AS customer_name, c.phone, a.status AS appointment_status
                    FROM charges ch JOIN customers c ON c.id = ch.customer_id LEFT JOIN appointments a ON a.id = ch.appointment_id
                   WHERE ch.barbershop_id = ? AND ch.kind = 'sinal'`;
  return {
    settings: depositSettings(shopId),
    hasPix: Boolean(pixSettings(shopId).pix_key),
    open: all(`${SELECT} AND ch.status = 'open' ORDER BY ch.id DESC`, [shopId]),
    credits: all(`${SELECT} AND ch.status = 'paid' AND ch.appointment_id IS NULL AND ch.sale_id IS NULL AND ch.forfeited_at IS NULL AND ch.refunded_at IS NULL ORDER BY ch.id DESC`, [
      shopId,
    ]),
    recent: all(`${SELECT} AND ch.status = 'paid' ORDER BY ch.paid_at DESC LIMIT 30`, [shopId]),
  };
}
