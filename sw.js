/* Kobe Mweusi service worker (shared by buyer.html and seller.html).
   - Caches the app shell so the apps keep opening offline.
   - SKIP_WAITING lets the in-app "A new version is ready" bar apply updates.
   - CACHE_URL pre-caches a page the seller app asks for after load.
   Only same-origin GETs are touched; Google Fonts and other CDNs go straight to the network. */
const CACHE = 'kobe-mweusi-v4';
const SHELL = [
  'index.html',
  'admin.html',
  'buyer.html',
  'seller.html',
  'Kobe_Mweusi_homepage_v7_static.html',
  'reset-password.html',
  'icon.svg',
  'kobe-qr.js',
  'jsQR.js',
  'kobe-camera.js',
  'supabase-js.js',
  'kobe-supabase.js',
  'kobe-app-workflows.js',
  'kobe-admin.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One file at a time: a missing page must not fail the whole install.
    await Promise.allSettled(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' }))));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const m = event.data || {};
  if (m.type === 'SKIP_WAITING') self.skipWaiting();
  if (m.type === 'CACHE_URL' && typeof m.url === 'string' && m.url.startsWith(self.location.origin)) {
    event.waitUntil(
      caches.open(CACHE)
        .then(c => c.add(new Request(m.url, { cache: 'reload' })))
        .catch(() => {})
    );
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  if (req.mode === 'navigate') {
    // Pages: network first so updates arrive, cached copy as the offline fallback.
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const fresh = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await fresh) || Response.error();
  })());
});