import { describe, expect, test } from "bun:test";

import { orderGames } from "../src/client/home.ts";
import { glyphInk, PIN } from "../src/client/icons-lib.ts";
import { ICONS, svgIcon } from "../src/client/icons.ts";
import {
	DRAW_CONTROLS_HTML,
	hexToHsv,
	hsvToHex,
	INK_CONTROL_HTML,
	PALETTE,
	simplify,
} from "../src/client/map/drawing.ts";
import { mapLimits, sameCamera, startOf } from "../src/client/map/map-view.ts";
import { isCrossMapUrl, isLocalLocHref, mapgenieLocId } from "../src/client/map/markdown.ts";
import { cleanUserData, uniqueName } from "../src/client/map/profiles.ts";
import { matchOf, queryOf } from "../src/client/map/search.ts";
import { geomOf, insideGeom } from "../src/client/map/selection.ts";
import { iconScale, vivid } from "../src/client/map/state.ts";
import { createSync } from "../src/client/sync.ts";
import { deriveLightAccentSoft, describePage, normalizePath } from "../src/client/theme.ts";

describe("drawing pure helpers", () => {
	test("hsvToHex and hexToHsv round-trip palette colors", () => {
		expect(PALETTE.length).toBeGreaterThan(5);
		expect(DRAW_CONTROLS_HTML).toContain('id="tool-draw"');
		expect(INK_CONTROL_HTML).toContain('id="tool-ink"');

		for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000", "#e5484d"]) {
			const [h, s, v] = hexToHsv(hex);
			expect(hsvToHex(h, s, v)).toBe(hex);
		}
	});

	test("simplify (Ramer-Douglas-Peucker) removes collinear points while keeping corners", () => {
		const collinear = [
			{ x: 0, y: 0 },
			{ x: 5, y: 0.1 },
			{ x: 10, y: -0.1 },
			{ x: 20, y: 0 },
		];
		expect(simplify(collinear, 1.0)).toEqual([
			{ x: 0, y: 0 },
			{ x: 20, y: 0 },
		]);

		const corner = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
		];
		expect(simplify(corner, 1.0)).toEqual(corner);
	});
});

describe("icons and contrast helpers", () => {
	test("glyphInk selects WCAG-contrasting ink color", () => {
		expect(glyphInk("#000000")).toBe("#ffffff");
		expect(glyphInk("#12161a")).toBe("#ffffff");
		expect(glyphInk("#ffffff")).toBe("#14161a");
		expect(glyphInk("#f5c544")).toBe("#14161a");
	});

	test("svgIcon renders 24x24 svg with class", () => {
		expect(PIN).toEqual({ S: 60, R: 2, K: 2.4 });
		expect(svgIcon("pin")).toBe(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS.pin}</svg>`);
		expect(svgIcon("check", "extra")).toContain('class="i extra"');
	});
});

describe("theme and navigation helpers", () => {
	test("deriveLightAccentSoft produces valid hex color", () => {
		expect(deriveLightAccentSoft("")).toBe("#b03028");
		expect(deriveLightAccentSoft("#d6453b")).toMatch(/^#[0-9a-f]{6}$/);
	});

	test("normalizePath normalizes index.html and trailing slashes", () => {
		expect(normalizePath("")).toBe("/");
		expect(normalizePath("/index.html")).toBe("/");
		expect(normalizePath("/about")).toBe("/about/");
		expect(normalizePath("/maps/elden-ring/index.html")).toBe("/maps/elden-ring/");
	});

	test("describePage identifies home, legal, signin, and map pages", () => {
		expect(describePage("/").type).toBe("home");
		expect(describePage("/about/").type).toBe("about");
		expect(describePage("/terms/").type).toBe("terms");
		expect(describePage("/privacy/").type).toBe("privacy");
		expect(describePage("/signin/").type).toBe("signin");

		const mapDesc = describePage("/maps/elden-ring/");
		expect(mapDesc.type).toBe("map");
		expect(mapDesc.slug).toBe("elden-ring");
		expect(mapDesc.title).toBe("Elden Ring");
		expect(mapDesc.buttonText).toBe("Return to Elden Ring");
	});
});

describe("modularized map and home helpers", () => {
	test("orderGames sorts recent games first while preserving remaining order", () => {
		const games = [
			{ id: 1, slug: "zelda", title: "Zelda", locations: 10, categories: 2 },
			{ id: 2, slug: "astro", title: "Astro", locations: 5, categories: 1 },
			{ id: 3, slug: "hollow-knight", title: "Hollow Knight", locations: 20, categories: 4 },
		];
		const ordered = orderGames(games, ["hollow-knight"]);
		expect(ordered.map((g) => g.slug)).toEqual(["hollow-knight", "zelda", "astro"]);
	});

	test("geomOf and insideGeom test box, ellipse, and freehand polygon geometry", () => {
		const id = (p: { x: number; y: number }) => p;
		const box = geomOf(
			{
				shape: "box",
				pts: [
					{ x: 10, y: 20 },
					{ x: 0, y: 0 },
				],
			},
			id,
		);
		expect(box).toEqual({ shape: "box", x: 0, y: 0, w: 10, h: 20 });
		expect(insideGeom(box, 5, 10)).toBe(true);
		expect(insideGeom(box, 15, 10)).toBe(false);

		const ellipse = geomOf(
			{
				shape: "ellipse",
				pts: [
					{ x: 0, y: 0 },
					{ x: 10, y: 5 },
				],
			},
			id,
		);
		expect(insideGeom(ellipse, 5, 2)).toBe(true);
		expect(insideGeom(ellipse, 10, 5)).toBe(false);

		const poly = geomOf(
			{
				shape: "free",
				pts: [
					{ x: 0, y: 0 },
					{ x: 10, y: 0 },
					{ x: 10, y: 10 },
					{ x: 0, y: 10 },
				],
			},
			id,
		);
		expect(insideGeom(poly, 5, 5)).toBe(true);
		expect(insideGeom(poly, 15, 5)).toBe(false);
	});

	test("mapgenieLocId extracts locationIds from URLs and #loc fragments, and isCrossMapUrl detects other maps", () => {
		expect(mapgenieLocId("https://mapgenie.io/elden-ring/maps/the-lands-between?locationIds=165234")).toBe(165234);
		expect(mapgenieLocId("https://rdr2map.com?locationIds=320")).toBe(320);
		expect(mapgenieLocId("?locationIds=42")).toBe(42);
		expect(mapgenieLocId("#loc=444895")).toBe(444895);
		expect(mapgenieLocId("https://mapgenie.io/infinity-nikki/maps/miraland#loc=509074")).toBe(509074);
		expect(mapgenieLocId("mailto:test@example.com")).toBeNull();
		expect(mapgenieLocId("https://example.com/no-loc")).toBeNull();

		expect(isLocalLocHref("#loc=444895")).toBe(true);
		expect(isLocalLocHref("https://mapgenie.io/infinity-nikki/maps/miraland?locationIds=509074")).toBe(false);

		const slugs = ["velen-novigrad", "skellige", "white-orchard"];
		expect(isCrossMapUrl("https://mapgenie.io/witcher-3/maps/skellige", slugs, "velen-novigrad")).toBe(true);
		expect(isCrossMapUrl("https://mapgenie.io/witcher-3/maps/velen-novigrad", slugs, "velen-novigrad")).toBe(false);
		expect(
			isCrossMapUrl("https://fallout4map.com/far-harbor", ["commonwealth", "far-harbor"], "commonwealth"),
		).toBe(true);
		expect(isCrossMapUrl("https://youtu.be/abc", slugs, "velen-novigrad")).toBe(false);
	});

	test("queryOf and matchOf rank exact, phrase, word, and fuzzy matches", () => {
		const q = queryOf("Golden Seed");
		expect(matchOf(q, { title: "Golden Seed", desc: "" })).toEqual([0, 0]);
		expect(matchOf(q, { title: "Ancient Golden Seed Tree", desc: "" })).toEqual([1, 0]);
		expect(matchOf(q, { title: "Seed of the Golden Order", desc: "" })).toEqual([2, 0]);
		expect(matchOf(q, { title: "Goldn Seed", desc: "" })?.[0]).toBe(3);
		expect(matchOf(q, { title: "Shrine", desc: "Contains a golden seed inside." })).toEqual([4, 0]);
		expect(matchOf(q, { title: "Unrelated", desc: "Nothing here" })).toBeNull();
	});

	test("cleanUserData sanitizes untrusted imported profile fields and uniqueName avoids collisions", () => {
		const taken = new Set(["Default"]);
		expect(uniqueName("Default", taken)).toBe("Default - copy");
		expect(uniqueName("Default", taken)).toBe("Default - copy 2");

		const dirty: any = {
			userCats: [{ id: -1, title: "A".repeat(100), color: "not-a-hex", glyph: "BAD GLYPH!" }],
			userMarkers: [{ id: -10, cat: -1, title: "", desc: "ok", lat: 12.5, lng: 34.5, links: [1, "bad", 2] }],
			drawings: [{ id: "d1", kind: "pen", color: "#112233", size: "xl", pts: [{ lng: 1, lat: 2 }] }],
			cameras: { main: { lng: 1, lat: 2, zoom: 10 }, broken: { lng: "x" } },
			found: [1, 2, "bad", null],
		};
		const cleaned = cleanUserData(dirty);
		expect(cleaned.userCats[0]).toEqual({ id: -1, title: "A".repeat(40), color: "#e5484d", glyph: null });
		expect(cleaned.userMarkers[0].title).toBe("Marker");
		expect(cleaned.userMarkers[0].links).toEqual([1, 2]);
		expect(cleaned.drawings[0].size).toBe("m");
		expect(cleaned.cameras).toEqual({ main: { lng: 1, lat: 2, zoom: 10 } });
		expect(cleaned.found).toEqual([1, 2]);
	});

	test("state and map-view pure calculations (vivid, iconScale, mapLimits, startOf, sameCamera)", () => {
		expect(vivid("#000000")).not.toBe("#000000");
		expect(iconScale(6)).toBe(0.5);
		expect(iconScale(16)).toBe(1);

		const info = { tilesets: [{ minzoom: 8, maxzoom: 14, bounds: [-1, -1, 1, 1] }] };
		const data = { mapConfig: { start_lng: 0.5, start_lat: -0.5, initial_zoom: 10 } };
		const lim = mapLimits(info, data);
		expect(lim.minZoom).toBe(8);
		expect(lim.maxZoom).toBe(14);
		expect(lim.maxBounds).not.toBeNull();

		expect(startOf(info, data, null)).toEqual({ center: [0.5, -0.5], zoom: 10 });
		expect(startOf(info, data, { lng: 0.1, lat: 0.2, zoom: 12 })).toEqual({ center: [0.1, 0.2], zoom: 12 });
		// Out-of-range zoom falls back to mapConfig
		expect(startOf(info, data, { lng: 0.1, lat: 0.2, zoom: 22 })).toEqual({ center: [0.5, -0.5], zoom: 10 });
		expect(sameCamera({ lng: 1, lat: 2, zoom: 10 }, { lng: 1.000001, lat: 2.000001, zoom: 10.001 })).toBe(true);
	});
});

describe("sync client engine (createSync)", () => {
	function makeMockEnv() {
		const profiles = new Map<string, any>();
		const meta = new Map<string, any>();
		const serverItems = new Map<string, { value: any; updated_at: number }>();
		let clock = 1000;

		const store = {
			profiles: async () => [...profiles.values()].map((p) => structuredClone(p)),
			isEmpty: (p: any) =>
				!p.found?.length && !p.drawings?.length && !p.userMarkers?.length && !p.userCats?.length,
			metaEntries: async () => [...meta.entries()].map(([k, v]) => ({ k, v: structuredClone(v) })),
			putProfile: async (rec: any) => {
				profiles.set(rec.key, structuredClone(rec));
			},
			deleteProfile: async (key: string) => {
				profiles.delete(key);
			},
			putMeta: async (k: string, v: any) => {
				meta.set(k, structuredClone(v));
			},
			removeMeta: async (k: string) => {
				meta.delete(k);
			},
			getMeta: async (k: string) => structuredClone(meta.get(k) ?? null),
		};

		const events = {
			online: [] as boolean[],
			conflicts: [] as any[],
			remoteChanged: [] as string[][],
			signedOut: 0,
		};

		const ui = {
			status: ({ online }: { online: boolean }) => events.online.push(online),
			conflicts: (list: any[]) => events.conflicts.push(list),
			remoteChanged: async (keys: string[]) => {
				events.remoteChanged.push(keys);
			},
			signedOut: () => {
				events.signedOut++;
			},
		};

		const api = async (method: string, path: string, body?: any) => {
			if (method === "GET" && path === "sync") {
				return {
					items: [...serverItems.entries()].map(([key, v]) => ({
						key,
						value: structuredClone(v.value),
						updated_at: v.updated_at,
					})),
				};
			}
			if (method === "POST" && path === "sync") {
				const results = [];
				for (const it of body.items) {
					const cur = serverItems.get(it.key);
					const base = it.base ?? 0;
					if (cur && cur.updated_at > base) {
						results.push({
							key: it.key,
							status: "conflict",
							value: structuredClone(cur.value),
							updated_at: cur.updated_at,
						});
						continue;
					}
					const t = ++clock;
					serverItems.set(it.key, { value: structuredClone(it.value), updated_at: t });
					results.push({ key: it.key, status: "ok", updated_at: t });
				}
				return { results };
			}
			throw new Error(`Unexpected API call: ${method} ${path}`);
		};

		return { profiles, meta, serverItems, store, ui, api, events, tick: () => ++clock };
	}

	test("adopts remote profile over empty local placeholder and pushes local edits", async () => {
		const env = makeMockEnv();
		// Local device starts with an empty default profile
		env.profiles.set("totk:local-empty", {
			key: "totk:local-empty",
			id: "local-empty",
			game: "totk",
			name: "Default",
			found: [],
		});
		// Server has an existing profile with progress
		env.serverItems.set("profile:totk:remote-1", {
			value: { name: "Playthrough 1", found: [10, 20], updated: 500 },
			updated_at: 500,
		});

		// Shim navigator.onLine and addEventListener/document for start()
		const origNav = (globalThis as any).navigator;
		const origAdd = (globalThis as any).addEventListener;
		const origDoc = (globalThis as any).document;
		(globalThis as any).navigator = { onLine: true };
		(globalThis as any).addEventListener = () => {};
		(globalThis as any).document = { addEventListener: () => {}, visibilityState: "visible" };

		const sync = createSync({ store: env.store, ui: env.ui, api: env.api });
		try {
			sync.start();
			await new Promise((r) => setTimeout(r, 30));

			// Empty local placeholder should be replaced by remote-1
			expect(env.profiles.has("totk:local-empty")).toBe(false);
			expect(env.profiles.get("totk:remote-1")?.found).toEqual([10, 20]);
			expect(env.events.remoteChanged).toEqual([["profile:totk:remote-1"]]);

			// Now make a local change and push it
			const prof = env.profiles.get("totk:remote-1");
			prof.found.push(30);
			env.profiles.set("totk:remote-1", prof);
			sync.noteLocal();
			await new Promise((r) => setTimeout(r, 1600));

			expect(env.serverItems.get("profile:totk:remote-1")?.value.found).toEqual([10, 20, 30]);
		} finally {
			sync.stop();
			(globalThis as any).navigator = origNav;
			(globalThis as any).addEventListener = origAdd;
			(globalThis as any).document = origDoc;
		}
	});
});