#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// server.ts: serves the site, and makes the preview cards for shared markers on demand.
//
//   bun server/server.ts [--port 8080] [--host 127.0.0.1] [--debug]
//
// Plain files are served as they are. Two routes are added:
//   /maps/<game>/?loc=<id>&map=<map>        the game page, with that marker's own preview tags. The page itself
//                                           opens the marker (see map.ts), so people get the same view.
//   /cards/share/<game>/<map>/<id>.jpg      that marker's card. Rendered the first time it is asked for, then
//                                           cached in cache/share/ and served from there. A changed marker (or
//                                           a changed category or game colour) gets a new card.
//   /maps/<game>/<map>/tiles/<set>/...      a map tile: the stored one, else the one in cache/tiles/, else made from the
//                                           four tiles of the next zoom and cached (see tile-service.ts).
//
// The static homepage and game cards still come from make-cards.ts. Share cards need Chromium and ImageMagick,
// like make-cards.ts. The address in tags comes from site.json when it is set, otherwise from the request.

import type { Stats } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { buildClient } from "../scripts/build.ts";
import { unpackMarker } from "../src/shared/share-link.ts";
import { createApi } from "./api.ts";
import {
	categoryIcon,
	chromePath,
	drawCard,
	esc,
	exists,
	gameFavicon,
	gameThemeColor,
	loadGames,
	markerHtml,
	officialIcon,
	plainText,
	PUBLIC,
	REPO,
	socialTags,
	withHead,
} from "./cards.ts";
import type { LoadedGame, MarkerCardInfo } from "./cards.ts";
import { streamOfflinePack } from "./offline-pack.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_TARGET_BYTES, parseSize, TileCache } from "./tile-cache.ts";
import { createTileService } from "./tile-service.ts";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".avif": "image/avif",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".webmanifest": "application/manifest+json; charset=utf-8",
};
const TEXT = /^text\/|javascript|json|css|svg|manifest/;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const HOST = opt("host", "127.0.0.1"),
	PORT = Number(opt("port", "8080"));

// the configured address, if there is a real one; otherwise the address the request came in on
const configuredSite = async (): Promise<string | null> => {
	const raw = process.env.SITE_URL || (await Bun.file(path.join(REPO, "site.json")).json()).url || "";
	const site = raw.replace(/\/+$/, "");
	return /^https?:\/\/[^/]+$/.test(site) && !site.includes("YOUR-DOMAIN") ? site : null;
};
const siteOrigin = async (req: Request): Promise<string> =>
	(await configuredSite()) || `${new URL(req.url).protocol}//${req.headers.get("host") || "localhost"}`;

/* ---------- caches: the game list (short time), map data (by file date), chrome (once), renders (once) ---------- */

let gamesCache: { at: number; list: LoadedGame[] } | null = null;
async function games(): Promise<LoadedGame[]> {
	if (!gamesCache || Date.now() - gamesCache.at > 30000)
		gamesCache = { at: Date.now(), list: (await loadGames()).games };
	return gamesCache.list;
}

const dataCache = new Map<string, { mtime: number; json: any }>();
async function readData(file: string): Promise<any> {
	const st = await stat(file);
	const hit = dataCache.get(file);
	if (hit && hit.mtime === st.mtimeMs) return hit.json;
	const json = await Bun.file(file).json();
	dataCache.set(file, { mtime: st.mtimeMs, json });
	return json;
}

// Card renders start headless Chromium, which is expensive. So: a few at a time; a limit per client per window; and when a
// client is over its limit (or the queue is full) it gets the game's plain card, not a render.
const RENDER_CONCURRENCY = 2,
	RENDER_QUEUE = 20,
	RENDERS_PER_WINDOW = 25,
	WINDOW_MS = 10 * 60 * 1000;
const clients = new Map<string, { start: number; count: number }>();
const clientIp = (req: Request): string =>
	String(req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown");

function allowRender(ip: string): boolean {
	const now = Date.now();
	if (clients.size > 10000) clients.clear();
	let c = clients.get(ip);
	if (!c || now - c.start > WINDOW_MS) {
		c = { start: now, count: 0 };
		clients.set(ip, c);
	}
	if (c.count >= RENDERS_PER_WINDOW) return false;
	c.count++;
	return true;
}
let active = 0;
const queued: (() => void)[] = [];
function takeSlot(): Promise<void> {
	return new Promise((res) => {
		if (active < RENDER_CONCURRENCY) {
			active++;
			res();
		} else queued.push(res);
	});
}
function freeSlot(): void {
	const next = queued.shift();
	if (next) next();
	else active--;
}

let chromeBin: string | null = null;
const chrome = async (): Promise<string> => (chromeBin ??= await chromePath());

const inflight = new Map<string, Promise<boolean>>();
const once = (key: string, fn: () => Promise<boolean>): Promise<boolean> => {
	if (!inflight.has(key))
		inflight.set(
			key,
			fn().finally(() => inflight.delete(key)),
		);
	return inflight.get(key)!;
};

/* ---------- a marker, from the game's own data ---------- */

async function markerInfo(gameSlug: string, mapSlug: string, id: number): Promise<MarkerCardInfo | null> {
	const g = (await games()).find((x) => x.slug === gameSlug);
	if (!g) return null;
	const mapMeta = g.maps.find((m) => m.slug === mapSlug);
	if (!mapMeta?.data) return null;
	const data = await readData(path.join(g.dir, mapMeta.data));
	const loc = (data.locations || []).find((l: any) => Number(l.id) === id);
	if (!loc) return null;
	const cat: any = Object.values(data.categories || {}).find((c: any) => c.id === loc.category_id);
	const shot = await firstScreenshot(gameSlug, g.dir, loc.media);
	// the card shows the category's icon: the game's own icon-font glyph, on its group's colour
	const group = (data.groups || []).find((x: any) => x.id === cat?.group_id);
	const color = /^#?[0-9a-f]{6}$/i.test(group?.color || "") ? "#" + String(group.color).replace("#", "") : null;
	const icon = cat?.icon ? await officialIcon(g, cat.icon, color) : null;
	return {
		title: loc.title || "Marker",
		category: cat?.title || "",
		description: plainText(loc.description, 150),
		gameTitle: g.title,
		theme: g.theme,
		poster: g.poster,
		shot,
		icon,
		gameSlug,
		mapSlug,
		id,
	};
}

// the first image of a marker that has been downloaded (locally in media/ or uploaded to R2 in data/atlas.db)
async function firstScreenshot(gameSlug: string, gameDir: string, media: any[]): Promise<string | null> {
	for (const m of media || []) {
		const kind = m.type || (m.mime_type || "").split("/")[0];
		if (kind !== "image" || !m.url) continue;
		let name: string | undefined;
		try {
			name = decodeURIComponent(new URL(m.url).pathname.split("/").pop()!);
		} catch {
			continue;
		}
		if (!name) continue;
		const file = path.join(gameDir, "media", name);
		if (await exists(file)) return file;
		if (mediaUrl && api.hasMedia(gameSlug, name)) {
			return `${mediaUrl}/v1/${encodeURIComponent(gameSlug)}/${encodeURIComponent(name)}`;
		}
	}
	return null;
}

/* ---------- routes ---------- */

function send(
	status: number,
	body: BodyInit | null = null,
	type = "text/plain; charset=utf-8",
	headers: Record<string, string | number> = {},
): Response {
	const h = new Headers();
	h.set("Content-Type", type);
	for (const [k, v] of Object.entries(headers)) {
		h.set(k, String(v));
	}
	return new Response(body, { status, headers: h });
}

async function shareCard(req: Request, gameSlug: string, mapSlug: string, id: number): Promise<Response> {
	const info = await markerInfo(gameSlug, mapSlug, id);
	if (!info) return send(404, "no such marker");
	const key = new Bun.CryptoHasher("sha1")
		.update(JSON.stringify({ ...info, v: 2 }))
		.digest("hex")
		.slice(0, 12);
	const dir = path.join(REPO, "cache", "share");
	const prefix = `${encodeURIComponent(gameSlug)}__${encodeURIComponent(mapSlug)}__${id}__`;
	const file = path.join(dir, `${prefix}${key}.jpg`);
	const ready = await ensureCard(file, clientIp(req), async () => {
		console.log(`card: ${gameSlug}/${mapSlug}/${id} (${info.title})`);
		return markerHtml(info);
	});
	if (!ready) return sendPlainCard(gameSlug);
	if (ready && !(await exists(file))) return sendPlainCard(gameSlug);
	for (const old of await readdir(dir).catch(() => [] as string[])) {
		if (old.startsWith(prefix) && old !== path.basename(file)) await unlink(path.join(dir, old)).catch(() => {});
	}
	if (req.method === "HEAD") {
		return new Response(null, {
			status: 200,
			headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
		});
	}
	return new Response(Bun.file(file), {
		status: 200,
		headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
	});
}

async function ensureCard(file: string, ip: string, htmlFor: () => Promise<string>): Promise<boolean> {
	if (await exists(file)) return true;
	if (!allowRender(ip) || queued.length >= RENDER_QUEUE) return false;
	return once(file, async () => {
		if (await exists(file)) return true;
		await takeSlot();
		try {
			await drawCard(await chrome(), await htmlFor(), file);
			return true;
		} finally {
			freeSlot();
		}
	});
}

async function sendPlainCard(gameSlug: string): Promise<Response> {
	const game = path.join(PUBLIC, "maps", gameSlug, "card.jpg");
	const file = (await exists(game)) ? game : path.join(PUBLIC, "card.jpg");
	return new Response(Bun.file(file), {
		status: 200,
		headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
	});
}

let mapTemplateCache: { mtime: number; html: string } | null = null;
async function mapTemplate(): Promise<string> {
	const file = path.join(PUBLIC, "map.html");
	const st = await stat(file);
	if (mapTemplateCache && mapTemplateCache.mtime === st.mtimeMs) return mapTemplateCache.html;
	const html = await Bun.file(file).text();
	mapTemplateCache = { mtime: st.mtimeMs, html };
	return html;
}

async function gamePageHtml(
	req: Request,
	gameSlug: string,
	{ block = null, pageTitle = null }: { block?: string | null; pageTitle?: string | null } = {},
): Promise<string | null> {
	const g = (await games()).find((x) => x.slug === gameSlug);
	if (!g) return null;
	const template = await mapTemplate();
	const isLight = /(?:^|;\s*)va_theme=light\b/.test(req.headers.get("cookie") || "");
	const themeColor = gameThemeColor(g.theme, isLight);
	const favicon = gameFavicon(g.theme, isLight);
	const fullTitle = pageTitle ? `${pageTitle} · Verticordia Atlas` : `${g.title} · Verticordia Atlas`;

	let gameBlock = block;
	if (!gameBlock) {
		const origin = await siteOrigin(req);
		const slug = encodeURI(g.slug);
		gameBlock = socialTags({
			title: fullTitle,
			description: g.description,
			url: `${origin}/maps/${slug}/`,
			image: `${origin}/maps/${slug}/card.jpg`,
			alt: g.alt,
		});
	}

	let out = template;
	out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(fullTitle)}</title>`);
	out = out.replace(
		/<meta name="theme-color" content="[^"]*">/,
		() => `<meta name="theme-color" content="${esc(themeColor)}">`,
	);
	out = out.replace(/<link rel="icon" href="[^"]*">/, () => `<link rel="icon" href="${esc(favicon)}">`);
	out = out.replace(/<body([^>]*)>/, (_m, attrs: string) => {
		const cleaned = attrs.replace(/\s*data-(?:game|media-url)="[^"]*"/g, "");
		const mediaAttr = mediaUrl ? ` data-media-url="${esc(mediaUrl)}"` : "";
		return `<body${cleaned} data-game="${esc(g.slug)}"${mediaAttr}>`;
	});
	out = withHead(out, gameBlock, fullTitle);
	return out;
}

async function gamePage(req: Request, gameSlug: string): Promise<Response> {
	const html = await gamePageHtml(req, gameSlug);
	if (!html) return send(404, "not found");
	return send(200, html, "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
}

async function sharePage(req: Request, gameSlug: string, mapSlug: string, id: number): Promise<Response | null> {
	const info = await markerInfo(gameSlug, mapSlug, id);
	if (!info) return null;
	const origin = await siteOrigin(req);
	const enc = encodeURIComponent;
	const pageUrl = `${origin}/maps/${encodeURI(gameSlug)}/?loc=${id}&map=${enc(mapSlug)}`;
	const shownTitle = `${info.title} · ${info.gameTitle}`;
	const description =
		[info.category, info.description].filter(Boolean).join(" · ") || `A marker on the ${info.gameTitle} map.`;
	const block = socialTags({
		title: shownTitle,
		description,
		url: pageUrl,
		image: `${origin}/cards/share/${enc(gameSlug)}/${enc(mapSlug)}/${id}.jpg`,
		alt: `${info.title} on the ${info.gameTitle} map`,
	});
	const html = await gamePageHtml(req, gameSlug, { block, pageTitle: shownTitle });
	if (!html) return null;
	return send(200, html, "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
}

async function sharedMarkerPage(req: Request, gameSlug: string, packed: string): Promise<Response | null> {
	const d = await unpackMarker(packed);
	const g = d && (await games()).find((x) => x.slug === gameSlug);
	if (!d || !g) return null;
	const origin = await siteOrigin(req);
	const shownTitle = `${d.title} · ${g.title}`;
	const description =
		[d.category, plainText(d.desc, 150)].filter(Boolean).join(" · ") || `A marker on the ${g.title} map.`;
	const block = socialTags({
		title: shownTitle,
		description,
		url: `${origin}/maps/${encodeURI(gameSlug)}/?tm=${packed}&map=${encodeURIComponent(d.map)}`,
		image: `${origin}/cards/tm/${encodeURI(gameSlug)}.jpg?tm=${packed}`,
		alt: `${d.title} on the ${g.title} map`,
	});
	const html = await gamePageHtml(req, gameSlug, { block, pageTitle: shownTitle });
	if (!html) return null;
	return send(200, html, "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
}

async function sharedMarkerCard(req: Request, gameSlug: string, packed: string): Promise<Response> {
	const d = await unpackMarker(packed);
	const g = d && (await games()).find((x) => x.slug === gameSlug);
	if (!d || !g) return send(404, "no such marker");
	const key = new Bun.CryptoHasher("sha1").update("tm2").update(packed).digest("hex").slice(0, 16);
	const file = path.join(REPO, "cache", "share", `tm-${encodeURIComponent(gameSlug)}-${key}.jpg`);
	const ready = await ensureCard(file, clientIp(req), async () => {
		console.log(`card: shared marker in ${gameSlug} (${d.title})`);
		return markerHtml({
			title: d.title,
			category: d.category,
			description: plainText(d.desc, 150),
			gameTitle: g.title,
			theme: g.theme,
			poster: g.poster,
			icon: d.category ? await categoryIcon(d) : null,
		});
	});
	if (!ready || !(await exists(file))) return sendPlainCard(gameSlug);
	if (req.method === "HEAD") {
		return new Response(null, {
			status: 200,
			headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
		});
	}
	return new Response(Bun.file(file), {
		status: 200,
		headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
	});
}

// sanitize the request target so scheme-relative paths ("//", "//////"), backslashes, or bad %-encoding never throw
function parseUrl(raw: string | undefined): { url: URL; pathname: string } | null {
	if (typeof raw !== "string") return null;
	try {
		let url: URL;
		if (raw.startsWith("http://") || raw.startsWith("https://")) {
			url = new URL(raw);
		} else {
			const trimmed = raw.replace(/^[\/\\]+/, "/");
			if (!trimmed.startsWith("/")) return null;
			url = new URL(trimmed, "http://localhost");
		}
		const pathname = decodeURIComponent(url.pathname).replace(/\\/g, "/").replace(/\/+/g, "/");
		if (/[\x00-\x1f\x7f]/.test(pathname)) return null;
		url.pathname = encodeURI(pathname);
		return { url, pathname };
	} catch {
		return null;
	}
}

async function serveStatic(req: Request, rel: string, search = ""): Promise<Response> {
	const rawParts = rel.split("/").filter(Boolean);
	if (rawParts.includes("..")) return send(403, "forbidden");
	let file = path.normalize(path.join(PUBLIC, rel));
	if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(403, "forbidden");
	const parts = path.relative(PUBLIC, file).split(path.sep).filter(Boolean);
	if (parts.some((p) => p.startsWith(".") || p === "cache" || p === "node_modules")) return send(404, "not found");
	let st: Stats;
	try {
		st = await stat(file);
	} catch {
		return send(404, "not found");
	}
	if (st.isDirectory()) {
		if (!rel.endsWith("/")) {
			return new Response(null, {
				status: 301,
				headers: { Location: encodeURI(rel) + "/" + search },
			});
		}
		file = path.join(file, "index.html");
		try {
			st = await stat(file);
		} catch {
			return send(404, "not found");
		}
	}
	if (!st.isFile()) return send(404, "not found");
	const type = TYPES[path.extname(file).toLowerCase()];
	if (!type) return send(404, "not found");
	const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
	const lastModified = st.mtime.toUTCString();
	const headers: Record<string, string> = {
		"Content-Type": type,
		ETag: etag,
		"Last-Modified": lastModified,
		"Cache-Control": TEXT.test(type) ? "no-cache" : "public, max-age=3600",
	};
	if (notModified(req, etag, st.mtime)) {
		return new Response(null, {
			status: 304,
			headers: { ETag: etag, "Last-Modified": lastModified, "Cache-Control": headers["Cache-Control"] },
		});
	}
	if (TEXT.test(type) && st.size > 1024 && /\bgzip\b/.test(req.headers.get("accept-encoding") || "")) {
		const body = await gzipped(file, st);
		headers["Content-Encoding"] = "gzip";
		headers["Content-Length"] = String(body.length);
		headers.Vary = "Accept-Encoding";
		if (req.method === "HEAD") {
			return new Response(null, { status: 200, headers });
		}
		return new Response(body, { status: 200, headers });
	}
	headers["Content-Length"] = String(st.size);
	if (req.method === "HEAD") {
		return new Response(null, { status: 200, headers });
	}
	return new Response(Bun.file(file), { status: 200, headers });
}

const gzCache = new Map<string, { mtime: number; body: Uint8Array }>();
async function gzipped(file: string, st: Stats): Promise<Uint8Array> {
	const hit = gzCache.get(file);
	if (hit && hit.mtime === st.mtimeMs) return hit.body;
	const body = Bun.gzipSync(await Bun.file(file).arrayBuffer());
	gzCache.set(file, { mtime: st.mtimeMs, body });
	return body;
}

function notModified(req: Request, etag: string, mtime: Date): boolean {
	const inm = req.headers.get("if-none-match");
	const strip = (t: string) => t.trim().replace(/^W\//, "");
	if (inm) return inm.trim() === "*" || inm.split(",").some((t) => strip(t) === strip(etag));
	const ims = req.headers.get("if-modified-since");
	if (ims) {
		const since = Date.parse(ims);
		return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since;
	}
	return false;
}

// Ensure client TypeScript bundles are fresh before accepting requests
await buildClient();

const siteFile = await Bun.file(path.join(REPO, "site.json")).json();
const mediaUrl = String(process.env.MEDIA_URL || siteFile.mediaUrl || "https://atlas-media.verticordia.com").replace(
	/\/+$/,
	"",
);
const DEBUG = args.includes("--debug");
const api = createApi({
	debug: DEBUG,
	root: REPO,
	googleClientId: process.env.GOOGLE_CLIENT_ID || siteFile.googleClientId || null,
	publicUrl: (process.env.PUBLIC_URL || siteFile.url || "").replace(/\/+$/, "") || null,
});

// the tile cache: made tiles (the zooms between the stored ones) are kept on disk. Limits: --tile-cache-max / TILE_CACHE_MAX
// (default 2GB) and --tile-cache-target / TILE_CACHE_TARGET (default 1GB, what an eviction pass shrinks it to).
const tileCache = new TileCache({
	root: path.join(REPO, "cache", "tiles"),
	maxBytes: parseSize(opt("tile-cache-max", process.env.TILE_CACHE_MAX || "")) ?? DEFAULT_MAX_BYTES,
	targetBytes: parseSize(opt("tile-cache-target", process.env.TILE_CACHE_TARGET || "")) ?? DEFAULT_TARGET_BYTES,
	popularity: () => api.gamePopularity(),
});
void tileCache.init().catch((e) => console.error("tile cache:", e));
const tiles = createTileService({
	publicDir: PUBLIC,
	cache: tileCache,
	tilesets: async (game) => {
		const g = (await games()).find((x) => x.slug === game);
		return g ? g.maps.flatMap((m) => m.tilesets || []) : null;
	},
	onNewMap: (game) => api.recordGameRequest(game),
});

const server = Bun.serve({
	port: PORT,
	hostname: HOST,
	async fetch(req, bunServer) {
		const url = new URL(req.url);
		if (url.pathname === "/api/ws") {
			const rejected = api.upgrade(req, bunServer);
			if (rejected) return rejected;
			return;
		}

		try {
			const parsed = parseUrl(req.url);
			if (!parsed) return send(400, "bad request");
			const { url: reqUrl, pathname: p } = parsed;
			const offlinePack = /^\/api\/maps\/([^/]+)\/([^/]+)\/offline-pack$/.exec(p);
			if (offlinePack) {
				if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed");
				// Offline packs may take several minutes to prepare on a cold cache; disable request idle timeout
				bunServer?.timeout?.(req, 0);
				return await streamOfflinePack(
					req,
					PUBLIC,
					path.join(REPO, "cache", "tiles"),
					offlinePack[1],
					offlinePack[2],
				);
			}

			if (p.startsWith("/api/")) {
				const res = await api.handle(req, reqUrl);
				if (!res) {
					return send(404, '{"error":"not found"}', "application/json; charset=utf-8", {
						"Cache-Control": "no-store",
					});
				}
				return res;
			}

			if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed");

			const card = /^\/cards\/share\/([^/]+)\/([^/]+)\/(\d+)\.jpg$/.exec(p);
			if (card) return await shareCard(req, card[1], card[2], Number(card[3]));

			const tmCard = /^\/cards\/tm\/([^/]+)\.jpg$/.exec(p);
			if (tmCard) return await sharedMarkerCard(req, tmCard[1], reqUrl.searchParams.get("tm") || "");

			const page = /^\/maps\/([^/]+)(?:\/|\/index\.html)?$/.exec(p);
			if (page && page[1] !== "index.json" && page[1] !== "map.html") {
				const gameList = await games();
				const match = gameList.find((x) => x.slug === page[1]);
				if (match) {
					if (!p.endsWith("/") && !p.endsWith("/index.html")) {
						return new Response(null, {
							status: 301,
							headers: { Location: `/maps/${encodeURI(page[1])}/${reqUrl.search}` },
						});
					}
					const tm = reqUrl.searchParams.get("tm");
					if (tm) {
						const res = await sharedMarkerPage(req, page[1], tm);
						if (res) return res;
					}
					const loc = reqUrl.searchParams.get("loc");
					if (loc && /^\d+$/.test(loc)) {
						const map = reqUrl.searchParams.get("map") || "";
						const res = await sharePage(req, page[1], map, Number(loc));
						if (res) return res;
					}
					return await gamePage(req, page[1]);
				}
			}

			const tile = /^\/maps\/([^/]+)\/([^/]+)\/tiles\/([^/]+)\/(.+)$/.exec(p);
			if (tile) {
				const tileRes = await tiles.serve(req, tile[1], tile[2], tile[3], tile[4]);
				if (tileRes) return tileRes;
			}

			const mediaMatch = /^\/maps\/([^/]+)\/media\/([^/]+)$/.exec(p);
			if (mediaMatch && mediaUrl && api.hasMedia(mediaMatch[1], mediaMatch[2])) {
				return new Response(null, {
					status: 308,
					headers: {
						Location: `${mediaUrl}/v1/${encodeURIComponent(mediaMatch[1])}/${encodeURIComponent(mediaMatch[2])}`,
						"Cache-Control": "public, max-age=31536000, immutable",
					},
				});
			}

			return await serveStatic(req, p, reqUrl.search);
		} catch (e) {
			console.error(e);
			return send(500, "server error");
		}
	},
	websocket: api.websocket,
});

console.log(`Verticordia Atlas on http://${HOST}:${PORT}/`);