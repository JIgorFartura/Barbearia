/**
 * PIX "copia e cola" estático (BR Code / EMV) com valor e identificador — gerado aqui mesmo,
 * sem banco nem intermediário. A confirmação do pagamento é feita pelo master no painel.
 */

/** CRC-16/CCITT-FALSE (polinômio 0x1021, início 0xFFFF), exigido pelo BR Code. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Sem acentos e só caracteres aceitos pelos aplicativos de banco. */
const ascii = (value: string, max: number) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,-]/g, '')
    .trim()
    .slice(0, max);

export interface PixInput {
  /** Chave PIX de quem recebe (CPF/CNPJ, e-mail, celular ou aleatória). */
  key: string;
  name: string;
  city: string;
  amountCents: number;
  /** Identificador da cobrança (até 25 letras/números). */
  txid?: string;
}

export function pixPayload(input: PixInput): string {
  const account = field('00', 'br.gov.bcb.pix') + field('01', input.key.trim());
  const txid = (input.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const body =
    field('00', '01') +
    field('26', account) +
    field('52', '0000') +
    field('53', '986') +
    (input.amountCents > 0 ? field('54', (input.amountCents / 100).toFixed(2)) : '') +
    field('58', 'BR') +
    field('59', ascii(input.name, 25) || 'RECEBEDOR') +
    field('60', ascii(input.city, 15) || 'BRASIL') +
    field('62', field('05', txid)) +
    '6304';
  return body + crc16(body);
}

export const PIX_KEY_TYPES = ['cpf', 'celular', 'email', 'aleatoria'] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

/**
 * Chave no formato que os bancos aceitam dentro do PIX copia e cola: CPF/CNPJ só números,
 * celular como +55DDDNÚMERO, e-mail em minúsculas e chave aleatória como veio. null = inválida.
 */
export function normalizePixKey(type: PixKeyType, value: string): string | null {
  const v = value.trim();
  const digits = v.replace(/\D/g, '');
  switch (type) {
    case 'cpf':
      return digits.length === 11 || digits.length === 14 ? digits : null;
    case 'celular': {
      const local = digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
      return local.length === 10 || local.length === 11 ? `+55${local}` : null;
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 77 ? v.toLowerCase() : null;
    case 'aleatoria':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null;
  }
}

/** Tipo de uma chave já salva (para a tela). */
export function pixKeyType(key: string): PixKeyType {
  if (key.startsWith('+55')) return 'celular';
  if (key.includes('@')) return 'email';
  if (/^[0-9a-f]{8}-/i.test(key)) return 'aleatoria';
  return 'cpf';
}
