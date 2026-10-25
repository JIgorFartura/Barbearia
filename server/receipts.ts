import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { config } from './config.js';
import { all, get, run } from './db.js';
import { HttpError } from './http.js';
import { notifyOwners } from './platform.js';

/**
 * Comprovante do PIX: o cliente manda a foto ou o PDF pela área dele e a barbearia recebe uma cópia
 * (no painel, junto do pagamento a conferir, e um aviso no WhatsApp do dono). O arquivo fica fora da
 * pasta pública /uploads: só o próprio cliente e a barbearia abrem, com login.
 */

export const receiptsDir = path.join(config.dataDir, 'receipts');

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' } as const;
type ReceiptType = keyof typeof TYPES;
export const RECEIPT_MAX_BYTES = 3 * 1024 * 1024;
const INVALID = 'Envie uma foto (JPG, PNG ou WEBP) ou o PDF do comprovante.';

/** Confere o tipo pelo conteúdo do arquivo (não pelo nome nem pelo que o navegador diz). */
function sniff(bytes: Buffer): ReceiptType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

const SAFE_NAME = /^[\w.-]+$/;
const removeFile = (name: string | null | undefined) => {
  if (name && SAFE_NAME.test(name)) fs.rmSync(path.join(receiptsDir, name), { force: true });
};

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
  const m = /^data:[\w.+-]+\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, INVALID);
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > RECEIPT_MAX_BYTES) throw new HttpError(400, 'Arquivo muito grande (máximo 3 MB). Mande um print da tela do comprovante.');
  const type = sniff(bytes);
  if (!type) throw new HttpError(400, INVALID);
  const c = get<ReceiptRow>('SELECT id, barbershop_id, customer_id, status, receipt_file, receipt_type, receipt_at FROM charges WHERE id = ?', [chargeId]);
  if (!c || c.barbershop_id !== shopId || c.customer_id !== customerId) throw new HttpError(404, 'Cobrança não encontrada.');
  if (c.status !== 'open') throw new HttpError(409, c.status === 'paid' ? 'Esse pagamento já foi confirmado pela barbearia.' : 'Essa cobrança foi cancelada.');

  fs.mkdirSync(receiptsDir, { recursive: true });
  const name = `${shopId}-${chargeId}-${crypto.randomBytes(8).toString('hex')}.${TYPES[type]}`;
  fs.writeFileSync(path.join(receiptsDir, name), bytes, { mode: 0o600 });
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
  const file = c.receipt_file && SAFE_NAME.test(c.receipt_file) ? path.join(receiptsDir, c.receipt_file) : null;
  if (!file || !c.receipt_type || !fs.existsSync(file)) throw new HttpError(404, 'Comprovante não encontrado.');
  const pdf = c.receipt_type === 'application/pdf';
  res.setHeader('content-type', c.receipt_type);
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-disposition', `${pdf ? 'attachment' : 'inline'}; filename="comprovante-${c.id}${path.extname(file)}"`);
  res.sendFile(file);
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
