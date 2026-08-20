// SPEL Safety — service worker.
//
// Purpose: make the PUBLIC report form work OFFLINE. Once a phone has opened the
// form even once, scanning the QR again opens it with no connectivity, the
// worker fills it in, and the report is queued on the phone (see report.js) and
// sent automatically when the internet is back.
//
// Scope note: this SW is registered at "/" so it can serve the report shell, but
// it ONLY handles the report form's own assets. Every other route (dashboard,
// admin, /api/*) falls through to the normal network — the SW never caches or
// interferes with the authenticated app.

const CACHE = 'spel-report-v3';
const SHELL = [
  '/report.html',
  '/js/report.js',
  '/js/common.js',
  '/css/style.css',
  '/favicon.svg',
  '/manifest.webmanifest',
];

// Only these paths are owned by the SW. Anything else = pass through to network.
const OWNED = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Best-effort precache: a single missing asset must not fail the install.
    await Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop old cache versions so a deploy is picked up.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Stale-while-revalidate for the report shell: serve instantly from cache (so it
// opens offline), and refresh the cached copy from the network in the background.
async function staleWhileRevalidate(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey || request, { ignoreSearch: true });
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(cacheKey || request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch POST (report submit) etc.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A navigation to the report form (with or without ?unit=…) → cached shell.
  if (req.mode === 'navigate' && url.pathname === '/report.html') {
    event.respondWith(staleWhileRevalidate(req, '/report.html'));
    return;
  }
  // Owned static assets → stale-while-revalidate.
  if (OWNED.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req, url.pathname));
    return;
  }
  // Everything else: do nothing → normal network handling (no caching).
});
