import { asaasSettings, invoicePaidByAsaas, markWebhookSeen, sameToken, type AsaasPayment } from './asaas.js';
import { get, run } from './db.js';
import { updateGatewayPayment } from './gatewayPayments.js';
import { HttpError } from './http.js';

/**
 * Avisos do Asaas da plataforma (webhook): mensalidade paga e nota fiscal. Responde rápido e nunca
 * devolve erro por regra de negócio (fatura já cancelada etc.), senão o Asaas pausa a fila de avisos;
 * só o token errado é recusado.
 */

interface AsaasEvent {
  event?: string;
  payment?: AsaasPayment;
  invoice?: { id?: string; status?: string; pdfUrl?: string | null };
}

export function handleAsaasEvent(token: string | undefined, body: AsaasEvent): { ok: true; invoiceId?: number; note?: string } {
  const s = asaasSettings();
  if (!s.webhookToken || !token || !sameToken(token, s.webhookToken)) throw new HttpError(401, 'Token do webhook inválido.');
  markWebhookSeen();
  const event = body.event ?? '';
  const p = body.payment;

  if (event.startsWith('PAYMENT_') && p?.id) {
    // Registro dos pagamentos online (o que o master vê): situação, forma usada e valor líquido.
    const gp = updateGatewayPayment(p.id, event, p);
    if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
      // A cobrança some da fatura quando ela é paga no cartão (Cielo): o registro guarda de qual fatura era.
      // Cartão parcelado: qualquer parcela aprovada identifica a fatura pelo parcelamento.
      const inv =
        get<{ id: number }>('SELECT id FROM invoices WHERE asaas_payment_id = ?', [p.id]) ??
        (gp?.invoice_id ? { id: gp.invoice_id } : undefined) ??
        (p.installment ? get<{ id: number }>('SELECT id FROM invoices WHERE asaas_installment_id = ?', [p.installment]) : undefined);
      if (inv) {
        const r = invoicePaidByAsaas(inv.id, p);
        if (gp && !r.note) run('UPDATE gateway_payments SET applied = 1 WHERE id = ?', [gp.id]);
        // Já estava paga (o master confirmou outro pagamento) e não foi a baixa manual repassada ao
        // Asaas: pago em dobro, o master devolve para a barbearia.
        else if (gp && !gp.applied && r.note === 'fatura paid' && p.status !== 'RECEIVED_IN_CASH') run('UPDATE gateway_payments SET duplicate = 1 WHERE id = ?', [gp.id]);
        return r;
      }
      return { ok: true, note: 'cobrança desconhecida' };
    }
    return { ok: true, note: gp ? 'situação atualizada' : 'cobrança desconhecida' };
  }

  if (event.startsWith('INVOICE_') && body.invoice?.id) {
    run('UPDATE invoices SET nfse_status = ?, nfse_url = COALESCE(?, nfse_url) WHERE nfse_id = ?', [body.invoice.status ?? event, body.invoice.pdfUrl ?? null, body.invoice.id]);
    return { ok: true };
  }
  return { ok: true, note: 'evento ignorado' };
}
