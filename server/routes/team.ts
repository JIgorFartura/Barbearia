import type { Router } from 'express';
import { z } from 'zod';
import { hashPassword, shopId } from '../auth.js';
import { shopNow } from '../clock.js';
import { all, get, nowIso, run, tx } from '../db.js';
import { HttpError, idParam, normalizePhone, parseBody } from '../http.js';
import { monthForecast, occupancy, periodNumbers, retention } from '../insights.js';
import { createShop, linkOwner, ownerUnits, suggestSlug, zSlug } from '../shops.js';
import { zPassword } from './auth.js';

/** Recepção (logins da equipe sem o financeiro) e rede com filiais (painel do dono). */
export function registerTeamRoutes(router: Router): void {
  // ---------- recepção

  const reception = (shop: number) =>
    all("SELECT id, name, email, phone, created_at FROM users WHERE barbershop_id = ? AND role = 'reception' ORDER BY name COLLATE NOCASE", [shop]);

  router.get('/reception', (req, res) => {
    res.json(reception(shopId(req)));
  });

  router.post('/reception', (req, res) => {
    const shop = shopId(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2, 'Informe o nome.').max(80),
        phone: z.string().max(30),
        email: z.string().trim().toLowerCase().email('E-mail inválido.').nullish().or(z.literal('')),
        password: zPassword,
      }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    const email = body.email || null;
    if (get('SELECT 1 AS ok FROM users WHERE phone = ?', [phone])) throw new HttpError(409, 'Esse celular já está em outro login.');
    if (email && get('SELECT 1 AS ok FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Esse e-mail já está em outro login.');
    run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'reception', ?, ?, ?, ?, ?, ?)", [
      shop,
      body.name,
      email,
      phone,
      hashPassword(body.password),
      nowIso(),
      nowIso(),
    ]);
    res.status(201).json(reception(shop));
  });

  router.put('/reception/:id/password', (req, res) => {
    const shop = shopId(req);
    const { password } = parseBody(z.object({ password: zPassword }), req.body);
    const { changes } = run("UPDATE users SET password_hash = ? WHERE id = ? AND barbershop_id = ? AND role = 'reception'", [hashPassword(password), idParam(req), shop]);
    if (!changes) throw new HttpError(404, 'Login da recepção não encontrado.');
    run('DELETE FROM sessions WHERE user_id = ?', [idParam(req)]);
    res.json(reception(shop));
  });

  router.delete('/reception/:id', (req, res) => {
    const shop = shopId(req);
    const { changes } = run("DELETE FROM users WHERE id = ? AND barbershop_id = ? AND role = 'reception'", [idParam(req), shop]);
    if (!changes) throw new HttpError(404, 'Login da recepção não encontrado.');
    res.json(reception(shop));
  });

  // ---------- rede com filiais

  /** Mais uma unidade da rede: começa nos dias grátis, com as cores e o fuso da unidade atual. */
  router.post('/units', (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(2, 'Informe o nome da unidade.').max(80), slug: zSlug.nullish() }), req.body);
    const current = shopId(req);
    const id = tx(() => {
      const shop = createShop({ name: body.name, slug: body.slug || suggestSlug(body.name), copyFrom: current });
      linkOwner(req.user!.id, shop);
      return shop;
    });
    res.status(201).json({ id, units: ownerUnits(req.user!.id) });
  });

  /** Visão da rede: os números de cada unidade lado a lado. */
  router.get('/network', (req, res) => {
    const units = ownerUnits(req.user!.id).filter((u) => u.active);
    res.json({
      current: shopId(req),
      units: units.map((u) => {
        const today = shopNow(u.id).date;
        const monthStart = `${today.slice(0, 8)}01`;
        const f = monthForecast(u.id);
        return {
          ...u,
          today: periodNumbers(u.id, today, today),
          month: periodNumbers(u.id, monthStart, today),
          projected: f.projected,
          lastMonthTotal: f.lastMonthTotal,
          occupancy: occupancy(u.id, monthStart, today).rate,
          activeCustomers: retention(u.id).active,
          appointmentsToday: get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM appointments WHERE barbershop_id = ? AND status = 'scheduled' AND starts_at >= ? AND starts_at < ?",
            [u.id, `${today} 00:00`, `${today} 23:59`],
          )!.n,
        };
      }),
    });
  });
}
