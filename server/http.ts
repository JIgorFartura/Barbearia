import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

z.config(z.locales.pt());

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
    throw new HttpError(400, msg);
  }
  return result.data;
}

export function idParam(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identificador inválido.');
  return id;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof HttpError ? err.status : ((err as { status?: number }).status ?? 500);
  const message = err instanceof Error ? err.message : 'Erro inesperado.';
  if (status >= 500) console.error('[api]', err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Erro interno.' : message });
}

// Campos reaproveitados pelos formulários.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

export const zText = optionalText;
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor no formato #RRGGBB.');
export const zDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD.')
  .nullish()
  .or(z.literal(''))
  .transform((v) => v || null);
/** Só http(s) ou arquivo enviado (/uploads/...): evita links "javascript:" no site público. */
export const zUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\//i.test(v) || /^\/uploads\/[\w.-]+$/.test(v), 'Endereço deve começar com https://')
  .nullish()
  .transform((v) => v || null);
export const zCents = z.number().int().min(0).max(100_000_000);
export const zBool = z.boolean();
export const zId = z.number().int().positive();

// Limite de pedidos por chave (ex.: IP) numa janela de tempo, em memória.
const hits = new Map<string, { count: number; until: number }>();
export function rateLimit(key: string, max: number, windowMs: number, message: string): void {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.until < now) {
    hits.set(key, { count: 1, until: now + windowMs });
    return;
  }
  if (++entry.count > max) throw new HttpError(429, message);
}

/** Celular só com dígitos (com DDD). */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  const local = digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
  if (local.length < 10 || local.length > 11) throw new HttpError(400, 'Celular com DDD, ex.: (11) 98888-7777.');
  return local;
}
