import { cancelInvoiceEverywhere } from './asaas.js';
import { ensureInvoices, listInvoices, platformSettings, shopBilling } from './billing.js';
import { stopSubscriptionCard } from './cards.js';
import { run } from './db.js';
import { localNow } from './time.js';

/**
 * Troca o ciclo da mensalidade. Para o anual: a mensalidade do mês que ainda não venceu é cancelada
 * (vira a fatura anual), o cartão automático mensal é desligado e a fatura anual sai na hora. Para o
 * mensal: o anual ainda não pago é cancelado (o já pago vale até o fim do período).
 */
export async function setBillingCycle(shopId: number, cycle: 'mensal' | 'anual', now: Date = new Date()): Promise<void> {
  if (shopBilling(shopId).billing_cycle === cycle) return;
  run('UPDATE barbershops SET billing_cycle = ? WHERE id = ?', [cycle, shopId]);
  const today = localNow(now).date;
  const open = listInvoices({ shopId, status: 'open' }, now);
  if (cycle === 'anual') {
    for (const inv of open.filter((i) => /^\d{4}-\d{2}$/.test(i.reference) && i.due_date >= today)) await cancelInvoiceEverywhere(inv.id);
    // No anual a implantação sai grátis (se ainda não foi paga).
    if (platformSettings().setup_free_on_annual) for (const inv of open.filter((i) => i.reference === 'implantacao')) await cancelInvoiceEverywhere(inv.id);
    await stopSubscriptionCard(shopId);
  } else {
    for (const inv of open.filter((i) => i.reference.startsWith('anual:'))) await cancelInvoiceEverywhere(inv.id);
  }
  ensureInvoices(now, shopId);
}
