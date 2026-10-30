import { config } from './config.js';
import { get } from './db.js';
import { localNow, type LocalNow } from './time.js';

/**
 * Relógio de cada barbearia. A agenda guarda "relógio de parede" (AAAA-MM-DD HH:MM) no fuso da
 * barbearia; o "agora" precisa estar no mesmo fuso, senão uma barbearia em Manaus veria lembretes e
 * horários do dia uma hora adiantados.
 */

/** Fuso da barbearia (sem escolha: o do servidor, horário de Brasília). */
export function shopTz(shopId: number): string {
  return get<{ timezone: string | null }>('SELECT timezone FROM barbershops WHERE id = ?', [shopId])?.timezone || config.timezone;
}

/** Agora no relógio da barbearia. */
export const shopNow = (shopId: number, at?: Date): LocalNow => localNow(at, shopTz(shopId));

/** Hoje (AAAA-MM-DD) na barbearia. */
export const shopToday = (shopId: number, at?: Date): string => shopNow(shopId, at).date;

/** Fuso da barbearia de um cliente. */
export function customerTz(customerId: number): string {
  return (
    get<{ timezone: string | null }>('SELECT b.timezone FROM customers c JOIN barbershops b ON b.id = c.barbershop_id WHERE c.id = ?', [customerId])?.timezone ||
    config.timezone
  );
}

/** Agora no relógio da barbearia do cliente. */
export const customerNow = (customerId: number, at?: Date): LocalNow => localNow(at, customerTz(customerId));
