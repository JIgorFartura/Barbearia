/**
 * Cielo, pela API do Link de Pagamento. O cliente paga numa página segura da Cielo (o sistema nunca
 * vê o cartão). Na cobrança recorrente, a Cielo guarda o cartão e cobra sozinha todo mês (mensalidade
 * do sistema e do clube). Cada recebedor usa as credenciais da própria conta Cielo (ClientId e Client
 * Secret, no site da Cielo).
 */

export interface CieloCredentials {
  clientId: string;
  clientSecret: string;
}

/** Nos testes troca-se quem fala com a Cielo; CIELO_BASE_URL aponta para um simulador local. */
export const cieloHttp = { fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch };
export const cieloBase = () => (process.env.CIELO_BASE_URL || 'https://cieloecommerce.cielo.com.br').replace(/\/+$/, '');

export class CieloError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Response> {
  try {
    return await cieloHttp.fetch(url, { method, headers: { 'user-agent': 'SistemaBarbearia', ...headers }, body, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new CieloError(`Sem resposta da Cielo (${(err as Error).message}).`, 0);
  }
}

/** Mensagem de erro da Cielo (vem em formatos diferentes conforme o serviço). */
async function errorOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[];
    const list = Array.isArray(j) ? j : ((j.errors ?? j.Errors ?? j.modelState ?? null) as unknown);
    if (Array.isArray(list) && list.length) {
      return list.map((e) => (typeof e === 'string' ? e : String((e as Record<string, unknown>).Message ?? (e as Record<string, unknown>).message ?? JSON.stringify(e)))).join('; ');
    }
    const o = j as Record<string, unknown>;
    return String(o.message ?? o.Message ?? o.error_description ?? o.error ?? (text.slice(0, 200) || `HTTP ${res.status}`));
  } catch {
    return text.slice(0, 200) || `HTTP ${res.status}`;
  }
}

// O token de acesso vale 20 minutos: guarda um por conta e renova um pouco antes.
const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(c: CieloCredentials, fresh: boolean): Promise<string> {
  const cached = tokens.get(c.clientId);
  if (!fresh && cached && cached.until > Date.now()) return cached.token;
  const res = await request(
    'POST',
    `${cieloBase()}/api/public/v2/token`,
    { authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    'grant_type=client_credentials',
  );
  if (res.status === 400 || res.status === 401) throw new CieloError('A Cielo recusou as credenciais: confira o ClientId e o Client Secret.', res.status);
  if (!res.ok) throw new CieloError(`Cielo: ${await errorOf(res)}`, res.status);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new CieloError('A Cielo não devolveu o token de acesso.', 502);
  tokens.set(c.clientId, { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 1200) - 60) * 1000 });
  return j.access_token;
}

/** Chamada à API com o token (renova uma vez se a Cielo disser que venceu). Só fala com o endereço da Cielo. */
export async function cieloCall<T>(c: CieloCredentials, method: string, path: string, body?: unknown): Promise<T> {
  const url = /^https?:\/\//.test(path) ? path : `${cieloBase()}${path}`;
  if (!url.startsWith(`${cieloBase()}/`)) throw new CieloError('Endereço fora da Cielo.', 400);
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(c, attempt > 0);
    const res = await request(
      method,
      url,
      { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body === undefined ? undefined : JSON.stringify(body),
    );
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw new CieloError(await errorOf(res), res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Confere as credenciais (pede um token novo). */
export async function testCielo(c: CieloCredentials): Promise<void> {
  await accessToken(c, true);
}

export interface LinkInput {
  /** Título na página de pagamento. */
  name: string;
  description?: string;
  amountCents: number;
  /** Nosso código (até 16 caracteres): volta no aviso de pagamento. */
  sku: string;
  /** Recorrente: cobra todo mês no cartão guardado pela Cielo. */
  recurrent: boolean;
  /** Último dia em que o link aceita pagamento (AAAA-MM-DD). */
  expirationDate?: string | null;
}

/** Cria o link de pagamento (uso único). Devolve o id na Cielo e o endereço curto para o cliente. */
export async function createLink(c: CieloCredentials, i: LinkInput): Promise<{ id: string; url: string }> {
  const r = await cieloCall<{ id?: string; shortUrl?: string }>(c, 'POST', '/api/public/v1/products/', {
    type: i.recurrent ? 'Recurrent' : 'Payment',
    name: i.name.slice(0, 128),
    ...(i.description ? { description: i.description.slice(0, 256), showDescription: true } : {}),
    price: i.amountCents,
    sku: i.sku.slice(0, 16),
    // Um pagamento por link (na recorrência, um assinante).
    quantity: 1,
    ...(i.expirationDate ? { expirationDate: i.expirationDate } : {}),
    shipping: { type: 'WithoutShipping' },
    // Na recorrência a Cielo não aceita parcelamento.
    ...(i.recurrent ? { recurrent: { interval: 'Monthly' } } : { maxNumberOfInstallments: 1 }),
  });
  if (!r.id || !r.shortUrl) throw new CieloError('A Cielo não devolveu o link de pagamento.', 502);
  return { id: r.id, url: r.shortUrl };
}

export async function deleteLink(c: CieloCredentials, linkId: string): Promise<void> {
  try {
    await cieloCall(c, 'DELETE', `/api/public/v1/products/${encodeURIComponent(linkId)}`);
  } catch (err) {
    if (!(err instanceof CieloError && err.status === 404)) throw err;
  }
}

/** Para a cobrança mensal (a Cielo não cobra mais o cartão). */
export async function deactivateRecurrence(c: CieloCredentials, recurrentPaymentId: string): Promise<void> {
  await cieloCall(c, 'DELETE', `/api/public/v1/RecurrentPayment/Deactivate/${encodeURIComponent(recurrentPaymentId)}`);
}

// ---------- pedidos (cada pagamento feito por um link)

/** Situação do pagamento, nos nossos termos (os avisos mandam número; as consultas, texto). */
export type CardStatus = 'PENDING' | 'RECEIVED' | 'AUTHORIZED' | 'DENIED' | 'EXPIRED' | 'CANCELLED' | 'CHARGEBACK' | 'REFUNDED' | 'UNKNOWN';

const STATUS: Record<string, CardStatus> = {
  '1': 'PENDING',
  '2': 'RECEIVED',
  '3': 'DENIED',
  '4': 'EXPIRED',
  '5': 'CANCELLED',
  '6': 'EXPIRED',
  '7': 'AUTHORIZED',
  '8': 'CHARGEBACK',
  pending: 'PENDING',
  paid: 'RECEIVED',
  denied: 'DENIED',
  expired: 'EXPIRED',
  notfinalized: 'EXPIRED',
  voided: 'CANCELLED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  authorized: 'AUTHORIZED',
  chargeback: 'CHARGEBACK',
  refunded: 'REFUNDED',
};

const key = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export const cieloStatus = (v: unknown): CardStatus => STATUS[key(v)] ?? 'UNKNOWN';

const METHOD: Record<string, string> = {
  '1': 'CREDIT_CARD',
  '2': 'BOLETO',
  '4': 'DEBIT_CARD',
  '5': 'CREDIT_CARD',
  '6': 'PIX',
  '7': 'DEBIT_CARD',
  creditcard: 'CREDIT_CARD',
  debitcard: 'DEBIT_CARD',
  pix: 'PIX',
  boleto: 'BOLETO',
};

export const cieloMethod = (v: unknown): string | null => METHOD[key(v)] ?? null;

type Json = Record<string, unknown>;

/** Primeiro valor presente entre os nomes dados (a Cielo varia maiúsculas e formatos). */
export function pick(o: unknown, ...names: string[]): string | null {
  if (!o || typeof o !== 'object') return null;
  const entries = Object.entries(o as Json);
  for (const n of names) {
    const hit = entries.find(([k]) => k.toLowerCase() === n.toLowerCase());
    if (hit && hit[1] != null && hit[1] !== '') return String(hit[1]);
  }
  return null;
}

export interface OrderInfo {
  status: CardStatus;
  method: string | null;
  amountCents: number | null;
  recurrentPaymentId: string | null;
}

/** O que importa de um pedido consultado na Cielo. */
export function orderInfo(o: unknown): OrderInfo {
  const p = (o && typeof o === 'object' ? ((o as Json).payment ?? (o as Json).Payment) : null) ?? {};
  const recurrent = (p as Json).recurrentPayment ?? (p as Json).RecurrentPayment;
  const amount = pick(p, 'amount', 'price') ?? pick(o, 'amount', 'price');
  return {
    status: cieloStatus(pick(p, 'status') ?? pick(o, 'payment_status', 'status')),
    method: cieloMethod(pick(p, 'type', 'paymentMethodType') ?? pick(o, 'payment_method_type')),
    amountCents: amount != null && /^\d+$/.test(amount) ? Number(amount) : null,
    recurrentPaymentId:
      pick(p, 'recurrentPaymentId', 'pagadorRecurrentPaymentId') ?? pick(recurrent, 'id', 'recurrentPaymentId') ?? pick(o, 'recurrent_payment_id', 'pagador_recurrent_payment_id'),
  };
}

export async function getOrder(c: CieloCredentials, orderNumber: string): Promise<OrderInfo> {
  return orderInfo(await cieloCall<Json>(c, 'GET', `/api/public/v2/orders/${encodeURIComponent(orderNumber)}`));
}

/** Pedidos feitos por um link (conferência quando um aviso não chega). */
export async function linkOrders(c: CieloCredentials, linkId: string): Promise<{ orderNumber: string; status: CardStatus }[]> {
  const r = await cieloCall<Json>(c, 'GET', `/api/public/v1/products/${encodeURIComponent(linkId)}/payments`);
  const orders = (r.orders ?? r.Orders ?? []) as Json[];
  return orders
    .map((o) => {
      const self = ((o.links ?? []) as Json[]).find((l) => pick(l, 'rel') === 'self');
      const fromHref = pick(self, 'href')?.split('/').pop() ?? null;
      return { orderNumber: pick(o, 'orderNumber', 'orderId', 'checkoutCieloOrderNumber', 'id') ?? fromHref ?? '', status: orderInfo(o).status };
    })
    .filter((o) => o.orderNumber);
}
