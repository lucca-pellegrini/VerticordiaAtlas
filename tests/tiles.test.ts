// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import { downloadTiles } from "../scripts/add-game.ts";
import { fullyCovered, listTiles, optimizeTileset } from "../scripts/prune-tiles.ts";
import { createApi } from "../server/api.ts";
import { parseSize, TileCache } from "../server/tile-cache.ts";
import {
	decodeTile,
	dedupeSolid,
	deriveRaw,
	encodeTile,
	ops,
	parseBackground,
	parseTail,
	parseTilePath,
	placeTile,
	solidKey,
	splitTemplate,
	tileInBounds,
	tilePath,
} from "../server/tile-engine.ts";
import { createTileService } from "../server/tile-service.ts";
import type { TilesetMeta } from "../src/shared/types.ts";

let tmp: string;
beforeEach(async () => {
	tmp = await mkdtemp(path.join(os.tmpdir(), "atlas-tiles-"));
});
afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

// a 256 x 256 tile of one colour, as a file's bytes
const solid = (r: number, g: number, b: number, ext = "png"): Promise<Buffer> => {
	const raw = Buffer.alloc(256 * 256 * 4);
	for (let i = 0; i < raw.length; i += 4) raw.set([r, g, b, 255], i);
	return encodeTile(raw, ext);
};

// a tile with a diagonal gradient that differs per tile, so it is never a single colour
const gradient = (seed: number): Promise<Buffer> => {
	const raw = Buffer.alloc(256 * 256 * 4);
	for (let y = 0; y < 256; y++)
		for (let x = 0; x < 256; x++)
			raw.set([(x + seed * 7) % 256, (y + seed * 13) % 256, (x + y + seed) % 256, 255], (y * 256 + x) * 4);
	return encodeTile(raw, "png");
};

const put = async (file: string, buf: Buffer) => {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, buf);
};
const pixel = (raw: Buffer, x: number, y: number) => [...raw.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];

describe("tile paths", () => {
	test("templates are split and read in either axis order", () => {
		expect(parseTail("{z}/{y}/{x}.jpg")).toEqual({ order: ["z", "y", "x"], ext: "jpg" });
		expect(parseTail("{z}/{x}/{y}.PNG")).toEqual({ order: ["z", "x", "y"], ext: "png" });
		expect(parseTail("{z}/{x}/{x}.png")).toBeNull();
		expect(parseTail("tiles.png")).toBeNull();
		const s = splitTemplate("world/tiles/default-v2/{z}/{y}/{x}.jpg")!;
		expect(s.base).toBe("world/tiles/default-v2/");
		expect(tilePath(s.tail, 5, 7, 9)).toBe("5/9/7.jpg"); // z/y/x
		expect(parseTilePath(s.tail, "5/9/7.jpg")).toEqual({ z: 5, x: 7, y: 9 });
		expect(parseTilePath(s.tail, "5/9/7.png")).toBeNull();
		expect(parseTilePath(s.tail, "2/9/7.jpg")).toBeNull(); // outside the zoom's grid
		expect(parseTilePath(s.tail, "../9/7.jpg")).toBeNull();
	});

	test("tileInBounds keeps tiles near the box and drops far ones", () => {
		const box = [-1.4, 0, 0, 1.4];
		expect(tileInBounds(box, 0, 0, 0)).toBe(true);
		expect(tileInBounds(box, 8, 127, 127)).toBe(true);
		expect(tileInBounds(box, 8, 0, 0)).toBe(false);
		expect(tileInBounds(undefined, 8, 0, 0)).toBe(true);
	});

	test("parseBackground accepts #rrggbb only", () => {
		expect(parseBackground("#102030")).toEqual([16, 32, 48, 255]);
		expect(parseBackground("red")).toBeNull();
		expect(parseBackground(undefined)).toBeNull();
	});
});

describe("tile engine", () => {
	test("solidKey tells a flat tile from a drawn one", async () => {
		expect(solidKey(await decodeTile(await solid(10, 20, 30)))).toBe("0a141eff");
		expect(solidKey(await decodeTile(await gradient(1)))).toBeNull();
	});

	test("deriveRaw stitches four tiles into one half the size, and fills a missing quarter", async () => {
		const colours: Record<string, number[]> = {
			"2,2": [200, 0, 0],
			"3,2": [0, 200, 0],
			"2,3": [0, 0, 200],
		};
		const read = async (z: number, x: number, y: number) => {
			const c = z === 2 ? colours[`${x},${y}`] : null;
			return c ? solid(c[0], c[1], c[2]) : null;
		};
		const raw = (await deriveRaw(1, 1, 1, { maxZoom: 2, read, background: [9, 9, 9, 255] }))!;
		expect(pixel(raw, 20, 20).slice(0, 3)).toEqual([200, 0, 0]);
		expect(pixel(raw, 230, 20).slice(0, 3)).toEqual([0, 200, 0]);
		expect(pixel(raw, 20, 230).slice(0, 3)).toEqual([0, 0, 200]);
		expect(pixel(raw, 230, 230)).toEqual([9, 9, 9, 255]); // the missing quarter
		expect(await deriveRaw(1, 0, 0, { maxZoom: 2, read })).toBeNull(); // nothing below at all
		expect(await deriveRaw(2, 2, 2, { maxZoom: 2, read })).toBeNull(); // nothing is made at the stored zoom
	});

	test("deriveRaw recurses through several zooms and reports the tiles made on the way", async () => {
		const made: string[] = [];
		const raw = await deriveRaw(0, 0, 0, {
			maxZoom: 3,
			read: async (z) => (z === 3 ? solid(50, 60, 70) : null),
			store: async (z, x, y) => void made.push(`${z}/${x}/${y}`),
		});
		expect(solidKey(raw!)?.slice(0, 6)).toBe("323c46");
		expect(made.length).toBe(4 + 16); // zoom 1 and 2 are made; zoom 3 is stored
		expect(made).not.toContain("0/0/0"); // the requested tile is the caller's to store
	});

	test("placeTile hard-links single-colour tiles to one copy and stores others as they are", async () => {
		const dir = path.join(tmp, "set");
		const flat = await solid(0, 0, 0);
		await placeTile(path.join(dir, "3/1/1.png"), flat, { key: "000000ff", dir, ext: "png" });
		await placeTile(path.join(dir, "3/1/2.png"), flat, { key: "000000ff", dir, ext: "png" });
		const a = await stat(path.join(dir, "3/1/1.png")),
			b = await stat(path.join(dir, "3/1/2.png"));
		expect(a.ino).toBe(b.ino);
		expect(a.nlink).toBe(3); // two tiles and the stored copy
		const grad = await gradient(1);
		await placeTile(path.join(dir, "3/1/3.png"), grad, null);
		expect((await stat(path.join(dir, "3/1/3.png"))).nlink).toBe(1);
		expect((await readdir(path.join(dir, "3/1"))).sort()).toEqual(["1.png", "2.png", "3.png"]); // no temporary files left
	});
});

describe("a stored copy that has run out of hard links", () => {
	// file systems allow only so many links to a file (65000 on ext4): here, a copy and two tiles
	const realLink = ops.link;
	beforeEach(() => {
		ops.link = async (existing, target) => {
			if ((await stat(existing)).nlink >= 3) throw Object.assign(new Error("too many links"), { code: "EMLINK" });
			return realLink(existing, target);
		};
	});
	afterEach(() => {
		ops.link = realLink;
	});

	test("placeTile starts the next copy of the colour", async () => {
		const dir = path.join(tmp, "set");
		const flat = await solid(7, 7, 7);
		for (let i = 0; i < 5; i++)
			await placeTile(path.join(dir, `3/0/${i}.png`), flat, { key: "070707ff", dir, ext: "png" });
		const names = (await readdir(dir)).filter((f) => f.startsWith("solid-")).sort();
		expect(names).toEqual(["solid-070707ff-1.png", "solid-070707ff-2.png", "solid-070707ff.png"]);
		for (let i = 0; i < 5; i++)
			expect(solidKey(await decodeTile(await readFile(path.join(dir, `3/0/${i}.png`))))).toBe("070707ff");
		expect((await readdir(path.join(dir, "3/0"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("dedupeSolid does the same for tiles already on disk, and a second run changes nothing", async () => {
		const dir = path.join(tmp, "set");
		const flat = await solid(9, 9, 9);
		for (let i = 0; i < 6; i++) await put(path.join(dir, `3/0/${i}.png`), flat);
		const tail = parseTail("{z}/{x}/{y}.png")!;
		for (const t of await listTiles(dir, tail))
			expect((await dedupeSolid(t.file, dir, "png"))?.key).toBe("090909ff");
		const inodes = new Set<number>();
		for (let i = 0; i < 6; i++) inodes.add((await stat(path.join(dir, `3/0/${i}.png`))).ino);
		expect(inodes.size).toBe(3); // two tiles to a copy
		const before = (await readdir(dir)).sort();
		for (const t of await listTiles(dir, tail)) expect((await dedupeSolid(t.file, dir, "png"))?.freed).toBe(0);
		expect((await readdir(dir)).sort()).toEqual(before);
		expect((await readdir(path.join(dir, "3/0"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("optimizeTileset finishes a tile set with more flat tiles than one copy can hold", async () => {
		const dir = path.join(tmp, "big");
		const tail = parseTail("{z}/{x}/{y}.png")!;
		const flat = await solid(0, 0, 0);
		for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) await put(path.join(dir, `3/${x}/${y}.png`), flat);
		const r = await optimizeTileset({ dir, tail, minZ: 3, maxZ: 3 });
		expect(r.solid).toBe(64);
		expect(r.background).toBe("#000000");
	});
});

describe("scripts/prune-tiles", () => {
	// a full pyramid, zoom 1 to 3 (z/x/y.png): drawn tiles inside, black tiles at the right edge of zoom 3
	async function pyramid(dir: string, opts: { without?: string[]; overview?: boolean } = {}) {
		for (let z = opts.overview === false ? 2 : 1; z <= 3; z++)
			for (let x = 0; x < 2 ** z; x++)
				for (let y = 0; y < 2 ** z; y++) {
					if (opts.without?.includes(`${z}/${x}/${y}`)) continue;
					const black = z === 3 && x >= 6;
					await put(
						path.join(dir, `${z}/${x}/${y}.png`),
						black ? await solid(0, 0, 0) : await gradient(z * 100 + x * 8 + y),
					);
				}
	}
	const tail = parseTail("{z}/{x}/{y}.png")!;

	test("fullyCovered needs all four tiles below, down to the stored zoom", () => {
		const t3 = [];
		for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) if (!(x === 7 && y === 7)) t3.push({ z: 3, x, y });
		const full = fullyCovered(t3, 1, 3);
		expect(full.get(2)!.size).toBe(15); // (3,3) lacks a child
		expect(full.get(2)!.has("3,3")).toBe(false);
		expect(full.has(1)).toBe(false); // the overview zoom is never deleted
	});

	test("single-colour tiles are linked, the overview is kept, intermediate zooms are deleted", async () => {
		const dir = path.join(tmp, "tiles");
		await pyramid(dir, { overview: false }); // zoom 2 and 3 only: a scraped map has no overview yet
		const r = await optimizeTileset({ dir, tail, minZ: 1, maxZ: 3 });
		expect(r.solid).toBe(16); // two columns of black tiles: 2 x 8
		expect(r.background).toBe("#000000");
		expect(r.overview).toBe(4);
		expect(r.pruned).toBe(16);
		const left = await listTiles(dir, tail);
		expect(left.filter((t) => t.z === 1).length).toBe(4);
		expect(left.filter((t) => t.z === 2).length).toBe(0);
		expect(left.filter((t) => t.z === 3).length).toBe(64);
		const a = await stat(path.join(dir, "3/6/0.png")),
			b = await stat(path.join(dir, "3/7/7.png"));
		expect(a.ino).toBe(b.ino);
		// the overview tile over the black corner is made from black tiles and one drawn column: not flat
		expect(await readdir(dir)).toContain("solid-000000ff.png");
		// running it again changes nothing
		const again = await optimizeTileset({ dir, tail, minZ: 1, maxZ: 3 });
		expect([again.overview, again.pruned, again.solidFreed]).toEqual([0, 0, 0]);
	});

	test("a tile with a gap below it is kept, and every tile of a map without its highest zoom is kept", async () => {
		const dir = path.join(tmp, "gap");
		await pyramid(dir, { without: ["3/0/0"] });
		const r = await optimizeTileset({ dir, tail, minZ: 1, maxZ: 3 });
		expect(r.pruned).toBe(15);
		const left = await listTiles(dir, tail);
		expect(left.filter((t) => t.z === 2).map((t) => `${t.x},${t.y}`)).toEqual(["0,0"]);

		const lone = path.join(tmp, "lone");
		await put(path.join(lone, "2/0/0.png"), await gradient(1));
		await put(path.join(lone, "1/0/0.png"), await gradient(2));
		const r2 = await optimizeTileset({ dir: lone, tail, minZ: 0, maxZ: 3 });
		expect(r2.pruned).toBe(0);
		expect(r2.overview).toBe(1); // the overview is made from what there is
		expect((await listTiles(lone, tail)).map((t) => t.z).sort()).toEqual([0, 1, 2]);
	});

	test("--dry-run reports and changes nothing", async () => {
		const dir = path.join(tmp, "dry");
		await pyramid(dir);
		const before = (await listTiles(dir, tail)).length;
		const r = await optimizeTileset({ dir, tail, minZ: 1, maxZ: 3, dryRun: true });
		expect(r.pruned).toBe(16);
		expect(r.solid).toBe(16);
		expect((await listTiles(dir, tail)).length).toBe(before);
		expect((await stat(path.join(dir, "3/6/0.png"))).nlink).toBe(1);
	});
});

describe("tile cache", () => {
	test("sizes are read with units", () => {
		expect(parseSize("2GB")).toBe(2 * 1024 ** 3);
		expect(parseSize("512 mb")).toBe(512 * 1024 ** 2);
		expect(parseSize("1.5g")).toBe(1.5 * 1024 ** 3);
		expect(parseSize("1000")).toBe(1000);
		expect(parseSize("lots")).toBeNull();
		expect(parseSize(undefined)).toBeNull();
	});

	const DAY = 86400000;
	async function fill(root: string, rel: string, bytes: number, ageDays: number) {
		const file = path.join(root, rel);
		await put(file, Buffer.alloc(bytes, 1));
		const t = new Date(Date.now() - ageDays * DAY);
		await utimes(file, t, t);
	}

	test("eviction deletes the oldest tiles, sooner for games nobody opens, and spares single-colour links", async () => {
		const root = path.join(tmp, "cache");
		await fill(root, "popular/map/set/1/0/old.png", 1000, 5);
		await fill(root, "quiet/map/set/1/0/old.png", 1000, 5);
		await fill(root, "popular/map/set/1/0/new.png", 1000, 1);
		await fill(root, "quiet/map/set/1/0/new.png", 1000, 1);
		await put(path.join(root, "quiet/map/set/solid-000000ff.png"), Buffer.alloc(500, 2));
		await link(path.join(root, "quiet/map/set/solid-000000ff.png"), path.join(root, "quiet/map/set/1/0/flat.png"));
		const cache = new TileCache({
			root,
			maxBytes: 4000,
			targetBytes: 2600,
			popularity: () => new Map([["popular", 100]]),
		});
		await cache.init();
		expect(cache.size).toBe(4500); // the linked file is counted once
		const r = await cache.evict();
		expect(r.removed).toBe(2);
		// a popular game's tiles count as up to a week newer: its five-day-old tile outlives the quiet game's day-old one
		expect(await readdir(path.join(root, "quiet/map/set/1/0"))).toEqual(["flat.png"]);
		expect((await readdir(path.join(root, "popular/map/set/1/0"))).sort()).toEqual(["new.png", "old.png"]);
		expect(cache.size).toBeLessThanOrEqual(2600);
	});

	test("a recently served tile outlives an older one, and adding past the limit starts a pass", async () => {
		const root = path.join(tmp, "cache2");
		await fill(root, "g/m/s/1/0/a.png", 1000, 3);
		await fill(root, "g/m/s/1/0/b.png", 1000, 3);
		const cache = new TileCache({ root, maxBytes: 2500, targetBytes: 2000 });
		await cache.init();
		cache.touch("g/m/s/1/0/a.png"); // a was served just now: b is the one to go
		await put(path.join(root, "g/m/s/1/0/c.png"), Buffer.alloc(1000, 1));
		await cache.added("g/m/s/1/0/c.png", 1000);
		await cache.evict();
		expect(await Bun.file(path.join(root, "g/m/s/1/0/b.png")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "g/m/s/1/0/a.png")).exists()).toBe(true);
	});
});

describe("tile service", () => {
	const ts: TilesetMeta = {
		name: "Default",
		template: "world/tiles/default/{z}/{y}/{x}.png",
		minzoom: 1,
		maxzoom: 3,
		bounds: [-180, -85, 180, 85],
	};

	async function setup() {
		const publicDir = path.join(tmp, "public");
		const stored = path.join(publicDir, "maps/game/world/tiles/default");
		for (let x = 0; x < 8; x++)
			for (let y = 0; y < 8; y++)
				await put(
					path.join(stored, `3/${y}/${x}.png`),
					x >= 6 ? await solid(0, 0, 0) : await gradient(x * 8 + y),
				);
		await put(path.join(stored, "1/0/0.png"), await gradient(99));
		const cache = new TileCache({ root: path.join(tmp, "cache") });
		const opened: string[] = [];
		const svc = createTileService({
			publicDir,
			cache,
			tilesets: async (g) => (g === "game" ? [ts] : null),
			onNewMap: (g, m) => void opened.push(`${g}/${m}`),
		});
		return { svc, cache, opened, publicDir };
	}

	test("a stored tile is served as it is; a missing one is made, cached, then served from the cache", async () => {
		const { svc, cache } = await setup();
		const stored = await svc.find("game", "world", "default", "3/2/2.png");
		expect(stored?.from).toBe("stored");

		const made = await svc.find("game", "world", "default", "2/1/1.png");
		expect(made?.from).toBe("made");
		expect(made!.file.startsWith(cache.root)).toBe(true);
		const img = await sharp(await readFile(made!.file)).metadata();
		expect([img.width, img.height, img.format]).toEqual([256, 256, "png"]);

		const again = await svc.find("game", "world", "default", "2/1/1.png");
		expect(again?.from).toBe("cache");
		expect(again!.file).toBe(made!.file);
		// the tiles made on the way are cached too: the four below zoom 2 are stored, so nothing more here, but zoom 2 came from them
		expect(cache.size).toBeGreaterThan(0);
	});

	test("what cannot be made is not found: outside the zooms, no tiles below, bad names, unknown games", async () => {
		const { svc } = await setup();
		expect(await svc.find("game", "world", "default", "0/0/0.png")).toBeNull(); // below the overview zoom
		expect(await svc.find("game", "world", "default", "4/0/0.png")).toBeNull(); // above the stored zoom
		expect(await svc.find("game", "world", "default", "3/9/9.png")).toBeNull(); // outside the grid
		expect(await svc.find("game", "world", "default", "2/1/1.jpg")).toBeNull(); // wrong format
		expect(await svc.find("game", "world", "other", "2/1/1.png")).toBeNull(); // unknown tile set
		expect(await svc.find("nope", "world", "default", "2/1/1.png")).toBeNull();
		expect(await svc.find("game", "..", "default", "2/1/1.png")).toBeNull();
		expect(await svc.find("game", "world", "default", "2/1/../1.png")).toBeNull();
	});

	test("a made single-colour tile is a link to one copy, and a map's popularity is noted once", async () => {
		const { svc, opened, cache } = await setup();
		// zoom 2 tiles over the black column (x = 3 in the {z}/{y}/{x} order, over zoom 3's x = 6 and 7) are flat
		const a = await svc.find("game", "world", "default", "2/0/3.png");
		const b = await svc.find("game", "world", "default", "2/1/3.png");
		expect(a?.from).toBe("made");
		expect(b?.from).toBe("made");
		expect((await stat(a!.file)).ino).toBe((await stat(b!.file)).ino);
		expect(await readdir(path.join(cache.root, "game/world/default"))).toContain("solid-000000ff.png");
		expect(opened).toEqual(["game/world"]);
	});

	test("serve returns HTTP 200 with headers and 304 on matching ETag", async () => {
		const { svc } = await setup();
		const req = new Request("http://localhost/maps/game/world/tiles/default/3/2/2.png");
		const res = await svc.serve(req, "game", "world", "default", "3/2/2.png");
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		expect(res!.headers.get("Content-Type")).toBe("image/png");
		const etag = res!.headers.get("ETag");
		expect(etag).not.toBeNull();

		// Conditional request with If-None-Match
		const req304 = new Request("http://localhost/maps/game/world/tiles/default/3/2/2.png", {
			headers: { "If-None-Match": etag! },
		});
		const res304 = await svc.serve(req304, "game", "world", "default", "3/2/2.png");
		expect(res304!.status).toBe(304);
	});
});

describe("scripts/add-game tile download", () => {
	// a fake tile CDN: zoom 1 to 3, with a gap at 3/0/0, which records what is asked for
	async function cdn() {
		const asked: string[] = [];
		const png = await solid(5, 5, 5);
		const server = http.createServer((req, res) => {
			asked.push(req.url!);
			const m = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(req.url!);
			if (!m || (m[1] === "3" && m[2] === "0" && m[3] === "0")) {
				res.writeHead(404);
				return res.end();
			}
			res.writeHead(200, { "Content-Type": "image/png" });
			res.end(png);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		return { asked, server, base: `http://127.0.0.1:${(server.address() as any).port}/tiles` };
	}
	const range = (n: number) => ({ x: { min: 0, max: n - 1 }, y: { min: 0, max: n - 1 } });
	const ts = {
		pattern: "{z}/{x}/{y}.png",
		min_zoom: 1,
		tiles_max_zoom: 3,
		bounds: { 1: range(2), 2: range(4), 3: range(8) },
	};
	const download = (c: { base: string }, dest: string, unpruned: boolean) =>
		downloadTiles({
			md: { locations: [] },
			ts,
			baseCandidates: [c.base],
			destDir: dest,
			localTail: "tiles/set/{z}/{x}/{y}.png",
			opts: { concurrency: 4, delay: 0, maxTiles: 100000, unpruned },
		});
	const zoomsAsked = (asked: string[]) => new Set(asked.map((u) => u.split("/")[2]));

	test("by default only the highest zoom is downloaded", async () => {
		const c = await cdn();
		try {
			const r = await download(c, path.join(tmp, "a"), false);
			expect(r.stats.saved).toBe(63); // 64 tiles, one of them missing
			expect(r.stats.missing).toBe(1);
			const tiles = await listTiles(path.join(tmp, "a/tiles/set"), parseTail("{z}/{x}/{y}.png")!);
			expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([3]));
			// the one probe at the lowest zoom finds the CDN; every other request is for the highest zoom
			expect(c.asked.filter((u) => !u.startsWith("/tiles/3/")).length).toBe(1);
		} finally {
			c.server.close();
		}
	});

	test("--force-get-tiles takes every zoom", async () => {
		const c = await cdn();
		try {
			const r = await download(c, path.join(tmp, "b"), true);
			expect(r.stats.saved).toBe(4 + 16 + 63);
			expect(zoomsAsked(c.asked)).toEqual(new Set(["1", "2", "3"]));
		} finally {
			c.server.close();
		}
	});

	test("when max-zoom bounds are missing, quadtree crawls and saves only the highest zoom", async () => {
		const c = await cdn();
		try {
			const tsNoMaxBounds = {
				pattern: "{z}/{x}/{y}.png",
				min_zoom: 1,
				tiles_max_zoom: 3,
				bounds: { 1: range(2) }, // bounds only at zoom 1, no bounds at zoom 3
			};
			const r = await downloadTiles({
				md: { locations: [] },
				ts: tsNoMaxBounds,
				baseCandidates: [c.base],
				destDir: path.join(tmp, "c"),
				localTail: "tiles/set/{z}/{x}/{y}.png",
				opts: { concurrency: 4, delay: 0, maxTiles: 100000, unpruned: false },
			});
			expect(r.stats.saved).toBe(63);
			const tiles = await listTiles(path.join(tmp, "c/tiles/set"), parseTail("{z}/{x}/{y}.png")!);
			expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([3]));
			expect(zoomsAsked(c.asked)).toEqual(new Set(["1", "2", "3"]));
		} finally {
			c.server.close();
		}
	});

	test("HTTP 200 with 68-byte 1x1 blank fallback is treated as missing and not saved", async () => {
		const asked: string[] = [];
		const blank68 = Buffer.from(
			"89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364600000000600023081d02f0000000049454e44ae426082",
			"hex",
		);
		const realTile = await solid(10, 20, 30);
		const server = http.createServer((req, res) => {
			asked.push(req.url!);
			const m = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(req.url!);
			// 3/0/0 returns the 68-byte 1x1 blank with status 200 (like Loot Atlas)
			if (m && m[1] === "3" && m[2] === "0" && m[3] === "0") {
				res.writeHead(200, { "Content-Type": "image/png" });
				return res.end(blank68);
			}
			res.writeHead(200, { "Content-Type": "image/png" });
			res.end(realTile);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as any).port}/tiles`;
		try {
			const r = await download({ base }, path.join(tmp, "d"), false);
			expect(r.stats.saved).toBe(63);
			expect(r.stats.missing).toBe(1);
			const existsBlank = await stat(path.join(tmp, "d/tiles/set/3/0/0.png")).catch(() => null);
			expect(existsBlank).toBeNull();
		} finally {
			server.close();
		}
	});
});

describe("game popularity", () => {
	test("requests are counted per game in SQLite", async () => {
		const api = createApi({ root: tmp });
		try {
			expect(api.gamePopularity().size).toBe(0);
			api.recordGameRequest("skyrim");
			api.recordGameRequest("skyrim");
			api.recordGameRequest("elden-ring");
			const pop = api.gamePopularity();
			expect(pop.get("skyrim")).toBe(2);
			expect(pop.get("elden-ring")).toBe(1);
		} finally {
			api.close();
		}
	});
});