// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// server/offline-pack.ts: streams a complete map package (metadata, markers, icons, tiles)
// in a single streaming binary pack (VAOP format) for offline storage.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

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
	const mapsDir = path.join(publicDir, "maps");
	const gameDir = path.join(mapsDir, gameSlug);
	const mapDir = path.join(gameDir, mapSlug);

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
	const cachedTilesDir = path.join(cacheDir, gameSlug, mapSlug);
	await walkDir(cachedTilesDir, (filePath, st) => {
		const rel = path.relative(cachedTilesDir, filePath).split(path.sep).join("/");
		const normUrl = `/maps/${gameSlug}/${mapSlug}/tiles/${rel}`;
		addItem(filePath, normUrl, st.size, st.ino);
	});

	return items;
}

function pipeFile(file: string, res: ServerResponse): Promise<void> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(file);
		stream.on("error", reject);
		stream.on("end", resolve);
		stream.pipe(res, { end: false });
	});
}

export async function ensureIntermediateTiles(
	publicDir: string,
	cacheDir: string,
	gameSlug: string,
	mapSlug: string,
): Promise<void> {
	const metaPath = path.join(publicDir, "maps", gameSlug, "meta.json");
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
		const publicTilesDir = path.join(publicDir, "maps", gameSlug, split.base);
		const cacheTilesDir = path.join(cacheDir, gameSlug, mapSlug, key);
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

export async function streamOfflinePack(
	req: IncomingMessage,
	res: ServerResponse,
	publicDir: string,
	cacheDir: string,
	gameSlug: string,
	mapSlug: string,
): Promise<boolean> {
	// the response starts once the tiles exist (the page shows "Preparing"); two requests for one map share the work
	const key = `${gameSlug}/${mapSlug}`;
	let work = preparing.get(key);
	if (!work) {
		work = ensureIntermediateTiles(publicDir, cacheDir, gameSlug, mapSlug)
			.catch(() => {})
			.finally(() => preparing.delete(key));
		preparing.set(key, work);
	}
	await work;
	const items = await collectMapPackItems(publicDir, cacheDir, gameSlug, mapSlug);
	if (!items) {
		res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ error: `Map ${gameSlug}/${mapSlug} not found` }));
		return true;
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
			totalBytes += 1 + 2 + Buffer.byteLength(item.url) + 1 + Buffer.byteLength(item.contentType) + 4 + item.size;
		}
	}
	seenInos.clear();

	res.writeHead(200, {
		"Content-Type": "application/octet-stream",
		"Cache-Control": "no-store",
		"X-VA-Total-Entries": String(items.length),
		"X-VA-Total-Bytes": String(totalBytes),
	});

	// Write 17-byte header:
	// "VAOP" (4 bytes) | Version (1 byte) | Total Entries (4 bytes BE) | Total Bytes (8 bytes BE)
	const hdr = Buffer.alloc(17);
	hdr.write(VAOP_MAGIC, 0, 4, "ascii");
	hdr.writeUInt8(VAOP_VERSION, 4);
	hdr.writeUInt32BE(items.length, 5);
	hdr.writeBigUInt64BE(BigInt(totalBytes), 9);
	res.write(hdr);

	// Stream entries
	for (const item of items) {
		if (res.writableEnded || res.destroyed) break;

		const prevUrl = seenInos.get(item.ino);
		if (prevUrl !== undefined) {
			// Type 1 (Alias)
			const targetUrlBuf = Buffer.from(item.url, "utf8");
			const srcUrlBuf = Buffer.from(prevUrl, "utf8");
			const mimeBuf = Buffer.from(item.contentType, "utf8");

			const entryHdr = Buffer.alloc(1 + 2 + targetUrlBuf.length + 2 + srcUrlBuf.length + 1 + mimeBuf.length);
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

			const ok = res.write(entryHdr);
			if (!ok) await new Promise((r) => res.once("drain", r));
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

			const ok = res.write(entryHdr);
			if (!ok) await new Promise((r) => res.once("drain", r));

			if (item.size > 0) {
				await pipeFile(item.file, res);
			}
		}
	}

	res.end();
	return true;
}