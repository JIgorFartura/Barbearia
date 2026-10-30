import { cancelInvoiceEverywhere } from './asaas.js';
import { CYCLE_MONTHS, ensureInvoices, isPeriodRef, listInvoices, setupFreeFor, shopBilling, type Cycle } from './billing.js';
import { stopSubscriptionCard } from './cards.js';
import { run } from './db.js';
import { localNow } from './time.js';

/**
 * Troca o período da cobrança (mensal, trimestral, semestral ou anual). Para um período: a mensalidade
 * do mês que ainda não venceu é cancelada (vira a fatura do período), o cartão automático mensal é
 * desligado e a fatura sai na hora; no semestral e no anual, a implantação ainda não paga sai de graça.
 * O período em aberto de outro ciclo é cancelado; o já pago vale até o fim dele.
 */
export async function setBillingCycle(shopId: number, cycle: Cycle, now: Date = new Date()): Promise<void> {
  if (shopBilling(shopId).billing_cycle === cycle) return;
  run('UPDATE barbershops SET billing_months = ? WHERE id = ?', [CYCLE_MONTHS[cycle], shopId]);
  const today = localNow(now).date;
  const open = listInvoices({ shopId, status: 'open' }, now);
  for (const inv of open.filter((i) => isPeriodRef(i.reference) && !i.reference.startsWith(`${cycle}:`))) await cancelInvoiceEverywhere(inv.id);
  if (cycle !== 'mensal') {
    for (const inv of open.filter((i) => /^\d{4}-\d{2}$/.test(i.reference) && i.due_date >= today)) await cancelInvoiceEverywhere(inv.id);
    if (setupFreeFor(cycle)) for (const inv of open.filter((i) => i.reference === 'implantacao')) await cancelInvoiceEverywhere(inv.id);
    await stopSubscriptionCard(shopId);
  }
  ensureInvoices(now, shopId);
}
