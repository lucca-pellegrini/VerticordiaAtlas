#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// prune-tiles.ts: make the tiles of the games already in public/maps/ fit the tile strategy (see server/tile-service.ts).
//
//   bun scripts/prune-tiles.ts [game ...] [--dry-run] [--no-prune] [--out public/maps] [--concurrency 8]
//
// For every tile set of every game (or just the games named):
//   1. a tile that is a single colour (the black or grey outside a map) becomes a hard link to one stored copy of that
//      colour, so such tiles take no space; the colour most used is saved as the tile set's "background" in meta.json
//   2. the overview (the lowest zoom of the tile set) is made from the highest zoom, if it is missing
//   3. the zooms between are deleted where the server can make them again, that is, where all four tiles of the next
//      zoom exist, down to the highest one. A tile with a gap below it (the map is not a perfect rectangle) is kept, and
//      so is every tile of a map whose highest zoom is missing.
// --no-prune skips step 3; --dry-run only reports what would be done.

import { readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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
			if (t.size <= 8192) key = solidKey(await decodeTile(await readFile(t.file)));
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

	// 2. the overview, from the highest zoom
	const have = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
	if (maxZ > minZ) {
		const wanted = new Map<string, [number, number]>();
		const deepest = Math.max(...tiles.map((t) => t.z));
		for (const t of tiles.filter((t) => t.z === deepest)) {
			const s = deepest - minZ;
			const x = t.x >> s,
				y = t.y >> s;
			if (!have.has(`${minZ}/${x}/${y}`)) wanted.set(`${x},${y}`, [x, y]);
		}
		const bg = parseBackground(o.background ?? r.background);
		await pool([...wanted.values()], Math.min(conc, 4), async ([x, y]) => {
			const raw = await deriveRaw(minZ, x, y, {
				maxZoom: deepest,
				background: bg,
				read: (z, tx, ty) => readFile(path.join(dir, tilePath(tail, z, tx, ty))).catch(() => null),
			});
			if (!raw) return;
			r.overview++;
			o.onProgress?.({ phase: "overview", overview: r.overview });
			if (o.dryRun) return;
			const sk = solidKey(raw);
			await placeTile(
				path.join(dir, tilePath(tail, minZ, x, y)),
				await encodeTile(raw, tail.ext),
				sk ? { key: sk, dir, ext: tail.ext } : null,
			);
		});
	}

	// 3. the zooms between, where they can be made again
	if (o.prune !== false && maxZ - minZ > 1) {
		tiles = o.dryRun ? tiles : await listTiles(dir, tail);
		const full = fullyCovered(tiles, minZ, maxZ);
		const doomed = tiles.filter((t) => t.z > minZ && t.z < maxZ && full.get(t.z)?.has(`${t.x},${t.y}`));
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
			out: { type: "string", default: path.join(REPO, "public", "maps") },
			"dry-run": { type: "boolean", default: false },
			"no-prune": { type: "boolean", default: false },
			"no-tui": { type: "boolean", default: false },
			concurrency: { type: "string", default: "8" },
		},
	});
	const root = v.out!;
	const games = positionals.length
		? positionals
		: (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

	// Pre-count tilesets for accurate progress tracking
	const tasks: { game: string; metaFile: string; meta: GameMeta; map: any; ts: any; dir: string; split: any }[] = [];
	for (const game of games) {
		const metaFile = path.join(root, game, "meta.json");
		try {
			const meta: GameMeta = JSON.parse(await readFile(metaFile, "utf8"));
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
		await writeFile(file, JSON.stringify(meta, null, 2) + "\n");
	}

	await dashboard.finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}