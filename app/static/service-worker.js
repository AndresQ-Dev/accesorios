const CACHE_VERSION = 'precios-static-v5';
const STATIC_ASSETS = [
  '/static/admin.css',
  '/static/admin.js',
  '/static/favicon.ico',
  '/static/favicon.svg',
  '/static/fetch-with-timeout.js',
  '/static/icons/apple-touch-icon.png',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/icon-maskable-512.png',
  '/static/index.css',
  '/static/index.js',
  '/static/images/scanner-no-match/01.webp',
  '/static/images/scanner-no-match/02.webp',
  '/static/images/scanner-no-match/04.webp',
  '/static/images/scanner-no-match/05.webp',
  '/static/login.js',
  '/static/manifest.webmanifest',
  '/static/pwa.js',
  '/static/scanner.js',
  '/static/scanner-lookup.js',
  '/static/no-repeat-picker.js',
  '/static/vendor/zxing_reader.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) return;
  if (!STATIC_ASSETS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});
