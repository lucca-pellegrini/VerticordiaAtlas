// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	convertPolygonsToRegions,
	generateLootAtlasSpriteSheet,
	isLootAtlas,
	parseLootAtlasSlug,
	slugify,
} from "../scripts/lootatlas.ts";

describe("scripts/lootatlas helpers", () => {
	test("isLootAtlas identifies Loot Atlas URLs correctly", () => {
		expect(isLootAtlas("https://app.lootatlas.com/games/firewatch")).toBe(true);
		expect(isLootAtlas("https://lootatlas.com/games/the-witness")).toBe(true);
		expect(isLootAtlas("https://api.lootatlas.com/api/v1/games")).toBe(true);
		expect(isLootAtlas("https://mapgenie.io/witcher-3")).toBe(false);
		expect(isLootAtlas("https://fallout4map.com")).toBe(false);
		expect(isLootAtlas("not-a-url")).toBe(false);
	});

	test("parseLootAtlasSlug extracts game and strategy slugs", () => {
		expect(parseLootAtlasSlug("https://app.lootatlas.com/games/firewatch")).toBe("firewatch");
		expect(parseLootAtlasSlug("https://app.lootatlas.com/games/Strategy,%20Wargame,%20RTS")).toBe(
			"Strategy, Wargame, RTS",
		);
		expect(parseLootAtlasSlug("https://app.lootatlas.com/strategies/two-forks-1")).toBe("two-forks-1");
		expect(parseLootAtlasSlug("apex-legends")).toBe("apex-legends");
	});

	test("slugify normalizes titles and slugs", () => {
		expect(slugify("Two Forks")).toBe("two-forks");
		expect(slugify("Strategy, Wargame, RTS")).toBe("strategy-wargame-rts");
		expect(slugify("Audio Kiosk")).toBe("audio-kiosk");
	});

	test("convertPolygonsToRegions creates valid GeoJSON features", () => {
		const rawPolygons = [
			{
				id: "poly-1",
				name: "Observation Point",
				color: "#ff0000",
				centerLat: 10.5,
				centerLong: 20.5,
				polygon: {
					type: "Polygon" as const,
					coordinates: [
						[
							{ lat: 10, lng: 20 },
							{ lat: 11, lng: 20 },
							{ lat: 11, lng: 21 },
						],
					],
				},
			},
		];

		const regions = convertPolygonsToRegions(rawPolygons, 1);
		expect(regions.length).toBe(1);
		expect(regions[0].title).toBe("Observation Point");
		expect(regions[0].center_x).toBe(20.5);
		expect(regions[0].center_y).toBe(10.5);

		const feat = regions[0].features[0];
		expect(feat.geometry.type).toBe("Polygon");
		// Ensure the ring is closed: 3 input points + 1 closing point = 4 points
		const ring = feat.geometry.coordinates[0];
		expect(ring.length).toBe(4);
		expect(ring[0]).toEqual([20, 10]);
		expect(ring[3]).toEqual([20, 10]);
	});

	test("generateLootAtlasSpriteSheet creates valid 1x and 2x sprites and JSON defs", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "lootatlas-sprite-test-"));
		try {
			const mockCategories = [
				{
					id: "cat-1",
					name: "Campfire",
					color: "#ffaa00",
					iconUri: "",
				},
				{
					id: "cat-2",
					name: "Supply Drop",
					color: "#00aaff",
					iconUri: "",
				},
			];

			const sprite = await generateLootAtlasSpriteSheet(mockCategories, tmpDir);
			expect(sprite.sprites).toBe(2);
			expect(sprite.json).toBe("markers.json");
			expect(sprite.png).toBe("markers.png");
			expect(sprite.json2x).toBe("markers@2x.json");
			expect(sprite.png2x).toBe("markers@2x.png");

			const defs1x = JSON.parse(await readFile(path.join(tmpDir, "markers.json"), "utf8"));
			const defs2x = JSON.parse(await readFile(path.join(tmpDir, "markers@2x.json"), "utf8"));

			expect(defs1x["campfire"]).toBeDefined();
			expect(defs1x["campfire"].width).toBe(33);
			expect(defs1x["campfire"].height).toBe(44);
			expect(defs1x["campfire"].pixelRatio).toBe(1);

			expect(defs2x["campfire"]).toBeDefined();
			expect(defs2x["campfire"].width).toBe(66);
			expect(defs2x["campfire"].height).toBe(88);
			expect(defs2x["campfire"].pixelRatio).toBe(2);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});
});