// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// lootatlas.ts: Scraper and ingestion pipeline for Loot Atlas games (https://app.lootatlas.com).

import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { splitTemplate } from "../server/tile-engine.ts";
import { fmt } from "../src/shared/escape.ts";
import { fnv } from "../src/shared/sync-rules.ts";
import { hexToHsl, hslToHex } from "../src/shared/theme-math.ts";
import type { ThemePalette } from "../src/shared/types.ts";
import {
	accentFromPoster,
	type AddGamePipelineOptions,
	collectMedia,
	deriveTheme,
	downloadMedia,
	downloadTiles,
	expandHome,
	posterVariants,
} from "./add-game.ts";
import { optimizeTileset } from "./prune-tiles.ts";
import { createPruneDashboard } from "./tui/prune-dashboard.js";
import { createR2Client, openMediaDb, validateR2Env } from "./upload-media.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const API_BASE = "https://api.lootatlas.com/api/v1";
const TILES_BASE = "https://tiles.lootatlas.com";
const mb = (n: number) => (n / 1e6).toFixed(1) + " MB";

const exists = (p: string) => Bun.file(p).exists();

export interface LootAtlasGame {
	id: string;
	name: string;
	slug: string;
	description?: string;
	imageUri?: string;
	imageLandscapeUri?: string;
	imageBlurUri?: string;
	imageLandscapeBlurUri?: string;
	tags?: Array<{ id: string; name: string; color?: string }>;
}

export interface LootAtlasMap {
	id: string;
	name: string;
	slug: string;
	description?: string;
	centerLat?: number;
	centerLng?: number;
	centerZoom?: number;
	pinZoom?: number;
	mapBackgroundColor?: string;
	thumbnailUri?: string;
	levels: Array<{
		id: string;
		order: number;
		bucketPath: string;
		maxZoom: number;
		transparent?: boolean;
		minX?: number | null;
		maxX?: number | null;
		minY?: number | null;
		maxY?: number | null;
	}>;
}

export interface LootAtlasCategory {
	id: string;
	name: string;
	color: string;
	iconUri: string;
}

export interface LootAtlasStrategy {
	id: string;
	name: string;
	description?: string;
	type: "BASE" | "FORK" | string;
	status: "PUBLIC" | "PRIVATE" | string;
	map?: {
		id: string;
		name: string;
		slug: string;
	};
	polygons?: Array<{
		id: string;
		name: string;
		color?: string;
		centerLat?: number;
		centerLong?: number;
		polygon?: {
			type: "Polygon";
			coordinates: Array<Array<{ lat: number; lng: number }>>;
		};
	}>;
}

export interface LootAtlasPin {
	id: string;
	name: string;
	lat: number;
	long: number;
	thumbnailUri?: string | null;
	category: {
		id: string;
		name: string;
		color?: string;
		iconUri?: string;
	};
	content?: Array<{
		id: string;
		type: "TEXT" | "IMAGE" | string;
		content: string;
	}>;
}

export function isLootAtlas(url: string): boolean {
	try {
		const u = new URL(url);
		return u.hostname === "lootatlas.com" || u.hostname.endsWith(".lootatlas.com");
	} catch {
		return false;
	}
}

export function parseLootAtlasSlug(urlOrSlug: string): string {
	const raw = urlOrSlug.trim();
	if (raw.includes("://") || raw.startsWith("/")) {
		try {
			const u = new URL(raw, "https://app.lootatlas.com");
			const segs = u.pathname.split("/").filter(Boolean);
			const gamesIdx = segs.indexOf("games");
			if (gamesIdx >= 0 && segs[gamesIdx + 1]) {
				return decodeURIComponent(segs[gamesIdx + 1]);
			}
			const stratIdx = segs.indexOf("strategies");
			if (stratIdx >= 0 && segs[stratIdx + 1]) {
				return decodeURIComponent(segs[stratIdx + 1]);
			}
			if (segs.length > 0) {
				return decodeURIComponent(segs[segs.length - 1]);
			}
		} catch {}
	}
	return decodeURIComponent(raw);
}

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "item"
	);
}

export function iconSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "icon"
	);
}

async function apiGet<T>(endpoint: string): Promise<T> {
	const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}/${endpoint.replace(/^\//, "")}`;
	const res = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} for ${url}`);
	}
	return (await res.json()) as T;
}

export async function fetchLootAtlasGames(): Promise<LootAtlasGame[]> {
	return await apiGet<LootAtlasGame[]>("games");
}

export async function resolveLootAtlasGame(slugOrUrl: string): Promise<LootAtlasGame> {
	const slug = parseLootAtlasSlug(slugOrUrl);
	const games = await fetchLootAtlasGames();
	const norm = slug.toLowerCase();
	let match = games.find(
		(g) => g.slug === slug || g.slug.toLowerCase() === norm || g.name.toLowerCase() === norm || g.id === slug,
	);
	if (!match) {
		const available = games.map((g) => `  - ${g.name} (${g.slug})`).join("\n");
		throw new Error(`Game "${slug}" not found on Loot Atlas. Available games:\n${available}`);
	}
	try {
		const det = await apiGet<LootAtlasGame>(`games/${match.id}`);
		match = { ...match, ...det };
	} catch {}
	return match;
}

export async function fetchLootAtlasCategories(gameId: string): Promise<LootAtlasCategory[]> {
	return await apiGet<LootAtlasCategory[]>(`games/${gameId}/categories`);
}

export async function fetchLootAtlasMaps(gameId: string): Promise<LootAtlasMap[]> {
	return await apiGet<LootAtlasMap[]>(`games/${gameId}/maps`);
}

export async function fetchLootAtlasStrategies(gameId: string): Promise<LootAtlasStrategy[]> {
	const res = await apiGet<{ data: LootAtlasStrategy[] }>(`strategies/game/${gameId}`);
	return res.data || [];
}

export async function fetchLootAtlasPins(strategyId: string): Promise<LootAtlasPin[]> {
	return await apiGet<LootAtlasPin[]>(`strategies/${strategyId}/pins`);
}

export async function detectLootAtlasMaxZoom(
	bucketPath: string,
	declaredMaxZoom: number,
	locations: { latitude: string; longitude: string }[],
	centerLat = 0,
	centerLng = 0,
): Promise<{ maxZoom: number; minZoom: number }> {
	const base = bucketPath.replace(/^http:\/\//, "https://");
	const startZ = Math.min(Math.max(declaredMaxZoom, 0), 16);

	// Check minZoom (usually 0, but some games start at zoom 1)
	let minZoom = 0;
	try {
		const res0 = await fetch(`${base}/0/0/0?format=webp`, { headers: { "User-Agent": UA } });
		const len0 = Number(res0.headers.get("content-length")) || 0;
		const type0 = res0.headers.get("content-type") || "";
		if (!res0.ok || len0 < 100 || type0.includes("png")) {
			minZoom = 1;
		}
	} catch {
		minZoom = 0;
	}

	for (let z = startZ; z >= minZoom; z--) {
		const maxCoord = 1 << z;
		const candidates: [number, number][] = [];

		// Center coordinate
		const midX = Math.max(0, Math.min(maxCoord - 1, Math.floor(((centerLng + 180) / 360) * maxCoord)));
		const latRad = (Math.max(-85, Math.min(85, centerLat)) * Math.PI) / 180;
		const midY = Math.max(
			0,
			Math.min(
				maxCoord - 1,
				Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * maxCoord),
			),
		);
		candidates.push([midX, midY]);

		// Sample up to 8 locations
		for (let i = 0; i < Math.min(locations.length, 8); i++) {
			const lat = parseFloat(locations[i].latitude);
			const lng = parseFloat(locations[i].longitude);
			if (Number.isFinite(lat) && Number.isFinite(lng)) {
				const x = Math.max(0, Math.min(maxCoord - 1, Math.floor(((lng + 180) / 360) * maxCoord)));
				const lRad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
				const y = Math.max(
					0,
					Math.min(
						maxCoord - 1,
						Math.floor(((1 - Math.log(Math.tan(lRad) + 1 / Math.cos(lRad)) / Math.PI) / 2) * maxCoord),
					),
				);
				candidates.push([x, y]);
			}
		}

		for (const [x, y] of candidates) {
			try {
				const res = await fetch(`${base}/${z}/${y}/${x}?format=webp`, {
					headers: { "User-Agent": UA },
				});
				const len = Number(res.headers.get("content-length")) || 0;
				const type = res.headers.get("content-type") || "";
				// Non-existent tiles return 68-byte 1x1 PNG fallback
				if (res.ok && len >= 100 && !type.includes("json") && !type.includes("png")) {
					return { maxZoom: z, minZoom };
				}
			} catch {}
		}
	}

	return { maxZoom: Math.max(minZoom, declaredMaxZoom - 1), minZoom };
}

export function convertPolygonsToRegions(polygons: LootAtlasStrategy["polygons"], mapId: number): any[] {
	if (!polygons || !polygons.length) return [];
	return polygons.map((poly, idx) => {
		const regionId = 5000 + idx;
		const coords = (poly.polygon?.coordinates || []).map((ring) => ring.map((pt) => [pt.lng, pt.lat]));
		for (const ring of coords) {
			if (ring.length > 0) {
				const first = ring[0];
				const last = ring[ring.length - 1];
				if (first[0] !== last[0] || first[1] !== last[1]) {
					ring.push([first[0], first[1]]);
				}
			}
		}

		return {
			id: regionId,
			map_id: mapId,
			parent_region_id: null,
			title: poly.name,
			subtitle: null,
			features: [
				{
					id: regionId,
					type: "Feature",
					geometry: {
						type: "Polygon",
						coordinates: coords,
					},
					properties: {
						id: regionId,
						color: poly.color || null,
					},
				},
			],
			center_x: poly.centerLong ?? null,
			center_y: poly.centerLat ?? null,
			order: idx + 1,
		};
	});
}

export async function generateLootAtlasSpriteSheet(
	categories: LootAtlasCategory[],
	outDir: string,
): Promise<{ json: string; png: string; json2x: string; png2x: string; sprites: number }> {
	const sharp = (await import("sharp")).default;
	const count = categories.length;
	const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
	const rows = Math.max(1, Math.ceil(count / cols));

	const pinW1x = 33,
		pinH1x = 44;
	const pinW2x = 66,
		pinH2x = 88;

	const sheetW1x = cols * pinW1x;
	const sheetH1x = rows * pinH1x;
	const sheetW2x = cols * pinW2x;
	const sheetH2x = rows * pinH2x;

	const defs1x: Record<string, any> = {};
	const defs2x: Record<string, any> = {};

	const composites1x: any[] = [];
	const composites2x: any[] = [];

	for (let i = 0; i < categories.length; i++) {
		const c = categories[i];
		const iconSlug = slugify(c.name);
		const col = i % cols;
		const row = Math.floor(i / cols);

		const x1x = col * pinW1x;
		const y1x = row * pinH1x;
		const x2x = col * pinW2x;
		const y2x = row * pinH2x;

		defs1x[iconSlug] = { width: pinW1x, height: pinH1x, x: x1x, y: y1x, pixelRatio: 1 };
		defs2x[iconSlug] = { width: pinW2x, height: pinH2x, x: x2x, y: y2x, pixelRatio: 2 };

		const color = c.color && c.color !== "#fff" && c.color !== "#ffffff" ? c.color : "#d6453b";

		let iconBuf: Buffer | null = null;
		if (c.iconUri) {
			try {
				const r = await fetch(c.iconUri);
				if (r.ok) {
					iconBuf = Buffer.from(await r.arrayBuffer());
				}
			} catch {}
		}

		// 1x pin teardrop
		const pinSvg1x = `
<svg width="${pinW1x}" height="${pinH1x}" viewBox="0 0 33 44" xmlns="http://www.w3.org/2000/svg">
  <path d="M 16.5 42 C 16.5 42 2 24 2 15 A 14.5 14.5 0 1 1 31 15 C 31 24 16.5 42 16.5 42 Z"
        fill="${color}" stroke="#18181b" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="16.5" cy="15" r="11" fill="#18181b" opacity="0.18"/>
</svg>`;
		let pinImg1x = sharp(Buffer.from(pinSvg1x));
		if (iconBuf) {
			const res1x = await sharp(iconBuf).resize(18, 18, { fit: "contain" }).toBuffer();
			pinImg1x = pinImg1x.composite([{ input: res1x, top: 6, left: 7 }]);
		}
		const pinBuf1x = await pinImg1x.png().toBuffer();
		composites1x.push({ input: pinBuf1x, left: x1x, top: y1x });

		// 2x pin teardrop
		const pinSvg2x = `
<svg width="${pinW2x}" height="${pinH2x}" viewBox="0 0 66 88" xmlns="http://www.w3.org/2000/svg">
  <path d="M 33 84 C 33 84 4 48 4 30 A 29 29 0 1 1 62 30 C 62 48 33 84 33 84 Z"
        fill="${color}" stroke="#18181b" stroke-width="4" stroke-linejoin="round"/>
  <circle cx="33" cy="30" r="22" fill="#18181b" opacity="0.18"/>
</svg>`;
		let pinImg2x = sharp(Buffer.from(pinSvg2x));
		if (iconBuf) {
			const res2x = await sharp(iconBuf).resize(36, 36, { fit: "contain" }).toBuffer();
			pinImg2x = pinImg2x.composite([{ input: res2x, top: 12, left: 15 }]);
		}
		const pinBuf2x = await pinImg2x.png().toBuffer();
		composites2x.push({ input: pinBuf2x, left: x2x, top: y2x });
	}

	const blank1x = await sharp({
		create: {
			width: sheetW1x,
			height: sheetH1x,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite(composites1x)
		.png()
		.toBuffer();

	const blank2x = await sharp({
		create: {
			width: sheetW2x,
			height: sheetH2x,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite(composites2x)
		.png()
		.toBuffer();

	await writeFile(path.join(outDir, "markers.png"), blank1x);
	await writeFile(path.join(outDir, "markers@2x.png"), blank2x);
	await writeFile(path.join(outDir, "markers.json"), JSON.stringify(defs1x, null, 2) + "\n");
	await writeFile(path.join(outDir, "markers@2x.json"), JSON.stringify(defs2x, null, 2) + "\n");

	return {
		json: "markers.json",
		png: "markers.png",
		json2x: "markers@2x.json",
		png2x: "markers@2x.png",
		sprites: count,
	};
}

export async function executeLootAtlasPipeline(
	p: AddGamePipelineOptions,
	log: (msg: string) => void = console.log,
): Promise<void> {
	p.onStage?.("Connecting to Loot Atlas");
	log(`Connecting to Loot Atlas API for ${p.url}...`);

	const game = await resolveLootAtlasGame(p.url);
	const slug = p.slug || p.id || slugify(game.slug) || slugify(game.name);
	const id = p.id || slug;
	const title = p.title || game.name;
	const outDir = path.join(p.out || "./public/maps", slug);
	await mkdir(outDir, { recursive: true });

	log(`Game "${title}" (${slug}) -> ${outDir}`);

	p.onStage?.("Fetching Categories & Maps");
	const [categories, maps, strategies] = await Promise.all([
		fetchLootAtlasCategories(game.id),
		fetchLootAtlasMaps(game.id),
		fetchLootAtlasStrategies(game.id),
	]);

	log(`Found ${maps.length} map(s), ${categories.length} category(ies), and ${strategies.length} strategy(ies)`);

	// Sprite sheet generation
	let sprite: any = null;
	if (!p.noMarkers && categories.length > 0) {
		p.onStage?.("Generating Marker Sprites");
		log(`Generating sprite sheet for ${categories.length} categories with sharp...`);
		sprite = await generateLootAtlasSpriteSheet(categories, outDir);
		log(`  markers: ${sprite.sprites} icons (@2x yes) generated in ${outDir}`);
	}

	// Map category IDs to sequential integers 100..N
	const catIdMap = new Map<string, number>();
	const catDict: Record<string, any> = {};
	const catArray: any[] = [];
	for (let i = 0; i < categories.length; i++) {
		const c = categories[i];
		const numId = 100 + i;
		catIdMap.set(c.id, numId);
		const catObj = {
			id: numId,
			group_id: 1,
			title: c.name,
			icon: slugify(c.name),
			info: null,
			order: i + 1,
			color: c.color || null,
		};
		catDict[String(numId)] = catObj;
		catArray.push(catObj);
	}

	const baseStrats = strategies.filter((s) => s.type === "BASE");

	// Map data preparation
	const metaMaps: any[] = [];
	const tileJobs: any[] = [];
	const dataMaps: any[] = [];
	let globalMediaCounter = 1;

	for (let mIdx = 0; mIdx < maps.length; mIdx++) {
		const m = maps[mIdx];
		const ms = slugify(m.slug || m.name);
		const mapId = mIdx + 1;
		const mapDir = path.join(outDir, ms);
		await mkdir(mapDir, { recursive: true });

		// Match base strategy for this map
		const strat =
			baseStrats.find((s) => s.map?.id === m.id || s.map?.slug === m.slug || slugify(s.name) === ms) ||
			strategies.find((s) => s.map?.id === m.id || s.map?.slug === m.slug || slugify(s.name) === ms);

		let pins: LootAtlasPin[] = [];
		if (strat) {
			log(`  Fetching pins for map "${m.name}" (strategy: ${strat.name})...`);
			pins = await fetchLootAtlasPins(strat.id).catch((e) => {
				log(`  ! could not fetch pins for strategy ${strat.id}: ${e.message}`);
				return [];
			});
		}

		// Convert pins to locations
		const locations: any[] = [];
		for (let pIdx = 0; pIdx < pins.length; pIdx++) {
			const pin = pins[pIdx];
			const locId = Number.parseInt(fnv(pin.id), 16) & 0x7fffffff || pIdx + 1;
			const catId = catIdMap.get(pin.category?.id) || 100;

			const textBlocks: string[] = [];
			const locMedia: any[] = [];

			for (const block of pin.content || []) {
				if (block.type === "TEXT" && block.content?.trim()) {
					textBlocks.push(block.content.trim());
				} else if (block.type === "IMAGE" && block.content?.trim()) {
					const imgUrl = block.content.trim();
					textBlocks.push(`![${pin.name}](${imgUrl})`);
					locMedia.push({
						id: globalMediaCounter++,
						title: pin.name,
						file_name: path.basename(new URL(imgUrl).pathname),
						url: imgUrl,
						type: "image",
						mime_type: "image/png",
						order: locMedia.length + 1,
						spoiler: false,
					});
				}
			}

			if (pin.thumbnailUri) {
				const thumbUrl = pin.thumbnailUri.trim();
				if (!locMedia.some((m) => m.url === thumbUrl)) {
					locMedia.push({
						id: globalMediaCounter++,
						title: `${pin.name} Thumbnail`,
						file_name: path.basename(new URL(thumbUrl).pathname),
						url: thumbUrl,
						type: "image",
						mime_type: "image/png",
						order: locMedia.length + 1,
						spoiler: false,
					});
				}
			}

			locations.push({
				id: locId,
				uuid: pin.id,
				map_id: mapId,
				region_id: null,
				category_id: catId,
				title: pin.name || "Marker",
				description: textBlocks.join("\n\n"),
				latitude: String(pin.lat),
				longitude: String(pin.long),
				features: null,
				ign_page_id: null,
				tags: [],
				media: locMedia,
			});
		}

		const regions = convertPolygonsToRegions(strat?.polygons, mapId);

		// Prepare mapConfig tile_sets
		const level = m.levels?.[0] || {
			id: "level1",
			bucketPath: `tiles/games/${game.id}/maps/${m.id}/level1`,
			maxZoom: 4,
		};
		const bucketRel = level.bucketPath.replace(/^https?:\/\/[^/]+\//, "");

		const { maxZoom: actualMaxZoom, minZoom } = !p.noTiles
			? await detectLootAtlasMaxZoom(
					level.bucketPath,
					level.maxZoom ?? 4,
					locations,
					m.centerLat ?? 0,
					m.centerLng ?? 0,
				)
			: { maxZoom: level.maxZoom ?? 4, minZoom: 0 };

		log(`  ${m.name}: max tile zoom detected as ${actualMaxZoom} (declared ${level.maxZoom ?? 4})`);

		const tilePattern = `${bucketRel}/{z}/{y}/{x}?format=webp`;
		const localTail = `tiles/default/{z}/{y}/{x}.webp`;

		const tileBoundsObj: Record<string, { x: { min: number; max: number }; y: { min: number; max: number } }> = {};
		for (let z = minZoom; z <= actualMaxZoom; z++) {
			const maxCoord = 1 << z;
			if (
				level.minX != null &&
				level.maxX != null &&
				level.minY != null &&
				level.maxY != null &&
				z === actualMaxZoom
			) {
				tileBoundsObj[z] = {
					x: { min: level.minX, max: level.maxX },
					y: { min: level.minY, max: level.maxY },
				};
			} else if (z <= 4) {
				tileBoundsObj[z] = {
					x: { min: 0, max: maxCoord - 1 },
					y: { min: 0, max: maxCoord - 1 },
				};
			} else if (locations.length > 0) {
				let minX = maxCoord,
					maxX = 0,
					minY = maxCoord,
					maxY = 0;
				for (const loc of locations) {
					const lat = parseFloat(loc.latitude);
					const lng = parseFloat(loc.longitude);
					if (Number.isFinite(lat) && Number.isFinite(lng)) {
						const x = Math.floor(((lng + 180) / 360) * maxCoord);
						const latRad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
						const y = Math.floor(
							((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * maxCoord,
						);
						if (x < minX) minX = x;
						if (x > maxX) maxX = x;
						if (y < minY) minY = y;
						if (y > maxY) maxY = y;
					}
				}
				const pad = 2;
				tileBoundsObj[z] = {
					x: { min: Math.max(0, minX - pad), max: Math.min(maxCoord - 1, maxX + pad) },
					y: { min: Math.max(0, minY - pad), max: Math.min(maxCoord - 1, maxY + pad) },
				};
			} else {
				tileBoundsObj[z] = {
					x: { min: 0, max: maxCoord - 1 },
					y: { min: 0, max: maxCoord - 1 },
				};
			}
		}

		const effectiveMaxZoom = p.maxZoom != null ? Math.min(actualMaxZoom, p.maxZoom) : actualMaxZoom;

		const tileSet = {
			id: mapId * 10 + 1,
			map_id: mapId,
			name: "Default",
			path: `${slug}/${ms}/tiles/default`,
			extension: "webp",
			pattern: tilePattern,
			min_zoom: minZoom,
			max_zoom: effectiveMaxZoom,
			tiles_max_zoom: effectiveMaxZoom,
			order: 0,
			bounds: tileBoundsObj,
		};

		const md = {
			map: { id: mapId, title: m.name, slug: ms },
			mapConfig: {
				tile_sets: [tileSet],
				initial_zoom: m.centerZoom ?? 2,
				start_lat: m.centerLat ?? 0,
				start_lng: m.centerLng ?? 0,
				overlay: null,
				overzoom: false,
				circle_locations_interactive: true,
				coordinate_grid: null,
			},
			groups: [
				{
					id: 1,
					game_id: 1,
					title: "General",
					order: 1,
					color: (categories[0]?.color || "#d6453b").replace("#", ""),
					categories: catArray,
				},
			],
			categories: catDict,
			locations,
			regions,
		};

		dataMaps.push(md);
		await writeFile(path.join(mapDir, "data.json"), JSON.stringify(md));

		const metaEntry = {
			slug: ms,
			title: m.name || ms,
			data: `${ms}/data.json`,
			tilesets: [
				{
					name: "Default",
					template: `${ms}/${localTail}`,
					minzoom: minZoom,
					maxzoom: effectiveMaxZoom,
					viewMaxzoom: Math.max(actualMaxZoom, level.maxZoom ?? actualMaxZoom),
					bounds: [-180, -85.051129, 180, 85.051129],
					tileSize: 256,
					background: m.mapBackgroundColor || "#000000",
				},
			],
		};
		metaMaps.push(metaEntry);

		if (!p.noTiles) {
			tileJobs.push({
				md,
				ts: tileSet,
				ms,
				dir: mapDir,
				localTail,
				info: metaEntry.tilesets[0],
			});
		}
	}

	// Poster download & processing
	p.onStage?.("Processing Poster & Theme");
	let poster: string | null = null;
	const posterUrl = game.imageLandscapeUri || game.imageUri;
	if (posterUrl && /^https?:/.test(posterUrl)) {
		try {
			const res = await fetch(posterUrl, { headers: { "User-Agent": UA } });
			if (res.ok) {
				const buf = Buffer.from(await res.arrayBuffer());
				const ctype = res.headers.get("content-type") || "image/jpeg";
				const ext = (ctype.split("/")[1] || "jpg").split(";")[0].replace("jpeg", "jpg");
				poster = `poster.${ext}`;
				await writeFile(path.join(outDir, poster), buf);
			}
		} catch (e: any) {
			log(`  ! could not download poster: ${e.message}`);
		}
	}

	const posterFile = poster ? path.join(outDir, poster) : null;
	const variants = posterFile ? await posterVariants(posterFile, outDir, !!p.poster) : false;

	// Accent and theme
	const posterAccent = posterFile && !p.accent ? await accentFromPoster(posterFile) : null;
	const defaultAccent = categories[0]?.color ? hslToHex(...hexToHsl(categories[0].color)) : "#d6453b";
	const accent = p.accent || posterAccent || defaultAccent;
	const theme = deriveTheme(accent);

	// Write meta.json
	const meta = {
		id,
		title,
		slug,
		source: p.url,
		poster,
		tagLabel: p.tagLabel || "Filter",
		defaultTag: p.defaultTag || null,
		markers: sprite ? { json: sprite.json, png: sprite.png, json2x: sprite.json2x, png2x: sprite.png2x } : null,
		icons: null,
		maps: metaMaps,
	};
	const writeMeta = () => writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
	await writeMeta();

	// Update homepage manifest (public/maps/index.json)
	const indexPath = p.index || "./public/maps/index.json";
	let index: { games: any[] } = { games: [] };
	if (await exists(indexPath)) {
		try {
			index = JSON.parse(await readFile(indexPath, "utf8"));
		} catch {}
	}
	const prevIndex = index.games.find((g) => g.slug === slug) || {};
	const posterRef = !poster ? undefined : variants ? `${slug}/poster` : `${slug}/${poster}`;
	const manifestEntry: Record<string, any> = {
		id: prevIndex.id || id,
		slug,
		title: prevIndex.title || title,
		description: game.description || prevIndex.description || `Interactive map and locations for ${title}.`,
		poster: (p.poster ? posterRef : prevIndex.poster) || posterRef,
		posterAlt: prevIndex.posterAlt,
		theme: prevIndex.theme || theme,
		stats: [
			{ value: dataMaps.reduce((n, m) => n + m.locations.length, 0), label: "markers" },
			{ value: categories.length, label: "categories" },
		],
		tagLabel: prevIndex.tagLabel || meta.tagLabel,
		defaultTag: prevIndex.defaultTag ?? meta.defaultTag,
	};
	for (const k of Object.keys(manifestEntry)) {
		if (manifestEntry[k] === undefined) delete manifestEntry[k];
	}
	const at = index.games.findIndex((g) => g.slug === slug);
	if (at >= 0) index.games[at] = manifestEntry;
	else index.games.push(manifestEntry);
	await writeFile(indexPath, JSON.stringify(index, null, "\t") + "\n");
	log(`Wrote ${path.join(outDir, "meta.json")} and updated ${indexPath}`);

	// Tile download
	const stagingBase = path.resolve(p.cacheDir || "./cache/updates", slug);
	if (p.redownloadTiles && !p.noTiles && tileJobs.length > 0) {
		await rm(stagingBase, { recursive: true, force: true });
		await mkdir(stagingBase, { recursive: true });
	}

	const tileBaseCandidates = [p.tilesBase || TILES_BASE];

	for (const { md, ts, ms, dir, localTail, info } of tileJobs) {
		const targetDir = p.redownloadTiles ? path.join(stagingBase, ms) : dir;
		log(`\nTiles for ${ms} / ${ts.name}${p.redownloadTiles ? " (atomic staging)" : ""}`);
		const r = await downloadTiles({
			md,
			ts,
			baseCandidates: tileBaseCandidates,
			destDir: targetDir,
			localTail,
			opts: {
				concurrency: p.concurrency ?? 16,
				delay: p.delay ?? 0,
				adaptive: p.adaptive ?? true,
				minConcurrency: p.minConcurrency,
				maxConcurrency: p.maxConcurrency,
				maxTiles: p.maxTiles ?? 400000,
				maxZoom: p.maxZoom,
				noTui: p.noTui,
				gameTitle: title,
				gameSlug: slug,
				mapSlug: ms,
				tilesetName: ts.name,
				container: p.container,
				renderer: p.renderer,
			},
		});

		info.minzoom = r.minzoom;
		info.maxzoom = r.maxzoom;
		if (p.maxZoom != null) info.maxzoom = Math.min(info.maxzoom ?? 99, p.maxZoom);

		const split = splitTemplate(info.template);
		if (!p.noOptimize && !p.noTiles && split) {
			p.onStage?.(`Optimizing Tiles: ${ms}`);
			let pruneDash: any = null;
			if (p.container && p.renderer) {
				pruneDash = await createPruneDashboard({
					container: p.container,
					renderer: p.renderer,
					totalTilesets: 1,
				});
				pruneDash.startTileset(title, ts.name || ms, 0);
			}
			try {
				const optDir = p.redownloadTiles ? path.join(stagingBase, split.base) : path.join(outDir, split.base);
				const o = await optimizeTileset({
					dir: optDir,
					tail: split.tail,
					minZ: info.minzoom ?? 0,
					maxZ: info.maxzoom ?? 0,
					prune: false,
					background: info.background,
					concurrency: p.concurrency ?? 16,
					onProgress: pruneDash ? (ev) => pruneDash.onProgress(ev) : undefined,
				});
				if (pruneDash) {
					pruneDash.finishTileset(o);
					await pruneDash.finish();
				}
				log(
					`  overview: ${o.overview} tile(s) made; ${o.solid} single-colour tiles linked (-${mb(o.solidFreed)})`,
				);
				if (o.background && !info.background) info.background = o.background;
			} finally {
				if (pruneDash) pruneDash.destroy();
			}
		}
		await writeMeta();
	}

	if (p.redownloadTiles && !p.noTiles && tileJobs.length > 0) {
		p.onStage?.("Swapping Staged Tiles");
		log(`  Swapping staged tiles into ${outDir}...`);
		for (const md of dataMaps) {
			const ms = md.map?.slug || "map";
			const stagedTilesDir = path.join(stagingBase, ms, "tiles");
			const targetTilesDir = path.join(outDir, ms, "tiles");
			if (await exists(stagedTilesDir)) {
				await rm(targetTilesDir, { recursive: true, force: true });
				await mkdir(path.dirname(targetTilesDir), { recursive: true });
				await rename(stagedTilesDir, targetTilesDir);
			}
		}
		await rm(stagingBase, { recursive: true, force: true });
		log(`  ✓ Atomic tile update complete for ${slug}`);
	}

	// Media download
	const { urls, kinds, embedded, youtube } = collectMedia(dataMaps, Boolean(p.videos));
	log(
		`\nMedia: ${JSON.stringify(kinds)}${embedded ? `, ${embedded} images embedded in descriptions` : ""}${youtube ? `, ${youtube} YouTube videos` : ""}; ${urls.size} file(s) to fetch`,
	);
	if (!p.noMedia && urls.size) {
		p.onStage?.("Downloading Media Assets");
		const uploadMedia = Boolean(p.uploadMedia);
		const r2Cfg = uploadMedia ? validateR2Env() : null;
		const r2Client = r2Cfg ? createR2Client(r2Cfg) : undefined;
		const mediaDb = openMediaDb();
		try {
			await downloadMedia(urls, path.join(outDir, "media"), {
				concurrency: p.concurrency ?? 16,
				delay: p.delay ?? 0,
				adaptive: p.adaptive ?? true,
				game: slug,
				mediaDb,
				uploadMedia,
				keepLocal: Boolean(p.keepLocal),
				s3: r2Client,
				mediaUrl: r2Cfg?.mediaUrl,
				noTui: p.noTui,
				container: p.container,
				renderer: p.renderer,
			});
		} finally {
			mediaDb.close();
		}
	}

	// Preview cards
	if (!p.noCards) {
		p.onStage?.("Generating Preview Cards");
		const here = path.dirname(fileURLToPath(import.meta.url));
		try {
			const proc = Bun.spawn([process.execPath, path.join(here, "make-cards.ts"), "--only", slug, "--no-tui"], {
				cwd: path.dirname(here),
				stdout: p.onLog ? "pipe" : "inherit",
				stderr: "pipe",
			});
			const exit = await proc.exited;
			if (exit !== 0) {
				const err = await new Response(proc.stderr).text();
				throw new Error(err || `make-cards.ts exited with code ${exit}`);
			}
			log("Cards rebuilt (make-cards.ts).");
		} catch (e: any) {
			log(`! Cards not rebuilt: ${e.message}`);
		}
	}

	p.onStage?.("Completed");
	log(`\n✓ Successfully scraped and added Loot Atlas game "${title}" (${slug})`);
}