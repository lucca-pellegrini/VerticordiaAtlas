// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BoxRenderable, createCliRenderer, type KeyEvent, TextRenderable } from "@opentui/core";

import { fmt } from "../../src/shared/escape.js";
import { runAddGamePipeline } from "../add-game.js";
import { resolveGames, updateGame } from "../update-games.js";
import { CatalogGame, createGamesCatalogView, GamesCatalogView } from "./games-catalog.js";
import { AddGameFormResult, AddGameFormView, createAddGameFormView } from "./input-form.js";
import { createServerJobView, ServerJobView } from "./server-job.js";
import {
	clearAndRedrawTerminal,
	computeResponsiveBox,
	fmtTime,
	isCtrlL,
	isInteractiveTty,
	RGBA_THEME,
	THEME,
} from "./theme.js";

export interface ServerDashboardOptions {
	host: string;
	port: number;
	noTui?: boolean;
	renderer?: any;
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

interface TabItem {
	id: string;
	label: string;
	type: "monitor" | "catalog" | "form" | "job";
	view?: GamesCatalogView | AddGameFormView | ServerJobView;
	jobSlug?: string;
	statusBadge?: string;
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

	const isInteractive = Boolean(opts.renderer) || isInteractiveTty(opts.noTui);

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

	const renderer =
		opts.renderer ||
		(await createCliRenderer({
			exitOnCtrlC: true,
		}));

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

	// Header Box
	const headerBox = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: boxW - 2,
		marginVertical: 0,
	});
	const topHeaderRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		justifyContent: "space-between",
		width: boxW - 2,
	});
	const headerTitle = new TextRenderable(renderer, {
		content: "VERTICORDIA ATLAS • SERVER DASHBOARD",
		fg: THEME.borderFocus,
	});
	const subText = new TextRenderable(renderer, {
		content: `http://${opts.host}:${opts.port}/ | Uptime: 00:00 | WebSockets: 0`,
		fg: THEME.text,
	});
	topHeaderRow.add(headerTitle);
	topHeaderRow.add(subText);
	headerBox.add(topHeaderRow);

	// Tabs Bar Row
	const tabPillsRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		width: boxW - 2,
		height: 1,
		backgroundColor: THEME.surface,
		marginVertical: 0,
	});
	const tabPillsList = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 1,
		marginVertical: 0,
	});
	tabPillsRow.add(tabPillsList);

	const tabNewBtn = new TextRenderable(renderer, {
		content: "+ [C-n]",
		fg: THEME.teal,
		bg: THEME.surface,
	});

	const tabHintText = new TextRenderable(renderer, {
		content: "C-1..0 / Alt-j/k ⇄  [C-w] Close ",
		fg: THEME.textDim,
		bg: THEME.surface,
	});
	tabPillsRow.add(tabHintText);

	headerBox.add(tabPillsRow);
	rootBox.add(headerBox);

	// Main Content Container
	const contentBox = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		width: boxW - 2,
		marginVertical: 0,
	});
	rootBox.add(contentBox);

	// Footer Keybind Hints Bar
	const footerBar = new TextRenderable(renderer, {
		content: "Requests: 0   Cards: 0   Tiles: 0   Memory: -- MB",
		fg: THEME.textDim,
	});
	rootBox.add(footerBar);

	renderer.root.add(rootBox);

	// Tab 1: Live Monitor View
	const monitorRoot = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexGrow: 1,
		width: boxW - 2,
	});

	const topRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		flexGrow: 1,
		marginVertical: 0,
	});
	let leftW = Math.floor((boxW - 4) * 0.52);

	const httpPane = new BoxRenderable(renderer, {
		width: leftW,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	httpPane.add(new TextRenderable(renderer, { content: "LIVE HTTP REQUESTS", fg: THEME.peach }));

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
	monitorRoot.add(topRow);

	const btmRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		flexGrow: 1,
	});

	const syncPane = new BoxRenderable(renderer, {
		width: leftW,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	syncPane.add(new TextRenderable(renderer, { content: "API & SYNC HUB (WEBSOCKET / SQLite)", fg: THEME.mauve }));

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
	monitorRoot.add(btmRow);

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

	// Tabs system
	let activeTabIdx = 0;
	const tabs: TabItem[] = [
		{ id: "monitor", label: "Live Monitor", type: "monitor" },
		{ id: "catalog", label: "Games Catalog", type: "catalog" },
	];

	const origLog = console.log;
	const origInfo = console.info;
	const origWarn = console.warn;
	const origError = console.error;

	function logApi(action: string, detail: string) {
		recentSyncs.push({ time: Date.now(), action, detail });
		if (recentSyncs.length > 50) recentSyncs.shift();
		renderUi(false);
	}

	console.log = (...args: any[]) => {
		const msg = args.map(String).join(" ");
		const cur = tabs[activeTabIdx];
		if (cur?.type === "job" && (cur.view as any)?.addLog) {
			(cur.view as any).addLog(msg);
		} else {
			logApi("log", msg);
		}
	};
	console.info = (...args: any[]) => {
		const msg = args.map(String).join(" ");
		const cur = tabs[activeTabIdx];
		if (cur?.type === "job" && (cur.view as any)?.addLog) {
			(cur.view as any).addLog(msg);
		} else {
			logApi("info", msg);
		}
	};
	console.warn = (...args: any[]) => {
		const msg = args.map(String).join(" ");
		const cur = tabs[activeTabIdx];
		if (cur?.type === "job" && (cur.view as any)?.addLog) {
			(cur.view as any).addLog(`[WARN] ${msg}`);
		} else {
			logApi("warn", msg);
		}
	};
	console.error = (...args: any[]) => {
		const msg = args.map(String).join(" ");
		const cur = tabs[activeTabIdx];
		if (cur?.type === "job" && (cur.view as any)?.addLog) {
			(cur.view as any).addLog(`[ERROR] ${msg}`);
		} else {
			logApi("error", msg);
		}
	};

	// Create Games Catalog View
	const catalogView: GamesCatalogView = await createGamesCatalogView({
		renderer,
		width: boxW - 2,
		height: boxH - 5,
		onUpdate(game: CatalogGame, overwriteTiles: boolean) {
			startUpdateJob(game, overwriteTiles);
		},
		onPrune(game: CatalogGame) {
			startPruneJob(game);
		},
		onCards(game: CatalogGame) {
			startCardsJob(game);
		},
		onNewScrape() {
			openNewAddGameTab();
		},
		onStatusChange(msg) {
			renderer.requestRender();
		},
	});
	tabs[1].view = catalogView;

	// Helper to instantiate Add Game Form View
	function createFormForTab(tab: TabItem): AddGameFormView {
		const formView = createAddGameFormView({
			renderer,
			width: boxW - 2,
			height: boxH - 5,
			onSubmit(result: AddGameFormResult) {
				startScrapeJobForTab(tab, result);
			},
			onCancel() {
				closeTab(tabs.indexOf(tab));
			},
		});
		tab.view = formView;
		return formView;
	}

	function openNewAddGameTab() {
		const formCount = tabs.filter((t) => t.type === "form").length;
		const label = formCount === 0 ? "Add Game" : `Add Game #${formCount + 1}`;
		const newTab: TabItem = {
			id: `add_${Date.now()}`,
			label,
			type: "form",
		};
		createFormForTab(newTab);
		tabs.push(newTab);
		switchTab(tabs.length - 1);
	}

	function closeTab(index: number) {
		if (index <= 1 || index >= tabs.length) return; // Cannot close Monitor or Catalog
		const tab = tabs[index];
		if (tab.view) tab.view.destroy();
		tabs.splice(index, 1);
		if (activeTabIdx >= tabs.length) activeTabIdx = tabs.length - 1;
		switchTab(activeTabIdx);
	}

	function startScrapeJobForTab(tab: TabItem, res: AddGameFormResult) {
		const slug = res.slug || res.url.replace(/\/+$/, "").split("/").pop() || "game";
		const title = res.title || slug;
		tab.type = "job";
		tab.label = `Scrape: ${slug}`;
		tab.jobSlug = slug;
		tab.statusBadge = "(RUNNING)";

		if (tab.view) tab.view.destroy();

		const jobView = createServerJobView({
			renderer,
			width: boxW - 2,
			height: boxH - 5,
			jobId: tab.id,
			jobType: "scrape",
			title,
			slug,
			onCompleted() {
				tab.statusBadge = "(✓)";
				catalogView.reload();
				updateTabBar();
			},
			onCloseTab() {
				closeTab(tabs.indexOf(tab));
			},
		});
		tab.view = jobView;

		// Mount if active
		if (tabs[activeTabIdx] === tab) {
			if (currentMountedRoot && currentMountedRoot.parent) {
				currentMountedRoot.parent.remove(currentMountedRoot);
			}
			contentBox.add(jobView.root);
			currentMountedRoot = jobView.root;
		}
		updateTabBar();

		// Run pipeline asynchronously
		runAddGamePipeline({
			url: res.url,
			slug: res.slug,
			title: res.title,
			poster: res.posterUrl,
			noTiles: !res.downloadTiles,
			allTilesets: res.allTilesets,
			noMedia: !res.downloadMedia,
			uploadMedia: res.uploadMedia,
			keepLocal: res.keepLocal,
			videos: res.videos,
			noCards: !res.makeCards,
			container: jobView.stageContainer,
			renderer,
			onLog: (line) => jobView.addLog(line),
			onStage: (stage) => jobView.setStage(stage),
		})
			.then(() => {
				jobView.finish(true);
				catalogView.reload();
			})
			.catch((err: any) => {
				jobView.finish(false, err.message);
				tab.statusBadge = "(✗)";
				updateTabBar();
			});
	}

	async function streamProcessOutput(proc: any, onLine: (line: string, isErr: boolean) => void): Promise<number> {
		async function pump(stream: any, isErr: boolean) {
			if (!stream) return;
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.trim()) onLine(line, isErr);
					}
				}
				if (buffer.trim()) onLine(buffer, isErr);
			} catch {}
		}

		await Promise.all([pump(proc.stdout, false), pump(proc.stderr, true)]);
		return await proc.exited;
	}

	function startPruneJob(game: CatalogGame) {
		const newTab: TabItem = {
			id: `prune_${Date.now()}`,
			label: `Prune: ${game.slug}`,
			type: "job",
			jobSlug: game.slug,
			statusBadge: "(RUNNING)",
		};
		const jobView = createServerJobView({
			renderer,
			width: boxW - 2,
			height: boxH - 5,
			jobId: newTab.id,
			jobType: "prune",
			title: game.title,
			slug: game.slug,
			onCompleted() {
				newTab.statusBadge = "(✓)";
				updateTabBar();
			},
			onCloseTab() {
				closeTab(tabs.indexOf(newTab));
			},
		});
		newTab.view = jobView;
		tabs.push(newTab);
		switchTab(tabs.length - 1);

		// Run prune asynchronously
		(async () => {
			jobView.setStage("Optimizing & Linking Tiles");
			try {
				const here = path.dirname(fileURLToPath(import.meta.url));
				const proc = Bun.spawn(
					[process.execPath, path.join(path.dirname(here), "prune-tiles.ts"), game.slug, "--no-tui"],
					{
						cwd: path.dirname(path.dirname(here)),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const exit = await streamProcessOutput(proc, (line, isErr) => {
					jobView.addLog(isErr ? `[stderr] ${line}` : line);
				});
				const success = exit === 0;
				jobView.finish(success, success ? "Pruning completed" : `Exited with code ${exit}`);
				if (success) catalogView.reload();
			} catch (e: any) {
				jobView.finish(false, e.message);
			}
		})();
	}

	function startUpdateJob(game: CatalogGame, overwriteTiles: boolean) {
		const newTab: TabItem = {
			id: `update_${Date.now()}`,
			label: `Update: ${game.slug}`,
			type: "job",
			jobSlug: game.slug,
			statusBadge: "(RUNNING)",
		};
		const jobView = createServerJobView({
			renderer,
			width: boxW - 2,
			height: boxH - 5,
			jobId: newTab.id,
			jobType: "scrape",
			title: game.title,
			slug: game.slug,
			onCompleted() {
				newTab.statusBadge = "(✓)";
				catalogView.reload();
				updateTabBar();
			},
			onCloseTab() {
				closeTab(tabs.indexOf(newTab));
			},
		});
		newTab.view = jobView;
		tabs.push(newTab);
		switchTab(tabs.length - 1);

		(async () => {
			jobView.setStage(overwriteTiles ? "Updating & Overwriting Tiles" : "Updating Markers, Tiles & Media");
			try {
				const mapsDir = path.resolve(
					path.dirname(fileURLToPath(import.meta.url)),
					"..",
					"..",
					"public",
					"maps",
				);
				const games = await resolveGames([game.slug], false, mapsDir);
				if (!games.length) throw new Error(`Game not found: ${game.slug}`);
				await updateGame(games[0], {
					redownloadTiles: overwriteTiles,
					container: jobView.stageContainer,
					renderer,
					onLog: (line) => jobView.addLog(line),
					onStage: (stage) => jobView.setStage(stage),
				});
				jobView.finish(true);
				catalogView.reload();
			} catch (err: any) {
				jobView.finish(false, err.message);
				newTab.statusBadge = "(✗)";
				updateTabBar();
			}
		})();
	}

	function startCardsJob(game: CatalogGame) {
		const newTab: TabItem = {
			id: `cards_${Date.now()}`,
			label: `Cards: ${game.slug}`,
			type: "job",
			jobSlug: game.slug,
			statusBadge: "(RUNNING)",
		};
		const jobView = createServerJobView({
			renderer,
			width: boxW - 2,
			height: boxH - 5,
			jobId: newTab.id,
			jobType: "cards",
			title: game.title,
			slug: game.slug,
			onCompleted() {
				newTab.statusBadge = "(✓)";
				updateTabBar();
			},
			onCloseTab() {
				closeTab(tabs.indexOf(newTab));
			},
		});
		newTab.view = jobView;
		tabs.push(newTab);
		switchTab(tabs.length - 1);

		(async () => {
			jobView.setStage("Rendering OpenGraph Cards");
			try {
				const here = path.dirname(fileURLToPath(import.meta.url));
				const proc = Bun.spawn(
					[process.execPath, path.join(path.dirname(here), "make-cards.ts"), "--only", game.slug, "--no-tui"],
					{
						cwd: path.dirname(path.dirname(here)),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const exit = await streamProcessOutput(proc, (line, isErr) => {
					jobView.addLog(isErr ? `[stderr] ${line}` : line);
				});
				const success = exit === 0;
				jobView.finish(success, success ? "Cards rendered" : `Exited with code ${exit}`);
				if (success) catalogView.reload();
			} catch (e: any) {
				jobView.finish(false, e.message);
			}
		})();
	}

	// Tab pills pool
	const tabPillTexts: TextRenderable[] = [];

	function updateTabBar() {
		if (tabNewBtn.parent) {
			tabPillsList.remove(tabNewBtn);
		}

		while (tabPillTexts.length < tabs.length) {
			const pill = new TextRenderable(renderer, { content: "", fg: THEME.textDim, bg: THEME.surface });
			tabPillTexts.push(pill);
			tabPillsList.add(pill);
		}
		while (tabPillTexts.length > tabs.length) {
			const pill = tabPillTexts.pop()!;
			tabPillsList.remove(pill);
		}

		for (let i = 0; i < tabs.length; i++) {
			const t = tabs[i];
			const isAct = i === activeTabIdx;
			const badge = t.statusBadge ? ` ${t.statusBadge}` : "";
			const canClose =
				(i >= 2 && t.type === "form") || (t.type === "job" && (t.view as ServerJobView)?.status !== "running");
			const closeMark = canClose ? " ×" : "";

			if (isAct) {
				tabPillTexts[i].content = ` ▌ ${i + 1}  ${t.label}${badge}${closeMark} `;
				tabPillTexts[i].fg = THEME.peach;
				tabPillTexts[i].bg = THEME.surfaceLight;
			} else if (t.statusBadge?.includes("RUNNING")) {
				tabPillTexts[i].content = ` ◌ ${i + 1}  ${t.label} (RUNNING)${closeMark} `;
				tabPillTexts[i].fg = THEME.yellow;
				tabPillTexts[i].bg = THEME.surface;
			} else if (t.statusBadge?.includes("✓")) {
				tabPillTexts[i].content = ` ✓ ${i + 1}  ${t.label}${closeMark} `;
				tabPillTexts[i].fg = THEME.green;
				tabPillTexts[i].bg = THEME.surface;
			} else if (t.statusBadge?.includes("✗")) {
				tabPillTexts[i].content = ` ✗ ${i + 1}  ${t.label}${closeMark} `;
				tabPillTexts[i].fg = THEME.red;
				tabPillTexts[i].bg = THEME.surface;
			} else {
				tabPillTexts[i].content = `   ${i + 1}  ${t.label}${closeMark} `;
				tabPillTexts[i].fg = THEME.textDim;
				tabPillTexts[i].bg = THEME.surface;
			}
		}

		tabPillsList.add(tabNewBtn);

		if (tabHintText) {
			tabHintText.content =
				boxW >= 105 ? "C-1..0 / Alt-j/k ⇄  [C-w] Close " : boxW >= 80 ? "C-1..0 / Alt-j/k ⇄ " : "";
		}

		renderer.requestRender();
	}

	let currentMountedRoot: BoxRenderable | null = null;

	function switchTab(index: number) {
		if (index < 0 || index >= tabs.length) return;
		for (let i = 0; i < tabs.length; i++) {
			if (i !== index && tabs[i].view?.blur) {
				tabs[i].view.blur();
			}
		}

		if (currentMountedRoot && currentMountedRoot.parent) {
			currentMountedRoot.parent.remove(currentMountedRoot);
			currentMountedRoot = null;
		}

		activeTabIdx = index;

		const cur = tabs[activeTabIdx];
		if (cur.type === "monitor") {
			contentBox.add(monitorRoot);
			currentMountedRoot = monitorRoot;
		} else if (cur.view) {
			contentBox.add(cur.view.root);
			currentMountedRoot = cur.view.root;
			if (cur.view.focus) cur.view.focus();
		}

		updateTabBar();
		renderUi(true);
	}

	let lastRender = 0;
	let isDestroyed = false;

	function renderUi(force = false) {
		if (isDestroyed) return;
		const now = Date.now();
		if (!force && now - lastRender < 100) return;
		lastRender = now;

		const elapsed = (now - startTime) / 1000;
		subText.content = `http://${opts.host}:${opts.port}/ | Uptime: ${fmtTime(elapsed)} | WS: ${wsCount} active`;

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

		// Context-sensitive Footer Keybind Hints
		const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
		const cur = tabs[activeTabIdx];
		let hints = "";
		const tabMax = Math.min(10, tabs.length);
		const tabHint = `[C-1..${tabMax === 10 ? "0" : tabMax}] Tabs   [Alt-j/k] Next/Prev`;

		if (cur.type === "monitor") {
			hints = `${tabHint}   [C-n] New Scrape   [^C] Quit Server`;
		} else if (cur.type === "catalog") {
			const cat = cur.view as GamesCatalogView;
			if (cat?.isModalOpen()) {
				hints = `[Tab/Shift+Tab] Move   [Enter] Confirm/Save   [Esc] Cancel   ${tabHint}`;
			} else {
				hints = `[←↑→↓] Select   [U] Update   [P] Prune   [C] Cards   [E/Enter] Edit   [[ / ]] Reorder   [D] Delete   [/] Search   [C-n] New   ${tabHint}`;
			}
		} else if (cur.type === "form") {
			hints = `[Tab/Shift+Tab] Field   [Space] Toggle   [Enter] Start Scrape   [Esc/C-w] Close Tab   ${tabHint}`;
		} else if (cur.type === "job") {
			const jv = cur.view as ServerJobView;
			if (jv?.status === "running") {
				hints = `${tabHint} (runs in background)   [C-n] New Scrape`;
			} else {
				hints = `[C-w] Close Tab   [C-1] Monitor   [C-2] Catalog   [C-n] New Scrape   ${tabHint}`;
			}
		}

		footerBar.content = `${hints}   |   RSS: ${memMb} MB`;
		renderer.requestRender();
	}

	function handleResize(termW: number, termH: number) {
		if (isDestroyed) return;
		const next = computeResponsiveBox(termW || renderer.width, termH || renderer.height, 250, 120);
		boxW = next.boxW;
		boxH = next.boxH;
		leftW = Math.floor((boxW - 4) * 0.52);

		rootBox.width = boxW;
		rootBox.height = boxH;
		headerBox.width = boxW - 2;
		topHeaderRow.width = boxW - 2;
		tabPillsRow.width = boxW - 2;
		contentBox.width = boxW - 2;
		monitorRoot.width = boxW - 2;
		topRow.width = boxW - 2;
		btmRow.width = boxW - 2;
		httpPane.width = leftW;
		syncPane.width = leftW;

		maxEventLines = Math.max(3, Math.floor((boxH - 12) / 2));
		maxTileLines = Math.max(2, maxEventLines - 1);
		updatePaneLines(httpPane, httpLines, maxEventLines);
		updatePaneLines(cardPane, cardLines, maxEventLines);
		updatePaneLines(syncPane, syncLines, maxEventLines);
		updatePaneLines(tilePane, tileLines, maxTileLines);

		for (const tab of tabs) {
			if (tab.view?.resize) {
				tab.view.resize(boxW - 2, boxH - 5);
			}
		}

		if (tabHintText) {
			tabHintText.content =
				boxW >= 105 ? "C-1..0 / Alt-j/k ⇄  [C-w] Close " : boxW >= 80 ? "C-1..0 / Alt-j/k ⇄ " : "";
		}

		renderUi(true);
	}

	renderer.on("resize", handleResize);
	const onStdoutResize = () => handleResize(renderer.width, renderer.height);
	process.stdout.on("resize", onStdoutResize);

	// Keybind handlers
	renderer.keyInput.on("keypress", (key: KeyEvent) => {
		if (isDestroyed) return;

		// Ctrl-L clears entire terminal screen and redraws all components
		if (isCtrlL(key)) {
			clearAndRedrawTerminal(renderer);
			handleResize(renderer.width, renderer.height);
			renderUi(true);
			key.preventDefault?.();
			return;
		}

		// Ctrl-W closes active closeable tab (job or form tab)
		const isCtrlW = (key.ctrl && (key.name === "w" || key.name === "W")) || key.raw === "\x17";
		if (isCtrlW && activeTabIdx >= 2) {
			key.preventDefault?.();
			const curTab = tabs[activeTabIdx];
			if (curTab.type === "job") {
				const jv = curTab.view as ServerJobView;
				if (jv.status !== "running") {
					closeTab(activeTabIdx);
					return;
				}
			} else if (curTab.type === "form") {
				closeTab(activeTabIdx);
				return;
			}
		}

		// Ctrl-N opens new scrape tab
		const isCtrlN = (key.ctrl && (key.name === "n" || key.name === "N")) || key.raw === "\x0e";
		if (isCtrlN) {
			key.preventDefault?.();
			queueMicrotask(() => {
				openNewAddGameTab();
			});
			return;
		}

		// C-1..C-0, Alt+1..Alt+0, or Meta+1..Meta+0 to switch directly to tabs 1 through 10
		const isCtrlOrAltOrMeta = Boolean(key.ctrl || key.alt || key.meta || (key.raw && /^\x1b[0-9]$/.test(key.raw)));
		if (isCtrlOrAltOrMeta) {
			let digit = key.name;
			if (key.raw && /^\x1b[0-9]$/.test(key.raw)) {
				digit = key.raw[1];
			}
			let targetIdx: number | null = null;
			if (digit >= "1" && digit <= "9") {
				targetIdx = parseInt(digit, 10) - 1;
			} else if (digit === "0") {
				targetIdx = 9; // 10th tab
			}
			if (targetIdx !== null && targetIdx < tabs.length) {
				switchTab(targetIdx);
				key.preventDefault?.();
				return;
			}
		}

		// Global Function Keys F1..F10 to switch tabs directly
		if (key.name?.startsWith("f") && key.name.length >= 2) {
			const fNum = parseInt(key.name.slice(1), 10);
			if (!isNaN(fNum) && fNum >= 1 && fNum <= Math.min(tabs.length, 12)) {
				switchTab(fNum - 1);
				key.preventDefault?.();
				return;
			}
		}

		// Alt-k, Alt-Up for previous tab
		const isPrevTab =
			((key.alt || key.meta) && (key.name === "k" || key.name === "K" || key.name === "up")) ||
			key.raw === "\x1bk";
		if (isPrevTab) {
			key.preventDefault?.();
			switchTab((activeTabIdx - 1 + tabs.length) % tabs.length);
			return;
		}

		// Alt-j, Alt-Down for next tab
		const isNextTab =
			((key.alt || key.meta) && (key.name === "j" || key.name === "J" || key.name === "down")) ||
			key.raw === "\x1bj";
		if (isNextTab) {
			key.preventDefault?.();
			switchTab((activeTabIdx + 1) % tabs.length);
			return;
		}

		// Forward keys to active tab view (tab-specific bindings)
		const curTab = tabs[activeTabIdx];
		if (curTab?.view?.handleKey) {
			const handled = curTab.view.handleKey(key);
			if (handled) {
				renderUi(true);
				return;
			}
		}

		renderUi(false);
	});

	// Initial tab setup
	switchTab(0);

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
			logApi(action, detail);
		},
		setWsCount(count) {
			wsCount = count;
			renderUi(false);
		},
		destroy() {
			clearInterval(ticker);
			console.log = origLog;
			console.info = origInfo;
			console.warn = origWarn;
			console.error = origError;
			if (!isDestroyed) {
				isDestroyed = true;
				renderer.off("resize", handleResize);
				process.stdout.off("resize", onStdoutResize);
				for (const tab of tabs) {
					if (tab.view) tab.view.destroy();
				}
				if (!opts.renderer) {
					try {
						renderer.destroy();
					} catch {}
				} else {
					try {
						renderer.root.remove(rootBox);
						renderer.requestRender();
					} catch {}
				}
			}
		},
	};
}