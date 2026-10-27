// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";

import { fmt } from "../../src/shared/escape.js";
import { computeResponsiveBox, fmtBytes, fmtTime, isInteractiveTty, RGBA_THEME, THEME } from "./theme.js";

export interface ServerDashboardOptions {
	host: string;
	port: number;
	noTui?: boolean;
}

export interface HttpRequestEvent {
	method: string;
	path: string;
	status: number;
	durationMs: number;
}

export interface CardRenderEvent {
	type: "share" | "marker" | "tm";
	key: string;
	durationMs: number;
	cached: boolean;
}

export interface TileEvent {
	action: "stored" | "cached" | "derived" | "miss";
	path: string;
	durationMs?: number;
}

export interface ServerDashboard {
	onRequest(ev: HttpRequestEvent): void;
	onCard(ev: CardRenderEvent): void;
	onTile(ev: TileEvent): void;
	onSync(action: string, detail: string): void;
	onApi(action: string, detail: string): void;
	setWsCount(count: number): void;
	destroy(): void;
}

export async function createServerDashboard(opts: ServerDashboardOptions): Promise<ServerDashboard> {
	const startTime = Date.now();
	let totalRequests = 0;
	let totalCards = 0;
	let totalTiles = 0;
	let storedTiles = 0;
	let cachedTiles = 0;
	let derivedTiles = 0;
	let wsCount = 0;

	const recentRequests: HttpRequestEvent[] = [];
	const recentCards: CardRenderEvent[] = [];
	const recentSyncs: { time: number; action: string; detail: string }[] = [];
	const recentTiles: TileEvent[] = [];

	const isInteractive = isInteractiveTty(opts.noTui);

	if (!isInteractive) {
		console.log(`Verticordia Atlas on http://${opts.host}:${opts.port}/`);
		return {
			onRequest(ev) {
				totalRequests++;
				if (process.env.DEBUG) {
					console.log(`[${ev.method}] ${ev.path} -> ${ev.status} (${ev.durationMs.toFixed(1)}ms)`);
				}
			},
			onCard(ev) {
				totalCards++;
				if (process.env.DEBUG) {
					console.log(`[CARD] ${ev.type} ${ev.key} (${ev.durationMs.toFixed(1)}ms, cached: ${ev.cached})`);
				}
			},
			onTile(ev) {
				totalTiles++;
				if (ev.action === "stored") storedTiles++;
				else if (ev.action === "cached") cachedTiles++;
				else if (ev.action === "derived") derivedTiles++;
			},
			onSync(action, detail) {
				if (process.env.DEBUG) {
					console.log(`[SYNC] ${action}: ${detail}`);
				}
			},
			onApi(action, detail) {
				if (process.env.DEBUG) {
					console.log(`[API] ${action}: ${detail}`);
				}
			},
			setWsCount(count) {
				wsCount = count;
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
		content: "VERTICORDIA ATLAS • SERVER DASHBOARD",
		fg: THEME.borderFocus,
	});
	const subText = new TextRenderable(renderer, {
		content: `Listening on http://${opts.host}:${opts.port}/ | Uptime: 00:00 | WebSockets: 0 active`,
		fg: THEME.text,
	});
	rootBox.add(headerText);
	rootBox.add(subText);

	// Grid layout: Top row (HTTP requests & Card renders), Bottom row (API/Sync & Tile engine)
	const topRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		flexGrow: 1,
		marginVertical: 1,
	});

	let leftW = Math.floor(boxW * 0.52);

	// Pane 1: HTTP Requests
	const httpPane = new BoxRenderable(renderer, {
		width: leftW,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	httpPane.add(new TextRenderable(renderer, { content: "LIVE HTTP REQUESTS", fg: THEME.peach }));

	// Pane 2: Card Rendering
	const cardPane = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	cardPane.add(new TextRenderable(renderer, { content: "SOCIAL CARDS (HEADLESS CHROMIUM)", fg: THEME.teal }));

	topRow.add(httpPane);
	topRow.add(cardPane);
	rootBox.add(topRow);

	// Bottom row
	const btmRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		flexGrow: 1,
	});

	// Pane 3: API & Sync Hub
	const syncPane = new BoxRenderable(renderer, {
		width: leftW,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	syncPane.add(new TextRenderable(renderer, { content: "API & SYNC HUB (WEBSOCKET / SQLite)", fg: THEME.mauve }));

	// Pane 4: Tile Engine & Cache
	const tilePane = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	tilePane.add(new TextRenderable(renderer, { content: "TILE ENGINE & CACHE", fg: THEME.green }));
	const tileStats1 = new TextRenderable(renderer, {
		content: "Total: 0 · Stored: 0 · Cache: 0 · Stitched: 0 (0.0%)",
		fg: THEME.text,
	});
	tilePane.add(tileStats1);

	btmRow.add(syncPane);
	btmRow.add(tilePane);
	rootBox.add(btmRow);

	// Dynamic lines pool helper
	function updatePaneLines(pane: BoxRenderable, lines: TextRenderable[], targetCount: number) {
		while (lines.length < targetCount) {
			const line = new TextRenderable(renderer, { content: "  ·", fg: THEME.textDim });
			lines.push(line);
			pane.add(line);
		}
		while (lines.length > targetCount) {
			const line = lines.pop()!;
			pane.remove(line);
		}
	}

	let maxEventLines = Math.max(3, Math.floor((boxH - 12) / 2));
	let maxTileLines = Math.max(2, maxEventLines - 1);

	const httpLines: TextRenderable[] = [];
	const cardLines: TextRenderable[] = [];
	const syncLines: TextRenderable[] = [];
	const tileLines: TextRenderable[] = [];

	updatePaneLines(httpPane, httpLines, maxEventLines);
	updatePaneLines(cardPane, cardLines, maxEventLines);
	updatePaneLines(syncPane, syncLines, maxEventLines);
	updatePaneLines(tilePane, tileLines, maxTileLines);

	// Footer bar
	const footerBar = new TextRenderable(renderer, {
		content: "Requests: 0   Cards: 0   Tiles: 0   Memory RSS: -- MB",
		fg: THEME.textDim,
	});
	rootBox.add(footerBar);

	renderer.root.add(rootBox);
	renderer.requestRender();

	let lastRender = Date.now();
	let isDestroyed = false;

	function renderUi(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		if (!force && now - lastRender < 100) return;
		lastRender = now;

		const elapsed = (now - startTime) / 1000;
		subText.content = `Listening on http://${opts.host}:${opts.port}/ | Uptime: ${fmtTime(elapsed)} | WebSockets: ${wsCount} active`;

		const maxPathLen = Math.max(24, Math.floor(boxW * 0.45) - 18);

		// HTTP lines
		const displayHttp = recentRequests.slice(-httpLines.length);
		for (let i = 0; i < httpLines.length; i++) {
			const item = displayHttp[displayHttp.length - 1 - i];
			if (item) {
				let col = THEME.green;
				if (item.status >= 500) col = THEME.red;
				else if (item.status >= 400) col = THEME.yellow;
				else if (item.status >= 300) col = THEME.blue;
				const p = item.path.length > maxPathLen ? item.path.slice(0, maxPathLen - 1) + "…" : item.path;
				httpLines[i].content = `[${item.method} ${item.status}] ${p} (${item.durationMs.toFixed(0)}ms)`;
				httpLines[i].fg = col;
			} else {
				httpLines[i].content = "  ·";
				httpLines[i].fg = THEME.textDim;
			}
		}

		// Card lines
		const displayCards = recentCards.slice(-cardLines.length);
		for (let i = 0; i < cardLines.length; i++) {
			const item = displayCards[displayCards.length - 1 - i];
			if (item) {
				const tag = item.cached ? "[CACHE]" : "[RENDER]";
				const col = item.cached ? THEME.teal : THEME.peach;
				const k = item.key.length > maxPathLen ? item.key.slice(0, maxPathLen - 1) + "…" : item.key;
				cardLines[i].content = `${tag} ${item.type}: ${k} (${item.durationMs.toFixed(0)}ms)`;
				cardLines[i].fg = col;
			} else {
				cardLines[i].content = "  ·";
				cardLines[i].fg = THEME.textDim;
			}
		}

		// Sync lines
		const displaySyncs = recentSyncs.slice(-syncLines.length);
		for (let i = 0; i < syncLines.length; i++) {
			const item = displaySyncs[displaySyncs.length - 1 - i];
			if (item) {
				const det = item.detail.length > maxPathLen ? item.detail.slice(0, maxPathLen - 1) + "…" : item.detail;
				syncLines[i].content = `[${item.action}] ${det}`;
				syncLines[i].fg = THEME.mauve;
			} else {
				syncLines[i].content = "  ·";
				syncLines[i].fg = THEME.textDim;
			}
		}

		// Tile lines & stats
		const displayTiles = recentTiles.slice(-tileLines.length);
		for (let i = 0; i < tileLines.length; i++) {
			const item = displayTiles[displayTiles.length - 1 - i];
			if (item) {
				let tag = "[STORED]";
				let col = THEME.green;
				if (item.action === "cached") {
					tag = "[CACHE]";
					col = THEME.teal;
				} else if (item.action === "derived") {
					tag = "[STITCH]";
					col = THEME.peach;
				} else if (item.action === "miss") {
					tag = "[MISS]";
					col = THEME.red;
				}
				const dur = item.durationMs != null ? ` (${item.durationMs.toFixed(0)}ms)` : "";
				const p = item.path.length > maxPathLen ? item.path.slice(0, maxPathLen - 1) + "…" : item.path;
				tileLines[i].content = `${tag.padEnd(8)} ${p}${dur}`;
				tileLines[i].fg = col;
			} else {
				tileLines[i].content = "  ·";
				tileLines[i].fg = THEME.textDim;
			}
		}

		const hitRatio = totalTiles > 0 ? (((storedTiles + cachedTiles) / totalTiles) * 100).toFixed(1) : "0.0";
		tileStats1.content = `Total: ${fmt(totalTiles)} · Stored: ${fmt(storedTiles)} · Cache: ${fmt(cachedTiles)} · Stitched: ${fmt(derivedTiles)} (${hitRatio}%)`;

		// Footer stats
		const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
		footerBar.content = `Requests: ${fmt(totalRequests)}   Cards: ${fmt(totalCards)}   Tiles: ${fmt(totalTiles)}   Memory RSS: ${memMb} MB`;

		renderer.requestRender();
	}

	function handleResize(termW: number, termH: number) {
		if (isDestroyed) return;
		const next = computeResponsiveBox(termW || renderer.width, termH || renderer.height, 250, 120);
		boxW = next.boxW;
		boxH = next.boxH;
		leftW = Math.floor(boxW * 0.52);
		rootBox.width = boxW;
		rootBox.height = boxH;
		httpPane.width = leftW;
		syncPane.width = leftW;

		maxEventLines = Math.max(3, Math.floor((boxH - 12) / 2));
		maxTileLines = Math.max(2, maxEventLines - 1);
		updatePaneLines(httpPane, httpLines, maxEventLines);
		updatePaneLines(cardPane, cardLines, maxEventLines);
		updatePaneLines(syncPane, syncLines, maxEventLines);
		updatePaneLines(tilePane, tileLines, maxTileLines);

		renderUi(true);
	}

	renderer.on("resize", handleResize);
	const onStdoutResize = () => handleResize(renderer.width, renderer.height);
	process.stdout.on("resize", onStdoutResize);

	// Auto-render ticker every 1s for uptime & memory
	const ticker = setInterval(() => {
		renderUi(true);
	}, 1000);

	return {
		onRequest(ev) {
			totalRequests++;
			recentRequests.push(ev);
			if (recentRequests.length > 50) recentRequests.shift();
			renderUi(false);
		},
		onCard(ev) {
			totalCards++;
			recentCards.push(ev);
			if (recentCards.length > 50) recentCards.shift();
			renderUi(false);
		},
		onTile(ev) {
			totalTiles++;
			if (ev.action === "stored") storedTiles++;
			else if (ev.action === "cached") cachedTiles++;
			else if (ev.action === "derived") derivedTiles++;
			recentTiles.push(ev);
			if (recentTiles.length > 50) recentTiles.shift();
			renderUi(false);
		},
		onSync(action, detail) {
			recentSyncs.push({ time: Date.now(), action, detail });
			if (recentSyncs.length > 50) recentSyncs.shift();
			renderUi(false);
		},
		onApi(action, detail) {
			recentSyncs.push({ time: Date.now(), action, detail });
			if (recentSyncs.length > 50) recentSyncs.shift();
			renderUi(false);
		},
		setWsCount(count) {
			wsCount = count;
			renderUi(false);
		},
		destroy() {
			clearInterval(ticker);
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