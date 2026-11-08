// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeCompact } from "../scripts/compact-map.ts";
import { ensureDetails, mapData } from "../src/client/map/map-view.ts";
import { state } from "../src/client/map/state.ts";
import { fromCompact, isCompact, locsOfCompact, toCompact } from "../src/shared/compact-map.ts";

const geo = [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} }];
const full = () => ({
	map: { id: 1 },
	categories: { "7": { id: 7, title: "Chest", icon: "chest" } },
	groups: [],
	locations: [
		{
			id: 10,
			map_id: 1,
			region_id: 3,
			category_id: 7,
			title: "A",
			description: "**hi** [x](#loc=11)",
			latitude: "0.85516773357426",
			longitude: "-0.87515917433227",
			features: geo,
			ign_page_id: null,
			tags: [4, 5],
			media: [{ id: 1, url: "https://m/x.png", type: "image" }],
		},
		{
			id: 11,
			region_id: null,
			category_id: 7,
			title: "B",
			description: null,
			latitude: "1",
			longitude: "2",
			tags: [],
			media: [],
		},
		{
			id: 12,
			region_id: null,
			category_id: 7,
			title: "Nowhere",
			latitude: "x",
			longitude: null,
			tags: [],
			media: [],
		},
	],
});

describe("compact map payload", () => {
	test("full -> compact -> full keeps id, title, category, tags, geometry and coordinates", () => {
		const { compact, details } = toCompact(full());
		expect(isCompact(compact)).toBe(true);
		expect(Object.keys(details.d)).toEqual(["10"]); // only what has a description or media
		expect(JSON.stringify(compact)).not.toContain("loc=11"); // descriptions are not in the first payload
		const back = fromCompact(compact, details);
		const src = full();
		expect(back.categories).toEqual(src.categories);
		src.locations.forEach((l: any, k: number) => {
			const b = back.locations[k];
			expect([b.id, b.title, b.category_id, b.tags, b.features ?? null, b.region_id]).toEqual([
				l.id,
				l.title,
				l.category_id,
				l.tags,
				l.features ?? null,
				l.region_id,
			]);
			expect(parseFloat(b.latitude)).toEqual(parseFloat(l.latitude));
			expect(parseFloat(b.longitude)).toEqual(parseFloat(l.longitude));
			expect(b.description).toEqual(l.description || null);
			expect(b.media).toEqual(l.media);
		});
		// the client records: unplaced locations left out, descriptions empty until the details arrive
		const locs = locsOfCompact(compact, () => "chest");
		expect(locs.map((l) => l.id)).toEqual([10, 11]);
		expect(locs[0]).toMatchObject({ cat: 7, region: 3, desc: "", media: [], icon: "chest", lat: 0.85516773357426 });
	});

	test("the CLI helper writes both files and leaves data.json untouched", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "compact-"));
		try {
			const text = JSON.stringify(full());
			await Bun.write(path.join(dir, "data.json"), text);
			await writeCompact(dir);
			expect(await readFile(path.join(dir, "data.json"), "utf8")).toBe(text);
			expect(isCompact(JSON.parse(await readFile(path.join(dir, "data.compact.json"), "utf8")))).toBe(true);
			expect(JSON.parse(await readFile(path.join(dir, "data.details.json"), "utf8")).d["10"][0]).toContain("hi");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("client loading of a compact map", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		state.folder = "";
	});
	const serve = (files: Record<string, unknown>, seen: string[] = []) => {
		globalThis.fetch = (async (u: any) => {
			const url = String(u);
			seen.push(url);
			return url in files ? new Response(JSON.stringify(files[url])) : new Response("nope", { status: 404 });
		}) as any;
		return seen;
	};

	test("a map whose meta names no compact file reads data.json, as does one whose file is gone", async () => {
		state.folder = "/maps/g";
		const seen = serve({ "/maps/g/a/data.json": full() });
		const d = await mapData({ slug: "fallback-a", data: "a/data.json" });
		expect(isCompact(d)).toBe(false);
		expect(d.locations).toHaveLength(3);
		expect(seen).toEqual(["/maps/g/a/data.json"]); // no probing for a file nobody listed
		seen.length = 0;
		const gone = await mapData({ slug: "fallback-gone", data: "a/data.json", compact: "a/data.compact.json" });
		expect(gone.locations).toHaveLength(3);
		expect(seen).toEqual(["/maps/g/a/data.compact.json", "/maps/g/a/data.json"]);
	});

	test("with one, the compact payload is read and the details fill state.locs on demand", async () => {
		state.folder = "/maps/g";
		const { compact, details } = toCompact(full());
		const seen = serve({ "/maps/g/b/data.compact.json": compact, "/maps/g/b/data.details.json": details });
		const info = { slug: "compact-b", data: "b/data.json", compact: "b/data.compact.json" };
		const data = await mapData(info);
		expect(isCompact(data)).toBe(true);
		expect(seen).toEqual(["/maps/g/b/data.compact.json"]); // data.json is not fetched
		const locs = locsOfCompact(data, () => undefined);
		Object.assign(state, { mapInfo: info, data, byId: new Map(locs.map((l) => [l.id, l])) });
		await ensureDetails();
		expect(locs[0].desc).toContain("**hi**");
		expect(locs[0].media).toHaveLength(1);
		expect(locs[1].desc).toBe("");
		await ensureDetails(); // already applied: no second fetch
		expect(seen).toEqual(["/maps/g/b/data.compact.json", "/maps/g/b/data.details.json"]);
	});

	test("without a details file, descriptions come from data.json", async () => {
		state.folder = "/maps/g";
		const { compact } = toCompact(full());
		serve({ "/maps/g/c/data.compact.json": compact, "/maps/g/c/data.json": full() });
		const info = { slug: "compact-c", data: "c/data.json", compact: "c/data.compact.json" };
		const data = await mapData(info);
		const locs = locsOfCompact(data, () => undefined);
		Object.assign(state, { mapInfo: info, data, byId: new Map(locs.map((l) => [l.id, l])) });
		await ensureDetails();
		expect(locs[0].desc).toContain("**hi**");
	});
});