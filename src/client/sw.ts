// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// sw.ts: the offline cache. The app works from what it holds, and asks the network only to refresh it.
//   shell (pages, scripts, styles, fonts, icons, vendor files): served from cache at once, refreshed in the background
//   game data (metadata, marker data, posters, cards): the same, and the refresh revalidates with the stored ETag
//   maps kept offline: answered from their pack in IndexedDB before anything else (see pack-store.ts), never the network
//   map tiles: cache first, kept for 30 days and at most TILE_LIMIT tiles
//   /api/ (accounts, sync): never cached, never answered from the cache

import { findInPacks, resetPackLookups } from "./pack-store.ts";

declare const __SW_VERSION__: string | undefined;
declare const self: ServiceWorkerGlobalScope;

export const VERSION = typeof __SW_VERSION__ !== "undefined" ? __SW_VERSION__ : "v40";
export const SHELL = `va-shell-${VERSION}`;
export const DATA = `va-data-${VERSION}`;
export const TILES = `va-tiles-${VERSION}`;
export const KEEP = new Set([SHELL, DATA, TILES]); // anything else is deleted on activation, the old "va-offline-tiles" too
export const TILE_LIMIT = 2000;
export const TILE_MAX_AGE = 30 * 24 * 3600 * 1000;

export const PRECACHE: readonly string[] = [
	"",
	"index.html",
	"map.html",
	"maps/index.json",
	"about/",
	"about/index.html",
	"terms/",
	"terms/index.html",
	"privacy/",
	"privacy/index.html",
	"license/",
	"license/index.html",
	"signin/",
	"signin/index.html",
	"signin/signin.js",
	"signin/signin.css",
	"account/",
	"account/index.html",
	"account/account.js",
	"account/account.css",
	"legal/legal.css",
	"legal/legal.js",
	"style.css",
	"base.css",
	"home.css",
	"app.js",
	"home.js",
	"theme.js",
	"fonts/instrument-serif-latin-400-normal.woff2",
	"fonts/instrument-sans-latin-variable.woff2",
	"fonts/red-hat-mono-latin-variable.woff2",
	"vendor/maplibre-gl.js",
	"vendor/maplibre-gl.css",
	"vendor/marked.umd.js",
	"vendor/lucide/icons.json",
	"manifest.webmanifest",
	"logo.svg",
	"icons/apple-touch-icon.png",
	"icons/icon-192.png",
	"icons/icon-512.png",
	"icons/maskable-512.png",
];

const offline = () =>
	new Response("Offline, and not cached yet.", { status: 503, headers: { "Content-Type": "text/plain" } });

if (typeof self !== "undefined" && "registration" in self) {
	const scope = self.registration.scope;
	const at = (p: string) => new URL(p, scope).href;

	self.addEventListener("install", (event: ExtendableEvent) => {
		event.waitUntil(
			(async () => {
				const cache = await caches.open(SHELL);
				// one missing file must not stop the rest from being cached
				await Promise.all(PRECACHE.map((p) => cache.add(at(p)).catch(() => {})));
				await self.skipWaiting();
			})(),
		);
	});

	self.addEventListener("activate", (event: ExtendableEvent) => {
		event.waitUntil(
			(async () => {
				for (const name of await caches.keys()) if (!KEEP.has(name)) await caches.delete(name);
				await self.clients.claim();
			})(),
		);
	});

	async function matchInCache(cache: Cache, req: Request, path: string): Promise<Response | undefined> {
		return (
			(await cache.match(req)) ||
			(await cache.match(req, { ignoreSearch: true })) ||
			(await cache.match(path)) ||
			(await cache.match(path, { ignoreSearch: true }))
		);
	}

	// a file of a map kept offline: straight from its pack
	async function fromPack(url: URL): Promise<Response | null> {
		const hit = await findInPacks(url.pathname);
		if (!hit) return null;
		return new Response(hit.blob, {
			status: 200,
			headers: {
				"Content-Type": hit.type || "application/octet-stream",
				"Content-Length": String(hit.blob.size),
			},
		});
	}

	function broadcastOnline(online: boolean): void {
		self.clients.matchAll().then((clients) => {
			for (const c of clients) c.postMessage({ type: "va-online-status", online });
		});
	}

	// serve what we have, refresh it behind the scenes. A server that is down may still answer (a proxy's 502/503): that
	// is not an answer, so what is cached is served and an error is never kept
	async function staleWhileRevalidate(event: FetchEvent, cacheName: string, req: Request): Promise<Response> {
		const cache = await caches.open(cacheName);
		let cached = await cache.match(req);
		if (!cached && req.mode === "navigate") cached = await cache.match(req, { ignoreSearch: true });
		if (!cached && cacheName !== SHELL) cached = await (await caches.open(SHELL)).match(req);
		const refresh = fetch(req, { cache: "no-cache" })
			.then((res) => {
				if (res.ok && res.status === 200) cache.put(req, res.clone());
				broadcastOnline(true);
				return res;
			})
			.catch(() => {
				broadcastOnline(false);
				return null;
			});
		if (cached) {
			event.waitUntil(refresh);
			return cached;
		}
		const fresh = await refresh;
		if (fresh && fresh.status < 500) return fresh;
		if (req.mode === "navigate") {
			const fallback = await (await caches.open(SHELL)).match(at("map.html"));
			if (fallback) return fallback;
		}
		return fresh ?? offline();
	}

	// a copy remembers when it was made, so tiles can age out
	async function stamped(res: Response): Promise<Response> {
		const body = await res.blob();
		const headers = new Headers(res.headers);
		headers.set("x-va-cached-at", String(Date.now()));
		return new Response(body, { status: res.status, statusText: res.statusText, headers });
	}

	async function trimTiles(cache: Cache): Promise<void> {
		const keys = await cache.keys();
		for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await cache.delete(k);
	}

	async function tile(event: FetchEvent, req: Request): Promise<Response> {
		const cache = await caches.open(TILES);
		const hit = await cache.match(req);
		if (hit && Date.now() - Number(hit.headers.get("x-va-cached-at") || 0) < TILE_MAX_AGE) return hit;
		try {
			const res = await fetch(req);
			if (res.ok) {
				broadcastOnline(true);
				event.waitUntil(
					stamped(res.clone())
						.then((copy) => cache.put(req, copy))
						.then(() => trimTiles(cache)),
				);
				return res;
			}
		} catch {
			broadcastOnline(false);
			/* offline: below */
		}
		return hit || offline();
	}

	self.addEventListener("message", (event: ExtendableMessageEvent) => {
		if (event.data?.type === "va-offline-changed") resetPackLookups();
		if (event.data?.type === "va-check-online") {
			event.source?.postMessage({
				type: "va-online-status",
				online: navigator.onLine,
			});
		}
		if (event.data?.type === "va-query-cached-games") {
			caches.open(DATA).then(async (cache) => {
				const keys = await cache.keys();
				const games = new Set<string>();
				for (const req of keys) {
					const path = new URL(req.url).pathname;
					const m = path.match(/\/maps\/([^/]+)\/(?:meta\.json|data\.json|markers\.json|[^/]+\/data\.json)/);
					if (m) games.add(decodeURIComponent(m[1]));
				}
				event.source?.postMessage({
					type: "va-cached-games-reply",
					games: [...games],
				});
			});
		}
		if (event.data?.type === "va-cache-posters" && Array.isArray(event.data?.urls)) {
			const urls: string[] = event.data.urls;
			event.waitUntil(
				(async () => {
					const cache = await caches.open(DATA);
					for (const rel of urls) {
						const req = new Request(at(rel));
						const hit = await cache.match(req);
						if (!hit) {
							try {
								const res = await fetch(req);
								if (res.ok && res.status === 200) {
									await cache.put(req, res);
								}
							} catch {}
						}
					}
				})(),
			);
		}
	});

	// the maps folder: tiles from the cache or the network, everything else revalidated
	function routeMaps(event: FetchEvent, req: Request, url: URL, rel: string): Promise<Response> {
		if (/^maps\/[^/]+\/[^/]+\/tiles\//.test(rel)) return tile(event, req);
		if (req.mode === "navigate" && /^maps\/[^/]+$/.test(rel))
			return Promise.resolve(Response.redirect(url.href + "/", 301));
		return staleWhileRevalidate(event, DATA, req);
	}

	self.addEventListener("fetch", (event: FetchEvent) => {
		const req = event.request;
		if (req.method !== "GET") return;
		const url = new URL(req.url);

		if (url.pathname.startsWith(new URL(scope).pathname + "api/")) return; // accounts and sync: the network, always
		if (url.origin !== self.location.origin) return;

		const rel = url.pathname.slice(new URL(scope).pathname.length);
		if (rel.startsWith("maps/")) {
			// a file of a map kept offline comes from its pack, before anything else
			event.respondWith(fromPack(url).then((r) => r ?? routeMaps(event, req, url, rel)));
			return;
		}
		event.respondWith(staleWhileRevalidate(event, SHELL, req));
	});
}