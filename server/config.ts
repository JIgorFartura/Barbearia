import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir,
  uploadsDir,
  /** ":memory:" nos testes. */
  dbFile: process.env.DB_FILE ?? path.join(dataDir, 'barbearia.db'),
  publicUrl,
  cookieSecure: publicUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  timezone: process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
  isProd: process.env.NODE_ENV === 'production',
};

/** Data de hoje (AAAA-MM-DD) no fuso da barbearia. */
export function today(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(date);
}
