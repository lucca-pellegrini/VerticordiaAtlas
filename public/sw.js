(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // src/client/sw.ts
  var exports_sw = {};
  __export(exports_sw, {
    DATA: () => DATA,
    KEEP: () => KEEP,
    PRECACHE: () => PRECACHE,
    SHELL: () => SHELL,
    TILES: () => TILES,
    TILE_LIMIT: () => TILE_LIMIT,
    TILE_MAX_AGE: () => TILE_MAX_AGE,
    VERSION: () => VERSION
  });
  var VERSION = "v40-559d2fa6";
  var SHELL = `va-shell-${VERSION}`;
  var DATA = `va-data-${VERSION}`;
  var TILES = `va-tiles-${VERSION}`;
  var KEEP = new Set([SHELL, DATA, TILES]);
  var TILE_LIMIT = 2000;
  var TILE_MAX_AGE = 30 * 24 * 3600 * 1000;
  var PRECACHE = [
    "",
    "index.html",
    "map.html",
    "about/",
    "about/index.html",
    "terms/",
    "terms/index.html",
    "privacy/",
    "privacy/index.html",
    "signin/",
    "signin/index.html",
    "signin/signin.js",
    "signin/signin.css",
    "legal/legal.css",
    "legal/legal.js",
    "style.css",
    "base.css",
    "home.css",
    "app.js",
    "home.js",
    "theme.js",
    "fonts/instrument-serif-latin-400-normal.woff2",
    "fonts/inter-latin-400-normal.woff2",
    "fonts/inter-latin-600-normal.woff2",
    "fonts/inter-latin-700-normal.woff2",
    "fonts/inter-latin-800-normal.woff2",
    "vendor/maplibre-gl.js",
    "vendor/maplibre-gl.css",
    "vendor/marked.umd.js",
    "vendor/lucide/icons.json",
    "manifest.webmanifest",
    "logo.svg",
    "icons/apple-touch-icon.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/maskable-512.png"
  ];
  var offline = () => new Response("Offline, and not cached yet.", { status: 503, headers: { "Content-Type": "text/plain" } });
  if (typeof self !== "undefined" && "registration" in self) {
    const scope = self.registration.scope;
    const at = (p) => new URL(p, scope).href;
    self.addEventListener("install", (event) => {
      event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        await Promise.all(PRECACHE.map((p) => cache.add(at(p)).catch(() => {})));
        await self.skipWaiting();
      })());
    });
    self.addEventListener("activate", (event) => {
      event.waitUntil((async () => {
        for (const name of await caches.keys())
          if (!KEEP.has(name))
            await caches.delete(name);
        await self.clients.claim();
      })());
    });
    async function staleWhileRevalidate(event, cacheName, req) {
      const cache = await caches.open(cacheName);
      let cached = await cache.match(req);
      if (!cached && req.mode === "navigate") {
        cached = await cache.match(req, { ignoreSearch: true });
      }
      const refresh = fetch(req, { cache: "no-cache" }).then((res) => {
        if (res.ok && res.status === 200)
          cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      const fresh = await refresh;
      if (fresh)
        return fresh;
      if (req.mode === "navigate") {
        const shell = await caches.open(SHELL);
        const fallback = await shell.match(at("map.html"));
        if (fallback)
          return fallback;
      }
      return offline();
    }
    async function stamped(res) {
      const body = await res.blob();
      const headers = new Headers(res.headers);
      headers.set("x-va-cached-at", String(Date.now()));
      return new Response(body, { status: res.status, statusText: res.statusText, headers });
    }
    async function trimTiles(cache) {
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT)))
        await cache.delete(k);
    }
    async function tile(event, req) {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit && Date.now() - Number(hit.headers.get("x-va-cached-at") || 0) < TILE_MAX_AGE)
        return hit;
      try {
        const res = await fetch(req);
        if (res.ok) {
          event.waitUntil(stamped(res.clone()).then((copy) => cache.put(req, copy)).then(() => trimTiles(cache)));
          return res;
        }
      } catch {}
      return hit || offline();
    }
    self.addEventListener("fetch", (event) => {
      const req = event.request;
      if (req.method !== "GET")
        return;
      const url = new URL(req.url);
      if (url.pathname.startsWith(new URL(scope).pathname + "api/"))
        return;
      if (url.origin !== self.location.origin)
        return;
      const rel = url.pathname.slice(new URL(scope).pathname.length);
      if (/^maps\/[^/]+\/[^/]+\/tiles\//.test(rel)) {
        event.respondWith(tile(event, req));
        return;
      }
      if (rel.startsWith("maps/")) {
        if (req.mode === "navigate" && /^maps\/[^/]+$/.test(rel)) {
          event.respondWith(Response.redirect(url.href + "/", 301));
          return;
        }
        event.respondWith(staleWhileRevalidate(event, DATA, req));
        return;
      }
      event.respondWith(staleWhileRevalidate(event, SHELL, req));
    });
  }
})();
