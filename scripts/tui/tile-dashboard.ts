// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { BoxRenderable, createCliRenderer, FrameBufferRenderable, TextRenderable } from "@opentui/core";

import { fmt } from "../../src/shared/escape.js";
import {
	computeResponsiveBox,
	densityGlyph,
	fmtBytes,
	fmtTime,
	isInteractiveTty,
	renderProgressBar,
	RGBA_THEME,
	THEME,
} from "./theme.js";

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
	concurrency?: number;
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

interface TileRecord {
	x: number;
	y: number;
	status: number; // 0=saved, 1=skipped, 2=missing, 3=failed
}

interface TileFlash {
	x: number;
	y: number;
	status: number;
	time: number;
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

	const tiles: TileRecord[] = [];
	let recentFlashes: TileFlash[] = [];
	const samples: { time: number; tiles: number; bytes: number }[] = [];
	let lastLogTime = Date.now();

	const isInteractive = isInteractiveTty(opts.noTui);

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

	let { boxW, boxH } = computeResponsiveBox(renderer.width || 80, renderer.height || 24, 128, 38);

	renderer.root.flexDirection = "column";
	renderer.root.alignItems = "center";
	renderer.root.justifyContent = "center";

	const rootBox = new BoxRenderable(renderer, {
		width: boxW,
		height: boxH,
		border: true,
		borderColor: RGBA_THEME.borderFocus,
		flexDirection: "column",
		paddingX: 1,
		paddingY: 0,
		backgroundColor: THEME.bgDark,
	});

	const headerText = new TextRenderable(renderer, {
		content: "VERTICORDIA ATLAS • TILE PYRAMID DOWNLOADER",
		fg: THEME.borderFocus,
	});
	const subText = new TextRenderable(renderer, {
		content: `${opts.gameTitle} (${opts.gameSlug}) — Map: ${opts.mapSlug} | Tileset: ${opts.tilesetName} (zoom ${opts.zoom})`,
		fg: THEME.text,
	});
	rootBox.add(headerText);
	rootBox.add(subText);

	const midRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		marginVertical: 1,
		flexGrow: 1,
	});

	let fbW = Math.max(16, Math.min(68, Math.floor(boxW * 0.52)));
	let fbH = Math.max(6, Math.min(22, boxH - 11));

	const fb = new FrameBufferRenderable(renderer, {
		width: fbW,
		height: fbH,
	});

	fb.frameBuffer.fillRect(0, 0, fbW, fbH, RGBA_THEME.bgDark);
	fb.frameBuffer.drawText("Bounds: discovering...", 1, 0, RGBA_THEME.textDim);

	const statsBox = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
	});

	const progressText = new TextRenderable(renderer, { content: "Progress:    0 tiles", fg: THEME.peach });
	const rateText = new TextRenderable(renderer, { content: "Rate:        0.0 tiles/s (0.0 KB/s)", fg: THEME.green });
	const timeText = new TextRenderable(renderer, { content: "Elapsed:     00:00   ETA: --:--", fg: THEME.teal });
	const countsText1 = new TextRenderable(renderer, { content: "Saved:       0       Cached: 0", fg: THEME.text });
	const countsText2 = new TextRenderable(renderer, { content: "Perimeter:   0       Failed: 0", fg: THEME.text });
	const extraStatsText = new TextRenderable(renderer, {
		content: "Concurrency: 8       Avg size: --",
		fg: THEME.textDim,
	});
	const cacheHitText = new TextRenderable(renderer, {
		content: "Cache hit:   0.0%    Total size: 0.0 MB",
		fg: THEME.mauve,
	});
	const legendText = new TextRenderable(renderer, {
		content: "░ ▒ ▓ █ Density   Flicker: ■ Blue (download) / × Red (void)",
		fg: THEME.textDim,
	});

	statsBox.add(progressText);
	statsBox.add(rateText);
	statsBox.add(timeText);
	statsBox.add(countsText1);
	statsBox.add(countsText2);
	statsBox.add(extraStatsText);
	statsBox.add(cacheHitText);
	statsBox.add(legendText);

	midRow.add(fb);
	midRow.add(statsBox);
	rootBox.add(midRow);

	const progressBar = new TextRenderable(renderer, {
		content: "[----------------------------------------] 0.0%",
		fg: THEME.green,
	});
	rootBox.add(progressBar);

	renderer.root.add(rootBox);
	renderer.requestRender();

	const FRAME_INTERVAL_MS = 16; // ~60 fps
	const STATS_INTERVAL_MS = 500; // Rate & ETA numbers update every 500ms
	const FLASH_DURATION_MS = 160; // Active flicker persists ~10 frames at 60 fps

	let lastRender = 0;
	let lastStatsUpdate = 0;
	let renderTimer: any = null;
	let isDestroyed = false;

	let cachedVMinX = 0;
	let cachedVSpanX = 1;
	let cachedVMinY = 0;
	let cachedVSpanY = 1;
	let cachedFbW = 0;
	let cachedFbH = 0;
	let bucketCount = new Int32Array(0);
	let bucketSaved = new Int32Array(0);
	let bucketSkipped = new Int32Array(0);
	let bucketBorder = new Int32Array(0);
	let maxDensity = 1;
	let bucketsDirty = true;

	function rebuildBuckets(vMinX: number, vSpanX: number, vMinY: number, vSpanY: number) {
		cachedVMinX = vMinX;
		cachedVSpanX = vSpanX;
		cachedVMinY = vMinY;
		cachedVSpanY = vSpanY;
		cachedFbW = fbW;
		cachedFbH = fbH;

		const size = fbW * fbH;
		if (bucketCount.length !== size) {
			bucketCount = new Int32Array(size);
			bucketSaved = new Int32Array(size);
			bucketSkipped = new Int32Array(size);
			bucketBorder = new Int32Array(size);
		} else {
			bucketCount.fill(0);
			bucketSaved.fill(0);
			bucketSkipped.fill(0);
			bucketBorder.fill(0);
		}

		maxDensity = 1;
		for (let i = 0; i < tiles.length; i++) {
			const t = tiles[i];
			const c = Math.floor(((t.x - vMinX) / vSpanX) * fbW);
			const r = Math.floor(((t.y - vMinY) / vSpanY) * (fbH - 2)) + 1;
			if (c >= 0 && c < fbW && r >= 1 && r < fbH - 1) {
				const idx = r * fbW + c;
				const cnt = ++bucketCount[idx];
				if (t.status === 0) bucketSaved[idx]++;
				else if (t.status === 1) bucketSkipped[idx]++;
				else bucketBorder[idx]++;
				if (cnt > maxDensity) maxDensity = cnt;
			}
		}
		bucketsDirty = false;
	}

	function redrawMinimap() {
		fb.frameBuffer.fillRect(0, 0, fbW, fbH, RGBA_THEME.bgDark);

		if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !tiles.length) {
			fb.frameBuffer.drawText("Bounds: discovering...", 1, 0, RGBA_THEME.textDim);
			return;
		}

		const mapSpanX = Math.max(1, xMax - xMin + 1);
		const mapSpanY = Math.max(1, yMax - yMin + 1);
		const padX = Math.max(1, Math.ceil(mapSpanX * 0.04));
		const padY = Math.max(1, Math.ceil(mapSpanY * 0.04));

		const vMinX = xMin - padX;
		const vMaxX = xMax + padX;
		const vMinY = yMin - padY;
		const vMaxY = yMax + padY;
		const vSpanX = Math.max(1, vMaxX - vMinX + 1);
		const vSpanY = Math.max(1, vMaxY - vMinY + 1);

		if (
			bucketsDirty ||
			vMinX !== cachedVMinX ||
			vSpanX !== cachedVSpanX ||
			vMinY !== cachedVMinY ||
			vSpanY !== cachedVSpanY ||
			fbW !== cachedFbW ||
			fbH !== cachedFbH
		) {
			rebuildBuckets(vMinX, vSpanX, vMinY, vSpanY);
		}

		for (let r = 1; r < fbH - 1; r++) {
			for (let c = 0; c < fbW; c++) {
				const idx = r * fbW + c;
				const count = bucketCount[idx];
				if (count > 0) {
					const ratio = count / maxDensity;
					const glyph = densityGlyph(ratio);
					const s = bucketSaved[idx];
					const k = bucketSkipped[idx];
					const b = bucketBorder[idx];
					let col = RGBA_THEME.green;
					if (s >= k && s >= b) col = RGBA_THEME.green;
					else if (k >= b) col = RGBA_THEME.blue;
					else col = RGBA_THEME.red;
					fb.frameBuffer.setCell(c, r, glyph, col, RGBA_THEME.bgDark);
				}
			}
		}

		// Active flicker overlay for tiles downloaded or scouted recently
		const now = Date.now();
		recentFlashes = recentFlashes.filter((f) => now - f.time < FLASH_DURATION_MS);
		const cellFlashes = new Map<number, number>();
		for (let i = 0; i < recentFlashes.length; i++) {
			const f = recentFlashes[i];
			const c = Math.floor(((f.x - vMinX) / vSpanX) * fbW);
			const r = Math.floor(((f.y - vMinY) / vSpanY) * (fbH - 2)) + 1;
			if (c >= 0 && c < fbW && r >= 1 && r < fbH - 1) {
				cellFlashes.set(r * fbW + c, f.status);
			}
		}

		for (const [idx, status] of cellFlashes.entries()) {
			const c = idx % fbW;
			const r = Math.floor(idx / fbW);
			const isVoid = status === 2 || status === 3;
			if (isVoid) {
				fb.frameBuffer.setCell(c, r, "×", RGBA_THEME.flashRed, RGBA_THEME.flashRedBg);
			} else {
				fb.frameBuffer.setCell(c, r, "■", RGBA_THEME.flashBlue, RGBA_THEME.flashBlueBg);
			}
		}

		const scaleX = (vSpanX / fbW).toFixed(1);
		const scaleY = (vSpanY / (fbH - 2)).toFixed(1);
		const boundsLabel = `[${xMin}..${xMax}] × [${yMin}..${yMax}] (scale: ~${scaleX}×${scaleY})`;
		fb.frameBuffer.drawText(boundsLabel.slice(0, fbW - 1), 1, 0, RGBA_THEME.textDim);
		const centerLabel = `Center: (${Math.round((xMin + xMax) / 2)}, ${Math.round((yMin + yMax) / 2)})`;
		fb.frameBuffer.drawText(centerLabel.slice(0, fbW - 1), 1, fbH - 1, RGBA_THEME.textDim);
	}

	function renderUi(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		lastRender = now;

		const totalDone = saved + skipped;
		const totalAll = Math.max(totalDone, totalExpected);
		const pct = totalAll > 0 ? Math.min(100, (totalDone / totalAll) * 100) : 0;

		// 1. Snappy 60+ fps updates: counters, progress bar, minimap
		progressText.content = `Progress:    ${fmt(totalDone)} / ${fmt(totalAll)} tiles (${pct.toFixed(1)}%)`;
		countsText1.content = `Saved:       ${fmt(saved).padEnd(8)} Cached: ${fmt(skipped)}`;
		countsText2.content = `Perimeter:   ${fmt(missing).padEnd(8)} Failed: ${fmt(failed)}`;

		const avgSize = saved > 0 ? fmtBytes(totalBytes / saved) : "--";
		const conc = opts.concurrency || 8;
		extraStatsText.content = `Concurrency: ${conc} workers   Avg tile: ${avgSize}`;

		const hitRatio = totalDone > 0 ? ((skipped / totalDone) * 100).toFixed(1) : "0.0";
		cacheHitText.content = `Cache hit:   ${hitRatio}%      Total data: ${fmtBytes(totalBytes)}`;

		const barWidth = Math.max(10, boxW - 24);
		progressBar.content = `${renderProgressBar(pct, barWidth)} ${pct.toFixed(1)}% (${fmtBytes(totalBytes)})`;

		// 2. Smoothed rate and ETA updates: calculated every 500ms
		if (force || now - lastStatsUpdate >= STATS_INTERVAL_MS) {
			lastStatsUpdate = now;
			samples.push({ time: now, tiles: totalDone, bytes: totalBytes });
			while (samples.length > 1 && now - samples[0].time > 3000) {
				samples.shift();
			}
			const oldest = samples[0];
			const sampleDt = Math.max(0.1, (now - oldest.time) / 1000);
			const rateTiles = Math.max(0, (totalDone - oldest.tiles) / sampleDt);
			const rateBytes = Math.max(0, (totalBytes - oldest.bytes) / sampleDt);

			const elapsed = (now - startTime) / 1000;
			const eta = rateTiles > 0 && totalAll > totalDone ? (totalAll - totalDone) / rateTiles : -1;

			rateText.content = `Rate:        ${rateTiles.toFixed(1)} tiles/s (${fmtBytes(rateBytes)}/s)`;
			timeText.content = `Elapsed:     ${fmtTime(elapsed)}   ETA: ${fmtTime(eta)}`;
		}

		redrawMinimap();
		renderer.requestRender();

		// If active flashes remain, ensure the next animation frame is scheduled
		if (recentFlashes.length > 0 && !renderTimer) {
			renderTimer = setTimeout(() => {
				renderTimer = null;
				if (!isDestroyed) renderUi(false);
			}, FRAME_INTERVAL_MS);
		}
	}

	function scheduleRender(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		const elapsed = now - lastRender;
		if (force || elapsed >= FRAME_INTERVAL_MS) {
			clearTimeout(renderTimer);
			renderTimer = null;
			renderUi(force);
		} else if (!renderTimer) {
			renderTimer = setTimeout(() => {
				renderTimer = null;
				if (!isDestroyed) renderUi(false);
			}, FRAME_INTERVAL_MS - elapsed);
		}
	}

	function handleResize(termW: number, termH: number) {
		if (isDestroyed) return;
		const next = computeResponsiveBox(termW || renderer.width, termH || renderer.height, 128, 38);
		boxW = next.boxW;
		boxH = next.boxH;
		rootBox.width = boxW;
		rootBox.height = boxH;

		fbW = Math.max(16, Math.min(68, Math.floor(boxW * 0.52)));
		fbH = Math.max(6, Math.min(22, boxH - 11));
		fb.width = fbW;
		fb.height = fbH;

		bucketsDirty = true;
		scheduleRender(true);
	}

	renderer.on("resize", handleResize);
	const onStdoutResize = () => handleResize(renderer.width, renderer.height);
	process.stdout.on("resize", onStdoutResize);

	return {
		updateBounds(minX, maxX, minY, maxY, expected) {
			let changed = false;
			if (minX < xMin) {
				xMin = minX;
				changed = true;
			}
			if (maxX > xMax) {
				xMax = maxX;
				changed = true;
			}
			if (minY < yMin) {
				yMin = minY;
				changed = true;
			}
			if (maxY > yMax) {
				yMax = maxY;
				changed = true;
			}
			if (expected != null && expected > totalExpected) totalExpected = expected;
			if (changed) bucketsDirty = true;
			scheduleRender(false);
		},
		onTile(x, y, status, bytes = 0) {
			let stNum = 0;
			if (status === "saved") {
				saved++;
				totalBytes += bytes;
				stNum = 0;
			} else if (status === "skipped") {
				skipped++;
				stNum = 1;
			} else if (status === "missing") {
				missing++;
				stNum = 2;
			} else if (status === "failed") {
				failed++;
				stNum = 3;
			}

			let boundsChanged = false;
			if (x < xMin) {
				xMin = x;
				boundsChanged = true;
			}
			if (x > xMax) {
				xMax = x;
				boundsChanged = true;
			}
			if (y < yMin) {
				yMin = y;
				boundsChanged = true;
			}
			if (y > yMax) {
				yMax = y;
				boundsChanged = true;
			}

			tiles.push({ x, y, status: stNum });
			recentFlashes.push({ x, y, status: stNum, time: Date.now() });
			if (recentFlashes.length > 300) recentFlashes.shift();

			if (boundsChanged) {
				bucketsDirty = true;
			} else if (
				!bucketsDirty &&
				cachedFbW === fbW &&
				cachedFbH === fbH &&
				cachedVSpanX > 0 &&
				cachedVSpanY > 0
			) {
				// Fast incremental bucket update in O(1)
				const c = Math.floor(((x - cachedVMinX) / cachedVSpanX) * fbW);
				const r = Math.floor(((y - cachedVMinY) / cachedVSpanY) * (fbH - 2)) + 1;
				if (c >= 0 && c < fbW && r >= 1 && r < fbH - 1) {
					const idx = r * fbW + c;
					const cnt = ++bucketCount[idx];
					if (stNum === 0) bucketSaved[idx]++;
					else if (stNum === 1) bucketSkipped[idx]++;
					else bucketBorder[idx]++;
					if (cnt > maxDensity) maxDensity = cnt;
				}
			}

			scheduleRender(false);
		},
		async finish() {
			scheduleRender(true);
			await new Promise((r) => setTimeout(r, 120));
			if (!isDestroyed) {
				isDestroyed = true;
				clearTimeout(renderTimer);
				renderer.off("resize", handleResize);
				process.stdout.off("resize", onStdoutResize);
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
				clearTimeout(renderTimer);
				renderer.off("resize", handleResize);
				process.stdout.off("resize", onStdoutResize);
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