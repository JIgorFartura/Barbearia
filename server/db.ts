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
/** Migração que recria tabelas (ex.: mudar um CHECK): roda com as chaves estrangeiras desligadas. */
interface Rebuild {
  rebuild: string;
}

const MIGRATIONS: (string | Rebuild)[] = [
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
  // 4) Logins: perfil de barbeiro, entrada pelo celular (e-mail opcional) e aceite dos termos de uso.
  {
    rebuild: `
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY,
      barbershop_id INTEGER REFERENCES barbershops(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('master', 'owner', 'barber')),
      name TEXT NOT NULL,
      email TEXT UNIQUE COLLATE NOCASE,
      -- Celular com DDD: entra no lugar do e-mail e recebe o código de "esqueci minha senha".
      phone TEXT,
      barber_id INTEGER REFERENCES barbers(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      terms_accepted_at TEXT,
      created_at TEXT NOT NULL,
      CHECK (email IS NOT NULL OR phone IS NOT NULL)
    );
    INSERT INTO users_new (id, barbershop_id, role, name, email, password_hash, created_at)
      SELECT id, barbershop_id, role, name, email, password_hash, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    CREATE UNIQUE INDEX users_phone ON users (phone) WHERE phone IS NOT NULL;
    CREATE UNIQUE INDEX users_barber ON users (barber_id) WHERE barber_id IS NOT NULL;
    `,
  },
  // 5) Fuso por barbearia, cópias de segurança, WhatsApp da plataforma, LGPD, estoque, avaliações
  //    e conexão do WhatsApp.
  `
  -- Fuso da barbearia (vazio = o do servidor, horário de Brasília).
  ALTER TABLE barbershops ADD COLUMN timezone TEXT;

  -- Imagens já enviadas para o armazenamento externo da cópia de segurança.
  CREATE TABLE backup_files (
    name TEXT PRIMARY KEY,
    uploaded_at TEXT NOT NULL
  );

  -- WhatsApp da plataforma (do master): avisos aos donos e códigos de "esqueci minha senha".
  CREATE TABLE platform_messages (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER REFERENCES barbershops(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX platform_messages_created ON platform_messages (created_at);

  CREATE TABLE password_codes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX password_codes_user ON password_codes (user_id, created_at);

  -- LGPD: aceite da política de privacidade (área do cliente), aviso dado pelo robô e conta excluída.
  ALTER TABLE customers ADD COLUMN privacy_accepted_at TEXT;
  ALTER TABLE customers ADD COLUMN privacy_notice_at TEXT;
  ALTER TABLE customers ADD COLUMN anonymized_at TEXT;
  -- Data de nascimento (opcional, para o presente de aniversário).
  ALTER TABLE customers ADD COLUMN birth_date TEXT;

  -- Estoque dos produtos: baixa automática na venda, entradas de mercadoria e ajustes.
  ALTER TABLE catalog_items ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE catalog_items ADD COLUMN stock_qty INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE catalog_items ADD COLUMN stock_min INTEGER;
  ALTER TABLE catalog_items ADD COLUMN cost_cents INTEGER;

  CREATE TABLE stock_moves (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    -- Positivo entra, negativo sai.
    qty INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('venda', 'cancelamento', 'compra', 'ajuste', 'perda', 'uso')),
    sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
    unit_cost_cents INTEGER,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX stock_moves_item ON stock_moves (catalog_item_id, created_at);
  CREATE INDEX stock_moves_shop ON stock_moves (barbershop_id, created_at);

  -- Barbeiros com login: podem fechar os próprios atendimentos (o dono decide).
  ALTER TABLE barbershops ADD COLUMN barber_can_close INTEGER NOT NULL DEFAULT 1;

  -- Avaliação depois do corte: o robô pergunta a nota; nota alta recebe o link do Google.
  ALTER TABLE barbershops ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE barbershops ADD COLUMN review_delay_min INTEGER NOT NULL DEFAULT 120;
  ALTER TABLE barbershops ADD COLUMN review_link TEXT;

  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    appointment_id INTEGER UNIQUE REFERENCES appointments(id) ON DELETE SET NULL,
    barber_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL,
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    -- asked: esperando a nota · comment: nota baixa, esperando o comentário · done · expired
    status TEXT NOT NULL DEFAULT 'asked' CHECK (status IN ('asked', 'comment', 'done', 'expired')),
    asked_at TEXT NOT NULL,
    answered_at TEXT
  );
  CREATE INDEX reviews_shop ON reviews (barbershop_id, answered_at);
  CREATE INDEX reviews_customer ON reviews (customer_id, status);

  -- Conexão do WhatsApp de cada barbearia (conferida a cada 10 minutos): ok | down.
  ALTER TABLE barbershops ADD COLUMN wa_status TEXT;
  ALTER TABLE barbershops ADD COLUMN wa_status_at TEXT;
  ALTER TABLE barbershops ADD COLUMN wa_checked_at TEXT;
  ALTER TABLE barbershops ADD COLUMN wa_error TEXT;
  ALTER TABLE barbershops ADD COLUMN wa_alerted_at TEXT;
  `,
  // 6) Clube de assinatura, cobranças PIX da barbearia (mensalidade do clube e sinal de agendamento).
  `
  -- PIX da própria barbearia (clube de assinatura e sinal): direto na chave dela, sem intermediário.
  ALTER TABLE barbershops ADD COLUMN pix_key TEXT;
  ALTER TABLE barbershops ADD COLUMN pix_name TEXT;
  ALTER TABLE barbershops ADD COLUMN pix_city TEXT;

  -- Clube de assinatura: o cliente paga por mês e usa os serviços do plano sem pagar na hora.
  -- Comissão do barbeiro nos usos do clube: % do preço normal do serviço.
  ALTER TABLE barbershops ADD COLUMN club_commission_pct INTEGER NOT NULL DEFAULT 100;

  CREATE TABLE club_plans (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    -- Usos por mês (NULL = à vontade).
    uses_per_month INTEGER CHECK (uses_per_month IS NULL OR uses_per_month > 0),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE club_plan_items (
    plan_id INTEGER NOT NULL REFERENCES club_plans(id) ON DELETE CASCADE,
    catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    PRIMARY KEY (plan_id, catalog_item_id)
  );

  CREATE TABLE club_members (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES club_plans(id),
    -- pending: esperando o primeiro pagamento · active · cancelled (vale até paid_until)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'cancelled')),
    billing_day INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
    -- Último dia coberto pelos pagamentos confirmados.
    paid_until TEXT,
    created_at TEXT NOT NULL,
    cancelled_at TEXT
  );
  CREATE UNIQUE INDEX club_members_customer ON club_members (customer_id) WHERE status <> 'cancelled';
  CREATE INDEX club_members_shop ON club_members (barbershop_id, status);

  -- Cobranças PIX da barbearia para o cliente (mensalidade do clube e sinal de agendamento).
  -- O cliente avisa que pagou (claimed_at) e a barbearia confirma no painel.
  CREATE TABLE charges (
    id INTEGER PRIMARY KEY,
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('clube', 'sinal')),
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
    claimed_at TEXT,
    paid_at TEXT,
    method TEXT,
    -- Clube: o mês que a cobrança cobre (vence no primeiro dia).
    club_member_id INTEGER REFERENCES club_members(id) ON DELETE CASCADE,
    period_start TEXT,
    period_end TEXT,
    due_date TEXT,
    reminded_at TEXT,
    -- Sinal: o horário segurado até expires_at; depois de pago, abatido na comanda (sale_id),
    -- perdido se o cliente faltar (forfeited_at) ou devolvido (refunded_at).
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    expires_at TEXT,
    sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
    forfeited_at TEXT,
    refunded_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX charges_club_period ON charges (club_member_id, period_start) WHERE club_member_id IS NOT NULL AND status <> 'cancelled';
  CREATE INDEX charges_shop ON charges (barbershop_id, status);
  CREATE INDEX charges_customer ON charges (customer_id, status);
  CREATE INDEX charges_appointment ON charges (appointment_id);

  ALTER TABLE cash_entries ADD COLUMN charge_id INTEGER REFERENCES charges(id) ON DELETE SET NULL;
  -- Item coberto pelo clube: sai por R$ 0 e conta no limite do mês.
  ALTER TABLE sale_items ADD COLUMN club_member_id INTEGER REFERENCES club_members(id) ON DELETE SET NULL;
  -- Parte da venda já paga antes (sinal): não entra de novo no caixa.
  ALTER TABLE sales ADD COLUMN prepaid_cents INTEGER NOT NULL DEFAULT 0;

  -- Sinal via PIX para segurar o horário: off | all (todos) | no_show (só quem já faltou).
  ALTER TABLE barbershops ADD COLUMN deposit_mode TEXT NOT NULL DEFAULT 'off' CHECK (deposit_mode IN ('off', 'all', 'no_show'));
  ALTER TABLE barbershops ADD COLUMN deposit_cents INTEGER NOT NULL DEFAULT 2000;
  -- Quanto tempo o horário fica segurado esperando o PIX.
  ALTER TABLE barbershops ADD COLUMN deposit_hold_min INTEGER NOT NULL DEFAULT 60;
  -- Cancelou com pelo menos estas horas de antecedência: o sinal vira crédito para o próximo horário.
  ALTER TABLE barbershops ADD COLUMN deposit_credit_hours INTEGER NOT NULL DEFAULT 24;
  `,
  // 7) Indique um amigo e presente de aniversário (os prêmios são vouchers de benefícios só-prêmio).
  `
  -- Benefício que só sai como prêmio (indicação, aniversário): não aparece para o cliente pegar.
  ALTER TABLE offers ADD COLUMN reward_only INTEGER NOT NULL DEFAULT 0;

  ALTER TABLE customers ADD COLUMN referral_code TEXT;
  CREATE UNIQUE INDEX customers_referral ON customers (barbershop_id, referral_code) WHERE referral_code IS NOT NULL;
  -- Quem indicou este cliente; e quando quem indicou ganhou o prêmio (na primeira visita paga do amigo).
  ALTER TABLE customers ADD COLUMN referred_by INTEGER REFERENCES customers(id) ON DELETE SET NULL;
  ALTER TABLE customers ADD COLUMN referral_rewarded_at TEXT;
  -- Ano do último presente de aniversário (um por ano). birth_date guarda "MM-DD".
  ALTER TABLE customers ADD COLUMN birthday_sent_year INTEGER;

  ALTER TABLE barbershops ADD COLUMN referral_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE barbershops ADD COLUMN referral_friend_offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL;
  ALTER TABLE barbershops ADD COLUMN referral_reward_offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL;
  ALTER TABLE barbershops ADD COLUMN birthday_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE barbershops ADD COLUMN birthday_offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL;
  `,
  // 8) Mensalidade cobrada pelo Asaas (PIX com baixa automática e nota fiscal) e lembrete da fatura no WhatsApp.
  `
  -- Dados da barbearia para a cobrança e a nota fiscal (CPF ou CNPJ só com números).
  ALTER TABLE barbershops ADD COLUMN billing_document TEXT;
  ALTER TABLE barbershops ADD COLUMN billing_name TEXT;
  ALTER TABLE barbershops ADD COLUMN billing_email TEXT;
  ALTER TABLE barbershops ADD COLUMN asaas_customer_id TEXT;

  ALTER TABLE invoices ADD COLUMN asaas_payment_id TEXT;
  ALTER TABLE invoices ADD COLUMN asaas_invoice_url TEXT;
  ALTER TABLE invoices ADD COLUMN asaas_pix_payload TEXT;
  ALTER TABLE invoices ADD COLUMN asaas_pix_qr TEXT;
  ALTER TABLE invoices ADD COLUMN asaas_error TEXT;
  CREATE UNIQUE INDEX invoices_asaas ON invoices (asaas_payment_id) WHERE asaas_payment_id IS NOT NULL;
  -- Nota fiscal de serviço emitida pelo Asaas depois do pagamento.
  ALTER TABLE invoices ADD COLUMN nfse_id TEXT;
  ALTER TABLE invoices ADD COLUMN nfse_status TEXT;
  ALTER TABLE invoices ADD COLUMN nfse_url TEXT;
  ALTER TABLE invoices ADD COLUMN nfse_error TEXT;
  -- Lembretes da fatura pelo WhatsApp da plataforma (antes de vencer e depois de vencida).
  ALTER TABLE invoices ADD COLUMN reminded_at TEXT;
  ALTER TABLE invoices ADD COLUMN overdue_reminded_at TEXT;
  `,
  // 9) O master cuida só da plataforma: não entra mais no painel das barbearias (sessions.acting_shop_id fica sem uso).
  `
  UPDATE sessions SET acting_shop_id = NULL;
  `,
  // 10) Pagamentos online pelo Asaas da plataforma (cartão, boleto ou PIX): mensalidades das barbearias e,
  //     dos clientes, clube e sinal, com repasse automático para a conta Asaas da barbearia (split).
  `
  CREATE TABLE gateway_payments (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'asaas',
    external_id TEXT NOT NULL UNIQUE,
    barbershop_id INTEGER REFERENCES barbershops(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('mensalidade', 'clube', 'sinal')),
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    charge_id INTEGER REFERENCES charges(id) ON DELETE SET NULL,
    value_cents INTEGER NOT NULL,
    -- Valor depois da taxa do Asaas (vem no aviso de pagamento).
    net_cents INTEGER,
    -- Parte da plataforma no repasse (o resto vai para a barbearia).
    platform_fee_pct REAL NOT NULL DEFAULT 0,
    -- PIX | BOLETO | CREDIT_CARD | DEBIT_CARD | UNDEFINED (o cliente escolhe)
    method TEXT,
    -- PENDING | CONFIRMED | RECEIVED | OVERDUE | REFUNDED | DELETED | ...
    status TEXT NOT NULL DEFAULT 'PENDING',
    -- Já baixou a fatura/cobrança (os avisos de confirmado e recebido chegam os dois).
    applied INTEGER NOT NULL DEFAULT 0,
    -- Pago duas vezes (ex.: PIX direto e cartão): a barbearia devolve ao cliente.
    duplicate INTEGER NOT NULL DEFAULT 0,
    -- Estornado pelo Asaas depois de baixado: o repasse já saiu do caixa da barbearia.
    refunded INTEGER NOT NULL DEFAULT 0,
    invoice_url TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX gateway_payments_shop ON gateway_payments (barbershop_id, created_at);
  CREATE INDEX gateway_payments_charge ON gateway_payments (charge_id);

  -- Carteira Asaas da barbearia (recebe o repasse) e se ela oferece cartão aos clientes.
  ALTER TABLE barbershops ADD COLUMN asaas_wallet_id TEXT;
  ALTER TABLE barbershops ADD COLUMN online_payments INTEGER NOT NULL DEFAULT 0;
  -- Cadastro do cliente no Asaas (o CPF fica só lá, não no sistema).
  ALTER TABLE customers ADD COLUMN asaas_customer_id TEXT;
  `,
  // 11) Cartão pela Cielo (Link de Pagamento): menor taxa, dinheiro em 1 dia útil e cobrança recorrente.
  //     Cada recebedor usa a própria conta Cielo: a plataforma (mensalidade) e cada barbearia (clube e
  //     sinal). Sai o cartão pelo Asaas com repasse (a Cielo não divide o pagamento).
  `
  CREATE TABLE card_links (
    id INTEGER PRIMARY KEY,
    -- Quem recebe: a plataforma (mensalidade das barbearias) ou a barbearia (clube e sinal dos clientes).
    receiver TEXT NOT NULL CHECK (receiver IN ('platform', 'shop')),
    barbershop_id INTEGER NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('mensalidade', 'clube', 'sinal')),
    -- Recorrente: a Cielo guarda o cartão e cobra sozinha todo mês.
    recurrent INTEGER NOT NULL DEFAULT 0,
    link_id TEXT NOT NULL UNIQUE,
    sku TEXT NOT NULL,
    url TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    charge_id INTEGER REFERENCES charges(id) ON DELETE SET NULL,
    club_member_id INTEGER REFERENCES club_members(id) ON DELETE SET NULL,
    -- open: esperando o 1º pagamento · active: cobrança mensal ligada · paid: avulso pago · cancelled
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'paid', 'cancelled')),
    recurrent_payment_id TEXT,
    last_paid_at TEXT,
    -- Última recusa do cartão (ou falha ao cancelar na Cielo), para o painel mostrar.
    error TEXT,
    checked_at TEXT,
    created_at TEXT NOT NULL,
    cancelled_at TEXT
  );
  CREATE INDEX card_links_shop ON card_links (barbershop_id, kind, status);
  CREATE INDEX card_links_member ON card_links (club_member_id);
  CREATE INDEX card_links_recurrent ON card_links (recurrent_payment_id);
  ALTER TABLE gateway_payments ADD COLUMN card_link_id INTEGER REFERENCES card_links(id) ON DELETE SET NULL;

  -- Conta Cielo da barbearia (credenciais da API do Link de Pagamento) e a taxa para lançar no caixa.
  ALTER TABLE barbershops ADD COLUMN cielo_client_id TEXT;
  ALTER TABLE barbershops ADD COLUMN cielo_client_secret TEXT;
  ALTER TABLE barbershops ADD COLUMN cielo_webhook_token TEXT;
  ALTER TABLE barbershops ADD COLUMN cielo_webhook_at TEXT;
  ALTER TABLE barbershops ADD COLUMN cielo_fee_pct REAL NOT NULL DEFAULT 3.48;
  ALTER TABLE barbershops ADD COLUMN card_enabled INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX barbershops_cielo_token ON barbershops (cielo_webhook_token);

  ALTER TABLE barbershops DROP COLUMN asaas_wallet_id;
  ALTER TABLE barbershops DROP COLUMN online_payments;
  ALTER TABLE customers DROP COLUMN asaas_customer_id;
  DELETE FROM platform_settings WHERE key IN ('online_enabled', 'online_fee_pct');
  `,
];

function migrate(): void {
  const current = Number((get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0));
  for (let v = current; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v];
    const rebuild = typeof m !== 'string';
    // Recriar tabela referenciada por outras exige as chaves estrangeiras desligadas (fora da transação).
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(() => {
        db.exec(rebuild ? m.rebuild : m);
        if (rebuild && all('PRAGMA foreign_key_check').length) throw new Error(`Migração ${v + 1}: chaves estrangeiras inconsistentes.`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

migrate();
