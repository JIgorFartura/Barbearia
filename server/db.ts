import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

type Param = string | number | bigint | null | Uint8Array;
export type Params = Record<string, unknown> | unknown[];

const cache = new Map<string, StatementSync>();

function prepare(sql: string): StatementSync {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmt.setAllowUnknownNamedParameters(true);
    cache.set(sql, stmt);
  }
  return stmt;
}

function clean(value: unknown): Param {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function bind(stmt: StatementSync, params: Params | undefined, method: 'all' | 'get' | 'run') {
  if (params === undefined) return (stmt[method] as () => unknown)();
  if (Array.isArray(params)) return (stmt[method] as (...a: Param[]) => unknown)(...params.map(clean));
  const named: Record<string, Param> = {};
  for (const [k, v] of Object.entries(params)) named[k] = clean(v);
  return (stmt[method] as (p: Record<string, Param>) => unknown)(named);
}

export function all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
  return (bind(prepare(sql), params, 'all') as T[]).map((row) => ({ ...row }));
}

export function get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
  const row = bind(prepare(sql), params, 'get') as T | undefined;
  return row ? { ...row } : undefined;
}

export function run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const r = bind(prepare(sql), params, 'run') as { changes: number | bigint; lastInsertRowid: number | bigint };
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

let depth = 0;
/** Executa fn numa transação (aceita aninhamento via SAVEPOINT). fn deve ser síncrona. */
export function tx<T>(fn: () => T): T {
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();

/**
 * Cada barbearia é um "inquilino": todas as tabelas de conteúdo têm barbershop_id, e as rotas do
 * painel sempre filtram por ele — uma barbearia nunca enxerga os dados de outra.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE barbershops (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tagline TEXT,
    about TEXT,
    primary_color TEXT NOT NULL DEFAULT '#111827',
    accent_color TEXT NOT NULL DEFAULT '#d4a017',
    logo_url TEXT,
    cover_url TEXT,
    whatsapp TEXT,
    instagram TEXT,
    address TEXT,
    hours TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER REFERENCES barbershops(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('master', 'owner')),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Serviços (corte, barba...) e produtos (pomada, cerveja...) que a barbearia oferece.
  CREATE TABLE catalog_items (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('service', 'product')),
    name TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL DEFAULT 0,
    duration_min INTEGER,
    image_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  -- Comércios parceiros: dão benefício aos clientes e podem comprar anúncios.
  CREATE TABLE partners (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    benefit TEXT,
    phone TEXT,
    instagram TEXT,
    website TEXT,
    logo_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  -- Espaço de propaganda vendido no site da barbearia (destaque no topo ou mural da comunidade).
  CREATE TABLE ads (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body TEXT,
    image_url TEXT,
    link_url TEXT,
    placement TEXT NOT NULL DEFAULT 'mural' CHECK (placement IN ('destaque', 'mural')),
    price_cents INTEGER NOT NULL DEFAULT 0,
    starts_on TEXT,
    ends_on TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    views INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- Campanha de fidelidade "junte N, ganhe 1": ex. tomou 5 cervejas, ganhou um copo.
  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    unit_label TEXT NOT NULL,
    goal INTEGER NOT NULL CHECK (goal > 0),
    reward TEXT NOT NULL,
    catalog_item_id INTEGER REFERENCES catalog_items(id) ON DELETE SET NULL,
    partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    image_url TEXT,
    starts_on TEXT,
    ends_on TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  -- Membros da comunidade de cada barbearia, identificados pelo celular.
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (barbershop_id, phone)
  );

  -- Extrato do cartão fidelidade: carimbos ganhos (earn) e prêmios entregues (redeem).
  CREATE TABLE loyalty_events (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('earn', 'redeem')),
    qty INTEGER NOT NULL CHECK (qty > 0),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX loyalty_events_customer ON loyalty_events (customer_id, campaign_id);
  CREATE INDEX loyalty_events_created ON loyalty_events (created_at);
  `,
];

function migrate(): void {
  const current = Number((get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0));
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

migrate();
