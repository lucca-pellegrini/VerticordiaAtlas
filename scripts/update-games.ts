#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// update-games.ts: Smart game repair and update utility.
//
// Updates game markers and metadata from MapGenie, downloads missing tilesets using known bounds,
// fetches missing media and videos, or performs full atomic tile pyramid redownloads through a staging directory.
//
// Usage:
//   bun scripts/update-games.ts [slug...] [options]
//
// Examples:
//   bun scripts/update-games.ts rdr2 --missing-tilesets
//   bun scripts/update-games.ts totk --media --videos
//   bun scripts/update-games.ts --missing-tilesets --dry-run
//   bun scripts/update-games.ts rdr2 --redownload-tiles
//   bun scripts/update-games.ts --all --missing-tilesets
//
// Options:
//   --all                Process all games found in public/maps/
//   --missing-tilesets   Scan and download any tilesets missing from disk
//   --redownload-tiles   Fully redownload all tiles for specified games (atomic via cache/updates/)
//   --media              Download missing media (images) to public/maps/<slug>/media/
//   --videos             Include video media (IGN/YouTube/mp4) when downloading media
//   --data-only          Refresh and clean markers/categories from source without touching tiles or poster
//   --dry-run            Scan and print update plan without downloading or mutating files
//   --concurrency <n>    Parallel network requests (default: 4)
//   --delay <ms>         Rate-limiting delay between requests (default: 50)
//   --max-tiles <n>      Tile limit safety cap (default: 400000)
//   --maps-dir <dir>     Root directory for games (default: ./public/maps)
//   --cache-dir <dir>    Staging root for atomic downloads (default: ./cache/updates)

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { splitTemplate } from "../server/tile-engine.ts";
import { boundsFor, collectMedia, downloadMedia, downloadTiles } from "./add-game.ts";
import { optimizeTileset } from "./prune-tiles.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exists = async (p: string) => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};
const mb = (n: number) => (n / 1e6).toFixed(1) + " MB";

export interface GameInfo {
	folder: string;
	gameDir: string;
	meta: any;
	indexEntry?: any;
}

export interface MissingTilesetItem {
	mapSlug: string;
	data: any;
	ts: any;
	key: string;
	localTail: string;
	destDir: string;
}

export function tilesetKey(ts: any): string {
	const segs = (ts.path || "").split("/").filter(Boolean);
	if (segs.length) return segs[segs.length - 1];
	const pattern = ts.pattern || "";
	if (pattern.includes("{")) {
		const prefix = pattern.slice(0, pattern.indexOf("{")).replace(/\/+$/, "");
		const pSegs = prefix.split("/").filter(Boolean);
		if (pSegs.length) return pSegs[pSegs.length - 1];
	}
	return `ts${ts.id}`;
}

export function tilesetTail(ts: any): string {
	const pattern = ts.pattern || "";
	if (pattern.includes("{")) {
		return pattern.slice(pattern.indexOf("{"));
	}
	return `{z}/{x}/{y}.${ts.extension || "jpg"}`;
}

export async function resolveGames(slugArgs: string[], all: boolean, mapsDir: string): Promise<GameInfo[]> {
	const list: GameInfo[] = [];
	const indexPath = path.join(mapsDir, "index.json");
	let indexGames: any[] = [];
	if (await exists(indexPath)) {
		try {
			indexGames = JSON.parse(await readFile(indexPath, "utf8")).games || [];
		} catch {}
	}

	if (all || (!slugArgs.length && !all)) {
		const entries = await readdir(mapsDir, { withFileTypes: true });
		for (const ent of entries) {
			if (!ent.isDirectory()) continue;
			const gameDir = path.join(mapsDir, ent.name);
			const metaPath = path.join(gameDir, "meta.json");
			if (await exists(metaPath)) {
				try {
					const meta = JSON.parse(await readFile(metaPath, "utf8"));
					const indexEntry = indexGames.find((g) => g.slug === ent.name || g.id === meta.id);
					list.push({ folder: ent.name, gameDir, meta, indexEntry });
				} catch {}
			}
		}
	}

	if (slugArgs.length) {
		const picked: GameInfo[] = [];
		for (const arg of slugArgs) {
			const folder = path.basename(arg.trim().replace(/\/+$/, ""));
			const gameDir = path.join(mapsDir, folder);
			const metaPath = path.join(gameDir, "meta.json");
			if (!(await exists(metaPath))) {
				throw new Error(`Game meta.json not found in ${gameDir}. Check the slug/folder name.`);
			}
			const meta = JSON.parse(await readFile(metaPath, "utf8"));
			const indexEntry = indexGames.find((g) => g.slug === folder || g.id === meta.id);
			picked.push({ folder, gameDir, meta, indexEntry });
		}
		return picked;
	}

	return list.sort((a, b) => a.folder.localeCompare(b.folder));
}

export async function detectMissingTilesets(game: GameInfo): Promise<MissingTilesetItem[]> {
	const missing: MissingTilesetItem[] = [];
	for (const m of game.meta.maps || []) {
		const mapSlug = m.slug;
		const dataPath = path.join(game.gameDir, mapSlug, "data.json");
		if (!(await exists(dataPath))) continue;
		const data = JSON.parse(await readFile(dataPath, "utf8"));
		const tileSets = data.mapConfig?.tile_sets || [];
		const tilesDir = path.join(game.gameDir, mapSlug, "tiles");
		const existingDirs = new Set((await exists(tilesDir)) ? await readdir(tilesDir) : []);

		for (const ts of tileSets) {
			const key = tilesetKey(ts);
			if (!existingDirs.has(key)) {
				const tail = tilesetTail(ts);
				missing.push({
					mapSlug,
					data,
					ts,
					key,
					localTail: `tiles/${key}/${tail}`,
					destDir: path.join(game.gameDir, mapSlug),
				});
			}
		}
	}
	return missing;
}

export async function downloadOneTileset(
	item: MissingTilesetItem,
	game: GameInfo,
	opts: {
		concurrency: number;
		delay: number;
		maxTiles: number;
		maxZoom?: number;
		stagingDir?: string;
	},
): Promise<any> {
	const tilesBases = ["https://tiles.mapgenie.io/games", "https://cdn.mapgenie.io/games"];
	const destDir = opts.stagingDir || item.destDir;
	const localTail = item.localTail;

	console.log(`\n  Downloading tileset: ${item.mapSlug} / ${item.ts.name} (into ${item.key})`);
	const r = await downloadTiles({
		md: item.data,
		ts: item.ts,
		baseCandidates: tilesBases,
		destDir,
		localTail,
		opts: {
			...opts,
			unpruned: false,
			gameTitle: game.meta.title,
			gameSlug: game.folder,
			mapSlug: item.mapSlug,
			tilesetName: item.ts.name,
			sourceDir: game.gameDir,
		},
	});

	const info: any = {
		name: item.ts.name,
		template: `${item.mapSlug}/${localTail}`,
		minzoom: r.minzoom,
		maxzoom: opts.maxZoom != null ? Math.min(r.maxzoom ?? 99, opts.maxZoom) : r.maxzoom,
		viewMaxzoom: item.ts.max_zoom,
		bounds: boundsFor(item.data, item.ts).bounds,
		tileSize: 256,
	};

	const split = splitTemplate(info.template);
	if (split) {
		const optimizeDir = opts.stagingDir
			? path.join(opts.stagingDir, item.mapSlug, "tiles", item.key)
			: path.join(game.gameDir, item.mapSlug, "tiles", item.key);
		if (await exists(optimizeDir)) {
			const o = await optimizeTileset({
				dir: optimizeDir,
				tail: split.tail,
				minZ: info.minzoom ?? 0,
				maxZ: info.maxzoom ?? 0,
				prune: false,
				background: info.background,
				concurrency: opts.concurrency,
			});
			console.log(
				`    overview: ${o.overview} tile(s) made; ${o.solid} single-colour tiles linked (-${mb(o.solidFreed)})`,
			);
			if (o.background) info.background = o.background;
		}
	}

	return info;
}

export async function updateGameMetaTilesets(game: GameInfo, newTilesetInfo: any, mapSlug: string): Promise<void> {
	const metaPath = path.join(game.gameDir, "meta.json");
	const meta = JSON.parse(await readFile(metaPath, "utf8"));
	const targetMap = (meta.maps || []).find((m: any) => m.slug === mapSlug);
	if (!targetMap) return;
	if (!targetMap.tilesets) targetMap.tilesets = [];
	const existingIdx = targetMap.tilesets.findIndex((ts: any) => ts.name === newTilesetInfo.name);
	if (existingIdx >= 0) {
		targetMap.tilesets[existingIdx] = newTilesetInfo;
	} else {
		targetMap.tilesets.push(newTilesetInfo);
	}
	await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
	game.meta = meta;
}

async function main() {
	const { values: v, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			all: { type: "boolean", default: false },
			"missing-tilesets": { type: "boolean", default: false },
			"redownload-tiles": { type: "boolean", default: false },
			media: { type: "boolean", default: false },
			videos: { type: "boolean", default: false },
			"data-only": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			concurrency: { type: "string", default: "4" },
			delay: { type: "string", default: "50" },
			"max-tiles": { type: "string", default: "400000" },
			"max-zoom": { type: "string" },
			"maps-dir": { type: "string", default: path.join(REPO, "public", "maps") },
			"cache-dir": { type: "string", default: path.join(REPO, "cache", "updates") },
			"no-tui": { type: "boolean", default: false },
		},
	});

	const mapsDir = path.resolve(v["maps-dir"]!);
	const cacheDir = path.resolve(v["cache-dir"]!);
	const games = await resolveGames(positionals, v.all || (!positionals.length && v["missing-tilesets"]), mapsDir);

	if (!games.length) {
		console.log("No games found to process. Provide game slug(s) or use --all / --missing-tilesets.");
		return;
	}

	const dryRun = v["dry-run"];
	const checkMissing = v["missing-tilesets"] || (!v["redownload-tiles"] && !v.media && !v["data-only"]);
	const opts = {
		concurrency: +v.concurrency!,
		delay: +v.delay!,
		maxTiles: +v["max-tiles"]!,
		maxZoom: v["max-zoom"] ? +v["max-zoom"] : undefined,
		noTui: Boolean(v["no-tui"]),
	};

	console.log(`\n=== Verticordia Atlas Game Updater ===`);
	console.log(`Games found: ${games.length} (${games.map((g) => g.folder).join(", ")})`);
	if (dryRun) console.log("Mode: DRY-RUN (no files will be written)");

	for (const game of games) {
		console.log(`\n------------------------------------------------------------`);
		console.log(`Game: ${game.meta.title || game.folder} [${game.folder}]`);
		console.log(`  Source: ${game.meta.source || "unknown"}`);

		// 1. Missing tilesets
		if (checkMissing || v["missing-tilesets"]) {
			const missingSets = await detectMissingTilesets(game);
			if (missingSets.length) {
				console.log(`  Missing tilesets on disk (${missingSets.length}):`);
				for (const m of missingSets) {
					console.log(`    - [${m.mapSlug}] ${m.ts.name} -> tiles/${m.key}`);
					if (!dryRun) {
						try {
							const info = await downloadOneTileset(m, game, opts);
							await updateGameMetaTilesets(game, info, m.mapSlug);
							console.log(`    ✓ Updated meta.json for ${m.mapSlug} with ${m.ts.name}`);
						} catch (e: any) {
							console.log(`    ✗ Failed downloading ${m.ts.name}: ${e.message}`);
						}
					}
				}
			} else {
				console.log(`  Tilesets: all configured tile sets exist on disk.`);
			}
		}

		// 2. Atomic redownload of all tiles
		if (v["redownload-tiles"]) {
			console.log(`  Performing ATOMIC REDOWNLOAD of all tilesets...`);
			const stagingGameDir = path.join(cacheDir, game.folder);
			if (dryRun) {
				console.log(`    [dry-run] would stage tiles in ${stagingGameDir} before swapping.`);
			} else {
				await rm(stagingGameDir, { recursive: true, force: true });
				await mkdir(stagingGameDir, { recursive: true });

				let allSucceeded = true;
				for (const m of game.meta.maps || []) {
					const dataPath = path.join(game.gameDir, m.slug, "data.json");
					if (!(await exists(dataPath))) continue;
					const data = JSON.parse(await readFile(dataPath, "utf8"));
					const tileSets = data.mapConfig?.tile_sets || [];

					for (const ts of tileSets) {
						const key = tilesetKey(ts);
						const tail = tilesetTail(ts);
						const item: MissingTilesetItem = {
							mapSlug: m.slug,
							data,
							ts,
							key,
							localTail: `tiles/${key}/${tail}`,
							destDir: path.join(stagingGameDir, m.slug),
						};
						try {
							const info = await downloadOneTileset(item, game, {
								...opts,
								stagingDir: stagingGameDir,
							});
							await updateGameMetaTilesets(game, info, m.slug);
						} catch (e: any) {
							allSucceeded = false;
							console.log(`    ✗ Error downloading ${ts.name}: ${e.message}`);
							break;
						}
					}
					if (!allSucceeded) break;
				}

				if (allSucceeded) {
					console.log(`  Swapping staged tiles into ${game.gameDir}...`);
					for (const m of game.meta.maps || []) {
						const stagedTilesDir = path.join(stagingGameDir, m.slug, "tiles");
						const targetTilesDir = path.join(game.gameDir, m.slug, "tiles");
						if (await exists(stagedTilesDir)) {
							await rm(targetTilesDir, { recursive: true, force: true });
							await mkdir(path.dirname(targetTilesDir), { recursive: true });
							await rename(stagedTilesDir, targetTilesDir);
						}
					}
					await rm(stagingGameDir, { recursive: true, force: true });
					console.log(`  ✓ Atomic tile redownload complete.`);
				} else {
					console.log(`  ✗ Atomic update aborted due to errors. Staging preserved at ${stagingGameDir}.`);
				}
			}
		}

		// 3. Media & videos
		if (v.media || v.videos) {
			const mediaDir = path.join(game.gameDir, "media");
			const existingMedia = new Set((await exists(mediaDir)) ? await readdir(mediaDir) : []);
			const mapsData: any[] = [];
			for (const m of game.meta.maps || []) {
				const df = path.join(game.gameDir, m.data || `${m.slug}/data.json`);
				if (await exists(df)) {
					mapsData.push(JSON.parse(await readFile(df, "utf8")));
				}
			}
			const { urls, kinds } = collectMedia(mapsData, Boolean(v.videos));
			const toFetch = new Map<string, string>();
			for (const [url, kind] of urls) {
				const fileName = path.basename(new URL(url).pathname);
				if (!existingMedia.has(fileName)) toFetch.set(url, kind);
			}

			console.log(
				`  Media total: ${urls.size} files (${JSON.stringify(kinds)}), missing on disk: ${toFetch.size}`,
			);
			if (toFetch.size && !dryRun) {
				await mkdir(mediaDir, { recursive: true });
				const st = await downloadMedia(toFetch, mediaDir, {
					concurrency: opts.concurrency,
					delay: opts.delay,
				});
				console.log(`  ✓ Media updated: saved ${st.saved}, skipped ${st.skipped}, failed ${st.failed}`);
			}
		}
	}

	console.log(`\n=== Update check finished ===\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}