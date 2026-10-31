// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { diveForSeed, findSiblingTiles } from "../scripts/add-game.ts";
import { createTileDashboard } from "../scripts/tile-downloader-tui.ts";

describe("tile downloader helper functions", () => {
	test("findSiblingTiles scans existing sibling tile directories at max zoom", async () => {
		const tmp = path.join(os.tmpdir(), `test-sibling-tiles-${Date.now()}`);
		try {
			const existingTs = path.join(tmp, "pywel", "tiles", "default-v3", "17");
			await mkdir(path.join(existingTs, "500"), { recursive: true });
			await mkdir(path.join(existingTs, "501"), { recursive: true });
			await writeFile(path.join(existingTs, "500", "600.jpg"), "tile1");
			await writeFile(path.join(existingTs, "500", "601.jpg"), "tile2");
			await writeFile(path.join(existingTs, "501", "700.jpg"), "tile3");

			const seeds = await findSiblingTiles(tmp, "pywel/tiles/faction-v3/{z}/{x}/{y}.jpg", 17);
			expect(seeds.length).toBe(3);
			const set = new Set(seeds.map(([x, y]) => `${x},${y}`));
			expect(set.has("500,600")).toBe(true);
			expect(set.has("500,601")).toBe(true);
			expect(set.has("501,700")).toBe(true);

			// Calling for same tileset or non-existent zoom returns empty
			const empty = await findSiblingTiles(tmp, "pywel/tiles/default-v3/{z}/{x}/{y}.jpg", 17);
			expect(empty.length).toBe(0);

			const noZoom = await findSiblingTiles(tmp, "pywel/tiles/faction-v3/{z}/{x}/{y}.jpg", 18);
			expect(noZoom.length).toBe(0);
		} finally {
			await rm(tmp, { recursive: true, force: true }).catch(() => {});
		}
	});

	test("diveForSeed finds child tile down the pyramid", async () => {
		// Mock HTTP server responding only to 1/0/0, 2/1/1, and 3/2/3
		const validTiles = new Set(["1/0/0", "2/1/1", "3/2/3"]);
		const server = http.createServer((req, res) => {
			const m = /^\/tiles\/(\d+\/\d+\/\d+)\.png$/.exec(req.url!);
			if (m && validTiles.has(m[1])) {
				res.writeHead(200, { "Content-Type": "image/png" });
				res.end(Buffer.from("dummy-png-header"));
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as any).port;
		const base = `http://127.0.0.1:${port}/tiles`;

		try {
			const seed = await diveForSeed([[0, 0]], 1, 3, (z, x, y) => `${base}/${z}/${x}/${y}.png`);
			expect(seed).toEqual([2, 3]);
		} finally {
			server.close();
		}
	});

	test("createTileDashboard tracks stats and rates accurately in non-TUI mode", async () => {
		const dashboard = await createTileDashboard({
			gameTitle: "Crimson Desert",
			gameSlug: "crimson-desert",
			mapSlug: "pywel",
			tilesetName: "Factions",
			zoom: 17,
			pattern: "{z}/{x}/{y}.jpg",
			destDir: "/tmp",
			noTui: true,
			totalExpected: 10,
		});

		dashboard.updateBounds(100, 200, 300, 400, 10);
		dashboard.onTile(100, 300, "saved", 2048);
		dashboard.onTile(101, 301, "skipped");
		dashboard.onTile(102, 302, "missing");
		dashboard.onTile(103, 303, "failed");

		const stats = dashboard.getStats();
		expect(stats.saved).toBe(1);
		expect(stats.skipped).toBe(1);
		expect(stats.missing).toBe(1);
		expect(stats.failed).toBe(1);
		expect(stats.bytes).toBe(2048);
		expect(stats.elapsedSeconds).toBeGreaterThanOrEqual(0);

		await dashboard.finish();
	});
});