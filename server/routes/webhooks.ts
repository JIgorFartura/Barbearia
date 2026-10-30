import crypto from 'node:crypto';
import express, { Router, type Request } from 'express';
import { handleAsaasEvent } from '../asaasWebhook.js';
import { handleShopAsaasEvent } from '../shopAsaas.js';
import { autoSaleNfse, issueChargeNfse, nfseEvent } from '../shopNfse.js';
import { settlePixCheckout } from '../pixCheckout.js';
import { handleCieloNotice } from '../cards.js';
import { handleInbound } from '../bot/inbound.js';
import { handlePlatformInbound } from '../manager.js';
import { platformChannel, platformWebhookToken } from '../platform.js';
import { setConnection } from '../connection.js';
import { get } from '../db.js';
import { HttpError } from '../http.js';
import { waConfig, type ShopBot } from '../messaging.js';
import { parseEvolutionConnection, parseEvolutionWebhook, parseMetaWebhook, verifyMetaSignature, zMetaConfig, type Inbound } from '../whatsapp.js';

/**
 * Onde o WhatsApp entrega as mensagens. Cada barbearia tem a sua URL com um segredo
 * (/api/webhooks/<canal>/<segredo>), que aparece no painel, aba Robô.
 */
export const webhooksRouter = Router();

function shopByToken(req: Request, provider: 'meta' | 'evolution'): ShopBot {
  const shop = get<ShopBot>('SELECT * FROM barbershops WHERE webhook_token = ? AND active = 1', [String(req.params.token ?? '')]);
  if (!shop || shop.wa_provider !== provider) throw new HttpError(404, 'Não encontrado.');
  return shop;
}

/** Responde o WhatsApp na hora e processa depois (a IA pode levar alguns segundos). */
function processLater(shop: ShopBot, messages: Inbound[]): void {
  for (const m of messages) {
    void handleInbound({ shopId: shop.id, from: m.from, text: m.text, name: m.name, externalId: m.externalId }).catch((err) =>
      console.error(`[webhook] ${shop.slug}:`, err),
    );
  }
}

// Verificação do webhook na Meta (GET com hub.challenge).
webhooksRouter.get('/meta/:token', (req, res) => {
  const shop = shopByToken(req, 'meta');
  const cfg = zMetaConfig.safeParse(waConfig(shop));
  if (req.query['hub.mode'] === 'subscribe' && cfg.success && cfg.data.verifyToken && req.query['hub.verify_token'] === cfg.data.verifyToken) {
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    return;
  }
  res.sendStatus(403);
});

webhooksRouter.post('/meta/:token', (req, res) => {
  const shop = shopByToken(req, 'meta');
  const cfg = zMetaConfig.safeParse(waConfig(shop));
  if (cfg.success && cfg.data.appSecret && !verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), cfg.data.appSecret)) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);
  processLater(shop, parseMetaWebhook(req.body));
});

webhooksRouter.post('/evolution/:token', (req, res) => {
  const shop = shopByToken(req, 'evolution');
  res.sendStatus(200);
  // A Evolution avisa quando a sessão do QR Code cai ou volta (evento CONNECTION_UPDATE).
  const state = parseEvolutionConnection(req.body);
  if (state) {
    void setConnection(shop.id, state === 'open', state === 'open' ? 'conectado' : 'A sessão do WhatsApp foi encerrada (Evolution).', new Date(), { immediate: true }).catch((err) =>
      console.error(`[webhook] ${shop.slug}:`, err),
    );
    return;
  }
  processLater(shop, parseEvolutionWebhook(req.body));
});

// ---------- WhatsApp da plataforma: o dono conversa com o gerente virtual (URL na aba Sistema do master)

function platformAuth(req: Request, provider: 'meta' | 'evolution') {
  const token = Buffer.from(String(req.params.token ?? ''));
  const expected = Buffer.from(platformWebhookToken());
  const channel = platformChannel();
  if (token.length !== expected.length || !crypto.timingSafeEqual(token, expected) || channel.provider !== provider) throw new HttpError(404, 'Não encontrado.');
  return channel;
}

function managerLater(messages: Inbound[]): void {
  for (const m of messages) {
    void handlePlatformInbound({ from: m.from, text: m.text, externalId: m.externalId }).catch((err) => console.error('[gerente virtual]', err));
  }
}

webhooksRouter.get('/platform/meta/:token', (req, res) => {
  const cfg = zMetaConfig.safeParse(platformAuth(req, 'meta').config);
  if (req.query['hub.mode'] === 'subscribe' && cfg.success && cfg.data.verifyToken && req.query['hub.verify_token'] === cfg.data.verifyToken) {
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    return;
  }
  res.sendStatus(403);
});

webhooksRouter.post('/platform/meta/:token', (req, res) => {
  const cfg = zMetaConfig.safeParse(platformAuth(req, 'meta').config);
  if (cfg.success && cfg.data.appSecret && !verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), cfg.data.appSecret)) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);
  managerLater(parseMetaWebhook(req.body));
});

webhooksRouter.post('/platform/evolution/:token', (req, res) => {
  platformAuth(req, 'evolution');
  res.sendStatus(200);
  managerLater(parseEvolutionWebhook(req.body));
});

/**
 * Avisos da Cielo (pagamento no cartão e mudança de situação). Cada recebedor tem a sua URL, com um
 * segredo; os dados vêm como formulário (ou JSON, com o endereço para buscar o pagamento).
 */
webhooksRouter.post('/cielo/:token', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
  res.json(await handleCieloNotice(String(req.params.token ?? ''), req.body ?? {}));
});

/** Avisos do Asaas (mensalidade paga, nota fiscal emitida). O token vem no cabeçalho asaas-access-token. */
/** Asaas da própria barbearia (PIX do clube com baixa automática e Pix Automático). */
webhooksRouter.post('/asaas/barbearia/:token', (req, res) => {
  const r = handleShopAsaasEvent(String(req.params.token ?? ''), req.get('asaas-access-token') ?? undefined, req.body ?? {});
  // Nota fiscal: a situação que o Asaas mandou e, com a mensalidade paga, a nota dela (automática).
  if (r.shopId && String(req.body?.event ?? '').startsWith('INVOICE_') && req.body?.invoice) nfseEvent(r.shopId, req.body.invoice, String(req.body.event));
  if (r.paidChargeId) void issueChargeNfse(r.paidChargeId).catch((err) => console.error('[nota fiscal]', err));
  // PIX da comanda pago: a venda é registrada sozinha (e a nota sai, se a barbearia emite automática).
  if (r.shopId && r.comanda) {
    const { saleId } = settlePixCheckout(r.shopId, r.comanda.id, r.comanda.paymentId);
    if (saleId) autoSaleNfse(r.shopId, saleId);
  }
  res.json({ ok: r.ok, note: r.note });
});

webhooksRouter.post('/asaas', (req, res) => {
  res.json(handleAsaasEvent(req.get('asaas-access-token') ?? undefined, req.body ?? {}));
});
