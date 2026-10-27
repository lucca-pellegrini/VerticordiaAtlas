// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";

import {
	detectMissingTilesets,
	type GameInfo,
	resolveGames,
	tilesetKey,
	tilesetTail,
} from "../scripts/update-games.ts";

describe("scripts/update-games helper functions", () => {
	test("tilesetKey extracts directory key from path or pattern", () => {
		expect(tilesetKey({ path: "rdr2/world/atlas-dark-v1" })).toBe("atlas-dark-v1");
		expect(tilesetKey({ path: "hitman-2/miami/default-v2/" })).toBe("default-v2");
		expect(tilesetKey({ pattern: "games/totk/world/default-v1/{z}/{x}/{y}.jpg" })).toBe("default-v1");
		expect(tilesetKey({ id: 999 })).toBe("ts999");
	});

	test("tilesetTail extracts template placeholder tail", () => {
		expect(tilesetTail({ pattern: "games/rdr2/{z}/{x}/{y}.jpg" })).toBe("{z}/{x}/{y}.jpg");
		expect(tilesetTail({ extension: "png" })).toBe("{z}/{x}/{y}.png");
	});

	test("resolveGames preserves directory folder and locks identity", async () => {
		const games = await resolveGames(["rdr2"], false, "./public/maps");
		expect(games.length).toBe(1);
		expect(games[0].folder).toBe("rdr2");
		expect(games[0].meta.id).toBe("rdr2");
		expect(games[0].meta.title).toBe("Red Dead Redemption 2");
	});

	test("detectMissingTilesets flags missing tile pyramids", async () => {
		const games = await resolveGames(["rdr2"], false, "./public/maps");
		const missing = await detectMissingTilesets(games[0]);
		expect(missing.length).toBe(1);
		expect(missing[0].key).toBe("atlas-dark-v1");
		expect(missing[0].ts.name).toBe("Detailed");
	});
});