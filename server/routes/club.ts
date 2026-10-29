import type { Router } from 'express';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { charge, chargesToConfirm, confirmCharge, pixSettings, rejectClaim, savePixSettings, undoConfirm } from '../charges.js';
import { cancelMembership, clubCoverage, clubOverview, deletePlan, memberView, savePlan, sendClubCharge, subscribe } from '../club.js';
import { shopNow } from '../clock.js';
import { growthSettings, referralsOverview, saveGrowthSettings, upcomingBirthdays } from '../growth.js';
import { IDLE_PER_DAY, idleStats } from '../idle.js';
import { idleSettings, saveIdleSettings } from '../promo.js';
import { shopOnlinePayments } from '../gatewayPayments.js';
import { cancelMemberCard } from '../cards.js';
import { cieloWebhookUrl, saveShopCielo, secretHint, shopCardStatus, shopCielo } from '../cardSettings.js';
import { CieloError, testCielo } from '../cielo.js';
import { AsaasError } from '../asaas.js';
import { saveShopAsaas, shopAsaasView, testShopAsaas } from '../shopAsaas.js';
import { config } from '../config.js';
import { get, run } from '../db.js';
import { METHODS } from '../finance.js';
import { HttpError, idParam, parseBody, zId, zText } from '../http.js';
import { shopBot } from '../messaging.js';
import { PIX_KEY_TYPES, normalizePixKey, pixKeyType } from '../pix.js';
import { receiptInfo, sendReceipt } from '../receipts.js';
import { isTime } from '../time.js';

const zPlan = z.object({
  name: z.string().trim().min(2, 'Dê um nome ao plano.').max(60),
  description: zText(300),
  price_cents: z.number().int().min(100, 'O preço mínimo é R$ 1,00.').max(10_000_000),
  uses_per_month: z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullish()
    .transform((v) => v ?? null),
  active: z.boolean().default(true),
  item_ids: z.array(zId).max(30),
});

const pixView = (shop: number) => {
  const s = pixSettings(shop);
  return { ...s, pix_type: s.pix_key ? pixKeyType(s.pix_key) : null };
};

/** Clube de assinatura, chave PIX da barbearia e confirmação dos PIX avisados pelos clientes (painel do dono). */
export function registerClubRoutes(router: Router): void {
  router.get('/pix', (req, res) => {
    res.json(pixView(shopId(req)));
  });

  router.put('/pix', (req, res) => {
    const body = parseBody(z.object({ pix_type: z.enum(PIX_KEY_TYPES), pix_key: zText(100), pix_name: zText(25), pix_city: zText(15) }), req.body);
    let key: string | null = null;
    if (body.pix_key) {
      key = normalizePixKey(body.pix_type, body.pix_key);
      if (!key) throw new HttpError(400, 'Chave PIX inválida para o tipo escolhido.');
    }
    savePixSettings(shopId(req), { pix_key: key, pix_name: body.pix_name, pix_city: body.pix_city });
    res.json(pixView(shopId(req)));
  });

  router.get('/club', (req, res) => {
    res.json(clubOverview(shopId(req)));
  });

  router.put('/club/settings', (req, res) => {
    const body = parseBody(z.object({ club_commission_pct: z.number().int().min(0).max(100) }), req.body);
    run('UPDATE barbershops SET club_commission_pct = ? WHERE id = ?', [body.club_commission_pct, shopId(req)]);
    res.json(clubOverview(shopId(req)));
  });

  router.post('/club/plans', (req, res) => {
    res.status(201).json(savePlan(shopId(req), null, parseBody(zPlan, req.body)));
  });

  router.put('/club/plans/:id', (req, res) => {
    res.json(savePlan(shopId(req), idParam(req), parseBody(zPlan, req.body)));
  });

  router.delete('/club/plans/:id', (req, res) => {
    deletePlan(shopId(req), idParam(req));
    res.json({ ok: true });
  });

  /** Assinante novo pelo balcão: pagou na hora (entra no caixa) ou recebe o PIX pelo WhatsApp. */
  router.post('/club/members', async (req, res) => {
    const body = parseBody(
      z.object({ customer_id: zId, plan_id: zId, paid_method: z.enum(METHODS).nullish(), send_pix: z.boolean().default(false) }),
      req.body,
    );
    const shop = shopId(req);
    const member = subscribe(shop, body.customer_id, body.plan_id, { userId: req.user!.id, paidMethod: body.paid_method ?? null });
    const sent = !body.paid_method && body.send_pix && member.open_charge ? await sendClubCharge(shopBot(shop), member.open_charge.id) : false;
    res.status(201).json({ member: memberView(member.id), sent });
  });

  router.post('/club/members/:id/cancel', async (req, res) => {
    const member = cancelMembership(shopId(req), idParam(req));
    // No cartão automático, a Cielo para de cobrar; se falhar, o dono vê como cancelar na Cielo.
    const warning = await cancelMemberCard(member.id);
    res.json({ ...member, warning });
  });

  /** Reenvia pelo WhatsApp a mensalidade em aberto, com o PIX. */
  router.post('/club/members/:id/send-pix', async (req, res) => {
    const shop = shopId(req);
    const member = memberView(idParam(req));
    if (member.barbershop_id !== shop) throw new HttpError(404, 'Assinante não encontrado.');
    if (!member.open_charge) throw new HttpError(409, 'Não há mensalidade em aberto para esse assinante.');
    if (!pixSettings(shop).pix_key) throw new HttpError(409, 'Cadastre a chave PIX da barbearia para mandar a cobrança.');
    if (!(await sendClubCharge(shopBot(shop), member.open_charge.id))) throw new HttpError(502, 'Não deu para enviar pelo WhatsApp agora. Confira a conexão na aba Robô WhatsApp.');
    res.json({ ok: true });
  });

  // ---------- PIX avisados pelos clientes (mensalidade do clube), com o comprovante que eles mandaram

  router.get('/charges/to-confirm', (req, res) => {
    res.json(chargesToConfirm(shopId(req)).map(({ receipt_file, receipt_type, receipt_at, ...c }) => ({ ...c, receipt: receiptInfo({ receipt_file, receipt_type, receipt_at }) })));
  });

  /** A cópia do comprovante para a barbearia (foto na tela; PDF baixa). */
  router.get('/charges/:id/receipt', (req, res) => {
    sendReceipt(res, charge(idParam(req), shopId(req)));
  });

  router.post('/charges/:id/confirm', (req, res) => {
    const body = parseBody(z.object({ method: z.enum(METHODS).default('pix') }), req.body ?? {});
    res.json(confirmCharge(shopId(req), idParam(req), { method: body.method, userId: req.user!.id }));
  });

  router.post('/charges/:id/reject', (req, res) => {
    res.json(rejectClaim(shopId(req), idParam(req)));
  });

  router.post('/charges/:id/undo', (req, res) => {
    res.json(undoConfirm(shopId(req), idParam(req)));
  });

  // ---------- cartão dos clientes pela Cielo da barbearia (clube no automático)

  const cardView = (shop: number) => {
    const s = shopCielo(shop);
    const slug = get<{ slug: string }>('SELECT slug FROM barbershops WHERE id = ?', [shop])!.slug;
    return {
      clientId: s.clientId,
      secretHint: secretHint(s.clientSecret),
      enabled: s.enabled,
      feePct: s.feePct,
      webhookUrl: s.webhookToken ? cieloWebhookUrl(s.webhookToken) : null,
      returnUrl: `${config.appUrl}/b/${slug}/conta`,
      webhookAt: s.webhookAt,
      status: shopCardStatus(shop),
      payments: shopOnlinePayments(shop),
    };
  };

  router.get('/online', (req, res) => {
    res.json(cardView(shopId(req)));
  });

  router.put('/online', (req, res) => {
    const body = parseBody(
      z.object({ clientId: zText(100), clientSecret: zText(200), enabled: z.boolean(), feePct: z.number().min(0).max(20) }),
      req.body,
    );
    const shop = shopId(req);
    saveShopCielo(shop, body);
    res.json(cardView(shop));
  });

  // ---------- Asaas da barbearia: PIX do clube com baixa automática e Pix Automático

  router.get('/asaas', (req, res) => {
    res.json(shopAsaasView(shopId(req), config.appUrl));
  });

  router.put('/asaas', (req, res) => {
    const body = parseBody(
      z.object({ env: z.enum(['sandbox', 'production']), apiKey: zText(300), pixAuto: z.boolean(), disconnect: z.boolean().default(false) }),
      req.body,
    );
    saveShopAsaas(shopId(req), body);
    res.json(shopAsaasView(shopId(req), config.appUrl));
  });

  router.post('/asaas/test', async (req, res) => {
    try {
      await testShopAsaas(shopId(req));
    } catch (err) {
      if (err instanceof AsaasError) throw new HttpError(502, err.message);
      throw err;
    }
    res.json({ ok: true });
  });

  /** Confere as credenciais na Cielo. */
  router.post('/online/test', async (req, res) => {
    const s = shopCielo(shopId(req));
    if (!s.clientId || !s.clientSecret) throw new HttpError(409, 'Salve o ClientId e o Client Secret primeiro.');
    try {
      await testCielo({ clientId: s.clientId, clientSecret: s.clientSecret });
    } catch (err) {
      if (err instanceof CieloError) throw new HttpError(502, err.message);
      throw err;
    }
    res.json({ ok: true });
  });

  // ---------- indique um amigo e aniversário

  const growthData = (shop: number) => ({
    settings: growthSettings(shop),
    referrals: referralsOverview(shop),
    birthdays: upcomingBirthdays(shop),
    idle: { settings: idleSettings(shop), stats: idleStats(shop), perDay: IDLE_PER_DAY },
  });

  router.get('/growth', (req, res) => {
    res.json(growthData(shopId(req)));
  });

  /** Horário vazio com desconto: dias e horários mais fracos, desconto (vazio = desligado). */
  router.put('/growth/idle', (req, res) => {
    const zClock = z.string().refine(isTime, 'Hora no formato HH:MM.');
    const body = parseBody(
      z
        .object({
          percent: z.number().int().min(5, 'Desconto de 5% a 50%.').max(50, 'Desconto de 5% a 50%.').nullable(),
          weekdays: z.array(z.number().int().min(0).max(6)).max(7),
          from: zClock,
          until: zClock,
        })
        .refine((s) => s.from < s.until, 'O fim da faixa deve ser depois do início.')
        .refine((s) => !s.percent || s.weekdays.length > 0, 'Escolha pelo menos um dia da semana.'),
      req.body,
    );
    const shop = shopId(req);
    saveIdleSettings(shop, body);
    res.json(growthData(shop));
  });

  router.put('/growth/settings', (req, res) => {
    const zReward = z
      .object({ title: z.string().trim().min(2, 'Descreva o presente.').max(80), valid_days: z.number().int().min(1).max(365) })
      .nullish()
      .transform((v) => v ?? null);
    const body = parseBody(
      z.object({ referral_enabled: z.boolean(), friend_reward: zReward, referrer_reward: zReward, birthday_enabled: z.boolean(), birthday_reward: zReward }),
      req.body,
    );
    const shop = shopId(req);
    saveGrowthSettings(shop, body);
    res.json(growthData(shop));
  });

  /** Na hora de fechar a comanda: o que o clube cobre para este cliente hoje. */
  router.get('/finance/club', (req, res) => {
    const customer = Number(req.query.customer_id);
    if (!Number.isInteger(customer) || customer <= 0) throw new HttpError(400, 'Informe o cliente.');
    const shop = shopId(req);
    res.json(clubCoverage(shop, customer, shopNow(shop).date));
  });
}
