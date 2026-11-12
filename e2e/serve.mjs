// Servidor dos testes de ponta a ponta: uma pasta de dados nova, a barbearia de demonstração e o relógio
// parado numa quarta-feira às 10h de Brasília (andando normalmente a partir daí), para os testes não
// dependerem do dia nem da hora em que rodam. Usa o build (npm run build antes).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { E2E_NOW } from './now.mjs';
const port = process.env.E2E_PORT ?? '3200';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladr-e2e-'));
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: port,
  AUTOMATIONS: '0',
  DEMO_LOGIN_CODES: '1',
  NODE_ENV: 'production',
  ANTHROPIC_API_KEY: '',
  CLOCK_AT: E2E_NOW,
  NODE_OPTIONS: `--import ${path.resolve('tools/clock-shift.mjs')} --disable-warning=ExperimentalWarning`,
};

const seed = spawnSync('npx', ['tsx', 'tools/seed-demo.ts'], { env, stdio: 'inherit' });
if (seed.status !== 0) process.exit(seed.status ?? 1);
// A fila de chegada ligada na demonstração (o teste da fila usa).
const db = new DatabaseSync(path.join(dataDir, 'barbearia.db'));
db.exec("UPDATE barbershops SET queue_enabled = 1 WHERE slug = 'demo'");
db.close();

const server = spawn(process.execPath, ['dist/server/index.js'], { env, stdio: 'inherit' });
// Login master (sem ele, a página inicial pede para criá-lo).
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) {
  const ok = await fetch(`${base}/api/public/push-key`).then((r) => r.ok, () => false);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 250));
}
await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Plataforma', email: 'master@bladr.test', password: 'master-12345' }),
});
const stop = () => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => process.exit(code ?? 0));
