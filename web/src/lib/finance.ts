export type Method = 'dinheiro' | 'pix' | 'debito' | 'credito' | 'outro';

export const METHODS: { id: Method; label: string }[] = [
  { id: 'pix', label: 'PIX' },
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'debito', label: 'Débito' },
  { id: 'credito', label: 'Crédito' },
  { id: 'outro', label: 'Outro' },
];

export const methodLabel = (m: string | null | undefined) => METHODS.find((x) => x.id === m)?.label ?? (m ? m : '—');

// Mesmas categorias do servidor (server/finance.ts).
export const IN_CATEGORIES = ['Atendimentos', 'Anúncios e parcerias', 'Outras entradas'];
export const OUT_CATEGORIES = [
  'Comissões',
  'Salários',
  'Aluguel',
  'Contas (água, luz, internet)',
  'Produtos e estoque',
  'Marketing',
  'Manutenção',
  'Impostos e taxas',
  'Mensalidade do sistema',
  'Outras saídas',
];

/** "12,50" ou "12.50" → 1250 centavos. */
export function parseMoney(value: string): number {
  const clean = value.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export const centsToInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/** Valor curto para eixos: 1.200 → "1,2 mil". */
export function compactMoney(cents: number): string {
  const v = cents / 100;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}
