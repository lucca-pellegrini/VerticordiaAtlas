// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	BoxRenderable,
	createCliRenderer,
	createHostClipboard,
	type HostClipboardService,
	type KeyEvent,
	type MouseEvent,
	TextRenderable,
} from "@opentui/core";

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
	startThrobber,
	THEME,
	throbberFrame,
} from "./theme.js";

export const MONITOR_SCROLLBACK_LIMIT = 1000;

export function fmtClock(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function fitLine(str: string, maxCols: number): string {
	if (maxCols <= 1) return str.slice(0, Math.max(0, maxCols));
	return str.length > maxCols ? str.slice(0, maxCols - 1) + "…" : str;
}

export interface ServerDashboardOptions {
	host: string;
	port: number;
	noTui?: boolean;
	renderer?: any;
	onExit?: () => void;
	onCopy?: (text: string) => void;
	clipboard?: {
		writeText(text: string, options?: any): Promise<any> | any;
		dispose?(): Promise<void> | void;
	};
}

export interface HttpRequestEvent {
	method: string;
	path: string;
	status: number;
	durationMs: number;
	time?: number;
}

export interface CardRenderEvent {
	type: "share" | "marker" | "tm";
	key: string;
	durationMs: number;
	cached: boolean;
	time?: number;
}

export interface TileEvent {
	action: "stored" | "cached" | "derived" | "miss";
	path: string;
	durationMs?: number;
	time?: number;
}

export interface ServerDashboard {
	onRequest(ev: HttpRequestEvent): void;
	onCard(ev: CardRenderEvent): void;
	onTile(ev: TileEvent): void;
	onSync(action: string, detail: string, time?: number): void;
	onApi(action: string, detail: string, time?: number): void;
	setWsCount(count: number): void;
	getLastCopiedText?(): string;
	destroy(): void | Promise<void>;
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
	let activeThrobberFrame = throbberFrame(0);
	let lastCopiedText = "";
	let copiedUntil = 0;

	const recentRequests: (HttpRequestEvent & { time: number })[] = [];
	const recentCards: (CardRenderEvent & { time: number })[] = [];
	const recentSyncs: { time: number; action: string; detail: string }[] = [];
	const recentTiles: (TileEvent & { time: number })[] = [];

	const isInteractive = Boolean(opts.renderer) || isInteractiveTty(opts.noTui);

	if (!isInteractive) {
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
			getLastCopiedText() {
				return lastCopiedText;
			},
			destroy() {},
		};
	}

	let isDestroyed = false;
	let ticker: any = null;
	let throbber: any = null;

	const renderer =
		opts.renderer ||
		(await createCliRenderer({
			exitOnCtrlC: false,
			exitSignals: [],
		}));

	renderer.on?.("destroy", () => {
		isDestroyed = true;
		if (ticker) clearInterval(ticker);
		throbber?.stop();
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

	// Header Box
	const headerBox = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: boxW - 4,
		marginY: 0,
	});
	const topHeaderRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		justifyContent: "space-between",
		width: boxW - 4,
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
		width: boxW - 4,
		height: 1,
		backgroundColor: THEME.surface,
		marginY: 0,
	});
	const tabPillsList = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 1,
		marginY: 0,
	});
	tabPillsRow.add(tabPillsList);

	const tabNewBtn = new TextRenderable(renderer, {
		content: "+ [^n]",
		fg: THEME.teal,
		bg: THEME.surface,
	});

	const tabHintText = new TextRenderable(renderer, {
		content: "Alt-1..0 / Alt-j/k ⇄  [^w] Close",
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
		width: boxW - 4,
		marginY: 0,
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
		width: boxW - 4,
	});

	const topRow = new BoxRenderable(renderer, {
		flexDirection: "row",
		gap: 2,
		flexGrow: 1,
		marginY: 0,
	});
	let leftW = Math.floor((boxW - 4) * 0.52);

	let focusedPaneIdx: number | null = null;
	let hoveredPaneIdx: number | null = null;
	const scrollOffsets: [number, number, number, number] = [0, 0, 0, 0];

	let maxEventLines = Math.max(3, Math.floor((boxH - 12) / 2));
	let maxTileLines = Math.max(2, maxEventLines - 1);

	const paneBaseTitles = [
		"LIVE HTTP REQUESTS",
		"SOCIAL CARDS (HEADLESS CHROMIUM)",
		"API & SYNC HUB (WEBSOCKET / SQLite)",
		"TILE ENGINE & CACHE",
	] as const;

	function getPaneBufferLength(paneIdx: number): number {
		if (paneIdx === 0) return recentRequests.length;
		if (paneIdx === 1) return recentCards.length;
		if (paneIdx === 2) return recentSyncs.length;
		return recentTiles.length;
	}

	function getPaneVisibleLines(paneIdx: number): number {
		return paneIdx === 3 ? maxTileLines : maxEventLines;
	}

	function clampPaneScroll(paneIdx: number) {
		const maxOff = Math.max(0, getPaneBufferLength(paneIdx) - getPaneVisibleLines(paneIdx));
		if (scrollOffsets[paneIdx] > maxOff) scrollOffsets[paneIdx] = maxOff;
		if (scrollOffsets[paneIdx] < 0) scrollOffsets[paneIdx] = 0;
	}

	function scrollPane(paneIdx: number, deltaLines: number) {
		scrollOffsets[paneIdx] += deltaLines;
		clampPaneScroll(paneIdx);
	}

	function pushToPaneBuffer<T>(buf: T[], item: T, paneIdx: number) {
		buf.push(item);
		const shifted = buf.length > MONITOR_SCROLLBACK_LIMIT;
		if (shifted) buf.shift();
		if (scrollOffsets[paneIdx] > 0 && !shifted) {
			scrollOffsets[paneIdx]++;
		}
		clampPaneScroll(paneIdx);
	}

	function makePaneMouseHandlers(paneIdx: number) {
		return {
			onMouseOver() {
				hoveredPaneIdx = paneIdx;
			},
			onMouseOut() {
				if (hoveredPaneIdx === paneIdx) hoveredPaneIdx = null;
			},
			onMouseDown() {
				if (focusedPaneIdx !== paneIdx) {
					focusedPaneIdx = paneIdx;
					renderUi(true);
				}
			},
			onMouseScroll(ev: MouseEvent) {
				focusedPaneIdx = paneIdx;
				const dir = ev.scroll?.direction;
				const step = Math.max(1, ev.scroll?.delta || 1);
				if (dir === "up") {
					scrollPane(paneIdx, step);
					renderUi(true);
				} else if (dir === "down") {
					scrollPane(paneIdx, -step);
					renderUi(true);
				}
			},
		};
	}

	const httpPane = new BoxRenderable(renderer, {
		width: leftW,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
		...makePaneMouseHandlers(0),
	});
	const httpTitle = new TextRenderable(renderer, { content: paneBaseTitles[0], fg: THEME.peach });
	httpPane.add(httpTitle);

	const cardPane = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
		...makePaneMouseHandlers(1),
	});
	const cardTitle = new TextRenderable(renderer, { content: paneBaseTitles[1], fg: THEME.teal });
	cardPane.add(cardTitle);

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
		...makePaneMouseHandlers(2),
	});
	const syncTitle = new TextRenderable(renderer, { content: paneBaseTitles[2], fg: THEME.mauve });
	syncPane.add(syncTitle);

	const tilePane = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
		...makePaneMouseHandlers(3),
	});
	const tileTitle = new TextRenderable(renderer, { content: paneBaseTitles[3], fg: THEME.green });
	tilePane.add(tileTitle);
	const tileStats1 = new TextRenderable(renderer, {
		content: "Total: 0 · Stored: 0 · Cache: 0 · Stitched: 0 (0.0%)",
		fg: THEME.text,
	});
	tilePane.add(tileStats1);

	btmRow.add(syncPane);
	btmRow.add(tilePane);
	monitorRoot.add(btmRow);

	const monitorPanes = [httpPane, cardPane, syncPane, tilePane];
	const monitorTitles = [httpTitle, cardTitle, syncTitle, tileTitle];

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

	const httpLines: TextRenderable[] = [];
	const cardLines: TextRenderable[] = [];
	const syncLines: TextRenderable[] = [];
	const tileLines: TextRenderable[] = [];

	updatePaneLines(httpPane, httpLines, maxEventLines);
	updatePaneLines(cardPane, cardLines, maxEventLines);
	updatePaneLines(syncPane, syncLines, maxEventLines);
	updatePaneLines(tilePane, tileLines, maxTileLines);

	// Clipboard service: uses OpenTUI host clipboard when running interactively (or custom clipboard in tests)
	let hostClipboard: HostClipboardService | NonNullable<ServerDashboardOptions["clipboard"]> | null =
		opts.clipboard ?? null;
	if (!hostClipboard && !opts.renderer) {
		try {
			hostClipboard = createHostClipboard();
		} catch {}
	}

	function copySelectedText(): boolean {
		const sel = renderer.getSelection?.();
		const text = sel?.getSelectedText?.() || "";
		if (!text) return false;
		lastCopiedText = text;
		copiedUntil = Date.now() + 2000;
		opts.onCopy?.(text);
		try {
			void Promise.resolve(hostClipboard?.writeText(text)).catch(() => {});
			void Promise.resolve(hostClipboard?.writeText(text, { selection: "primary" })).catch(() => {});
		} catch {}
		try {
			if (renderer.isOsc52Supported?.()) {
				renderer.copyToClipboardOSC52?.(text);
			}
		} catch {}
		renderUi(true);
		return true;
	}

	const onSelection = () => {
		copySelectedText();
	};
	renderer.on?.("selection", onSelection);

	// Tabs system
	let activeTabIdx = 0;
	const tabs: TabItem[] = [
		{ id: "monitor", label: "Live Monitor", type: "monitor" },
		{ id: "catalog", label: "Games Catalog", type: "catalog" },
	];

	function runningJobTabs(): TabItem[] {
		return tabs.filter(
			(tab) => tab.type === "job" && (tab.view as ServerJobView | undefined)?.status === "running",
		);
	}

	const origLog = console.log;
	const origInfo = console.info;
	const origWarn = console.warn;
	const origError = console.error;

	function logApi(action: string, detail: string, time = Date.now()) {
		pushToPaneBuffer(recentSyncs, { time, action, detail }, 2);
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
		width: boxW - 4,
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
			width: boxW - 4,
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
			width: boxW - 4,
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
			width: boxW - 4,
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
			width: boxW - 4,
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
			width: boxW - 4,
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
			const isRunning = t.type === "job" && (t.view as ServerJobView | undefined)?.status === "running";
			const badge = isRunning ? " (RUNNING)" : t.statusBadge ? ` ${t.statusBadge}` : "";
			const canClose =
				(i >= 2 && t.type === "form") || (t.type === "job" && (t.view as ServerJobView)?.status !== "running");
			const closeMark = canClose ? " ×" : "";

			if (isAct) {
				const spinner = isRunning ? `${activeThrobberFrame} ` : "";
				tabPillTexts[i].content = ` ${spinner}▌ ${i + 1}  ${t.label}${badge}${closeMark} `;
				tabPillTexts[i].fg = THEME.peach;
				tabPillTexts[i].bg = THEME.surfaceLight;
			} else if (isRunning) {
				tabPillTexts[i].content = ` ${activeThrobberFrame} ${i + 1}  ${t.label} (RUNNING)${closeMark} `;
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
				boxW >= 105 ? "Alt-1..0 / Alt-j/k ⇄  [^w] Close" : boxW >= 80 ? "Alt-1..0 / Alt-j/k ⇄" : "";
		}

		renderer.requestRender();
	}

	let currentMountedRoot: BoxRenderable | null = null;

	function switchTab(index: number) {
		if (index < 0 || index >= tabs.length) return;
		for (let i = 0; i < tabs.length; i++) {
			if (i !== index) {
				tabs[i].view?.blur?.();
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

	function slicePaneItems<T>(buf: T[], visibleCount: number, paneIdx: number): T[] {
		clampPaneScroll(paneIdx);
		const offset = scrollOffsets[paneIdx];
		const endIdx = Math.max(0, buf.length - offset);
		const startIdx = Math.max(0, endIdx - visibleCount);
		return buf.slice(startIdx, endIdx);
	}

	function renderUi(_force = false) {
		if (isDestroyed || (renderer as any).isDestroyed) return;
		const now = Date.now();

		const elapsed = (now - startTime) / 1000;
		const runningJobs = runningJobTabs();
		const activeJobs =
			runningJobs.length > 0
				? ` | ${activeThrobberFrame} ${runningJobs.length} job${runningJobs.length === 1 ? "" : "s"} running`
				: "";
		subText.content = `http://${opts.host}:${opts.port}/ | Uptime: ${fmtTime(elapsed)} | WS: ${wsCount} active${activeJobs}`;

		const leftInnerW = Math.max(12, leftW - 4);
		const rightInnerW = Math.max(12, boxW - 4 - leftW - 2 - 4);
		const maxPathLen = Math.max(16, Math.floor(boxW * 0.45) - 27);

		for (let p = 0; p < 4; p++) {
			clampPaneScroll(p);
			const isFocused = focusedPaneIdx === p;
			monitorPanes[p].borderColor = isFocused ? RGBA_THEME.borderFocus : RGBA_THEME.borderDim;
			const innerW = p % 2 === 0 ? leftInnerW : rightInnerW;
			const prefix = isFocused ? "▸ " : "";
			const scrollBadge = scrollOffsets[p] > 0 ? ` [↑ -${scrollOffsets[p]}]` : isFocused ? " [FOCUSED]" : "";
			monitorTitles[p].content = fitLine(`${prefix}${paneBaseTitles[p]}${scrollBadge}`, innerW);
		}

		// HTTP lines (chronological: oldest visible at top, newest at bottom)
		const displayHttp = slicePaneItems(recentRequests, httpLines.length, 0);
		for (let i = 0; i < httpLines.length; i++) {
			const item = displayHttp[i];
			if (item) {
				let col = THEME.green;
				if (item.status >= 500) col = THEME.red;
				else if (item.status >= 400) col = THEME.yellow;
				else if (item.status >= 300) col = THEME.blue;
				const p = item.path.length > maxPathLen ? item.path.slice(0, maxPathLen - 1) + "…" : item.path;
				httpLines[i].content = fitLine(
					`${fmtClock(item.time)} [${item.method} ${item.status}] ${p} (${item.durationMs.toFixed(0)}ms)`,
					leftInnerW,
				);
				httpLines[i].fg = col;
			} else {
				httpLines[i].content = "  ·";
				httpLines[i].fg = THEME.textDim;
			}
		}

		// Card lines (chronological: oldest visible at top, newest at bottom)
		const displayCards = slicePaneItems(recentCards, cardLines.length, 1);
		for (let i = 0; i < cardLines.length; i++) {
			const item = displayCards[i];
			if (item) {
				const tag = item.cached ? "[CACHE]" : "[RENDER]";
				const col = item.cached ? THEME.teal : THEME.peach;
				const k = item.key.length > maxPathLen ? item.key.slice(0, maxPathLen - 1) + "…" : item.key;
				cardLines[i].content = fitLine(
					`${fmtClock(item.time)} ${tag} ${item.type}: ${k} (${item.durationMs.toFixed(0)}ms)`,
					rightInnerW,
				);
				cardLines[i].fg = col;
			} else {
				cardLines[i].content = "  ·";
				cardLines[i].fg = THEME.textDim;
			}
		}

		// Sync lines (chronological: oldest visible at top, newest at bottom)
		const displaySyncs = slicePaneItems(recentSyncs, syncLines.length, 2);
		for (let i = 0; i < syncLines.length; i++) {
			const item = displaySyncs[i];
			if (item) {
				const det = item.detail.length > maxPathLen ? item.detail.slice(0, maxPathLen - 1) + "…" : item.detail;
				syncLines[i].content = fitLine(`${fmtClock(item.time)} [${item.action}] ${det}`, leftInnerW);
				syncLines[i].fg = THEME.mauve;
			} else {
				syncLines[i].content = "  ·";
				syncLines[i].fg = THEME.textDim;
			}
		}

		// Tile lines & stats (chronological: oldest visible at top, newest at bottom)
		const displayTiles = slicePaneItems(recentTiles, tileLines.length, 3);
		for (let i = 0; i < tileLines.length; i++) {
			const item = displayTiles[i];
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
				tileLines[i].content = fitLine(`${fmtClock(item.time)} ${tag.padEnd(8)} ${p}${dur}`, rightInnerW);
				tileLines[i].fg = col;
			} else {
				tileLines[i].content = "  ·";
				tileLines[i].fg = THEME.textDim;
			}
		}

		const hitRatio = totalTiles > 0 ? (((storedTiles + cachedTiles) / totalTiles) * 100).toFixed(1) : "0.0";
		tileStats1.content = fitLine(
			`Total: ${fmt(totalTiles)} · Stored: ${fmt(storedTiles)} · Cache: ${fmt(cachedTiles)} · Stitched: ${fmt(derivedTiles)} (${hitRatio}%)`,
			rightInnerW,
		);

		// Context-sensitive Footer Keybind Hints
		const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
		const cur = tabs[activeTabIdx];
		let hints = "";
		const tabMax = Math.min(10, tabs.length);
		const tabHint = `[Alt-1..${tabMax === 10 ? "0" : tabMax}] Tabs   [Alt-j/k] Next/Prev`;

		if (cur.type === "monitor") {
			hints = `[Tab] Focus Pane   [↑↓/jk/PgUp/PgDn] Scroll   [Esc] Follow   [^C/y] Copy   [^n] New   [^c] Quit`;
		} else if (cur.type === "catalog") {
			const cat = cur.view as GamesCatalogView;
			if (cat?.isModalOpen()) {
				hints = `[Tab/Shift+Tab] Move   [Enter] Confirm/Save   [Esc] Cancel   ${tabHint}`;
			} else {
				hints = `[←↑→↓] Select   [U] Update   [P] Prune   [C] Cards   [E/Enter] Edit   [[ / ]] Reorder   [D] Delete   [/] Search   [^n] New   ${tabHint}`;
			}
		} else if (cur.type === "form") {
			hints = `[Tab/Shift+Tab] Field   [Space] Toggle   [Enter] Start Scrape   [Esc/^w] Close Tab   ${tabHint}`;
		} else if (cur.type === "job") {
			const jv = cur.view as ServerJobView;
			if (jv?.status === "running") {
				hints = `${tabHint} (runs in background)   [^n] New Scrape`;
			} else {
				hints = `[^w] Close Tab   [Alt-1] Monitor   [Alt-2] Catalog   [^n] New Scrape   ${tabHint}`;
			}
		}

		const copiedBadge = now < copiedUntil ? "   |   ✓ Copied" : "";
		footerBar.content = fitLine(`${hints}${copiedBadge}   |   RSS: ${memMb} MB`, boxW - 4);
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
		headerBox.width = boxW - 4;
		topHeaderRow.width = boxW - 4;
		tabPillsRow.width = boxW - 4;
		contentBox.width = boxW - 4;
		monitorRoot.width = boxW - 4;
		topRow.width = boxW - 4;
		btmRow.width = boxW - 4;
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
				tab.view.resize(boxW - 4, boxH - 5);
			}
		}

		if (tabHintText) {
			tabHintText.content =
				boxW >= 105 ? "Alt-1..0 / Alt-j/k ⇄  [^w] Close" : boxW >= 80 ? "Alt-1..0 / Alt-j/k ⇄" : "";
		}

		renderUi(true);
	}

	renderer.on("resize", handleResize);
	const onStdoutResize = () => handleResize(renderer.width, renderer.height);
	process.stdout.on("resize", onStdoutResize);

	// Keybind handlers
	renderer.keyInput.on("keypress", (key: KeyEvent) => {
		if (isDestroyed) return;

		// Ctrl+Shift+C, Meta+C, Super+C, or 'y' (when selection exists and not in form) copies selected text
		const isCopyShortcut =
			(key.ctrl && key.shift && (key.name === "c" || key.name === "C")) ||
			((key.meta || (key as any).super) && (key.name === "c" || key.name === "C")) ||
			(!key.ctrl &&
				!(key as any).alt &&
				!key.meta &&
				!key.option &&
				(key.name === "y" || key.name === "Y") &&
				tabs[activeTabIdx]?.type !== "form" &&
				Boolean(renderer.getSelection?.()?.getSelectedText?.()));
		if (isCopyShortcut) {
			key.preventDefault?.();
			key.stopPropagation?.();
			copySelectedText();
			return;
		}

		// Ctrl-C (without Shift) gracefully shuts down the server
		const isCtrlC =
			(!key.shift && key.ctrl && (key.name === "c" || key.name === "C")) || (key.raw === "\x03" && !key.shift);
		if (isCtrlC) {
			key.preventDefault?.();
			key.stopPropagation?.();
			if (opts.onExit) {
				opts.onExit();
			} else {
				process.kill(process.pid, "SIGINT");
			}
			return;
		}

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

		// Alt+1..Alt+0, or Meta+1..Meta+0 to switch directly to tabs 1 through 10
		const isAltOrMeta = Boolean(
			key.option || key.meta || (key as any).alt || (key.raw && /^\x1b[0-9]$/.test(key.raw)),
		);
		if (isAltOrMeta) {
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
			((key.option || key.meta || (key as any).alt) &&
				(key.name === "k" || key.name === "K" || key.name === "up")) ||
			key.raw === "\x1bk";
		if (isPrevTab) {
			key.preventDefault?.();
			switchTab((activeTabIdx - 1 + tabs.length) % tabs.length);
			return;
		}

		// Alt-j, Alt-Down for next tab
		const isNextTab =
			((key.option || key.meta || (key as any).alt) &&
				(key.name === "j" || key.name === "J" || key.name === "down")) ||
			key.raw === "\x1bj";
		if (isNextTab) {
			key.preventDefault?.();
			switchTab((activeTabIdx + 1) % tabs.length);
			return;
		}

		// Live Monitor pane focus & scrollback navigation
		const curTab = tabs[activeTabIdx];
		if (curTab?.type === "monitor") {
			const isShiftTab = (key.name === "tab" && key.shift) || key.name === "backtab" || key.raw === "\x1b[Z";
			const isTab = key.name === "tab" && !key.shift && !isShiftTab;
			if (isTab) {
				focusedPaneIdx = focusedPaneIdx === null ? 0 : (focusedPaneIdx + 1) % 4;
				key.preventDefault?.();
				key.stopPropagation?.();
				renderUi(true);
				return;
			}
			if (isShiftTab) {
				focusedPaneIdx = focusedPaneIdx === null ? 3 : (focusedPaneIdx + 3) % 4;
				key.preventDefault?.();
				key.stopPropagation?.();
				renderUi(true);
				return;
			}
			if (key.name === "escape" || key.raw === "\x1b") {
				focusedPaneIdx = null;
				scrollOffsets[0] = 0;
				scrollOffsets[1] = 0;
				scrollOffsets[2] = 0;
				scrollOffsets[3] = 0;
				key.preventDefault?.();
				key.stopPropagation?.();
				renderUi(true);
				return;
			}

			const targetPane = focusedPaneIdx ?? hoveredPaneIdx;
			if (targetPane !== null) {
				const fullPage = getPaneVisibleLines(targetPane);
				const halfPage = Math.max(1, Math.floor(fullPage / 2));
				const noMod = !key.ctrl && !key.option && !key.meta && !(key as any).alt;

				const isUp = noMod && (key.name === "up" || key.name === "k");
				const isDown = noMod && (key.name === "down" || key.name === "j");
				const isHalfUp = (key.ctrl && (key.name === "u" || key.name === "U")) || key.raw === "\x15";
				const isHalfDown = (key.ctrl && (key.name === "d" || key.name === "D")) || key.raw === "\x04";
				const isFullUp =
					(key.ctrl && (key.name === "b" || key.name === "B")) || key.raw === "\x02" || key.name === "pageup";
				const isFullDown =
					(key.ctrl && (key.name === "f" || key.name === "F")) ||
					key.raw === "\x06" ||
					key.name === "pagedown";
				const isBottom =
					(noMod && key.name === "end") ||
					(noMod && (key.name === "G" || key.sequence === "G" || (key.name === "g" && key.shift)));
				const isTop = (noMod && key.name === "home") || (noMod && !isBottom && key.name === "g" && !key.shift);

				if (isUp || isDown || isHalfUp || isHalfDown || isFullUp || isFullDown || isTop || isBottom) {
					focusedPaneIdx = targetPane;
					if (isUp) scrollPane(targetPane, 1);
					else if (isDown) scrollPane(targetPane, -1);
					else if (isHalfUp) scrollPane(targetPane, halfPage);
					else if (isHalfDown) scrollPane(targetPane, -halfPage);
					else if (isFullUp) scrollPane(targetPane, fullPage);
					else if (isFullDown) scrollPane(targetPane, -fullPage);
					else if (isTop) {
						scrollOffsets[targetPane] = Math.max(0, getPaneBufferLength(targetPane) - fullPage);
						clampPaneScroll(targetPane);
					} else if (isBottom) {
						scrollOffsets[targetPane] = 0;
					}
					key.preventDefault?.();
					key.stopPropagation?.();
					renderUi(true);
					return;
				}
			}
		}

		// Forward keys to active tab view (tab-specific bindings)
		if (curTab?.view?.handleKey) {
			const handled = curTab.view.handleKey(key);
			if (handled) {
				key.preventDefault?.();
				key.stopPropagation?.();
				renderUi(true);
				return;
			}
		}

		renderUi(false);
	});

	// Initial tab setup
	switchTab(0);

	// Auto-render ticker every 1s for uptime & memory
	ticker = setInterval(() => {
		renderUi(true);
	}, 1000);

	throbber = startThrobber((frame) => {
		if (isDestroyed) return;
		activeThrobberFrame = frame;
		if (runningJobTabs().length === 0) return;
		updateTabBar();
		renderUi(false);
	});

	return {
		onRequest(ev) {
			totalRequests++;
			pushToPaneBuffer(recentRequests, { ...ev, time: ev.time ?? Date.now() }, 0);
			renderUi(false);
		},
		onCard(ev) {
			totalCards++;
			pushToPaneBuffer(recentCards, { ...ev, time: ev.time ?? Date.now() }, 1);
			renderUi(false);
		},
		onTile(ev) {
			totalTiles++;
			if (ev.action === "stored") storedTiles++;
			else if (ev.action === "cached") cachedTiles++;
			else if (ev.action === "derived") derivedTiles++;
			pushToPaneBuffer(recentTiles, { ...ev, time: ev.time ?? Date.now() }, 3);
			renderUi(false);
		},
		onSync(action, detail, time = Date.now()) {
			pushToPaneBuffer(recentSyncs, { time, action, detail }, 2);
			renderUi(false);
		},
		onApi(action, detail, time = Date.now()) {
			logApi(action, detail, time);
		},
		setWsCount(count) {
			wsCount = count;
			renderUi(false);
		},
		getLastCopiedText() {
			return lastCopiedText;
		},
		async destroy() {
			if (ticker) clearInterval(ticker);
			throbber?.stop();
			console.log = origLog;
			console.info = origInfo;
			console.warn = origWarn;
			console.error = origError;
			if (!isDestroyed) {
				isDestroyed = true;
				renderer.off?.("resize", handleResize);
				renderer.off?.("selection", onSelection);
				process.stdout.off?.("resize", onStdoutResize);
				for (const tab of tabs) {
					if (tab.view) tab.view.destroy();
				}
				if (hostClipboard && !opts.clipboard) {
					try {
						await hostClipboard.dispose?.();
					} catch {}
				}
				if (!opts.renderer) {
					try {
						renderer.destroy();
						await renderer.closed;
					} catch {}
				} else {
					try {
						renderer.root.remove(rootBox);
						if (!(renderer as any).isDestroyed) {
							renderer.requestRender();
						}
					} catch {}
				}
			}
		},
	};
}