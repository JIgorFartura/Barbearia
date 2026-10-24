import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  dataDir,
  uploadsDir,
  /** ":memory:" nos testes. */
  dbFile: process.env.DB_FILE ?? path.join(dataDir, 'barbearia.db'),
  publicUrl,
  cookieSecure: publicUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  timezone: process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
  isProd,
  /** Endereço usado nos links que o robô manda (área do cliente). Em desenvolvimento, o Vite. */
  appUrl: publicUrl || (isProd ? `http://localhost:${port}` : 'http://localhost:5173'),
  /**
   * Mostra na tela o código de acesso do cliente quando o WhatsApp da barbearia não está conectado.
   * Ligado só em desenvolvimento (ou com DEMO_LOGIN_CODES=1 para demonstrações).
   */
  demoLoginCodes: process.env.DEMO_LOGIN_CODES ? process.env.DEMO_LOGIN_CODES === '1' : !isProd,
  /** Robô: sem chave da Anthropic ele responde com um menu simples. */
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  botModel: process.env.BOT_MODEL ?? 'claude-opus-5-5',
  botEffort: (process.env.BOT_EFFORT ?? 'low') as 'low' | 'medium' | 'high',
  /** Liga as automações (lembretes, recontato). */
  automations: process.env.AUTOMATIONS !== '0',
};

/** Data de hoje (AAAA-MM-DD) no fuso da barbearia. */
export function today(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(date);
}
