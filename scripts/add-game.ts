#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// add-game.ts: add (or refresh) a MapGenie game from just its link.
//
//   bun scripts/add-game.ts https://mapgenie.io/<game> [options]
//   bun scripts/add-game.ts https://fallout4map.com/ --id fallout-4 [options]     (a game with its own domain)
//
// Give the game's page link. Its maps are found on that page and added in the order it lists them. (A link to one
// map, https://mapgenie.io/<game>/maps/<map>, also works: the game's maps are still all added, in the same order.)
//
// First run it with --no-tiles --no-media: it only reads the page and prints a report of what
// the game contains (maps, tile sets, marker sprite, media, features the viewer cannot draw yet).
//
// Options
//   --out <dir>          output root (default ./public/maps); the game lands in <out>/<id>/
//   --id <id>            folder/id for the game (default: the game slug from the URL)
//   --title <text>       display title (default: taken from the page)
//   --poster <file|url>  poster image (default: the one already in the game folder, else the page's og:image).
//                        Makes poster-600/1200.webp for the homepage, and (with --poster) a theme from its colours
//   --tag-label <text>   label for the tag selector (default: guessed, "Difficulty" or "Filter")
//   --default-tag <text> tag selected by default for new profiles
//   --index <file>       homepage manifest to update (default ./public/maps/index.json)
//   --slug <name>        folder / URL name of the game page (default: --id)
//   --accent <#rrggbb>   theme accent colour (default: the colour of the game's first group)
//   --max-zoom <n>       cap tile zoom (default: the tile set's tiles_max_zoom)
//   --all-tilesets       download every tile set of a map (default: only the first)
//   --videos             also download video media (default: images only)
//   --game <name>        the game's name on MapGenie (the folder of its markers/icons on the CDN, e.g. fallout-4). Needed
//                        only for a game with its own domain (https://fallout4map.com, https://fo76map.com) when it
//                        cannot be read from the page
//   --map-url <template> where a map lives, with {map} for its slug, e.g. https://fallout4map.com/maps/{map}. Only used
//                        when the game page has no links to its maps
//   --no-tiles --no-media --no-markers --no-icons --no-clean-markers
//   --upload-media       stream/upload downloaded media directly to Cloudflare R2 / S3 and record in data/atlas.db
//   --keep-local         when used with --upload-media, also keep local files in public/maps/<slug>/media/
//   --no-optimize        keep the tiles as downloaded: no overview is made, and single-colour tiles are not linked
//                        (what prune-tiles.ts does afterwards, for any game; run it by hand later if you skip it here)
//   --icons-only         only (re)fetch the sidebar icons of a game that was already added, and update its meta.json
//   --no-cards           don't rebuild the social preview cards (make-cards.ts) at the end
//   --html <file>        read the map page from a saved file instead of fetching it
//   --mapdata <file>     use a saved window.mapData JSON (the old console snippet) for this one map
//   --tiles-base <url>   tile CDN base (default https://tiles.mapgenie.io/games)
//   --media-base <url>   marker CDN base (default https://media.mapgenie.io/v2/assets/prod/games)
//   --concurrency <n> --delay <ms> --max-tiles <n>
//   --force-get-tiles <map>  fetch every tile of that map at every zoom, inside its bounds, not only the highest zoom (repeatable;
//                        slow and big: use it for a map whose tiles have gaps at different places and zooms, e.g. Solstheim,
//                        or any map that is not a perfect rectangle at the stored zoom)

import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import vm from "node:vm";

import { splitTemplate } from "../server/tile-engine.ts";
import { hexToHsl, hslToHex } from "../src/shared/theme-math.ts";
import type { ThemePalette } from "../src/shared/types.ts";
import { cleanGameMarkers } from "./clean-markers.ts";
import { optimizeTileset } from "./prune-tiles.ts";
import {
	createR2Client,
	type MediaDatabase,
	openMediaDb,
	uploadAndVerifyBuffer,
	validateR2Env,
} from "./upload-media.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) => Bun.file(p).exists();
const mb = (n: number) => (n / 1e6).toFixed(1) + " MB";

/* ---------- extracting window.* values from the page HTML ---------- */

function readExpression(html: string, start: number): string {
	let i = start,
		depth = 0,
		quote: string | null = null;
	for (; i < html.length; i++) {
		const c = html[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			continue;
		}
		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") depth--;
		else if (depth <= 0 && (c === ";" || c === "\n" || c === "<")) break;
	}
	return html.slice(start, i).trim();
}

export function extractVar(
	html: string,
	name: string,
	ok: (v: any) => boolean = (v) => v && typeof v === "object",
): any {
	const re = new RegExp(`window\\.${name}\\s*=\\s*`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		const expr = readExpression(html, m.index + m[0].length);
		const attempts = [
			() => JSON.parse(expr),
			// fallbacks for JS literals or JSON.parse('...') wrappers; empty context, 2 s limit
			() => vm.runInNewContext("(" + expr + ")", { JSON }, { timeout: 2000 }),
		];
		for (const attempt of attempts) {
			try {
				const v = JSON.parse(JSON.stringify(attempt()));
				if (ok(v)) return v;
			} catch {}
		}
	}
	return null;
}
const isMapData = (v: any): boolean => Boolean(v && Array.isArray(v.locations) && v.mapConfig);

/* ---------- network helpers ---------- */

async function getPage(url: string) {
	const r = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
	return { html: await r.text(), url: r.url };
}

async function getJSON(url: string, referer: string) {
	const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: referer } });
	if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
	return r.json();
}

// The page only inlines part of window.mapData (map, mapConfig, groups, categories). The site's own script then
// fetches /api/v1/maps/<id>/data (locations, tags, styles, maps, regions, ...) and merges it in; so do we.
async function loadMapData(html: string, origin: string, _slug: string | null, referer: string) {
	const inline = extractVar(html, "mapData", (v) => v && typeof v === "object" && v.mapConfig);
	if (!inline) return null;
	if (Array.isArray(inline.locations)) return inline; // older pages / saved console dumps: already complete
	if (!inline.map?.id) throw new Error("mapData has no map id, cannot fetch its locations");
	const api = await getJSON(`${origin}/api/v1/maps/${inline.map.id}/data`, referer);
	return { ...inline, ...(api as object) };
}

async function getBin(
	url: string,
	tries = 3,
	referer = "https://mapgenie.io/",
): Promise<{ status: number; buf?: Buffer; type?: string; error?: string }> {
	let last: unknown;
	for (let a = 1; a <= tries; a++) {
		try {
			const r = await fetch(url, {
				headers: {
					"User-Agent": UA,
					Referer: referer,
					Origin: new URL(referer).origin,
				},
			});
			if ([403, 404, 410].includes(r.status)) return { status: r.status };
			if (!r.ok) throw new Error("HTTP " + r.status);
			return { status: 200, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "" };
		} catch (e) {
			last = e;
			await sleep(500 * a);
		}
	}
	return { status: 0, error: String(last) };
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
	let i = 0;
	await Promise.all(
		Array.from({ length: n }, async () => {
			while (i < items.length) {
				const it = items[i++];
				await fn(it);
			}
		}),
	);
}

/* ---------- tile maths ---------- */

const lon2x = (lon: number, n: number) => ((lon + 180) / 360) * n;
const lat2y = (lat: number, n: number) => {
	const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
	return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};
const x2lon = (x: number, n: number) => (x / n) * 360 - 180;
const y2lat = (y: number, n: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

export function tilesCovering(
	bounds: [number, number, number, number] | number[],
	z: number,
	pad = 0,
): [number, number][] {
	const n = 2 ** z,
		[w, s, e, nn] = bounds;
	const x0 = Math.max(0, Math.floor(lon2x(w, n)) - pad);
	const x1 = Math.min(n - 1, Math.max(Math.floor(lon2x(w, n)), Math.ceil(lon2x(e, n)) - 1) + pad);
	const y0 = Math.max(0, Math.floor(lat2y(nn, n)) - pad);
	const y1 = Math.min(n - 1, Math.max(Math.floor(lat2y(nn, n)), Math.ceil(lat2y(s, n)) - 1) + pad);
	const out: [number, number][] = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
	return out;
}

const fill = (tpl: string, z: number, x: number, y: number) =>
	tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

export function boundsFor(md: any, ts: any): { bounds: [number, number, number, number]; guessed: boolean } {
	// tile-index bounds per zoom level: { "8": { x: { min, max }, y: { min, max } }, ... }
	if (ts.bounds && typeof ts.bounds === "object" && !Array.isArray(ts.bounds)) {
		const zs = Object.keys(ts.bounds)
			.map(Number)
			.filter(Number.isFinite)
			.sort((a, b) => a - b);
		const z = zs.includes(ts.min_zoom) ? ts.min_zoom : zs[0];
		const bz = ts.bounds[z];
		if (
			bz?.x &&
			bz?.y &&
			Number.isFinite(bz.x.min) &&
			Number.isFinite(bz.x.max) &&
			Number.isFinite(bz.y.min) &&
			Number.isFinite(bz.y.max)
		) {
			const n = 2 ** z;
			return {
				bounds: [x2lon(bz.x.min, n), y2lat(bz.y.max + 1, n), x2lon(bz.x.max + 1, n), y2lat(bz.y.min, n)],
				guessed: false,
			};
		}
	}
	const b = ts.bounds || md.styles?.mapStyle?.bounds;
	// ignore whole-world placeholder bounds (e.g. [-180, -85, 180, 85] on Fallout 76), which would try 65,536 tiles at zoom 8
	if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && (b[2] - b[0] < 300 || b[3] - b[1] < 150)) {
		return { bounds: b as [number, number, number, number], guessed: false };
	}
	const lats = md.locations.map((l: any) => parseFloat(l.latitude)).filter(Number.isFinite);
	const lngs = md.locations.map((l: any) => parseFloat(l.longitude)).filter(Number.isFinite);
	const dx = Math.max(...lngs) - Math.min(...lngs) || 1,
		dy = Math.max(...lats) - Math.min(...lats) || 1;
	return {
		bounds: [Math.min(...lngs) - dx, Math.min(...lats) - dy, Math.max(...lngs) + dx, Math.max(...lats) + dy],
		guessed: true,
	};
}

/* ---------- tiles: only the highest zoom is scraped; --force-get-tiles crawls every tile of every zoom, no pruning ---------- */

export async function downloadTiles({
	md,
	ts,
	baseCandidates,
	destDir,
	localTail,
	opts,
}: {
	md: any;
	ts: any;
	baseCandidates: string[];
	destDir: string;
	localTail: string;
	opts: any;
}) {
	const minZ = ts.min_zoom ?? 0;
	const maxZ = Math.min(ts.tiles_max_zoom ?? ts.max_zoom ?? 15, opts.maxZoom ?? 99);
	const { bounds, guessed } = boundsFor(md, ts);
	if (guessed) console.log("  ! no bounds in the data, guessing from marker positions (check the tile count below)");
	const remote = (base: string) => `${base}/${ts.pattern}`;
	const first = tilesCovering(bounds, minZ, 1);

	let base: string | null = null;
	for (const b of baseCandidates) {
		for (const [x, y] of first) {
			const r = await getBin(fill(remote(b), minZ, x, y), 1);
			if (r.status === 200 && r.type?.startsWith("image/")) {
				base = b;
				break;
			}
		}
		if (base) break;
	}
	if (!base) throw new Error(`No tile found at zoom ${minZ} under: ${baseCandidates.join(", ")}. Try --tiles-base.`);

	const stats = { saved: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 };
	// Only the highest zoom is scraped (--force-get-tiles takes the whole pyramid): the overview is made from it afterwards,
	// and the zooms in between are made by the server when they are asked for (see server/tile-service.ts).
	const maxOnly = !opts.unpruned;
	const maxBoundsCount =
		ts.bounds &&
		!Array.isArray(ts.bounds) &&
		ts.bounds[maxZ]?.x &&
		ts.bounds[maxZ]?.y &&
		Number.isFinite(ts.bounds[maxZ].x.min) &&
		Number.isFinite(ts.bounds[maxZ].x.max) &&
		Number.isFinite(ts.bounds[maxZ].y.min) &&
		Number.isFinite(ts.bounds[maxZ].y.max)
			? (ts.bounds[maxZ].x.max - ts.bounds[maxZ].x.min + 1) * (ts.bounds[maxZ].y.max - ts.bounds[maxZ].y.min + 1)
			: Infinity;
	const hasMaxBounds = Number.isFinite(maxBoundsCount) && maxBoundsCount <= 512;
	const startZ = maxOnly && hasMaxBounds ? maxZ : minZ;
	let cands = first;
	for (let z = startZ; z <= maxZ; z++) {
		const bz = ts.bounds && !Array.isArray(ts.bounds) ? ts.bounds[z] : null;
		if (
			bz?.x &&
			bz?.y &&
			Number.isFinite(bz.x.min) &&
			Number.isFinite(bz.x.max) &&
			Number.isFinite(bz.y.min) &&
			Number.isFinite(bz.y.max)
		) {
			if (z === startZ || opts.unpruned) {
				cands = [];
				for (let x = bz.x.min; x <= bz.x.max; x++)
					for (let y = bz.y.min; y <= bz.y.max; y++) cands.push([x, y]);
			} else {
				cands = cands.filter(([x, y]) => x >= bz.x.min && x <= bz.x.max && y >= bz.y.min && y <= bz.y.max);
			}
		} else if (z === startZ || opts.unpruned) {
			cands = z === minZ ? first : tilesCovering(bounds, z, 0);
		}
		if ((!maxOnly || z === maxZ) && stats.saved + stats.skipped + cands.length > opts.maxTiles) {
			console.log(`  stopping before zoom ${z}: would pass --max-tiles ${opts.maxTiles}`);
			break;
		}
		const isScouting = maxOnly && z < maxZ;
		const found: [number, number][] = [];
		await pool(cands, opts.concurrency, async ([x, y]) => {
			const file = path.join(destDir, fill(localTail, z, x, y));
			if (await exists(file)) {
				if (!isScouting) stats.skipped++;
				found.push([x, y]);
				return;
			}
			const r = await getBin(fill(remote(base!), z, x, y));
			if (r.status === 200 && r.type?.startsWith("image/") && r.buf) {
				if (!isScouting) {
					await mkdir(path.dirname(file), { recursive: true });
					await writeFile(file, r.buf);
					stats.saved++;
					stats.bytes += r.buf.length;
				}
				found.push([x, y]);
			} else if (r.status === 0) {
				if (!isScouting) stats.failed++;
			} else {
				if (!isScouting) stats.missing++;
			}
			if (opts.delay) await sleep(opts.delay);
		});
		console.log(`  zoom ${z}: ${found.length} tiles (${cands.length} tried)${isScouting ? " (scouting)" : ""}`);
		if (!found.length && !opts.unpruned) break;
		if (!opts.unpruned)
			cands = found.flatMap(([x, y]): [number, number][] => [
				[2 * x, 2 * y],
				[2 * x + 1, 2 * y],
				[2 * x, 2 * y + 1],
				[2 * x + 1, 2 * y + 1],
			]);
	}
	console.log(
		`  tiles: saved ${stats.saved}, already had ${stats.skipped}, missing ${stats.missing}, failed ${stats.failed}, ${mb(stats.bytes)}`,
	);
	return { minzoom: minZ, maxzoom: maxZ, bounds, stats };
}

/* ---------- markers sprite ---------- */

async function downloadMarkers({
	html,
	slug,
	mediaBase,
	outDir,
	cats,
	origin,
	cdnUrl,
}: {
	html: string;
	slug: string;
	mediaBase: string;
	outDir: string;
	cats: any[];
	origin: string;
	cdnUrl: string;
}) {
	const hit = html.match(/https?:\/\/[^"'\s\\]+?\/markers\/markers\.json([^"'\s\\]*)/);
	const bases: { dir: string; q: string }[] = [];
	if (hit) bases.push({ dir: hit[0].replace(/markers\.json.*$/, ""), q: hit[1] });
	const versioned = html.match(/https?:\/\/[^"'\s\\]+?\/markers\/v\d+\/markers@2x\.png/);
	if (versioned) bases.unshift({ dir: versioned[0].replace(/markers@2x\.png.*$/, ""), q: "" });
	const spriteHit =
		html.match(/marker_sprite_url["']?\s*[:=]\s*["']([^"']+)["']/i) ||
		html.match(/MARKER_IMAGES_URL\s*=\s*['"]([^'"]+)['"]/i) ||
		html.match(/\/images\/games\/[a-z0-9-]+\/markers(?:@2x)?\.png[^"'\s]*/i);
	const cdn = (cdnUrl || "https://cdn.mapgenie.io").replace(/\/$/, "");
	if (spriteHit) {
		let p = spriteHit[1] || spriteHit[0];
		p = p.replace(/markers(?:@2x)?\.png.*$/, "").replace(/^\//, "");
		if (!p.startsWith("http")) p = `${cdn}/${p}`;
		bases.unshift({ dir: p.endsWith("/") ? p : p + "/", q: "" });
	}
	bases.push({ dir: `${cdn}/images/games/${slug}/`, q: "" });
	bases.push(
		{ dir: `${mediaBase}/${slug}/markers/`, q: hit ? hit[1] : "" },
		{ dir: `${mediaBase}/${slug}/markers/`, q: "?v=2" },
	);

	const referer = origin || "https://mapgenie.io/";

	for (const { dir, q } of bases) {
		const j = await getBin(dir + "markers.json" + q, 1, referer);
		if (j.status !== 200 || !j.buf) continue;
		let defs: Record<string, unknown>;
		try {
			defs = JSON.parse(j.buf.toString("utf8"));
		} catch {
			continue;
		}
		const p = await getBin(dir + "markers.png" + q, 3, referer);
		if (p.status !== 200 || !p.buf) continue;
		await writeFile(path.join(outDir, "markers.json"), j.buf);
		await writeFile(path.join(outDir, "markers.png"), p.buf);
		const res: {
			json: string;
			png: string;
			json2x: string | null;
			png2x: string | null;
			missingIcons?: string[];
			sprites?: number;
		} = { json: "markers.json", png: "markers.png", json2x: null, png2x: null };
		const j2 = await getBin(dir + "markers@2x.json" + q, 1),
			p2 = j2.status === 200 ? await getBin(dir + "markers@2x.png" + q) : { status: 0 };
		if (j2.status === 200 && j2.buf && p2.status === 200 && p2.buf) {
			await writeFile(path.join(outDir, "markers@2x.json"), j2.buf);
			await writeFile(path.join(outDir, "markers@2x.png"), p2.buf);
			res.json2x = "markers@2x.json";
			res.png2x = "markers@2x.png";
		}
		const used = new Set(cats.map((c: any) => c.icon).filter(Boolean));
		res.missingIcons = [...used].filter((i) => !defs[i]);
		res.sprites = Object.keys(defs).length;
		return res;
	}
	return null;
}

/* ---------- icons: the sidebar shows each category's logo, from the site's icon font (one glyph per category icon) ---------- */

async function downloadIcons({
	html,
	origin,
	slug,
	outDir,
}: {
	html: string;
	origin: string;
	slug: string;
	outDir: string;
}) {
	const base = origin + "/";
	const candidates = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
		.map((m) => m[1].replace(/&amp;/g, "&"))
		.filter((u) => /icon/i.test(u) && /\.css(\?|$)/i.test(u));
	candidates.push(`game-icons/${slug}/icons.css`);
	for (const link of [...new Set(candidates.map((u) => new URL(u, base).href))]) {
		const css = await getBin(link, 1, base);
		if (css.status !== 200 || !css.buf) continue;
		const text = css.buf.toString("utf8");
		const glyphs: Record<string, any> = {};
		for (const m of text.matchAll(/\.icon-([a-z0-9_]+)((?:\s+\.path\d+)?):before\s*\{([^}]*)\}/gi)) {
			const cp = m[3].match(/content:\s*"\\([0-9a-f]{4})"/i);
			if (!cp) continue;
			const pIdx = m[2] ? parseInt(m[2].match(/\d+/)![0], 10) : 0;
			const color = (m[3].match(/color:\s*(#[0-9a-f]{3,8})/i) || [])[1]?.toLowerCase();
			const ml = (m[3].match(/margin-left:\s*([^;]+)/i) || [])[1]?.trim();
			(glyphs[m[1]] ||= []).push({
				path: pIdx,
				cp: cp[1].toLowerCase(),
				...(color ? { color } : {}),
				...(ml ? { ml } : {}),
			});
		}
		if (Object.keys(glyphs).length) {
			for (const k of Object.keys(glyphs))
				glyphs[k] = glyphs[k]
					.sort((a: any, b: any) => a.path - b.path)
					.map(({ path: _p, ...layer }: any) => layer);
			const font = text.match(/url\(['"]?([^'")?]+\.woff)/);
			if (!font) continue;
			const f = await getBin(new URL(font[1], link).href, 1, base);
			if (f.status !== 200 || !f.buf) continue;
			await mkdir(path.join(outDir, "icons"), { recursive: true });
			await writeFile(path.join(outDir, "icons", "icons.woff"), f.buf);
			return { font: "icons/icons.woff", glyphs };
		}
		const imgMatch = text.match(/background(?:-image)?:\s*url\(['"]?([^'")?]+\.png)/i);
		if (!imgMatch) continue;
		for (const m of text.matchAll(/\.icon-([a-z0-9_]+)\s*\{([^}]*)\}/gi)) {
			const pos = m[2].match(/background-position:\s*(-?\d+)(?:px)?\s+(-?\d+)(?:px)?/i);
			if (!pos) continue;
			const x = -parseInt(pos[1], 10) || 0,
				y = -parseInt(pos[2], 10) || 0;
			glyphs[m[1]] = x ? { x, y } : y;
		}
		if (!Object.keys(glyphs).length) continue;
		const img = await getBin(new URL(imgMatch[1], link).href, 1, base);
		if (img.status !== 200 || !img.buf) continue;
		const size = parseInt((text.match(/width:\s*(\d+)px/i) || [])[1], 10) || 18;
		await mkdir(path.join(outDir, "icons"), { recursive: true });
		await writeFile(path.join(outDir, "icons", "icons.png"), img.buf);
		return { image: "icons/icons.png", size, glyphs };
	}
	return null;
}

/* ---------- media ---------- */

export function collectMedia(maps: any[], withVideos: boolean) {
	const urls = new Map<string, string>();
	const kinds: Record<string, number> = {};
	let youtube = 0;
	for (const md of maps)
		for (const l of md.locations || [])
			for (const m of l.media || []) {
				const kind = m.type || (m.mime_type || "").split("/")[0] || "unknown";
				kinds[kind] = (kinds[kind] || 0) + 1;
				if (!m.url) continue;
				if (kind === "youtube") {
					youtube++;
					continue;
				}
				if (kind === "image" || withVideos) urls.set(m.url, kind);
			}
	let embedded = 0;
	for (const md of maps)
		for (const l of md.locations || [])
			for (const m of (l.description || "").matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g)) {
				embedded++;
				urls.set(m[1], "image");
			}
	return { urls, kinds, embedded, youtube };
}

export async function downloadMedia(
	urls: Map<string, string>,
	dir: string,
	opts: {
		concurrency: number;
		delay?: number;
		game?: string;
		mediaDb?: MediaDatabase;
		uploadMedia?: boolean;
		keepLocal?: boolean;
		s3?: { presign: (key: string, opts?: any) => string };
		mediaUrl?: string;
		getBinImpl?: typeof getBin;
		fetchImpl?: typeof fetch;
	},
) {
	const writeLocal = !opts.uploadMedia || Boolean(opts.keepLocal);
	if (writeLocal) await mkdir(dir, { recursive: true });
	const st = { saved: 0, uploaded: 0, skipped: 0, skippedCloud: 0, failed: 0, bytes: 0 };
	const names = new Map<string, string>();
	const cloudSet = opts.game && opts.mediaDb ? opts.mediaDb.uploadedSet(opts.game) : new Set<string>();
	const fetchBin = opts.getBinImpl || getBin;

	await pool([...urls.keys()], opts.concurrency, async (url) => {
		const name = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
		if (names.has(name) && names.get(name) !== url) console.log("  ! file name collision:", name);
		names.set(name, url);

		// Silently ignore any media already marked as uploaded to R2/S3 in the SQLite media table
		if (cloudSet.has(name) || (opts.game && opts.mediaDb?.has(opts.game, name))) {
			st.skippedCloud++;
			return;
		}

		const file = path.join(dir, name);
		if (!opts.uploadMedia && (await exists(file))) {
			st.skipped++;
			return;
		}

		// If uploading to R2 and the file is already on disk, upload the local copy instead of re-fetching MapGenie
		let buf: Buffer | undefined;
		if (opts.uploadMedia && (await exists(file))) {
			buf = Buffer.from(await Bun.file(file).arrayBuffer());
		} else {
			const r = await fetchBin(url);
			if (r.status === 200 && r.buf) {
				buf = r.buf;
			} else {
				st.failed++;
				console.log("  failed", url, r.status || r.error);
				if (opts.delay) await sleep(opts.delay);
				return;
			}
		}

		if (opts.uploadMedia) {
			if (!opts.game || !opts.s3 || !opts.mediaUrl || !opts.mediaDb) {
				throw new Error("uploadMedia requires game, s3, mediaUrl, and mediaDb");
			}
			const rec = await uploadAndVerifyBuffer({
				game: opts.game,
				originalName: name,
				buf,
				s3: opts.s3,
				mediaUrl: opts.mediaUrl,
				fetchImpl: opts.fetchImpl,
			});
			opts.mediaDb.record(rec);
			cloudSet.add(name);
			st.uploaded++;
			st.bytes += buf.length;
			if (opts.keepLocal) {
				if (!(await exists(file))) {
					await writeFile(file, buf);
					st.saved++;
				}
			} else if (await exists(file)) {
				await unlink(file).catch(() => {});
			}
		} else {
			await writeFile(file, buf);
			st.saved++;
			st.bytes += buf.length;
		}

		if (opts.delay) await sleep(opts.delay);
	});
	console.log(
		`  media: saved ${st.saved}${opts.uploadMedia ? `, uploaded ${st.uploaded}` : ""}, already had ${st.skipped}, skipped ${st.skippedCloud} (in cloud), failed ${st.failed}, ${mb(st.bytes)}`,
	);
	return st;
}

/* ---------- report: what is in this game, and what the viewer will not draw ---------- */

function report(_slug: string, maps: any[], sprite: any) {
	console.log("\n=== Report ===");
	for (const md of maps) {
		const cats: any[] = Object.values(md.categories || {});
		const types: Record<string, number> = {};
		cats.forEach((c) => {
			types[c.display_type || "marker"] = (types[c.display_type || "marker"] || 0) + 1;
		});
		const lines: string[] = [];
		lines.push(
			`map "${md.map?.slug}" (${md.map?.title}): ${md.locations.length} locations, ${cats.length} categories in ${(md.groups || []).length} groups, display types ${JSON.stringify(types)}`,
		);
		lines.push(`  tags: ${(md.tags || []).map((t: any) => t.title).join(", ") || "none"}`);
		for (const ts of md.mapConfig.tile_sets || [])
			lines.push(
				`  tile set "${ts.name}": zoom ${ts.min_zoom}-${ts.tiles_max_zoom ?? "?"} (view up to ${ts.max_zoom}), ${ts.extension}, pattern ${ts.pattern}`,
			);
		const warn: string[] = [];
		const f = md.locations.filter((l: any) => l.features).length;
		if (f) warn.push(`${f} locations carry "features" (lines/polygons)`);
		if ((md.regions || []).length) warn.push(`${md.regions.length} regions`);
		if ((md.roads || []).length) warn.push(`${md.roads.length} roads`);
		if ((md.routes || []).length) warn.push(`${md.routes.length} routes`);
		if ((md.heatmapCategories || []).length) warn.push("heatmaps");
		if (Object.keys(types).some((t) => t !== "marker"))
			warn.push(
				`non-marker categories: ${Object.keys(types)
					.filter((t) => t !== "marker")
					.join(", ")}`,
			);
		if (md.mapConfig.overlay) warn.push("map overlay");
		if ((md.mapConfig.tile_sets || []).length > 1) warn.push("several tile sets");
		const prem = cats.filter((c) => c.premium).length;
		if (prem) warn.push(`${prem} premium categories`);
		if ((md.proCategoryLocationCounts || []).length)
			warn.push("proCategoryLocationCounts is not empty: some locations are Pro-only and are NOT in this data");
		console.log(lines.join("\n"));
		console.log(warn.length ? "  not rendered / incomplete: " + warn.join("; ") : "  nothing unusual");
	}
	if (sprite)
		console.log(
			`markers: ${sprite.sprites} icons, @2x ${sprite.json2x ? "yes" : "no"}, categories without an icon in the sprite: ${sprite.missingIcons.length ? sprite.missingIcons.join(", ") : "none"}`,
		);
	else console.log("markers: no sprite found (the viewer needs a generic pin fallback for this game)");
}

/* ---------- theme: every colour of a game page is derived from one accent ---------- */

// group colours come without "#"; very dark or grey ones make a poor accent
function vividHex(c?: string): string | null {
	if (!/^#?[0-9a-f]{6}$/i.test(c || "")) return null;
	const [h, s, l] = hexToHsl("#" + c!.replace("#", ""));
	return hslToHex(h, Math.max(s, 0.45), Math.min(Math.max(l, 0.42), 0.55));
}
export function deriveTheme(accent: string): ThemePalette {
	const [h, s, al] = hexToHsl(accent),
		tint = (sat: number, l: number) => hslToHex(h, Math.min(sat, s), l);
	return {
		accent,
		"accent-soft": hslToHex(h, Math.min(s, 0.7), Math.min(0.78, al + 0.22)),
		night: tint(0.3, 0.035),
		panel: tint(0.3, 0.065),
		"panel-2": tint(0.28, 0.095),
		line: tint(0.25, 0.17),
	};
}

/* ---------- poster: homepage variants, and a theme derived from the picture ---------- */

let magickBin: string | null | undefined;
async function magick(args: string[], opts: Record<string, any> = {}): Promise<Buffer | null> {
	if (magickBin === undefined) {
		magickBin = null;
		for (const bin of ["magick", "convert"]) {
			if (Bun.which(bin)) {
				magickBin = bin;
				break;
			}
		}
	}
	if (!magickBin) return null;
	try {
		const proc = Bun.spawn([magickBin, ...args], { stdout: "pipe", stderr: "ignore", ...opts });
		const out = await new Response(proc.stdout).arrayBuffer();
		const exit = await proc.exited;
		if (exit !== 0) return null;
		return Buffer.from(out);
	} catch {
		return null;
	}
}

async function posterVariants(file: string, dir: string, force: boolean): Promise<boolean> {
	for (const w of [600, 1200]) {
		const out = path.join(dir, `poster-${w}.webp`);
		if (!force && (await exists(out))) continue;
		if (!(
			(await magick([
				file,
				"-auto-orient",
				"-resize",
				`${w}x${w / 2}^`,
				"-gravity",
				"center",
				"-extent",
				`${w}x${w / 2}`,
				"-quality",
				"82",
				out,
			])) || (await exists(out))
		))
			return false;
	}
	return true;
}

export async function accentFromPoster(file: string): Promise<string | null> {
	const W = 96,
		H = 54;
	const raw = await magick([file, "-auto-orient", "-resize", `${W}x${H}!`, "-depth", "8", "rgb:-"]);
	if (!raw || raw.length < W * H * 3) return null;
	const BINS = 24,
		bins = Array.from({ length: BINS }, () => ({ w: 0, s: 0, l: 0, h: 0 }));
	for (let i = 0; i < W * H; i++) {
		const hex = "#" + [0, 1, 2].map((k) => raw[i * 3 + k].toString(16).padStart(2, "0")).join("");
		const [h, sat, l] = hexToHsl(hex);
		const chroma = sat * (1 - Math.abs(2 * l - 1));
		if (chroma < 0.05) continue;
		const b = bins[Math.floor(h / (360 / BINS)) % BINS];
		b.w += chroma;
		b.s += sat * chroma;
		b.l += l * chroma;
		b.h += h * chroma;
	}
	const score = (i: number) => bins[i].w + 0.5 * (bins[(i + 1) % BINS].w + bins[(i + BINS - 1) % BINS].w);
	let best = 0;
	for (let i = 1; i < BINS; i++) if (score(i) > score(best)) best = i;
	const b = bins[best];
	if (!b.w) return null;
	const h = b.h / b.w,
		sat = b.s / b.w,
		l = b.l / b.w;
	return hslToHex(h, Math.min(0.75, Math.max(0.4, sat)), Math.min(0.5, Math.max(0.38, l)));
}

/* ---------- the game page: its maps, as links, in the order they are displayed ---------- */

const isShared = (host: string) => /(^|\.)mapgenie\.io$/i.test(host);
async function listGameMaps(pageUrl: string, game: string | null | undefined) {
	const { html, url } = await getPage(pageUrl);
	const here = new URL(url);
	const maps: { slug: string; url: string }[] = [];
	for (const m of html.matchAll(/href="([^"#?]*\/maps\/([a-z0-9][a-z0-9-]*))\/?(?:[?#][^"]*)?"/gi)) {
		let u: URL;
		try {
			u = new URL(m[1].replace(/&amp;/g, "&"), url);
		} catch {
			continue;
		}
		if (u.origin !== here.origin) continue;
		if (game && isShared(here.hostname) && !u.pathname.toLowerCase().startsWith(`/${game.toLowerCase()}/maps/`))
			continue;
		if (!maps.some((x) => x.slug === m[2])) maps.push({ slug: m[2], url: u.href });
	}
	if (!maps.length && !isShared(here.hostname)) {
		const inline = extractVar(html, "mapData", (v) => v && typeof v === "object" && v.map?.slug);
		if (inline) maps.push({ slug: inline.map.slug, url: here.href });
		for (const m of html.matchAll(/<a[^>]+class="[^"]*\bmap-link\b[^"]*"[^>]+href="([^"#?]+)"/gi)) {
			let u: URL;
			try {
				u = new URL(m[1].replace(/&amp;/g, "&"), url);
			} catch {
				continue;
			}
			if (u.origin !== here.origin) continue;
			const s = u.pathname.split("/").filter(Boolean).pop();
			if (s && !maps.some((x) => x.slug === s)) maps.push({ slug: s, url: u.href });
		}
	}
	return { maps, finalUrl: here };
}

/* ---------- main ---------- */

const guessTagLabel = (tags: any[]) =>
	tags.some((t) =>
		/casual|easy|normal|standard|hard|insane|insanity|nightmare|veteran|survival|legend/i.test(t.title),
	)
		? "Difficulty"
		: "Filter";

async function main() {
	const { values: v, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			out: { type: "string", default: "./public/maps" },
			id: { type: "string" },
			slug: { type: "string" },
			accent: { type: "string" },
			title: { type: "string" },
			poster: { type: "string" },
			"tag-label": { type: "string" },
			"default-tag": { type: "string" },
			index: { type: "string", default: "./public/maps/index.json" },
			"max-zoom": { type: "string" },
			"all-tilesets": { type: "boolean", default: false },
			videos: { type: "boolean", default: false },
			"no-tiles": { type: "boolean", default: false },
			"no-media": { type: "boolean", default: false },
			"upload-media": { type: "boolean", default: false },
			"keep-local": { type: "boolean", default: false },
			"no-markers": { type: "boolean", default: false },
			"no-cards": { type: "boolean", default: false },
			"no-icons": { type: "boolean", default: false },
			"no-clean-markers": { type: "boolean", default: false },
			"no-optimize": { type: "boolean", default: false },
			"icons-only": { type: "boolean", default: false },
			html: { type: "string" },
			mapdata: { type: "string" },
			game: { type: "string" },
			"map-url": { type: "string" },
			"tiles-base": { type: "string" },
			"media-base": { type: "string", default: "https://media.mapgenie.io/v2/assets/prod/games" },
			concurrency: { type: "string", default: "4" },
			delay: { type: "string", default: "100" },
			"max-tiles": { type: "string", default: "400000" },
			"force-get-tiles": { type: "string", multiple: true, default: [] },
		},
	});
	if (!positionals[0]) {
		console.error("Usage: bun scripts/add-game.ts https://mapgenie.io/<game> [options]");
		process.exit(1);
	}
	const uploadMedia = Boolean(v["upload-media"]) && !v["no-media"];
	const r2Cfg = uploadMedia ? validateR2Env() : null;
	const r2Client = r2Cfg ? createR2Client(r2Cfg) : undefined;
	const opts = {
		concurrency: +v.concurrency!,
		delay: +v.delay!,
		maxTiles: +v["max-tiles"]!,
		maxZoom: v["max-zoom"] ? +v["max-zoom"] : undefined,
	};
	const forceTiles = new Set(v["force-get-tiles"]);

	const given = new URL(positionals[0]);
	const givenSegs = given.pathname.split("/").filter(Boolean);
	let origin = given.origin;
	let dedicated = !isShared(given.hostname);
	const isGameLink = dedicated ? !givenSegs.includes("maps") : givenSegs[1] !== "maps";
	const gameSlug = dedicated ? v.game : givenSegs[0];
	if (!dedicated && !gameSlug) throw new Error("Give the game link, e.g. https://mapgenie.io/pragmata");
	let startUrl = given;
	let slug: string | null | undefined = dedicated ? null : gameSlug;
	const mapUrl = (ms: string) =>
		new URL(
			v["map-url"] ? v["map-url"].replace("{map}", ms) : dedicated ? `/maps/${ms}` : `/${slug}/maps/${ms}`,
			origin,
		).href;

	let mapOrder: { slug: string; url: string }[] | null = null;
	if (!v.mapdata) {
		try {
			const listed = await listGameMaps(
				dedicated ? `${origin}/` : `${origin}/${gameSlug}`,
				dedicated ? null : gameSlug,
			);
			mapOrder = listed.maps;
			if (listed.finalUrl.origin !== origin) {
				origin = listed.finalUrl.origin;
				dedicated = !isShared(listed.finalUrl.hostname);
			}
		} catch (e: any) {
			if (isGameLink && !dedicated) throw new Error(`Could not read ${origin}/${gameSlug}: ${e.message}`);
			console.log(`  ! could not read the game page (${e.message}); using the map data for the map list`);
		}
		if (isGameLink) {
			if (mapOrder?.length) startUrl = new URL(mapOrder[0].url);
			else if (!dedicated) throw new Error(`No maps are listed on ${origin}/${gameSlug}. Check the link.`);
			else console.log("  ! no map links on the game page: reading that page itself as the first map");
		}
	}
	const segs = startUrl.pathname.split("/").filter(Boolean);
	let mapSlug = segs.includes("maps") ? segs[segs.indexOf("maps") + 1] : null;
	if (!dedicated) slug = segs[0] || slug;

	// 1. first page and its mapData
	let page: { html: string; url: string }, md0: any;
	if (v.mapdata) {
		md0 = JSON.parse(await readFile(v.mapdata, "utf8"));
		page = { html: v.html ? await readFile(v.html, "utf8") : "", url: startUrl.href };
	} else {
		page = v.html ? { html: await readFile(v.html, "utf8"), url: startUrl.href } : await getPage(startUrl.href);
		const landed = new URL(page.url);
		if (landed.origin !== origin) {
			origin = landed.origin;
			dedicated = !isShared(landed.hostname);
		}
		md0 = await loadMapData(page.html, origin, slug ?? null, startUrl.href).catch((e) => {
			throw new Error("Loading map data failed: " + e.message);
		});
		if (!isMapData(md0))
			throw new Error(
				"Could not find window.mapData (with locations) for this page. Save the page and use --html, or use --mapdata with the console snippet.",
			);
	}
	const html = page.html;
	if (!dedicated) {
		const finalSegs = new URL(page.url).pathname.split("/").filter(Boolean);
		if (finalSegs[0]) slug = finalSegs[0];
	}
	mapSlug = md0.map?.slug || mapSlug || "map";

	// 2. every map of the game, in the order the game page lists them
	const bySlug = new Map<string, any>([[mapSlug!, md0]]);
	if (!v.mapdata) {
		const urlOf = new Map((mapOrder || []).map((m) => [m.slug, m.url]));
		for (const ms of mapOrder?.length ? mapOrder.map((m) => m.slug) : (md0.maps || []).map((m: any) => m.slug)) {
			if (bySlug.has(ms)) continue;
			try {
				const p = await getPage(urlOf.get(ms) || mapUrl(ms));
				const md = await loadMapData(p.html, origin, slug ?? null, p.url);
				if (isMapData(md)) bySlug.set(ms, md);
				else console.log(`  ! no mapData on map "${ms}"`);
			} catch (e: any) {
				console.log(`  ! could not load map "${ms}": ${e.message}`);
			}
		}
	}
	const maps = (mapOrder?.length ? mapOrder.map((m) => m.slug) : [...bySlug.keys()])
		.map((ms) => bySlug.get(ms))
		.filter(Boolean);
	console.log(`Maps, in page order: ${maps.map((m) => m.map?.slug).join(", ")}`);

	const game = extractVar(html, "game") || {};
	const cdnUrl = game.config?.cdn_url || "https://cdn.mapgenie.io";
	if (v.game) slug = v.game;
	else if (!slug)
		slug =
			game.slug ||
			(html.match(/\/games\/([a-z0-9][a-z0-9-]*)\/markers\//i) || [])[1] ||
			(html.match(/game-icons\/([a-z0-9][a-z0-9-]*)\//i) || [])[1] ||
			null;
	if (!slug)
		throw new Error(
			"Could not tell the game's MapGenie name from the page: give it with --game <name> (e.g. fallout-4).",
		);
	const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1];
	const id = v.id || slug;
	const pageSlug = v.slug || id;
	const title = v.title || game.title || (ogTitle ? ogTitle.replace(/\s*(Interactive )?Map.*$/i, "").trim() : slug);
	const outDir = path.join(v.out!, pageSlug);
	await mkdir(outDir, { recursive: true });
	if (v["icons-only"]) {
		const metaFile = path.join(outDir, "meta.json");
		if (!(await exists(metaFile)))
			throw new Error(`${metaFile} not found: add the game first (without --icons-only)`);
		const icons = await downloadIcons({ html, origin, slug, outDir }).catch((e) => {
			console.log("  ! icons:", e.message);
			return null;
		});
		const meta = JSON.parse(await readFile(metaFile, "utf8"));
		meta.icons = icons;
		await writeFile(metaFile, JSON.stringify(meta, null, 2) + "\n");
		console.log(
			icons
				? `icons: ${Object.keys(icons.glyphs).length} glyphs in ${(icons as any).font || (icons as any).image}`
				: "! no icon font for this game: the sidebar keeps the marker sprite",
		);
		return;
	}
	console.log(`Game "${title}" (${slug}) -> ${outDir}, ${maps.length} map(s)`);

	const cats = maps.flatMap((m) => Object.values(m.categories || {}));
	const tags = maps[0].tags || [];

	// 3. markers
	let sprite = null;
	if (!v["no-markers"]) {
		sprite = await downloadMarkers({
			html,
			slug,
			mediaBase: v["media-base"]!.replace(/\/$/, ""),
			outDir,
			cats,
			origin,
			cdnUrl,
		});
	}
	report(slug, maps, sprite);
	const icons = v["no-icons"]
		? null
		: await downloadIcons({ html, origin, slug, outDir }).catch((e) => {
				console.log("  ! icons:", e.message);
				return null;
			});
	console.log(
		icons
			? `icons: ${Object.keys(icons.glyphs).length} category glyphs in ${(icons as any).font || (icons as any).image}`
			: "! no icon font for this game: the sidebar will use the marker sprite",
	);

	// 4. per map: data + tiles
	if (!v["no-clean-markers"]) {
		const cleaned = cleanGameMarkers(
			maps.map((md, idx) => ({ slug: md.map?.slug || "map", isDefault: idx === 0, data: md })),
		);
		if (cleaned.linksCleaned > 0) {
			console.log(
				`markers: cleaned ${cleaned.linksCleaned} same-map link(s) across ${cleaned.locationsChanged} marker(s)`,
			);
		}
	}
	const tilesBases: string[] = [];
	if (v["tiles-base"]) tilesBases.push(v["tiles-base"].replace(/\/$/, ""));
	const cdn = extractVar(html, "tilesCdnUrl", (x) => typeof x === "string");
	if (cdn) tilesBases.push(cdn.replace(/\/$/, "") + "/games", cdn.replace(/\/$/, ""));
	tilesBases.push("https://tiles.mapgenie.io/games");

	const metaMaps: any[] = [];
	const tileJobs: any[] = [];
	for (const md of maps) {
		const ms = md.map?.slug || "map";
		const dir = path.join(outDir, ms);
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "data.json"), JSON.stringify(md));
		const sets = [...(md.mapConfig.tile_sets || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		const chosen = v["all-tilesets"] ? sets : sets.slice(0, 1);
		const entry = { slug: ms, title: md.map?.title || ms, data: `${ms}/data.json`, tilesets: [] as any[] };
		for (const ts of chosen) {
			const key = (ts.path || "").split("/").filter(Boolean).pop() || `ts${ts.id}`;
			const tail = ts.pattern.slice(ts.pattern.indexOf("{"));
			const localTail = `tiles/${key}/${tail}`;
			const info: any = {
				name: ts.name,
				template: `${ms}/${localTail}`,
				minzoom: ts.min_zoom ?? 0,
				maxzoom: ts.tiles_max_zoom ?? ts.max_zoom,
				viewMaxzoom: ts.max_zoom,
				bounds: boundsFor(md, ts).bounds,
				tileSize: 256,
			};
			if (opts.maxZoom != null) info.maxzoom = Math.min(info.maxzoom ?? 99, opts.maxZoom);
			entry.tilesets.push(info);
			if (!v["no-tiles"]) tileJobs.push({ md, ts, ms, dir, localTail, info });
		}
		metaMaps.push(entry);
	}

	// 5. poster
	let poster: string | null = null;
	const existingPoster = (await readdir(outDir)).find((f) => /^poster\.(jpe?g|png|webp|avif)$/i.test(f));
	const posterSrc =
		v.poster ||
		(existingPoster
			? null
			: (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1]);
	try {
		if (posterSrc && /^https?:/.test(posterSrc)) {
			const r = await getBin(posterSrc);
			if (r.status === 200 && r.buf && r.type) {
				const ext = (r.type.split("/")[1] || "jpg").split(";")[0].replace("jpeg", "jpg");
				poster = `poster.${ext}`;
				await writeFile(path.join(outDir, poster), r.buf);
			}
		} else if (posterSrc) {
			poster = "poster" + path.extname(posterSrc).toLowerCase();
			if (path.resolve(posterSrc) !== path.resolve(outDir, poster))
				await copyFile(posterSrc, path.join(outDir, poster));
		} else if (existingPoster) poster = existingPoster;
	} catch (e: any) {
		console.log("  ! poster failed:", e.message);
	}
	const posterFile = poster ? path.join(outDir, poster) : null;
	const variants = posterFile ? await posterVariants(posterFile, outDir, !!v.poster) : false;
	if (posterFile)
		console.log(
			`  poster: ${poster}${variants ? " + poster-600.webp / poster-1200.webp" : " (ImageMagick not found: no webp variants, the homepage will use the original file)"}`,
		);

	// 7. meta.json for the game and the homepage manifest
	const prevMeta = (await exists(path.join(outDir, "meta.json")))
		? JSON.parse(await readFile(path.join(outDir, "meta.json"), "utf8"))
		: null;
	const meta = {
		id,
		title,
		slug,
		source: positionals[0],
		poster,
		tagLabel: v["tag-label"] || guessTagLabel(tags),
		defaultTag: v["default-tag"] || null,
		markers: sprite
			? { json: sprite.json, png: sprite.png, json2x: sprite.json2x, png2x: sprite.png2x }
			: v["no-markers"]
				? (prevMeta?.markers ?? null)
				: null,
		icons: v["no-icons"] ? (prevMeta?.icons ?? null) : icons,
		maps: metaMaps,
	};
	const writeMeta = () => writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
	await writeMeta();

	// 8. homepage manifest
	let index: { games: any[] } = { games: [] };
	if (await exists(v.index!)) index = JSON.parse(await readFile(v.index!, "utf8"));
	const prev = index.games.find((g) => g.slug === pageSlug) || {};
	const posterAccent =
		posterFile && (v.poster || !prev.theme) && !v.accent ? await accentFromPoster(posterFile) : null;
	const accent = v.accent || posterAccent || vividHex(maps[0].groups?.[0]?.color) || "#d6453b";
	const newTheme = !prev.theme || v.accent || (v.poster && posterAccent);
	if (newTheme)
		console.log(
			`  theme: accent ${accent} (${v.accent ? "--accent" : posterAccent ? "from the poster" : "from the game's first group colour"})`,
		);
	const posterRef = !poster ? undefined : variants ? `${pageSlug}/poster` : `${pageSlug}/${poster}`;
	const entry: Record<string, any> = {
		id: prev.id || id,
		slug: pageSlug,
		title: prev.title || title,
		description: prev.description || `Every marker on the ${title} map.`,
		poster: (v.poster ? posterRef : prev.poster) || posterRef,
		posterAlt: prev.posterAlt,
		theme: newTheme ? deriveTheme(accent) : prev.theme,
		stats: [
			{ value: maps.reduce((n, m) => n + m.locations.length, 0), label: "markers" },
			{ value: cats.length, label: "categories" },
		],
		tagLabel: prev.tagLabel || meta.tagLabel,
		defaultTag: prev.defaultTag ?? meta.defaultTag,
	};
	for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
	const at = index.games.findIndex((g) => g.slug === pageSlug);
	if (at >= 0) index.games[at] = entry;
	else index.games.push(entry);
	await writeFile(v.index!, JSON.stringify(index, null, 2) + "\n");
	console.log(
		`\nWrote ${path.join(outDir, "meta.json")} and updated ${v.index}; the game is now listed, fetching tiles and media`,
	);

	// 10. tiles, then media
	for (const m of forceTiles)
		if (!maps.some((md) => md.map?.slug === m)) console.log(`! --force-get-tiles: no map "${m}" in this game`);
	for (const { md, ts, ms, dir, localTail, info } of tileJobs) {
		console.log(`\nTiles for ${ms} / ${ts.name}`);
		const r = await downloadTiles({
			md,
			ts,
			baseCandidates: tilesBases,
			destDir: dir,
			localTail,
			opts: { ...opts, unpruned: forceTiles.has(ms) },
		});
		info.minzoom = r.minzoom;
		info.maxzoom = r.maxzoom;
		if (opts.maxZoom != null) info.maxzoom = Math.min(info.maxzoom ?? 99, opts.maxZoom);
		// the overview (lowest zoom) from the highest, single-colour tiles as links, and the colour around the map.
		// A forced map keeps the whole pyramid it was asked for; prune-tiles.ts can thin it out later.
		const split = splitTemplate(info.template);
		if (!v["no-optimize"] && !v["no-tiles"] && split) {
			const o = await optimizeTileset({
				dir: path.join(outDir, split.base),
				tail: split.tail,
				minZ: info.minzoom ?? 0,
				maxZ: info.maxzoom ?? 0,
				prune: false,
				background: info.background,
				concurrency: opts.concurrency,
			});
			console.log(
				`  overview: ${o.overview} tile(s) made; ${o.solid} single-colour tiles linked (-${mb(o.solidFreed)})`,
			);
			if (o.background && !info.background) info.background = o.background;
		}
		await writeMeta();
	}

	const { urls, kinds, embedded, youtube } = collectMedia(maps, Boolean(v.videos));
	console.log(
		`\nMedia: ${JSON.stringify(kinds)}${embedded ? `, ${embedded} images embedded in descriptions` : ""}${youtube ? `, ${youtube} YouTube videos (embedded, not downloaded)` : ""}; ${urls.size} file(s) to fetch${v.videos ? "" : " (images only; use --videos for the rest)"}`,
	);
	if (!v["no-media"] && urls.size) {
		const mediaDb = openMediaDb();
		try {
			await downloadMedia(urls, path.join(outDir, "media"), {
				...opts,
				game: pageSlug,
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
	console.log(`\nDone: ${outDir}`);

	// 11. social preview cards for the homepage and every game, and their tags (make-cards.ts)
	if (!v["no-cards"]) {
		const here = path.dirname(fileURLToPath(import.meta.url));
		try {
			const proc = Bun.spawn([process.execPath, path.join(here, "make-cards.ts")], {
				cwd: path.dirname(here),
				stdout: "inherit",
				stderr: "pipe",
			});
			const exit = await proc.exited;
			if (exit !== 0) {
				const err = await new Response(proc.stderr).text();
				throw new Error(err || `make-cards.ts exited with code ${exit}`);
			}
			console.log("Cards rebuilt (make-cards.ts).");
		} catch (e: any) {
			console.log(
				'! Cards not rebuilt, run "bun scripts/make-cards.ts" by hand:',
				String(e.stderr || e.message)
					.trim()
					.split("\n")
					.slice(-1)[0],
			);
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}