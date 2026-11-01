import crypto from 'node:crypto';
import { shopNow, shopTz } from './clock.js';
import { config } from './config.js';
import { all, get, nowIso, run } from './db.js';
import { HttpError } from './http.js';
import { addDays, localToIso } from './time.js';

/**
 * Agenda do barbeiro no Google Agenda (ou no calendário do iPhone): um link secreto de calendário
 * (formato .ics) que o Google lê de tempos em tempos. Só os horários dele, com o primeiro nome do
 * cliente e o serviço (sem celular). Trocar o link desliga o antigo.
 */

/** Link do calendário do barbeiro (cria o segredo na primeira vez). */
export function calendarLink(shopId: number, barberId: number, opts: { renew?: boolean } = {}): string {
  const b = get<{ calendar_token: string | null }>('SELECT calendar_token FROM barbers WHERE id = ? AND barbershop_id = ?', [barberId, shopId]);
  if (!b) throw new HttpError(404, 'Barbeiro não encontrado.');
  let token = b.calendar_token;
  if (!token || opts.renew) {
    token = crypto.randomBytes(24).toString('base64url');
    run('UPDATE barbers SET calendar_token = ? WHERE id = ?', [token, barberId]);
  }
  return `${config.appUrl}/api/public/calendar/${token}.ics`;
}

const icsDate = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Texto de calendário: escapa vírgula, ponto e vírgula e quebra de linha. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');

/** Os próximos 60 dias (e os últimos 7) do barbeiro, em .ics. */
export function barberIcs(token: string, now: Date = new Date()): string {
  const b = get<{ id: number; name: string; barbershop_id: number; shop: string; address: string | null }>(
    `SELECT b.id, b.name, b.barbershop_id, s.name AS shop, s.address FROM barbers b JOIN barbershops s ON s.id = b.barbershop_id
      WHERE b.calendar_token = ? AND s.active = 1`,
    [token],
  );
  if (!b) throw new HttpError(404, 'Calendário não encontrado.');
  const tz = shopTz(b.barbershop_id);
  const today = shopNow(b.barbershop_id, now).date;
  const appts = all<{ id: number; starts_at: string; ends_at: string; service_name: string; customer: string; status: string }>(
    `SELECT a.id, a.starts_at, a.ends_at, a.service_name, c.name AS customer, a.status FROM appointments a JOIN customers c ON c.id = a.customer_id
      WHERE a.barber_id = ? AND a.starts_at >= ? AND a.starts_at < ? AND a.status IN ('scheduled', 'cancelled')`,
    [b.id, `${addDays(today, -7)} 00:00`, `${addDays(today, 60)} 00:00`],
  );
  const stamp = icsDate(nowIso());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bladr//Agenda do barbeiro//PT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${b.shop} · ${b.name}`)}`,
    `X-WR-TIMEZONE:${tz}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
  ];
  for (const a of appts) {
    const first = a.customer.split(/\s+/)[0];
    lines.push(
      'BEGIN:VEVENT',
      `UID:horario-${a.id}@bladr`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(localToIso(a.starts_at, tz))}`,
      `DTEND:${icsDate(localToIso(a.ends_at, tz))}`,
      `SUMMARY:${esc(`${a.service_name} · ${first}`)}`,
      ...(b.address ? [`LOCATION:${esc(b.address)}`] : []),
      `STATUS:${a.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  // Linhas do .ics terminam em CRLF.
  return `${lines.join('\r\n')}\r\n`;
}
