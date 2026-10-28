#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// update-games.ts: Smart game updater and repair utility.
//
// A thin wrapper around add-game that re-runs the scrape and download pipeline using
// the game's existing metadata (slug, title, id, source, poster, description), with
// an option to force-overwrite all tiles atomically via cache staging.
//
// Usage:
//   bun scripts/update-games.ts [slug...] [options]
//
// Examples:
//   bun scripts/update-games.ts rdr2
//   bun scripts/update-games.ts rdr2 --redownload-tiles
//   bun scripts/update-games.ts --all
//   bun scripts/update-games.ts totk --media --videos
//
// Options:
//   --all                Process all games found in public/maps/
//   --redownload-tiles   Atomic full redownload of all tilesets into cache staging dir before swap
//   --overwrite-tiles    Alias for --redownload-tiles
//   --no-tiles           Disable downloading map tiles
//   --skip-tiles         Alias for --no-tiles
//   --media              Download missing media (images) to public/maps/<slug>/media/
//   --no-media           Skip downloading media files
//   --upload-media       Stream & upload media directly to Cloudflare R2 / S3
//   --keep-local         When uploading to R2, also keep local copies on disk
//   --videos             Include video media (IGN/YouTube/mp4)
//   --cards              Re-render OpenGraph preview cards (default: skip)
//   --data-only          Update data and marker links only (skips tiles and media)
//   --dry-run            Simulate operations without writing changes
//   --concurrency <n>    Parallel network requests (default: 16)
//   --delay <ms>         Rate-limiting delay between requests (default: 0)
//   --max-tiles <n>      Tile limit safety cap (default: 400000)
//   --maps-dir <dir>     Root directory for games (default: ./public/maps)
//   --cache-dir <dir>    Staging root for atomic downloads (default: ./cache/updates)
//   --no-tui             Disable terminal UI dashboard
//   --help, -h           Show this help message

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runAddGamePipeline } from "./add-game.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exists = async (p: string) => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};

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

export interface UpdateGameOptions {
	redownloadTiles?: boolean;
	noTiles?: boolean;
	noMedia?: boolean;
	uploadMedia?: boolean;
	keepLocal?: boolean;
	videos?: boolean;
	noCards?: boolean;
	concurrency?: number;
	delay?: number;
	maxTiles?: number;
	maxZoom?: number;
	mapsDir?: string;
	cacheDir?: string;
	noTui?: boolean;
	dryRun?: boolean;
	renderer?: any;
	container?: any;
	onLog?: (msg: string) => void;
	onStage?: (stage: string) => void;
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

/**
 * Re-runs the scrape and download pipeline for a game with its existing configuration.
 * Preserves the original slug, title, id, poster, and description.
 * If redownloadTiles is true, downloads tiles into cache staging and atomically swaps them.
 */
export async function updateGame(game: GameInfo, options: UpdateGameOptions = {}): Promise<void> {
	const meta = game.meta;
	const sourceUrl =
		meta.source || (meta.slug ? `https://mapgenie.io/${meta.slug}` : `https://mapgenie.io/${game.folder}`);
	const id = meta.id || game.folder;
	const slug = game.folder;
	const title = meta.title || game.indexEntry?.title || game.folder;
	const accent = game.indexEntry?.theme?.accent;
	const tagLabel = meta.tagLabel || game.indexEntry?.tagLabel;
	const defaultTag = meta.defaultTag || game.indexEntry?.defaultTag;
	const allTilesets = meta.maps?.some((m: any) => (m.tilesets?.length || 0) > 1) ?? true;

	if (options.dryRun) {
		console.log(`[dry-run] Update plan for ${title} (${slug}):`);
		console.log(`  Source: ${sourceUrl}`);
		console.log(
			`  Tiles:  ${options.noTiles ? "skipped" : options.redownloadTiles ? "atomic redownload (via cache staging)" : "incremental update"}`,
		);
		console.log(
			`  Media:  ${options.noMedia ? "skipped" : options.uploadMedia ? "upload to cloud" : "download missing"}`,
		);
		return;
	}

	await runAddGamePipeline({
		url: sourceUrl,
		out: options.mapsDir || path.dirname(game.gameDir),
		id,
		slug,
		title,
		poster: undefined, // Preserves the existing poster files on disk
		accent,
		tagLabel,
		defaultTag,
		allTilesets,
		redownloadTiles: Boolean(options.redownloadTiles),
		cacheDir: options.cacheDir || path.join(REPO, "cache", "updates"),
		noTiles: options.noTiles,
		noMedia: options.noMedia,
		uploadMedia: options.uploadMedia,
		keepLocal: options.keepLocal,
		videos: options.videos,
		noCards: options.noCards ?? true,
		concurrency: options.concurrency,
		delay: options.delay,
		maxTiles: options.maxTiles,
		maxZoom: options.maxZoom,
		noTui: options.noTui,
		container: options.container,
		renderer: options.renderer,
		onLog: options.onLog,
		onStage: options.onStage,
	});
}

async function main() {
	const { values: v, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			all: { type: "boolean", default: false },
			"redownload-tiles": { type: "boolean", default: false },
			"overwrite-tiles": { type: "boolean", default: false },
			"no-tiles": { type: "boolean", default: false },
			"skip-tiles": { type: "boolean", default: false },
			media: { type: "boolean", default: false },
			"no-media": { type: "boolean", default: false },
			"upload-media": { type: "boolean", default: false },
			"keep-local": { type: "boolean", default: false },
			videos: { type: "boolean", default: false },
			cards: { type: "boolean", default: false },
			"data-only": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			concurrency: { type: "string", default: "16" },
			delay: { type: "string", default: "0" },
			"max-tiles": { type: "string", default: "400000" },
			"max-zoom": { type: "string" },
			"maps-dir": { type: "string", default: path.join(REPO, "public", "maps") },
			"cache-dir": { type: "string", default: path.join(REPO, "cache", "updates") },
			"no-tui": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});

	if (v.help) {
		console.log(`
Usage: bun scripts/update-games.ts [slug...] [options]

Options:
  --all                Process all games found in maps directory
  --redownload-tiles   Atomic full redownload of all tilesets into cache staging dir before swap
  --overwrite-tiles    Alias for --redownload-tiles
  --no-tiles           Disable downloading map tiles
  --skip-tiles         Alias for --no-tiles
  --media              Download missing media files
  --no-media           Disable downloading media files
  --upload-media       Stream & upload media directly to Cloudflare R2 / S3
  --keep-local         When uploading to R2, also keep local copies on disk
  --videos             Include video media files
  --cards              Re-render OpenGraph preview cards (default: skip)
  --data-only          Update data and marker links only (skips tiles and media)
  --dry-run            Simulate operations without writing changes
  --concurrency <n>    Parallel download concurrency (default: 16)
  --delay <ms>         Rate-limiting delay between requests in ms (default: 0)
  --max-tiles <n>      Tile download limit safety cap (default: 400000)
  --maps-dir <dir>     Root directory for games (default: ./public/maps)
  --cache-dir <dir>    Staging root for atomic downloads (default: ./cache/updates)
  --no-tui             Disable terminal UI dashboard
  --help, -h           Show this help message
`);
		process.exit(0);
	}

	const redownloadTiles = v["redownload-tiles"] || v["overwrite-tiles"];
	const noTiles = v["no-tiles"] || v["skip-tiles"] || v["data-only"];
	const noMedia = v["no-media"] || v["data-only"] || (!v.media && !v["upload-media"]);

	const mapsDir = path.resolve(v["maps-dir"]!);
	const cacheDir = path.resolve(v["cache-dir"]!);
	const games = await resolveGames(positionals, v.all || !positionals.length, mapsDir);

	if (!games.length) {
		console.log("No games found to process. Provide game slug(s) or use --all.");
		return;
	}

	const dryRun = v["dry-run"];
	const updateOpts: UpdateGameOptions = {
		redownloadTiles,
		noTiles,
		noMedia,
		uploadMedia: v["upload-media"],
		keepLocal: v["keep-local"],
		videos: v.videos,
		noCards: !v.cards,
		concurrency: +v.concurrency!,
		delay: +v.delay!,
		maxTiles: +v["max-tiles"]!,
		maxZoom: v["max-zoom"] ? +v["max-zoom"] : undefined,
		mapsDir,
		cacheDir,
		noTui: Boolean(v["no-tui"]),
		dryRun,
	};

	console.log(`\n=== Verticordia Atlas Game Updater ===`);
	console.log(`Games found: ${games.length} (${games.map((g) => g.folder).join(", ")})`);
	if (redownloadTiles) console.log("Mode: ATOMIC TILE OVERWRITE (staging via cache)");
	if (dryRun) console.log("Mode: DRY-RUN (no files will be written)");

	for (const game of games) {
		console.log(`\n------------------------------------------------------------`);
		console.log(`Updating ${game.meta.title || game.folder} [${game.folder}]...`);
		try {
			await updateGame(game, updateOpts);
			console.log(`✓ Completed update for ${game.folder}`);
		} catch (e: any) {
			console.error(`✗ Error updating ${game.folder}: ${e.message}`);
		}
	}

	console.log(`\n=== Update finished ===\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}