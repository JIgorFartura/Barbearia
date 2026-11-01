// Service worker do app: mostra os avisos (push), abre a tela certa ao tocar e guarda uma cópia da
// agenda para ver sem internet. Com internet, tudo vem sempre da rede (a versão mais nova); a cópia
// só aparece quando a rede falha. Sair da conta apaga o que ficou guardado no aparelho.
const SHELL = 'bladr-app-v1';
const DATA = 'bladr-dados-v1';

/** Respostas da API guardadas para ver sem internet (a agenda e quem está logado). */
const OFFLINE_API = [
  /^\/api\/auth\/me$/,
  /^\/api\/barber\/(me|agenda)$/,
  /^\/api\/shop\/(status|agenda|barbers|queue)$/,
  /^\/api\/customer\/[\w-]+\/me$/,
  /^\/api\/public\/shops\/[\w-]+\/brand$/,
];
const LOGOUT = [/^\/api\/auth\/logout$/, /^\/api\/customer\/[\w-]+\/logout$/];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL && key !== DATA) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

/** Rede primeiro; sem rede, a última cópia guardada. */
async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = (await cache.match(request)) || (fallbackUrl && (await cache.match(fallbackUrl)));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'POST' && LOGOUT.some((r) => r.test(url.pathname))) {
    event.waitUntil(caches.delete(DATA));
    return;
  }
  if (req.method !== 'GET') return;

  // Telas do app (páginas e arquivos do site): sempre a versão nova, com a cópia para sem internet.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL, '/'));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Arquivos com nome único por versão: se já tem, não muda.
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const response = await fetch(req);
        if (response.ok) await cache.put(req, response.clone());
        return response;
      }),
    );
    return;
  }
  if (OFFLINE_API.some((r) => r.test(url.pathname))) {
    event.respondWith(networkFirst(req, DATA));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Barbearia', {
      body: data.body || '',
      tag: data.tag,
      icon: data.icon || '/icons/192.png',
      badge: '/icons/192.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (w.url === url && 'focus' in w) return w.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
