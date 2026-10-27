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

export interface MediaDashboardOptions {
	game: string;
	totalExpected: number;
	uploadMedia?: boolean;
	keepLocal?: boolean;
	concurrency?: number;
	noTui?: boolean;
}

export interface MediaItemEvent {
	name: string;
	url: string;
	size?: number;
	status: "downloaded" | "uploaded" | "cached" | "skippedCloud" | "failed";
	verifiedUrl?: string;
	error?: string;
}

export interface MediaDashboard {
	onItem(event: MediaItemEvent): void;
	finish(): Promise<void>;
	destroy(): void;
	getStats(): {
		saved: number;
		uploaded: number;
		skipped: number;
		skippedCloud: number;
		failed: number;
		bytes: number;
		elapsedSeconds: number;
	};
}

export async function createMediaDashboard(opts: MediaDashboardOptions): Promise<MediaDashboard> {
	const startTime = Date.now();
	let saved = 0;
	let uploaded = 0;
	let skipped = 0;
	let skippedCloud = 0;
	let failed = 0;
	let totalBytes = 0;
	const totalExpected = opts.totalExpected || 0;

	const recentTransfers: MediaItemEvent[] = [];
	const samples: { time: number; items: number; bytes: number }[] = [];
	let lastLogTime = Date.now();

	const isInteractive = isInteractiveTty(opts.noTui);

	if (!isInteractive) {
		return {
			onItem(ev) {
				if (ev.status === "downloaded") {
					saved++;
					totalBytes += ev.size || 0;
				} else if (ev.status === "uploaded") {
					uploaded++;
					totalBytes += ev.size || 0;
					if (opts.keepLocal) saved++;
				} else if (ev.status === "cached") {
					skipped++;
				} else if (ev.status === "skippedCloud") {
					skippedCloud++;
				} else if (ev.status === "failed") {
					failed++;
				}
				const now = Date.now();
				if (now - lastLogTime >= 1500) {
					lastLogTime = now;
					const elapsed = (now - startTime) / 1000;
					const done = saved + uploaded + skipped + skippedCloud;
					const rate = elapsed > 0 ? (done / elapsed).toFixed(1) : "0.0";
					const pct = totalExpected > 0 ? ` (${((done / totalExpected) * 100).toFixed(1)}%)` : "";
					console.log(
						`  media: ${fmt(saved)} saved, ${fmt(uploaded)} uploaded, ${fmt(skipped + skippedCloud)} cached${pct} [${rate} items/s, ${fmtBytes(totalBytes)}]`,
					);
				}
			},
			async finish() {
				const elapsed = (Date.now() - startTime) / 1000;
				const done = saved + uploaded + skipped + skippedCloud;
				const rate = elapsed > 0 ? (done / elapsed).toFixed(1) : "0.0";
				console.log(
					`  media: saved ${fmt(saved)}${opts.uploadMedia ? `, uploaded ${fmt(uploaded)}` : ""}, already had ${fmt(skipped)}, skipped ${fmt(skippedCloud)} (in cloud), failed ${fmt(failed)}, ${fmtBytes(totalBytes)} in ${elapsed.toFixed(1)}s (${rate} items/s)`,
				);
			},
			destroy() {},
			getStats() {
				const elapsedSeconds = (Date.now() - startTime) / 1000;
				return { saved, uploaded, skipped, skippedCloud, failed, bytes: totalBytes, elapsedSeconds };
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
		content: "VERTICORDIA ATLAS • MEDIA ASSET PIPELINE",
		fg: THEME.borderFocus,
	});
	const subText = new TextRenderable(renderer, {
		content: `Game: ${opts.game} | Total: ${fmt(totalExpected)} | Mode: ${opts.uploadMedia ? "Cloudflare R2 + SQLite" : "Local Disk Storage"}`,
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

	// Left panel: Recent File Transfers
	const leftPanel = new BoxRenderable(renderer, {
		width: Math.floor(boxW * 0.54),
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	const leftTitle = new TextRenderable(renderer, {
		content: "RECENT TRANSFERS & R2 VERIFICATIONS",
		fg: THEME.peach,
	});
	leftPanel.add(leftTitle);

	const maxLogLines = Math.max(4, boxH - 12);
	const transferLines: TextRenderable[] = [];
	for (let i = 0; i < maxLogLines; i++) {
		const line = new TextRenderable(renderer, {
			content: "  ·",
			fg: THEME.textDim,
		});
		transferLines.push(line);
		leftPanel.add(line);
	}

	// Right panel: Statistics & Pipeline State
	const rightPanel = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	const rightTitle = new TextRenderable(renderer, {
		content: "PIPELINE METRICS",
		fg: THEME.teal,
	});
	rightPanel.add(rightTitle);

	const progressText = new TextRenderable(renderer, { content: "Progress:    0 items", fg: THEME.peach });
	const rateText = new TextRenderable(renderer, { content: "Throughput:  0.0 items/s (0.0 KB/s)", fg: THEME.green });
	const timeText = new TextRenderable(renderer, { content: "Elapsed:     00:00   ETA: --:--", fg: THEME.teal });
	const localStatsText = new TextRenderable(renderer, {
		content: "Local disk:  0 saved  · 0 cached",
		fg: THEME.text,
	});
	const cloudStatsText = new TextRenderable(renderer, {
		content: "Cloud R2:    0 uploaded · 0 cloud-set",
		fg: THEME.mauve,
	});
	const statusSummaryText = new TextRenderable(renderer, {
		content: "DB Verified: 0 verified · 0 failed",
		fg: THEME.text,
	});
	const workerText = new TextRenderable(renderer, {
		content: `Workers:     ${opts.concurrency || 8} active`,
		fg: THEME.textDim,
	});

	rightPanel.add(progressText);
	rightPanel.add(rateText);
	rightPanel.add(timeText);
	rightPanel.add(localStatsText);
	rightPanel.add(cloudStatsText);
	rightPanel.add(statusSummaryText);
	rightPanel.add(workerText);

	midRow.add(leftPanel);
	midRow.add(rightPanel);
	rootBox.add(midRow);

	const progressBar = new TextRenderable(renderer, {
		content: "[----------------------------------------] 0.0%",
		fg: THEME.green,
	});
	rootBox.add(progressBar);

	renderer.root.add(rootBox);
	renderer.requestRender();

	let lastRender = Date.now();
	let isDestroyed = false;

	function renderUi(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		if (!force && now - lastRender < 80) return;
		lastRender = now;

		const done = saved + uploaded + skipped + skippedCloud;
		samples.push({ time: now, items: done, bytes: totalBytes });
		while (samples.length > 1 && now - samples[0].time > 3000) {
			samples.shift();
		}
		const oldest = samples[0];
		const sampleDt = Math.max(0.1, (now - oldest.time) / 1000);
		const rateItems = Math.max(0, (done - oldest.items) / sampleDt);
		const rateBytes = Math.max(0, (totalBytes - oldest.bytes) / sampleDt);

		const elapsed = (now - startTime) / 1000;
		const totalAll = Math.max(done, totalExpected);
		const pct = totalAll > 0 ? Math.min(100, (done / totalAll) * 100) : 0;
		const eta = rateItems > 0 && totalAll > done ? (totalAll - done) / rateItems : -1;

		progressText.content = `Progress:    ${fmt(done)} / ${fmt(totalAll)} items (${pct.toFixed(1)}%)`;
		rateText.content = `Throughput:  ${rateItems.toFixed(1)} items/s (${fmtBytes(rateBytes)}/s)`;
		timeText.content = `Elapsed:     ${fmtTime(elapsed)}   ETA: ${fmtTime(eta)}`;
		localStatsText.content = `Local disk:  ${fmt(saved)} saved  · ${fmt(skipped)} cached`;
		cloudStatsText.content = `Cloud R2:    ${fmt(uploaded)} uploaded · ${fmt(skippedCloud)} existing`;
		statusSummaryText.content = `Failures:    ${fmt(failed)}   Data: ${fmtBytes(totalBytes)}`;

		const barWidth = Math.max(10, boxW - 24);
		progressBar.content = `${renderProgressBar(pct, barWidth)} ${pct.toFixed(1)}% (${fmtBytes(totalBytes)})`;

		// Update recent lines
		const displayList = recentTransfers.slice(-maxLogLines);
		for (let i = 0; i < maxLogLines; i++) {
			const item = displayList[displayList.length - 1 - i];
			if (item) {
				let tag = "[SAVED]";
				let col = THEME.green;
				if (item.status === "uploaded") {
					tag = "[R2 UP]";
					col = THEME.mauve;
				} else if (item.status === "cached") {
					tag = "[LOCAL]";
					col = THEME.blue;
				} else if (item.status === "skippedCloud") {
					tag = "[CLOUD]";
					col = THEME.teal;
				} else if (item.status === "failed") {
					tag = "[ERROR]";
					col = THEME.red;
				}
				const sz = item.size ? ` (${fmtBytes(item.size)})` : "";
				const maxName = Math.max(12, Math.floor(boxW * 0.54) - 20);
				const nameStr = item.name.length > maxName ? item.name.slice(0, maxName - 1) + "…" : item.name;
				transferLines[i].content = `${tag.padEnd(8)} ${nameStr}${sz}`;
				transferLines[i].fg = col;
			} else {
				transferLines[i].content = "  ·";
				transferLines[i].fg = THEME.textDim;
			}
		}

		renderer.requestRender();
	}

	function handleResize(termW: number, termH: number) {
		if (isDestroyed) return;
		const next = computeResponsiveBox(termW || renderer.width, termH || renderer.height, 128, 38);
		boxW = next.boxW;
		boxH = next.boxH;
		rootBox.width = boxW;
		rootBox.height = boxH;
		leftPanel.width = Math.floor(boxW * 0.54);
		renderUi(true);
	}

	renderer.on("resize", handleResize);
	const onStdoutResize = () => handleResize(renderer.width, renderer.height);
	process.stdout.on("resize", onStdoutResize);

	return {
		onItem(ev) {
			if (ev.status === "downloaded") {
				saved++;
				totalBytes += ev.size || 0;
			} else if (ev.status === "uploaded") {
				uploaded++;
				totalBytes += ev.size || 0;
				if (opts.keepLocal) saved++;
			} else if (ev.status === "cached") {
				skipped++;
			} else if (ev.status === "skippedCloud") {
				skippedCloud++;
			} else if (ev.status === "failed") {
				failed++;
			}

			recentTransfers.push(ev);
			if (recentTransfers.length > 50) recentTransfers.shift();

			renderUi(false);
		},
		async finish() {
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
			const done = saved + uploaded + skipped + skippedCloud;
			const rate = elapsed > 0 ? (done / elapsed).toFixed(1) : "0.0";
			console.log(
				`  media: saved ${fmt(saved)}${opts.uploadMedia ? `, uploaded ${fmt(uploaded)}` : ""}, already had ${fmt(skipped)}, skipped ${fmt(skippedCloud)} (in cloud), failed ${fmt(failed)}, ${fmtBytes(totalBytes)} in ${elapsed.toFixed(1)}s (${rate} items/s)`,
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
		getStats() {
			const elapsedSeconds = (Date.now() - startTime) / 1000;
			return { saved, uploaded, skipped, skippedCloud, failed, bytes: totalBytes, elapsedSeconds };
		},
	};
}