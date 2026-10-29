export const money = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function phone(value: string | null | undefined): string {
  const d = (value ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return value ?? '';
}

export function date(value: string | null | undefined): string {
  if (!value) return '';
  const d = value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString('pt-BR');
}

// Datas da agenda chegam como "AAAA-MM-DD" e "AAAA-MM-DD HH:MM" (horário da barbearia).
export const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const naive = (d: string) => new Date(`${d}T12:00:00Z`);
export const weekdayOf = (d: string) => naive(d).getUTCDay();
export const addDays = (d: string, n: number) => new Date(naive(d).getTime() + n * 86400000).toISOString().slice(0, 10);
export const todayStr = () => new Date().toLocaleDateString('en-CA');
/** "sexta, 06/11" */
export const dayLabel = (d: string) => `${WEEKDAYS[weekdayOf(d)]}, ${d.slice(8, 10)}/${d.slice(5, 7)}`;
/** "17h" ou "17h30" */
export const hourLabel = (t: string) => (t.endsWith(':00') ? `${Number(t.slice(0, 2))}h` : `${Number(t.slice(0, 2))}h${t.slice(3, 5)}`);
/** Só a primeira letra maiúscula ("Sexta, 06/11 às 17h"). */
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "sexta, 06/11 às 17h" a partir de "2026-11-06 17:00" */
export const stampLabel = (s: string) => `${dayLabel(s.slice(0, 10))} às ${hourLabel(s.slice(11, 16))}`;

export const whatsappLink = (number: string, text = '') =>
  `https://wa.me/55${number.replace(/\D/g, '').replace(/^55/, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export const instagramLink = (handle: string) => `https://instagram.com/${handle.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '')}`;

/** De onde veio o desconto do horário. */
export const promoLabel = (kind: 'vazio' | 'volta' | null | undefined) => (kind === 'volta' ? 'desconto de volta' : 'horário vazio');
