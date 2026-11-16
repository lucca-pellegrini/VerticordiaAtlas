// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { esc, fmt, fmtEn } from "../src/shared/escape.ts";
import {
	computePace,
	computeSessions,
	dailyCounts,
	detectBatchTimestamps,
	extractStampedFinds,
	latestSession,
	localDayKey,
	recentFeed,
} from "../src/shared/found-log.ts";
import { closeRing, sanitizeGeometry, sanitizeMapData } from "../src/shared/geometry.ts";
import {
	extractMarkerLinksFromText,
	linesToSteps,
	parseMarkerLink,
	suggestRegionTitle,
} from "../src/shared/guide-import.ts";
import {
	deriveGuideView,
	isStepVisible,
	nextAutoAdvanceStepId,
	nextVisibleStepId,
	prevVisibleStepId,
	resolveVariants,
} from "../src/shared/guide-progress.ts";
import {
	cleanGuide,
	duplicateSection,
	duplicateStep,
	type Guide,
	guideByteLength,
	insertSection,
	insertStep,
	MAX_CONSEQUENCE,
	MAX_DESCRIPTION,
	MAX_GUIDE_BYTES,
	MAX_GUIDE_SECTIONS,
	MAX_GUIDE_STEPS,
	MAX_GUIDE_TITLE,
	MAX_GUIDE_VARIANTS,
	MAX_LINK_LABEL,
	MAX_NOTES,
	MAX_PLACE,
	MAX_POLYGON_POINTS,
	MAX_REWARD,
	MAX_SECTION_TITLE,
	MAX_STEP_LINKS,
	MAX_STEP_TARGETS,
	MAX_STEP_TITLE,
	MAX_THREAD,
	MAX_VARIANT_OPTIONS,
	MAX_ZONE_AVOID,
	mergeSections,
	mergeSteps,
	moveSection,
	moveStep,
	removeSection,
	removeStep,
	splitSection,
	splitStep,
	updateSection,
	updateStep,
} from "../src/shared/guide.ts";
import { flat, fuzzyScore, levenshtein, norm, words } from "../src/shared/search.ts";
import {
	B32,
	B32_MAP,
	cleanSecretChars,
	encodeSecret,
	formatSecret,
	formatSecretKey,
	normalizeSecret,
	SECRET_TOTAL_CHARS,
	validateSecretKey,
} from "../src/shared/secret-key.ts";
import { packMarker, unpackMarker } from "../src/shared/share-link.ts";
import { contentKey, fnv, POSITION_FIELDS, sendKey, stable, TOUCH_FIELD } from "../src/shared/sync-rules.ts";
import { deriveLightAccentSoft, deriveLightTheme, glyphInk, hexToHsl, hslToHex } from "../src/shared/theme-math.ts";

describe("shared/search", () => {
	test("norm strips diacritics and lowercases", () => {
		expect(norm("Élan & Árbol")).toBe("elan & arbol");
		expect(norm(null)).toBe("");
		expect(norm(undefined)).toBe("");
	}, 30_000);

	test("flat collapses non-alphanumeric runs to single spaces", () => {
		expect(flat("Armorer's Cookbook [1]")).toBe("armorer s cookbook 1");
		expect(flat("  --Hello,   World!-- ")).toBe("hello world");
	}, 30_000);

	test("words keeps only words of 3 or more characters", () => {
		expect(words("An Armorer's Cookbook in a Tower")).toEqual(["armorer", "cookbook", "tower"]);
	}, 30_000);

	test("levenshtein computes exact edit distance", () => {
		expect(levenshtein("", "")).toBe(0);
		expect(levenshtein("wolf", "")).toBe(4);
		expect(levenshtein("", "wolf")).toBe(4);
		expect(levenshtein("wolf", "wolf")).toBe(0);
		expect(levenshtein("returm", "return")).toBe(1);
		expect(levenshtein("elden", "eldne")).toBe(2);
	}, 30_000);

	test("fuzzyScore matches within typo thresholds and ignores short words", () => {
		const target = words("Tower of Return");
		expect(fuzzyScore(["tower", "of", "returm"], target)).toBe(1);
		expect(fuzzyScore(["of", "in"], target)).toBeNull();
		expect(fuzzyScore(["zzzzzz"], target)).toBeNull();
		expect(fuzzyScore(["towr"], target)).toBe(1);
		expect(fuzzyScore(["twr"], target)).toBeNull(); // length 3 allows only 1 edit, distance to 'tower' is 2
	}, 30_000);
});

describe("shared/sync-rules", () => {
	test("stable produces canonical JSON with sorted keys and omits undefined", () => {
		const a = { b: 2, a: 1, c: undefined, nested: { z: true, y: [3, 2, 1] } };
		const b = { nested: { y: [3, 2, 1], z: true }, a: 1, b: 2 };
		expect(stable(a)).toBe(stable(b));
		expect(stable(a)).toBe('{"a":1,"b":2,"nested":{"y":[3,2,1],"z":true}}');
		expect(stable(null)).toBe("null");
		expect(stable(undefined)).toBe("null");
	}, 30_000);

	test("contentKey ignores updated, map, and cameras on profile keys only", () => {
		expect(TOUCH_FIELD).toBe("updated");
		expect(POSITION_FIELDS).toEqual(["updated", "map", "cameras"]);

		const p1 = {
			name: "Main",
			found: [1, 2],
			updated: 1000,
			map: "hyrule",
			cameras: { hyrule: { lng: 1, lat: 2, zoom: 10 } },
		};
		const p2 = {
			name: "Main",
			found: [1, 2],
			updated: 2000,
			map: "depths",
			cameras: { depths: { lng: 5, lat: 6, zoom: 12 } },
		};
		const p3 = { name: "Main", found: [1, 2, 3], updated: 2000, map: "depths", cameras: {} };

		expect(contentKey("profile:totk:1", p1)).toBe(contentKey("profile:totk:1", p2));
		expect(contentKey("profile:totk:1", p1)).not.toBe(contentKey("profile:totk:1", p3));

		// For meta keys, map and cameras are not stripped
		expect(contentKey("meta:presets:totk", p1)).not.toBe(contentKey("meta:presets:totk", p2));
	}, 30_000);

	test("sendKey ignores updated on profile keys but includes map and cameras", () => {
		const p1 = {
			name: "Main",
			found: [1, 2],
			updated: 1000,
			map: "hyrule",
			cameras: { hyrule: { lng: 1, lat: 2, zoom: 10 } },
		};
		const p2 = {
			name: "Main",
			found: [1, 2],
			updated: 9999,
			map: "hyrule",
			cameras: { hyrule: { lng: 1, lat: 2, zoom: 10 } },
		};
		const p3 = {
			name: "Main",
			found: [1, 2],
			updated: 9999,
			map: "depths",
			cameras: { hyrule: { lng: 1, lat: 2, zoom: 10 } },
		};

		expect(sendKey("profile:totk:1", p1)).toBe(sendKey("profile:totk:1", p2));
		expect(sendKey("profile:totk:1", p1)).not.toBe(sendKey("profile:totk:1", p3));
	}, 30_000);

	test("contentKey ignores foundAt on profile keys while sendKey includes it", () => {
		const p1 = { name: "Main", found: [1, 2], foundAt: { "1": 1000, "2": 2000 }, updated: 1000 };
		const p2 = { name: "Main", found: [1, 2], foundAt: { "1": 1500, "2": 2500 }, updated: 2000 };
		const p3 = { name: "Main", found: [1, 2], updated: 2000 };

		expect(contentKey("profile:totk:1", p1)).toBe(contentKey("profile:totk:1", p2));
		expect(contentKey("profile:totk:1", p1)).toBe(contentKey("profile:totk:1", p3));
		expect(sendKey("profile:totk:1", p1)).not.toBe(sendKey("profile:totk:1", p2));
		expect(sendKey("profile:totk:1", p1)).not.toBe(sendKey("profile:totk:1", p3));
	}, 30_000);

	test("fnv hashes strings deterministically to 32-bit hex", () => {
		expect(fnv("")).toBe("811c9dc5");
		expect(fnv("hello")).toBe(fnv("hello"));
		expect(fnv("hello")).not.toBe(fnv("world"));
	}, 30_000);

	test("golden test: pre-existing profile and meta records produce byte-identical stable, contentKey, sendKey, and fnv hashes", () => {
		const minimalProfile = {
			id: "p1",
			game: "elden-ring",
			name: "Default",
			tag: null,
			found: [101, 205, 309],
			created: 1700000000000,
			updated: 1700000500000,
		};
		expect(stable(minimalProfile)).toBe(
			'{"created":1700000000000,"found":[101,205,309],"game":"elden-ring","id":"p1","name":"Default","tag":null,"updated":1700000500000}',
		);
		expect(contentKey("profile:elden-ring:p1", minimalProfile)).toBe(
			'{"created":1700000000000,"found":[101,205,309],"game":"elden-ring","id":"p1","name":"Default","tag":null}',
		);
		expect(fnv(contentKey("profile:elden-ring:p1", minimalProfile))).toBe("4980a76e");
		expect(sendKey("profile:elden-ring:p1", minimalProfile)).toBe(
			'{"created":1700000000000,"found":[101,205,309],"game":"elden-ring","id":"p1","name":"Default","tag":null}',
		);
		expect(fnv(sendKey("profile:elden-ring:p1", minimalProfile))).toBe("4980a76e");

		const richProfileWithFoundAt = {
			id: "main",
			game: "hollow-knight",
			name: "112% Steel Soul",
			tag: 2,
			tagStrict: true,
			found: [10, 20, 30],
			foundAt: { "10": 1700000100, "20": 1700000200 },
			created: 1700000000000,
			updated: 1700000900000,
			map: "hallownest",
			cameras: {
				hallownest: { lng: -12.3456, lat: 45.6789, zoom: 11.5 },
			},
			view: {
				hallownest: { hidden: [5, 8], hideFound: true, collapsed: ["grp-1"], presetId: "pre-1" },
			},
			drawings: [
				{
					id: "d1",
					kind: "line",
					color: "#e5484d",
					size: "m",
					pts: [
						{ lng: 1, lat: 2 },
						{ lng: 3, lat: 4 },
					],
					map: "hallownest",
				},
			],
			userCats: [{ id: -1, title: "Pins", color: "#3b82f6", glyph: "star" }],
			userMarkers: [
				{
					id: -101,
					cat: -1,
					title: "Bench",
					desc: "Rest here",
					lat: 10.5,
					lng: -20.25,
					links: [10],
					map: "hallownest",
					created: 1700000050000,
				},
			],
		};
		expect(contentKey("profile:hollow-knight:main", richProfileWithFoundAt)).toBe(
			'{"created":1700000000000,"drawings":[{"color":"#e5484d","id":"d1","kind":"line","map":"hallownest","pts":[{"lat":2,"lng":1},{"lat":4,"lng":3}],"size":"m"}],"found":[10,20,30],"game":"hollow-knight","id":"main","name":"112% Steel Soul","tag":2,"tagStrict":true,"userCats":[{"color":"#3b82f6","glyph":"star","id":-1,"title":"Pins"}],"userMarkers":[{"cat":-1,"created":1700000050000,"desc":"Rest here","id":-101,"lat":10.5,"links":[10],"lng":-20.25,"map":"hallownest","title":"Bench"}],"view":{"hallownest":{"collapsed":["grp-1"],"hidden":[5,8],"hideFound":true,"presetId":"pre-1"}}}',
		);
		expect(fnv(contentKey("profile:hollow-knight:main", richProfileWithFoundAt))).toBe("6c45cb9b");
		expect(sendKey("profile:hollow-knight:main", richProfileWithFoundAt)).toBe(
			'{"cameras":{"hallownest":{"lat":45.6789,"lng":-12.3456,"zoom":11.5}},"created":1700000000000,"drawings":[{"color":"#e5484d","id":"d1","kind":"line","map":"hallownest","pts":[{"lat":2,"lng":1},{"lat":4,"lng":3}],"size":"m"}],"found":[10,20,30],"foundAt":{"10":1700000100,"20":1700000200},"game":"hollow-knight","id":"main","map":"hallownest","name":"112% Steel Soul","tag":2,"tagStrict":true,"userCats":[{"color":"#3b82f6","glyph":"star","id":-1,"title":"Pins"}],"userMarkers":[{"cat":-1,"created":1700000050000,"desc":"Rest here","id":-101,"lat":10.5,"links":[10],"lng":-20.25,"map":"hallownest","title":"Bench"}],"view":{"hallownest":{"collapsed":["grp-1"],"hidden":[5,8],"hideFound":true,"presetId":"pre-1"}}}',
		);
		expect(fnv(sendKey("profile:hollow-knight:main", richProfileWithFoundAt))).toBe("bba325a3");

		const metaPresets = [
			{ id: "pre-1", name: "Grubs & Charms", hidden: [1, 2, 3] },
			{ id: "pre-2", name: "Bosses Only", hidden: [4, 5] },
		];
		expect(contentKey("meta:presets:hollow-knight", metaPresets)).toBe(
			'[{"hidden":[1,2,3],"id":"pre-1","name":"Grubs & Charms"},{"hidden":[4,5],"id":"pre-2","name":"Bosses Only"}]',
		);
		expect(fnv(contentKey("meta:presets:hollow-knight", metaPresets))).toBe("7e6c9683");
		expect(sendKey("meta:presets:hollow-knight", metaPresets)).toBe(
			'[{"hidden":[1,2,3],"id":"pre-1","name":"Grubs & Charms"},{"hidden":[4,5],"id":"pre-2","name":"Bosses Only"}]',
		);
		expect(fnv(sendKey("meta:presets:hollow-knight", metaPresets))).toBe("7e6c9683");

		const metaView = {
			hidden: [1, 4],
			hideFound: false,
			collapsed: [10],
			presetId: null,
		};
		expect(contentKey("meta:view:hollow-knight:hallownest", metaView)).toBe(
			'{"collapsed":[10],"hidden":[1,4],"hideFound":false,"presetId":null}',
		);
		expect(fnv(contentKey("meta:view:hollow-knight:hallownest", metaView))).toBe("38364f3a");
		expect(sendKey("meta:view:hollow-knight:hallownest", metaView)).toBe(
			'{"collapsed":[10],"hidden":[1,4],"hideFound":false,"presetId":null}',
		);
		expect(fnv(sendKey("meta:view:hollow-knight:hallownest", metaView))).toBe("38364f3a");
	}, 30_000);

	test("guide: keys ignore only updated in both contentKey and sendKey", () => {
		const g1 = { v: 1, id: "g-1234", game: "totk", title: "Route A", sections: [], created: 1000, updated: 2000 };
		const g2 = { v: 1, id: "g-1234", game: "totk", title: "Route A", sections: [], created: 1000, updated: 9999 };
		const g3 = { v: 1, id: "g-1234", game: "totk", title: "Route B", sections: [], created: 1000, updated: 9999 };

		expect(contentKey("guide:totk:g-1234", g1)).toBe(contentKey("guide:totk:g-1234", g2));
		expect(sendKey("guide:totk:g-1234", g1)).toBe(sendKey("guide:totk:g-1234", g2));
		expect(contentKey("guide:totk:g-1234", g1)).not.toBe(contentKey("guide:totk:g-1234", g3));
		expect(sendKey("guide:totk:g-1234", g1)).not.toBe(sendKey("guide:totk:g-1234", g3));
	}, 30_000);

	test("profile.guides cursor and variants are ignored in contentKey (never conflict) but kept in sendKey (replicate)", () => {
		const baseProfile = {
			id: "p1",
			game: "totk",
			name: "Main",
			found: [1, 2],
			created: 1000,
			updated: 2000,
		};
		const withCursorAndVariantOnly = {
			...baseProfile,
			updated: 3000,
			guides: {
				"g-1234": {
					cursor: "st-5",
					variants: { mode: "ironman" },
					updated: 3000,
				},
			},
		};
		// When a guide progress entry only has cursor/variants/updated, contentKey matches the untouched profile
		expect(contentKey("profile:totk:p1", withCursorAndVariantOnly)).toBe(
			contentKey("profile:totk:p1", baseProfile),
		);
		// But sendKey differs so cursor and variants replicate to other devices
		expect(sendKey("profile:totk:p1", withCursorAndVariantOnly)).not.toBe(sendKey("profile:totk:p1", baseProfile));

		// With manual done or skipped steps, contentKey includes done/skipped while ignoring cursor/variants/updated
		const pA = {
			...baseProfile,
			guides: {
				"g-1234": {
					done: { "st-1": 1700000000 },
					skipped: ["st-2"],
					cursor: "st-3",
					variants: { mode: "standard" },
					updated: 4000,
				},
			},
		};
		const pB = {
			...baseProfile,
			guides: {
				"g-1234": {
					done: { "st-1": 1700000000 },
					skipped: ["st-2"],
					cursor: "st-99",
					variants: { mode: "ironman" },
					updated: 8000,
				},
			},
		};
		const pC = {
			...baseProfile,
			guides: {
				"g-1234": {
					done: { "st-1": 1700000000, "st-4": 1700000100 },
					skipped: ["st-2"],
					cursor: "st-99",
					variants: { mode: "ironman" },
					updated: 8000,
				},
			},
		};
		expect(contentKey("profile:totk:p1", pA)).toBe(contentKey("profile:totk:p1", pB));
		expect(sendKey("profile:totk:p1", pA)).not.toBe(sendKey("profile:totk:p1", pB));
		expect(contentKey("profile:totk:p1", pA)).not.toBe(contentKey("profile:totk:p1", pC));
	}, 30_000);
});

describe("share-link", () => {
	test.concurrent(
		"packs and unpacks a user marker losslessly (with coordinate rounding and validation)",
		async () => {
			const input = {
				title: "Hidden Chest",
				category: "Loot",
				color: "E5484D",
				glyph: "key-round",
				desc: "Behind the waterfall",
				lat: 12.3456789,
				lng: -45.6789123,
				map: "limgrave",
				links: [101, 202, -5, 0, 3.14], // negative, 0, and non-integers should be filtered out
			};
			const packed = await packMarker(input);
			expect(typeof packed).toBe("string");
			expect(packed).toMatch(/^[A-Za-z0-9_-]+$/);

			const unpacked = await unpackMarker(packed);
			expect(unpacked).toEqual({
				title: "Hidden Chest",
				category: "Loot",
				color: "#e5484d",
				glyph: "key-round",
				desc: "Behind the waterfall",
				lat: 12.345679,
				lng: -45.678912,
				map: "limgrave",
				links: [101, 202],
			});
		},
		30_000,
	);

	test.concurrent(
		"unpackMarker returns null on malformed or out-of-bounds payloads",
		async () => {
			expect(await unpackMarker("")).toBeNull();
			expect(await unpackMarker("not valid base64!!!")).toBeNull();
			expect(await unpackMarker("AAAA")).toBeNull();

			const badLat = await packMarker({ title: "Out of bounds", lat: 95, lng: 0, map: "world" });
			expect(await unpackMarker(badLat)).toBeNull();
		},
		30_000,
	);

	test.concurrent(
		"unpackMarker aborts decompression bombs exceeding MAX_DECOMPRESSED_BYTES",
		async () => {
			const rawJson = JSON.stringify({
				v: 2,
				title: "Bomb",
				lat: 0,
				lng: 0,
				desc: "A".repeat(100_000),
			});
			const compressedStream = new Blob([new TextEncoder().encode(rawJson)])
				.stream()
				.pipeThrough(new CompressionStream("deflate-raw"));
			const compressedBytes = new Uint8Array(await new Response(compressedStream).arrayBuffer());
			let bin = "";
			for (const b of compressedBytes) bin += String.fromCharCode(b);
			const b64url = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			expect(b64url.length).toBeLessThan(4000);
			expect(await unpackMarker(b64url)).toBeNull();
		},
		30_000,
	);
});

describe("shared/escape and shared/theme-math", () => {
	test("esc, fmt, and fmtEn format strings and numbers", () => {
		expect(esc('A & <"B">')).toBe("A &amp; &lt;&quot;B&quot;&gt;");
		expect(esc(null)).toBe("");
		expect(fmtEn(12345)).toBe("12,345");
		expect(typeof fmt(12345)).toBe("string");
	}, 30_000);

	test("theme-math functions compute consistent HSL and light theme palettes", () => {
		const [h, s, l] = hexToHsl("#d6453b");
		expect(hslToHex(h, s, l)).toBe("#d6453b");
		expect(deriveLightAccentSoft("#d6453b")).toMatch(/^#[0-9a-f]{6}$/);
		const light = deriveLightTheme({ accent: "#d6453b" });
		expect(light["accent-soft"]).toBe(deriveLightAccentSoft("#d6453b"));
		expect(glyphInk("#000000")).toBe("#ffffff");
		expect(glyphInk("#ffffff")).toBe("#14161a");
	}, 30_000);
});

describe("shared/secret-key", () => {
	test("normalizeSecret handles case, lookalikes (O->0, I/L->1, U->V), and non-alphanumeric noise", () => {
		expect(normalizeSecret("")).toBe("");
		expect(normalizeSecret("oil u")).toBe("011V");
		expect(normalizeSecret("  ABCD-EFGH\t1234\n5678_90  ")).toBe("ABCDEFGH1234567890");
	}, 30_000);

	test("cleanSecretChars and formatSecretKey format into 4-character groups capped at 30 characters", () => {
		expect(cleanSecretChars("oil")).toBe("011");
		expect(formatSecretKey("")).toBe("");
		expect(formatSecretKey("a")).toBe("A");
		expect(formatSecretKey("abcd")).toBe("ABCD");
		expect(formatSecretKey("abcde")).toBe("ABCD-E");
		expect(formatSecretKey("123456781234567812345678123456")).toBe("1234-5678-1234-5678-1234-5678-1234-56");
		expect(formatSecretKey("123456781234567812345678123456EXTRA")).toBe("1234-5678-1234-5678-1234-5678-1234-56");
	}, 30_000);

	test("encodeSecret produces 30-character keys with scattered checksum catching typos", () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
		const raw = encodeSecret(bytes);
		expect(raw.length).toBe(SECRET_TOTAL_CHARS);
		const formatted = formatSecret(raw);
		expect(formatted.split("-")).toHaveLength(8);
		expect(formatted.split("-")[7].length).toBe(2);

		const valid = validateSecretKey(formatted);
		expect(valid.valid).toBe(true);

		// Single character mutations at any position are caught
		for (let pos = 0; pos < raw.length; pos++) {
			const orig = raw[pos];
			const alt = B32[(B32_MAP[orig] + 1) % 32];
			const bad = raw.slice(0, pos) + alt + raw.slice(pos + 1);
			const res = validateSecretKey(bad);
			expect(res.valid).toBe(false);
		}
	}, 30_000);

	test("validateSecretKey rejects invalid lengths, characters, and non-canonical encodings", () => {
		expect(validateSecretKey("").valid).toBe(false);
		expect(validateSecretKey("ABCD").valid).toBe(false);
		expect(validateSecretKey("K99J-1WVA-1D50-M2DP-8F0P-W1R1-J8").valid).toBe(false);
		expect(validateSecretKey("5SKQ-QBWX-7YT2-QYDA-0PKQ-RXFA-Y05P-SR").valid).toBe(false);
		expect(validateSecretKey("V348-Q6DX-VWMR-EQ6W-3BPM-PC1S-P4C8-VK").valid).toBe(true);
		expect(validateSecretKey("V348-Q6DX-VWMR-EQ67-3BPM-PC1S-P4C8-VK").valid).toBe(false);
		expect(validateSecretKey("D6NQ-62B7-R7T2-1HXJ-8WT0-RHHD-FQ3M-67").valid).toBe(true);
	}, 30_000);
});

describe("shared/geometry", () => {
	test("closeRing closes open rings and deduplicates consecutive identical points", () => {
		expect(closeRing([])).toEqual([]);
		expect(closeRing([[0, 0]])).toEqual([[0, 0]]);
		expect(
			closeRing([
				[0, 0],
				[10, 0],
				[10, 10],
				[0, 10],
			]),
		).toEqual([
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		]);
		// Consecutive duplicates are removed before closing
		expect(
			closeRing([
				[0, 0],
				[0, 0],
				[10, 0],
				[10, 10],
				[10, 10],
				[0, 10],
				[0, 0],
				[0, 0],
			]),
		).toEqual([
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		]);
		// Already closed ring is preserved
		expect(
			closeRing([
				[1, 1],
				[2, 1],
				[2, 2],
				[1, 1],
			]),
		).toEqual([
			[1, 1],
			[2, 1],
			[2, 2],
			[1, 1],
		]);
	}, 30_000);

	test("sanitizeGeometry normalizes Polygon, MultiPolygon, and LineStrings", () => {
		const unclosedPoly = {
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[5, 0],
					[5, 5],
					[0, 5],
				],
			],
		};
		const cleanedPoly = sanitizeGeometry(unclosedPoly);
		expect(cleanedPoly.coordinates[0]).toHaveLength(5);
		expect(cleanedPoly.coordinates[0][4]).toEqual([0, 0]);

		const unclosedMulti = {
			type: "MultiPolygon",
			coordinates: [
				[
					[
						[0, 0],
						[1, 0],
						[1, 1],
						[0, 1],
					],
				],
			],
		};
		const cleanedMulti = sanitizeGeometry(unclosedMulti);
		expect(cleanedMulti.coordinates[0][0]).toHaveLength(5);
		expect(cleanedMulti.coordinates[0][0][4]).toEqual([0, 0]);

		const dupLine = {
			type: "LineString",
			coordinates: [
				[0, 0],
				[0, 0],
				[1, 1],
				[1, 1],
				[2, 2],
			],
		};
		expect(sanitizeGeometry(dupLine).coordinates).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
		]);
	}, 30_000);

	test("sanitizeMapData mutates unclosed regions and location features in place", () => {
		const mapData = {
			regions: [
				{
					id: 1,
					features: [
						{
							geometry: {
								type: "Polygon",
								coordinates: [
									[
										[0, 0],
										[10, 0],
										[10, 10],
										[0, 10],
									],
								],
							},
						},
					],
				},
			],
			locations: [
				{
					id: 10,
					features: [
						{
							geometry: {
								type: "Polygon",
								coordinates: [
									[
										[1, 1],
										[2, 1],
										[2, 2],
										[1, 2],
									],
								],
							},
						},
					],
				},
			],
		};

		const changed = sanitizeMapData(mapData);
		expect(changed).toBe(true);
		expect(mapData.regions[0].features[0].geometry.coordinates[0]).toHaveLength(5);
		expect(mapData.locations[0].features[0].geometry.coordinates[0]).toHaveLength(5);

		// Subsequent call is a no-op
		expect(sanitizeMapData(mapData)).toBe(false);
	}, 30_000);
});

describe("shared/found-log", () => {
	test("detectBatchTimestamps requires at least 8 finds at an identical timestamp", () => {
		const found: number[] = [];
		const foundAt: Record<string, number> = {};
		// 7 finds at t=1000 -> NOT a batch
		for (let i = 1; i <= 7; i++) {
			found.push(i);
			foundAt[String(i)] = 1000;
		}
		// 8 finds at t=2000 -> IS a batch
		for (let i = 10; i < 18; i++) {
			found.push(i);
			foundAt[String(i)] = 2000;
		}
		const entries = extractStampedFinds(found, foundAt);
		const batches = detectBatchTimestamps(entries);
		expect(batches.has(1000)).toBe(false);
		expect(batches.has(2000)).toBe(true);
	});

	test("computeSessions excludes batches and splits on >= 45 minute gaps", () => {
		const found = [1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15, 16, 17];
		const foundAt: Record<string, number> = {
			"1": 1000,
			"2": 2000, // +1000s (< 2700s) -> same session
			"3": 4699, // +2699s (< 2700s) -> same session
			"4": 7399, // +2700s (>= 2700s) -> new session
			"5": 7500,
			// 8-marker batch in the middle should be ignored
			"10": 5000,
			"11": 5000,
			"12": 5000,
			"13": 5000,
			"14": 5000,
			"15": 5000,
			"16": 5000,
			"17": 5000,
		};
		const entries = extractStampedFinds(found, foundAt);
		const batches = detectBatchTimestamps(entries);
		const sessions = computeSessions(entries, batches);
		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toEqual({ start: 1000, end: 4699, count: 3, ids: [1, 2, 3] });
		expect(sessions[1]).toEqual({ start: 7399, end: 7500, count: 2, ids: [4, 5] });

		expect(latestSession(sessions, 7500 + 2699)?.active).toBe(true);
		expect(latestSession(sessions, 7500 + 2700)?.active).toBe(false);
	});

	test("dailyCounts and localDayKey bucket by timezone offset and exclude batches", () => {
		// 2026-06-15T01:30:00Z -> in UTC it's June 15; in UTC-3 (-180 min) it's June 14 22:30
		const sec = Math.floor(Date.UTC(2026, 5, 15, 1, 30, 0) / 1000);
		expect(localDayKey(sec, 0)).toBe("2026-06-15");
		expect(localDayKey(sec, -180)).toBe("2026-06-14");

		const found = [1, 2, 10, 11, 12, 13, 14, 15, 16, 17];
		const foundAt: Record<string, number> = {
			"1": sec,
			"2": sec - 86400,
			"10": sec,
			"11": sec,
			"12": sec,
			"13": sec,
			"14": sec,
			"15": sec,
			"16": sec,
			"17": sec,
		};
		// Note: id 1 is also at `sec`, so `sec` has 9 finds total -> batch!
		const entries = extractStampedFinds(found, foundAt);
		const batches = detectBatchTimestamps(entries);
		const counts = dailyCounts(entries, batches, sec, 0, 3);
		expect(counts.map((c) => [c.dayKey, c.count])).toEqual([
			["2026-06-13", 0],
			["2026-06-14", 1],
			["2026-06-15", 0], // batch at `sec` excluded
		]);
	});

	test("computePace enforces >= 20 non-batch finds and >= 3 distinct active days over trailing 14 days", () => {
		const day0 = Math.floor(Date.UTC(2026, 5, 15, 12, 0, 0) / 1000);
		const found: number[] = [];
		const foundAt: Record<string, number> = {};
		// 19 finds across 3 days -> below 20 threshold -> null
		for (let i = 0; i < 19; i++) {
			found.push(i + 1);
			foundAt[String(i + 1)] = day0 - (i % 3) * 86400 + i;
		}
		let entries = extractStampedFinds(found, foundAt);
		expect(computePace(entries, detectBatchTimestamps(entries), 50, day0, 0)).toBeNull();

		// 20th find on day0 -> 20 finds across 3 days -> 20/3 = 6.67/day -> ceil(50 / 6.666...) = 8
		found.push(20);
		foundAt["20"] = day0 + 100;
		entries = extractStampedFinds(found, foundAt);
		const pace = computePace(entries, detectBatchTimestamps(entries), 50, day0, 0);
		expect(pace).not.toBeNull();
		expect(pace!.finds).toBe(20);
		expect(pace!.activeDays).toBe(3);
		expect(pace!.estimatedDays).toBe(8);

		// 20 finds across only 2 distinct days -> null
		const twoDays: Record<string, number> = {};
		for (let i = 0; i < 20; i++) twoDays[String(i + 1)] = day0 - (i % 2) * 86400 + i;
		const entries2 = extractStampedFinds(found, twoDays);
		expect(computePace(entries2, detectBatchTimestamps(entries2), 50, day0, 0)).toBeNull();

		// Remaining <= 0 -> null
		expect(computePace(entries, detectBatchTimestamps(entries), 0, day0, 0)).toBeNull();
	});

	test("recentFeed collapses each batch into one entry and respects limit", () => {
		const found = [1, 2, 10, 11, 12, 13, 14, 15, 16, 17];
		const foundAt: Record<string, number> = {
			"1": 100,
			"2": 300,
			"10": 200,
			"11": 200,
			"12": 200,
			"13": 200,
			"14": 200,
			"15": 200,
			"16": 200,
			"17": 200,
		};
		const entries = extractStampedFinds(found, foundAt);
		const feed = recentFeed(entries, detectBatchTimestamps(entries), 10);
		expect(feed).toHaveLength(3);
		expect(feed[0]).toEqual({ kind: "single", id: 2, at: 300 });
		expect(feed[1]?.kind).toBe("batch");
		if (feed[1]?.kind === "batch") expect(feed[1].ids).toHaveLength(8);
		expect(feed[2]).toEqual({ kind: "single", id: 1, at: 100 });
	});
});

// Minimal JSON Schema Draft 2020-12 validator for `docs/guide.schema.json`
function validateAgainstSchema(value: unknown, schema: any, rootSchema = schema, curPath = "$"): string[] {
	if (schema.$ref) {
		const refPath = String(schema.$ref).replace(/^#\//, "").split("/");
		let target: any = rootSchema;
		for (const seg of refPath) target = target?.[seg];
		if (!target) return [`${curPath}: unresolved $ref ${schema.$ref}`];
		return validateAgainstSchema(value, target, rootSchema, curPath);
	}
	const errs: string[] = [];
	if (schema.oneOf) {
		const matches = schema.oneOf.filter(
			(sub: any) => validateAgainstSchema(value, sub, rootSchema, curPath).length === 0,
		);
		if (matches.length !== 1)
			errs.push(`${curPath}: expected to match exactly 1 oneOf branch (matched ${matches.length})`);
		return errs;
	}
	if (schema.anyOf) {
		const ok = schema.anyOf.some((sub: any) => validateAgainstSchema(value, sub, rootSchema, curPath).length === 0);
		if (!ok) errs.push(`${curPath}: failed all anyOf branches`);
	}
	if (schema.const !== undefined && value !== schema.const) {
		errs.push(`${curPath}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
		return errs;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errs.push(`${curPath}: value ${JSON.stringify(value)} not in enum`);
		return errs;
	}
	if (schema.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			errs.push(`${curPath}: expected object`);
			return errs;
		}
		const obj = value as Record<string, unknown>;
		for (const reqKey of schema.required || []) {
			if (!Object.prototype.hasOwnProperty.call(obj, reqKey) || obj[reqKey] === undefined) {
				errs.push(`${curPath}: missing required property "${reqKey}"`);
			}
		}
		for (const k of Object.keys(obj)) {
			if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(k)) {
				errs.push(`${curPath}.${k}: property name does not match ${schema.propertyNames.pattern}`);
			}
			const propSchema = schema.properties?.[k];
			if (propSchema) {
				errs.push(...validateAgainstSchema(obj[k], propSchema, rootSchema, `${curPath}.${k}`));
			} else if (schema.additionalProperties === false) {
				errs.push(`${curPath}: unexpected additional property "${k}"`);
			} else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
				errs.push(...validateAgainstSchema(obj[k], schema.additionalProperties, rootSchema, `${curPath}.${k}`));
			}
		}
	} else if (schema.type === "array") {
		if (!Array.isArray(value)) {
			errs.push(`${curPath}: expected array`);
			return errs;
		}
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errs.push(`${curPath}: array length ${value.length} < minItems ${schema.minItems}`);
		}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {
			errs.push(`${curPath}: array length ${value.length} > maxItems ${schema.maxItems}`);
		}
		if (schema.items) {
			for (let i = 0; i < value.length; i++) {
				errs.push(...validateAgainstSchema(value[i], schema.items, rootSchema, `${curPath}[${i}]`));
			}
		}
	} else if (schema.type === "string") {
		if (typeof value !== "string") {
			errs.push(`${curPath}: expected string`);
			return errs;
		}
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			errs.push(`${curPath}: string length ${value.length} < minLength ${schema.minLength}`);
		}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			errs.push(`${curPath}: string length ${value.length} > maxLength ${schema.maxLength}`);
		}
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
			errs.push(`${curPath}: string "${value}" does not match pattern ${schema.pattern}`);
		}
	} else if (schema.type === "integer" || schema.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			errs.push(`${curPath}: expected finite ${schema.type}`);
			return errs;
		}
		if (schema.type === "integer" && !Number.isInteger(value)) {
			errs.push(`${curPath}: expected integer, got ${value}`);
		}
		if (schema.minimum !== undefined && value < schema.minimum) {
			errs.push(`${curPath}: ${value} < minimum ${schema.minimum}`);
		}
	} else if (schema.type === "boolean") {
		if (typeof value !== "boolean") {
			errs.push(`${curPath}: expected boolean`);
		}
	}
	return errs;
}

describe("shared/guide: schema, validation, and editing operations", () => {
	const schemaPath = path.join(import.meta.dir, "..", "docs", "guide.schema.json");
	const guideSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
	const fixtureNames = ["flat-checklist.json", "place-multi-target.json", "variants-and-missing.json"];
	const fixtures: Guide[] = fixtureNames.map((name) =>
		JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "guides", name), "utf8")),
	);

	test("all synthetic fixtures and docs/guides.md examples conform to docs/guide.schema.json and cleanGuide with 0 issues", () => {
		for (let i = 0; i < fixtures.length; i++) {
			const fx = fixtures[i]!;
			const schemaErrs = validateAgainstSchema(fx, guideSchema);
			expect(schemaErrs).toEqual([]);

			const { guide, issues } = cleanGuide(fx);
			expect(issues).toEqual([]);
			expect(guide).toEqual(fx);
		}

		// Also validate the JSON examples embedded in docs/guides.md
		const docText = readFileSync(path.join(import.meta.dir, "..", "docs", "guides.md"), "utf8");
		const codeBlocks = [...docText.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!));
		expect(codeBlocks.length).toBeGreaterThanOrEqual(3);
		for (const block of codeBlocks) {
			expect(validateAgainstSchema(block, guideSchema)).toEqual([]);
			const { guide, issues } = cleanGuide(block);
			expect(issues).toEqual([]);
			expect(guide).toEqual(block);
		}
	}, 30_000);

	test("cleanGuide rejects irrecoverable inputs (non-objects, future/wrong versions, missing game or sections)", () => {
		for (const bad of [null, undefined, 42, "string", true, [], [1, 2]]) {
			const res = cleanGuide(bad);
			expect(res.guide).toBeNull();
			expect(res.issues.length).toBeGreaterThan(0);
		}

		const futureVer = cleanGuide({ ...fixtures[0], v: 2 });
		expect(futureVer.guide).toBeNull();
		expect(futureVer.issues[0]?.message).toContain("Unsupported guide format version 2");

		const badVer = cleanGuide({ ...fixtures[0], v: 0 });
		expect(badVer.guide).toBeNull();

		const noGame = cleanGuide({ ...fixtures[0], game: "   " });
		expect(noGame.guide).toBeNull();

		const badGame = cleanGuide({ ...fixtures[0], game: "../etc/passwd" });
		expect(badGame.guide).toBeNull();

		const emptySections = cleanGuide({ ...fixtures[0], sections: [] });
		expect(emptySections.guide).toBeNull();

		const nonObjectSections = cleanGuide({ ...fixtures[0], sections: [null, "bad", 123] });
		expect(nonObjectSections.guide).toBeNull();
	}, 30_000);

	test("cleanGuide rejects prototype-pollution keys (__proto__, constructor, prototype) everywhere", () => {
		const raw = JSON.parse(
			'{"v":1,"id":"__proto__","game":"sunlit-reach","title":"Pollution Test","__proto__":{"polluted":true},"constructor":"bad","variants":[{"id":"__proto__","label":"Bad","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"default":"a"},{"id":"mode","label":"Mode","options":[{"id":"__proto__","label":"Bad"},{"id":"a","label":"A"},{"id":"b","label":"B"}],"default":"__proto__"}],"sections":[{"id":"constructor","title":"Sec","prototype":123,"steps":[{"id":"prototype","kind":"task","title":"Step","only":{"__proto__":["a"],"constructor":["a"],"mode":["__proto__","a"]}}]}],"created":1,"updated":1}',
		);
		const { guide, issues } = cleanGuide(raw);
		expect(guide).not.toBeNull();
		expect(({} as any).polluted).toBeUndefined();
		expect(guide!.id).not.toBe("__proto__");
		expect(guide!.sections[0]!.id).toBe("sec-1");
		expect(guide!.sections[0]!.steps[0]!.id).toBe("step-1");
		expect(guide!.variants).toHaveLength(1);
		expect(guide!.variants![0]!.id).toBe("mode");
		expect(guide!.variants![0]!.default).toBe("a");
		expect(guide!.sections[0]!.steps[0]!.only).toEqual({ mode: ["a"] });
		expect(issues.length).toBeGreaterThan(5);
		expect(validateAgainstSchema(guide, guideSchema)).toEqual([]);
	}, 30_000);

	test("cleanGuide deterministically regenerates duplicate section and step ids, drops invalid targets/links/only, and clips strings", () => {
		const messy = {
			v: 1,
			id: "bad id!",
			game: "sunlit-reach",
			title: "T".repeat(MAX_GUIDE_TITLE + 50),
			description: "D".repeat(MAX_DESCRIPTION + 50),
			unknownRoot: "drop-me",
			variants: [
				{
					id: "pact",
					label: "Pact",
					options: [
						{ id: "wardens", label: "Wardens" },
						{ id: "wardens", label: "Duplicate" },
						{ id: "scholars", label: "Scholars" },
					],
					default: "non-existent",
				},
				{
					id: "too-few",
					label: "Too Few",
					options: [{ id: "only-one", label: "One" }],
					default: "only-one",
				},
			],
			sections: [
				{
					id: "dup-sec",
					title: "S".repeat(MAX_SECTION_TITLE + 20),
					notes: "N".repeat(MAX_NOTES + 10),
					steps: [
						{
							id: "dup-step",
							kind: "invalid-kind",
							title: "A".repeat(MAX_STEP_TITLE + 20),
							reward: "R".repeat(MAX_REWARD + 20),
							consequence: "C".repeat(MAX_CONSEQUENCE + 20),
							place: "P".repeat(MAX_PLACE + 20),
							thread: "H".repeat(MAX_THREAD + 20),
							targets: [
								{ kind: "marker", marker: 101 },
								{ kind: "marker", marker: -5 }, // negative user marker id -> dropped
								{ kind: "marker", marker: Number.NaN }, // non-finite -> dropped
								{ kind: "point", point: { lat: Number.POSITIVE_INFINITY, lng: 0, map: "m" } }, // non-finite -> dropped
								{ kind: "point", point: { lat: 10, lng: 20, map: "overworld" } },
							],
							only: {
								pact: ["wardens", "ghost-option"],
								unknownVar: ["x"],
							},
							links: [
								{ url: "javascript:alert(1)", label: "XSS" },
								{ url: "mailto:user@example.com" },
								{ url: "https://atlas.verticordia.com/guide", label: "L".repeat(MAX_LINK_LABEL + 20) },
							],
						},
						{
							id: "dup-step",
							kind: "task",
							title: "Second step with duplicate id",
						},
					],
				},
				{
					id: "dup-sec",
					title: "Second section with duplicate id",
					steps: [],
				},
			],
			created: -10,
			updated: "bad",
		};

		const r1 = cleanGuide(messy);
		const r2 = cleanGuide(messy);
		expect(r1.guide).not.toBeNull();
		// Deterministic output
		expect(r1.guide).toEqual(r2.guide);
		const g = r1.guide!;
		expect(validateAgainstSchema(g, guideSchema)).toEqual([]);

		expect(g.title.length).toBe(MAX_GUIDE_TITLE);
		expect(g.description!.length).toBe(MAX_DESCRIPTION);
		expect(g.variants).toHaveLength(1);
		expect(g.variants![0]!.default).toBe("wardens");
		expect(g.sections[0]!.id).toBe("dup-sec");
		expect(g.sections[1]!.id).toBe("sec-1");

		const st0 = g.sections[0]!.steps[0]!;
		const st1 = g.sections[0]!.steps[1]!;
		expect(st0.id).toBe("dup-step");
		expect(st1.id).toBe("step-1");
		expect(st0.kind).toBe("task");
		expect(st0.title.length).toBe(MAX_STEP_TITLE);
		expect(st0.reward!.length).toBe(MAX_REWARD);
		expect(st0.consequence!.length).toBe(MAX_CONSEQUENCE);
		expect(st0.place!.length).toBe(MAX_PLACE);
		expect(st0.thread!.length).toBe(MAX_THREAD);
		expect(st0.targets).toEqual([
			{ kind: "marker", marker: 101 },
			{ kind: "point", point: { lat: 10, lng: 20, map: "overworld" } },
		]);
		expect(st0.only).toEqual({ pact: ["wardens"] });
		expect(st0.links).toEqual([{ url: "https://atlas.verticordia.com/guide", label: "L".repeat(MAX_LINK_LABEL) }]);
		expect(g.created).toBe(0);
		expect(g.updated).toBe(0);
	}, 30_000);

	test("cleanGuide is total under field-by-field fixture mutations and random fuzzing", () => {
		const badValues: unknown[] = [
			null,
			undefined,
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"",
			"   ",
			"__proto__",
			"constructor",
			"prototype",
			true,
			false,
			[],
			[null, {}, -999],
			{},
			{ __proto__: { bad: 1 } },
		];

		for (const fx of fixtures) {
			for (const topKey of Object.keys(fx)) {
				for (const bad of badValues) {
					const copy: any = structuredClone(fx);
					copy[topKey] = bad;
					const res = cleanGuide(copy);
					if (res.guide !== null) {
						expect(validateAgainstSchema(res.guide, guideSchema)).toEqual([]);
					}
				}
			}
			// Mutate nested section and step fields
			for (const bad of badValues) {
				const copySec: any = structuredClone(fx);
				for (const k of ["id", "title", "notes", "level", "gate", "after", "optional", "steps"]) {
					const c = structuredClone(copySec);
					c.sections[0][k] = bad;
					const res = cleanGuide(c);
					if (res.guide !== null) {
						expect(validateAgainstSchema(res.guide, guideSchema)).toEqual([]);
					}
				}
				for (const k of [
					"id",
					"kind",
					"title",
					"notes",
					"targets",
					"place",
					"samePlace",
					"reward",
					"consequence",
					"optional",
					"missable",
					"thread",
					"only",
					"links",
					"zone",
				]) {
					const c = structuredClone(copySec);
					c.sections[0].steps[0][k] = bad;
					const res = cleanGuide(c);
					if (res.guide !== null) {
						expect(validateAgainstSchema(res.guide, guideSchema)).toEqual([]);
					}
				}
			}
		}
	}, 30_000);

	test("limits are enforced and a maximal guide at the structural limits serializes below MAX_GUIDE_BYTES", () => {
		// 1. Construct a guide at structural limits: 300 sections, 2,000 steps total, 8 variants with 8 options each
		const variants = Array.from({ length: MAX_GUIDE_VARIANTS + 2 }, (_, v) => ({
			id: `var-${v + 1}`,
			label: `Variant ${v + 1}`,
			options: Array.from({ length: MAX_VARIANT_OPTIONS + 2 }, (__, o) => ({
				id: `opt-${o + 1}`,
				label: `Option ${o + 1}`,
			})),
			default: "opt-1",
		}));

		const sections = [];
		let stepNum = 0;
		for (let s = 0; s < MAX_GUIDE_SECTIONS + 10; s++) {
			const stepsInSec = s < 200 ? 10 : 1; // 200 * 10 = 2000 steps across the first 200 sections
			const steps = [];
			for (let i = 0; i < stepsInSec; i++) {
				stepNum++;
				steps.push({
					id: `st-${stepNum}`,
					kind: "task",
					title: `Step ${stepNum}: Collect the Sunstone Shard at Beacon #${stepNum}`,
					targets: [{ kind: "marker", marker: stepNum }],
					place: "Sunlit Valley",
					thread: "Main Quest",
				});
			}
			sections.push({
				id: `sec-${s + 1}`,
				title: `Section ${s + 1}: Region Sweep`,
				steps,
			});
		}

		const { guide, issues } = cleanGuide({
			v: 1,
			id: "max-limits-guide",
			game: "sunlit-reach",
			title: "Maximal Structural Guide",
			variants,
			sections,
			created: 1760000000000,
			updated: 1760000000000,
		});

		expect(guide).not.toBeNull();
		expect(issues.length).toBeGreaterThan(0);
		expect(guide!.variants).toHaveLength(MAX_GUIDE_VARIANTS);
		expect(guide!.variants![0]!.options).toHaveLength(MAX_VARIANT_OPTIONS);
		expect(guide!.sections).toHaveLength(MAX_GUIDE_SECTIONS);
		const totalSteps = guide!.sections.reduce((a, s) => a + s.steps.length, 0);
		expect(totalSteps).toBe(MAX_GUIDE_STEPS);

		const bytes = guideByteLength(guide!);
		console.log(
			`[guides] 2,000-step / 300-section / 8x8-variant guide serialized size: ${bytes.toLocaleString("en-US")} bytes (limit: ${MAX_GUIDE_BYTES.toLocaleString("en-US")} bytes)`,
		);
		expect(bytes).toBeLessThanOrEqual(MAX_GUIDE_BYTES);
		expect(validateAgainstSchema(guide, guideSchema)).toEqual([]);

		// 2. Also verify that an intentionally bloated guide (e.g. 500 steps each with 5,000-char notes > 2.5 MB)
		// is clamped by cleanGuide to <= MAX_GUIDE_BYTES
		const bloatedSteps = Array.from({ length: 400 }, (_, i) => ({
			id: `bloat-${i + 1}`,
			kind: "task" as const,
			title: `Step ${i + 1}`,
			notes: "X".repeat(MAX_NOTES),
			consequence: "Y".repeat(MAX_CONSEQUENCE),
			targets: Array.from({ length: MAX_STEP_TARGETS + 5 }, (__, t) => ({
				kind: "marker" as const,
				marker: i * 200 + t + 1,
			})),
			links: Array.from({ length: MAX_STEP_LINKS + 2 }, (__, l) => ({
				url: `https://atlas.verticordia.com/step/${i}/${l}`,
			})),
			zone: {
				map: "overworld",
				polygon: Array.from({ length: MAX_POLYGON_POINTS + 10 }, (__, p) => ({ lng: p * 0.01, lat: p * 0.01 })),
				avoid: Array.from({ length: MAX_ZONE_AVOID + 5 }, (__, a) => ({
					marker: a + 1,
					note: `Avoid ${a}`,
				})),
			},
		}));
		const bloatedRes = cleanGuide({
			v: 1,
			id: "bloated-guide",
			game: "sunlit-reach",
			title: "Bloated Guide",
			sections: [{ id: "sec-1", title: "All", steps: bloatedSteps }],
			created: 1,
			updated: 1,
		});
		expect(bloatedRes.guide).not.toBeNull();
		expect(guideByteLength(bloatedRes.guide!)).toBeLessThanOrEqual(MAX_GUIDE_BYTES);
		expect(bloatedRes.guide!.sections[0]!.steps[0]!.targets!.length).toBeLessThanOrEqual(MAX_STEP_TARGETS);
		expect(bloatedRes.guide!.sections[0]!.steps[0]!.links!.length).toBeLessThanOrEqual(MAX_STEP_LINKS);
		expect(bloatedRes.guide!.sections[0]!.steps[0]!.zone!.polygon!.length).toBeLessThanOrEqual(MAX_POLYGON_POINTS);
		expect(bloatedRes.guide!.sections[0]!.steps[0]!.zone!.avoid!.length).toBeLessThanOrEqual(MAX_ZONE_AVOID);
	}, 30_000);

	test("pure editing operations preserve existing ids, never mutate inputs, and round-trip through cleanGuide", () => {
		const base = structuredClone(fixtures[1]!);
		const snapBefore = JSON.stringify(base);

		// insertSection & updateSection
		const withSec = insertSection(base, { id: "sec-added", title: "Inner Sanctum", level: "20-25" }, 1, 5000);
		expect(JSON.stringify(base)).toBe(snapBefore);
		expect(withSec.sections).toHaveLength(2);
		expect(withSec.sections[0]!.id).toBe("sec-outer-delve");
		expect(withSec.sections[1]!.id).toBe("sec-added");

		const updatedSec = updateSection(withSec, "sec-added", { title: "Updated Sanctum", optional: true }, 6000);
		expect(withSec.sections[1]!.title).toBe("Inner Sanctum");
		expect(updatedSec.sections[1]!.title).toBe("Updated Sanctum");
		expect(updatedSec.sections[1]!.optional).toBe(true);

		// moveSection & duplicateSection
		const movedSec = moveSection(updatedSec, "sec-added", 0, 7000);
		expect(movedSec.sections.map((s) => s.id)).toEqual(["sec-added", "sec-outer-delve"]);

		const dupSec = duplicateSection(movedSec, "sec-outer-delve", { newSectionId: "sec-copy", nowMs: 8000 });
		expect(dupSec.sections.map((s) => s.id)).toEqual(["sec-added", "sec-outer-delve", "sec-copy"]);
		expect(dupSec.sections[2]!.steps).toHaveLength(dupSec.sections[1]!.steps.length);
		expect(dupSec.sections[2]!.steps[0]!.id).not.toBe(dupSec.sections[1]!.steps[0]!.id);

		// splitSection & mergeSections
		const splitSec = splitSection(base, "sec-outer-delve", 2, "Lower Delve", "sec-lower", 9000);
		expect(splitSec.sections.map((s) => s.id)).toEqual(["sec-outer-delve", "sec-lower"]);
		expect(splitSec.sections[0]!.steps.map((st) => st.id)).toEqual(["st-cavern-lore", "st-sluice-caches"]);
		expect(splitSec.sections[1]!.steps.map((st) => st.id)).toEqual(["st-sluice-lever", "st-basin-explore"]);

		const mergedSec = mergeSections(splitSec, "sec-outer-delve", "sec-lower", 10000);
		expect(mergedSec.sections).toHaveLength(1);
		expect(mergedSec.sections[0]!.steps.map((st) => st.id)).toEqual([
			"st-cavern-lore",
			"st-sluice-caches",
			"st-sluice-lever",
			"st-basin-explore",
		]);

		const afterRemoveSec = removeSection(splitSec, "sec-lower", 11000);
		expect(afterRemoveSec.sections.map((s) => s.id)).toEqual(["sec-outer-delve"]);

		// Step operations: insertStep, updateStep, moveStep, duplicateStep, splitStep, mergeSteps, removeStep
		const s1 = insertStep(base, "sec-outer-delve", { id: "st-new", kind: "task", title: "New Step" }, 1, 12000);
		expect(s1.sections[0]!.steps[1]!.id).toBe("st-new");

		const s2 = updateStep(s1, "st-new", { title: "Edited Step", reward: "Gold Coin" }, 13000);
		expect(s1.sections[0]!.steps[1]!.title).toBe("New Step");
		expect(s2.sections[0]!.steps[1]!.title).toBe("Edited Step");
		expect(s2.sections[0]!.steps[1]!.id).toBe("st-new");

		const s3 = moveStep(s2, "st-new", "sec-outer-delve", 0, 14000);
		expect(s3.sections[0]!.steps[0]!.id).toBe("st-new");

		const s4 = duplicateStep(s3, "st-new", "st-new-copy", 15000);
		expect(s4.sections[0]!.steps[1]!.id).toBe("st-new-copy");

		// splitStep on multi-target step `st-sluice-caches` (which has 3 targets: 2001, 2002, 2003)
		const s5 = splitStep(s4, "st-sluice-caches", {
			afterTargetIndex: 1,
			newStepId: "st-sluice-caches-2",
			secondTitle: "Remaining Sluice Caches",
			nowMs: 16000,
		});
		const origCacheStep = s5.sections[0]!.steps.find((st) => st.id === "st-sluice-caches")!;
		const splitCacheStep = s5.sections[0]!.steps.find((st) => st.id === "st-sluice-caches-2")!;
		expect(origCacheStep.targets).toHaveLength(1);
		expect(splitCacheStep.targets).toHaveLength(2);

		// mergeSteps back together preserves `st-sluice-caches` id and restores all 3 targets
		const s6 = mergeSteps(s5, "st-sluice-caches", "st-sluice-caches-2", 17000);
		const mergedCacheStep = s6.sections[0]!.steps.find((st) => st.id === "st-sluice-caches")!;
		expect(mergedCacheStep.targets).toHaveLength(3);
		expect(s6.sections[0]!.steps.some((st) => st.id === "st-sluice-caches-2")).toBe(false);

		const s7 = removeStep(s6, "st-new-copy", 18000);
		expect(s7.sections[0]!.steps.some((st) => st.id === "st-new-copy")).toBe(false);

		const roundTrip = cleanGuide(s7);
		expect(roundTrip.issues).toEqual([]);
		expect(roundTrip.guide).toEqual(s7);
		expect(JSON.stringify(base)).toBe(snapBefore);
	}, 30_000);
});

describe("shared/guide-progress: table-driven derived state rules and performance", () => {
	const fxFlat = JSON.parse(
		readFileSync(path.join(import.meta.dir, "fixtures", "guides", "flat-checklist.json"), "utf8"),
	) as Guide;
	const fxPlace = JSON.parse(
		readFileSync(path.join(import.meta.dir, "fixtures", "guides", "place-multi-target.json"), "utf8"),
	) as Guide;
	const fxVariants = JSON.parse(
		readFileSync(path.join(import.meta.dir, "fixtures", "guides", "variants-and-missing.json"), "utf8"),
	) as Guide;

	test("rule: variants combine with AND, unmentioned variants do not hide, and hidden steps never count or become cursor", () => {
		const cases: {
			name: string;
			variants: Record<string, string>;
			expectedVisibleIds: string[];
			expectedTotalTasks: number;
		}[] = [
			{
				name: "defaults (mode=standard, pact=wardens): st-warden-envoy visible, st-ironman-ward hidden",
				variants: {},
				expectedVisibleIds: [
					"st-gatehouse",
					"st-warden-envoy",
					"st-legacy-shrine",
					"st-vault-key",
					"st-vault-sanctum",
				],
				expectedTotalTasks: 5,
			},
			{
				name: "mode=ironman AND pact=wardens: both st-warden-envoy and st-ironman-ward visible",
				variants: { mode: "ironman", pact: "wardens" },
				expectedVisibleIds: [
					"st-gatehouse",
					"st-warden-envoy",
					"st-ironman-ward",
					"st-legacy-shrine",
					"st-vault-key",
					"st-vault-sanctum",
				],
				expectedTotalTasks: 6,
			},
			{
				name: "mode=ironman AND pact=scholars: both Warden-only steps hidden (AND rule)",
				variants: { mode: "ironman", pact: "scholars" },
				expectedVisibleIds: ["st-gatehouse", "st-legacy-shrine", "st-vault-key", "st-vault-sanctum"],
				expectedTotalTasks: 4,
			},
		];

		for (const tc of cases) {
			const view = deriveGuideView({
				guide: fxVariants,
				found: new Set(),
				progress: { cursor: "st-ironman-ward" },
				variants: tc.variants,
			});
			expect(view.visibleSteps.map((s) => s.step.id)).toEqual(tc.expectedVisibleIds);
			expect(view.counts.total).toBe(tc.expectedTotalTasks);
			if (!tc.expectedVisibleIds.includes("st-ironman-ward")) {
				// Cursor pointing at a hidden step falls back to the first visible undone/unskipped step
				expect(view.cursor).toBe("st-gatehouse");
			} else {
				expect(view.cursor).toBe("st-ironman-ward");
			}
		}
		expect(resolveVariants(fxVariants, { variants: { mode: "invalid" } })).toEqual({
			mode: "standard",
			pact: "wardens",
		});
		expect(isStepVisible(fxVariants.sections[0]!.steps[2]!, { mode: "ironman", pact: "wardens" })).toBe(true);
	}, 30_000);

	test("rule: task step completion, partial steps, optional targets, manual done flags, waypoint/info steps, and samePlace", () => {
		// In fxPlace:
		// - st-cavern-lore: info step (never done, never counted)
		// - st-sluice-caches: task with required markers 2001, 2002 and optional marker 2003
		// - st-sluice-lever: task with no targets (manual done flag) and samePlace: true
		// - st-basin-explore: task with required markers 2004, 2005
		const v0 = deriveGuideView({ guide: fxPlace, found: new Set([2001]) });
		const cacheStep0 = v0.stepsById.get("st-sluice-caches")!;
		expect(cacheStep0.requiredTargets).toBe(2);
		expect(cacheStep0.foundRequiredTargets).toBe(1);
		expect(cacheStep0.partial).toBe(true);
		expect(cacheStep0.done).toBe(false);
		expect(cacheStep0.status).toBe("partial");
		expect(v0.counts.total).toBe(3); // 3 task steps; info step excluded
		expect(v0.counts.done).toBe(0);

		// Finding both required targets (2001, 2002) completes st-sluice-caches even without optional 2003
		const v1 = deriveGuideView({
			guide: fxPlace,
			found: new Set([2001, 2002]),
			progress: { done: { "st-sluice-lever": 1700000000 }, cursor: "st-basin-explore" },
		});
		expect(v1.stepsById.get("st-sluice-caches")!.done).toBe(true);
		expect(v1.stepsById.get("st-sluice-caches")!.partial).toBe(false);
		expect(v1.stepsById.get("st-sluice-lever")!.done).toBe(true);
		expect(v1.stepsById.get("st-sluice-lever")!.effectivePlace).toBe("Sluice Gallery");
		expect(v1.stepsById.get("st-cavern-lore")!.done).toBe(false);
		expect(v1.stepsById.get("st-cavern-lore")!.passed).toBe(true); // before cursor
		expect(v1.counts).toEqual({
			total: 3,
			required: 3,
			done: 2,
			doneRequired: 2,
			skipped: 0,
			remaining: 1,
		});
	}, 30_000);

	test("rule: missing markers vs unknown markers, optional sections, skipped steps, and cursor navigation", () => {
		// In fxVariants, st-legacy-shrine has marker 999999 with a snapshot
		// 1. When markerExists returns 'unknown', marker 999999 is treated as existing and required
		const unknownView = deriveGuideView({
			guide: fxVariants,
			found: new Set(),
			markerExists: () => "unknown",
		});
		const legacyUnknown = unknownView.stepsById.get("st-legacy-shrine")!;
		expect(legacyUnknown.targets[0]!.missing).toBe(false);
		expect(legacyUnknown.requiredTargets).toBe(1);
		expect(legacyUnknown.done).toBe(false);

		// 2. When markerExists returns 'no' for 999999, it degrades to its snapshot point, is excluded from required
		// targets, and st-legacy-shrine becomes a manual step (done when progress.done has its id)
		const missingView = deriveGuideView({
			guide: fxVariants,
			found: new Set([3001]),
			markerExists: (id) => (id === 999999 ? "no" : "yes"),
			progress: {
				skipped: ["st-warden-envoy"],
				done: { "st-legacy-shrine": 1700000100 },
			},
		});
		const legacyMissing = missingView.stepsById.get("st-legacy-shrine")!;
		expect(legacyMissing.targets[0]!.missing).toBe(true);
		expect(legacyMissing.targets[0]!.point).toEqual({ lat: 22.15, lng: 14.75, map: "citadel" });
		expect(legacyMissing.requiredTargets).toBe(0);
		expect(legacyMissing.done).toBe(true);

		// Optional section `sec-astral-vault` steps are flagged optional; required count excludes them
		expect(missingView.stepsById.get("st-vault-key")!.optional).toBe(true);
		expect(missingView.stepsById.get("st-vault-sanctum")!.optional).toBe(true);
		expect(missingView.counts).toEqual({
			total: 5, // 3 in sec-approach + 2 in sec-astral-vault
			required: 3, // only the 3 in sec-approach
			done: 2, // st-gatehouse (found 3001) + st-legacy-shrine (manual done)
			doneRequired: 2,
			skipped: 1, // st-warden-envoy
			remaining: 2, // 5 - 2 - 1 = 2
		});

		// Cursor fallback skipped over done st-gatehouse, skipped st-warden-envoy, and done st-legacy-shrine -> st-vault-key
		expect(missingView.cursor).toBe("st-vault-key");
		expect(nextVisibleStepId(missingView)).toBe("st-vault-sanctum");
		expect(prevVisibleStepId(missingView)).toBe("st-legacy-shrine");
		expect(nextAutoAdvanceStepId(missingView, "st-vault-key")).toBe("st-vault-sanctum");

		// A step with only optional marker targets is also treated as optional
		const optTargetGuide = updateStep(fxFlat, "st-waystone-1", {
			targets: [{ kind: "marker", marker: 1001, optional: true }],
		});
		const optTargetView = deriveGuideView({ guide: optTargetGuide, found: new Set() });
		expect(optTargetView.stepsById.get("st-waystone-1")!.optional).toBe(true);
	}, 30_000);

	test("performance: deriving a 2,000-step guide against 30,000 found markers completes well under 250 ms", () => {
		const found = new Set<number>();
		for (let i = 1; i <= 30_000; i++) found.add(i * 2); // 30,000 even marker ids found

		const sections = [];
		for (let s = 0; s < 20; s++) {
			const steps = [];
			for (let i = 0; i < 100; i++) {
				const n = s * 100 + i + 1;
				steps.push({
					id: `st-${n}`,
					kind: "task" as const,
					title: `Step ${n}`,
					targets: [
						{ kind: "marker" as const, marker: n * 2 },
						{ kind: "marker" as const, marker: n * 2 + (i % 2) },
					],
				});
			}
			sections.push({ id: `sec-${s + 1}`, title: `Section ${s + 1}`, steps });
		}
		const bigGuide: Guide = {
			v: 1,
			id: "perf-guide-2000",
			game: "sunlit-reach",
			title: "Performance Benchmark Guide",
			sections,
			created: 1,
			updated: 1,
		};

		const t0 = performance.now();
		const view = deriveGuideView({
			guide: bigGuide,
			found,
			markerExists: () => "yes",
		});
		const elapsedMs = performance.now() - t0;
		console.log(`[guides] deriveGuideView(2,000 steps, 30,000 found markers): ${elapsedMs.toFixed(2)} ms`);

		expect(view.counts.total).toBe(2000);
		expect(view.counts.done).toBe(1000);
		expect(elapsedMs).toBeLessThan(250);
	}, 30_000);
});

describe("shared/guide-import: URL parsing and text-to-steps conversion", () => {
	test("parseMarkerLink and extractMarkerLinksFromText parse #loc, ?loc, and locationIds links", () => {
		expect(parseMarkerLink("#loc=1001")).toEqual({ markerId: 1001 });
		expect(parseMarkerLink("?loc=2002&map=underdepths")).toEqual({ markerId: 2002, mapSlug: "underdepths" });
		expect(parseMarkerLink("https://mapgenie.io/elden-ring/maps/the-lands-between?locationIds=165234")).toEqual({
			markerId: 165234,
			mapSlug: "the-lands-between",
		});
		expect(parseMarkerLink("https://atlas.verticordia.com/maps/hollow-knight/#loc=42")).toEqual({
			markerId: 42,
			mapSlug: "hollow-knight",
		});
		expect(parseMarkerLink("javascript:alert(1)")).toBeNull();
		expect(parseMarkerLink("https://example.com/no-id")).toBeNull();

		const text = "Check [North Shrine](#loc=101) and [South Chest](https://mapgenie.io/g/maps/m?locationIds=202).";
		expect(extractMarkerLinksFromText(text)).toEqual([101, 202]);
	}, 30_000);

	test("linesToSteps converts markdown checklists and numbered lists into steps with bound marker targets", () => {
		const raw = [
			"- [ ] Speak with the Elder at Dawnvale Camp",
			"1. Attune the [North Waystone](#loc=1001)",
			"* [x] Open [West Chest](?locationIds=2001) and [East Chest](#loc=2002)",
			"   ",
		].join("\n");
		const steps = linesToSteps(raw);
		expect(steps).toEqual([
			{ id: "step-1", kind: "task", title: "Speak with the Elder at Dawnvale Camp" },
			{
				id: "step-2",
				kind: "task",
				title: "Attune the North Waystone",
				targets: [{ kind: "marker", marker: 1001 }],
			},
			{
				id: "step-3",
				kind: "task",
				title: "Open West Chest and East Chest",
				targets: [
					{ kind: "marker", marker: 2001 },
					{ kind: "marker", marker: 2002 },
				],
			},
		]);
	}, 30_000);

	test("suggestRegionTitle resolves explicit marker regions, polygon centroids, and clean fallbacks", () => {
		const regions = [
			{
				id: 10,
				title: "Outer Basin",
				parent_region_id: null,
				features: [
					{
						type: "Feature",
						geometry: {
							type: "Polygon",
							coordinates: [
								[
									[0, 0],
									[20, 0],
									[20, 20],
									[0, 20],
									[0, 0],
								],
							],
						},
					},
				],
			},
			{
				id: 11,
				title: "Inner Ruins",
				parent_region_id: 10,
				features: [
					{
						type: "Feature",
						geometry: {
							type: "Polygon",
							coordinates: [
								[
									[2, 2],
									[8, 2],
									[8, 8],
									[2, 8],
									[2, 2],
								],
							],
						},
					},
				],
			},
		];
		const byId = new Map<number, any>(regions.map((r) => [r.id, r]));

		// 1. Explicit majority marker region wins
		expect(
			suggestRegionTitle(
				[
					{ region: 10, lng: 5, lat: 5 },
					{ region: 11, lng: 5, lat: 5 },
					{ region: 11, lng: 6, lat: 6 },
				],
				regions,
				byId,
			),
		).toBe("Inner Ruins");

		// 2. Fallback to polygon centroid prefers subregion over parent
		expect(
			suggestRegionTitle(
				[
					{ region: null, lng: 4, lat: 4 },
					{ region: null, lng: 6, lat: 6 },
				],
				regions,
				byId,
			),
		).toBe("Inner Ruins");

		// 3. Centroid in outer region returns parent name
		expect(
			suggestRegionTitle(
				[
					{ region: null, lng: 14, lat: 14 },
					{ region: null, lng: 16, lat: 16 },
				],
				regions,
				byId,
			),
		).toBe("Outer Basin");

		// 4. Outside any polygon & no region falls back gracefully without blocking
		expect(
			suggestRegionTitle(
				[
					{ region: null, lng: 50, lat: 50 },
					{ region: null, lng: 52, lat: 52 },
				],
				regions,
				byId,
			),
		).toBe("Selected area (2 targets)");
	}, 30_000);
});