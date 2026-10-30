import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { AsaasError, asaasHttp, sameToken, type AsaasPayment } from './asaas.js';
import { charge, confirmCharge, type ChargeView } from './charges.js';
import { shopNow } from './clock.js';
import { get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { sendMessage, shopBot } from './messaging.js';
import { addDays } from './time.js';

/**
 * Asaas da própria barbearia (opcional): a conta é dela, o dinheiro cai direto lá (a plataforma não
 * passa a mão em nada). Com o Asaas ligado, a mensalidade do clube sai com PIX de baixa automática: o
 * cliente paga, o Asaas avisa (webhook) e o mês é liberado e entra no caixa sozinho, sem o dono
 * conferir extrato. Pix Automático (opcional; o Asaas libera na conta): o cliente autoriza uma vez,
 * pagando o primeiro mês, e nos meses seguintes o débito cai sozinho no vencimento.
 */

export type ShopAsaasEnv = 'sandbox' | 'production';
const BASE: Record<ShopAsaasEnv, string> = { sandbox: 'https://api-sandbox.asaas.com/v3', production: 'https://api.asaas.com/v3' };
/** A cobrança do Pix Automático é criada entre 2 e 10 dias úteis antes do vencimento: 8 dias corridos. */
export const PIX_AUTO_ADVANCE_DAYS = 8;

interface ShopAsaasRow {
  id: number;
  name: string;
  slug: string;
  asaas_shop_env: string | null;
  asaas_shop_key: string | null;
  asaas_shop_token: string | null;
  asaas_shop_webhook_at: string | null;
  pix_auto_enabled: number;
}

const row = (shopId: number) =>
  get<ShopAsaasRow>('SELECT id, name, slug, asaas_shop_env, asaas_shop_key, asaas_shop_token, asaas_shop_webhook_at, pix_auto_enabled FROM barbershops WHERE id = ?', [shopId]);

/** Conta Asaas ligada? */
export const shopAsaasOn = (shopId: number) => Boolean(row(shopId)?.asaas_shop_key);
export const pixAutoOn = (shopId: number) => {
  const r = row(shopId);
  return Boolean(r?.asaas_shop_key && r.pix_auto_enabled);
};

/** Para a tela do dono: a chave nunca volta (só se está salva). */
export function shopAsaasView(shopId: number, appUrl: string) {
  const r = row(shopId)!;
  return {
    connected: Boolean(r.asaas_shop_key),
    env: (r.asaas_shop_env === 'production' ? 'production' : 'sandbox') as ShopAsaasEnv,
    pixAuto: Boolean(r.pix_auto_enabled),
    webhookUrl: r.asaas_shop_token ? `${appUrl}/api/webhooks/asaas/barbearia/${r.asaas_shop_token}` : null,
    webhookToken: r.asaas_shop_token,
    webhookAt: r.asaas_shop_webhook_at,
  };
}

export function saveShopAsaas(shopId: number, s: { env: ShopAsaasEnv; apiKey?: string | null; pixAuto: boolean; disconnect?: boolean }): void {
  if (s.disconnect) {
    run('UPDATE barbershops SET asaas_shop_key = NULL, pix_auto_enabled = 0 WHERE id = ?', [shopId]);
    return;
  }
  const r = row(shopId)!;
  const key = s.apiKey?.trim() || r.asaas_shop_key;
  if (!key) throw new HttpError(400, 'Cole a chave de API da sua conta Asaas.');
  // Trocou de conta: os cadastros dos clientes eram da outra.
  if (s.apiKey?.trim() && s.apiKey.trim() !== r.asaas_shop_key) run('UPDATE customers SET asaas_shop_customer_id = NULL WHERE barbershop_id = ?', [shopId]);
  run('UPDATE barbershops SET asaas_shop_env = ?, asaas_shop_key = ?, pix_auto_enabled = ?, asaas_shop_token = COALESCE(asaas_shop_token, ?) WHERE id = ?', [
    s.env,
    key,
    s.pixAuto ? 1 : 0,
    crypto.randomBytes(24).toString('base64url'),
    shopId,
  ]);
}

export async function shopAsaasCall<T>(shopId: number, method: string, path: string, body?: unknown): Promise<T> {
  const r = row(shopId);
  if (!r?.asaas_shop_key) throw new AsaasError('Asaas da barbearia não ligado.', 0);
  const env: ShopAsaasEnv = r.asaas_shop_env === 'production' ? 'production' : 'sandbox';
  let res: Response;
  try {
    res = await asaasHttp.fetch(`${process.env.ASAAS_BASE_URL || BASE[env]}${path}`, {
      method,
      headers: { 'content-type': 'application/json', access_token: r.asaas_shop_key, 'user-agent': 'SistemaBarbearia/1.0' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AsaasError(`Sem resposta do Asaas: ${(err as Error).message}`, 0);
  }
  const text = await res.text();
  let data: { errors?: { description?: string }[] } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* resposta sem JSON */
  }
  if (!res.ok) {
    const detail = data?.errors?.map((e) => e.description).filter(Boolean).join(' ');
    throw new AsaasError(detail || (res.status === 401 ? 'Chave de API do Asaas recusada.' : `Asaas respondeu ${res.status}.`), res.status);
  }
  return data as T;
}

export async function testShopAsaas(shopId: number): Promise<void> {
  await shopAsaasCall(shopId, 'GET', '/customers?limit=1');
}

// ---------- CPF do cliente (o PIX com baixa automática pede)

/** "123.456.789-09" → "12345678909", conferindo os dígitos verificadores. */
export function normalizeCpf(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return null;
  const check = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]) ? d : null;
}

export function saveCustomerCpf(shopId: number, customerId: number, raw: string): void {
  const cpf = normalizeCpf(raw);
  if (!cpf) throw new HttpError(400, 'CPF inválido. Confira os números.');
  run('UPDATE customers SET cpf = ?, asaas_shop_customer_id = NULL WHERE id = ? AND barbershop_id = ?', [cpf, customerId, shopId]);
}

/** O cliente na conta Asaas da barbearia (criado na primeira cobrança). null: falta o CPF. */
export async function ensureCustomer(shopId: number, customerId: number): Promise<string | null> {
  const c = get<{ id: number; name: string; phone: string; cpf: string | null; asaas_shop_customer_id: string | null }>(
    'SELECT id, name, phone, cpf, asaas_shop_customer_id FROM customers WHERE id = ? AND barbershop_id = ?',
    [customerId, shopId],
  );
  if (!c?.cpf) return null;
  if (c.asaas_shop_customer_id) return c.asaas_shop_customer_id;
  const r = await shopAsaasCall<{ id: string }>(shopId, 'POST', '/customers', {
    name: c.name,
    cpfCnpj: c.cpf,
    mobilePhone: c.phone,
    externalReference: `cliente:${c.id}`,
    // Os avisos vão pelo robô da barbearia (e-mail/SMS do Asaas podem ter custo).
    notificationDisabled: true,
  });
  run('UPDATE customers SET asaas_shop_customer_id = ? WHERE id = ?', [r.id, c.id]);
  return r.id;
}

// ---------- PIX da mensalidade do clube com baixa automática

export type AutoPix = { payload: string; qr: string; auto: true } | { needsCpf: true } | { error: string };

export const qrFrom = async (payload: string, encodedImage?: string | null) =>
  encodedImage ? `data:image/png;base64,${encodedImage}` : await QRCode.toDataURL(payload, { margin: 1, width: 260 });

/**
 * O PIX (copia e cola e QR Code) da mensalidade em aberto, gerado na conta Asaas da barbearia (uma vez
 * por mensalidade). null: a barbearia não ligou o Asaas (vale o PIX da chave dela, conferido à mão).
 */
export async function asaasChargePix(c: ChargeView, now: Date = new Date()): Promise<AutoPix | null> {
  if (c.status !== 'open' || !shopAsaasOn(c.barbershop_id)) return null;
  const saved = get<{ asaas_payment_id: string | null; asaas_pix_payload: string | null; asaas_pix_qr: string | null }>(
    'SELECT asaas_payment_id, asaas_pix_payload, asaas_pix_qr FROM charges WHERE id = ?',
    [c.id],
  )!;
  if (saved.asaas_pix_payload) return { payload: saved.asaas_pix_payload, qr: saved.asaas_pix_qr ?? (await qrFrom(saved.asaas_pix_payload)), auto: true };
  try {
    const customer = await ensureCustomer(c.barbershop_id, c.customer_id);
    if (!customer) return { needsCpf: true };
    let paymentId = saved.asaas_payment_id;
    if (!paymentId) {
      const today = shopNow(c.barbershop_id, now).date;
      const p = await shopAsaasCall<{ id: string }>(c.barbershop_id, 'POST', '/payments', {
        customer,
        billingType: 'PIX',
        value: c.amount_cents / 100,
        // O Asaas não aceita vencimento no passado (atrasada vence hoje).
        dueDate: !c.due_date || c.due_date < today ? today : c.due_date,
        description: c.description,
        externalReference: `clube:${c.id}`,
      });
      paymentId = p.id;
      run('UPDATE charges SET asaas_payment_id = ? WHERE id = ?', [paymentId, c.id]);
    }
    const qr = await shopAsaasCall<{ encodedImage?: string; payload: string }>(c.barbershop_id, 'GET', `/payments/${paymentId}/pixQrCode`);
    const image = await qrFrom(qr.payload, qr.encodedImage);
    run('UPDATE charges SET asaas_pix_payload = ?, asaas_pix_qr = ? WHERE id = ?', [qr.payload, image, c.id]);
    return { payload: qr.payload, qr: image, auto: true };
  } catch (err) {
    if (!(err instanceof AsaasError)) throw err;
    console.warn(`[asaas da barbearia ${c.barbershop_id}]`, err.message);
    return { error: err.message };
  }
}

/** Mensalidade cancelada: tira a cobrança do Asaas também (sem travar se falhar). */
export async function cancelAsaasChargeOf(chargeId: number): Promise<void> {
  const c = get<{ barbershop_id: number; asaas_payment_id: string | null }>('SELECT barbershop_id, asaas_payment_id FROM charges WHERE id = ?', [chargeId]);
  if (!c?.asaas_payment_id || !shopAsaasOn(c.barbershop_id)) return;
  await shopAsaasCall(c.barbershop_id, 'DELETE', `/payments/${c.asaas_payment_id}`).catch((err) => console.warn('[asaas da barbearia]', (err as Error).message));
}

// ---------- Pix Automático do clube

/** Onde vem o copia e cola na resposta da autorização (o QR imediato do 1º pagamento). */
function immediatePix(r: Record<string, unknown>): { payload: string | null; image: string | null } {
  const q = (r.immediateQrCode ?? r.qrCode ?? r) as Record<string, unknown>;
  const payload = (q.payload ?? q.copyPaste ?? r.payload ?? null) as string | null;
  const image = (q.encodedImage ?? r.encodedImage ?? null) as string | null;
  return { payload, image };
}

/**
 * O assinante quer o débito automático: cria a autorização do Pix Automático no Asaas com o QR Code do
 * primeiro pagamento (a mensalidade em aberto). Pagando esse QR, ele autoriza os próximos meses; a
 * autorização fica ativa quando o Asaas avisa (PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED).
 */
export async function startPixAuto(shopId: number, customerId: number, now: Date = new Date()): Promise<{ payload: string; qr: string } | { needsCpf: true }> {
  if (!pixAutoOn(shopId)) throw new HttpError(409, 'A barbearia não oferece o Pix Automático.');
  const m = get<{ id: number; status: string; pix_auto_id: string | null; pix_auto_status: string | null; price_cents: number; plan_name: string }>(
    `SELECT m.id, m.status, m.pix_auto_id, m.pix_auto_status, p.price_cents, p.name AS plan_name FROM club_members m JOIN club_plans p ON p.id = m.plan_id
      WHERE m.barbershop_id = ? AND m.customer_id = ? AND m.status <> 'cancelled'`,
    [shopId, customerId],
  );
  if (!m) throw new HttpError(404, 'Você não tem assinatura do clube.');
  if (m.pix_auto_status === 'ACTIVE') throw new HttpError(409, 'O Pix Automático já está ligado.');
  // Pediu de novo sem pagar o 1º QR: a autorização anterior sai antes de criar outra.
  if (m.pix_auto_id && m.pix_auto_status === 'CREATED') await cancelPixAuto(m.id);
  const open = get<{ id: number; amount_cents: number; period_end: string; description: string }>(
    "SELECT id, amount_cents, period_end, description FROM charges WHERE club_member_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [m.id],
  );
  if (!open) throw new HttpError(409, 'O Pix Automático começa junto com uma mensalidade: espere a próxima chegar.');
  try {
    const customer = await ensureCustomer(shopId, customerId);
    if (!customer) return { needsCpf: true };
    const today = shopNow(shopId, now).date;
    const start = addDays(open.period_end, 1);
    const r = await shopAsaasCall<Record<string, unknown> & { id: string; status?: string }>(shopId, 'POST', '/pix/automatic/authorizations', {
      customerId: customer,
      frequency: 'MONTHLY',
      contractId: `clube-${m.id}-${Date.now().toString(36)}`.slice(0, 35),
      startDate: start > today ? start : addDays(today, 1),
      value: m.price_cents / 100,
      description: `Clube ${m.plan_name}`.slice(0, 140),
      // O 1º pagamento: a mensalidade em aberto. Pagar este QR é o que autoriza os próximos meses.
      immediateQrCode: { originalValue: open.amount_cents / 100, expirationSeconds: 2 * 86400, description: open.description.slice(0, 140) },
    });
    const pix = immediatePix(r);
    if (!pix.payload) throw new AsaasError('O Asaas não devolveu o QR Code do Pix Automático.', 0);
    run('UPDATE club_members SET pix_auto_id = ?, pix_auto_status = ?, pix_auto_charge_id = ? WHERE id = ?', [r.id, r.status ?? 'CREATED', open.id, m.id]);
    return { payload: pix.payload, qr: await qrFrom(pix.payload, pix.image) };
  } catch (err) {
    if (err instanceof AsaasError) throw new HttpError(502, `Não deu para ligar o Pix Automático: ${err.message}`);
    throw err;
  }
}

/** Mensalidade seguinte de quem está no Pix Automático: a cobrança ligada à autorização (o débito cai no vencimento). */
export async function schedulePixAutoCharge(chargeId: number): Promise<boolean> {
  const c = charge(chargeId);
  const m = c.club_member_id ? get<{ pix_auto_id: string | null; pix_auto_status: string | null }>('SELECT pix_auto_id, pix_auto_status FROM club_members WHERE id = ?', [c.club_member_id]) : undefined;
  if (!m?.pix_auto_id || m.pix_auto_status !== 'ACTIVE' || !pixAutoOn(c.barbershop_id)) return false;
  try {
    const customer = await ensureCustomer(c.barbershop_id, c.customer_id);
    if (!customer) return false;
    const p = await shopAsaasCall<{ id: string }>(c.barbershop_id, 'POST', '/payments', {
      customer,
      billingType: 'PIX',
      value: c.amount_cents / 100,
      dueDate: c.due_date,
      description: c.description,
      externalReference: `clube:${c.id}`,
      pixAutomaticAuthorizationId: m.pix_auto_id,
    });
    run('UPDATE charges SET asaas_payment_id = ?, auto_debit = 1 WHERE id = ?', [p.id, c.id]);
    return true;
  } catch (err) {
    if (!(err instanceof AsaasError)) throw err;
    console.warn(`[pix automático ${c.barbershop_id}]`, err.message);
    return false;
  }
}

/** O assinante desligou o débito automático (ou cancelou o clube). */
export async function cancelPixAuto(memberId: number): Promise<void> {
  const m = get<{ barbershop_id: number; pix_auto_id: string | null; pix_auto_status: string | null }>(
    'SELECT barbershop_id, pix_auto_id, pix_auto_status FROM club_members WHERE id = ?',
    [memberId],
  );
  if (!m?.pix_auto_id || m.pix_auto_status === 'CANCELLED') return;
  run("UPDATE club_members SET pix_auto_status = 'CANCELLED' WHERE id = ?", [memberId]);
  if (shopAsaasOn(m.barbershop_id)) {
    await shopAsaasCall(m.barbershop_id, 'DELETE', `/pix/automatic/authorizations/${m.pix_auto_id}`).catch((err) => console.warn('[pix automático]', (err as Error).message));
  }
}

// ---------- avisos do Asaas da barbearia (webhook)

interface ShopAsaasEvent {
  id?: string;
  event?: string;
  payment?: AsaasPayment & { externalReference?: string | null; pixAutomaticAuthorizationId?: string | null };
  pixAutomaticAuthorization?: { id?: string; status?: string };
  authorization?: { id?: string; status?: string };
}

const METHOD: Record<string, 'pix' | 'credito' | 'debito' | 'outro'> = { PIX: 'pix', CREDIT_CARD: 'credito', DEBIT_CARD: 'debito' };

async function paidNotice(shopId: number, chargeId: number): Promise<void> {
  const c = charge(chargeId);
  const shop = shopBot(shopId);
  await sendMessage({
    shop,
    customerId: c.customer_id,
    phone: c.phone,
    waId: c.wa_id,
    kind: 'assinatura',
    text: `Recebemos o pagamento do clube, ${c.customer_name.split(/\s+/)[0]}! ✅ ${c.description}. Os benefícios estão liberados. 👊`,
  }).catch((err) => console.error('[clube]', err));
}

/**
 * Aviso do Asaas da barbearia: pagamento recebido (baixa a mensalidade sozinha) e situação do Pix
 * Automático. Nunca recusa por regra de negócio (senão o Asaas pausa a fila); só o segredo errado.
 */
export function handleShopAsaasEvent(
  urlToken: string,
  headerToken: string | undefined,
  body: ShopAsaasEvent,
): { ok: true; note?: string; shopId?: number; paidChargeId?: number; comanda?: { id: number | null; paymentId: string } } {
  const shop = urlToken ? get<{ id: number; asaas_shop_token: string }>('SELECT id, asaas_shop_token FROM barbershops WHERE asaas_shop_token = ?', [urlToken]) : undefined;
  if (!shop || !headerToken || !sameToken(headerToken, shop.asaas_shop_token)) throw new HttpError(401, 'Token do webhook inválido.');
  run('UPDATE barbershops SET asaas_shop_webhook_at = ? WHERE id = ?', [nowIso(), shop.id]);
  const event = body.event ?? '';
  const p = body.payment;

  if ((event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') && p?.id) {
    // PIX da comanda: quem registra a venda é a rota (pixCheckout depende deste módulo).
    const comanda = /^comanda:(\d+)$/.exec(p.externalReference ?? '')?.[1];
    if (comanda || get('SELECT 1 AS ok FROM pix_checkouts WHERE barbershop_id = ? AND asaas_payment_id = ?', [shop.id, p.id])) {
      return { ok: true, shopId: shop.id, comanda: { id: comanda ? Number(comanda) : null, paymentId: p.id } };
    }
    const ref = /^clube:(\d+)$/.exec(p.externalReference ?? '')?.[1];
    const c =
      get<{ id: number; status: string }>('SELECT id, status FROM charges WHERE barbershop_id = ? AND asaas_payment_id = ?', [shop.id, p.id]) ??
      (ref ? get<{ id: number; status: string }>('SELECT id, status FROM charges WHERE barbershop_id = ? AND id = ?', [shop.id, Number(ref)]) : undefined);
    if (!c) return { ok: true, note: 'cobrança desconhecida' };
    if (c.status !== 'open') return { ok: true, note: 'já baixada' };
    confirmCharge(shop.id, c.id, { method: METHOD[p.billingType ?? 'PIX'] ?? 'pix', userId: null });
    void paidNotice(shop.id, c.id);
    return { ok: true, shopId: shop.id, paidChargeId: c.id };
  }

  if (event.startsWith('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_')) {
    const authId = body.pixAutomaticAuthorization?.id ?? body.authorization?.id;
    const m = authId
      ? get<{ id: number; pix_auto_charge_id: number | null }>('SELECT id, pix_auto_charge_id FROM club_members WHERE barbershop_id = ? AND pix_auto_id = ?', [shop.id, authId])
      : undefined;
    if (!m) return { ok: true, note: 'autorização desconhecida' };
    const status = event.replace('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_', '');
    const map: Record<string, string> = { CREATED: 'CREATED', ACTIVATED: 'ACTIVE', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', REFUSED: 'REFUSED' };
    run('UPDATE club_members SET pix_auto_status = ? WHERE id = ?', [map[status] ?? status, m.id]);
    // Ativou: o 1º pagamento (QR imediato) já foi liquidado, então a mensalidade dele está paga.
    if (status === 'ACTIVATED' && m.pix_auto_charge_id) {
      const c = get<{ status: string }>('SELECT status FROM charges WHERE id = ?', [m.pix_auto_charge_id]);
      if (c?.status === 'open') {
        confirmCharge(shop.id, m.pix_auto_charge_id, { method: 'pix', userId: null });
        void paidNotice(shop.id, m.pix_auto_charge_id);
        return { ok: true, shopId: shop.id, paidChargeId: m.pix_auto_charge_id };
      }
    }
    return { ok: true };
  }
  if (event.startsWith('INVOICE_')) return { ok: true, shopId: shop.id, note: 'nota fiscal' };
  return { ok: true, note: 'evento ignorado' };
}
