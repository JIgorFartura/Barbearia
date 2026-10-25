import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { config } from './config.js';
import { HttpError } from './http.js';

/**
 * Arquivos privados (comprovantes do PIX, fotos do corte): ficam fora da pasta pública /uploads e só
 * saem por rotas com login, que conferem quem pode ver. O tipo é conferido pelo conteúdo do arquivo.
 */

export const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' } as const;
export type FileType = keyof typeof FILE_TYPES;

/** Confere o tipo pelo conteúdo (não pelo nome nem pelo que o navegador diz). */
export function sniff(bytes: Buffer): FileType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** "data:...;base64,..." → bytes e tipo conferido; recusa o que não for dos tipos aceitos ou passar do tamanho. */
export function decodeDataUrl(dataUrl: string, opts: { accept: FileType[]; maxBytes: number; invalid: string; tooBig: string }): { bytes: Buffer; type: FileType } {
  const m = /^data:[\w.+-]+\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, opts.invalid);
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > opts.maxBytes) throw new HttpError(400, opts.tooBig);
  const type = sniff(bytes);
  if (!type || !opts.accept.includes(type)) throw new HttpError(400, opts.invalid);
  return { bytes, type };
}

const SAFE_NAME = /^[\w.-]+$/;

/** Pasta privada dentro de DATA_DIR (receipts, photos...). */
export const privateDir = (name: string) => path.join(config.dataDir, name);

/** Grava com nome aleatório (prefixo para achar de quem é) e devolve o nome. */
export function savePrivate(dir: string, prefix: string, bytes: Buffer, type: FileType): string {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${prefix}-${crypto.randomBytes(8).toString('hex')}.${FILE_TYPES[type]}`;
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
  return name;
}

export function removePrivate(dir: string, name: string | null | undefined): void {
  if (name && SAFE_NAME.test(name)) fs.rmSync(path.join(dir, name), { force: true });
}

/** Manda o arquivo (imagem abre na tela; PDF baixa). Quem chama já conferiu que a pessoa pode ver. */
export function sendPrivate(res: Response, dir: string, name: string | null, type: string | null, downloadName: string): void {
  const file = name && SAFE_NAME.test(name) ? path.join(dir, name) : null;
  if (!file || !type || !fs.existsSync(file)) throw new HttpError(404, 'Arquivo não encontrado.');
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-disposition', `${type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${downloadName}${path.extname(file)}"`);
  res.sendFile(file);
}
