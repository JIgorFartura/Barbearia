import { shopNow } from './clock.js';
import { get, run } from './db.js';
import { weekdayOf } from './time.js';

/**
 * Horário vazio com desconto: nos dias e horários mais fracos que o dono escolhe, a vaga livre de hoje
 * sai com X% de desconto no serviço para quem marcar no mesmo dia (pela área do cliente, pelo robô ou
 * respondendo SIM à oferta da manhã). Marcando com antecedência, preço normal: assim ninguém aprende
 * a esperar o desconto, e o horário que ia ficar parado vira dinheiro.
 */

export interface IdleSettings {
  /** null = desligado. */
  percent: number | null;
  /** Dias da semana (0 = domingo). */
  weekdays: number[];
  from: string;
  until: string;
}

export function idleSettings(shopId: number): IdleSettings {
  const s = get<{ idle_percent: number | null; idle_weekdays: string; idle_from: string; idle_until: string }>(
    'SELECT idle_percent, idle_weekdays, idle_from, idle_until FROM barbershops WHERE id = ?',
    [shopId],
  );
  return {
    percent: s?.idle_percent || null,
    weekdays: (s?.idle_weekdays ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number),
    from: s?.idle_from ?? '09:00',
    until: s?.idle_until ?? '17:00',
  };
}

export function saveIdleSettings(shopId: number, s: IdleSettings): void {
  run('UPDATE barbershops SET idle_percent = ?, idle_weekdays = ?, idle_from = ?, idle_until = ? WHERE id = ?', [
    s.percent || null,
    [...new Set(s.weekdays)].sort().join(','),
    s.from,
    s.until,
    shopId,
  ]);
}

/** A regra vale para este dia? Devolve o desconto e a faixa de horário (só hoje, nos dias escolhidos). */
export function idleWindow(shopId: number, date: string, now?: Date): { percent: number; from: string; until: string } | null {
  const s = idleSettings(shopId);
  if (!s.percent || date !== shopNow(shopId, now).date || !s.weekdays.includes(weekdayOf(date))) return null;
  return { percent: s.percent, from: s.from, until: s.until };
}

/** Desconto de um horário de hoje dentro da faixa (null = preço normal). */
export function idleDiscount(shopId: number, date: string, time: string, now?: Date): number | null {
  const w = idleWindow(shopId, date, now);
  return w && time >= w.from && time < w.until ? w.percent : null;
}

/** Preço com o desconto (arredondado para o centavo). */
export const discounted = (cents: number, percent: number) => Math.round((cents * (100 - percent)) / 100);
