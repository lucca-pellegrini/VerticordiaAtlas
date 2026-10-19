// sw.js: the offline cache. The app works from what it holds, and asks the network only to refresh it.
//   shell (pages, scripts, styles, icons, vendor files): served from cache at once, refreshed in the background
//   game data (metadata, marker data, posters, cards): the same, and the refresh revalidates with the stored ETag
//   map tiles: cache first, kept for 30 days and at most TILE_LIMIT tiles
//   fonts: cache first
//   /api/ (accounts, sync): never cached, never answered from the cache
// Bump VERSION when the precache list changes.

const VERSION = 'v31';
const SHELL = `va-shell-${VERSION}`, DATA = `va-data-${VERSION}`, TILES = `va-tiles-${VERSION}`, FONTS = `va-fonts-${VERSION}`;
const KEEP = new Set([SHELL, DATA, TILES, FONTS]);
const TILE_LIMIT = 2000;
const TILE_MAX_AGE = 30 * 24 * 3600 * 1000;

const PRECACHE = [
  '', 'index.html', 'signin/', 'signin/index.html', 'signin/signin.js', 'signin/signin.css',
  'style.css', 'base.css', 'home.css', 'app.js', 'home.js', 'account.js', 'sync.js', 'drawing.js', 'usermarkers.js',
  'capture.mjs', 'icons.mjs', 'icons-lib.mjs', 'share-link.mjs', 'perfect-freehand.mjs', 'shared/sync-rules.mjs', 'shared/search.mjs',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/marked.umd.js', 'vendor/perfect-freehand.mjs',
  'vendor/lucide/icons.json', 'card.jpg',
];

const scope = self.registration.scope;
const at = p => new URL(p, scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // one missing file must not stop the rest from being cached
    await Promise.all(PRECACHE.map(p => cache.add(at(p)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (!KEEP.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

const offline = () => new Response('Offline, and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });

// serve what we have, refresh it behind the scenes
async function staleWhileRevalidate(event, cacheName, req) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const refresh = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok && res.status === 200) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { event.waitUntil(refresh); return cached; }
  return (await refresh) || offline();
}

// a copy remembers when it was made, so tiles can age out
async function stamped(res) {
  const body = await res.blob();
  const headers = new Headers(res.headers);
  headers.set('x-va-cached-at', String(Date.now()));
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
async function trimTiles(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await cache.delete(k);
}
async function tile(event, req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit && Date.now() - Number(hit.headers.get('x-va-cached-at') || 0) < TILE_MAX_AGE) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      event.waitUntil(stamped(res.clone()).then(copy => cache.put(req, copy)).then(() => trimTiles(cache)));
      return res;
    }
  } catch { /* offline: below */ }
  return hit || offline();
}

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req).catch(() => null);
  if (res && res.ok) cache.put(req, res.clone());
  return res || offline();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.startsWith(new URL(scope).pathname + 'api/')) return; // accounts and sync: the network, always

  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(cacheFirst(FONTS, req));
    return;
  }
  if (url.origin !== self.location.origin) return;

  const rel = url.pathname.slice(new URL(scope).pathname.length);
  if (/^maps\/[^/]+\/[^/]+\/tiles\//.test(rel)) { event.respondWith(tile(event, req)); return; }
  if (rel.startsWith('maps/')) { event.respondWith(staleWhileRevalidate(event, DATA, req)); return; }
  event.respondWith(staleWhileRevalidate(event, SHELL, req));
});
