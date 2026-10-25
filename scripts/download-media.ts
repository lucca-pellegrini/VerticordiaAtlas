#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// download-media.ts: downloads marker media for an existing game in public/maps/<slug>/, skipping any media
// already recorded as uploaded to Cloudflare R2 / S3 in data/atlas.db.
//
//   bun scripts/download-media.ts <slug> [--upload-media] [--keep-local] [--videos] [--concurrency 4]

import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { collectMedia, downloadMedia } from "./add-game.ts";
import { createR2Client, openMediaDb, REPO, validateR2Env } from "./upload-media.ts";

export function resolveGameSlug(
	arg: string | undefined,
	explicitGame?: string,
	mapsDir = path.join(REPO, "public", "maps"),
): string {
	if (explicitGame?.trim()) return explicitGame.trim().replace(/^\/+|\/+$/g, "");
	if (!arg?.trim()) {
		throw new Error("Game slug/id is required (e.g. bun scripts/download-media.ts re2 or --game <slug>).");
	}
	const raw = arg.trim();
	const abs = path.resolve(raw);
	const relToMaps = path.relative(path.resolve(mapsDir), abs);
	if (relToMaps && !relToMaps.startsWith("..") && !path.isAbsolute(relToMaps)) {
		const firstSeg = relToMaps.split(path.sep)[0];
		if (firstSeg) return firstSeg;
	}
	// If it looks like a filesystem path outside mapsDir or with path separators that couldn't be resolved to mapsDir
	if (raw.includes("/") || raw.includes("\\") || raw.endsWith(".json")) {
		const parts = abs.split(path.sep);
		const mapsIdx = parts.lastIndexOf("maps");
		if (mapsIdx >= 0 && parts[mapsIdx + 1] && !parts[mapsIdx + 1].endsWith(".json")) {
			return parts[mapsIdx + 1];
		}
		throw new Error(`Could not infer game slug/id from "${raw}". Pass --game <slug>.`);
	}
	return raw;
}

export async function loadGameMapsData(gameDir: string): Promise<any[]> {
	const metaFile = Bun.file(path.join(gameDir, "meta.json"));
	const maps: any[] = [];
	if (await metaFile.exists()) {
		const meta = await metaFile.json();
		for (const m of meta.maps || []) {
			if (!m.data) continue;
			const df = Bun.file(path.join(gameDir, m.data));
			if (await df.exists()) maps.push(await df.json());
		}
	}
	const rootData = Bun.file(path.join(gameDir, "data.json"));
	if (!maps.length && (await rootData.exists())) {
		maps.push(await rootData.json());
	}
	if (!maps.length) {
		throw new Error(`No map data.json found in ${gameDir}`);
	}
	return maps;
}

async function main() {
	const { values: v, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			game: { type: "string" },
			id: { type: "string" },
			slug: { type: "string" },
			"maps-dir": { type: "string", default: path.join(REPO, "public", "maps") },
			"upload-media": { type: "boolean", default: false },
			"keep-local": { type: "boolean", default: false },
			"no-media": { type: "boolean", default: false },
			videos: { type: "boolean", default: false },
			concurrency: { type: "string", default: "4" },
			delay: { type: "string", default: "100" },
		},
	});

	const mapsDir = path.resolve(v["maps-dir"]!);
	const slug = resolveGameSlug(positionals[0], v.game || v.slug || v.id, mapsDir);
	const gameDir = path.join(mapsDir, slug);
	const st = await stat(gameDir).catch(() => null);
	if (!st?.isDirectory()) {
		throw new Error(`Game directory not found: ${gameDir}`);
	}

	const uploadMedia = Boolean(v["upload-media"]) && !v["no-media"];
	const r2Cfg = uploadMedia ? validateR2Env() : null;
	const r2Client = r2Cfg ? createR2Client(r2Cfg) : undefined;

	const maps = await loadGameMapsData(gameDir);
	const { urls } = collectMedia(maps, Boolean(v.videos));
	if (v["no-media"] || !urls.size) {
		console.log(
			`Media for "${slug}": ${urls.size} file(s) listed${v["no-media"] ? " (skipped via --no-media)" : ""}.`,
		);
		return;
	}

	const mediaDb = openMediaDb(REPO);
	try {
		await downloadMedia(urls, path.join(gameDir, "media"), {
			concurrency: Math.max(1, Number(v.concurrency) || 4),
			delay: Math.max(0, Number(v.delay) || 0),
			game: slug,
			mediaDb,
			uploadMedia,
			keepLocal: Boolean(v["keep-local"]),
			s3: r2Client,
			mediaUrl: r2Cfg?.mediaUrl,
		});
	} finally {
		mediaDb.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}