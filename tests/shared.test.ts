// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";

import { esc, fmt, fmtEn } from "../src/shared/escape.ts";
import { flat, fuzzyScore, levenshtein, norm, words } from "../src/shared/search.ts";
import { packMarker, unpackMarker } from "../src/shared/share-link.ts";
import { contentKey, fnv, POSITION_FIELDS, sendKey, stable, TOUCH_FIELD } from "../src/shared/sync-rules.ts";
import { deriveLightAccentSoft, deriveLightTheme, glyphInk, hexToHsl, hslToHex } from "../src/shared/theme-math.ts";

describe("shared/search", () => {
	test("norm strips diacritics and lowercases", () => {
		expect(norm("Élan & Árbol")).toBe("elan & arbol");
		expect(norm(null)).toBe("");
		expect(norm(undefined)).toBe("");
	});

	test("flat collapses non-alphanumeric runs to single spaces", () => {
		expect(flat("Armorer's Cookbook [1]")).toBe("armorer s cookbook 1");
		expect(flat("  --Hello,   World!-- ")).toBe("hello world");
	});

	test("words keeps only words of 3 or more characters", () => {
		expect(words("An Armorer's Cookbook in a Tower")).toEqual(["armorer", "cookbook", "tower"]);
	});

	test("levenshtein computes exact edit distance", () => {
		expect(levenshtein("", "")).toBe(0);
		expect(levenshtein("wolf", "")).toBe(4);
		expect(levenshtein("", "wolf")).toBe(4);
		expect(levenshtein("wolf", "wolf")).toBe(0);
		expect(levenshtein("returm", "return")).toBe(1);
		expect(levenshtein("elden", "eldne")).toBe(2);
	});

	test("fuzzyScore matches within typo thresholds and ignores short words", () => {
		const target = words("Tower of Return");
		expect(fuzzyScore(["tower", "of", "returm"], target)).toBe(1);
		expect(fuzzyScore(["of", "in"], target)).toBeNull();
		expect(fuzzyScore(["zzzzzz"], target)).toBeNull();
		expect(fuzzyScore(["towr"], target)).toBe(1);
		expect(fuzzyScore(["twr"], target)).toBeNull(); // length 3 allows only 1 edit, distance to 'tower' is 2
	});
});

describe("shared/sync-rules", () => {
	test("stable produces canonical JSON with sorted keys and omits undefined", () => {
		const a = { b: 2, a: 1, c: undefined, nested: { z: true, y: [3, 2, 1] } };
		const b = { nested: { y: [3, 2, 1], z: true }, a: 1, b: 2 };
		expect(stable(a)).toBe(stable(b));
		expect(stable(a)).toBe('{"a":1,"b":2,"nested":{"y":[3,2,1],"z":true}}');
		expect(stable(null)).toBe("null");
		expect(stable(undefined)).toBe("null");
	});

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
	});

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
	});

	test("fnv hashes strings deterministically to 32-bit hex", () => {
		expect(fnv("")).toBe("811c9dc5");
		expect(fnv("hello")).toBe(fnv("hello"));
		expect(fnv("hello")).not.toBe(fnv("world"));
	});
});

describe("share-link", () => {
	test("packs and unpacks a user marker losslessly (with coordinate rounding and validation)", async () => {
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
	});

	test("unpackMarker returns null on malformed or out-of-bounds payloads", async () => {
		expect(await unpackMarker("")).toBeNull();
		expect(await unpackMarker("not valid base64!!!")).toBeNull();
		expect(await unpackMarker("AAAA")).toBeNull();

		const badLat = await packMarker({ title: "Out of bounds", lat: 95, lng: 0, map: "world" });
		expect(await unpackMarker(badLat)).toBeNull();
	});
});

describe("shared/escape and shared/theme-math", () => {
	test("esc, fmt, and fmtEn format strings and numbers", () => {
		expect(esc('A & <"B">')).toBe("A &amp; &lt;&quot;B&quot;&gt;");
		expect(esc(null)).toBe("");
		expect(fmtEn(12345)).toBe("12,345");
		expect(typeof fmt(12345)).toBe("string");
	});

	test("theme-math functions compute consistent HSL and light theme palettes", () => {
		const [h, s, l] = hexToHsl("#d6453b");
		expect(hslToHex(h, s, l)).toBe("#d6453b");
		expect(deriveLightAccentSoft("#d6453b")).toMatch(/^#[0-9a-f]{6}$/);
		const light = deriveLightTheme({ accent: "#d6453b" });
		expect(light["accent-soft"]).toBe(deriveLightAccentSoft("#d6453b"));
		expect(glyphInk("#000000")).toBe("#ffffff");
		expect(glyphInk("#ffffff")).toBe("#14161a");
	});
});