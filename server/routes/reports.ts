import type { Router } from 'express';
import { z } from 'zod';
import { shopId } from '../auth.js';
import { shopNow } from '../clock.js';
import { get, run } from '../db.js';
import { parseBody } from '../http.js';
import { monthForecast, occupancy, periodNumbers, retention } from '../insights.js';
import { platformChannel, platformDisplayPhone } from '../platform.js';
import { addDays, daysBetween } from '../time.js';

export const PERIODS = ['mes', 'mes_passado', '30', '90'] as const;
type Period = (typeof PERIODS)[number];

/** Datas do período escolhido na tela (sempre no relógio da barbearia). */
function range(shop: number, period: Period): { from: string; to: string } {
  const today = shopNow(shop).date;
  const monthStart = `${today.slice(0, 8)}01`;
  if (period === 'mes') return { from: monthStart, to: today };
  if (period === 'mes_passado') return { from: `${addDays(monthStart, -1).slice(0, 8)}01`, to: addDays(monthStart, -1) };
  return { from: addDays(today, -(Number(period) - 1)), to: today };
}

/** Relatórios do dono: números do período, ocupação da agenda, clientes, previsão do mês e o gerente virtual. */
export function registerReportRoutes(router: Router): void {
  router.get('/reports', (req, res) => {
    const shop = shopId(req);
    const period = (PERIODS as readonly string[]).includes(String(req.query.period)) ? (req.query.period as Period) : 'mes';
    const { from, to } = range(shop, period);
    const days = daysBetween(from, to) + 1;
    res.json({
      period,
      from,
      to,
      numbers: periodNumbers(shop, from, to),
      // Mesmo tamanho de período, logo antes (comparação).
      previous: periodNumbers(shop, addDays(from, -days), addDays(from, -1)),
      occupancy: occupancy(shop, from, to),
      retention: retention(shop),
      forecast: monthForecast(shop),
      manager: {
        weekly_summary: Boolean(get<{ weekly_summary: number }>('SELECT weekly_summary FROM barbershops WHERE id = ?', [shop])?.weekly_summary),
        phone: platformDisplayPhone(),
        connected: platformChannel().provider !== 'simulador',
      },
    });
  });

  /** Resumo da semana no WhatsApp (toda segunda de manhã). */
  router.put('/manager', (req, res) => {
    const { weekly_summary } = parseBody(z.object({ weekly_summary: z.boolean() }), req.body);
    run('UPDATE barbershops SET weekly_summary = ? WHERE id = ?', [weekly_summary ? 1 : 0, shopId(req)]);
    res.json({ weekly_summary });
  });
}
