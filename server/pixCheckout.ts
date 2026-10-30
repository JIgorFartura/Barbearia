import { AsaasError } from './asaas.js';
import { shopNow } from './clock.js';
import { get, run, tx } from './db.js';
import { addEntry, createSale, previewSale, type SaleInput, type SaleResult } from './finance.js';
import { HttpError } from './http.js';
import { ensureCustomer, normalizeCpf, qrFrom, saveCustomerCpf, shopAsaasCall, shopAsaasOn } from './shopAsaas.js';

/**
 * PIX na comanda com confirmação automática. A comanda fica esperando o pagamento (nada entra no
 * caixa); o QR sai da conta Asaas da barbearia e, quando o Asaas avisa que o PIX caiu, a venda é
 * registrada sozinha: caixa, comissão, carimbos e baixa do estoque, como se tivesse sido fechada na hora.
 */

/** A comanda como foi montada na tela (vira a venda quando o PIX cai). */
export type PixSaleInput = Pick<SaleInput, 'appointmentId' | 'customerId' | 'items' | 'discountCents' | 'giftCode' | 'giftCents' | 'notes'>;

export interface PixCheckoutView {
  id: number;
  status: 'pending' | 'paid' | 'cancelled';
  amount_cents: number;
  payload: string | null;
  qr: string | null;
  sale: { id: number; total_cents: number; gift_cents: number } | null;
  stamps: SaleResult['stamps'];
  error: string | null;
}

interface Row {
  id: number;
  barbershop_id: number;
  user_id: number | null;
  payload: string;
  amount_cents: number;
  asaas_payment_id: string | null;
  pix_payload: string | null;
  pix_qr: string | null;
  status: PixCheckoutView['status'];
  sale_id: number | null;
  stamps: string | null;
  error: string | null;
}

const rowOf = (shopId: number, id: number) => get<Row>('SELECT * FROM pix_checkouts WHERE id = ? AND barbershop_id = ?', [id, shopId]);

export function pixCheckoutView(shopId: number, id: number): PixCheckoutView {
  const r = rowOf(shopId, id);
  if (!r) throw new HttpError(404, 'PIX da comanda não encontrado.');
  const sale = r.sale_id
    ? get<{ id: number; total_cents: number; gift_cents: number }>('SELECT id, total_cents, gift_cents FROM sales WHERE id = ?', [r.sale_id]) ?? null
    : null;
  return {
    id: r.id,
    status: r.status,
    amount_cents: r.amount_cents,
    payload: r.status === 'pending' ? r.pix_payload : null,
    qr: r.status === 'pending' ? r.pix_qr : null,
    sale,
    stamps: r.stamps ? (JSON.parse(r.stamps) as SaleResult['stamps']) : [],
    error: r.error,
  };
}

/** Quem paga na conta Asaas da barbearia: o cliente da comanda (com CPF) ou um cliente de balcão. null: falta o CPF. */
async function payerFor(shopId: number, customerId: number | null, payerCpf: string | null): Promise<string | null> {
  if (customerId) {
    if (payerCpf) saveCustomerCpf(shopId, customerId, payerCpf);
    return ensureCustomer(shopId, customerId);
  }
  if (!payerCpf) return null;
  const cpf = normalizeCpf(payerCpf);
  if (!cpf) throw new HttpError(400, 'CPF inválido. Confira os números.');
  const r = await shopAsaasCall<{ id: string }>(shopId, 'POST', '/customers', { name: 'Cliente do balcão', cpfCnpj: cpf, notificationDisabled: true });
  return r.id;
}

/**
 * Gera o PIX da comanda. A venda é conferida antes (itens, estoque, vale-presente) com o mesmo cálculo
 * do registro, sem gravar nada; o valor do PIX é o total menos o que o vale-presente paga.
 */
export async function startPixCheckout(
  shopId: number,
  userId: number,
  input: PixSaleInput,
  payerCpf: string | null,
  now: Date = new Date(),
): Promise<PixCheckoutView | { needsCpf: true }> {
  if (!shopAsaasOn(shopId)) {
    throw new HttpError(409, 'Para o PIX com confirmação automática, ligue o Asaas da barbearia (Clube de assinatura → PIX com baixa automática).');
  }
  const sale = previewSale({ ...input, shopId, userId, method: 'pix', now });
  const amount = sale.total_cents - sale.gift_cents;
  if (amount <= 0) throw new HttpError(400, 'Não sobra nada para pagar no PIX: registre a venda normalmente.');
  const customerId = sale.customer_id ?? null;

  let asaasCustomer: string | null;
  try {
    asaasCustomer = await payerFor(shopId, customerId, payerCpf);
  } catch (err) {
    if (err instanceof AsaasError) throw new HttpError(502, `O Asaas recusou: ${err.message}`);
    throw err;
  }
  if (!asaasCustomer) return { needsCpf: true };

  const id = run('INSERT INTO pix_checkouts (barbershop_id, user_id, customer_id, payload, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    shopId,
    userId,
    customerId,
    JSON.stringify(input),
    amount,
    now.toISOString(),
  ]).lastInsertRowid;
  try {
    const payment = await shopAsaasCall<{ id: string }>(shopId, 'POST', '/payments', {
      customer: asaasCustomer,
      billingType: 'PIX',
      value: amount / 100,
      dueDate: shopNow(shopId, now).date,
      description: `Comanda #${id}`,
      externalReference: `comanda:${id}`,
    });
    run('UPDATE pix_checkouts SET asaas_payment_id = ? WHERE id = ?', [payment.id, id]);
    const qr = await shopAsaasCall<{ encodedImage?: string; payload: string }>(shopId, 'GET', `/payments/${payment.id}/pixQrCode`);
    run('UPDATE pix_checkouts SET pix_payload = ?, pix_qr = ? WHERE id = ?', [qr.payload, await qrFrom(qr.payload, qr.encodedImage), id]);
  } catch (err) {
    run("UPDATE pix_checkouts SET status = 'cancelled', error = ? WHERE id = ?", [(err as Error).message, id]);
    if (err instanceof AsaasError) throw new HttpError(502, `O Asaas recusou o PIX: ${err.message}`);
    throw err;
  }
  return pixCheckoutView(shopId, id);
}

/** O cliente desistiu (ou pagou de outro jeito): a cobrança sai do Asaas também. */
export async function cancelPixCheckout(shopId: number, id: number): Promise<PixCheckoutView> {
  const r = rowOf(shopId, id);
  if (!r) throw new HttpError(404, 'PIX da comanda não encontrado.');
  if (r.status === 'paid') throw new HttpError(409, 'Esse PIX já foi pago: a venda está registrada.');
  if (r.status === 'pending') {
    run("UPDATE pix_checkouts SET status = 'cancelled' WHERE id = ?", [id]);
    if (r.asaas_payment_id) {
      await shopAsaasCall(shopId, 'DELETE', `/payments/${r.asaas_payment_id}`).catch((err) => console.warn('[asaas da barbearia]', (err as Error).message));
    }
  }
  return pixCheckoutView(shopId, id);
}

/**
 * O Asaas avisou que o PIX caiu: registra a venda (uma vez só, mesmo com os dois avisos de pago).
 * Se a comanda não puder mais virar venda (cancelada na tela, atendimento fechado por outro caminho), o
 * valor entra no caixa mesmo assim, com o motivo, para o dono conferir: dinheiro recebido nunca some.
 */
export function settlePixCheckout(shopId: number, id: number | null, paymentId: string, now: Date = new Date()): { saleId: number | null } {
  return tx(() => {
    const r =
      (id ? rowOf(shopId, id) : undefined) ??
      get<Row>('SELECT * FROM pix_checkouts WHERE barbershop_id = ? AND asaas_payment_id = ?', [shopId, paymentId]);
    if (!r || r.status === 'paid') return { saleId: r?.sale_id ?? null };
    const input = JSON.parse(r.payload) as PixSaleInput;
    try {
      // Cancelado na tela e pago mesmo assim: a comanda pode ter sido fechada de outro jeito.
      if (r.status === 'cancelled') throw new HttpError(409, 'pago depois de cancelado');
      const result = createSale({ ...input, shopId, userId: r.user_id, method: 'pix', now });
      run("UPDATE pix_checkouts SET status = 'paid', sale_id = ?, stamps = ?, error = NULL, paid_at = ? WHERE id = ?", [
        result.sale.id,
        JSON.stringify(result.stamps),
        now.toISOString(),
        r.id,
      ]);
      return { saleId: result.sale.id };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      addEntry(
        shopId,
        {
          type: 'in',
          category: 'Atendimentos',
          description: `PIX da comanda #${r.id} (conferir: ${err.message})`,
          amount_cents: r.amount_cents,
          method: 'pix',
          date: shopNow(shopId, now).date,
          status: 'paid',
        },
        r.user_id,
      );
      run("UPDATE pix_checkouts SET status = 'paid', error = ?, paid_at = ? WHERE id = ?", [err.message, now.toISOString(), r.id]);
      return { saleId: null };
    }
  });
}
