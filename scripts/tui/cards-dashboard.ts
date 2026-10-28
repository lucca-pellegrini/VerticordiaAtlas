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

export interface CardsDashboardOptions {
	totalCards: number;
	chromeBin: string;
	siteUrl: string;
	noTui?: boolean;
	container?: BoxRenderable;
	renderer?: any;
}

export interface CardItemMeta {
	slug: string;
	title: string;
	outPath: string;
	poster?: boolean;
	accent?: string;
	markersCount?: number;
	catsCount?: number;
}

interface FinishedCardRecord {
	slug: string;
	title: string;
	bytes: number;
	durationMs: number;
	hasPoster: boolean;
}

export interface CardsDashboard {
	onStep(message: string, tag?: string): void;
	startCard(card: CardItemMeta): void;
	onCardStep(step: string): void;
	finishCard(card: CardItemMeta, bytes?: number, durationMs?: number): void;
	finish(): Promise<void>;
	destroy(): void;
}

export async function createCardsDashboard(opts: CardsDashboardOptions): Promise<CardsDashboard> {
	const startTime = Date.now();
	let completed = 0;
	let totalBytes = 0;
	let currentCard: CardItemMeta | null = null;
	let currentSubStep = "Idle";
	const finished: FinishedCardRecord[] = [];
	const logLinesList: { time: string; tag: string; message: string; color: string }[] = [];

	const isInteractive = isInteractiveTty(opts.noTui);

	function timeStr(): string {
		const d = new Date();
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
	}

	if (!isInteractive) {
		console.log(`=== Verticordia Atlas Social Card Generator ===`);
		console.log(`Target: ${opts.siteUrl} | Chromium: ${opts.chromeBin} | Total: ${opts.totalCards} cards\n`);

		return {
			onStep(message, tag = "INFO") {
				console.log(`  [${tag}] ${message}`);
			},
			startCard(card) {
				currentCard = card;
				console.log(`\n• [${card.slug}] ${card.title}:`);
			},
			onCardStep(step) {
				console.log(`    → ${step}`);
			},
			finishCard(card, bytes = 0, durationMs = 0) {
				completed++;
				totalBytes += bytes;
				const dur = durationMs > 0 ? ` (${durationMs.toFixed(0)}ms)` : "";
				const sz = bytes > 0 ? ` [${fmtBytes(bytes)}]` : "";
				console.log(`    ✓ ${card.slug}: card.jpg${sz}${dur}`);
			},
			async finish() {
				const elapsed = (Date.now() - startTime) / 1000;
				const rate = elapsed > 0 ? (completed / elapsed).toFixed(1) : "0.0";
				console.log(
					`\n✓ Finished ${completed}/${opts.totalCards} cards (${fmtBytes(totalBytes)}) in ${elapsed.toFixed(1)}s (${rate} cards/s)\n`,
				);
			},
			destroy() {},
		};
	}

	const renderer =
		opts.renderer ||
		(await createCliRenderer({
			exitOnCtrlC: true,
		}));

	let { boxW, boxH } = computeResponsiveBox(
		opts.container ? opts.container.width || 80 : renderer.width || 80,
		opts.container ? opts.container.height || 24 : renderer.height || 24,
		250,
		120,
	);

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
		content: "VERTICORDIA ATLAS • SOCIAL CARD GENERATOR",
		fg: THEME.borderFocus,
	});
	const subText = new TextRenderable(renderer, {
		content: `Site: ${opts.siteUrl} | Chromium: ${opts.chromeBin} | Total: ${opts.totalCards} cards`,
		fg: THEME.textDim,
	});
	rootBox.add(headerText);
	rootBox.add(subText);

	// Progress bar
	const progressBar = new TextRenderable(renderer, {
		content: "[----------------------------------------] 0.0% (0/0 cards)",
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
	leftPane.add(new TextRenderable(renderer, { content: "ACTIVE CARD PIPELINE", fg: THEME.peach }));

	const curTitleText = new TextRenderable(renderer, { content: "Card:   --", fg: THEME.textBright });
	const curDestText = new TextRenderable(renderer, { content: "Output: --", fg: THEME.textDim });
	const curPosterText = new TextRenderable(renderer, { content: "Poster: --", fg: THEME.text });
	const curThemeText = new TextRenderable(renderer, { content: "Theme:  --", fg: THEME.teal });
	const curStepText = new TextRenderable(renderer, { content: "Step:   ▶ Ready", fg: THEME.yellow });
	const recentHeader = new TextRenderable(renderer, { content: "\nRECENT FINISHED CARDS:", fg: THEME.peach });

	leftPane.add(curTitleText);
	leftPane.add(curDestText);
	leftPane.add(curPosterText);
	leftPane.add(curThemeText);
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
		content: "Completed: 0/0   Data: 0.0 MB   Elapsed: 00:00   Rate: 0.0 cards/s",
		fg: THEME.textDim,
	});
	rootBox.add(footerBar);

	if (opts.container) {
		opts.container.add(rootBox);
	} else {
		renderer.root.add(rootBox);
	}
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
		const pct = opts.totalCards > 0 ? (completed / opts.totalCards) * 100 : 0;
		const barW = Math.max(10, boxW - 28);
		const rate = elapsed > 0 ? (completed / elapsed).toFixed(1) : "0.0";

		progressBar.content = `${renderProgressBar(pct, barW)} ${pct.toFixed(1)}% (${completed}/${opts.totalCards} cards)`;

		if (currentCard) {
			curTitleText.content = `Card:   [${currentCard.slug}] ${currentCard.title}`;
			curDestText.content = `Output: ${currentCard.outPath}`;
			curPosterText.content = `Poster: ${currentCard.poster ? "✓ Source poster image present" : "○ No poster (solid canvas)"}`;
			curThemeText.content = `Theme:  ${currentCard.accent ? `Accent ${currentCard.accent}` : "Default brand palette"}`;
			curStepText.content = `Step:   ▶ ${currentSubStep}`;
		} else {
			curTitleText.content = "Card:   --";
			curDestText.content = "Output: --";
			curPosterText.content = "Poster: --";
			curThemeText.content = "Theme:  --";
			curStepText.content = "Step:   ○ Completed";
		}

		// Update recent finished cards
		const recentSlice = finished.slice(-recentListLines.length);
		for (let i = 0; i < recentListLines.length; i++) {
			const item = recentSlice[recentSlice.length - 1 - i];
			if (item) {
				const tag = item.hasPoster ? "[IMG]" : "[CLR]";
				const sz = fmtBytes(item.bytes).padEnd(9);
				const dur = `${item.durationMs.toFixed(0)}ms`;
				recentListLines[i].content = `✓ ${tag} ${item.slug.padEnd(16).slice(0, 16)} ${sz} (${dur})`;
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
		footerBar.content = `Completed: ${completed}/${opts.totalCards}   Data: ${fmtBytes(totalBytes)}   Elapsed: ${fmtTime(elapsed)}   Rate: ${rate} cards/s   Memory: ${memMb} MB`;

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
			if (tag === "CONFIG") color = THEME.blue;
			else if (tag === "CHROME") color = THEME.teal;
			else if (tag === "HOMEPAGE") color = THEME.peach;
			else if (tag === "MAGICK") color = THEME.yellow;
			else if (tag === "DONE") color = THEME.green;
			logLinesList.push({ time: timeStr(), tag, message, color });
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		startCard(card) {
			currentCard = card;
			currentSubStep = "Preparing card template";
			logLinesList.push({
				time: timeStr(),
				tag: "START",
				message: `Starting [${card.slug}] ${card.title}`,
				color: THEME.peach,
			});
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		onCardStep(step) {
			currentSubStep = step;
			let color = THEME.text;
			let tag = "RENDER";
			if (step.includes("Chromium")) {
				tag = "CHROME";
				color = THEME.teal;
			} else if (step.includes("ImageMagick")) {
				tag = "MAGICK";
				color = THEME.yellow;
			} else if (step.includes("HTML")) {
				tag = "HTML";
				color = THEME.blue;
			}
			const slug = currentCard ? `[${currentCard.slug}] ` : "";
			logLinesList.push({ time: timeStr(), tag, message: `${slug}${step}`, color });
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		finishCard(card, bytes = 0, durationMs = 0) {
			completed++;
			totalBytes += bytes;
			finished.push({
				slug: card.slug,
				title: card.title,
				bytes,
				durationMs,
				hasPoster: Boolean(card.poster),
			});
			currentSubStep = `Finished in ${durationMs.toFixed(0)}ms (${fmtBytes(bytes)})`;
			logLinesList.push({
				time: timeStr(),
				tag: "DONE",
				message: `Saved [${card.slug}] card.jpg (${fmtBytes(bytes)} in ${durationMs.toFixed(0)}ms)`,
				color: THEME.green,
			});
			if (logLinesList.length > 100) logLinesList.shift();
			renderUi(false);
		},
		async finish() {
			currentCard = null;
			currentSubStep = "All cards generated";
			renderUi(true);
			await new Promise((r) => setTimeout(r, 120));
			if (!isDestroyed) {
				isDestroyed = true;
				if (!opts.renderer) {
					renderer.off("resize", handleResize);
					process.stdout.off("resize", onStdoutResize);
					try {
						renderer.destroy();
					} catch {}
				} else if (opts.container) {
					try {
						opts.container.remove(rootBox);
						renderer.requestRender();
					} catch {}
				}
			}
			const elapsed = (Date.now() - startTime) / 1000;
			const rate = elapsed > 0 ? (completed / elapsed).toFixed(1) : "0.0";
			if (!opts.renderer && !opts.container) {
				console.log(
					`\n✓ Finished ${completed}/${opts.totalCards} cards (${fmtBytes(totalBytes)}) in ${elapsed.toFixed(1)}s (${rate} cards/s)\n`,
				);
			}
		},
		destroy() {
			if (!isDestroyed) {
				isDestroyed = true;
				if (!opts.renderer) {
					renderer.off("resize", handleResize);
					process.stdout.off("resize", onStdoutResize);
					try {
						renderer.destroy();
					} catch {}
				} else if (opts.container) {
					try {
						opts.container.remove(rootBox);
						renderer.requestRender();
					} catch {}
				}
			}
		},
	};
}