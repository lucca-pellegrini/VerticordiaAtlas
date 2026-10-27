import { BoxRenderable, createCliRenderer, FrameBufferRenderable, RGBA, TextRenderable } from "@opentui/core";

import { fmt } from "../src/shared/escape.js";

export interface DashboardOptions {
	gameTitle: string;
	gameSlug: string;
	mapSlug: string;
	tilesetName: string;
	zoom: number;
	pattern: string;
	destDir: string;
	noTui?: boolean;
	totalExpected?: number;
	bounds?: { xMin: number; xMax: number; yMin: number; yMax: number };
}

export interface TileDashboard {
	updateBounds(xMin: number, xMax: number, yMin: number, yMax: number, totalExpected?: number): void;
	onTile(x: number, y: number, status: "saved" | "skipped" | "missing" | "failed", bytes?: number): void;
	finish(): Promise<void>;
	destroy(): void;
	getStats(): {
		saved: number;
		skipped: number;
		missing: number;
		failed: number;
		bytes: number;
		elapsedSeconds: number;
		tilesPerSecond: number;
	};
}

function fmtTime(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "--:--";
	const s = Math.floor(sec);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m >= 60) {
		const h = Math.floor(m / 60);
		return `${h}:${String(m % 60).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
	}
	return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

function fmtBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function createTileDashboard(opts: DashboardOptions): Promise<TileDashboard> {
	const startTime = Date.now();
	let saved = 0;
	let skipped = 0;
	let missing = 0;
	let failed = 0;
	let totalBytes = 0;
	let totalExpected = opts.totalExpected || 0;

	let xMin = opts.bounds?.xMin ?? Infinity;
	let xMax = opts.bounds?.xMax ?? -Infinity;
	let yMin = opts.bounds?.yMin ?? Infinity;
	let yMax = opts.bounds?.yMax ?? -Infinity;

	const samples: { time: number; tiles: number; bytes: number }[] = [];
	let lastLogTime = Date.now();

	const isInteractive = Boolean(
		process.stdout.isTTY && !opts.noTui && !process.env.CI && !process.argv.some((arg) => arg.includes("test")),
	);

	if (!isInteractive) {
		return {
			updateBounds(minX, maxX, minY, maxY, expected) {
				xMin = Math.min(xMin, minX);
				xMax = Math.max(xMax, maxX);
				yMin = Math.min(yMin, minY);
				yMax = Math.max(yMax, maxY);
				if (expected != null && expected > totalExpected) totalExpected = expected;
			},
			onTile(_x, _y, status, bytes = 0) {
				if (status === "saved") {
					saved++;
					totalBytes += bytes;
				} else if (status === "skipped") {
					skipped++;
				} else if (status === "missing") {
					missing++;
				} else if (status === "failed") {
					failed++;
				}
				const now = Date.now();
				if (now - lastLogTime >= 1500) {
					lastLogTime = now;
					const elapsed = (now - startTime) / 1000;
					const totalDone = saved + skipped;
					const rate = elapsed > 0 ? (totalDone / elapsed).toFixed(1) : "0.0";
					const pct = totalExpected > 0 ? ` (${((totalDone / totalExpected) * 100).toFixed(1)}%)` : "";
					console.log(
						`  zoom ${opts.zoom}: ${fmt(saved)} saved, ${fmt(skipped)} cached, ${fmt(missing)} perimeter${pct} [${rate} t/s, ${fmtBytes(totalBytes)}]`,
					);
				}
			},
			async finish() {
				const elapsed = (Date.now() - startTime) / 1000;
				const totalDone = saved + skipped;
				const rate = elapsed > 0 ? (totalDone / elapsed).toFixed(1) : "0.0";
				console.log(
					`  tiles: saved ${fmt(saved)}, already had ${fmt(skipped)}, missing ${fmt(missing)}, failed ${fmt(failed)}, ${fmtBytes(totalBytes)} in ${elapsed.toFixed(1)}s (${rate} tiles/s)`,
				);
			},
			destroy() {},
			getStats() {
				const elapsedSeconds = (Date.now() - startTime) / 1000;
				const tilesPerSecond = elapsedSeconds > 0 ? (saved + skipped) / elapsedSeconds : 0;
				return { saved, skipped, missing, failed, bytes: totalBytes, elapsedSeconds, tilesPerSecond };
			},
		};
	}

	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
	});

	const termW = Math.max(60, renderer.width || 80);
	const termH = Math.max(20, renderer.height || 24);

	const rootBox = new BoxRenderable(renderer, {
		width: Math.min(termW, 96),
		height: Math.min(termH, 24),
		border: true,
		borderColor: RGBA.fromHex("#89b4fa"),
		flexDirection: "column",
		paddingX: 1,
		paddingY: 0,
	});

	const headerText = new TextRenderable(renderer, {
		content: "VERTICORDIA ATLAS • TILE DOWNLOADER",
		fg: "#89b4fa",
	});
	const subText = new TextRenderable(renderer, {
		content: `${opts.gameTitle} (${opts.gameSlug}) — Map: ${opts.mapSlug} | Tileset: ${opts.tilesetName} (zoom ${opts.zoom})`,
		fg: "#cdd6f4",
	});
	rootBox.add(headerText);
	rootBox.add(subText);

	const midRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		marginVertical: 1,
		flexGrow: 1,
	});

	const fbW = Math.max(24, Math.min(42, Math.floor(termW / 2) - 4));
	const fbH = Math.max(8, Math.min(12, termH - 12));

	const fb = new FrameBufferRenderable(renderer, {
		width: fbW,
		height: fbH,
	});
	const bgDark = RGBA.fromHex("#181825");
	const fgDim = RGBA.fromHex("#585b70");
	const fgGreen = RGBA.fromHex("#a6e3a1");
	const fgBlue = RGBA.fromHex("#89b4fa");
	const fgRed = RGBA.fromHex("#f38ba8");

	fb.frameBuffer.fillRect(0, 0, fbW, fbH, bgDark);
	fb.frameBuffer.drawText("Bounds: discovering...", 1, 0, fgDim);

	const statsBox = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
	});

	const progressText = new TextRenderable(renderer, { content: "Progress: 0 tiles", fg: "#fab387" });
	const rateText = new TextRenderable(renderer, { content: "Rate:     0.0 tiles/s (0.0 KB/s)", fg: "#a6e3a1" });
	const timeText = new TextRenderable(renderer, { content: "Elapsed:  00:00   ETA: --:--", fg: "#89dceb" });
	const countsText1 = new TextRenderable(renderer, { content: "Saved:    0       Cached: 0", fg: "#cdd6f4" });
	const countsText2 = new TextRenderable(renderer, { content: "Border:   0       Failed: 0", fg: "#cdd6f4" });
	const legendText = new TextRenderable(renderer, {
		content: "▓ Saved  ░ Cached  · Queued  × Void",
		fg: "#6c7086",
	});

	statsBox.add(progressText);
	statsBox.add(rateText);
	statsBox.add(timeText);
	statsBox.add(countsText1);
	statsBox.add(countsText2);
	statsBox.add(legendText);

	midRow.add(fb);
	midRow.add(statsBox);
	rootBox.add(midRow);

	const progressBar = new TextRenderable(renderer, {
		content: "[----------------------------------------] 0.0%",
		fg: "#a6e3a1",
	});
	rootBox.add(progressBar);

	renderer.root.add(rootBox);
	renderer.requestRender();

	let lastRender = Date.now();
	let isDestroyed = false;

	function project(x: number, y: number): [number, number] | null {
		if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin) return null;
		if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax <= yMin) return null;
		const c = Math.max(0, Math.min(fbW - 1, Math.floor(((x - xMin) / (xMax - xMin || 1)) * (fbW - 1))));
		const r = Math.max(1, Math.min(fbH - 1, 1 + Math.floor(((y - yMin) / (yMax - yMin || 1)) * (fbH - 2))));
		return [c, r];
	}

	function renderUi(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		if (!force && now - lastRender < 80) return;
		lastRender = now;

		samples.push({ time: now, tiles: saved + skipped, bytes: totalBytes });
		while (samples.length > 1 && now - samples[0].time > 3000) {
			samples.shift();
		}
		const oldest = samples[0];
		const sampleDt = Math.max(0.1, (now - oldest.time) / 1000);
		const rateTiles = Math.max(0, (saved + skipped - oldest.tiles) / sampleDt);
		const rateBytes = Math.max(0, (totalBytes - oldest.bytes) / sampleDt);

		const elapsed = (now - startTime) / 1000;
		const totalDone = saved + skipped;
		const totalAll = Math.max(totalDone, totalExpected);
		const pct = totalAll > 0 ? Math.min(100, (totalDone / totalAll) * 100) : 0;
		const eta = rateTiles > 0 && totalAll > totalDone ? (totalAll - totalDone) / rateTiles : -1;

		progressText.content = `Progress: ${fmt(totalDone)} / ${fmt(totalAll)} tiles (${pct.toFixed(1)}%)`;
		rateText.content = `Rate:     ${rateTiles.toFixed(1)} tiles/s (${fmtBytes(rateBytes)}/s)`;
		timeText.content = `Elapsed:  ${fmtTime(elapsed)}   ETA: ${fmtTime(eta)}`;
		countsText1.content = `Saved:    ${fmt(saved).padEnd(8)} Cached: ${fmt(skipped)}`;
		countsText2.content = `Border:   ${fmt(missing).padEnd(8)} Failed: ${fmt(failed)}`;

		const barWidth = 36;
		const filled = Math.min(barWidth, Math.floor((pct / 100) * barWidth));
		const empty = Math.max(0, barWidth - filled);
		progressBar.content = `[${"█".repeat(filled)}${"░".repeat(empty)}] ${pct.toFixed(1)}% (${fmtBytes(totalBytes)})`;

		renderer.requestRender();
	}

	return {
		updateBounds(minX, maxX, minY, maxY, expected) {
			xMin = Math.min(xMin, minX);
			xMax = Math.max(xMax, maxX);
			yMin = Math.min(yMin, minY);
			yMax = Math.max(yMax, maxY);
			if (expected != null && expected > totalExpected) totalExpected = expected;
			if (!isDestroyed && Number.isFinite(xMin) && Number.isFinite(xMax)) {
				fb.frameBuffer.drawText(
					`Bounds: [${xMin}..${xMax}] × [${yMin}..${yMax}]`.slice(0, fbW - 2),
					1,
					0,
					fgDim,
				);
			}
			renderUi(false);
		},
		onTile(x, y, status, bytes = 0) {
			if (status === "saved") {
				saved++;
				totalBytes += bytes;
			} else if (status === "skipped") {
				skipped++;
			} else if (status === "missing") {
				missing++;
			} else if (status === "failed") {
				failed++;
			}

			if (x < xMin) xMin = x;
			if (x > xMax) xMax = x;
			if (y < yMin) yMin = y;
			if (y > yMax) yMax = y;

			const pt = project(x, y);
			if (pt) {
				const [c, r] = pt;
				if (status === "saved") {
					fb.frameBuffer.setCell(c, r, "▓", fgGreen, bgDark);
				} else if (status === "skipped") {
					fb.frameBuffer.setCell(c, r, "░", fgBlue, bgDark);
				} else if (status === "missing") {
					fb.frameBuffer.setCell(c, r, "×", fgRed, bgDark);
				}
			}

			renderUi(false);
		},
		async finish() {
			renderUi(true);
			await new Promise((r) => setTimeout(r, 120));
			if (!isDestroyed) {
				isDestroyed = true;
				try {
					renderer.destroy();
				} catch {}
			}
			const elapsed = (Date.now() - startTime) / 1000;
			const totalDone = saved + skipped;
			const rate = elapsed > 0 ? (totalDone / elapsed).toFixed(1) : "0.0";
			console.log(
				`  tiles: saved ${fmt(saved)}, already had ${fmt(skipped)}, missing ${fmt(missing)}, failed ${fmt(failed)}, ${fmtBytes(totalBytes)} in ${elapsed.toFixed(1)}s (${rate} tiles/s)`,
			);
		},
		destroy() {
			if (!isDestroyed) {
				isDestroyed = true;
				try {
					renderer.destroy();
				} catch {}
			}
		},
		getStats() {
			const elapsedSeconds = (Date.now() - startTime) / 1000;
			const tilesPerSecond = elapsedSeconds > 0 ? (saved + skipped) / elapsedSeconds : 0;
			return { saved, skipped, missing, failed, bytes: totalBytes, elapsedSeconds, tilesPerSecond };
		},
	};
}