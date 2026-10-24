import QRCode from 'qrcode';
import { shopNow } from './clock.js';
import { all, get, nowIso, run, tx } from './db.js';
import type { Method } from './finance.js';
import { HttpError } from './http.js';
import { pixPayload } from './pix.js';

/**
 * Cobranças PIX da barbearia para o cliente: mensalidade do clube e sinal de agendamento.
 * O PIX vai direto para a chave da barbearia (sem intermediário). O cliente avisa que pagou
 * ("Já paguei" na área dele ou "paguei" no WhatsApp) e a barbearia confirma no painel:
 * só então o valor entra no caixa.
 */

export interface ChargeView {
  id: number;
  barbershop_id: number;
  kind: 'clube' | 'sinal';
  customer_id: number;
  customer_name: string;
  phone: string;
  wa_id: string | null;
  description: string;
  amount_cents: number;
  status: 'open' | 'paid' | 'cancelled';
  claimed_at: string | null;
  paid_at: string | null;
  method: string | null;
  club_member_id: number | null;
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  reminded_at: string | null;
  appointment_id: number | null;
  expires_at: string | null;
  sale_id: number | null;
  forfeited_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

const SELECT = 'SELECT ch.*, c.name AS customer_name, c.phone, c.wa_id FROM charges ch JOIN customers c ON c.id = ch.customer_id';

export function charge(id: number, shopId?: number): ChargeView {
  const c = get<ChargeView>(`${SELECT} WHERE ch.id = ?${shopId ? ' AND ch.barbershop_id = ?' : ''}`, shopId ? [id, shopId] : [id]);
  if (!c) throw new HttpError(404, 'Cobrança não encontrada.');
  return c;
}

export interface PixSettings {
  pix_key: string | null;
  pix_name: string | null;
  pix_city: string | null;
}

export const pixSettings = (shopId: number) => get<PixSettings>('SELECT pix_key, pix_name, pix_city FROM barbershops WHERE id = ?', [shopId])!;

export function savePixSettings(shopId: number, s: PixSettings): PixSettings {
  run('UPDATE barbershops SET pix_key = ?, pix_name = ?, pix_city = ? WHERE id = ?', [s.pix_key, s.pix_name, s.pix_city, shopId]);
  return pixSettings(shopId);
}

/** PIX copia e cola da cobrança em aberto (null se a barbearia não cadastrou a chave). */
export function chargePayload(c: ChargeView): string | null {
  if (c.status !== 'open') return null;
  const s = get<PixSettings & { name: string }>('SELECT name, pix_key, pix_name, pix_city FROM barbershops WHERE id = ?', [c.barbershop_id]);
  if (!s?.pix_key) return null;
  return pixPayload({
    key: s.pix_key,
    name: s.pix_name || s.name,
    city: s.pix_city || 'Brasil',
    amountCents: c.amount_cents,
    txid: `${c.kind === 'clube' ? 'CLUBE' : 'SINAL'}${c.id}`,
  });
}

/** PIX copia e cola + QR Code, para mostrar na tela. */
export async function chargePix(c: ChargeView): Promise<{ payload: string; qr: string } | null> {
  const payload = chargePayload(c);
  return payload ? { payload, qr: await QRCode.toDataURL(payload, { margin: 1, width: 260 }) } : null;
}

/** O cliente avisa que pagou (a barbearia confere no extrato e confirma). */
export function claimCharge(shopId: number, customerId: number, chargeId: number, now: Date = new Date()): ChargeView {
  const { changes } = run("UPDATE charges SET claimed_at = COALESCE(claimed_at, ?) WHERE id = ? AND barbershop_id = ? AND customer_id = ? AND status = 'open'", [
    now.toISOString(),
    chargeId,
    shopId,
    customerId,
  ]);
  if (!changes) throw new HttpError(404, 'Cobrança em aberto não encontrada.');
  return charge(chargeId);
}

/** "Paguei" no WhatsApp: vale para a cobrança em aberto mais recente que ainda não foi avisada. */
export function claimLatest(shopId: number, customerId: number, now: Date = new Date()): ChargeView | null {
  const c = get<{ id: number }>("SELECT id FROM charges WHERE barbershop_id = ? AND customer_id = ? AND status = 'open' AND claimed_at IS NULL ORDER BY id DESC LIMIT 1", [
    shopId,
    customerId,
  ]);
  return c ? claimCharge(shopId, customerId, c.id, now) : null;
}

/** Pagamentos que os clientes avisaram e a barbearia ainda não conferiu. */
export const chargesToConfirm = (shopId: number): ChargeView[] =>
  all<ChargeView>(`${SELECT} WHERE ch.barbershop_id = ? AND ch.status = 'open' AND ch.claimed_at IS NOT NULL ORDER BY ch.claimed_at`, [shopId]);

/** Caiu na conta: entra no caixa e libera o que a cobrança paga (mês do clube ou o horário). */
export function confirmCharge(shopId: number, chargeId: number, opts: { method: Method; userId: number | null; now?: Date }): ChargeView {
  return tx(() => {
    const c = charge(chargeId, shopId);
    if (c.status !== 'open') throw new HttpError(409, c.status === 'paid' ? 'Esse pagamento já foi confirmado.' : 'Essa cobrança foi cancelada.');
    const now = opts.now ?? new Date();
    run("UPDATE charges SET status = 'paid', paid_at = ?, method = ? WHERE id = ?", [now.toISOString(), opts.method, chargeId]);
    run(
      `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, charge_id, created_by, created_at)
       VALUES (?, 'in', ?, ?, ?, ?, ?, 'paid', ?, ?, ?)`,
      [
        shopId,
        c.kind === 'clube' ? 'Clube de assinatura' : 'Atendimentos',
        `${c.description} · ${c.customer_name}`,
        c.amount_cents,
        opts.method,
        shopNow(shopId, now).date,
        chargeId,
        opts.userId,
        nowIso(),
      ],
    );
    if (c.club_member_id) {
      run("UPDATE club_members SET paid_until = MAX(COALESCE(paid_until, ''), ?), status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = ?", [
        c.period_end,
        c.club_member_id,
      ]);
    }
    return charge(chargeId);
  });
}

/** Confirmou por engano: tira do caixa e a cobrança volta a ficar em aberto. */
export function undoConfirm(shopId: number, chargeId: number): ChargeView {
  return tx(() => {
    const c = charge(chargeId, shopId);
    if (c.status !== 'paid') throw new HttpError(409, 'Esse pagamento não está confirmado.');
    if (c.sale_id) throw new HttpError(409, 'Esse sinal já foi abatido numa venda. Cancele a venda antes.');
    if (c.refunded_at) throw new HttpError(409, 'Esse sinal já foi devolvido ao cliente.');
    if (get("SELECT 1 AS ok FROM gateway_payments WHERE charge_id = ? AND applied = 1", [chargeId])) {
      throw new HttpError(409, 'Esse pagamento foi feito online e baixado sozinho; não dá para desfazer. Para devolver ao cliente, peça o estorno à plataforma.');
    }
    run("UPDATE charges SET status = 'open', paid_at = NULL, method = NULL, forfeited_at = NULL WHERE id = ?", [chargeId]);
    run('DELETE FROM cash_entries WHERE charge_id = ?', [chargeId]);
    if (c.club_member_id) {
      const last = get<{ until: string | null }>("SELECT MAX(period_end) AS until FROM charges WHERE club_member_id = ? AND status = 'paid'", [c.club_member_id])?.until ?? null;
      run("UPDATE club_members SET paid_until = ?, status = CASE WHEN ? IS NULL AND status = 'active' THEN 'pending' ELSE status END WHERE id = ?", [
        last,
        last,
        c.club_member_id,
      ]);
    }
    return charge(chargeId);
  });
}

/** Não caiu na conta: volta a ficar em aberto, à espera do pagamento. */
export function rejectClaim(shopId: number, chargeId: number): ChargeView {
  const { changes } = run("UPDATE charges SET claimed_at = NULL WHERE id = ? AND barbershop_id = ? AND status = 'open' AND claimed_at IS NOT NULL", [chargeId, shopId]);
  if (!changes) throw new HttpError(404, 'Aviso de pagamento não encontrado.');
  return charge(chargeId);
}
