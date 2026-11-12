import type { Response } from 'express';
import { config } from './config.js';
import { all, get, run } from './db.js';
import { decodeDataUrl, privateDir, removePrivate, savePrivate, sendPrivate } from './files.js';
import { HttpError } from './http.js';
import { notifyOwners } from './platform.js';

/**
 * Comprovante do PIX: o cliente manda a foto ou o PDF pela área dele e a barbearia recebe uma cópia
 * (no painel, junto do pagamento a conferir, e um aviso no WhatsApp do dono). O arquivo fica fora da
 * pasta pública /uploads: só o próprio cliente e a barbearia abrem, com login.
 */

export const receiptsDir = privateDir('receipts');

export const RECEIPT_MAX_BYTES = 3 * 1024 * 1024;
const INVALID = 'Envie uma foto (JPG, PNG ou WEBP) ou o PDF do comprovante.';

const removeFile = (name: string | null | undefined) => removePrivate(receiptsDir, name);

interface ReceiptRow {
  id: number;
  barbershop_id: number;
  customer_id: number;
  status: string;
  receipt_file: string | null;
  receipt_type: string | null;
  receipt_at: string | null;
}

/**
 * O cliente envia o comprovante de uma cobrança em aberto: guarda o arquivo (troca o anterior, se
 * tinha) e vale como "já paguei". Devolve se é para avisar o dono (não repete o aviso em 10 minutos).
 */
export function saveReceipt(shopId: number, customerId: number, chargeId: number, dataUrl: string, now: Date = new Date()): { notify: boolean } {
  const { bytes, type } = decodeDataUrl(dataUrl, {
    accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: RECEIPT_MAX_BYTES,
    invalid: INVALID,
    tooBig: 'Arquivo muito grande (máximo 3 MB). Mande um print da tela do comprovante.',
  });
  const c = get<ReceiptRow>('SELECT id, barbershop_id, customer_id, status, receipt_file, receipt_type, receipt_at FROM charges WHERE id = ?', [chargeId]);
  if (!c || c.barbershop_id !== shopId || c.customer_id !== customerId) throw new HttpError(404, 'Cobrança não encontrada.');
  if (c.status !== 'open') throw new HttpError(409, c.status === 'paid' ? 'Esse pagamento já foi confirmado pela barbearia.' : 'Essa cobrança foi cancelada.');

  const name = savePrivate(receiptsDir, `${shopId}-${chargeId}`, bytes, type);
  const at = now.toISOString();
  let changes = 0;
  try {
    changes = run(
      "UPDATE charges SET receipt_file = ?, receipt_type = ?, receipt_at = ?, claimed_at = COALESCE(claimed_at, ?) WHERE id = ? AND status = 'open'",
      [name, type, at, at, chargeId],
    ).changes;
  } finally {
    if (!changes) removeFile(name);
  }
  if (!changes) throw new HttpError(409, 'Essa cobrança não está mais em aberto.');
  removeFile(c.receipt_file);
  return { notify: !c.receipt_at || now.getTime() - Date.parse(c.receipt_at) > 10 * 60000 };
}

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** A cópia da barbearia: aviso no WhatsApp do dono para conferir o PIX no extrato e confirmar no painel. */
export async function notifyReceipt(chargeId: number): Promise<void> {
  const c = get<{ shop_id: number; shop: string; customer: string; description: string; amount_cents: number }>(
    `SELECT b.id AS shop_id, b.name AS shop, cu.name AS customer, ch.description, ch.amount_cents
       FROM charges ch JOIN barbershops b ON b.id = ch.barbershop_id JOIN customers cu ON cu.id = ch.customer_id WHERE ch.id = ?`,
    [chargeId],
  );
  if (!c) return;
  const value = money(c.amount_cents);
  const link = `${config.appUrl}/painel?conferir=1`;
  await notifyOwners(c.shop_id, `🧾 Comprovante de PIX na ${c.shop}: ${c.customer} pagou ${value} (${c.description}). Confira no extrato e confirme no painel: ${link}`, {
    kind: 'comprovante',
    params: [c.shop, c.customer, value, c.description, link],
  });
}

/** O que a tela precisa saber do comprovante (sem o nome do arquivo guardado). */
export const receiptInfo = (c: { receipt_file?: string | null; receipt_type?: string | null; receipt_at?: string | null }) =>
  c.receipt_file && c.receipt_type && c.receipt_at ? { type: c.receipt_type, at: c.receipt_at } : null;

/** Abre o comprovante (imagem na tela; PDF baixa). Quem chama já conferiu que pode ver esta cobrança. */
export function sendReceipt(res: Response, c: { id: number; receipt_file: string | null; receipt_type: string | null }): void {
  if (!c.receipt_file) throw new HttpError(404, 'Comprovante não encontrado.');
  sendPrivate(res, receiptsDir, c.receipt_file, c.receipt_type, `comprovante-${c.id}`);
}

/** Tira o comprovante da cobrança e apaga o arquivo. */
export function dropReceipt(chargeId: number): void {
  const c = get<{ receipt_file: string | null }>('SELECT receipt_file FROM charges WHERE id = ?', [chargeId]);
  if (!c?.receipt_file) return;
  run('UPDATE charges SET receipt_file = NULL, receipt_type = NULL, receipt_at = NULL WHERE id = ?', [chargeId]);
  removeFile(c.receipt_file);
}

/** Apaga os comprovantes de um cliente (exclusão da conta) ou os enviados antes de uma data (limpeza). */
export function purgeReceipts(filter: { customerId: number } | { before: string }): number {
  const rows =
    'customerId' in filter
      ? all<{ id: number }>('SELECT id FROM charges WHERE customer_id = ? AND receipt_file IS NOT NULL', [filter.customerId])
      : all<{ id: number }>('SELECT id FROM charges WHERE receipt_file IS NOT NULL AND receipt_at < ?', [filter.before]);
  for (const r of rows) dropReceipt(r.id);
  return rows.length;
}
