// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";

import { fmt } from "../../src/shared/escape.js";
import {
	clearAndRedrawTerminal,
	computeResponsiveBox,
	fmtBytes,
	fmtTime,
	isCtrlL,
	isInteractiveTty,
	renderProgressBar,
	RGBA_THEME,
	THEME,
} from "./theme.js";

export interface PruneDashboardOptions {
	totalTilesets: number;
	dryRun?: boolean;
	noTui?: boolean;
	container?: BoxRenderable;
	renderer?: any;
}

export interface PruneTilesetEvent {
	phase: "solid" | "overview" | "prune";
	solid?: number;
	solidFreed?: number;
	topColors?: [string, number][];
	overview?: number;
	pruned?: number;
	prunedBytes?: number;
}

export interface PruneDashboard {
	startTileset(gameSlug: string, tilesetName: string, totalTiles: number): void;
	onProgress(ev: PruneTilesetEvent): void;
	finishTileset(res: {
		tiles: number;
		solid: number;
		solidFreed: number;
		overview: number;
		pruned: number;
		prunedBytes: number;
		background: string | null;
	}): void;
	finish(): Promise<void>;
	destroy(): void;
	getTotals(): {
		tilesetsProcessed: number;
		totalTiles: number;
		totalSolid: number;
		totalSolidFreed: number;
		totalOverview: number;
		totalPruned: number;
		totalPrunedBytes: number;
	};
}

export async function createPruneDashboard(opts: PruneDashboardOptions): Promise<PruneDashboard> {
	const startTime = Date.now();
	let tilesetsProcessed = 0;
	let totalTiles = 0;
	let totalSolid = 0;
	let totalSolidFreed = 0;
	let totalOverview = 0;
	let totalPruned = 0;
	let totalPrunedBytes = 0;

	let curGame = "--";
	let curTileset = "--";
	let curTiles = 0;
	let curSolid = 0;
	let curSolidFreed = 0;
	let curOverview = 0;
	let curPruned = 0;
	let curPrunedBytes = 0;
	let curTopColors: [string, number][] = [];
	let curPhase: "solid" | "overview" | "prune" | "idle" = "idle";

	const isInteractive = isInteractiveTty(opts.noTui);

	if (!isInteractive) {
		return {
			startTileset(gameSlug, tilesetName, count) {
				curGame = gameSlug;
				curTileset = tilesetName;
				curTiles = count;
				console.log(`  optimizing ${gameSlug} / ${tilesetName} (${fmt(count)} tiles)...`);
			},
			onProgress(ev) {
				if (ev.solid != null) curSolid = ev.solid;
				if (ev.solidFreed != null) curSolidFreed = ev.solidFreed;
				if (ev.overview != null) curOverview = ev.overview;
				if (ev.pruned != null) curPruned = ev.pruned;
				if (ev.prunedBytes != null) curPrunedBytes = ev.prunedBytes;
			},
			finishTileset(res) {
				tilesetsProcessed++;
				totalTiles += res.tiles;
				totalSolid += res.solid;
				totalSolidFreed += res.solidFreed;
				totalOverview += res.overview;
				totalPruned += res.pruned;
				totalPrunedBytes += res.prunedBytes;
				console.log(
					`    solid: ${fmt(res.solid)} (${fmtBytes(res.solidFreed)} linked), overview: ${fmt(res.overview)}, pruned: ${fmt(res.pruned)} (${fmtBytes(res.prunedBytes)}) [bg: ${res.background || "none"}]`,
				);
			},
			async finish() {
				const elapsed = (Date.now() - startTime) / 1000;
				const totalFreed = totalSolidFreed + totalPrunedBytes;
				console.log(
					`  pruning complete: ${fmt(tilesetsProcessed)} tilesets, ${fmt(totalSolid)} solid linked (${fmtBytes(totalSolidFreed)}), ${fmt(totalPruned)} intermediate pruned (${fmtBytes(totalPrunedBytes)}), total freed: ${fmtBytes(totalFreed)} in ${elapsed.toFixed(1)}s`,
				);
			},
			destroy() {},
			getTotals() {
				return {
					tilesetsProcessed,
					totalTiles,
					totalSolid,
					totalSolidFreed,
					totalOverview,
					totalPruned,
					totalPrunedBytes,
				};
			},
		};
	}

	const renderer =
		opts.renderer ||
		(await createCliRenderer({
			exitOnCtrlC: true,
		}));

	let { boxW, boxH } = computeResponsiveBox(
		opts.container ? opts.container.width || 80 : renderer.width || 80,
		opts.container ? opts.container.height || 16 : renderer.height || 24,
		128,
		opts.container ? 16 : 38,
	);

	renderer.root.flexDirection = "column";
	renderer.root.alignItems = "center";
	renderer.root.justifyContent = "center";

	if (opts.container) {
		opts.container.flexDirection = "column";
		opts.container.alignItems = "center";
		opts.container.justifyContent = "center";
	}

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
		content: "VERTICORDIA ATLAS • TILE PYRAMID PRUNER & OPTIMIZER",
		fg: THEME.borderFocus,
	});
	const subText = new TextRenderable(renderer, {
		content: `Mode: ${opts.dryRun ? "DRY RUN (preview only)" : "ACTIVE PRUNING"} | Total Tilesets: ${opts.totalTilesets}`,
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

	// Left: Current Tileset
	const leftPanel = new BoxRenderable(renderer, {
		width: Math.floor(boxW * 0.52),
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	const leftTitle = new TextRenderable(renderer, {
		content: "CURRENT TILESET PROCESSING",
		fg: THEME.peach,
	});
	leftPanel.add(leftTitle);

	const targetText = new TextRenderable(renderer, { content: "Target:    --", fg: THEME.textBright });
	const phase1Text = new TextRenderable(renderer, {
		content: "1. Dedupe:   0 solid (0.0 KB linked)",
		fg: THEME.text,
	});
	const colorChipsText = new TextRenderable(renderer, { content: "   Colors:   none", fg: THEME.textDim });
	const phase2Text = new TextRenderable(renderer, { content: "2. Overview: 0 generated", fg: THEME.text });
	const phase3Text = new TextRenderable(renderer, {
		content: "3. Pruning:  0 intermediate (0.0 KB)",
		fg: THEME.text,
	});

	leftPanel.add(targetText);
	leftPanel.add(phase1Text);
	leftPanel.add(colorChipsText);
	leftPanel.add(phase2Text);
	leftPanel.add(phase3Text);

	// Right: Aggregate Totals
	const rightPanel = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	const rightTitle = new TextRenderable(renderer, {
		content: "CUMULATIVE SAVINGS",
		fg: THEME.teal,
	});
	rightPanel.add(rightTitle);

	const progressText = new TextRenderable(renderer, { content: "Tilesets:    0 / 0 completed", fg: THEME.peach });
	const totalTilesText = new TextRenderable(renderer, { content: "Total tiles: 0 scanned", fg: THEME.text });
	const solidSavingsText = new TextRenderable(renderer, {
		content: "Solid links: 0 (0.0 KB saved)",
		fg: THEME.green,
	});
	const pruneSavingsText = new TextRenderable(renderer, {
		content: "Pruned:      0 (0.0 KB freed)",
		fg: THEME.mauve,
	});
	const netSavingsText = new TextRenderable(renderer, { content: "Net freed:   0.0 KB storage", fg: THEME.green });
	const timeText = new TextRenderable(renderer, { content: "Elapsed:     00:00", fg: THEME.teal });

	rightPanel.add(progressText);
	rightPanel.add(totalTilesText);
	rightPanel.add(solidSavingsText);
	rightPanel.add(pruneSavingsText);
	rightPanel.add(netSavingsText);
	rightPanel.add(timeText);

	midRow.add(leftPanel);
	midRow.add(rightPanel);
	rootBox.add(midRow);

	const progressBar = new TextRenderable(renderer, {
		content: "[----------------------------------------] 0.0%",
		fg: THEME.green,
	});
	rootBox.add(progressBar);

	if (opts.container) {
		opts.container.add(rootBox);
	} else {
		renderer.root.add(rootBox);
	}
	renderer.requestRender();

	let lastRender = Date.now();
	let isDestroyed = false;

	function renderUi(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		if (!force && now - lastRender < 80) return;
		lastRender = now;

		targetText.content = `Target:    ${curGame} / ${curTileset} (${fmt(curTiles)} tiles)`;
		phase1Text.content = `1. Dedupe:   ${fmt(curSolid)} solid (${fmtBytes(curSolidFreed)} linked)`;

		if (curTopColors.length) {
			const colStr = curTopColors
				.slice(0, 3)
				.map(([k, c]) => `#${k.slice(0, 6)} (${fmt(c)})`)
				.join(" · ");
			colorChipsText.content = `   Colors:   ${colStr}`;
		} else {
			colorChipsText.content = "   Colors:   discovering...";
		}

		phase2Text.content = `2. Overview: ${fmt(curOverview)} generated`;
		phase3Text.content = `3. Pruning:  ${fmt(curPruned)} intermediate (${fmtBytes(curPrunedBytes)})`;

		const totalSets = opts.totalTilesets || 1;
		const pct = Math.min(100, (tilesetsProcessed / totalSets) * 100);
		progressText.content = `Tilesets:    ${fmt(tilesetsProcessed)} / ${fmt(totalSets)} completed (${pct.toFixed(0)}%)`;
		totalTilesText.content = `Total tiles: ${fmt(totalTiles + curTiles)} scanned`;
		solidSavingsText.content = `Solid links: ${fmt(totalSolid + curSolid)} (${fmtBytes(totalSolidFreed + curSolidFreed)} saved)`;
		pruneSavingsText.content = `Pruned:      ${fmt(totalPruned + curPruned)} (${fmtBytes(totalPrunedBytes + curPrunedBytes)} freed)`;

		const netFreed = totalSolidFreed + curSolidFreed + totalPrunedBytes + curPrunedBytes;
		netSavingsText.content = `Net freed:   ${fmtBytes(netFreed)} storage`;

		const elapsed = (now - startTime) / 1000;
		timeText.content = `Elapsed:     ${fmtTime(elapsed)}`;

		const suffix = ` ${pct.toFixed(1)}% (freed ${fmtBytes(netFreed)})`;
		const innerW = boxW - 4;
		const barWidth = Math.max(6, innerW - suffix.length - 2);
		progressBar.content = `${renderProgressBar(pct, barWidth)}${suffix}`;

		renderer.requestRender();
	}

	function handleResize(termW: number, termH: number) {
		if (isDestroyed) return;
		const targetW = opts.container ? opts.container.width || termW : termW || renderer.width;
		const targetH = opts.container ? opts.container.height || termH : termH || renderer.height;
		const maxH = opts.container ? 16 : 38;
		const next = computeResponsiveBox(targetW, targetH, 128, maxH);
		boxW = next.boxW;
		boxH = next.boxH;
		rootBox.width = boxW;
		rootBox.height = boxH;
		leftPanel.width = Math.floor(boxW * 0.52);
		renderUi(true);
	}

	renderer.on("resize", handleResize);
	const onStdoutResize = () => handleResize(renderer.width, renderer.height);
	process.stdout.on("resize", onStdoutResize);

	const onKeypress = (key: any) => {
		if (isDestroyed) return;
		if (isCtrlL(key)) {
			clearAndRedrawTerminal(renderer);
			handleResize(renderer.width, renderer.height);
			renderUi(true);
			key.preventDefault?.();
		}
	};
	if (!opts.renderer && !opts.container && renderer.keyInput) {
		renderer.keyInput.on("keypress", onKeypress);
	}

	return {
		startTileset(gameSlug, tilesetName, count) {
			curGame = gameSlug;
			curTileset = tilesetName;
			curTiles = count;
			curSolid = 0;
			curSolidFreed = 0;
			curOverview = 0;
			curPruned = 0;
			curPrunedBytes = 0;
			curTopColors = [];
			curPhase = "solid";
			renderUi(false);
		},
		onProgress(ev) {
			curPhase = ev.phase;
			if (ev.solid != null) curSolid = ev.solid;
			if (ev.solidFreed != null) curSolidFreed = ev.solidFreed;
			if (ev.topColors != null) curTopColors = ev.topColors;
			if (ev.overview != null) curOverview = ev.overview;
			if (ev.pruned != null) curPruned = ev.pruned;
			if (ev.prunedBytes != null) curPrunedBytes = ev.prunedBytes;
			renderUi(false);
		},
		finishTileset(res) {
			tilesetsProcessed++;
			totalTiles += res.tiles;
			totalSolid += res.solid;
			totalSolidFreed += res.solidFreed;
			totalOverview += res.overview;
			totalPruned += res.pruned;
			totalPrunedBytes += res.prunedBytes;
			renderUi(false);
		},
		async finish() {
			renderUi(true);
			await new Promise((r) => setTimeout(r, 120));
			if (!isDestroyed) {
				isDestroyed = true;
				if (!opts.renderer) {
					renderer.off("resize", handleResize);
					process.stdout.off("resize", onStdoutResize);
					if (renderer.keyInput) {
						try {
							renderer.keyInput.off("keypress", onKeypress);
						} catch {}
					}
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
			const totalFreed = totalSolidFreed + totalPrunedBytes;
			if (!opts.renderer && !opts.container) {
				console.log(
					`  pruning complete: ${fmt(tilesetsProcessed)} tilesets, ${fmt(totalSolid)} solid linked (${fmtBytes(totalSolidFreed)}), ${fmt(totalPruned)} intermediate pruned (${fmtBytes(totalPrunedBytes)}), total freed: ${fmtBytes(totalFreed)} in ${elapsed.toFixed(1)}s`,
				);
			}
		},
		destroy() {
			if (!isDestroyed) {
				isDestroyed = true;
				if (!opts.renderer) {
					renderer.off("resize", handleResize);
					process.stdout.off("resize", onStdoutResize);
					if (renderer.keyInput) {
						try {
							renderer.keyInput.off("keypress", onKeypress);
						} catch {}
					}
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
		getTotals() {
			return {
				tilesetsProcessed,
				totalTiles,
				totalSolid,
				totalSolidFreed,
				totalOverview,
				totalPruned,
				totalPrunedBytes,
			};
		},
	};
}