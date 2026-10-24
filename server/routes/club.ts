import type { Router } from 'express';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { chargesToConfirm, confirmCharge, pixSettings, rejectClaim, savePixSettings, undoConfirm } from '../charges.js';
import { cancelMembership, clubCoverage, clubOverview, deletePlan, memberView, savePlan, sendClubCharge, subscribe } from '../club.js';
import { shopNow } from '../clock.js';
import { depositsOverview, refundDeposit, saveDepositSettings } from '../deposits.js';
import { run } from '../db.js';
import { METHODS } from '../finance.js';
import { HttpError, idParam, parseBody, zId, zText } from '../http.js';
import { shopBot } from '../messaging.js';
import { PIX_KEY_TYPES, normalizePixKey, pixKeyType } from '../pix.js';

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

/** Clube de assinatura, sinal, chave PIX da barbearia e confirmação dos PIX avisados pelos clientes (painel do dono). */
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

  router.post('/club/members/:id/cancel', (req, res) => {
    res.json(cancelMembership(shopId(req), idParam(req)));
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

  // ---------- PIX avisados pelos clientes (clube e sinal)

  router.get('/charges/to-confirm', (req, res) => {
    res.json(chargesToConfirm(shopId(req)));
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

  // ---------- sinal para segurar o horário

  router.get('/deposits', (req, res) => {
    res.json(depositsOverview(shopId(req)));
  });

  router.put('/deposits/settings', (req, res) => {
    const body = parseBody(
      z.object({
        deposit_mode: z.enum(['off', 'all', 'no_show']),
        deposit_cents: z.number().int().min(100, 'O sinal mínimo é R$ 1,00.').max(100_000),
        deposit_hold_min: z.number().int().min(15).max(24 * 60),
        deposit_credit_hours: z.number().int().min(0).max(7 * 24),
      }),
      req.body,
    );
    if (body.deposit_mode !== 'off' && !pixSettings(shopId(req)).pix_key) throw new HttpError(409, 'Cadastre a chave PIX da barbearia antes de ligar o sinal.');
    saveDepositSettings(shopId(req), body);
    res.json(depositsOverview(shopId(req)));
  });

  router.post('/charges/:id/refund', (req, res) => {
    const body = parseBody(z.object({ method: z.enum(METHODS).default('pix') }), req.body ?? {});
    res.json(refundDeposit(shopId(req), idParam(req), { userId: req.user!.id, method: body.method }));
  });

  /** Na hora de fechar a comanda: o que o clube cobre para este cliente hoje. */
  router.get('/finance/club', (req, res) => {
    const customer = Number(req.query.customer_id);
    if (!Number.isInteger(customer) || customer <= 0) throw new HttpError(400, 'Informe o cliente.');
    const shop = shopId(req);
    res.json(clubCoverage(shop, customer, shopNow(shop).date));
  });
}
