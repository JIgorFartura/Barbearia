import express, { Router, type Request } from 'express';
import { handleAsaasEvent } from '../asaasWebhook.js';
import { handleCieloNotice } from '../cards.js';
import { handleInbound } from '../bot/inbound.js';
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

/**
 * Avisos da Cielo (pagamento no cartão e mudança de situação). Cada recebedor tem a sua URL, com um
 * segredo; os dados vêm como formulário (ou JSON, com o endereço para buscar o pagamento).
 */
webhooksRouter.post('/cielo/:token', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
  res.json(await handleCieloNotice(String(req.params.token ?? ''), req.body ?? {}));
});

/** Avisos do Asaas (mensalidade paga, nota fiscal emitida). O token vem no cabeçalho asaas-access-token. */
webhooksRouter.post('/asaas', (req, res) => {
  res.json(handleAsaasEvent(req.get('asaas-access-token') ?? undefined, req.body ?? {}));
});
