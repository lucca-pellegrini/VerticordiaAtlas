// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { BoxRenderable, type KeyEvent, TextRenderable } from "@opentui/core";

import { fmtTime, RGBA_THEME, THEME } from "./theme.js";

export interface ServerJobOptions {
	renderer: any;
	width: number;
	height: number;
	jobId: string;
	jobType: "scrape" | "prune" | "cards";
	title: string;
	slug: string;
	onCompleted?: () => void;
	onCloseTab?: () => void;
}

export interface ServerJobView {
	root: BoxRenderable;
	stageContainer: BoxRenderable;
	status: "running" | "completed" | "failed";
	slug: string;
	title: string;
	setStage(stageName: string): void;
	addLog(line: string): void;
	finish(success: boolean, message?: string): void;
	handleKey(key: KeyEvent): boolean;
	resize(width: number, height: number): void;
	destroy(): void;
}

export function createServerJobView(opts: ServerJobOptions): ServerJobView {
	const renderer = opts.renderer;
	let boxW = opts.width;
	let boxH = opts.height;

	const startTime = Date.now();
	let endTime = 0;
	let jobStatus: "running" | "completed" | "failed" = "running";
	let currentStage = "Initializing...";
	const logs: string[] = [];
	let isDestroyed = false;

	const rootBox = new BoxRenderable(renderer, {
		width: boxW,
		height: boxH,
		flexDirection: "column",
		paddingX: 1,
		paddingY: 0,
		backgroundColor: THEME.bgDark,
	});

	// Top Job Header Box
	const headerBox = new BoxRenderable(renderer, {
		flexDirection: "column",
		marginVertical: 0,
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
		width: boxW - 2,
	});

	const titleRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		justifyContent: "space-between",
		width: boxW - 4,
	});
	const titleText = new TextRenderable(renderer, {
		content: `JOB [${opts.jobType.toUpperCase()}]: ${opts.title} (${opts.slug})`,
		fg: THEME.peach,
	});
	const statusBadge = new TextRenderable(renderer, {
		content: " [RUNNING] ",
		fg: THEME.yellow,
	});
	titleRow.add(titleText);
	titleRow.add(statusBadge);
	headerBox.add(titleRow);

	const subRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		justifyContent: "space-between",
		width: boxW - 4,
	});
	const stageText = new TextRenderable(renderer, {
		content: `Stage: ${currentStage}`,
		fg: THEME.teal,
	});
	const elapsedText = new TextRenderable(renderer, {
		content: "Elapsed: 00:00",
		fg: THEME.textDim,
	});
	subRow.add(stageText);
	subRow.add(elapsedText);
	headerBox.add(subRow);

	rootBox.add(headerBox);

	// Dedicated Container for Embedded Stage TUIs (Tile, Media, Prune, Cards)
	const stageContainer = new BoxRenderable(renderer, {
		width: boxW - 2,
		flexGrow: 1,
		flexDirection: "column",
		marginVertical: 0,
	});
	rootBox.add(stageContainer);

	// Streaming Log Pane
	const logBoxH = Math.max(4, Math.min(8, Math.floor(boxH * 0.22)));
	const logBox = new BoxRenderable(renderer, {
		width: boxW - 2,
		height: logBoxH,
		border: true,
		borderColor: RGBA_THEME.borderDim,
		flexDirection: "column",
		paddingX: 1,
		paddingY: 0,
	});
	const logTitle = new TextRenderable(renderer, {
		content: "STREAMING LOGS",
		fg: THEME.textDim,
	});
	logBox.add(logTitle);

	const maxLogLines = Math.max(2, logBoxH - 2);
	const logLinesPool: TextRenderable[] = [];
	for (let i = 0; i < maxLogLines; i++) {
		const line = new TextRenderable(renderer, { content: "  ·", fg: THEME.textDim });
		logLinesPool.push(line);
		logBox.add(line);
	}
	rootBox.add(logBox);

	// Bottom action hint
	const footerHint = new TextRenderable(renderer, {
		content: "[Tab] Switch Tab (runs in background)   [N] New Scrape Tab",
		fg: THEME.textDim,
	});
	rootBox.add(footerHint);

	function updateLogDisplay() {
		const display = logs.slice(-logLinesPool.length);
		const maxCol = Math.max(20, boxW - 8);
		for (let i = 0; i < logLinesPool.length; i++) {
			const item = display[display.length - 1 - i];
			if (item) {
				const truncated = item.length > maxCol ? item.slice(0, maxCol - 1) + "…" : item;
				logLinesPool[i].content = truncated;
				if (item.includes("ERROR") || item.includes("failed") || item.includes("✗")) {
					logLinesPool[i].fg = THEME.red;
				} else if (item.includes("✓") || item.includes("Done") || item.includes("success")) {
					logLinesPool[i].fg = THEME.green;
				} else if (item.includes("Stage") || item.includes("Tiles") || item.includes("Media")) {
					logLinesPool[i].fg = THEME.peach;
				} else {
					logLinesPool[i].fg = THEME.text;
				}
			} else {
				logLinesPool[i].content = "  ·";
				logLinesPool[i].fg = THEME.textDim;
			}
		}
		renderer.requestRender();
	}

	const ticker = setInterval(() => {
		if (isDestroyed) return;
		const now = Date.now();
		const elapsed = (endTime ? endTime - startTime : now - startTime) / 1000;
		elapsedText.content = `Elapsed: ${fmtTime(elapsed)}`;
		renderer.requestRender();
	}, 1000);

	return {
		root: rootBox,
		stageContainer,
		get status() {
			return jobStatus;
		},
		slug: opts.slug,
		title: opts.title,
		setStage(stageName: string) {
			currentStage = stageName;
			stageText.content = `Stage: ${stageName}`;
			renderer.requestRender();
		},
		addLog(line: string) {
			const trimmed = line.trim();
			if (!trimmed) return;
			logs.push(trimmed);
			if (logs.length > 200) logs.shift();
			updateLogDisplay();
		},
		finish(success: boolean, message?: string) {
			endTime = Date.now();
			jobStatus = success ? "completed" : "failed";
			if (success) {
				statusBadge.content = " [COMPLETED] ";
				statusBadge.fg = THEME.green;
				stageText.content = `Stage: Finished ✓ ${message || ""}`;
				footerHint.content = "[W] Close Tab   [1] Live Monitor   [2] Games Catalog   [N] New Scrape Tab";
				opts.onCompleted?.();
			} else {
				statusBadge.content = " [FAILED] ";
				statusBadge.fg = THEME.red;
				stageText.content = `Stage: Error ✗ ${message || ""}`;
				footerHint.content = "[W] Close Tab   [1] Live Monitor   [2] Games Catalog   [N] New Scrape Tab";
			}
			renderer.requestRender();
		},
		handleKey(key: KeyEvent): boolean {
			if (jobStatus !== "running" && (key.name === "w" || key.name === "W")) {
				opts.onCloseTab?.();
				return true;
			}
			return false;
		},
		resize(w: number, h: number) {
			boxW = w;
			boxH = h;
			rootBox.width = boxW;
			rootBox.height = boxH;
			headerBox.width = boxW - 2;
			titleRow.width = boxW - 4;
			subRow.width = boxW - 4;
			stageContainer.width = boxW - 2;
			logBox.width = boxW - 2;
			updateLogDisplay();
		},
		destroy() {
			isDestroyed = true;
			clearInterval(ticker);
		},
	};
}