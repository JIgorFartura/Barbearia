import type { Response } from 'express';
import { z } from 'zod';
import { all, get, run } from './db.js';
import { decodeDataUrl, privateDir, removePrivate, savePrivate, sendPrivate, type FileType } from './files.js';
import { HttpError, zId, zText } from './http.js';

/**
 * Ficha do cliente: as preferências anotadas ("máquina 2 nas laterais, tesoura em cima") e as fotos do
 * corte. Aparece no cartão do horário para o dono e para o barbeiro (na próxima visita, mesmo com
 * outro barbeiro, ele sabe o que fazer). O cliente vê as fotos dele na área e pode apagar.
 * As fotos ficam fora da pasta pública: só saem com login.
 */

export const photosDir = privateDir('photos');
/** Até tantas fotos por cliente: a mais antiga sai quando chega uma nova. */
const MAX_PHOTOS = 30;
const IMAGES: FileType[] = ['image/jpeg', 'image/png', 'image/webp'];

/** O que a tela manda ao enviar uma foto (a descrição do corte o cliente também vê). */
export const zPhoto = z.object({
  dataUrl: z.string().max(5_000_000),
  thumbUrl: z.string().max(400_000).nullish(),
  appointment_id: zId.nullish(),
  note: zText(200),
});
export const zNotes = z.object({ notes: zText(1000) });

export interface PhotoView {
  id: number;
  created_at: string;
  barber_name: string | null;
  note: string | null;
  appointment_id: number | null;
  created_by: number | null;
}

interface PhotoRow {
  id: number;
  customer_id: number;
  created_by: number | null;
  file: string;
  thumb: string | null;
  type: string;
}

/** A foto, se for desta barbearia (e do cliente, quando é ele que pede). */
export function photoOf(shopId: number, photoId: number, opts: { customerId?: number } = {}): PhotoRow {
  const p = get<PhotoRow & { barbershop_id: number }>('SELECT id, barbershop_id, customer_id, created_by, file, thumb, type FROM cut_photos WHERE id = ?', [photoId]);
  if (!p || p.barbershop_id !== shopId || (opts.customerId && p.customer_id !== opts.customerId)) throw new HttpError(404, 'Foto não encontrada.');
  return p;
}

export function customerPhotos(customerId: number): PhotoView[] {
  return all<PhotoView>(
    `SELECT p.id, p.created_at, b.name AS barber_name, p.note, p.appointment_id, p.created_by FROM cut_photos p LEFT JOIN barbers b ON b.id = p.barber_id
      WHERE p.customer_id = ? ORDER BY p.created_at DESC, p.id DESC`,
    [customerId],
  );
}

/**
 * A ficha completa (painel e app do barbeiro). `userId`: quem está vendo, quando só pode apagar as
 * fotos que ele mesmo tirou (o barbeiro); sem ele, pode apagar todas (o dono).
 */
export function customerProfile(shopId: number, customerId: number, opts: { userId?: number } = {}) {
  const c = get<{ id: number; name: string; phone: string; notes: string | null; anonymized_at: string | null }>(
    'SELECT id, name, phone, notes, anonymized_at FROM customers WHERE id = ? AND barbershop_id = ?',
    [customerId, shopId],
  );
  if (!c || c.anonymized_at) throw new HttpError(404, 'Cliente não encontrado.');
  return {
    customer: { id: c.id, name: c.name, phone: c.phone },
    notes: c.notes,
    photos: customerPhotos(customerId).map(({ created_by, ...p }) => ({ ...p, can_delete: opts.userId === undefined || created_by === opts.userId })),
  };
}

/** Resumo para o cartão do horário: as anotações, quantas fotos tem e a última. */
export function profileSummary(customerId: number): { notes: string | null; photos: number; lastPhotoId: number | null } {
  const c = get<{ notes: string | null }>('SELECT notes FROM customers WHERE id = ?', [customerId]);
  const p = get<{ n: number; last: number | null }>(
    'SELECT COUNT(*) AS n, (SELECT id FROM cut_photos WHERE customer_id = :c ORDER BY created_at DESC, id DESC LIMIT 1) AS last FROM cut_photos WHERE customer_id = :c',
    { c: customerId },
  )!;
  return { notes: c?.notes ?? null, photos: p.n, lastPhotoId: p.last };
}

export function saveNotes(shopId: number, customerId: number, notes: string | null): void {
  const { changes } = run('UPDATE customers SET notes = ? WHERE id = ? AND barbershop_id = ? AND anonymized_at IS NULL', [notes?.trim() || null, customerId, shopId]);
  if (!changes) throw new HttpError(404, 'Cliente não encontrado.');
}

/** Foto do corte (tirada no celular do barbeiro ou do dono, já reduzida no aparelho, com a miniatura). */
export function addPhoto(input: {
  shopId: number;
  customerId: number;
  dataUrl: string;
  thumbUrl?: string | null;
  appointmentId?: number | null;
  barberId?: number | null;
  note?: string | null;
  userId: number | null;
  now?: Date;
}): PhotoView {
  if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ? AND anonymized_at IS NULL', [input.customerId, input.shopId])) {
    throw new HttpError(404, 'Cliente não encontrado.');
  }
  // A foto fica ligada ao horário (e ao barbeiro dele), se veio de um.
  let barberId = input.barberId ?? null;
  if (input.appointmentId) {
    const a = get<{ barber_id: number }>('SELECT barber_id FROM appointments WHERE id = ? AND customer_id = ? AND barbershop_id = ?', [
      input.appointmentId,
      input.customerId,
      input.shopId,
    ]);
    if (!a) throw new HttpError(404, 'Horário não encontrado.');
    barberId ??= a.barber_id;
  }
  const invalid = 'Envie uma foto (JPG, PNG ou WEBP).';
  const photo = decodeDataUrl(input.dataUrl, { accept: IMAGES, maxBytes: 3 * 1024 * 1024, invalid, tooBig: 'Foto muito grande (máximo 3 MB).' });
  // A miniatura é sempre JPG (feita na tela).
  const thumb = input.thumbUrl ? decodeDataUrl(input.thumbUrl, { accept: ['image/jpeg'], maxBytes: 300 * 1024, invalid, tooBig: 'Miniatura muito grande.' }) : null;
  const prefix = `${input.shopId}-${input.customerId}`;
  const file = savePrivate(photosDir, prefix, photo.bytes, photo.type);
  const thumbFile = thumb ? savePrivate(photosDir, `${prefix}-mini`, thumb.bytes, thumb.type) : null;
  let id = 0;
  try {
    id = run(
      'INSERT INTO cut_photos (barbershop_id, customer_id, appointment_id, barber_id, file, type, thumb, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [input.shopId, input.customerId, input.appointmentId ?? null, barberId, file, photo.type, thumbFile, input.note?.trim() || null, input.userId, (input.now ?? new Date()).toISOString()],
    ).lastInsertRowid;
  } finally {
    if (!id) removePhotoFiles([file, thumbFile]);
  }
  // Guarda só as mais recentes.
  for (const old of all<{ id: number }>('SELECT id FROM cut_photos WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', [input.customerId, MAX_PHOTOS])) {
    deletePhoto(input.shopId, old.id);
  }
  return customerPhotos(input.customerId).find((p) => p.id === id)!;
}

/** Apaga (o dono, o barbeiro que tirou ou o próprio cliente; quem chama confere). */
export function deletePhoto(shopId: number, photoId: number, opts: { customerId?: number } = {}): void {
  const p = photoOf(shopId, photoId, opts);
  run('DELETE FROM cut_photos WHERE id = ?', [photoId]);
  removePhotoFiles([p.file, p.thumb]);
}

/** Manda a foto (ou a miniatura, se tiver). */
export function sendPhoto(res: Response, shopId: number, photoId: number, opts: { customerId?: number; thumb?: boolean } = {}): void {
  const p = photoOf(shopId, photoId, opts);
  const mini = opts.thumb && p.thumb;
  sendPrivate(res, photosDir, mini || p.file, mini ? 'image/jpeg' : p.type, `corte-${p.id}`);
}

/** O barbeiro só abre a ficha de quem tem (ou teve) horário com ele. */
export function barberSeesCustomer(barberId: number, customerId: number): boolean {
  return Boolean(get('SELECT 1 AS ok FROM appointments WHERE barber_id = ? AND customer_id = ? LIMIT 1', [barberId, customerId]));
}

/** LGPD: na exclusão da conta as fotos saem do banco junto com o resto, e os arquivos logo depois. */
export const photoFilesOf = (customerId: number) =>
  all<{ file: string; thumb: string | null }>('SELECT file, thumb FROM cut_photos WHERE customer_id = ?', [customerId]).flatMap((p) => [p.file, p.thumb]);

export function removePhotoFiles(files: (string | null)[]): void {
  for (const f of files) removePrivate(photosDir, f);
}
