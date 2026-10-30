import { all, get, nowIso, run } from './db.js';

/**
 * Desconto de volta: quem recebe o recontato de cliente sumido ganha X% no próximo horário, marcando
 * até uma data. Ele entra sozinho no horário marcado por qualquer canal (robô, área do cliente ou
 * balcão) e fica preso a esse horário; se o horário for cancelado ou virar falta, volta a valer.
 */
export interface Comeback {
  id: number;
  percent: number;
  /** Último dia para marcar (AAAA-MM-DD, no relógio da barbearia). */
  valid_until: string;
}

// Valendo: não venceu e não está num horário marcado (o atendido conta como usado).
const AVAILABLE = `FROM comeback_promos p LEFT JOIN appointments a ON a.id = p.appointment_id
  WHERE p.valid_until >= :today AND (p.appointment_id IS NULL OR a.status <> 'scheduled')`;

/** O desconto de volta que o cliente ainda pode usar (o maior, se houver mais de um). */
export function availableComeback(customerId: number, today: string): Comeback | null {
  return (
    get<Comeback>(`SELECT p.id, p.percent, p.valid_until ${AVAILABLE} AND p.customer_id = :customer ORDER BY p.percent DESC, p.valid_until DESC LIMIT 1`, {
      today,
      customer: customerId,
    }) ?? null
  );
}

/** Os descontos de volta valendo na barbearia, por cliente. */
export function availableComebacks(shopId: number, today: string): Map<number, Comeback> {
  const map = new Map<number, Comeback>();
  for (const r of all<Comeback & { customer_id: number }>(
    `SELECT p.id, p.customer_id, p.percent, p.valid_until ${AVAILABLE} AND p.barbershop_id = :shop ORDER BY p.percent, p.valid_until`,
    { today, shop: shopId },
  )) {
    map.set(r.customer_id, { id: r.id, percent: r.percent, valid_until: r.valid_until });
  }
  return map;
}

/** Dá o desconto, ou renova o que o cliente ainda tem (fica o maior e o prazo mais longo). */
export function grantComeback(shopId: number, customerId: number, percent: number, validUntil: string, today: string): Comeback {
  const open = availableComeback(customerId, today);
  if (open) {
    const next = { id: open.id, percent: Math.max(open.percent, percent), valid_until: open.valid_until > validUntil ? open.valid_until : validUntil };
    run('UPDATE comeback_promos SET percent = ?, valid_until = ? WHERE id = ?', [next.percent, next.valid_until, open.id]);
    return next;
  }
  const { lastInsertRowid } = run('INSERT INTO comeback_promos (barbershop_id, customer_id, percent, valid_until, created_at) VALUES (?, ?, ?, ?, ?)', [
    shopId,
    customerId,
    percent,
    validUntil,
    nowIso(),
  ]);
  return { id: lastInsertRowid, percent, valid_until: validUntil };
}

/** Prende o desconto ao horário marcado com ele. */
export const useComeback = (promoId: number, appointmentId: number) => run('UPDATE comeback_promos SET appointment_id = ? WHERE id = ?', [appointmentId, promoId]);
