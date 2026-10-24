import { asaasEnabled } from './asaas.js';
import { platformSettings } from './billing.js';
import { all, run } from './db.js';
import { sendPlatformMessage } from './platform.js';
import { addDays, localNow } from './time.js';

/**
 * Lembrete da mensalidade do sistema pelo WhatsApp da plataforma: alguns dias antes de vencer e,
 * se passar do vencimento, um aviso com a data em que o acesso fica restrito. Um de cada, por fatura.
 */

const BEFORE_DAYS = 3;
const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const firstName = (name: string) => name.split(/\s+/)[0];

export async function invoiceReminders(now: Date = new Date()): Promise<number> {
  const n = localNow(now);
  // Só em horário comercial (horário da plataforma).
  if (n.time < '08:00' || n.time >= '21:00') return 0;
  const auto = asaasEnabled();
  const grace = platformSettings().grace_days;
  const invoices = all<{ id: number; barbershop_id: number; shop: string; amount_cents: number; due_date: string; reminded_at: string | null; overdue_reminded_at: string | null }>(
    `SELECT i.id, i.barbershop_id, b.name AS shop, i.amount_cents, i.due_date, i.reminded_at, i.overdue_reminded_at
       FROM invoices i JOIN barbershops b ON b.id = i.barbershop_id
      WHERE i.status = 'open' AND b.active = 1
        AND ((i.reminded_at IS NULL AND i.due_date >= ? AND i.due_date <= ?) OR (i.overdue_reminded_at IS NULL AND i.due_date < ?))`,
    [n.date, addDays(n.date, BEFORE_DAYS), n.date],
  );
  let sent = 0;
  for (const inv of invoices) {
    const late = inv.due_date < n.date;
    run(`UPDATE invoices SET ${late ? 'overdue_reminded_at' : 'reminded_at'} = ? WHERE id = ?`, [now.toISOString(), inv.id]);
    const owners = all<{ id: number; name: string; phone: string }>("SELECT id, name, phone FROM users WHERE barbershop_id = ? AND role = 'owner' AND phone IS NOT NULL", [
      inv.barbershop_id,
    ]);
    for (const o of owners) {
      const how = auto ? 'pelo PIX da tela Mensalidade, no painel (a baixa é automática)' : 'pelo painel, na tela Mensalidade';
      const text = late
        ? `Olá, ${firstName(o.name)}! A mensalidade do sistema da ${inv.shop} (${money(inv.amount_cents)}) venceu em ${br(inv.due_date)}. Para não ter o acesso restrito a partir de ${br(addDays(inv.due_date, grace + 1))}, pague ${how}.`
        : `Olá, ${firstName(o.name)}! A mensalidade do sistema da ${inv.shop} (${money(inv.amount_cents)}) vence em ${br(inv.due_date)}. Pague ${how}.`;
      const r = await sendPlatformMessage({
        phone: o.phone,
        text,
        kind: 'fatura',
        userId: o.id,
        shopId: inv.barbershop_id,
        template: { kind: 'fatura', params: [firstName(o.name), inv.shop, money(inv.amount_cents), br(inv.due_date)] },
      });
      if (r.status !== 'failed') sent++;
    }
  }
  return sent;
}
