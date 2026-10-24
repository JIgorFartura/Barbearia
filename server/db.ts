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
  // 2) Agenda, robô do WhatsApp, área do cliente e benefícios (vouchers).
  `
  -- Configuração do robô e das automações de cada barbearia.
  ALTER TABLE barbershops ADD COLUMN bot_name TEXT NOT NULL DEFAULT 'Assistente';
  ALTER TABLE barbershops ADD COLUMN bot_persona TEXT;
  ALTER TABLE barbershops ADD COLUMN wa_provider TEXT NOT NULL DEFAULT 'simulador';
  ALTER TABLE barbershops ADD COLUMN wa_config TEXT;
  ALTER TABLE barbershops ADD COLUMN webhook_token TEXT;
  ALTER TABLE barbershops ADD COLUMN slot_step_min INTEGER NOT NULL DEFAULT 30;
  ALTER TABLE barbershops ADD COLUMN reminder_hours INTEGER NOT NULL DEFAULT 24;
  ALTER TABLE barbershops ADD COLUMN habit_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE barbershops ADD COLUMN habit_weekday INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE barbershops ADD COLUMN habit_time TEXT NOT NULL DEFAULT '09:00';
  ALTER TABLE barbershops ADD COLUMN winback_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE barbershops ADD COLUMN winback_days INTEGER NOT NULL DEFAULT 30;
  ALTER TABLE barbershops ADD COLUMN winback_message TEXT;
  UPDATE barbershops SET webhook_token = lower(hex(randomblob(16)));
  CREATE UNIQUE INDEX barbershops_webhook_token ON barbershops (webhook_token);
  -- Toda barbearia nova ganha o segredo da URL do webhook.
  CREATE TRIGGER barbershops_webhook_token_new AFTER INSERT ON barbershops WHEN NEW.webhook_token IS NULL
  BEGIN
    UPDATE barbershops SET webhook_token = lower(hex(randomblob(16))) WHERE id = NEW.id;
  END;

  CREATE TABLE barbers (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    photo_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  -- Expediente semanal: pode haver mais de uma faixa por dia (ex.: 9h-12h e 13h-19h).
  CREATE TABLE barber_hours (
    id INTEGER PRIMARY KEY,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
  );

  -- Folgas e bloqueios (datas/horas locais "AAAA-MM-DD HH:MM").
  CREATE TABLE barber_blocks (
    id INTEGER PRIMARY KEY,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  );

  -- Horários marcados (datas/horas locais "AAAA-MM-DD HH:MM"). Barbeiro com histórico não é apagado, só desativado.
  CREATE TABLE appointments (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    barber_id INTEGER NOT NULL REFERENCES barbers(id),
    service_id INTEGER REFERENCES catalog_items(id) ON DELETE SET NULL,
    service_name TEXT NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'no_show')),
    source TEXT NOT NULL CHECK (source IN ('painel', 'cliente', 'whatsapp')),
    notes TEXT,
    created_at TEXT NOT NULL,
    cancelled_at TEXT
  );
  CREATE INDEX appointments_barber ON appointments (barber_id, starts_at);
  CREATE INDEX appointments_customer ON appointments (customer_id, starts_at);
  CREATE INDEX appointments_shop ON appointments (barbershop_id, starts_at);

  -- Horário de costume informado pelo cliente (senão o sistema descobre pelo histórico).
  ALTER TABLE customers ADD COLUMN wa_id TEXT;
  ALTER TABLE customers ADD COLUMN pref_weekday INTEGER;
  ALTER TABLE customers ADD COLUMN pref_time TEXT;
  ALTER TABLE customers ADD COLUMN pref_barber_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL;
  ALTER TABLE customers ADD COLUMN pref_service_id INTEGER REFERENCES catalog_items(id) ON DELETE SET NULL;
  ALTER TABLE customers ADD COLUMN pref_interval_days INTEGER;
  ALTER TABLE customers ADD COLUMN reminders_opt_out INTEGER NOT NULL DEFAULT 0;

  -- Benefícios que o cliente resgata como voucher (código único, validado no balcão).
  CREATE TABLE offers (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    image_url TEXT,
    valid_days INTEGER NOT NULL DEFAULT 7,
    max_total INTEGER,
    per_customer INTEGER NOT NULL DEFAULT 1,
    starts_on TEXT,
    ends_on TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE vouchers (
    id INTEGER PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used')),
    expires_on TEXT NOT NULL,
    used_at TEXT,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX vouchers_customer ON vouchers (customer_id);

  -- Área logada do cliente: sessões longas e códigos de acesso enviados pelo WhatsApp.
  CREATE TABLE customer_sessions (
    id TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE customer_codes (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('code', 'link')),
    secret_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX customer_codes_customer ON customer_codes (customer_id, created_at);

  -- Todas as mensagens do robô (recebidas e enviadas), com o consumo de tokens.
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    phone TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    external_id TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX messages_external ON messages (barbershop_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX messages_phone ON messages (barbershop_id, phone, created_at);
  CREATE INDEX messages_created ON messages (created_at);

  -- Horário que o robô ofereceu (lembrete semanal, cliente sumido): "SIM" confirma.
  CREATE TABLE bot_offers (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    service_id INTEGER REFERENCES catalog_items(id) ON DELETE SET NULL,
    starts_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX bot_offers_customer ON bot_offers (customer_id, status);

  -- O que as automações já fizeram (evita mandar a mesma mensagem duas vezes).
  CREATE TABLE automation_log (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX automation_log_lookup ON automation_log (barbershop_id, kind, ref);

  -- Master dentro do painel de uma barbearia.
  ALTER TABLE sessions ADD COLUMN acting_shop_id INTEGER REFERENCES barbershops(id) ON DELETE SET NULL;
  `,
  // 3) Financeiro da barbearia, mensalidades da plataforma e consumo do cliente.
  `
  -- Plataforma (master): planos, faturas das barbearias, configurações e avisos.
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO platform_settings (key, value) VALUES ('grace_days', '5'), ('trial_days', '14');

  ALTER TABLE barbershops ADD COLUMN plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL;
  -- Valor combinado com a barbearia (vazio = preço do plano).
  ALTER TABLE barbershops ADD COLUMN monthly_price_cents INTEGER;
  ALTER TABLE barbershops ADD COLUMN billing_day INTEGER NOT NULL DEFAULT 10;
  ALTER TABLE barbershops ADD COLUMN trial_until TEXT;
  -- Master liberou o acesso até esta data, mesmo com mensalidade vencida.
  ALTER TABLE barbershops ADD COLUMN released_until TEXT;

  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    reference TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
    paid_at TEXT,
    method TEXT,
    notes TEXT,
    informed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (barbershop_id, reference)
  );

  CREATE TABLE announcements (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'novidade' CHECK (level IN ('novidade', 'aviso', 'manutencao')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  -- Comissão de cada barbeiro: % sobre serviços e produtos, com exceções por serviço.
  ALTER TABLE barbers ADD COLUMN phone TEXT;
  ALTER TABLE barbers ADD COLUMN service_commission REAL NOT NULL DEFAULT 0;
  ALTER TABLE barbers ADD COLUMN product_commission REAL NOT NULL DEFAULT 0;

  CREATE TABLE barber_service_rates (
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    service_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('percent', 'fixed')),
    -- percent: % do valor; fixed: centavos por serviço.
    value REAL NOT NULL CHECK (value >= 0),
    PRIMARY KEY (barber_id, service_id)
  );

  -- Venda (comanda): atendimento da agenda ou venda de balcão.
  CREATE TABLE sales (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('dinheiro', 'pix', 'debito', 'credito', 'outro')),
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'cancelled')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    cancelled_at TEXT
  );
  CREATE UNIQUE INDEX sales_appointment ON sales (appointment_id) WHERE appointment_id IS NOT NULL AND status = 'closed';
  CREATE INDEX sales_shop_date ON sales (barbershop_id, date);
  CREATE INDEX sales_customer ON sales (customer_id, date);

  -- Pagamento de comissões a um barbeiro (sai do caixa).
  CREATE TABLE barber_payouts (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    barber_id INTEGER NOT NULL REFERENCES barbers(id),
    amount_cents INTEGER NOT NULL,
    items INTEGER NOT NULL,
    until_date TEXT NOT NULL,
    date TEXT NOT NULL,
    method TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sale_items (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    catalog_item_id INTEGER REFERENCES catalog_items(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('service', 'product')),
    name TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    unit_price_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    barber_id INTEGER REFERENCES barbers(id),
    commission_cents INTEGER NOT NULL DEFAULT 0,
    payout_id INTEGER REFERENCES barber_payouts(id) ON DELETE SET NULL
  );
  CREATE INDEX sale_items_sale ON sale_items (sale_id);
  CREATE INDEX sale_items_barber ON sale_items (barber_id, payout_id);

  -- Fluxo de caixa: entradas e saídas (pagas ou a pagar).
  CREATE TABLE cash_entries (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('in', 'out')),
    category TEXT NOT NULL,
    description TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    method TEXT,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'pending')),
    sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
    payout_id INTEGER REFERENCES barber_payouts(id) ON DELETE CASCADE,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX cash_entries_shop_date ON cash_entries (barbershop_id, date);

  -- Carimbo lançado automaticamente por uma venda (sai junto se a venda for cancelada).
  ALTER TABLE loyalty_events ADD COLUMN sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE;

  -- O que o cliente pediu para deixar separado (ex.: 1 cerveja) no horário marcado.
  CREATE TABLE appointment_items (
    id INTEGER PRIMARY KEY,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL CHECK (qty > 0),
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX appointment_items_appointment ON appointment_items (appointment_id);

  -- Pergunta do robô esperando SIM/NÃO (ex.: "posso avisar o Paulo da sua cerveja?").
  CREATE TABLE bot_questions (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'yes', 'no', 'expired')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX bot_questions_customer ON bot_questions (customer_id, status);
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
