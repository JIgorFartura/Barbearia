import { charge, chargePix, type ChargeView } from './charges.js';
import { clubCoverage } from './club.js';
import { shopNow, shopTz } from './clock.js';
import { all, get, nowIso, run, tx } from './db.js';
import { sendMessage, shopBot } from './messaging.js';
import { asaasChargePix, shopAsaasOn } from './shopAsaas.js';
import { addDays, addMinutes, dayLabel, hourLabel, isoToLocal } from './time.js';

/**
 * Sinal só para quem falta. Desligado por padrão: quem confirma pelo WhatsApp continua sem pagar nada.
 * Com o dono ligando, o cliente que faltou N vezes nos últimos 6 meses e marca sozinho (site, app ou
 * robô) paga um sinal no PIX para segurar o horário; sem pagamento no prazo, a vaga é liberada. No
 * fechamento o sinal é abatido. Cancelou com antecedência (ou foi a barbearia): vira crédito para o
 * próximo horário. Faltou ou cancelou em cima da hora: a barbearia fica com o sinal.
 */

export interface DepositSettings {
  /** Quantas faltas nos últimos 6 meses fazem o cliente pagar sinal (0 = desligado). */
  deposit_no_shows: number;
  deposit_cents: number;
  /** Prazo para pagar depois de marcar (minutos). */
  deposit_hold_min: number;
}

const NO_SHOW_DAYS = 180;
/** Cancelando até tantas horas antes, o sinal vira crédito. */
export const DEPOSIT_CREDIT_HOURS = 24;

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const firstName = (name: string) => name.split(/\s+/)[0];
const when = (stamp: string) => `${dayLabel(stamp.slice(0, 10))} às ${hourLabel(stamp.slice(11, 16))}`;

export const depositSettings = (shopId: number) =>
  get<DepositSettings>('SELECT deposit_no_shows, deposit_cents, deposit_hold_min FROM barbershops WHERE id = ?', [shopId])!;

export function saveDepositSettings(shopId: number, s: DepositSettings): DepositSettings {
  run('UPDATE barbershops SET deposit_no_shows = ?, deposit_cents = ?, deposit_hold_min = ? WHERE id = ?', [s.deposit_no_shows, s.deposit_cents, s.deposit_hold_min, shopId]);
  return depositSettings(shopId);
}

/** Faltas do cliente nos últimos 6 meses. */
export function noShows(customerId: number, shopId: number, now?: Date): number {
  const since = `${addDays(shopNow(shopId, now).date, -NO_SHOW_DAYS)} 00:00`;
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM appointments WHERE customer_id = ? AND status = 'no_show' AND starts_at >= ?", [customerId, since])!.n;
}

/** Este cliente precisa pagar sinal para um horário que começa em `startsAt`? */
export function needsDeposit(shopId: number, customerId: number, startsAt: string, now: Date = new Date()): boolean {
  const s = depositSettings(shopId);
  if (s.deposit_no_shows <= 0 || s.deposit_cents <= 0) return false;
  // Sem chave PIX e sem o Asaas da barbearia não tem como cobrar.
  if (!get<{ pix_key: string | null }>('SELECT pix_key FROM barbershops WHERE id = ?', [shopId])?.pix_key && !shopAsaasOn(shopId)) return false;
  const n = shopNow(shopId, now);
  // Em cima da hora não daria tempo de pagar; assinante em dia não paga sinal.
  if (startsAt < addMinutes(n.stamp, s.deposit_hold_min + 30)) return false;
  if (clubCoverage(shopId, customerId, n.date)) return false;
  return noShows(customerId, shopId, now) >= s.deposit_no_shows;
}

/** Sinal do horário (pago, avisado ou esperando pagamento). */
export function appointmentDeposit(appointmentId: number): ChargeView | null {
  const c = get<{ id: number }>("SELECT id FROM charges WHERE appointment_id = ? AND kind = 'sinal' AND status <> 'cancelled' ORDER BY id DESC LIMIT 1", [appointmentId]);
  return c ? charge(c.id) : null;
}

/** Crédito de sinal (de um horário cancelado com antecedência). */
const creditOf = (customerId: number) =>
  get<{ id: number }>(
    "SELECT id FROM charges WHERE customer_id = ? AND kind = 'sinal' AND status = 'paid' AND appointment_id IS NULL AND sale_id IS NULL AND forfeited_at IS NULL AND refunded_at IS NULL ORDER BY id LIMIT 1",
    [customerId],
  );

/** Logo depois de o cliente marcar: usa o crédito, se tiver, ou cria o sinal. null = não precisa. */
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

/** O PIX do sinal: com baixa automática (Asaas da barbearia) ou pela chave da barbearia. */
export async function depositPix(c: ChargeView, now?: Date): Promise<{ payload: string; qr: string; auto: boolean } | null> {
  if (c.status !== 'open') return null;
  const auto = await asaasChargePix(c, now).catch(() => null);
  if (auto && 'payload' in auto) return { payload: auto.payload, qr: auto.qr, auto: true };
  const key = await chargePix(c);
  return key ? { ...key, auto: false } : null;
}

/** O que o cliente vê do sinal (área do cliente e robô). */
export async function depositView(c: ChargeView | null, now?: Date) {
  if (!c) return null;
  return {
    id: c.id,
    status: c.status,
    amount_cents: c.amount_cents,
    claimed: Boolean(c.claimed_at),
    expires_at: c.expires_at,
    pix: await depositPix(c, now),
  };
}

/** Texto do robô sobre o sinal logo depois de marcar. */
export async function depositText(shopId: number, c: ChargeView, now?: Date): Promise<string> {
  if (c.status === 'paid') return `Você tem ${money(c.amount_cents)} de sinal de crédito: já vale para esse horário. 👍`;
  const pix = await depositPix(c, now);
  const until = c.expires_at ? hourLabel(isoToLocal(c.expires_at, shopTz(shopId)).slice(11, 16)) : '';
  return `Como teve falta nos últimos meses, para segurar esse horário é preciso um sinal de ${money(c.amount_cents)} no PIX até as ${until}. Ele é descontado no dia.${
    pix ? ` PIX copia e cola: ${pix.payload}` : ''
  } Sem o pagamento, o horário é liberado.`;
}

/**
 * Horário cancelado. Sinal pago: crédito se foi com antecedência (ou a barbearia cancelou); em cima da
 * hora, fica com a barbearia. Sinal em aberto: cancelado (avisou que pagou: vira crédito quando cair).
 */
export function depositOnCancel(shopId: number, appointmentId: number, opts: { byCustomer: boolean; now?: Date }): 'credit' | 'kept' | 'cancelled' | null {
  const c = appointmentDeposit(appointmentId);
  if (!c || c.sale_id) return null;
  const now = opts.now ?? new Date();
  if (c.status === 'open') {
    if (c.claimed_at) {
      run('UPDATE charges SET appointment_id = NULL, expires_at = NULL WHERE id = ?', [c.id]);
      return 'credit';
    }
    run("UPDATE charges SET status = 'cancelled' WHERE id = ?", [c.id]);
    return 'cancelled';
  }
  const startsAt = get<{ starts_at: string }>('SELECT starts_at FROM appointments WHERE id = ?', [appointmentId])!.starts_at;
  const early = startsAt >= addMinutes(shopNow(shopId, now).stamp, DEPOSIT_CREDIT_HOURS * 60);
  if (!opts.byCustomer || early) {
    run('UPDATE charges SET appointment_id = NULL WHERE id = ?', [c.id]);
    return 'credit';
  }
  run('UPDATE charges SET forfeited_at = ? WHERE id = ?', [now.toISOString(), c.id]);
  return 'kept';
}

/** Faltou: o sinal pago fica com a barbearia (desfazer a falta devolve o sinal ao horário). */
export function depositOnNoShow(appointmentId: number, noShow: boolean): void {
  run(`UPDATE charges SET forfeited_at = ${noShow ? '?' : 'NULL'} WHERE appointment_id = ? AND kind = 'sinal' AND status = 'paid' AND sale_id IS NULL`, noShow ? [nowIso(), appointmentId] : [appointmentId]);
}

/** Sinal pago do horário que ainda não foi usado (abatido na comanda). */
export function prepaidDeposit(appointmentId: number): { id: number; amount_cents: number } | null {
  return (
    get<{ id: number; amount_cents: number }>(
      "SELECT id, amount_cents FROM charges WHERE appointment_id = ? AND kind = 'sinal' AND status = 'paid' AND sale_id IS NULL AND forfeited_at IS NULL AND refunded_at IS NULL",
      [appointmentId],
    ) ?? null
  );
}

/** Passou o prazo sem pagar (nem avisar que pagou): libera a vaga e avisa o cliente. */
export async function expireDeposits(shopId: number, now: Date = new Date()): Promise<number> {
  const expired = all<{ id: number; appointment_id: number }>(
    "SELECT id, appointment_id FROM charges WHERE barbershop_id = ? AND kind = 'sinal' AND status = 'open' AND claimed_at IS NULL AND appointment_id IS NOT NULL AND expires_at < ?",
    [shopId, now.toISOString()],
  );
  let n = 0;
  for (const c of expired) {
    const a = get<{ status: string; starts_at: string; customer_id: number; name: string; phone: string; wa_id: string | null }>(
      'SELECT a.status, a.starts_at, a.customer_id, c.name, c.phone, c.wa_id FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?',
      [c.appointment_id],
    );
    run("UPDATE charges SET status = 'cancelled' WHERE id = ?", [c.id]);
    if (!a || a.status !== 'scheduled') continue;
    run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [nowIso(), c.appointment_id]);
    const shop = shopBot(shopId);
    await sendMessage({
      shop,
      customerId: a.customer_id,
      phone: a.phone,
      waId: a.wa_id,
      kind: 'liberado',
      text: `Oi, ${firstName(a.name)}! Como o sinal não foi pago no prazo, liberamos o horário de ${when(a.starts_at)} na ${shop.name}. Se ainda quiser vir, é só marcar de novo.`,
      template: { kind: 'liberado', params: [firstName(a.name), when(a.starts_at), shop.name] },
    });
    n++;
  }
  return n;
}
