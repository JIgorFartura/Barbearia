import { setBillingCycle } from './annual.js';
import { cancelInvoiceEverywhere } from './asaas.js';
import { ensureInvoices, listInvoices, shopBilling } from './billing.js';
import { stopSubscriptionCard } from './cards.js';
import { config } from './config.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { sendPlatformMessage } from './platform.js';
import { addDays, localNow } from './time.js';

/**
 * Fim do teste grátis: o dono é avisado pelo WhatsApp da plataforma (2 dias antes) e, no painel,
 * escolhe continuar (plano mensal com a implantação, ou anual com a implantação grátis) ou cancelar.
 * A cobrança só vence depois do último dia grátis.
 */

const AHEAD_DAYS = 2;
const br = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const firstName = (name: string) => name.split(/\s+/)[0];

const owners = (shopId: number) =>
  all<{ id: number; name: string; phone: string | null }>(
    "SELECT id, name, phone FROM users WHERE role = 'owner' AND (barbershop_id = :s OR id IN (SELECT user_id FROM shop_members WHERE barbershop_id = :s))",
    { s: shopId },
  );

/** Aviso do fim do teste (uma vez por barbearia), para quem ainda não decidiu. */
export async function trialReminders(now: Date = new Date()): Promise<number> {
  const n = localNow(now);
  if (n.time < '08:00' || n.time >= '21:00') return 0;
  const shops = all<{ id: number; name: string; trial_until: string }>(
    `SELECT id, name, trial_until FROM barbershops
      WHERE active = 1 AND trial_decision IS NULL AND trial_notified_at IS NULL AND courtesy_since IS NULL
        AND trial_until IS NOT NULL AND trial_until >= ? AND trial_until <= ?`,
    [n.date, addDays(n.date, AHEAD_DAYS)],
  );
  let sent = 0;
  for (const s of shops) {
    run('UPDATE barbershops SET trial_notified_at = ? WHERE id = ?', [now.toISOString(), s.id]);
    const link = `${config.appUrl}/painel/mensalidade`;
    for (const o of owners(s.id).filter((o) => o.phone)) {
      const r = await sendPlatformMessage({
        phone: o.phone!,
        text: `Olá, ${firstName(o.name)}! O teste grátis da ${s.name} termina em ${br(s.trial_until)}. Quer continuar com o Bladr? Escolha o plano (ou cancele) no painel, na tela Mensalidade: ${link}`,
        kind: 'fatura',
        userId: o.id,
        shopId: s.id,
        template: { kind: 'fim_teste', params: [firstName(o.name), s.name, br(s.trial_until), link] },
      });
      if (r.status !== 'failed') sent++;
    }
  }
  return sent;
}

/**
 * Continuar depois do teste: escolhe mensal ou anual e a primeira cobrança já sai, vencendo no dia
 * seguinte ao último dia grátis (ou hoje, se o teste já acabou). A implantação vem junto no mensal.
 */
export async function continueAfterTrial(shopId: number, cycle: 'mensal' | 'anual', now: Date = new Date()): Promise<void> {
  const s = shopBilling(shopId);
  const today = localNow(now).date;
  const start = s.trial_until && s.trial_until >= today ? addDays(s.trial_until, 1) : today;
  run("UPDATE barbershops SET trial_decision = 'continuar', trial_decided_at = ?, billing_day = ? WHERE id = ?", [nowIso(), Number(start.slice(8, 10)), shopId]);
  await setBillingCycle(shopId, cycle, now);
  // Gera a primeira cobrança como se já fosse o primeiro dia pago (meio-dia, horário de Brasília).
  ensureInvoices(new Date(`${start}T12:00:00-03:00`), shopId);
}

/**
 * Cancelar a contratação (só quem nunca pagou): a barbearia é desativada, as cobranças em aberto
 * somem e o master é avisado com o motivo. Os dados ficam guardados, caso o dono volte.
 */
export async function cancelSignup(shopId: number, reason: string | null): Promise<void> {
  if (get("SELECT 1 AS ok FROM invoices WHERE barbershop_id = ? AND status = 'paid'", [shopId])) {
    throw new HttpError(409, 'Sua barbearia já tem mensalidade paga: para cancelar, fale com a gente pelo WhatsApp.');
  }
  run("UPDATE barbershops SET active = 0, trial_decision = 'cancelar', trial_decided_at = ?, cancel_reason = ? WHERE id = ?", [nowIso(), reason, shopId]);
  for (const inv of listInvoices({ shopId, status: 'open' })) await cancelInvoiceEverywhere(inv.id);
  await stopSubscriptionCard(shopId);
  const shop = shopBilling(shopId);
  for (const m of all<{ id: number; phone: string }>("SELECT id, phone FROM users WHERE role = 'master' AND phone IS NOT NULL")) {
    void sendPlatformMessage({
      phone: m.phone,
      text: `❌ ${shop.name} cancelou a contratação no fim do teste.${reason ? ` Motivo: ${reason}` : ''}`,
      kind: 'aviso',
      userId: m.id,
      shopId,
    });
  }
}
