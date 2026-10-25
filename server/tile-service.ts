// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// tile-service.ts: answers a tile request. Order: the stored tile in public/maps (the highest zoom, the overview, and any
// tile of an older full download) -> the disk cache -> make it from the four tiles of the next zoom, cache it, serve it.
// The cache is always asked first; a tile is only made on a miss.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { TilesetMeta } from "../src/shared/types.ts";
import type { TileCache } from "./tile-cache.ts";
import {
	contentType,
	deriveRaw,
	encodeTile,
	parseBackground,
	parseTilePath,
	placeTile,
	solidKey,
	splitTemplate,
	tileInBounds,
	tilePath,
} from "./tile-engine.ts";
import type { Raw } from "./tile-engine.ts";

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
const MAX_DEPTH = 6; // zooms below the stored one a request may reach: at most 4^6 tiles are read to make one
const MAKERS = 4; // tiles being made at once
const REMEMBER_MISSING = 10 * 60 * 1000;
const NEW_MAP_AFTER = 6 * 3600 * 1000; // a map not asked for in this long counts as newly requested

export interface TileServiceOptions {
	publicDir: string;
	cache: TileCache;
	tilesets: (game: string) => Promise<TilesetMeta[] | null>; // the tile sets of a game (meta.json)
	onNewMap?: (game: string, map: string) => void; // a map of a game is newly requested (popularity)
	now?: () => number;
}

export interface FoundTile {
	file: string;
	ext: string;
	from: "stored" | "cache" | "made";
}

const exists = (p: string): Promise<boolean> =>
	stat(p).then(
		(s) => s.isFile(),
		() => false,
	);
const readOrNull = (p: string): Promise<Buffer | null> => readFile(p).catch(() => null);

export function createTileService(o: TileServiceOptions) {
	const now = o.now ?? Date.now;
	const recentMaps = new Map<string, number>();
	const missing = new Map<string, number>();
	const making = new Map<string, Promise<FoundTile | null>>();
	let active = 0;
	const waiting: (() => void)[] = [];
	const takeSlot = (): Promise<void> =>
		new Promise((res) => {
			if (active < MAKERS) {
				active++;
				res();
			} else waiting.push(res);
		});
	const freeSlot = (): void => {
		const next = waiting.shift();
		if (next) next();
		else active--;
	};

	function noteMap(game: string, map: string): void {
		const key = `${game}/${map}`,
			t = now();
		const last = recentMaps.get(key);
		if (last !== undefined && t - last < NEW_MAP_AFTER) return;
		if (recentMaps.size > 5000) recentMaps.clear();
		recentMaps.set(key, t);
		o.onNewMap?.(game, map);
	}

	async function make(
		game: string,
		mapDir: string,
		key: string,
		base: string,
		ts: TilesetMeta,
		rel: string,
		c: { z: number; x: number; y: number },
	): Promise<FoundTile | null> {
		const split = splitTemplate(ts.template)!;
		const ext = split.tail.ext;
		const cacheDir = `${game}/${mapDir}/${key}`;
		const publicTiles = path.join(o.publicDir, "maps", game, base);
		const readTile = async (z: number, x: number, y: number): Promise<Buffer | null> => {
			const r = tilePath(split.tail, z, x, y);
			return (
				(await readOrNull(path.join(publicTiles, r))) ?? (await readOrNull(o.cache.file(`${cacheDir}/${r}`)))
			);
		};
		const save = async (z: number, x: number, y: number, raw: Raw): Promise<string> => {
			const r = `${cacheDir}/${tilePath(split.tail, z, x, y)}`;
			const buf = await encodeTile(raw, ext);
			const sk = solidKey(raw);
			await placeTile(o.cache.file(r), buf, sk ? { key: sk, dir: o.cache.file(cacheDir), ext } : null);
			await o.cache.added(r, sk ? 0 : buf.length);
			return r;
		};
		await takeSlot();
		try {
			const raw = await deriveRaw(c.z, c.x, c.y, {
				maxZoom: ts.maxzoom ?? c.z,
				read: readTile,
				background: parseBackground(ts.background),
				store: async (z, x, y, r) => void (await save(z, x, y, r)),
			});
			if (!raw) {
				if (missing.size > 100_000) missing.clear();
				missing.set(rel, now());
				return null;
			}
			await save(c.z, c.x, c.y, raw);
			return { file: o.cache.file(`${cacheDir}/${tilePath(split.tail, c.z, c.x, c.y)}`), ext, from: "made" };
		} finally {
			freeSlot();
		}
	}

	// the file that answers /maps/<game>/<mapDir>/tiles/<key>/<rest>, or null when there is no such tile
	async function find(game: string, mapDir: string, key: string, rest: string): Promise<FoundTile | null> {
		if (![game, mapDir, key].every((s) => SEGMENT.test(s))) return null;
		const sets = await o.tilesets(game);
		if (!sets) return null;
		const base = `${mapDir}/tiles/${key}/`;
		const ts = sets.find((s) => splitTemplate(s.template)?.base === base);
		if (!ts) return null;
		const split = splitTemplate(ts.template)!;
		const c = parseTilePath(split.tail, rest);
		if (!c) return null;
		noteMap(game, mapDir);

		const stored = path.join(o.publicDir, "maps", game, base, tilePath(split.tail, c.z, c.x, c.y));
		if (await exists(stored)) return { file: stored, ext: split.tail.ext, from: "stored" };

		const minZ = ts.minzoom ?? 0,
			maxZ = ts.maxzoom ?? c.z;
		if (c.z < minZ || c.z >= maxZ || maxZ - c.z > MAX_DEPTH) return null;
		if (!tileInBounds(ts.bounds, c.z, c.x, c.y)) return null;

		const rel = `${game}/${mapDir}/${key}/${tilePath(split.tail, c.z, c.x, c.y)}`;
		const cached = o.cache.file(rel);
		if (await exists(cached)) {
			o.cache.touch(rel);
			return { file: cached, ext: split.tail.ext, from: "cache" };
		}
		const gone = missing.get(rel);
		if (gone !== undefined && now() - gone < REMEMBER_MISSING) return null;
		let job = making.get(rel);
		if (!job) {
			job = make(game, mapDir, key, base, ts, rel, c).finally(() => making.delete(rel));
			making.set(rel, job);
		}
		return job;
	}

	async function serve(
		req: IncomingMessage,
		res: ServerResponse,
		game: string,
		mapDir: string,
		key: string,
		rest: string,
	): Promise<boolean> {
		const found = await find(game, mapDir, key, rest);
		if (!found) return false;
		const st = await stat(found.file);
		const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
		const headers = {
			"Content-Type": contentType(found.ext),
			ETag: etag,
			"Last-Modified": st.mtime.toUTCString(),
			"Cache-Control": "public, max-age=3600",
		};
		const inm = req.headers["if-none-match"];
		if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""))) {
			res.writeHead(304, headers);
			res.end();
			return true;
		}
		res.writeHead(200, { ...headers, "Content-Length": st.size });
		if (req.method === "HEAD") res.end();
		else createReadStream(found.file).pipe(res);
		return true;
	}

	return { find, serve };
}