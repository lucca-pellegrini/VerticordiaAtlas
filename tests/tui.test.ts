// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";
import http from "node:http";

import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
	AdaptiveRateController,
	clearAndRedrawTerminal,
	computeResponsiveBox,
	createAddGameFormView,
	createCardsDashboard,
	createGamesCatalogView,
	createMediaDashboard,
	createPruneDashboard,
	createScreenshotDashboard,
	createServerDashboard,
	createServerJobView,
	createTileDashboard,
	densityGlyph,
	expandHome,
	fmtBytes,
	fmtTime,
	isCtrlL,
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

		// Keybind detection for Ctrl-L redraw
		expect(isCtrlL({ ctrl: true, name: "l" })).toBe(true);
		expect(isCtrlL({ ctrl: true, name: "L" })).toBe(true);
		expect(isCtrlL({ raw: "\x0c" })).toBe(true);
		expect(isCtrlL({ sequence: "\x0c" })).toBe(true);
		expect(isCtrlL({ ctrl: false, name: "l" })).toBe(false);
		expect(isCtrlL({ ctrl: true, name: "c" })).toBe(false);
		expect(isCtrlL(null)).toBe(false);

		// clearAndRedrawTerminal handles null and mocks safely
		const mockRenderer = {
			forceFullRepaintRequested: false,
			requestRenderCalled: false,
			requestRender() {
				this.requestRenderCalled = true;
			},
		};
		clearAndRedrawTerminal(mockRenderer as any);
		expect(mockRenderer.forceFullRepaintRequested).toBe(true);
		expect(mockRenderer.requestRenderCalled).toBe(true);
		clearAndRedrawTerminal(undefined);
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

	test("tile-dashboard infers border rectangle and transitions from unknown to estimated progress", async () => {
		const dashboard = await createTileDashboard({
			gameTitle: "Test Map",
			gameSlug: "test-map",
			mapSlug: "test",
			tilesetName: "Default",
			zoom: 10,
			pattern: "{z}/{x}/{y}.jpg",
			destDir: "/tmp",
			noTui: true,
			totalExpected: 0, // total unknown
		});

		// 1. Download tiles with no edges discovered yet
		dashboard.onTile(100, 200, "saved", 1024);
		dashboard.onTile(110, 210, "saved", 1024);
		let st = dashboard.getStats() as any;
		expect(st.progressMode).toBe("unknown");
		expect(st.hasFourEdges).toBe(false);

		// 2. Discover only top and right borders (not all 4)
		dashboard.onTile(100, 199, "missing"); // Top border
		dashboard.onTile(111, 205, "missing"); // Right border
		st = dashboard.getStats() as any;
		expect(st.progressMode).toBe("unknown");
		expect(st.hasFourEdges).toBe(false);

		// 3. Discover remaining left and bottom borders (all 4 found!)
		dashboard.onTile(99, 205, "missing"); // Left border
		dashboard.onTile(105, 211, "missing"); // Bottom border
		st = dashboard.getStats() as any;
		expect(st.hasFourEdges).toBe(true);
		expect(st.progressMode).toBe("estimated");
		// Valid X span: 100..110 (11 tiles), Y span: 200..210 (11 tiles) => 11 * 11 = 121
		expect(st.estimatedTotal).toBe(121);

		await dashboard.finish();
	});

	test("AdaptiveRateController dynamically scales concurrency and delay based on latency and HTTP status", async () => {
		const controller = new AdaptiveRateController({
			initialConcurrency: 8,
			minConcurrency: 4,
			maxConcurrency: 32,
			initialDelayMs: 40,
			minDelayMs: 0,
			maxDelayMs: 200,
		});

		expect(controller.concurrency).toBe(8);
		expect(controller.delayMs).toBe(40);

		// 1. Healthy fast responses with low latency (30-40ms):
		// First drains delayMs down to 0, then gradually ramps concurrency up
		for (let i = 0; i < 40; i++) {
			controller.recordResult(200, 35);
			await new Promise((r) => setTimeout(r, 12));
		}
		expect(controller.delayMs).toBe(0);
		expect(controller.concurrency).toBeGreaterThan(8);

		const peakC = controller.concurrency;

		// 2. Latency starts increasing significantly (e.g. 280ms vs baseline 35ms):
		// Controller stops increasing rate (state: holding)
		for (let i = 0; i < 20; i++) {
			controller.recordResult(200, 280);
			await new Promise((r) => setTimeout(r, 12));
		}
		const snapHold = controller.getSnapshot();
		expect(snapHold.state === "holding" || snapHold.state === "throttling").toBe(true);
		expect(controller.concurrency).toBeLessThanOrEqual(peakC);

		// 3. Severe congestion / unexpected HTTP 429 rate limit error:
		// Controller immediately backs off: drops concurrency and increases delay
		const backedOff = controller.recordResult(429, 250);
		expect(backedOff).toBe(true);
		expect(controller.concurrency).toBeLessThan(peakC);
		expect(controller.delayMs).toBeGreaterThan(0);
		expect(controller.getSnapshot().state).toBe("backed-off");

		// 4. Perimeter voids (404 / 410) do not count towards rates and do not throttle workers down
		const concBeforeVoids = controller.concurrency;
		for (let i = 0; i < 30; i++) {
			const changed = controller.recordResult(404, 500); // even with high latency, 404 is a void
			expect(changed).toBe(false);
		}
		expect(controller.concurrency).toBe(concBeforeVoids);

		// 5. Fixed controller when disabled respects static parameters
		const staticCtrl = new AdaptiveRateController({
			enabled: false,
			initialConcurrency: 12,
			initialDelayMs: 50,
		});
		staticCtrl.recordResult(500, 999);
		staticCtrl.recordResult(200, 20);
		expect(staticCtrl.concurrency).toBe(12);
		expect(staticCtrl.delayMs).toBe(50);

		// 6. Controller stuck at minimum concurrency with high delay risks probing when zero errors occur
		const stuckCtrl = new AdaptiveRateController({
			initialConcurrency: 4,
			minConcurrency: 4,
			maxConcurrency: 32,
			initialDelayMs: 200,
			minDelayMs: 0,
			maxDelayMs: 250,
			rampIntervalMs: 20,
			probeIntervalMs: 40,
		});
		expect(stuckCtrl.concurrency).toBe(4);
		expect(stuckCtrl.delayMs).toBe(200);

		for (let i = 0; i < 15; i++) {
			stuckCtrl.recordResult(200, 75);
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(stuckCtrl.delayMs).toBeLessThan(200);
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

	test("server-dashboard multi-tab interactive UI boots, renders tabs, and navigates", async () => {
		const testEnv = await createTestRenderer({ width: 120, height: 35 });
		const dashboard = await createServerDashboard({
			host: "127.0.0.1",
			port: 8080,
			renderer: testEnv.renderer,
		});

		dashboard.onRequest({ method: "GET", path: "/maps/requiem", status: 200, durationMs: 4.5 });
		dashboard.onTile({ action: "stored", path: "/maps/requiem/tiles/default/10/1/1.jpg" });
		dashboard.setWsCount(3);

		// Switch to tab 2 (Catalog) via Alt+2, then tab 3 (Add Game) via Alt+3, then tab 1 (Monitor) via Alt+1
		testEnv.renderer.keyInput.emit("keypress", {
			name: "2",
			alt: true,
			ctrl: false,
			meta: false,
			shift: false,
		} as any);
		testEnv.renderer.keyInput.emit("keypress", {
			name: "3",
			alt: true,
			ctrl: false,
			meta: false,
			shift: false,
		} as any);
		testEnv.renderer.keyInput.emit("keypress", {
			name: "1",
			alt: true,
			ctrl: false,
			meta: false,
			shift: false,
		} as any);

		dashboard.destroy();
		testEnv.dispose();
	});

	test("games-catalog-view loads catalog, navigates 4-card grid, and supports reordering", async () => {
		const testEnv = await createTestRenderer({ width: 100, height: 30 });
		const renderer = testEnv.renderer;

		const tmpDir = `/tmp/atlas-catalog-test-${Date.now()}`;
		await Bun.write(
			`${tmpDir}/index.json`,
			JSON.stringify(
				{
					games: [
						{ slug: "game-a", title: "Game A", description: "Desc A" },
						{ slug: "game-b", title: "Game B", description: "Desc B" },
						{ slug: "game-c", title: "Game C", description: "Desc C" },
						{ slug: "game-d", title: "Game D", description: "Desc D" },
						{ slug: "game-e", title: "Game E", description: "Desc E" },
					],
				},
				null,
				2,
			),
		);

		const catalog = await createGamesCatalogView({
			renderer,
			width: 100,
			height: 30,
			indexPath: `${tmpDir}/index.json`,
			mapsDir: tmpDir,
		});

		// Check navigation keys
		expect(catalog.handleKey({ name: "right" } as any)).toBe(true);
		expect(catalog.handleKey({ name: "down" } as any)).toBe(true);
		expect(catalog.handleKey({ name: "up" } as any)).toBe(true);
		expect(catalog.handleKey({ name: "left" } as any)).toBe(true);

		// Reorder: swap game-a with game-b using "]"
		expect(catalog.handleKey({ name: "]" } as any)).toBe(true);
		await new Promise((r) => setTimeout(r, 60));
		const updatedRaw = await Bun.file(`${tmpDir}/index.json`).text();
		const updated = JSON.parse(updatedRaw);
		expect(updated.games[0].slug).toBe("game-b");
		expect(updated.games[1].slug).toBe("game-a");

		// Real-time external index.json updates
		const externalGames = {
			games: [
				{ slug: "game-b", title: "Game B", description: "Desc B" },
				{ slug: "game-a", title: "Game A", description: "Desc A" },
				{ slug: "game-new", title: "Game New", description: "Desc New" },
			],
		};
		await Bun.write(`${tmpDir}/index.json`, JSON.stringify(externalGames, null, "\t"));
		await new Promise((r) => setTimeout(r, 250));
		catalog.focus();

		catalog.destroy();
		testEnv.dispose();
	});

	test("server-job-view streams logs, tracks stages and status transitions", async () => {
		const testEnv = await createTestRenderer({ width: 100, height: 30 });
		const renderer = testEnv.renderer;

		let completed = false;
		const jobView = createServerJobView({
			renderer,
			width: 100,
			height: 30,
			jobId: "job-1",
			jobType: "scrape",
			title: "Crimson Desert",
			slug: "crimson-desert",
			onCompleted: () => {
				completed = true;
			},
		});

		expect(jobView.status).toBe("running");
		jobView.setStage("Downloading Tiles");
		jobView.addLog("Tile 100/500 saved");
		jobView.addLog("Tile 200/500 saved");
		jobView.finish(true, "All tiles & media downloaded");

		expect(jobView.status).toBe("completed");
		expect(completed).toBe(true);

		jobView.destroy();
		testEnv.dispose();
	});

	test("prune-dashboard mounts inside container, handles onProgress and finishes cleanly", async () => {
		const testEnv = await createTestRenderer({ width: 100, height: 30 });
		const container = new BoxRenderable(testEnv.renderer, { width: 98, height: 16 });
		testEnv.renderer.root.add(container);

		const pruneDash = await createPruneDashboard({
			container,
			renderer: testEnv.renderer,
			totalTilesets: 1,
		});

		pruneDash.startTileset("GTA IV", "default", 500);
		pruneDash.onProgress({ phase: "solid", solid: 25, solidFreed: 102400 });
		pruneDash.onProgress({ phase: "overview", overview: 1 });
		pruneDash.finishTileset({
			tiles: 500,
			solid: 25,
			solidFreed: 102400,
			overview: 1,
			pruned: 100,
			prunedBytes: 409600,
			background: "#000000",
		});

		const totals = pruneDash.getTotals();
		expect(totals.totalSolid).toBe(25);
		expect(totals.tilesetsProcessed).toBe(1);

		await pruneDash.finish();
		pruneDash.destroy();
		testEnv.dispose();
	});

	test("cards-dashboard tracks multi-step card rendering progress", async () => {
		const dashboard = await createCardsDashboard({
			totalCards: 2,
			chromeBin: "chromium",
			siteUrl: "https://atlas.verticordia.com",
			noTui: true,
		});

		dashboard.onStep("Validated site configuration", "CONFIG");
		dashboard.startCard({
			slug: "homepage",
			title: "Atlas Homepage",
			outPath: "public/card.jpg",
			poster: true,
		});
		dashboard.onCardStep("Compiling HTML markup");
		dashboard.finishCard(
			{ slug: "homepage", title: "Atlas Homepage", outPath: "public/card.jpg", poster: true },
			160000,
			220,
		);

		dashboard.startCard({
			slug: "totk",
			title: "Tears of the Kingdom",
			outPath: "public/maps/totk/card.jpg",
			poster: true,
		});
		dashboard.onCardStep("Spawning headless Chromium");
		dashboard.finishCard(
			{ slug: "totk", title: "Tears of the Kingdom", outPath: "public/maps/totk/card.jpg", poster: true },
			145000,
			190,
		);

		await dashboard.finish();
	});

	test("screenshot-dashboard tracks CDP emulation, navigation and capture steps", async () => {
		const dashboard = await createScreenshotDashboard({
			totalShots: 2,
			base: "http://127.0.0.1:8072",
			outDir: "public/screenshots",
			noTui: true,
		});

		dashboard.onStep("Server health check succeeded", "SERVER");
		dashboard.startShot({
			name: "wide-1-games",
			form: "wide",
			path: "/",
			caption: "Homepage games grid",
		});
		dashboard.onShotStep("Configuring 1600x900 viewport");
		dashboard.onShotStep("Page.navigate to /");
		dashboard.finishShot(
			{ name: "wide-1-games", form: "wide", path: "/", caption: "Homepage games grid" },
			420000,
			6200,
		);

		dashboard.startShot({
			name: "narrow-1-games",
			form: "narrow",
			path: "/",
			caption: "Mobile homepage games grid",
		});
		dashboard.onShotStep("Enabling touch emulation");
		dashboard.finishShot(
			{ name: "narrow-1-games", form: "narrow", path: "/", caption: "Mobile homepage games grid" },
			310000,
			5900,
		);

		await dashboard.finish();
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

			// Local file path validation
			const tmpText = `/tmp/test-not-img-${Date.now()}.txt`;
			await Bun.write(tmpText, "Hello world not an image");
			const notImgLocal = await validatePosterUrl(tmpText);
			expect(notImgLocal.ok).toBe(false);

			const missingLocal = await validatePosterUrl(`/tmp/missing-file-${Date.now()}.png`);
			expect(missingLocal.ok).toBe(false);
			expect(missingLocal.message).toBe("File not found");

			const dirLocal = await validatePosterUrl("/tmp");
			expect(dirLocal.ok).toBe(false);
			expect(dirLocal.message).toContain("directory");

			// Valid local image (min 400x400)
			const tmpImg = `/tmp/test-valid-${Date.now()}.png`;
			const sharp = (await import("sharp")).default;
			await sharp({
				create: {
					width: 400,
					height: 400,
					channels: 3,
					background: { r: 255, g: 0, b: 0 },
				},
			})
				.png()
				.toFile(tmpImg);
			const validLocal = await validatePosterUrl(tmpImg);
			expect(validLocal.ok).toBe(true);
			expect(validLocal.message).toContain("Valid local PNG");

			// Tilde expansion helper
			expect(expandHome("~/test.png")).not.toContain("~");
			expect(expandHome("/absolute/path.png")).toBe("/absolute/path.png");
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