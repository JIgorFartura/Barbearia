/**
 * Restaura uma cópia de segurança.
 *
 *   npm run restore -- <cópia.db.gz | cópia.db.gz.enc> [--forcar]
 *
 * Grava o banco em DATA_DIR/barbearia.db (padrão: ./data). Pare o sistema antes. Cópias criptografadas
 * (.enc, as que vão para o armazenamento externo) pedem a senha em BACKUP_PASSWORD.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { decrypt } from '../server/backupCrypto.js';

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const force = args.includes('--forcar');
if (!source || !fs.existsSync(source)) {
  console.error('Uso: npm run restore -- <cópia.db.gz | cópia.db.gz.enc> [--forcar]');
  process.exit(1);
}

let data = fs.readFileSync(source);
if (source.endsWith('.enc')) {
  const password = process.env.BACKUP_PASSWORD;
  if (!password) {
    console.error('Cópia criptografada: informe a senha em BACKUP_PASSWORD.');
    process.exit(1);
  }
  data = decrypt(data, password);
}
const db = zlib.gunzipSync(data);

const target = path.join(path.resolve(process.env.DATA_DIR ?? 'data'), 'barbearia.db');
if (fs.existsSync(target) && !force) {
  console.error(`Já existe um banco em ${target}. Pare o sistema e use --forcar para substituir.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
const tmp = `${target}.restaurando`;
fs.writeFileSync(tmp, db);
const check = new DatabaseSync(tmp);
const ok = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
const shops = (check.prepare('SELECT COUNT(*) AS n FROM barbershops').get() as { n: number }).n;
check.close();
if (ok !== 'ok') {
  fs.rmSync(tmp);
  console.error(`A cópia está corrompida: ${ok}`);
  process.exit(1);
}
for (const extra of ['-wal', '-shm']) fs.rmSync(`${target}${extra}`, { force: true });
fs.renameSync(tmp, target);
console.log(`Banco restaurado em ${target} (${shops} barbearia(s)). Pode iniciar o sistema.`);
