// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// server/offline-pack.ts: streams a complete map package (metadata, markers, icons, tiles)
// in a single streaming binary pack (VAOP format) for offline storage.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createRateLimiter, type RateLimiter, resolveClientIp } from "./rate-limit.ts";
import {
	deriveRaw,
	encodeTile,
	listTiles,
	parseBackground,
	placeTile,
	solidKey,
	splitTemplate,
	tilePath,
} from "./tile-engine.ts";

export const VAOP_MAGIC = "VAOP";
export const VAOP_VERSION = 1;

export const PACK_SLUG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;

export function isValidPackSlug(slug: unknown): slug is string {
	return typeof slug === "string" && slug !== "." && slug !== ".." && PACK_SLUG_RE.test(slug);
}

function isContainedWithin(childPath: string, parentDir: string): boolean {
	const resolvedParent = path.resolve(parentDir);
	const resolvedChild = path.resolve(childPath);
	return resolvedChild.startsWith(resolvedParent + path.sep);
}

export interface PackItem {
	file: string;
	url: string; // root-relative URL starting with /maps/...
	contentType: string;
	size: number;
	ino: number;
}

function mimeFor(file: string): string {
	const ext = path.extname(file).toLowerCase();
	switch (ext) {
		case ".json":
			return "application/json";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".svg":
			return "image/svg+xml";
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		default:
			return "application/octet-stream";
	}
}

async function walkDir(
	dir: string,
	onFile: (filePath: string, st: { size: number; ino: number }) => void,
): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walkDir(full, onFile);
			} else if (entry.isFile()) {
				const st = await stat(full).catch(() => null);
				if (st) onFile(full, { size: st.size, ino: st.ino });
			}
		}
	} catch {
		/* directory missing */
	}
}

export async function collectMapPackItems(
	publicDir: string,
	cacheDir: string,
	gameSlug: string,
	mapSlug: string,
): Promise<PackItem[] | null> {
	if (!isValidPackSlug(gameSlug) || !isValidPackSlug(mapSlug)) return null;

	const mapsDir = path.resolve(publicDir, "maps");
	const gameDir = path.resolve(mapsDir, gameSlug);
	const mapDir = path.resolve(gameDir, mapSlug);
	const resolvedCacheRoot = path.resolve(cacheDir);
	const cachedTilesDir = path.resolve(resolvedCacheRoot, gameSlug, mapSlug);

	if (
		!isContainedWithin(gameDir, mapsDir) ||
		!isContainedWithin(mapDir, gameDir) ||
		!isContainedWithin(cachedTilesDir, resolvedCacheRoot)
	) {
		return null;
	}

	const mapStat = await stat(mapDir).catch(() => null);
	if (!mapStat || !mapStat.isDirectory()) return null;

	const items: PackItem[] = [];
	const seenUrls = new Set<string>();

	const addItem = (filePath: string, urlPath: string, size: number, ino: number) => {
		const normUrl = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
		if (seenUrls.has(normUrl)) return;
		seenUrls.add(normUrl);
		items.push({
			file: filePath,
			url: normUrl,
			contentType: mimeFor(filePath),
			size,
			ino,
		});
	};

	// 1. meta.json
	const metaFile = path.join(gameDir, "meta.json");
	const metaStat = await stat(metaFile).catch(() => null);
	if (metaStat?.isFile()) {
		addItem(metaFile, `/maps/${gameSlug}/meta.json`, metaStat.size, metaStat.ino);
	}

	// 2. data.json
	const dataFile = path.join(mapDir, "data.json");
	const dataStat = await stat(dataFile).catch(() => null);
	if (dataStat?.isFile()) {
		addItem(dataFile, `/maps/${gameSlug}/${mapSlug}/data.json`, dataStat.size, dataStat.ino);
	}

	// 3. marker sprite assets
	for (const m of ["markers.json", "markers@2x.json", "markers.png", "markers@2x.png"]) {
		const mf = path.join(gameDir, m);
		const mst = await stat(mf).catch(() => null);
		if (mst?.isFile()) addItem(mf, `/maps/${gameSlug}/${m}`, mst.size, mst.ino);
	}

	// 4. icons/ assets
	const iconsDir = path.join(gameDir, "icons");
	await walkDir(iconsDir, (filePath, st) => {
		const rel = path.relative(mapsDir, filePath).split(path.sep).join("/");
		addItem(filePath, `/maps/${rel}`, st.size, st.ino);
	});

	// 5. tiles/ in public/maps/<game>/<map>/tiles/
	const tilesDir = path.join(mapDir, "tiles");
	await walkDir(tilesDir, (filePath, st) => {
		const rel = path.relative(mapsDir, filePath).split(path.sep).join("/");
		addItem(filePath, `/maps/${rel}`, st.size, st.ino);
	});

	// 6. cached tiles in cache/tiles/<game>/<map>/ (if any)
	await walkDir(cachedTilesDir, (filePath, st) => {
		const rel = path.relative(cachedTilesDir, filePath).split(path.sep).join("/");
		const normUrl = `/maps/${gameSlug}/${mapSlug}/tiles/${rel}`;
		addItem(filePath, normUrl, st.size, st.ino);
	});

	return items;
}

export async function ensureIntermediateTiles(
	publicDir: string,
	cacheDir: string,
	gameSlug: string,
	mapSlug: string,
): Promise<void> {
	if (!isValidPackSlug(gameSlug) || !isValidPackSlug(mapSlug)) return;
	const mapsDir = path.resolve(publicDir, "maps");
	const gameDir = path.resolve(mapsDir, gameSlug);
	const mapDir = path.resolve(gameDir, mapSlug);
	const resolvedCacheRoot = path.resolve(cacheDir);
	const mapCacheDir = path.resolve(resolvedCacheRoot, gameSlug, mapSlug);
	if (
		!isContainedWithin(gameDir, mapsDir) ||
		!isContainedWithin(mapDir, gameDir) ||
		!isContainedWithin(mapCacheDir, resolvedCacheRoot)
	) {
		return;
	}

	const metaPath = path.join(gameDir, "meta.json");
	const meta = await readFile(metaPath, "utf8")
		.then(JSON.parse)
		.catch(() => null);
	if (!meta) return;
	const mapMeta = meta.maps?.find((m: any) => m.slug === mapSlug);
	if (!mapMeta?.tilesets?.length) return;

	for (const ts of mapMeta.tilesets) {
		const split = splitTemplate(ts.template);
		if (!split) continue;
		const tail = split.tail;
		const key = path.basename(split.base.replace(/\/+$/, ""));
		if (!isValidPackSlug(key)) continue;
		const publicTilesDir = path.resolve(gameDir, split.base);
		const cacheTilesDir = path.resolve(mapCacheDir, key);
		if (!isContainedWithin(publicTilesDir, gameDir) || !isContainedWithin(cacheTilesDir, mapCacheDir)) {
			continue;
		}
		const minZ = ts.minzoom ?? 0;
		const maxZ = ts.maxzoom ?? 18;
		if (maxZ <= minZ) continue;

		const publicTiles = await listTiles(publicTilesDir, tail);
		const cacheTiles = await listTiles(cacheTilesDir, tail);
		const allTiles = [...publicTiles, ...cacheTiles];
		if (!allTiles.length) continue;

		const have = new Set(allTiles.map((t) => `${t.z}/${t.x}/${t.y}`));
		const deepest = Math.max(...allTiles.map((t) => t.z));
		let currentZ = new Set(allTiles.filter((t) => t.z === deepest).map((t) => `${t.x},${t.y}`));

		const readTile = async (rz: number, rx: number, ry: number): Promise<Buffer | null> => {
			const p1 = path.join(publicTilesDir, tilePath(tail, rz, rx, ry));
			const b1 = await readFile(p1).catch(() => null);
			if (b1) return b1;
			const p2 = path.join(cacheTilesDir, tilePath(tail, rz, rx, ry));
			return readFile(p2).catch(() => null);
		};

		const bg = parseBackground(ts.background);

		for (let z = deepest - 1; z >= minZ; z--) {
			const needed = new Set<string>();
			for (const k of currentZ) {
				const [x, y] = k.split(",").map(Number);
				needed.add(`${x >> 1},${y >> 1}`);
			}
			const missing: [number, number][] = [];
			for (const k of needed) {
				const [x, y] = k.split(",").map(Number);
				if (!have.has(`${z}/${x}/${y}`)) missing.push([x, y]);
			}
			if (missing.length > 0) {
				let idx = 0;
				await Promise.all(
					Array.from({ length: 8 }, async () => {
						while (idx < missing.length) {
							const item = missing[idx++];
							if (!item) break;
							const [x, y] = item;
							const raw = await deriveRaw(z, x, y, { maxZoom: deepest, background: bg, read: readTile });
							if (raw) {
								const sk = solidKey(raw);
								const buf = await encodeTile(raw, tail.ext);
								const target = path.join(cacheTilesDir, tilePath(tail, z, x, y));
								await placeTile(
									target,
									buf,
									sk ? { key: sk, dir: cacheTilesDir, ext: tail.ext } : null,
								);
								have.add(`${z}/${x}/${y}`);
							}
						}
					}),
				);
			}
			currentZ = needed;
		}
	}
}

const preparing = new Map<string, Promise<void>>();

export const DEFAULT_PACK_RATE_MAX = 30;
export const DEFAULT_PACK_RATE_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_PACK_MAX_CONCURRENT = 3;

const defaultPackLimiter = createRateLimiter();

export interface OfflinePackLimiterState {
	active: number;
}

const defaultConcurrencyState: OfflinePackLimiterState = { active: 0 };

export interface StreamOfflinePackOptions {
	clientIp?: string;
	trustProxy?: boolean;
	remoteAddress?: string | null;
	rateLimiter?: RateLimiter;
	maxPerWindow?: number;
	windowMs?: number;
	maxConcurrent?: number;
	concurrencyState?: OfflinePackLimiterState;
	prepareFn?: (publicDir: string, cacheDir: string, gameSlug: string, mapSlug: string) => Promise<void>;
}

export async function streamOfflinePack(
	req: Request,
	publicDir: string,
	cacheDir: string,
	gameSlug: string,
	mapSlug: string,
	opts: StreamOfflinePackOptions = {},
): Promise<Response> {
	if (!isValidPackSlug(gameSlug) || !isValidPackSlug(mapSlug)) {
		return new Response(JSON.stringify({ error: "Invalid map slug" }), {
			status: 400,
			headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
		});
	}

	const mapsDir = path.resolve(publicDir, "maps");
	const gameDir = path.resolve(mapsDir, gameSlug);
	const mapDir = path.resolve(gameDir, mapSlug);
	const resolvedCacheRoot = path.resolve(cacheDir);
	const cachedTilesDir = path.resolve(resolvedCacheRoot, gameSlug, mapSlug);

	if (
		!isContainedWithin(gameDir, mapsDir) ||
		!isContainedWithin(mapDir, gameDir) ||
		!isContainedWithin(cachedTilesDir, resolvedCacheRoot)
	) {
		return new Response(JSON.stringify({ error: "Invalid map path" }), {
			status: 400,
			headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
		});
	}

	const limiter = opts.rateLimiter ?? defaultPackLimiter;
	const maxPerWindow = opts.maxPerWindow ?? DEFAULT_PACK_RATE_MAX;
	const windowMs = opts.windowMs ?? DEFAULT_PACK_RATE_WINDOW_MS;
	const ip = opts.clientIp ?? resolveClientIp(req, Boolean(opts.trustProxy), opts.remoteAddress);

	if (!limiter.allow("offline-pack:ip", ip, maxPerWindow, windowMs)) {
		const retryAfter = limiter.retryAfterSeconds("offline-pack:ip", ip, windowMs);
		return new Response(JSON.stringify({ error: "Too many offline pack requests. Please try again later." }), {
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"Retry-After": String(retryAfter),
			},
		});
	}

	const maxConcurrent = opts.maxConcurrent ?? DEFAULT_PACK_MAX_CONCURRENT;
	const conc = opts.concurrencyState ?? defaultConcurrencyState;
	if (conc.active >= maxConcurrent) {
		return new Response(JSON.stringify({ error: "Offline pack builder is busy. Please retry shortly." }), {
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"Retry-After": "5",
			},
		});
	}

	conc.active++;
	let slotReleased = false;
	const releaseSlot = () => {
		if (!slotReleased) {
			slotReleased = true;
			conc.active = Math.max(0, conc.active - 1);
		}
	};

	try {
		// the response starts once the tiles exist (the page shows "Preparing"); two requests for one map share the work
		const prepareImpl = opts.prepareFn ?? ensureIntermediateTiles;
		const key = `${gameSlug}/${mapSlug}`;
		let work = opts.prepareFn ? undefined : preparing.get(key);
		if (!work) {
			work = prepareImpl(publicDir, cacheDir, gameSlug, mapSlug)
				.catch(() => {})
				.finally(() => {
					if (!opts.prepareFn) preparing.delete(key);
				});
			if (!opts.prepareFn) preparing.set(key, work);
		}
		await work;
		const items = await collectMapPackItems(publicDir, cacheDir, gameSlug, mapSlug);
		if (!items) {
			releaseSlot();
			return new Response(JSON.stringify({ error: `Map ${gameSlug}/${mapSlug} not found` }), {
				status: 404,
				headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
			});
		}

		// Calculate total uncompressed payload bytes (file bytes + headers)
		const seenInos = new Map<number, string>();
		let totalBytes = 0;
		for (const item of items) {
			if (seenInos.has(item.ino)) {
				// Type 1: [1 byte type] + [2 bytes targetUrlLen] + targetUrl + [2 bytes srcUrlLen] + srcUrl + [1 byte mimeLen] + mime
				const src = seenInos.get(item.ino)!;
				totalBytes +=
					1 +
					2 +
					Buffer.byteLength(item.url) +
					2 +
					Buffer.byteLength(src) +
					1 +
					Buffer.byteLength(item.contentType);
			} else {
				seenInos.set(item.ino, item.url);
				// Type 0: [1 byte type] + [2 bytes urlLen] + url + [1 byte mimeLen] + mime + [4 bytes size] + item.size
				totalBytes +=
					1 + 2 + Buffer.byteLength(item.url) + 1 + Buffer.byteLength(item.contentType) + 4 + item.size;
			}
		}
		seenInos.clear();

		const headers = {
			"Content-Type": "application/octet-stream",
			"Cache-Control": "no-store",
			"X-VA-Total-Entries": String(items.length),
			"X-VA-Total-Bytes": String(totalBytes),
		};

		if (req.method === "HEAD") {
			releaseSlot();
			return new Response(null, { status: 200, headers });
		}

		// Write 17-byte header:
		// "VAOP" (4 bytes) | Version (1 byte) | Total Entries (4 bytes BE) | Total Bytes (8 bytes BE)
		const hdr = Buffer.alloc(17);
		hdr.write(VAOP_MAGIC, 0, 4, "ascii");
		hdr.writeUInt8(VAOP_VERSION, 4);
		hdr.writeUInt32BE(items.length, 5);
		hdr.writeBigUInt64BE(BigInt(totalBytes), 9);

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					controller.enqueue(new Uint8Array(hdr.buffer, hdr.byteOffset, hdr.byteLength));

					// Stream entries
					for (const item of items) {
						const prevUrl = seenInos.get(item.ino);
						if (prevUrl !== undefined) {
							// Type 1 (Alias)
							const targetUrlBuf = Buffer.from(item.url, "utf8");
							const srcUrlBuf = Buffer.from(prevUrl, "utf8");
							const mimeBuf = Buffer.from(item.contentType, "utf8");

							const entryHdr = Buffer.alloc(
								1 + 2 + targetUrlBuf.length + 2 + srcUrlBuf.length + 1 + mimeBuf.length,
							);
							let off = 0;
							entryHdr.writeUInt8(1, off);
							off += 1;
							entryHdr.writeUInt16BE(targetUrlBuf.length, off);
							off += 2;
							targetUrlBuf.copy(entryHdr, off);
							off += targetUrlBuf.length;
							entryHdr.writeUInt16BE(srcUrlBuf.length, off);
							off += 2;
							srcUrlBuf.copy(entryHdr, off);
							off += srcUrlBuf.length;
							entryHdr.writeUInt8(mimeBuf.length, off);
							off += 1;
							mimeBuf.copy(entryHdr, off);

							controller.enqueue(
								new Uint8Array(entryHdr.buffer, entryHdr.byteOffset, entryHdr.byteLength),
							);
						} else {
							// Type 0 (Full file)
							seenInos.set(item.ino, item.url);
							const urlBuf = Buffer.from(item.url, "utf8");
							const mimeBuf = Buffer.from(item.contentType, "utf8");

							const entryHdr = Buffer.alloc(1 + 2 + urlBuf.length + 1 + mimeBuf.length + 4);
							let off = 0;
							entryHdr.writeUInt8(0, off);
							off += 1;
							entryHdr.writeUInt16BE(urlBuf.length, off);
							off += 2;
							urlBuf.copy(entryHdr, off);
							off += urlBuf.length;
							entryHdr.writeUInt8(mimeBuf.length, off);
							off += 1;
							mimeBuf.copy(entryHdr, off);
							off += mimeBuf.length;
							entryHdr.writeUInt32BE(item.size, off);

							controller.enqueue(
								new Uint8Array(entryHdr.buffer, entryHdr.byteOffset, entryHdr.byteLength),
							);

							if (item.size > 0) {
								const reader = Bun.file(item.file).stream().getReader();
								try {
									while (true) {
										const { done, value } = await reader.read();
										if (done) break;
										if (value) controller.enqueue(value);
									}
								} finally {
									reader.releaseLock();
								}
							}
						}
					}

					controller.close();
				} finally {
					releaseSlot();
				}
			},
			cancel() {
				releaseSlot();
			},
		});

		return new Response(stream, { status: 200, headers });
	} catch (e) {
		releaseSlot();
		throw e;
	}
}