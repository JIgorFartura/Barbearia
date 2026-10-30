import { config } from './config.js';

/**
 * Datas da agenda são "relógio de parede" da barbearia, gravadas como texto "AAAA-MM-DD HH:MM".
 * As contas abaixo tratam esse texto como hora ingênua (sem fuso); o Brasil não tem horário de verão.
 */

export const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export interface LocalNow {
  /** AAAA-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  /** 0 = domingo */
  weekday: number;
  /** AAAA-MM-DD HH:MM */
  stamp: string;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formats.set(timeZone, f);
  }
  return f;
}

/** Data e hora locais para um instante, no fuso informado (padrão: o do servidor). Para uma barbearia, use shopNow. */
export function localNow(at: Date = new Date(), timeZone: string = config.timezone): LocalNow {
  const p = Object.fromEntries(partsFormat(timeZone).formatToParts(at).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, weekday: weekdayOf(date), stamp: `${date} ${time}` };
}

/** O instante (ISO, UTC) de um horário de parede "AAAA-MM-DD HH:MM" no fuso (padrão: o do servidor). */
export function localToIso(stamp: string, timeZone: string = config.timezone): string {
  const asUtc = Date.parse(`${stamp.replace(' ', 'T')}:00Z`);
  const seen = localNow(new Date(asUtc), timeZone).stamp;
  const offset = Date.parse(`${seen.replace(' ', 'T')}:00Z`) - asUtc;
  return new Date(asUtc - offset).toISOString();
}

const naive = (date: string, time = '00:00') => new Date(`${date}T${time}:00Z`);
const pad = (n: number) => String(n).padStart(2, '0');

function fromNaive(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const weekdayOf = (date: string) => naive(date).getUTCDay();

export function addDays(date: string, days: number): string {
  return fromNaive(new Date(naive(date).getTime() + days * 86400000)).slice(0, 10);
}

export function addMinutes(stamp: string, minutes: number): string {
  const [date, time] = stamp.split(' ');
  return fromNaive(new Date(naive(date, time).getTime() + minutes * 60000));
}

/** Diferença em dias entre duas datas AAAA-MM-DD (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((naive(b).getTime() - naive(a).getTime()) / 86400000);
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export const fromMinutes = (total: number) => `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;

export const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(naive(v).getTime()) && fromNaive(naive(v)).startsWith(v);
export const isTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** "sexta, 31/10" */
export function dayLabel(date: string): string {
  return `${WEEKDAYS[weekdayOf(date)]}, ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** "17h" ou "17h30" */
export const hourLabel = (time: string) => (time.endsWith(':00') ? `${Number(time.slice(0, 2))}h` : `${Number(time.slice(0, 2))}h${time.slice(3)}`);

/** "hoje", "amanhã" ou "sexta, 31/10" — relativo à data de hoje. */
export function relativeDay(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'hoje';
  if (diff === 1) return 'amanhã';
  return dayLabel(date);
}

/** Converte um instante ISO (UTC) para "AAAA-MM-DD HH:MM" local. */
export const isoToLocal = (iso: string, timeZone?: string) => localNow(new Date(iso), timeZone).stamp;

/** Fusos do Brasil que a barbearia pode escolher. */
export const TIMEZONES = ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'America/Noronha'] as const;
