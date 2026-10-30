/**
 * Kit de marca do assistente: tira as cores do logo enviado, sugere paletas de barbearia e desenha um
 * logo (monograma com as iniciais) para quem ainda não tem. Tudo no navegador.
 */

export interface Palette {
  id: string;
  label: string;
  primary: string;
  accent: string;
}

/** Paletas prontas, testadas com texto branco em cima da cor principal. */
export const PRESETS: Palette[] = [
  { id: 'classica', label: 'Clássica', primary: '#15110D', accent: '#F0A21B' },
  { id: 'vintage', label: 'Vintage', primary: '#5B1A1A', accent: '#E8D5B0' },
  { id: 'moderna', label: 'Moderna', primary: '#0F2A43', accent: '#F97316' },
  { id: 'verde', label: 'Verde e latão', primary: '#1F3A2E', accent: '#C9A227' },
];

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function luminance([r, g, b]: number[]): number {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function saturation([r, g, b]: number[]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function hue([r, g, b]: number[]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

/** Escurece até o texto branco ficar legível em cima (contraste de 4,5:1). */
function darkEnough(c: number[]): number[] {
  let out = c;
  for (let i = 0; i < 20 && 1.05 / (luminance(out) + 0.05) < 4.5; i++) out = out.map((v) => v * 0.88);
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não deu para abrir o logo.'));
    img.src = url;
  });
}

/** As cores do logo: a principal (a que mais aparece, escurecida se preciso) e a de destaque (a mais viva que contrasta). */
export async function paletteFromLogo(url: string): Promise<Palette> {
  const img = await loadImage(url);
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  // Agrupa as cores parecidas (4 bits por canal) e conta quantas vezes cada grupo aparece.
  const buckets = new Map<string, { n: number; sum: number[] }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const c = [data[i], data[i + 1], data[i + 2]];
    if (luminance(c) > 0.85) continue; // fundo branco
    const key = c.map((v) => v >> 4).join(',');
    const b = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] };
    b.n++;
    b.sum = b.sum.map((s, k) => s + c[k]);
    buckets.set(key, b);
  }
  const colors = [...buckets.values()].sort((a, b) => b.n - a.n).map((b) => b.sum.map((s) => s / b.n));
  if (!colors.length) return { ...PRESETS[0], id: 'logo', label: 'Do seu logo' };
  const primary = darkEnough(colors[0]);
  const vivid = colors.find((c) => saturation(c) > 0.35 && luminance(c) > 0.12 && (Math.abs(hue(c) - hue(primary)) > 25 || Math.abs(luminance(c) - luminance(primary)) > 0.3));
  const accent = vivid ?? rgb(PRESETS[0].accent);
  return { id: 'logo', label: 'Do seu logo', primary: hex(primary[0], primary[1], primary[2]), accent: hex(accent[0], accent[1], accent[2]) };
}

/** Iniciais do nome, sem "barbearia", "barber" e as preposições (ex.: "Barbearia do Zé Lima" → "ZL"). */
export function initials(name: string): string {
  const skip = new Set(['barbearia', 'barber', 'barbershop', 'shop', 'de', 'da', 'do', 'das', 'dos', 'e', 'the']);
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w && !skip.has(w.toLowerCase()));
  const pick = words.length ? words : name.split(/\s+/).filter(Boolean);
  return pick
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export type LogoStyle = 'circulo' | 'quadrado' | 'selo';
export const LOGO_STYLES: { id: LogoStyle; label: string }[] = [
  { id: 'circulo', label: 'Círculo' },
  { id: 'quadrado', label: 'Quadrado' },
  { id: 'selo', label: 'Selo' },
];

/** Desenha o logo (512×512) com as iniciais nas cores da marca. */
export function drawLogo(name: string, p: Pick<Palette, 'primary' | 'accent'>, style: LogoStyle): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const text = initials(name) || 'B';
  ctx.fillStyle = p.primary;
  if (style === 'quadrado') {
    ctx.beginPath();
    ctx.roundRect(16, 16, 480, 480, 110);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(256, 256, 240, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = p.accent;
  if (style === 'selo') {
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(256, 256, 212, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(256, 256, 186, 0, Math.PI * 2);
    ctx.stroke();
  } else if (style === 'circulo') {
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(256, 256, 222, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = p.accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = style === 'selo' ? 'Georgia, "Times New Roman", serif' : 'Inter, "Helvetica Neue", Arial, sans-serif';
  ctx.font = `${style === 'selo' ? 700 : 800} ${text.length > 1 ? 190 : 240}px ${font}`;
  ctx.fillText(text, 256, style === 'selo' ? 250 : 268);
  if (style === 'selo') {
    // Uma navalha pequena embaixo das iniciais.
    ctx.fillRect(196, 352, 120, 10);
    ctx.fillRect(316, 348, 26, 18);
  }
  return canvas;
}

/** O logo desenhado como arquivo PNG, pronto para enviar. */
export function logoFile(canvas: HTMLCanvasElement): Promise<File> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(new File([b], 'logo.png', { type: 'image/png' })) : reject(new Error('Não deu para gerar o logo.'))), 'image/png'),
  );
}
