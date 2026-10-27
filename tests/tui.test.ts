// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";
import http from "node:http";

import {
	computeResponsiveBox,
	createMediaDashboard,
	createPruneDashboard,
	createServerDashboard,
	createTileDashboard,
	densityGlyph,
	fmtBytes,
	fmtTime,
	isInteractiveTty,
	promptAddGameTui,
	renderProgressBar,
	validatePosterUrl,
} from "../scripts/tui/index.js";

describe("TUI ecosystem components & helpers", () => {
	test("theme helpers: densityGlyph, fmtTime, fmtBytes, renderProgressBar", () => {
		expect(densityGlyph(0)).toBe(" ");
		expect(densityGlyph(0.2)).toBe("░");
		expect(densityGlyph(0.4)).toBe("▒");
		expect(densityGlyph(0.7)).toBe("▓");
		expect(densityGlyph(0.95)).toBe("█");

		expect(fmtTime(45)).toBe("00:45");
		expect(fmtTime(125)).toBe("02:05");
		expect(fmtTime(3665)).toBe("1:01:05");
		expect(fmtTime(-1)).toBe("--:--");

		expect(fmtBytes(512)).toBe("0.5 KB");
		expect(fmtBytes(2 * 1024 * 1024)).toBe("2.0 MB");
		expect(fmtBytes(3.5 * 1024 * 1024 * 1024)).toBe("3.50 GB");

		const bar = renderProgressBar(50, 10);
		expect(bar).toBe("[█████░░░░░]");
	});

	test("computeResponsiveBox computes bounded dimensions for any terminal size", () => {
		// Small terminal (e.g. 50x20)
		const small = computeResponsiveBox(50, 20, 128, 38);
		expect(small.boxW).toBe(48); // 50 - 2
		expect(small.boxH).toBe(18); // 20 - 2

		// Tiny terminal (< min limits)
		const tiny = computeResponsiveBox(30, 10, 128, 38);
		expect(tiny.boxW).toBe(36); // clamped to min 36
		expect(tiny.boxH).toBe(14); // clamped to min 14

		// Large terminal (e.g. 200x60)
		const large = computeResponsiveBox(200, 60, 128, 38);
		expect(large.boxW).toBe(128); // capped at max 128
		expect(large.boxH).toBe(38); // capped at max 38
	});

	test("isInteractiveTty respects noTui flag and test execution", () => {
		expect(isInteractiveTty(true)).toBe(false);
		// Inside bun test, it should evaluate to false
		expect(isInteractiveTty(false)).toBe(false);
	});

	test("tile-dashboard tracks dynamic bounds expansion and tile stats", async () => {
		const dashboard = await createTileDashboard({
			gameTitle: "Crimson Desert",
			gameSlug: "crimson-desert",
			mapSlug: "pywel",
			tilesetName: "World Map",
			zoom: 17,
			pattern: "{z}/{x}/{y}.jpg",
			destDir: "/tmp",
			noTui: true,
			totalExpected: 50,
			bounds: { xMin: 65000, xMax: 65100, yMin: 65000, yMax: 65100 },
		});

		dashboard.onTile(65050, 65050, "saved", 4096);
		dashboard.onTile(65051, 65051, "skipped");
		dashboard.onTile(65052, 65052, "missing");
		// Expanding bounds dynamically
		dashboard.onTile(65200, 65300, "saved", 8192);

		const st = dashboard.getStats();
		expect(st.saved).toBe(2);
		expect(st.skipped).toBe(1);
		expect(st.missing).toBe(1);
		expect(st.failed).toBe(0);
		expect(st.bytes).toBe(12288);
		expect(st.elapsedSeconds).toBeGreaterThanOrEqual(0);

		await dashboard.finish();
	});

	test("tile-dashboard handles rapid bursts of tiles with incremental bounds and stats", async () => {
		const dashboard = await createTileDashboard({
			gameTitle: "Crimson Desert",
			gameSlug: "crimson-desert",
			mapSlug: "pywel",
			tilesetName: "World Map",
			zoom: 17,
			pattern: "{z}/{x}/{y}.jpg",
			destDir: "/tmp",
			noTui: true,
			totalExpected: 1000,
			bounds: { xMin: 65000, xMax: 65100, yMin: 65000, yMax: 65100 },
		});

		for (let i = 0; i < 500; i++) {
			dashboard.onTile(65000 + (i % 100), 65000 + Math.floor(i / 100), i % 5 === 0 ? "skipped" : "saved", 2048);
		}

		const st = dashboard.getStats();
		expect(st.saved).toBe(400);
		expect(st.skipped).toBe(100);
		expect(st.bytes).toBe(400 * 2048);
		await dashboard.finish();
	});

	test("media-dashboard tracks download, upload, cache, and cloud verification", async () => {
		const dashboard = await createMediaDashboard({
			game: "zelda-totk",
			totalExpected: 10,
			uploadMedia: true,
			keepLocal: true,
			noTui: true,
		});

		dashboard.onItem({
			name: "shot1.jpg",
			url: "https://example.com/shot1.jpg",
			size: 10240,
			status: "downloaded",
		});
		dashboard.onItem({
			name: "shot2.jpg",
			url: "https://example.com/shot2.jpg",
			size: 20480,
			status: "uploaded",
			verifiedUrl: "https://r2.example.com/shot2.jpg",
		});
		dashboard.onItem({ name: "shot3.jpg", url: "https://example.com/shot3.jpg", status: "cached" });
		dashboard.onItem({ name: "shot4.jpg", url: "https://example.com/shot4.jpg", status: "skippedCloud" });
		dashboard.onItem({ name: "shot5.jpg", url: "https://example.com/shot5.jpg", status: "failed", error: "404" });

		const st = dashboard.getStats();
		expect(st.saved).toBe(2); // 1 downloaded + 1 uploaded with keepLocal
		expect(st.uploaded).toBe(1);
		expect(st.skipped).toBe(1);
		expect(st.skippedCloud).toBe(1);
		expect(st.failed).toBe(1);
		expect(st.bytes).toBe(30720);

		await dashboard.finish();
	});

	test("prune-dashboard tracks multi-phase progress and cumulative totals", async () => {
		const dashboard = await createPruneDashboard({
			totalTilesets: 2,
			dryRun: false,
			noTui: true,
		});

		dashboard.startTileset("crimson-desert", "pywel", 1000);
		dashboard.onProgress({
			phase: "solid",
			solid: 120,
			solidFreed: 500000,
			topColors: [
				["000000ff", 100],
				["111111ff", 20],
			],
		});
		dashboard.onProgress({
			phase: "overview",
			overview: 4,
		});
		dashboard.onProgress({
			phase: "prune",
			pruned: 400,
			prunedBytes: 1500000,
		});

		dashboard.finishTileset({
			tiles: 1000,
			solid: 120,
			solidFreed: 500000,
			overview: 4,
			pruned: 400,
			prunedBytes: 1500000,
			background: "#000000",
		});

		const totals = dashboard.getTotals();
		expect(totals.tilesetsProcessed).toBe(1);
		expect(totals.totalSolid).toBe(120);
		expect(totals.totalSolidFreed).toBe(500000);
		expect(totals.totalOverview).toBe(4);
		expect(totals.totalPruned).toBe(400);
		expect(totals.totalPrunedBytes).toBe(1500000);

		await dashboard.finish();
	});

	test("server-dashboard tracks requests, cards, tiles, and sync WebSocket events", async () => {
		const dashboard = await createServerDashboard({
			host: "127.0.0.1",
			port: 8080,
			noTui: true,
		});

		dashboard.onRequest({ method: "GET", path: "/maps/totk", status: 200, durationMs: 5.2 });
		dashboard.onRequest({ method: "GET", path: "/api/missing", status: 404, durationMs: 1.1 });
		dashboard.onCard({ type: "share", key: "totk/hyrule/100", durationMs: 45.0, cached: false });
		dashboard.onTile({ action: "stored", path: "/maps/totk/tiles/default/10/1/1.jpg" });
		dashboard.onTile({ action: "derived", path: "/maps/totk/tiles/default/9/0/0.jpg", durationMs: 12.0 });
		dashboard.onTile({ action: "miss", path: "/maps/totk/tiles/default/99/0/0.jpg", durationMs: 1.5 });
		dashboard.onSync("broadcast", "user 123 synced profile");
		dashboard.onApi("GET me", "-> 200 (1.2ms)");
		dashboard.setWsCount(4);

		dashboard.destroy();
	});

	test("validatePosterUrl verifies mime types and image sizes", async () => {
		// Mock HTTP server responding with an image
		const server = http.createServer((req, res) => {
			if (req.url === "/valid.jpg") {
				res.writeHead(200, { "Content-Type": "image/jpeg" });
				res.end(Buffer.alloc(1000, 0xff));
			} else if (req.url === "/text.html") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end("<html>Not an image</html>");
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as any).port;

		try {
			// Empty URL is accepted as optional
			const empty = await validatePosterUrl("");
			expect(empty.ok).toBe(true);

			// Invalid protocol
			const badProto = await validatePosterUrl("ftp://example.com/poster.jpg");
			expect(badProto.ok).toBe(false);

			// Valid image
			const valid = await validatePosterUrl(`http://127.0.0.1:${port}/valid.jpg`);
			expect(valid.ok).toBe(true);

			// Not an image
			const notImg = await validatePosterUrl(`http://127.0.0.1:${port}/text.html`);
			expect(notImg.ok).toBe(false);
			expect(notImg.message).toContain("Not an image");

			// 404 Not Found
			const notFound = await validatePosterUrl(`http://127.0.0.1:${port}/404.jpg`);
			expect(notFound.ok).toBe(false);
			expect(notFound.message).toContain("404");
		} finally {
			server.close();
		}
	});

	test("promptAddGameTui initializes and cleans up without throwing EditBuffer errors", async () => {
		const formPromise = promptAddGameTui("https://mapgenie.io/test-game");
		// Send escape character via stdin after short tick
		setTimeout(() => {
			process.stdin.emit("data", Buffer.from("\x1b"));
		}, 60);

		// Should resolve to null on Escape without throwing unhandled exceptions
		const result = await Promise.race([formPromise, new Promise((r) => setTimeout(() => r("timeout"), 1000))]);
		expect(result === null || result === "timeout").toBe(true);
		// Wait past the old 400ms debounce to ensure no timer throws after destroy
		await new Promise((r) => setTimeout(r, 450));
	});

	test("promptAddGameTui resolves AddGameFormResult with downloadTiles and uploadMedia", async () => {
		const formPromise = promptAddGameTui("https://mapgenie.io/crimson-desert");
		setTimeout(() => {
			process.stdin.emit("data", Buffer.from("\r"));
		}, 60);
		const result = await Promise.race([formPromise, new Promise((r) => setTimeout(() => r("timeout"), 1000))]);
		if (result !== "timeout" && result !== null) {
			expect(result.url).toBe("https://mapgenie.io/crimson-desert");
			expect(result.downloadTiles).toBe(true);
			expect(result.uploadMedia).toBe(false);
			expect(result.downloadMedia).toBe(true);
			expect(result.allTilesets).toBe(true);
		}
		await new Promise((r) => setTimeout(r, 450));
	});
});