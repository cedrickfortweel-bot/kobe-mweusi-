/* Kobe Mweusi agent hub service worker.

   The hub is online-only for scanning, but the shell is cached so the
   page still opens on a weak connection.

   Pages are served network first, so a new build is picked up as soon
   as it is reachable. Static files are served stale-while-revalidate:
   the cached copy answers immediately and the fresh one replaces it in
   the background. The API boundary is one of these files, so it must
   never be pinned to a copy that is older than the server it talks to. */
const CACHE = 'kobe-agent-hub-v3';
const SHELL = [
  'agent.html',
  'agent.css',
  'agent.webmanifest',
  'agent-sw.js',
  'kobe-turtle-logo.png',
  'jsQR.js',
  'kobe-camera.js',
  'supabase-js.js',
  'kobe-supabase.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.allSettled(SHELL.map(file => cache.add(new Request(file, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('/agent-sw.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  const file = url.pathname.split('/').pop() || '';
  if (!SHELL.includes(file)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const fresh = fetch(request).then(res => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await fresh) || Response.error();
  })());
});
