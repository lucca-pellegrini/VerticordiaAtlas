// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";

import { fmt } from "../../src/shared/escape.js";
import {
	computeResponsiveBox,
	fmtBytes,
	fmtTime,
	isInteractiveTty,
	renderProgressBar,
	RGBA_THEME,
	THEME,
} from "./theme.js";

export interface ScreenshotDashboardOptions {
	totalShots: number;
	base: string;
	outDir: string;
	noTui?: boolean;
}

export interface ShotItemMeta {
	name: string;
	form: "wide" | "narrow";
	path: string;
	caption?: string;
	settle?: string;
}

interface FinishedShotRecord {
	name: string;
	form: string;
	bytes: number;
	durationMs: number;
}

export interface ScreenshotDashboard {
	onStep(message: string, tag?: string): void;
	startShot(shot: ShotItemMeta): void;
	onShotStep(step: string): void;
	finishShot(shot: ShotItemMeta, bytes?: number, durationMs?: number): void;
	finish(): Promise<void>;
	destroy(): void;
}

export async function createScreenshotDashboard(opts: ScreenshotDashboardOptions): Promise<ScreenshotDashboard> {
	const startTime = Date.now();
	let completed = 0;
	let totalBytes = 0;
	let currentShot: ShotItemMeta | null = null;
	let currentSubStep = "Idle";
	const finished: FinishedShotRecord[] = [];
	const logLinesList: { time: string; tag: string; message: string; color: string }[] = [];

	const isInteractive = isInteractiveTty(opts.noTui);

	function timeStr(): string {
		const d = new Date();
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
	}

	if (!isInteractive) {
		console.log(`=== Verticordia Atlas Screenshot Capture ===`);
		console.log(`Target: ${opts.base} | Output: ${opts.outDir} | Total: ${opts.totalShots} screenshots\n`);

		return {
			onStep(message, tag = "INFO") {
				console.log(`  [${tag}] ${message}`);
			},
			startShot(shot) {
				currentShot = shot;
				console.log(`\n• [${shot.name}] (${shot.form}) ${shot.path}:`);
			},
			onShotStep(step) {
				console.log(`    → ${step}`);
			},
			finishShot(shot, bytes = 0, durationMs = 0) {
				completed++;
				totalBytes += bytes;
				const dur = durationMs > 0 ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
				const sz = bytes > 0 ? ` [${fmtBytes(bytes)}]` : "";
				console.log(`    ✓ ${shot.name}.jpg${sz}${dur}`);
			},
			async finish() {
				const elapsed = (Date.now() - startTime) / 1000;
				console.log(
					`\n✓ Captured ${completed}/${opts.totalShots} screenshots (${fmtBytes(totalBytes)}) in ${elapsed.toFixed(1)}s\n`,
				);
			},
			destroy() {},
		};
	}

	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
	});

	let { boxW, boxH } = computeResponsiveBox(renderer.width || 80, renderer.height || 24, 250, 120);

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

	// Header
	const headerText = new TextRenderable(renderer, {
		content: "VERTICORDIA ATLAS • APP SCREENSHOT CAPTURE (CDP)",
		fg: THEME.borderFocus,
	});
	const subText = new TextRenderable(renderer, {
		content: `Server: ${opts.base} | Output: ${opts.outDir} | Total: ${opts.totalShots} shots`,
		fg: THEME.textDim,
	});
	rootBox.add(headerText);
	rootBox.add(subText);

	// Progress bar
	const progressBar = new TextRenderable(renderer, {
		content: "[----------------------------------------] 0.0% (0/0 shots)",
		fg: THEME.green,
	});
	rootBox.add(progressBar);

	// Main Row: Left (Active pipeline & recent) vs Right (Verbose logs)
	const mainRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		flexGrow: 1,
		marginVertical: 1,
	});

	let leftW = Math.floor(boxW * 0.48);

	// Left Pane
	const leftPane = new BoxRenderable(renderer, {
		width: leftW,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	leftPane.add(new TextRenderable(renderer, { content: "ACTIVE SHOT PIPELINE", fg: THEME.peach }));

	const curTitleText = new TextRenderable(renderer, { content: "Shot:    --", fg: THEME.textBright });
	const curFormText = new TextRenderable(renderer, { content: "Format:  --", fg: THEME.teal });
	const curRouteText = new TextRenderable(renderer, { content: "Route:   --", fg: THEME.textDim });
	const curCaptionText = new TextRenderable(renderer, { content: "Caption: --", fg: THEME.text });
	const curStepText = new TextRenderable(renderer, { content: "Step:    ▶ Ready", fg: THEME.yellow });
	const recentHeader = new TextRenderable(renderer, { content: "\nRECENT CAPTURED SCREENSHOTS:", fg: THEME.peach });

	leftPane.add(curTitleText);
	leftPane.add(curFormText);
	leftPane.add(curRouteText);
	leftPane.add(curCaptionText);
	leftPane.add(curStepText);
	leftPane.add(recentHeader);

	const recentListLines: TextRenderable[] = [];
	let maxRecentLines = Math.max(3, boxH - 18);
	for (let i = 0; i < maxRecentLines; i++) {
		const line = new TextRenderable(renderer, { content: "  ·", fg: THEME.textDim });
		recentListLines.push(line);
		leftPane.add(line);
	}

	// Right Pane (Verbose Logs)
	const rightPane = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	rightPane.add(new TextRenderable(renderer, { content: "VERBOSE STAGE & LOG STREAM", fg: THEME.mauve }));

	const logLinesRenderables: TextRenderable[] = [];
	let maxLogLines = Math.max(5, boxH - 11);
	for (let i = 0; i < maxLogLines; i++) {
		const line = new TextRenderable(renderer, { content: "  ·", fg: THEME.textDim });
		logLinesRenderables.push(line);
		rightPane.add(line);
	}

	mainRow.add(leftPane);
	mainRow.add(rightPane);
	rootBox.add(mainRow);

	// Footer bar
	const footerBar = new TextRenderable(renderer, {
		content: "Completed: 0/0   Data: 0.0 MB   Elapsed: 00:00   Remaining: --:--",
		fg: THEME.textDim,
	});
	rootBox.add(footerBar);

	renderer.root.add(rootBox);
	renderer.requestRender();

	let lastRender = 0;
	let isDestroyed = false;

	function updateLinesPool(pane: BoxRenderable, list: TextRenderable[], target: number) {
		while (list.length < target) {
			const line = new TextRenderable(renderer, { content: "  ·", fg: THEME.textDim });
			list.push(line);
			pane.add(line);
		}
		while (list.length > target) {
			const line = list.pop()!;
			pane.remove(line);
		}
	}

	function renderUi(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		if (!force && now - lastRender < 30) return;
		lastRender = now;

		const elapsed = (now - startTime) / 1000;
		const pct = opts.totalShots > 0 ? (completed / opts.totalShots) * 100 : 0;
		const barW = Math.max(10, boxW - 28);
		const rate = elapsed > 0 ? completed / elapsed : 0;
		const remainingSec = rate > 0 && opts.totalShots > completed ? (opts.totalShots - completed) / rate : -1;

		progressBar.content = `${renderProgressBar(pct, barW)} ${pct.toFixed(1)}% (${completed}/${opts.totalShots} shots)`;

		if (currentShot) {
			const formLabel =
				currentShot.form === "wide" ? "Desktop (16:9, 2400×1350 px)" : "Phone (9:16, 1080×1920 px)";
			curTitleText.content = `Shot:    ${currentShot.name}`;
			curFormText.content = `Format:  ${formLabel}`;
			curRouteText.content = `Route:   ${currentShot.path}`;
			curCaptionText.content = `Caption: ${currentShot.caption || "--"}`;
			curStepText.content = `Step:    ▶ ${currentSubStep}`;
		} else {
			curTitleText.content = "Shot:    --";
			curFormText.content = "Format:  --";
			curRouteText.content = "Route:   --";
			curCaptionText.content = "Caption: --";
			curStepText.content = "Step:    ○ Completed";
		}

		// Update recent finished shots
		const recentSlice = finished.slice(-recentListLines.length);
		for (let i = 0; i < recentListLines.length; i++) {
			const item = recentSlice[recentSlice.length - 1 - i];
			if (item) {
				const tag = item.form === "wide" ? "[WIDE]" : "[PHON]";
				const sz = fmtBytes(item.bytes).padEnd(9);
				const dur = `${(item.durationMs / 1000).toFixed(1)}s`;
				recentListLines[i].content = `✓ ${tag} ${item.name.padEnd(18).slice(0, 18)} ${sz} (${dur})`;
				recentListLines[i].fg = THEME.green;
			} else {
				recentListLines[i].content = "  ·";
				recentListLines[i].fg = THEME.textDim;
			}
		}

		// Update verbose logs
		const maxLen = Math.max(25, boxW - leftW - 14);
		const logSlice = logLinesList.slice(-logLinesRenderables.length);
		for (let i = 0; i < logLinesRenderables.length; i++) {
			const item = logSlice[logSlice.length - 1 - i];
			if (item) {
				const msg = item.message.length > maxLen ? item.message.slice(0, maxLen - 1) + "…" : item.message;
				logLinesRenderables[i].content = `${item.time} [${item.tag}] ${msg}`;
				logLinesRenderables[i].fg = item.color;
			} else {
				logLinesRenderables[i].content = "  ·";
				logLinesRenderables[i].fg = THEME.textDim;
			}
		}

		const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
		footerBar.content = `Completed: ${completed}/${opts.totalShots}   Data: ${fmtBytes(totalBytes)}   Elapsed: ${fmtTime(elapsed)}   Remaining: ${fmtTime(remainingSec)}   Memory: ${memMb} MB`;

		renderer.requestRender();
	}

	function handleResize(termW: number, termH: number) {
		if (isDestroyed) return;
		const next = computeResponsiveBox(termW || renderer.width, termH || renderer.height, 250, 120);
		boxW = next.boxW;
		boxH = next.boxH;
		leftW = Math.floor(boxW * 0.48);
		rootBox.width = boxW;
		rootBox.height = boxH;
		leftPane.width = leftW;

		maxRecentLines = Math.max(3, boxH - 18);
		maxLogLines = Math.max(5, boxH - 11);
		updateLinesPool(leftPane, recentListLines, maxRecentLines);
		updateLinesPool(rightPane, logLinesRenderables, maxLogLines);

		renderUi(true);
	}

	renderer.on("resize", handleResize);
	const onStdoutResize = () => handleResize(renderer.width, renderer.height);
	process.stdout.on("resize", onStdoutResize);

	return {
		onStep(message, tag = "STEP") {
			let color = THEME.mauve;
			if (tag === "SERVER") color = THEME.blue;
			else if (tag === "CDP") color = THEME.teal;
			else if (tag === "SHOT") color = THEME.peach;
			else if (tag === "NAV") color = THEME.yellow;
			else if (tag === "CAPTURE") color = THEME.green;
			logLinesList.push({ time: timeStr(), tag, message, color });
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		startShot(shot) {
			currentShot = shot;
			currentSubStep = "Configuring viewport & emulation";
			logLinesList.push({
				time: timeStr(),
				tag: "SHOT",
				message: `Starting ${shot.name} (${shot.form}) -> ${shot.path}`,
				color: THEME.peach,
			});
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		onShotStep(step) {
			currentSubStep = step;
			let color = THEME.text;
			let tag = "CDP";
			if (step.includes("Navigating")) {
				tag = "NAV";
				color = THEME.yellow;
			} else if (step.includes("settle") || step.includes("Settle") || step.includes("grace period")) {
				tag = "SETTLE";
				color = THEME.teal;
			} else if (step.includes("capture") || step.includes("Capture")) {
				tag = "CAPTURE";
				color = THEME.green;
			} else if (step.includes("input") || step.includes("DOM")) {
				tag = "ACTION";
				color = THEME.mauve;
			}
			const name = currentShot ? `[${currentShot.name}] ` : "";
			logLinesList.push({ time: timeStr(), tag, message: `${name}${step}`, color });
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		finishShot(shot, bytes = 0, durationMs = 0) {
			completed++;
			totalBytes += bytes;
			finished.push({
				name: shot.name,
				form: shot.form,
				bytes,
				durationMs,
			});
			currentSubStep = `Finished in ${(durationMs / 1000).toFixed(1)}s (${fmtBytes(bytes)})`;
			logLinesList.push({
				time: timeStr(),
				tag: "DONE",
				message: `Saved ${shot.name}.jpg (${fmtBytes(bytes)} in ${(durationMs / 1000).toFixed(1)}s)`,
				color: THEME.green,
			});
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		async finish() {
			currentShot = null;
			currentSubStep = "All screenshots captured";
			renderUi(true);
			await new Promise((r) => setTimeout(r, 120));
			if (!isDestroyed) {
				isDestroyed = true;
				renderer.off("resize", handleResize);
				process.stdout.off("resize", onStdoutResize);
				try {
					renderer.destroy();
				} catch {}
			}
			const elapsed = (Date.now() - startTime) / 1000;
			console.log(
				`\n✓ Captured ${completed}/${opts.totalShots} screenshots (${fmtBytes(totalBytes)}) in ${elapsed.toFixed(1)}s\n`,
			);
		},
		destroy() {
			if (!isDestroyed) {
				isDestroyed = true;
				renderer.off("resize", handleResize);
				process.stdout.off("resize", onStdoutResize);
				try {
					renderer.destroy();
				} catch {}
			}
		},
	};
}