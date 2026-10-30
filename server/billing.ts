import QRCode from 'qrcode';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { pixPayload } from './pix.js';
import { addDays, isoToLocal, localNow } from './time.js';

/**
 * Mensalidades da plataforma: cada barbearia tem um plano (ou valor combinado) e um dia de
 * vencimento. A fatura do mês é gerada sozinha; vencida além da carência, o painel da barbearia
 * fica restrito à tela de pagamento até o master confirmar o pagamento (ou liberar o acesso).
 */

export interface PlatformSettings {
  grace_days: number;
  trial_days: number;
  /** A barbearia pode criar a conta sozinha pelo site (com os dias grátis). */
  signup_enabled: boolean;
  pix_key: string;
  pix_name: string;
  pix_city: string;
  /** Desconto dos planos por período, sobre as mensalidades do período (%). */
  quarterly_discount_pct: number;
  semiannual_discount_pct: number;
  annual_discount_pct: number;
  /** Cartão parcelado: juros ao mês (%) pagos por quem parcela, a partir da parcela abaixo. */
  card_interest_pct: number;
  /** Até quantas parcelas sem juros (2 = juros a partir de 3x). */
  interest_free_installments: number;
  max_installments: number;
  /** Taxa de implantação (0 = não cobra): uma vez, junto com a primeira cobrança depois do teste. */
  setup_fee_cents: number;
  /** No semestral e no anual a implantação sai grátis. */
  setup_free_on_annual: boolean;
}

export function platformSettings(): PlatformSettings {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM platform_settings');
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    grace_days: Number(map.grace_days ?? 5),
    trial_days: Number(map.trial_days ?? 14),
    signup_enabled: map.signup_enabled !== 'false',
    pix_key: map.pix_key ?? '',
    pix_name: map.pix_name ?? '',
    pix_city: map.pix_city ?? '',
    quarterly_discount_pct: Number(map.quarterly_discount_pct ?? 10),
    semiannual_discount_pct: Number(map.semiannual_discount_pct ?? 15),
    annual_discount_pct: Number(map.annual_discount_pct ?? 25),
    card_interest_pct: Number(map.card_interest_pct ?? 2.99),
    interest_free_installments: Number(map.interest_free_installments ?? 2),
    max_installments: Number(map.max_installments ?? 12),
    setup_fee_cents: Number(map.setup_fee_cents ?? 0),
    setup_free_on_annual: map.setup_free_on_annual !== 'false',
  };
}

export function savePlatformSettings(s: PlatformSettings): void {
  tx(() => {
    for (const [key, value] of Object.entries(s)) {
      run('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
    }
  });
}

interface ShopBilling {
  id: number;
  name: string;
  active: number;
  created_at: string;
  plan_id: number | null;
  plan_name: string | null;
  plan_price: number | null;
  monthly_price_cents: number | null;
  billing_day: number;
  trial_until: string | null;
  released_until: string | null;
  /** Cortesia do master: sem mensalidade enquanto estiver marcada (a data é o combinado, só para lembrar). */
  courtesy_since: string | null;
  courtesy_until: string | null;
  courtesy_note: string | null;
  billing_cycle: Cycle;
  billing_months: number;
  setup_fee_waived: number;
}

/** Períodos de cobrança: a mensalidade ou uma fatura a cada 3, 6 ou 12 meses, com desconto. */
export type Cycle = 'mensal' | 'trimestral' | 'semestral' | 'anual';
export const CYCLES: Cycle[] = ['mensal', 'trimestral', 'semestral', 'anual'];
export const CYCLE_MONTHS: Record<Cycle, number> = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };
const cycleOf = (months: number): Cycle => CYCLES.find((c) => CYCLE_MONTHS[c] === months) ?? 'mensal';
/** Fatura de um período ("trimestral:2026-11", "semestral:…", "anual:…"). */
export const isPeriodRef = (reference: string) => /^(trimestral|semestral|anual):/.test(reference);

export function cycleDiscount(cycle: Cycle): number {
  const s = platformSettings();
  return { mensal: 0, trimestral: s.quarterly_discount_pct, semestral: s.semiannual_discount_pct, anual: s.annual_discount_pct }[cycle];
}

/** Implantação grátis no semestral e no anual (se ligado nas configurações). */
export const setupFreeFor = (cycle: Cycle) => platformSettings().setup_free_on_annual && CYCLE_MONTHS[cycle] >= 6;

/**
 * No cartão, o período parcela até o número de meses dele (trimestral em 3x, anual em 12x) e a
 * implantação em até 3x, sempre dentro do máximo das configurações.
 */
export function installmentCap(reference: string): number {
  const max = platformSettings().max_installments;
  if (reference === 'implantacao') return Math.min(3, max);
  const cycle = reference.split(':')[0] as Cycle;
  return isPeriodRef(reference) ? Math.min(CYCLE_MONTHS[cycle], max) : 1;
}

export function shopBilling(shopId: number): ShopBilling {
  const s = get<ShopBilling>(
    `SELECT b.id, b.name, b.active, b.created_at, b.plan_id, p.name AS plan_name, p.price_cents AS plan_price, b.monthly_price_cents,
            b.billing_day, b.trial_until, b.released_until, b.courtesy_since, b.courtesy_until, b.courtesy_note, b.billing_months, b.setup_fee_waived
       FROM barbershops b LEFT JOIN plans p ON p.id = b.plan_id WHERE b.id = ?`,
    [shopId],
  );
  if (!s) throw new HttpError(404, 'Barbearia não encontrada.');
  return { ...s, billing_cycle: cycleOf(s.billing_months) };
}

/** Valor da mensalidade: o combinado com a barbearia ou o preço do plano. */
export const monthlyPrice = (s: Pick<ShopBilling, 'monthly_price_cents' | 'plan_price'>) => s.monthly_price_cents ?? s.plan_price ?? 0;

/** Valor do período: as mensalidades do período com o desconto dele. */
export const periodPrice = (s: Pick<ShopBilling, 'monthly_price_cents' | 'plan_price'>, cycle: Cycle) =>
  Math.round(monthlyPrice(s) * CYCLE_MONTHS[cycle] * (1 - cycleDiscount(cycle) / 100));
export const annualPrice = (s: Pick<ShopBilling, 'monthly_price_cents' | 'plan_price'>) => periodPrice(s, 'anual');

/**
 * Parcelas no cartão: sem juros até o limite; daí em diante, juros compostos ao mês (tabela Price)
 * pagos por quem parcela. O total já vem com os juros: a plataforma recebe o valor da fatura.
 */
export function installmentOptions(amountCents: number): { n: number; each_cents: number; total_cents: number; interest: boolean }[] {
  const { card_interest_pct, interest_free_installments, max_installments } = platformSettings();
  const i = card_interest_pct / 100;
  const out = [];
  for (let n = 1; n <= max_installments; n++) {
    const interest = n > interest_free_installments && i > 0;
    const each = interest ? Math.ceil((amountCents * i) / (1 - (1 + i) ** -n)) : Math.ceil(amountCents / n);
    out.push({ n, each_cents: each, total_cents: interest ? each * n : amountCents, interest });
  }
  return out;
}

/** Fatura da implantação (uma vez): a menos que esteja isenta ou seja um período com a implantação grátis. */
function setupFeeInvoice(s: ShopBilling, due: string): number {
  const { setup_fee_cents } = platformSettings();
  if (setup_fee_cents <= 0 || s.setup_fee_waived || setupFreeFor(s.billing_cycle)) return 0;
  return run(
    `INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at)
     VALUES (?, 'implantacao', 'Implantação: site, marca e configuração do sistema', ?, ?, ?) ON CONFLICT(barbershop_id, reference) DO NOTHING`,
    [s.id, setup_fee_cents, due, nowIso()],
  ).changes;
}

/** Fatura de período (trimestral, semestral ou anual) que cobre o mês "AAAA-MM" (paga ou em aberto). */
function periodCovering(shopId: number, month: string): { reference: string } | undefined {
  return all<{ reference: string }>("SELECT reference FROM invoices WHERE barbershop_id = ? AND reference LIKE '%:%' AND status <> 'cancelled'", [shopId])
    .filter((r) => isPeriodRef(r.reference))
    .find((r) => {
      const [cycle, start] = r.reference.split(':');
      return month >= start && month < addMonths(start, CYCLE_MONTHS[cycle as Cycle]);
    });
}

const addMonths = (reference: string, n: number) => {
  const [y, m] = reference.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** Vencimento do mês "AAAA-MM" no dia escolhido (dia 31 vira o último dia do mês). */
export function dueDate(reference: string, day: number): string {
  const [y, m] = reference.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${reference}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthName = (reference: string) => `${MONTHS[Number(reference.slice(5, 7)) - 1]}/${reference.slice(0, 4)}`;

/**
 * Gera a fatura do mês corrente de cada barbearia ativa com mensalidade (uma vez por mês).
 * Não cobra meses cujo vencimento cai antes do cadastro ou dentro do período grátis.
 */
export function ensureInvoices(now: Date = new Date(), onlyShopId?: number): number {
  const today = localNow(now).date;
  const reference = today.slice(0, 7);
  let created = 0;
  for (const { id } of all<{ id: number }>('SELECT id FROM barbershops WHERE active = 1').filter((s) => !onlyShopId || s.id === onlyShopId)) {
    const s = shopBilling(id);
    const amount = monthlyPrice(s);
    if (amount <= 0 || s.courtesy_since) continue;
    const due = dueDate(reference, s.billing_day);
    if (due < isoToLocal(s.created_at).slice(0, 10)) continue;
    if (s.trial_until && due <= s.trial_until) continue;
    // Mês já coberto por um período pago (ou em aberto): não cobra de novo.
    if (periodCovering(id, reference)) continue;
    // Primeira cobrança da barbearia: a implantação vem junto (uma vez só).
    if (!get("SELECT 1 AS ok FROM invoices WHERE barbershop_id = ? AND reference <> 'implantacao'", [id])) created += setupFeeInvoice(s, due < today ? today : due);
    if (s.billing_months > 1) {
      // O período começa no mês ainda não pago (se a mensalidade do mês já foi paga, começa no próximo).
      if (get("SELECT 1 AS ok FROM invoices WHERE barbershop_id = ? AND reference = ? AND status <> 'cancelled'", [id, reference])) continue;
      const end = addMonths(reference, s.billing_months - 1);
      created += run(
        `INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(barbershop_id, reference) DO NOTHING`,
        [
          id,
          `${s.billing_cycle}:${reference}`,
          `Plano ${s.billing_cycle} ${monthName(reference)} a ${monthName(end)}${s.plan_name ? ` · ${s.plan_name}` : ''}`,
          periodPrice(s, s.billing_cycle),
          due < today ? today : due,
          nowIso(),
        ],
      ).changes;
      continue;
    }
    const { changes } = run(
      `INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(barbershop_id, reference) DO NOTHING`,
      [id, reference, `Mensalidade ${monthName(reference)}${s.plan_name ? ` · ${s.plan_name}` : ''}`, amount, due, nowIso()],
    );
    created += changes;
  }
  return created;
}

const nextMonth = (reference: string) => {
  const [y, m] = reference.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * Fatura da próxima mensalidade ainda não paga (cria se ainda não existe): no cartão automático, a
 * cobrança pode cair antes de a fatura do mês nascer.
 */
export function nextMonthlyInvoice(shopId: number, now: Date = new Date()): InvoiceView | null {
  const s = shopBilling(shopId);
  const amount = monthlyPrice(s);
  if (amount <= 0) return null;
  const latest = get<{ reference: string }>(
    "SELECT reference FROM invoices WHERE barbershop_id = ? AND reference GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' ORDER BY reference DESC LIMIT 1",
    [shopId],
  );
  const reference = latest ? nextMonth(latest.reference) : localNow(now).date.slice(0, 7);
  if (!latest) setupFeeInvoice(s, dueDate(reference, s.billing_day));
  const id = run(
    `INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [shopId, reference, `Mensalidade ${monthName(reference)}${s.plan_name ? ` · ${s.plan_name}` : ''}`, amount, dueDate(reference, s.billing_day), nowIso()],
  ).lastInsertRowid;
  return invoice(id, now);
}

export interface InvoiceView {
  id: number;
  barbershop_id: number;
  shop_name: string;
  reference: string;
  description: string;
  amount_cents: number;
  due_date: string;
  status: 'open' | 'paid' | 'cancelled';
  paid_at: string | null;
  method: string | null;
  notes: string | null;
  informed_at: string | null;
  /** Cobrança criada no Asaas (baixa automática). */
  asaas: number;
  asaas_invoice_url: string | null;
  asaas_error: string | null;
  nfse_status: string | null;
  nfse_url: string | null;
  nfse_error: string | null;
  overdue: boolean;
}

const INVOICE_SELECT = `
  SELECT i.id, i.barbershop_id, b.name AS shop_name, i.reference, i.description, i.amount_cents, i.due_date, i.status,
         i.paid_at, i.method, i.notes, i.informed_at, i.asaas_payment_id IS NOT NULL AS asaas, i.asaas_invoice_url, i.asaas_error,
         i.nfse_status, i.nfse_url, i.nfse_error
    FROM invoices i JOIN barbershops b ON b.id = i.barbershop_id`;

const withOverdue = (i: Omit<InvoiceView, 'overdue'>, today: string): InvoiceView => ({ ...i, overdue: i.status === 'open' && i.due_date < today });

export function listInvoices(filter: { shopId?: number; status?: string } = {}, now?: Date): InvoiceView[] {
  const today = localNow(now).date;
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.shopId) {
    where.push('i.barbershop_id = ?');
    params.push(filter.shopId);
  }
  if (filter.status) {
    where.push('i.status = ?');
    params.push(filter.status);
  }
  return all<Omit<InvoiceView, 'overdue'>>(`${INVOICE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.due_date DESC, i.id DESC LIMIT 500`, params).map((i) =>
    withOverdue(i, today),
  );
}

export function invoice(id: number, now?: Date): InvoiceView {
  const i = get<Omit<InvoiceView, 'overdue'>>(`${INVOICE_SELECT} WHERE i.id = ?`, [id]);
  if (!i) throw new HttpError(404, 'Fatura não encontrada.');
  return withOverdue(i, localNow(now).date);
}

/** Situação de acesso: bloqueada se há fatura vencida além da carência e o master não liberou. */
export function accessStatus(shopId: number, now?: Date) {
  const today = localNow(now).date;
  const s = shopBilling(shopId);
  const { grace_days } = platformSettings();
  const open = listInvoices({ shopId, status: 'open' }, now).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const late = open.filter((i) => addDays(i.due_date, grace_days) < today);
  const released = Boolean(s.released_until && s.released_until >= today);
  return {
    blocked: Boolean(s.active) && late.length > 0 && !released && !s.courtesy_since,
    courtesy: s.courtesy_since ? { since: s.courtesy_since, until: s.courtesy_until, note: s.courtesy_note } : null,
    graceDays: grace_days,
    releasedUntil: s.released_until,
    trialUntil: s.trial_until,
    open,
    /** Data em que o acesso é bloqueado se a fatura mais antiga não for paga. */
    blockOn: open[0] ? addDays(open[0].due_date, grace_days + 1) : null,
  };
}

/** Formas da mensalidade que não existem no caixa da barbearia. */
const CASH_METHOD: Record<string, string> = { cartao: 'credito', boleto: 'outro', transferencia: 'outro' };

/** Master confirma o pagamento: libera o acesso e lança a saída no caixa da barbearia. */
export function markInvoicePaid(id: number, data: { paid_at: string; method: string | null; notes: string | null }): InvoiceView {
  return tx(() => {
    const inv = invoice(id);
    if (inv.status === 'paid') throw new HttpError(409, 'Essa fatura já está paga.');
    if (inv.status === 'cancelled') throw new HttpError(409, 'Essa fatura foi cancelada.');
    run("UPDATE invoices SET status = 'paid', paid_at = ?, method = ?, notes = ? WHERE id = ?", [data.paid_at, data.method, data.notes, id]);
    run(
      `INSERT INTO cash_entries (barbershop_id, type, category, description, amount_cents, method, date, status, invoice_id, created_at)
       VALUES (?, 'out', 'Mensalidade do sistema', ?, ?, ?, ?, 'paid', ?, ?)`,
      [inv.barbershop_id, inv.description, inv.amount_cents, data.method && (CASH_METHOD[data.method] ?? data.method), data.paid_at, id, nowIso()],
    );
    return invoice(id);
  });
}

export function cancelInvoice(id: number): InvoiceView {
  const inv = invoice(id);
  if (inv.status !== 'open') throw new HttpError(409, 'Só faturas em aberto podem ser canceladas.');
  run("UPDATE invoices SET status = 'cancelled' WHERE id = ?", [id]);
  return invoice(id);
}

/** Cobrança avulsa (ex.: implantação, ajuste). */
export function createInvoice(shopId: number, data: { description: string; amount_cents: number; due_date: string }): InvoiceView {
  shopBilling(shopId);
  const id = run('INSERT INTO invoices (barbershop_id, reference, description, amount_cents, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    shopId,
    `avulsa-${Date.now()}`,
    data.description,
    data.amount_cents,
    data.due_date,
    nowIso(),
  ]).lastInsertRowid;
  return invoice(id);
}

/** CPF ou CNPJ válido (dígitos verificadores), só números. */
export function validTaxId(digits: string): boolean {
  if (!/^\d{11}$|^\d{14}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  const check = (base: string, weights: number[]) => {
    const sum = weights.reduce((t, w, i) => t + Number(base[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  if (digits.length === 11) {
    const d1 = check(digits, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = check(digits, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === Number(digits[9]) && d2 === Number(digits[10]);
  }
  const d1 = check(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = check(digits, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(digits[12]) && d2 === Number(digits[13]);
}

/** Dados da barbearia para a cobrança e a nota fiscal. */
export function billingInfo(shopId: number) {
  return get<{ billing_document: string | null; billing_name: string | null; billing_email: string | null }>(
    'SELECT billing_document, billing_name, billing_email FROM barbershops WHERE id = ?',
    [shopId],
  )!;
}

export function saveBillingInfo(shopId: number, data: { document: string; name: string; email: string | null }) {
  const digits = data.document.replace(/\D/g, '');
  if (!validTaxId(digits)) throw new HttpError(400, 'CPF ou CNPJ inválido.');
  const before = billingInfo(shopId);
  run('UPDATE barbershops SET billing_document = ?, billing_name = ?, billing_email = ? WHERE id = ?', [digits, data.name, data.email, shopId]);
  // Mudou o documento: o cadastro no Asaas é refeito na próxima cobrança.
  if (before.billing_document !== digits) run('UPDATE barbershops SET asaas_customer_id = NULL WHERE id = ?', [shopId]);
  return billingInfo(shopId);
}

/** Barbearia avisa que pagou (o master confere e confirma). */
export function informPayment(shopId: number, invoiceId: number): InvoiceView {
  const { changes } = run("UPDATE invoices SET informed_at = ? WHERE id = ? AND barbershop_id = ? AND status = 'open'", [nowIso(), invoiceId, shopId]);
  if (!changes) throw new HttpError(404, 'Fatura em aberto não encontrada.');
  return invoice(invoiceId);
}

/** PIX copia e cola + QR Code da fatura (quando o master cadastrou a chave PIX). */
export async function invoicePix(inv: InvoiceView): Promise<{ payload: string; qr: string } | null> {
  const s = platformSettings();
  if (!s.pix_key || inv.status !== 'open') return null;
  const payload = pixPayload({ key: s.pix_key, name: s.pix_name || 'Bladr', city: s.pix_city || 'Brasil', amountCents: inv.amount_cents, txid: `FAT${inv.id}` });
  return { payload, qr: await QRCode.toDataURL(payload, { margin: 1, width: 260 }) };
}

/** Receita da plataforma para o painel master. */
export function platformRevenue(now?: Date) {
  const today = localNow(now).date;
  const month = today.slice(0, 7);
  const shops = all<{ id: number }>('SELECT id FROM barbershops WHERE active = 1').map((s) => shopBilling(s.id));
  const paying = shops.filter((s) => monthlyPrice(s) > 0 && !(s.trial_until && s.trial_until >= today) && !s.courtesy_since);
  const perMonth = (s: ShopBilling) => Math.round(periodPrice(s, s.billing_cycle) / s.billing_months);
  const sum = (sql: string, params: unknown[] = []) => get<{ v: number }>(sql, params)?.v ?? 0;
  return {
    mrr: paying.reduce((t, s) => t + perMonth(s), 0),
    payingShops: paying.length,
    trialShops: shops.filter((s) => s.trial_until && s.trial_until >= today).length,
    courtesyShops: shops.filter((s) => s.courtesy_since).length,
    receivedThisMonth: sum("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM invoices WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?", [month]),
    open: sum("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM invoices WHERE status = 'open' AND due_date >= ?", [today]),
    overdue: sum("SELECT COALESCE(SUM(amount_cents), 0) AS v FROM invoices WHERE status = 'open' AND due_date < ?", [today]),
    informed: sum("SELECT COUNT(*) AS v FROM invoices WHERE status = 'open' AND informed_at IS NOT NULL"),
    byMonth: all<{ month: string; total: number }>(
      "SELECT substr(paid_at, 1, 7) AS month, SUM(amount_cents) AS total FROM invoices WHERE status = 'paid' GROUP BY month ORDER BY month DESC LIMIT 6",
    ).reverse(),
  };
}
