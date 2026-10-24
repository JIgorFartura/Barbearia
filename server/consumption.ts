import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { sendMessage, shopBot } from './messaging.js';
import { shopNow } from './clock.js';
import { hourLabel, relativeDay } from './time.js';

/**
 * O que o cliente costuma consumir quando vem (ex.: sempre corta o cabelo e toma 1 cerveja).
 * Ao confirmar o horário, o robô pergunta se pode avisar o barbeiro para deixar separado.
 */

export interface Usual {
  productId: number;
  name: string;
  qty: number;
}

/** Produtos que aparecem em pelo menos metade das últimas visitas pagas (mínimo 2 vezes). */
export function usualConsumption(customerId: number): Usual[] {
  const sales = all<{ id: number }>("SELECT id FROM sales WHERE customer_id = ? AND status = 'closed' ORDER BY date DESC, id DESC LIMIT 8", [customerId]);
  if (sales.length < 2) return [];
  const byProduct = new Map<number, { name: string; qtys: number[] }>();
  for (const s of sales) {
    for (const i of all<{ catalog_item_id: number; name: string; qty: number }>(
      "SELECT catalog_item_id, name, SUM(qty) AS qty FROM sale_items WHERE sale_id = ? AND kind = 'product' AND catalog_item_id IS NOT NULL GROUP BY catalog_item_id",
      [s.id],
    )) {
      const entry = byProduct.get(i.catalog_item_id) ?? { name: i.name, qtys: [] };
      entry.qtys.push(i.qty);
      byProduct.set(i.catalog_item_id, entry);
    }
  }
  return [...byProduct.entries()]
    .filter(([id, p]) => p.qtys.length >= 2 && p.qtys.length / sales.length >= 0.5 && Boolean(get('SELECT 1 AS ok FROM catalog_items WHERE id = ? AND active = 1', [id])))
    .sort((a, b) => b[1].qtys.length - a[1].qtys.length)
    .slice(0, 2)
    .map(([productId, p]) => {
      const sorted = [...p.qtys].sort((x, y) => x - y);
      return { productId, name: p.name, qty: Math.max(1, sorted[Math.floor(sorted.length / 2)]) };
    });
}

export const describeItems = (items: { name: string; qty: number }[]) => items.map((i) => `${i.qty} ${i.name.toLowerCase()}`).join(' e ');

export interface ReservedItem {
  catalog_item_id: number;
  name: string;
  qty: number;
}

export function reservedItems(appointmentId: number): ReservedItem[] {
  return all<ReservedItem>(
    'SELECT a.catalog_item_id, c.name, SUM(a.qty) AS qty FROM appointment_items a JOIN catalog_items c ON c.id = a.catalog_item_id WHERE a.appointment_id = ? GROUP BY a.catalog_item_id',
    [appointmentId],
  );
}

interface ApptInfo {
  id: number;
  barbershop_id: number;
  customer_id: number;
  customer_name: string;
  barber_name: string;
  barber_phone: string | null;
  starts_at: string;
  status: string;
}

function apptInfo(shopId: number, appointmentId: number): ApptInfo {
  const a = get<ApptInfo>(
    `SELECT a.id, a.barbershop_id, a.customer_id, c.name AS customer_name, b.name AS barber_name, b.phone AS barber_phone, a.starts_at, a.status
       FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN barbers b ON b.id = a.barber_id
      WHERE a.id = ? AND a.barbershop_id = ?`,
    [appointmentId, shopId],
  );
  if (!a) throw new HttpError(404, 'Horário não encontrado.');
  return a;
}

/** Sugestão para um horário marcado: o consumo de costume, se ainda não foi reservado. */
export function suggestionFor(shopId: number, appointmentId: number, now?: Date): { items: Usual[]; barber: string; question: string } | null {
  const a = apptInfo(shopId, appointmentId);
  if (a.status !== 'scheduled' || reservedItems(a.id).length) return null;
  const items = usualConsumption(a.customer_id);
  if (!items.length) return null;
  const when = relativeDay(a.starts_at.slice(0, 10), shopNow(shopId, now).date);
  const day = when === 'hoje' || when === 'amanhã' ? ` ${when}` : '';
  return {
    items,
    barber: a.barber_name,
    question: `Posso avisar o ${a.barber_name} que você vai querer ${describeItems(items)}${day}, pra ele deixar separado? 🍺 Responda SIM ou NÃO.`,
  };
}

/** Guarda a pergunta para o próximo SIM/NÃO do cliente no WhatsApp. Devolve o texto da pergunta. */
export function askConsumption(shopId: number, appointmentId: number, now?: Date): string | null {
  const s = suggestionFor(shopId, appointmentId, now);
  if (!s) return null;
  const a = apptInfo(shopId, appointmentId);
  run("UPDATE bot_questions SET status = 'expired' WHERE customer_id = ? AND status = 'pending'", [a.customer_id]);
  run("INSERT INTO bot_questions (barbershop_id, customer_id, appointment_id, kind, payload, created_at) VALUES (?, ?, ?, 'consumo', ?, ?)", [
    shopId,
    a.customer_id,
    appointmentId,
    JSON.stringify(s.items),
    nowIso(),
  ]);
  return s.question;
}

/** Separa os itens no horário e avisa o barbeiro pelo WhatsApp (se ele tiver celular cadastrado). */
export async function reserveItems(
  shopId: number,
  appointmentId: number,
  items: { productId: number; qty: number }[],
  source: 'whatsapp' | 'cliente' | 'painel',
  opts: { customerId?: number; dryRun?: boolean; now?: Date } = {},
): Promise<{ items: ReservedItem[]; barberNotified: boolean; barber: string }> {
  const a = apptInfo(shopId, appointmentId);
  if (opts.customerId && a.customer_id !== opts.customerId) throw new HttpError(404, 'Horário não encontrado.');
  if (a.status !== 'scheduled' || a.starts_at < shopNow(shopId, opts.now).stamp) throw new HttpError(409, 'Esse horário não está mais marcado.');
  if (!items.length) throw new HttpError(400, 'Escolha pelo menos um item.');
  tx(() => {
    for (const i of items) {
      if (!get("SELECT 1 AS ok FROM catalog_items WHERE id = ? AND barbershop_id = ? AND kind = 'product' AND active = 1", [i.productId, shopId])) {
        throw new HttpError(404, 'Produto não encontrado.');
      }
      run('INSERT INTO appointment_items (appointment_id, catalog_item_id, qty, source, created_at) VALUES (?, ?, ?, ?, ?)', [appointmentId, i.productId, i.qty, source, nowIso()]);
    }
    run("UPDATE bot_questions SET status = 'yes' WHERE appointment_id = ? AND status = 'pending'", [appointmentId]);
  });
  const reserved = reservedItems(appointmentId);
  let barberNotified = false;
  if (a.barber_phone) {
    const date = a.starts_at.slice(0, 10);
    const result = await sendMessage({
      shop: shopBot(shopId),
      customerId: null,
      phone: a.barber_phone,
      text: `Oi, ${a.barber_name}! ${a.customer_name} vem ${relativeDay(date, shopNow(shopId, opts.now).date)} às ${hourLabel(a.starts_at.slice(11))} e pediu pra deixar separado: ${describeItems(reserved)}. 🍺`,
      kind: 'barbeiro',
      dryRun: opts.dryRun,
    });
    barberNotified = result.status !== 'failed';
  }
  return { items: reserved, barberNotified, barber: a.barber_name };
}
