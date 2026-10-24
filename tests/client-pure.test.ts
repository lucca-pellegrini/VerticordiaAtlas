// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";

import {
	formatAccountDate,
	formatBytes,
	providerLabel,
	renderAccountInfoHtml,
	renderOfflineListHtml,
} from "../src/client/account-page.ts";
import { menuMarkup } from "../src/client/account.ts";
import {
	allPosterUrls,
	getGameOfflineState,
	offlineWarningFor,
	orderGames,
	posterUrlsForGame,
} from "../src/client/home.ts";
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
import {
	createOfflineManager,
	fnvBytes,
	offlineKey,
	type OfflineManifest,
	type OfflineStatus,
	type OfflineStorageAdapter,
	pickSampleUrls,
	unpackVaopStream,
} from "../src/client/offline.ts";
import { createMemoryPackStore } from "../src/client/pack-store.ts";
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

	test("describePage identifies home, legal, signin, account, and map pages", () => {
		expect(describePage("/").type).toBe("home");
		expect(describePage("/about/").type).toBe("about");
		expect(describePage("/terms/").type).toBe("terms");
		expect(describePage("/privacy/").type).toBe("privacy");
		expect(describePage("/signin/").type).toBe("signin");
		expect(describePage("/account/").type).toBe("account");

		const mapDesc = describePage("/maps/elden-ring/");
		expect(mapDesc.type).toBe("map");
		expect(mapDesc.slug).toBe("elden-ring");
		expect(mapDesc.title).toBe("Elden Ring");
		expect(mapDesc.buttonText).toBe("Return to Elden Ring");
	});

	test("account menu and account page helpers format user details and escape HTML", () => {
		const user = {
			id: "u1",
			provider: "google" as const,
			email: 'alice<"x">@example.com',
			name: "Alice",
			createdAt: Date.UTC(2026, 9, 24, 12, 0, 0),
			sessions: 2,
			syncedItems: 5,
		};
		const menu = menuMarkup(user);
		expect(menu).toContain('href="');
		expect(menu).toContain("account/");
		expect(menu).toContain("alice&lt;&quot;x&quot;&gt;@example.com");

		expect(providerLabel("google")).toBe("Google");
		expect(providerLabel("secret")).toBe("Secret key");
		expect(formatAccountDate(undefined)).toBe("—");
		expect(formatAccountDate(Date.UTC(2026, 9, 24, 12, 0, 0))).toContain("2026");
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");

		const html = renderAccountInfoHtml(user);
		expect(html).toContain("Google");
		expect(html).toContain("alice&lt;&quot;x&quot;&gt;@example.com");
		expect(html).toContain(">2<");
		expect(html).toContain(">5<");
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

	test("getGameOfflineState and offlineWarningFor handle downloaded, cached, and unavailable games", () => {
		const downloaded = new Set(["re2", "elden-ring"]);
		const cached = new Set(["slime-rancher", "hollow-knight"]);

		expect(getGameOfflineState("re2", downloaded, cached)).toBe("downloaded");
		expect(getGameOfflineState("slime-rancher", downloaded, cached)).toBe("cached");
		expect(getGameOfflineState("skyrim", downloaded, cached)).toBe("unavailable");

		expect(offlineWarningFor("downloaded", "Resident Evil 2")).toBeNull();

		const cachedWarn = offlineWarningFor("cached", "Slime Rancher");
		expect(cachedWarn).not.toBeNull();
		expect(cachedWarn!.title).toBe("Slime Rancher");
		expect(cachedWarn!.message).toContain("no guarantee the map will be visible");
		expect(cachedWarn!.message).toContain("marker data is there and progress can still be made");
		expect(cachedWarn!.confirmText).toBe("Continue to map");

		const unavailWarn = offlineWarningFor("unavailable", "Skyrim");
		expect(unavailWarn).not.toBeNull();
		expect(unavailWarn!.title).toBe("Skyrim");
		expect(unavailWarn!.message).toContain("not been downloaded or cached for offline use");
		expect(unavailWarn!.message).toContain("page will probably not load at all until you're back online");
		expect(unavailWarn!.confirmText).toBe("Try anyway");
	});

	test("posterUrlsForGame and allPosterUrls extract poster-600 and poster-1200 webps", () => {
		const g1 = { slug: "re2", title: "Resident Evil 2", poster: "re2/poster" };
		const g2 = { slug: "custom", title: "Custom", poster: "custom/art.png" };
		const g3 = { slug: "no-poster", title: "No Poster" };

		expect(posterUrlsForGame(g1 as any)).toEqual(["maps/re2/poster-600.webp", "maps/re2/poster-1200.webp"]);
		expect(posterUrlsForGame(g2 as any)).toEqual(["maps/custom/art.png"]);
		expect(posterUrlsForGame(g3 as any)).toEqual([]);

		const all = allPosterUrls([g1, g2, g3, g1] as any);
		expect(all).toEqual(["maps/re2/poster-600.webp", "maps/re2/poster-1200.webp", "maps/custom/art.png"]);
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

describe("offline maps manager (src/client/offline.ts)", () => {
	// a VAOP stream of the given files; an entry with `alias` is a second name for an earlier file
	const vaop = (entries: { url: string; type?: string; data?: string; alias?: string }[], chunk = 7) => {
		const enc = new TextEncoder();
		const parts: Buffer[] = [];
		const hdr = Buffer.alloc(17);
		hdr.write("VAOP", 0, 4, "ascii");
		hdr.writeUInt8(1, 4);
		hdr.writeUInt32BE(entries.length, 5);
		hdr.writeBigUInt64BE(1000n, 9);
		parts.push(hdr);
		for (const e of entries) {
			const u = Buffer.from(e.url);
			const m = Buffer.from(e.type ?? "image/jpeg");
			if (e.alias) {
				const src = Buffer.from(e.alias);
				const b = Buffer.alloc(1 + 2 + u.length + 2 + src.length + 1 + m.length);
				b.writeUInt8(1, 0);
				b.writeUInt16BE(u.length, 1);
				u.copy(b, 3);
				b.writeUInt16BE(src.length, 3 + u.length);
				src.copy(b, 5 + u.length);
				b.writeUInt8(m.length, 5 + u.length + src.length);
				m.copy(b, 6 + u.length + src.length);
				parts.push(b);
			} else {
				const data = Buffer.from(enc.encode(e.data ?? ""));
				const b = Buffer.alloc(1 + 2 + u.length + 1 + m.length + 4);
				b.writeUInt8(0, 0);
				b.writeUInt16BE(u.length, 1);
				u.copy(b, 3);
				b.writeUInt8(m.length, 3 + u.length);
				m.copy(b, 4 + u.length);
				b.writeUInt32BE(data.length, 4 + u.length + m.length);
				parts.push(b, data);
			}
		}
		const all = Buffer.concat(parts);
		let at = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(c) {
					if (at >= all.length) return c.close();
					c.enqueue(all.subarray(at, Math.min(all.length, (at += chunk))));
				},
			}),
		);
	};

	test("pure helpers hash bytes and pick samples", () => {
		expect(offlineKey("re7", "baker-ranch")).toBe("offline:re7:baker-ranch");
		expect(fnvBytes(new Uint8Array([1, 2, 3, 4]))).toMatch(/^[0-9a-f]{8}$/);
		expect(fnvBytes(new Uint8Array([1, 2, 3, 4]))).not.toBe(fnvBytes(new Uint8Array([1, 2, 3, 5])));
		const urls = Array.from({ length: 20 }, (_, i) => `/u/${i}`);
		expect(pickSampleUrls(urls, 5)).toEqual(["/u/0", "/u/4", "/u/9", "/u/14", "/u/19"]);
		expect(pickSampleUrls(["/a"], 5)).toEqual(["/a"]);
	});

	test("a pack is downloaded, answers its URLs (aliases included), is verified, damaged, and removed", async () => {
		const storeMap = new Map<string, OfflineManifest>();
		const storage: OfflineStorageAdapter = {
			get: async (k) => (storeMap.has(k) ? structuredClone(storeMap.get(k)!) : null),
			put: async (m) => void storeMap.set(m.k, structuredClone(m)),
			remove: async (k) => void storeMap.delete(k),
			list: async () => [...storeMap.values()].map((m) => structuredClone(m)),
		};
		const packs = createMemoryPackStore();
		const meta = {
			id: "re7",
			title: "Resident Evil 7",
			maps: [
				{ slug: "baker-ranch", title: "Baker Ranch", data: "baker-ranch/data.json", tilesets: [] },
				{ slug: "end-of-zoe", title: "End of Zoe", data: "end-of-zoe/data.json", tilesets: [] },
			],
		} as any;
		const files = [
			{ url: "/maps/re7/meta.json", type: "application/json", data: "{}" },
			{ url: "/maps/re7/baker-ranch/tiles/a/9/1/1.jpg", data: "tile-one" },
			{ url: "/maps/re7/baker-ranch/tiles/a/9/1/2.jpg", data: "tile-two" },
			{ url: "/maps/re7/baker-ranch/tiles/a/9/2/2.jpg", alias: "/maps/re7/baker-ranch/tiles/a/9/1/1.jpg" },
		];
		let requests = 0;
		let changes = 0;
		const mgr = createOfflineManager({
			storage,
			packs,
			fetchMeta: async () => meta,
			fetchPack: async () => (requests++, vaop(files)),
			now: () => 1700000000000,
			notifyChanged: () => void changes++,
		});

		const statuses: OfflineStatus[] = [];
		const manifest = await mgr.downloadOfflineMap({
			gameSlug: "re7",
			mapSlug: "baker-ranch",
			onStatus: (s) => statuses.push(s),
		});
		expect(statuses[0]).toEqual({ phase: "preparing", map: 1, maps: 1 }); // before anything is asked of the network
		expect(statuses.slice(1).every((s) => s.phase === "downloading")).toBe(true);
		expect(manifest.expectedCount).toBe(4);
		expect(manifest.totalBytes).toBe(2 + "tile-one".length + "tile-two".length); // the alias stores nothing
		expect(changes).toBe(1);

		const hit = await packs.read("re7", "baker-ranch", "/maps/re7/baker-ranch/tiles/a/9/2/2.jpg");
		expect(await hit!.blob.text()).toBe("tile-one");
		expect(hit!.type).toBe("image/jpeg");
		expect(await packs.read("re7", "baker-ranch", "/maps/re7/nothing.json")).toBeNull();
		expect(await packs.maps("re7")).toEqual(["baker-ranch"]);

		// the account page sees every file as stored
		const inspected = await mgr.inspectOfflineManifests();
		expect(inspected[0].cachedCount).toBe(4);
		expect(inspected[0].intact).toBe(true);
		expect(renderOfflineListHtml(inspected)).toContain("Verified");
		expect((await mgr.verifyOfflineMap({ gameSlug: "re7", mapSlug: "baker-ranch" })).status).toBe("intact");
		expect(requests).toBe(1); // verifying asks the network for nothing

		// a game's maps are all fetched, each announced as "preparing" with its place in the game
		const seen: string[] = [];
		await mgr.downloadOfflineGame({
			gameSlug: "re7",
			onStatus: (s) => s.phase === "preparing" && seen.push(`${s.map}/${s.maps}`),
		});
		expect(seen).toEqual(["1/2", "2/2"]);
		expect((await mgr.getGameOfflineManifests("re7")).map((m) => m.map)).toEqual(["baker-ranch", "end-of-zoe"]);

		// a pack that lost its data is reported, and repaired by downloading it again
		await packs.remove("re7", "baker-ranch");
		const damaged = await mgr.inspectOfflineManifests();
		expect(damaged.find((d) => d.manifest.map === "baker-ranch")!.intact).toBe(false);
		expect(renderOfflineListHtml(damaged)).toContain("Missing data");
		expect((await mgr.verifyOfflineMap({ gameSlug: "re7", mapSlug: "baker-ranch" })).status).toBe("damaged");
		expect((await mgr.getGameOfflineManifests("re7")).map((m) => m.map)).toEqual(["end-of-zoe"]);
		await mgr.downloadOfflineMap({ gameSlug: "re7", mapSlug: "baker-ranch" });
		expect((await mgr.verifyOfflineMap({ gameSlug: "re7", mapSlug: "baker-ranch" })).status).toBe("intact");

		await mgr.removeOfflineGame("re7");
		expect(await mgr.listOfflineManifests()).toEqual([]);
		expect(await packs.maps("re7")).toEqual([]);
	});

	test("a cancelled or failed download leaves no pack behind", async () => {
		const packs = createMemoryPackStore();
		const mgr = createOfflineManager({
			storage: { get: async () => null, put: async () => {}, remove: async () => {}, list: async () => [] },
			packs,
			fetchMeta: async () =>
				({ id: "g", title: "G", maps: [{ slug: "m", title: "M", data: "m/data.json", tilesets: [] }] }) as any,
			fetchPack: async () => new Response(new Blob(["VAOP"]).stream()), // a truncated stream
			notifyChanged: () => {},
		});
		await expect(mgr.downloadOfflineMap({ gameSlug: "g", mapSlug: "m" })).rejects.toThrow();
		expect(await packs.stat("g", "m")).toBeNull();
	});

	test("unpackVaopStream decodes binary stream entries and aliases properly", async () => {
		// Construct a mock VAOP buffer
		const file1 = new TextEncoder().encode("tile-content-1");
		const file2 = new TextEncoder().encode("tile-content-2");

		const chunks: Uint8Array[] = [];
		// 17-byte header: "VAOP", v=1, entries=3, totalBytes=100
		const hdr = Buffer.alloc(17);
		hdr.write("VAOP", 0, 4, "ascii");
		hdr.writeUInt8(1, 4);
		hdr.writeUInt32BE(3, 5);
		hdr.writeBigUInt64BE(100n, 9);
		chunks.push(hdr);

		// Entry 1 (Type 0 file): url="/maps/game/a.jpg", mime="image/jpeg", data=file1
		const u1 = Buffer.from("/maps/game/a.jpg");
		const m1 = Buffer.from("image/jpeg");
		const e1 = Buffer.alloc(1 + 2 + u1.length + 1 + m1.length + 4);
		e1.writeUInt8(0, 0);
		e1.writeUInt16BE(u1.length, 1);
		u1.copy(e1, 3);
		e1.writeUInt8(m1.length, 3 + u1.length);
		m1.copy(e1, 4 + u1.length);
		e1.writeUInt32BE(file1.length, 4 + u1.length + m1.length);
		chunks.push(e1, file1);

		// Entry 2 (Type 0 file): url="/maps/game/b.jpg", mime="image/jpeg", data=file2
		const u2 = Buffer.from("/maps/game/b.jpg");
		const e2 = Buffer.alloc(1 + 2 + u2.length + 1 + m1.length + 4);
		e2.writeUInt8(0, 0);
		e2.writeUInt16BE(u2.length, 1);
		u2.copy(e2, 3);
		e2.writeUInt8(m1.length, 3 + u2.length);
		m1.copy(e2, 4 + u2.length);
		e2.writeUInt32BE(file2.length, 4 + u2.length + m1.length);
		chunks.push(e2, file2);

		// Entry 3 (Type 1 alias): target="/maps/game/c.jpg", src="/maps/game/a.jpg", mime="image/jpeg"
		const u3 = Buffer.from("/maps/game/c.jpg");
		const e3 = Buffer.alloc(1 + 2 + u3.length + 2 + u1.length + 1 + m1.length);
		e3.writeUInt8(1, 0);
		e3.writeUInt16BE(u3.length, 1);
		u3.copy(e3, 3);
		e3.writeUInt16BE(u1.length, 3 + u3.length);
		u1.copy(e3, 5 + u3.length);
		e3.writeUInt8(m1.length, 5 + u3.length + u1.length);
		m1.copy(e3, 6 + u3.length + u1.length);
		chunks.push(e3);

		const fullBuf = Buffer.concat(chunks);
		let offset = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= fullBuf.length) {
					controller.close();
					return;
				}
				const chunk = fullBuf.subarray(offset, Math.min(fullBuf.length, offset + 16)); // Split into small chunks to test streaming parser
				offset += chunk.length;
				controller.enqueue(chunk);
			},
		});

		const entries: any[] = [];
		await unpackVaopStream(stream, async (e) => {
			entries.push(e);
		});

		expect(entries.length).toBe(3);
		expect(entries[0].type).toBe(0);
		expect(entries[0].url).toBe("/maps/game/a.jpg");
		expect(new TextDecoder().decode(entries[0].bytes)).toBe("tile-content-1");
		expect(entries[1].type).toBe(0);
		expect(entries[1].url).toBe("/maps/game/b.jpg");
		expect(new TextDecoder().decode(entries[1].bytes)).toBe("tile-content-2");
		expect(entries[2].type).toBe(1);
		expect(entries[2].url).toBe("/maps/game/c.jpg");
		expect(entries[2].sourceUrl).toBe("/maps/game/a.jpg");
	});
});