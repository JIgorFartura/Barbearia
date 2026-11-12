import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { all, db, get, nowIso, run } from './db.js';
import { encrypt } from './backupCrypto.js';
import { localNow } from './time.js';

export { decrypt } from './backupCrypto.js';

/**
 * Cópia de segurança do banco (agenda, caixa, clientes de todas as barbearias).
 * - Todo dia, a partir das 3h (horário da plataforma), grava uma cópia compactada em DATA_DIR/backups
 *   e guarda as últimas BACKUP_KEEP (padrão 14).
 * - Com um armazenamento S3 configurado (Cloudflare R2, Backblaze B2, AWS S3, Wasabi...), a cópia e as
 *   imagens enviadas também vão para fora do servidor — é isso que protege se o servidor quebrar.
 *   Com BACKUP_PASSWORD, a cópia enviada vai criptografada (AES-256-GCM).
 */

export const backupsDir = path.join(config.dataDir, 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14));
const DAILY_AT = '03:00';
const NAME = /^barbearia-\d{4}-\d{2}-\d{2}-\d{6}\.db\.gz$/;

export interface RemoteConfig {
  /** Ex.: https://<conta>.r2.cloudflarestorage.com. Vazio = AWS S3. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
}

export function remoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  const bucket = env.BACKUP_S3_BUCKET?.trim();
  const accessKey = env.BACKUP_S3_ACCESS_KEY?.trim();
  const secretKey = env.BACKUP_S3_SECRET_KEY?.trim();
  if (!bucket || !accessKey || !secretKey) return null;
  const endpoint = (env.BACKUP_S3_ENDPOINT ?? '').trim().replace(/\/+$/, '');
  const prefix = (env.BACKUP_S3_PREFIX ?? 'barbearia/').trim().replace(/^\/+/, '');
  return {
    endpoint,
    bucket,
    region: env.BACKUP_S3_REGION?.trim() || (endpoint.includes('r2.cloudflarestorage.com') ? 'auto' : 'us-east-1'),
    accessKey,
    secretKey,
    prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
  };
}

// ---------- assinatura AWS SigV4 (o mesmo padrão em todos os armazenamentos compatíveis com S3)

const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
/** Codifica cada parte do caminho como o S3 espera (mantém as barras). */
const encodePath = (p: string) => p.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

export interface SignInput {
  method: string;
  host: string;
  /** Caminho já no formato final, ex.: /bucket/pasta/arquivo.gz */
  path: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Cabeçalhos extras a assinar (minúsculos). */
  headers?: Record<string, string>;
  payloadHash: string;
  /** AAAAMMDDTHHMMSSZ */
  amzDate: string;
}

/** Devolve os cabeçalhos assinados (Authorization, x-amz-date, x-amz-content-sha256). */
export function signS3(input: SignInput): Record<string, string> {
  const date = input.amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: input.host,
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': input.amzDate,
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonical = [input.method, encodePath(input.path), '', ...names.map((n) => `${n}:${headers[n]}`), '', signedHeaders, input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, date), input.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** Envia um arquivo para o armazenamento (PUT assinado). */
export async function putObject(cfg: RemoteConfig, key: string, body: Buffer, contentType = 'application/octet-stream', fetchImpl: typeof fetch = fetch): Promise<void> {
  // Com endpoint próprio (R2, B2, MinIO): bucket no caminho. Na AWS: bucket no nome do servidor.
  const url = cfg.endpoint ? new URL(`${cfg.endpoint}/${cfg.bucket}/${cfg.prefix}${key}`) : new URL(`https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${cfg.prefix}${key}`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers = signS3({
    method: 'PUT',
    host: url.host,
    path: decodeURIComponent(url.pathname),
    region: cfg.region,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    headers: { 'content-type': contentType },
    payloadHash: sha256Hex(body),
    amzDate,
  });
  const res = await fetchImpl(url, { method: 'PUT', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`Armazenamento recusou (HTTP ${res.status}${code ? ` ${code}` : ''}).`);
  }
}

// ---------- cópia

export interface BackupStatus {
  at: string | null;
  file: string | null;
  bytes: number;
  remote: 'ok' | 'failed' | 'off';
  error: string | null;
  uploadsSent: number;
}

const STATUS_KEY = 'backup_status';

export function backupStatus(): BackupStatus {
  const raw = get<{ value: string }>('SELECT value FROM platform_settings WHERE key = ?', [STATUS_KEY])?.value;
  const empty: BackupStatus = { at: null, file: null, bytes: 0, remote: remoteConfig() ? 'failed' : 'off', error: null, uploadsSent: 0 };
  try {
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch {
    return empty;
  }
}

function saveStatus(s: BackupStatus): void {
  run('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [STATUS_KEY, JSON.stringify(s)]);
}

export function listBackups(): { name: string; bytes: number; at: string }[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((n) => NAME.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(backupsDir, name));
      return { name, bytes: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Caminho de uma cópia local (o nome é conferido: nada de "../"). */
export function backupPath(name: string): string | null {
  if (!NAME.test(name)) return null;
  const file = path.join(backupsDir, name);
  return fs.existsSync(file) ? file : null;
}

/** Fotografia consistente do banco, compactada. */
export function snapshot(): Buffer {
  fs.mkdirSync(backupsDir, { recursive: true });
  const tmp = path.join(backupsDir, `.tmp-${process.pid}-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    return zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Imagens enviadas que ainda não foram para o armazenamento externo (cada uma vai uma vez só). */
async function syncUploads(cfg: RemoteConfig, fetchImpl: typeof fetch): Promise<number> {
  if (!fs.existsSync(config.uploadsDir)) return 0;
  const done = new Set(all<{ name: string }>('SELECT name FROM backup_files').map((r) => r.name));
  let sent = 0;
  for (const name of fs.readdirSync(config.uploadsDir)) {
    if (done.has(name) || !/^[\w.-]+$/.test(name) || sent >= 500) continue;
    const ext = path.extname(name).slice(1);
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    await putObject(cfg, `uploads/${name}`, fs.readFileSync(path.join(config.uploadsDir, name)), type, fetchImpl);
    run('INSERT OR IGNORE INTO backup_files (name, uploaded_at) VALUES (?, ?)', [name, nowIso()]);
    sent++;
  }
  return sent;
}

let busy = false;

/** Faz a cópia agora: grava local, apaga as antigas e envia para fora (se configurado). */
export async function createBackup(opts: { now?: Date; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<BackupStatus> {
  if (busy) return backupStatus();
  busy = true;
  try {
    const now = opts.now ?? new Date();
    const n = localNow(now);
    const name = `barbearia-${n.date}-${n.time.replace(':', '')}${String(now.getUTCSeconds()).padStart(2, '0')}.db.gz`;
    const data = snapshot();
    fs.writeFileSync(path.join(backupsDir, name), data);
    // Guarda as mais recentes (a que acabou de ser feita sempre fica).
    for (const old of listBackups().filter((f) => f.name !== name).slice(KEEP - 1)) fs.rmSync(path.join(backupsDir, old.name), { force: true });

    const status: BackupStatus = { at: now.toISOString(), file: name, bytes: data.length, remote: 'off', error: null, uploadsSent: 0 };
    const cfg = remoteConfig(opts.env);
    if (cfg) {
      const password = (opts.env ?? process.env).BACKUP_PASSWORD ?? '';
      try {
        await putObject(cfg, password ? `${name}.enc` : name, password ? encrypt(data, password) : data, 'application/octet-stream', opts.fetchImpl);
        status.uploadsSent = await syncUploads(cfg, opts.fetchImpl ?? fetch);
        status.remote = 'ok';
      } catch (err) {
        status.remote = 'failed';
        status.error = err instanceof Error ? err.message : String(err);
        console.error('[backup] envio para o armazenamento falhou:', status.error);
      }
    }
    saveStatus(status);
    return status;
  } finally {
    busy = false;
  }
}

/** Chamado a cada minuto: uma cópia por dia, a partir das 3h (horário da plataforma). */
export async function dailyBackup(now: Date = new Date()): Promise<boolean> {
  const n = localNow(now);
  const last = backupStatus().at;
  if (n.time < DAILY_AT || (last && localNow(new Date(last)).date === n.date)) return false;
  await createBackup({ now });
  return true;
}
