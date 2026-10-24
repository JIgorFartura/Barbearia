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

export const whatsappLink = (number: string, text = '') =>
  `https://wa.me/55${number.replace(/\D/g, '').replace(/^55/, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export const instagramLink = (handle: string) => `https://instagram.com/${handle.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '')}`;
