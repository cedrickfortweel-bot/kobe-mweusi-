/* Kobe Mweusi service worker (shared by buyer.html and seller.html).
   - Caches the app shell so the apps keep opening offline.
   - SKIP_WAITING lets the in-app "A new version is ready" bar apply updates.
   - CACHE_URL pre-caches a page the seller app asks for after load.
   Only same-origin GETs are touched; Google Fonts and other CDNs go straight to the network. */
const CACHE = 'kobe-mweusi-v7';
const SHELL = [
  'index.html',
  'admin.html',
  'buyer.html',
  'seller.html',
  'Kobe_Mweusi_homepage_v7_static.html',
  'reset-password.html',
  'kobe-theme.css',
  'kobe-theme.js',
  'kobe-oled.css',
  'kobe-calm.css',
  'portal-calm.css',
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
  if (m.type === 'PUSH_RESUBSCRIBE') {
    // App asked the SW to refresh the push subscription (e.g. new VAPID key).
    event.waitUntil((async () => {
      try {
        const reg = self.registration;
        if (!reg.pushManager || !('PushManager' in self)) return;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          self.clients.matchAll().then(list => {
            list.forEach(c => c.postMessage({ type: 'PUSH_RESUBSCRIBE', subscription: sub }));
          });
        }
      } catch (e) { /* push resubscribe is best effort */ }
    })());
  }
});

/* Normalize a notification link to a same-origin URL inside this app, so a
   crafted or corrupted payload cannot navigate a user off site.
   Notification data comes from our own VAPID-signed payload today, but it is
   attacker-influenceable data and the payload also round trips through the
   push service, which can modify it: RFC 8291 Section 7 makes exactly this
   point about header and payload fields being untrusted at the client. */
function safeLink(raw) {
  const FALLBACK = '/buyer.html';
  try {
    const url = new URL(String(raw || FALLBACK), self.location.origin);
    if (url.origin !== self.location.origin) return FALLBACK;
    let path = url.pathname;
    if (path === '/' || path === '') path = FALLBACK;
    const allowed = ['/buyer.html', '/seller.html', '/reset-password.html', '/admin.html', '/index.html'];
    if (allowed.indexOf(path) < 0) path = FALLBACK;
    return path + url.search + url.hash;
  } catch (e) {
    return FALLBACK;
  }
}

/* Notification clicks open the deep link carried in the push payload
   (notification data.link) and tell the visible page via OPEN_LINK. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = safeLink(event.notification.data && event.notification.data.link);
  const url = new URL(link, self.location.origin).toString();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        c.postMessage({ type: 'OPEN_LINK', link: url });
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

/* Web Push delivery. The push service POSTs an encrypted record; the browser
   decrypts it and hands us event.data.json() here. Payload shape is
   { title, body, data: { link, ... }, ts }, produced by the Edge Function in
   supabase/functions/_shared/push.ts. */
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }

  const title = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'Kobe Mweusi';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const link = safeLink(payload.data && payload.data.link);

  const options = {
    body: body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: (payload.data && payload.data.tag) ? String(payload.data.tag) : undefined,
    data: { link: link, extra: (payload.data && payload.data.extra) || null },
    /* Keep a notification relevant until the reader acts on it. */
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
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