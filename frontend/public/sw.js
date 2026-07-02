/* BlueWings PWA service worker: offline app-shell caching.
 * Strategy: network-first with cache fallback for all same-origin GETs, so fresh
 * code always wins when online and the last good copy serves offline.
 * /api/* is never cached (live conversation data).
 */
const CACHE = 'bluewings-shell-v2';
const SHELL = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const cacheKey = event.request.mode === 'navigate' ? '/' : event.request;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(cacheKey, copy));
        }
        return res;
      })
      .catch(() => caches.match(cacheKey))
  );
});
