#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// clean-markers.ts: rewrite intra-map MapGenie marker links in location descriptions to minimal "#loc=<id>" fragments.
//
//   bun scripts/clean-markers.ts [game ...] [--dry-run] [--out public/maps]
//
// Links that point to a marker on the same map (whether on mapgenie.io or a dedicated domain like rdr2map.com) become
// "#loc=<id>". Links that point to another map are left as full URLs so the viewer can tell a cross-map link from a
// local one and let the user know that switching maps on link follow is planned.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { GameMeta } from "../src/shared/types.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface CleanMapInput {
	slug: string;
	isDefault?: boolean;
	data: {
		map?: { slug?: string };
		locations?: { id: number | string; description?: string | null }[];
		[k: string]: unknown;
	};
}

export interface CleanLinkContext {
	mapSlug: string;
	isDefaultMap?: boolean;
	sameMapIds: ReadonlySet<number>;
	otherMapIds?: ReadonlySet<number>;
	otherMapSlugs?: ReadonlySet<string>;
}

// Parse a markdown link target and return "#loc=<id>" when it points to the current map, or null to leave it as is.
export function resolveSameMapHref(rawHref: string, ctx: CleanLinkContext): string | null {
	const href = rawHref.trim();
	if (!href || /^#loc=\d+$/i.test(href)) return null;
	let u: URL;
	try {
		u = new URL(href, "https://mapgenie.io/");
	} catch {
		return null;
	}
	if (!/^https?:$/i.test(u.protocol)) return null;
	const m = /^(\d+)/.exec(u.searchParams.get("locationIds") || "");
	if (!m) return null;
	const id = Number(m[1]);
	if (!Number.isFinite(id)) return null;

	// If the ID is known to live on this map, it is always a same-map reference.
	if (ctx.sameMapIds.has(id)) return `#loc=${id}`;

	// If the ID belongs to another map of this game, keep the full URL for cross-map handling.
	if (ctx.otherMapIds?.has(id)) return null;

	// Otherwise (e.g. an older marker ID removed upstream), check the URL path to see which map it targeted.
	const segs = u.pathname.split("/").filter(Boolean);
	const mapIdx = segs.indexOf("maps");
	const urlMapSlug = mapIdx >= 0 ? segs[mapIdx + 1] : segs[0];
	if (urlMapSlug && ctx.otherMapSlugs?.has(urlMapSlug)) return null;
	if (urlMapSlug === ctx.mapSlug) return `#loc=${id}`;
	if (!urlMapSlug && ctx.isDefaultMap) return `#loc=${id}`;
	return null;
}

const MD_LINK_RE = /(\[[^\]]*\]\()([^)\s]+)(\))/g;

export function cleanDescription(
	desc: string | null | undefined,
	ctx: CleanLinkContext,
): { text: string; cleaned: number } {
	if (!desc || !desc.includes("locationIds")) return { text: String(desc ?? ""), cleaned: 0 };
	let cleaned = 0;
	const text = desc.replace(MD_LINK_RE, (full, open: string, href: string, close: string) => {
		const local = resolveSameMapHref(href, ctx);
		if (!local) return full;
		cleaned++;
		return `${open}${local}${close}`;
	});
	return { text, cleaned };
}

export interface CleanGameStats {
	maps: number;
	locationsChanged: number;
	linksCleaned: number;
}

// Clean all maps of a game in memory (mutating location.description in place) and return summary counts.
export function cleanGameMarkers(maps: CleanMapInput[]): CleanGameStats {
	const idsByMap = new Map<string, Set<number>>();
	const allSlugs = new Set<string>();
	for (const m of maps) {
		allSlugs.add(m.slug);
		const set = new Set<number>();
		for (const loc of m.data.locations || []) {
			const id = Number(loc.id);
			if (Number.isFinite(id)) set.add(id);
		}
		idsByMap.set(m.slug, set);
	}

	let locationsChanged = 0,
		linksCleaned = 0;
	maps.forEach((m, idx) => {
		const sameMapIds = idsByMap.get(m.slug) ?? new Set<number>();
		const otherMapIds = new Set<number>();
		const otherMapSlugs = new Set<string>();
		for (const [slug, set] of idsByMap) {
			if (slug === m.slug) continue;
			otherMapSlugs.add(slug);
			for (const id of set) if (!sameMapIds.has(id)) otherMapIds.add(id);
		}
		const ctx: CleanLinkContext = {
			mapSlug: m.slug,
			isDefaultMap: m.isDefault ?? idx === 0,
			sameMapIds,
			otherMapIds,
			otherMapSlugs,
		};
		for (const loc of m.data.locations || []) {
			if (!loc.description) continue;
			const { text, cleaned } = cleanDescription(loc.description, ctx);
			if (cleaned > 0) {
				loc.description = text;
				locationsChanged++;
				linksCleaned += cleaned;
			}
		}
	});
	return { maps: maps.length, locationsChanged, linksCleaned };
}

export async function cleanGameOnDisk(
	gameDir: string,
	opts: { dryRun?: boolean } = {},
): Promise<CleanGameStats | null> {
	const metaFile = path.join(gameDir, "meta.json");
	let meta: GameMeta;
	try {
		meta = JSON.parse(await readFile(metaFile, "utf8"));
	} catch {
		return null;
	}
	const loaded: { slug: string; file: string; data: any }[] = [];
	for (const m of meta.maps || []) {
		const file = path.join(gameDir, m.data || `${m.slug}/data.json`);
		try {
			loaded.push({ slug: m.slug, file, data: JSON.parse(await readFile(file, "utf8")) });
		} catch {
			/* missing data.json */
		}
	}
	if (!loaded.length) return null;
	const stats = cleanGameMarkers(loaded.map((l, i) => ({ slug: l.slug, isDefault: i === 0, data: l.data })));
	if (stats.linksCleaned > 0 && !opts.dryRun) {
		for (const l of loaded) await writeFile(l.file, JSON.stringify(l.data));
	}
	return stats;
}

async function main() {
	const { values: v, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			out: { type: "string", default: path.join(REPO, "public", "maps") },
			"dry-run": { type: "boolean", default: false },
		},
	});
	const root = v.out!;
	const games = positionals.length
		? positionals
		: (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

	let totalLocations = 0,
		totalLinks = 0;
	for (const game of games) {
		const r = await cleanGameOnDisk(path.join(root, game), { dryRun: v["dry-run"] });
		if (!r) continue;
		if (r.linksCleaned > 0) {
			console.log(
				`${game}: ${r.linksCleaned} link(s) across ${r.locationsChanged} marker(s) ${v["dry-run"] ? "would be " : ""}cleaned`,
			);
		}
		totalLocations += r.locationsChanged;
		totalLinks += r.linksCleaned;
	}
	console.log(
		`\n${v["dry-run"] ? "Would clean" : "Cleaned"} ${totalLinks} same-map link(s) across ${totalLocations} marker(s).`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}