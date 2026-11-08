#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// prune-tiles.ts: make the tiles of the games already in public/maps/ fit the tile strategy (see server/tile-service.ts).
//
//   bun scripts/prune-tiles.ts [game ...] [--dry-run] [--no-prune] [--aggressive-prune] [--keep-below-max 3]
//                              [--out public/maps] [--concurrency 8]
//
// For every tile set of every game (or just the games named):
//   1. a tile that is a single colour (the black or grey outside a map) becomes a hard link to one stored copy of that
//      colour, so such tiles take no space; the colour most used is saved as the tile set's "background" in meta.json
//   2. the overview levels (minzoom through maxzoom - 3, the zooms a map is first opened at) are made from the highest
//      zoom, where they are missing: one pass down the pyramid, so no level is ever made from a lossy copy of another
//   3. the zooms between the overview levels and the highest one are deleted where the server can make them again, that
//      is, where all four tiles of the next zoom exist, down to the highest one. A tile with a gap below it (the map is
//      not a perfect rectangle) is kept, and so is every tile of a map whose highest zoom is missing.
// --no-prune skips step 3; --dry-run only reports what would be done (without reading any pixel of a tile above 8 KB).
// --keep-below-max N changes how many zooms below the highest are made on demand (default 3 -> zooms maxzoom-2 and
// maxzoom-1; each costs ~1 s and ~4 s a tile to make). --aggressive-prune is the old behaviour: only minzoom is kept.
//
// Rollback: step 2 only adds tiles (undo: delete the zoom folders minzoom+1 .. maxzoom-3). Step 3 deletes tiles that the
// server remakes on demand (slightly different bytes, as the pixels are shrunk again); an exact restore needs a copy of
// the tile folder or `add-game --force-get-tiles`. Always run with --dry-run first and copy the folder of any map you
// cannot scrape again.

import { readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	decodeTile,
	dedupeSolid,
	deriveRaw,
	encodeTile,
	listTiles,
	parseBackground,
	placeTile,
	solidKey,
	splitTemplate,
	tilePath,
} from "../server/tile-engine.ts";
import type { TileFile, TileTail } from "../server/tile-engine.ts";
import type { GameMeta } from "../src/shared/types.ts";
import { createPruneDashboard, type PruneTilesetEvent } from "./tui/prune-dashboard.js";

export { listTiles };
export type { TileFile };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mb = (n: number): string => (n / 1e6).toFixed(1) + " MB";

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.max(1, n) }, async () => {
			while (i < items.length) await fn(items[i++]);
		}),
	);
}

// the tiles of each zoom from which every tile below, down to the stored zoom, exists
export function fullyCovered(
	tiles: { z: number; x: number; y: number }[],
	minZ: number,
	maxZ: number,
): Map<number, Set<string>> {
	const full = new Map<number, Set<string>>();
	full.set(maxZ, new Set(tiles.filter((t) => t.z === maxZ).map((t) => `${t.x},${t.y}`)));
	for (let z = maxZ - 1; z > minZ; z--) {
		const kids = full.get(z + 1)!,
			here = new Set<string>(),
			seen = new Set<string>();
		for (const k of kids) {
			const [x, y] = k.split(",").map(Number);
			const px = x >> 1,
				py = y >> 1,
				pk = `${px},${py}`;
			if (seen.has(pk)) continue;
			seen.add(pk);
			if ([0, 1].every((dx) => [0, 1].every((dy) => kids.has(`${2 * px + dx},${2 * py + dy}`)))) here.add(pk);
		}
		full.set(z, here);
	}
	return full;
}

export interface OptimizeResult {
	tiles: number;
	solid: number;
	solidFreed: number;
	overview: number;
	pruned: number;
	prunedBytes: number;
	background: string | null;
}

export async function optimizeTileset(o: {
	dir: string;
	tail: TileTail;
	minZ: number;
	maxZ: number;
	prune?: boolean;
	keepBelowMax?: number; // the overview levels are minZ .. maxZ - keepBelowMax (default 3)
	aggressive?: boolean; // the old behaviour: the overview is minZ alone
	dryRun?: boolean;
	background?: string | null;
	concurrency?: number;
	onProgress?: (ev: PruneTilesetEvent) => void;
}): Promise<OptimizeResult> {
	const { dir, tail, minZ, maxZ } = o;
	const conc = o.concurrency ?? 8;
	const r: OptimizeResult = {
		tiles: 0,
		solid: 0,
		solidFreed: 0,
		overview: 0,
		pruned: 0,
		prunedBytes: 0,
		background: null,
	};
	let tiles = await listTiles(dir, tail);
	r.tiles = tiles.length;
	if (!tiles.length) return r;

	// 1. single-colour tiles
	const colours = new Map<string, number>();
	const firstOfColour = new Set<string>();
	await pool(tiles, conc, async (t) => {
		let key: string | null = null;
		if (o.dryRun) {
			if (t.size <= 8192) key = solidKey(await decodeTile(Buffer.from(await Bun.file(t.file).bytes())));
			if (key && firstOfColour.has(key)) r.solidFreed += t.size;
			else if (key) firstOfColour.add(key);
		} else {
			const d = await dedupeSolid(t.file, dir, tail.ext);
			key = d?.key ?? null;
			r.solidFreed += d?.freed ?? 0;
		}
		if (key) {
			r.solid++;
			colours.set(key, (colours.get(key) ?? 0) + 1);
		}
	});
	const top = [...colours.entries()].filter(([k]) => k.endsWith("ff")).sort((a, b) => b[1] - a[1])[0];
	r.background = top ? "#" + top[0].slice(0, 6) : null;
	o.onProgress?.({
		phase: "solid",
		solid: r.solid,
		solidFreed: r.solidFreed,
		topColors: [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
	});

	// 2. the overview levels, from the highest zoom, in one pass down the pyramid
	const have = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
	const deepest = Math.max(...tiles.map((t) => t.z));
	const keepTo = o.aggressive ? minZ : Math.min(Math.max(minZ, maxZ - (o.keepBelowMax ?? 3)), deepest - 1);
	if (keepTo >= minZ) {
		const roots = new Map<string, [number, number]>(); // the overview tiles whose subtree misses a level to keep
		const missing = new Set<string>();
		for (const t of tiles.filter((t) => t.z === deepest)) {
			for (let z = minZ; z <= keepTo; z++) {
				const s = deepest - z;
				const key = `${z}/${t.x >> s}/${t.y >> s}`;
				if (have.has(key)) continue;
				missing.add(key);
				const x = t.x >> (deepest - minZ),
					y = t.y >> (deepest - minZ);
				roots.set(`${x},${y}`, [x, y]);
			}
		}
		if (o.dryRun) r.overview = missing.size;
		const bg = parseBackground(o.background ?? r.background);
		const read = (z: number, tx: number, ty: number) =>
			Bun.file(path.join(dir, tilePath(tail, z, tx, ty)))
				.bytes()
				.then((b) => Buffer.from(b))
				.catch(() => null);
		const put = async (z: number, x: number, y: number, raw: Buffer) => {
			if (have.has(`${z}/${x}/${y}`)) return;
			have.add(`${z}/${x}/${y}`);
			r.overview++;
			o.onProgress?.({ phase: "overview", overview: r.overview });
			const sk = solidKey(raw);
			await placeTile(
				path.join(dir, tilePath(tail, z, x, y)),
				await encodeTile(raw, tail.ext),
				sk ? { key: sk, dir, ext: tail.ext } : null,
			);
		};
		if (!o.dryRun)
			await pool([...roots.values()], Math.min(conc, 4), async ([x, y]) => {
				const raw = await deriveRaw(minZ, x, y, {
					maxZoom: deepest,
					background: bg,
					read,
					store: (z, tx, ty, raw) => (z <= keepTo ? put(z, tx, ty, raw) : Promise.resolve()),
				});
				if (raw) await put(minZ, x, y, raw);
			});
	}

	// 3. the zooms between, where they can be made again
	if (o.prune !== false && maxZ - keepTo > 1) {
		tiles = o.dryRun ? tiles : await listTiles(dir, tail);
		const full = fullyCovered(tiles, minZ, maxZ);
		const doomed = tiles.filter((t) => t.z > keepTo && t.z < maxZ && full.get(t.z)?.has(`${t.x},${t.y}`));
		const parents = new Set<string>();
		await pool(doomed, conc, async (t) => {
			const st = await stat(t.file);
			r.pruned++;
			if (st.nlink === 1) r.prunedBytes += st.size;
			o.onProgress?.({ phase: "prune", pruned: r.pruned, prunedBytes: r.prunedBytes });
			if (o.dryRun) return;
			await unlink(t.file);
			parents.add(path.dirname(t.file));
		});
		// folders left empty
		for (const p of [...parents].sort((a, b) => b.length - a.length)) {
			await rmdir(p).catch(() => {});
			await rmdir(path.dirname(p)).catch(() => {});
		}
	}
	return r;
}

async function main() {
	const { values: v, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			game: { type: "string" },
			out: { type: "string", default: path.join(REPO, "public", "maps") },
			"dry-run": { type: "boolean", default: false },
			"no-prune": { type: "boolean", default: false },
			"aggressive-prune": { type: "boolean", default: false },
			"keep-below-max": { type: "string", default: "3" },
			"no-tui": { type: "boolean", default: false },
			concurrency: { type: "string", default: "8" },
		},
	});
	const root = v.out!;
	if (!/^\d+$/.test(v["keep-below-max"]!)) throw new Error("--keep-below-max takes a whole number");
	const games = v.game
		? [v.game]
		: positionals.length
			? positionals
			: (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

	// Pre-count tilesets for accurate progress tracking
	const tasks: { game: string; metaFile: string; meta: GameMeta; map: any; ts: any; dir: string; split: any }[] = [];
	for (const game of games) {
		const metaFile = path.join(root, game, "meta.json");
		try {
			const meta: GameMeta = await Bun.file(metaFile).json();
			for (const map of meta.maps || []) {
				for (const ts of map.tilesets || []) {
					const split = splitTemplate(ts.template);
					if (split) {
						tasks.push({ game, metaFile, meta, map, ts, dir: path.join(root, game, split.base), split });
					}
				}
			}
		} catch {}
	}

	const dashboard = await createPruneDashboard({
		totalTilesets: tasks.length,
		dryRun: v["dry-run"],
		noTui: v["no-tui"],
	});

	const changedMetaFiles = new Map<string, GameMeta>();
	for (const t of tasks) {
		dashboard.startTileset(t.game, t.ts.name || t.map.slug, 0);
		const r = await optimizeTileset({
			dir: t.dir,
			tail: t.split.tail,
			minZ: t.ts.minzoom ?? 0,
			maxZ: t.ts.maxzoom ?? 0,
			prune: !v["no-prune"],
			aggressive: v["aggressive-prune"],
			keepBelowMax: +v["keep-below-max"]!,
			dryRun: v["dry-run"],
			background: t.ts.background,
			concurrency: +v.concurrency!,
			onProgress: (ev) => dashboard.onProgress(ev),
		});

		dashboard.finishTileset(r);

		if (r.background && !t.ts.background && !v["dry-run"]) {
			t.ts.background = r.background;
			changedMetaFiles.set(t.metaFile, t.meta);
		}
	}

	for (const [file, meta] of changedMetaFiles.entries()) {
		const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
		await Bun.write(tmp, JSON.stringify(meta, null, 2) + "\n");
		await rename(tmp, file);
	}

	await dashboard.finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}