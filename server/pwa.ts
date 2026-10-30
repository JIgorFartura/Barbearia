import fs from 'node:fs';
import zlib from 'node:zlib';
import { Router } from 'express';
import { get } from './db.js';

/**
 * App instalável (PWA): cada barbearia tem o app dela, com o nome, as cores e o ícone dela, que o
 * cliente instala pela área (/b/slug/conta). O painel do dono e o app do barbeiro instalam como o app
 * da plataforma. Os ícones são desenhados aqui (a tesoura do ícone do sistema nas cores da barbearia).
 */

export const pwaRouter = Router();

const PLATFORM = { bg: '#111827', fg: '#d4a017', background: '#fafafa' };

interface ShopBrand {
  slug: string;
  name: string;
  primary_color: string;
  accent_color: string;
}

const shopBrand = (slug: string) =>
  get<ShopBrand>('SELECT slug, name, primary_color, accent_color FROM barbershops WHERE slug = ? AND active = 1', [slug.toLowerCase()]);

const platformName = () => get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'legal_company'")?.value || 'Bladr';

// ---------- ícone (PNG desenhado na hora e guardado em memória)

function png(width: number, height: number, rgba: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Distância do ponto ao segmento (a, b). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * A tesoura do icon.svg (grade de 64): fundo na cor principal, traço na cor de destaque. `full`: fundo
 * até a borda e desenho menor (ícone "maskable" e o do iPhone, que arredondam sozinhos). Só os pixels da
 * borda das formas são subamostrados (o resto é cheio ou vazio), para desenhar rápido.
 */
export function iconPng(size: number, bg: string, fg: string, full: boolean): Buffer {
  const [br, bgG, bb] = rgb(bg);
  const [fr, fgG, fb] = rgb(fg);
  const scale = 64 / size;
  // No ícone "maskable" o desenho fica dentro da área segura (80% do centro).
  const shrink = full ? 0.78 : 1;
  const SS = 4;
  const half = scale * Math.SQRT1_2;
  /** Distância (negativa dentro) ao quadrado de cantos arredondados de raio 14. */
  const box = (u: number, v: number) => {
    const qx = Math.abs(u - 32) - 18;
    const qy = Math.abs(v - 32) - 18;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 14;
  };
  /** Distância ao traço da tesoura (no espaço do desenho), menos a meia largura do traço. */
  const scissors = (u: number, v: number) => {
    const pu = 32 + (u - 32) / shrink;
    const pv = 32 + (v - 32) / shrink;
    return (
      Math.min(
        Math.abs(Math.hypot(pu - 20, pv - 44) - 7),
        Math.abs(Math.hypot(pu - 44, pv - 44) - 7),
        segDist(pu, pv, 25, 39, 46, 12),
        segDist(pu, pv, 39, 39, 18, 12),
      ) - 2
    );
  };
  /** Fração do pixel dentro da forma: cheio, vazio ou subamostrado na borda. */
  const coverage = (x: number, y: number, sdf: (u: number, v: number) => number, edge: number) => {
    const d = sdf((x + 0.5) * scale, (y + 0.5) * scale);
    if (d <= -edge) return 1;
    if (d >= edge) return 0;
    let n = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (sdf((x + (sx + 0.5) / SS) * scale, (y + (sy + 0.5) / SS) * scale) <= 0) n++;
    return n / (SS * SS);
  };
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cover = full ? 1 : coverage(x, y, box, half);
      if (!cover) continue;
      const k = coverage(x, y, scissors, half / shrink);
      const i = (y * size + x) * 4;
      out[i] = Math.round(br + (fr - br) * k);
      out[i + 1] = Math.round(bgG + (fgG - bgG) * k);
      out[i + 2] = Math.round(bb + (fb - bb) * k);
      out[i + 3] = Math.round(255 * cover);
    }
  }
  return png(size, size, out);
}

const iconCache = new Map<string, Buffer>();
const ICONS: Record<string, { size: number; full: boolean }> = {
  '192.png': { size: 192, full: false },
  '512.png': { size: 512, full: false },
  'maskable.png': { size: 512, full: true },
  'apple.png': { size: 180, full: true },
};

function sendIcon(res: import('express').Response, file: string, bg: string, fg: string): void {
  const spec = ICONS[file];
  if (!spec) {
    res.status(404).end();
    return;
  }
  const key = `${file}:${bg}:${fg}`;
  let buf = iconCache.get(key);
  if (!buf) {
    buf = iconPng(spec.size, bg, fg, spec.full);
    if (iconCache.size > 500) iconCache.clear();
    iconCache.set(key, buf);
  }
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'public, max-age=86400');
  res.end(buf);
}

pwaRouter.get('/icons/:file', (req, res) => sendIcon(res, String(req.params.file), PLATFORM.bg, PLATFORM.fg));
pwaRouter.get('/b/:slug/icons/:file', (req, res) => {
  const shop = shopBrand(String(req.params.slug));
  if (!shop) {
    res.status(404).end();
    return;
  }
  sendIcon(res, String(req.params.file), shop.primary_color, shop.accent_color);
});

// ---------- manifest

const icons = (base: string) => [
  { src: `${base}/icons/192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: `${base}/icons/512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: `${base}/icons/maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

function sendManifest(res: import('express').Response, manifest: object): void {
  res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=3600');
  res.end(JSON.stringify(manifest));
}

/** Painel do dono e app do barbeiro. */
pwaRouter.get('/manifest.webmanifest', (_req, res) => {
  const name = platformName();
  sendManifest(res, {
    id: '/',
    name,
    short_name: name.length > 14 ? 'Barbearia' : name,
    lang: 'pt-BR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: PLATFORM.background,
    theme_color: PLATFORM.bg,
    icons: icons(''),
  });
});

/** App do cliente, com a marca da barbearia. */
pwaRouter.get('/b/:slug/manifest.webmanifest', (req, res) => {
  const shop = shopBrand(String(req.params.slug));
  if (!shop) {
    res.status(404).end();
    return;
  }
  const base = `/b/${shop.slug}`;
  sendManifest(res, {
    id: `${base}/`,
    name: shop.name,
    short_name: shop.name.length > 14 ? shop.name.split(/\s+/).slice(0, 2).join(' ').slice(0, 14) : shop.name,
    description: `Agende, veja seu cartão fidelidade e receba os avisos da ${shop.name}.`,
    lang: 'pt-BR',
    start_url: `${base}/conta`,
    scope: `${base}/`,
    display: 'standalone',
    background_color: PLATFORM.background,
    theme_color: shop.primary_color,
    icons: icons(base),
  });
});

// ---------- página (index.html com o manifest, o ícone e as cores certas)

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let indexCache: { file: string; mtime: number; html: string } | null = null;

/** O index.html do app com o manifest da barbearia (em /b/slug/...) ou o da plataforma. */
export function renderIndex(file: string, path: string): string {
  const mtime = fs.statSync(file).mtimeMs;
  if (!indexCache || indexCache.file !== file || indexCache.mtime !== mtime) indexCache = { file, mtime, html: fs.readFileSync(file, 'utf8') };
  let html = indexCache.html;
  const m = /^\/b\/([a-z0-9-]+)(?:\/|$)/.exec(path);
  const shop = m ? shopBrand(m[1]) : undefined;
  const base = shop ? `/b/${shop.slug}` : '';
  const name = shop?.name ?? platformName();
  const tags = [
    `<link rel="manifest" href="${base}/manifest.webmanifest" />`,
    `<link rel="apple-touch-icon" href="${base}/icons/apple.png" />`,
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    `<meta name="apple-mobile-web-app-title" content="${esc(name)}" />`,
  ];
  html = html.replace('</head>', `  ${tags.join('\n    ')}\n  </head>`);
  if (shop) {
    html = html
      .replace(/<meta name="theme-color" content="[^"]*"\s*\/?>/, `<meta name="theme-color" content="${esc(shop.primary_color)}" />`)
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(shop.name)}</title>`);
  }
  return html;
}
