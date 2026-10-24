import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, parseBody } from '../http.js';

/** Envio de imagens (logo, capa, fotos de produto e anúncios). Guarda em DATA_DIR/uploads. */
export const uploadsRouter = Router();

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024;

uploadsRouter.post('/', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Faça login para continuar.');
  const { dataUrl } = parseBody(z.object({ dataUrl: z.string() }), req.body);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new HttpError(400, 'Envie uma imagem PNG, JPG ou WEBP.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_BYTES) throw new HttpError(400, 'Imagem muito grande (máximo 3 MB).');
  const name = `${crypto.randomBytes(12).toString('hex')}.${TYPES[match[1]]}`;
  fs.writeFileSync(path.join(config.uploadsDir, name), bytes);
  res.status(201).json({ url: `/uploads/${name}` });
});
