// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	BoxRenderable,
	FrameBufferRenderable,
	type KeyEvent,
	RGBA,
	TextAttributes,
	TextRenderable,
} from "@opentui/core";

import {
	type PipelineGameContext,
	type PipelineMediaProgress,
	type PipelineOptimizeProgress,
	type PipelineTileProgress,
	runPipelineStageCards,
	runPipelineStageMedia,
	runPipelineStageMetaAndTiles,
	runPipelineStageOptimize,
} from "../add-game.js";
import { type GameInfo, gameToPipelineOptions, type UpdateGameOptions } from "../update-games.js";
import { hslToRgbInts } from "./quit-confirm.js";
import { fmtBytes, fmtTime, RGBA_THEME, startThrobber, THEME, throbberFrame } from "./theme.js";

export type PipelineStageId = "meta_tiles" | "optimize" | "media" | "cards" | "report";
export type PulseKind = "arrival" | "success" | "error";

export interface PipelineStageMeta {
	id: PipelineStageId;
	shortTitle: string;
	title: string;
}

export const PIPELINE_STAGES: readonly PipelineStageMeta[] = [
	{ id: "meta_tiles", shortTitle: "1. Meta & Tiles", title: "Stage 1: Metadata & Tiles" },
	{ id: "optimize", shortTitle: "2. Optimize", title: "Stage 2: Optimize & Prune" },
	{ id: "media", shortTitle: "3. Media", title: "Stage 3: Media Assets" },
	{ id: "cards", shortTitle: "4. Cards", title: "Stage 4: Preview Cards" },
	{ id: "report", shortTitle: "5. Report", title: "Stage 5: Final Report" },
];

export const FOLLOW_MAGENTA = "#f472b6";
export const RGBA_FOLLOW_MAGENTA = RGBA.fromHex(FOLLOW_MAGENTA);

export interface StagePulseState {
	kind: PulseKind;
	startedAt: number;
	durationMs: number;
}

export interface StageWaveOptions {
	nowMs: number;
	working: boolean;
	selected: boolean;
	followedHere: boolean;
	pulse?: StagePulseState | null;
}

/** Truncate a slug or label to fit within `maxLen` columns. */
export function truncateSlug(slug: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (slug.length <= maxLen) return slug;
	if (maxLen === 1) return "…";
	return slug.slice(0, maxLen - 1) + "…";
}

/** Format tile downloader progress for the sidebar, including tileset index, mode, and ETA. */
export function formatTileSidebarStats(ev: PipelineTileProgress): string {
	const tsPart = `${ev.tilesetIndex}/${ev.totalTilesets}`;
	const totalPart = ev.mode === "unknown" ? "?" : String(ev.total);
	const estTag = ev.mode === "estimated" ? " est" : "";
	const etaPart = ev.etaSeconds >= 0 ? ` ~${fmtTime(ev.etaSeconds)}` : "";
	return `${tsPart} ${ev.done}/${totalPart}${estTag}${etaPart}`;
}

/** Format media downloader/uploader progress for the sidebar, including ETA. */
export function formatMediaSidebarStats(ev: PipelineMediaProgress): string {
	const etaPart = ev.etaSeconds >= 0 ? ` (ETA ~${fmtTime(ev.etaSeconds)})` : "";
	return `${ev.done}/${ev.total}${etaPart}`;
}

/** Format optimize/prune progress for the sidebar. */
export function formatOptimizeSidebarStats(ev: PipelineOptimizeProgress): string {
	const tsPart = `${ev.tilesetIndex}/${ev.totalTilesets}`;
	const freed = ev.freedBytes > 0 ? ` -${fmtBytes(ev.freedBytes)}` : "";
	return `${tsPart} ${ev.phase} (${ev.tilesDone})${freed}`;
}

/**
 * Calculate the background RGBA color for a cell `(x, y)` in a pipeline sidebar stage card.
 * Active stages display a faint rightward-moving color wave; pulses briefly override with
 * red (error), green (success), or bright blue (new job arrival).
 */
export function calculateStageCellBg(x: number, y: number, opts: StageWaveOptions): RGBA {
	let h = opts.followedHere ? 320 : opts.selected ? 45 : 215;
	let s = 0.18;
	let l = 0.13;

	if (opts.working) {
		// Rightward-moving wave: phase = x * freq - time * speed
		const phase = x * 0.28 + y * 0.12 - opts.nowMs * 0.0026;
		const wave = Math.sin(phase);
		s = (opts.followedHere ? 0.3 : opts.selected ? 0.28 : 0.24) + 0.12 * wave;
		l = 0.145 + 0.025 * wave;
	}

	if (opts.pulse) {
		const age = opts.nowMs - opts.pulse.startedAt;
		if (age >= 0 && age < opts.pulse.durationMs) {
			const t = 1 - age / opts.pulse.durationMs;
			const intensity = Math.sin((t * Math.PI) / 2);
			if (opts.pulse.kind === "error") {
				h = 352;
				s = 0.72;
				l = l + 0.22 * intensity;
			} else if (opts.pulse.kind === "success") {
				h = 140;
				s = 0.6;
				l = l + 0.18 * intensity;
			} else if (opts.pulse.kind === "arrival") {
				h = 205;
				s = 0.78;
				l = l + 0.22 * intensity;
			}
		}
	}

	if (!opts.working && (!opts.pulse || opts.nowMs - opts.pulse.startedAt >= opts.pulse.durationMs)) {
		if (opts.followedHere) {
			h = 320;
			s = 0.24;
			l = 0.15;
		} else if (opts.selected) {
			h = 45;
			s = 0.2;
			l = 0.14;
		} else {
			return RGBA_THEME.surface;
		}
	}

	const [r, g, b] = hslToRgbInts(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(0.85, l)));
	return RGBA.fromInts(r, g, b, 255);
}

/** Simple unbounded async FIFO queue with close signal for pipeline stages. */
export class AsyncQueue<T> {
	private items: T[] = [];
	private waiters: ((val: T | null) => void)[] = [];
	private closed = false;

	push(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(item);
		} else {
			this.items.push(item);
		}
	}

	close(): void {
		this.closed = true;
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			waiter(null);
		}
	}

	get size(): number {
		return this.items.length;
	}

	next(): Promise<T | null> {
		if (this.items.length > 0) {
			return Promise.resolve(this.items.shift()!);
		}
		if (this.closed) {
			return Promise.resolve(null);
		}
		return new Promise<T | null>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

export interface PipelineFailureRecord {
	slug: string;
	title: string;
	stage: PipelineStageId;
	error: string;
}

export interface PipelineSuccessRecord {
	slug: string;
	title: string;
	elapsedMs: number;
}

export interface PipelineTimingSpan {
	slug: string;
	stage: Exclude<PipelineStageId, "report">;
	status: "ok" | "skipped" | "error";
	enqueuedAtMs: number;
	startMs: number;
	endMs: number;
	durationMs: number;
	queueWaitMs: number;
	error?: string;
}

export interface PipelineStageTimingSummary {
	stage: Exclude<PipelineStageId, "report">;
	busyMs: number;
	idleMs: number;
	utilizationPct: number;
	avgDurationMs: number;
	maxDurationMs: number;
	maxGameSlug: string | null;
	totalQueueWaitMs: number;
	avgQueueWaitMs: number;
	okCount: number;
	skippedCount: number;
	errorCount: number;
}

export interface ChromeTraceEvent {
	name: string;
	cat?: string;
	ph: "X" | "M";
	pid: number;
	tid: number;
	ts: number;
	dur?: number;
	args?: Record<string, any>;
}

export interface PipelineTimingReport {
	jobId: string;
	title: string;
	totalGames: number;
	startedAt: string;
	endedAt: string;
	totalDurationMs: number;
	stagesSummary: PipelineStageTimingSummary[];
	spans: PipelineTimingSpan[];
	traceEvents: ChromeTraceEvent[];
}

const ACTIVE_STAGE_IDS: readonly Exclude<PipelineStageId, "report">[] = ["meta_tiles", "optimize", "media", "cards"];

/** Collects per-game, per-stage execution & queue-wait spans and exports a flamegraph-compatible timing report. */
export class PipelineTimingRecorder {
	readonly startTimeMs: number;
	private spans: PipelineTimingSpan[] = [];

	constructor(startTimeMs = Date.now()) {
		this.startTimeMs = startTimeMs;
	}

	record(params: {
		slug: string;
		stage: Exclude<PipelineStageId, "report">;
		status: "ok" | "skipped" | "error";
		enqueuedAtAbsMs: number;
		startAbsMs: number;
		endAbsMs: number;
		error?: string;
	}): void {
		const enqueuedAtMs = Math.max(0, params.enqueuedAtAbsMs - this.startTimeMs);
		const startMs = Math.max(0, params.startAbsMs - this.startTimeMs);
		const endMs = Math.max(startMs, params.endAbsMs - this.startTimeMs);
		const durationMs = endMs - startMs;
		const queueWaitMs = Math.max(0, startMs - enqueuedAtMs);
		this.spans.push({
			slug: params.slug,
			stage: params.stage,
			status: params.status,
			enqueuedAtMs,
			startMs,
			endMs,
			durationMs,
			queueWaitMs,
			...(params.error ? { error: params.error } : {}),
		});
	}

	buildReport(meta: { jobId: string; title: string; totalGames: number; endTimeMs?: number }): PipelineTimingReport {
		const endTimeMs = meta.endTimeMs ?? Date.now();
		const totalDurationMs = Math.max(1, endTimeMs - this.startTimeMs);
		const sorted = [...this.spans].sort((a, b) => a.startMs - b.startMs);

		const stagesSummary: PipelineStageTimingSummary[] = ACTIVE_STAGE_IDS.map((stage) => {
			const stageSpans = sorted.filter((s) => s.stage === stage);
			const activeSpans = stageSpans.filter((s) => s.status !== "skipped");
			const busyMs = activeSpans.reduce((acc, s) => acc + s.durationMs, 0);
			const idleMs = Math.max(0, totalDurationMs - busyMs);
			const utilizationPct = Math.min(100, (busyMs / totalDurationMs) * 100);
			const okCount = stageSpans.filter((s) => s.status === "ok").length;
			const skippedCount = stageSpans.filter((s) => s.status === "skipped").length;
			const errorCount = stageSpans.filter((s) => s.status === "error").length;
			const totalQueueWaitMs = activeSpans.reduce((acc, s) => acc + s.queueWaitMs, 0);
			const avgQueueWaitMs = activeSpans.length > 0 ? totalQueueWaitMs / activeSpans.length : 0;
			const avgDurationMs = activeSpans.length > 0 ? busyMs / activeSpans.length : 0;
			let maxDurationMs = 0;
			let maxGameSlug: string | null = null;
			for (const s of activeSpans) {
				if (s.durationMs >= maxDurationMs) {
					maxDurationMs = s.durationMs;
					maxGameSlug = s.slug;
				}
			}
			return {
				stage,
				busyMs,
				idleMs,
				utilizationPct: Number(utilizationPct.toFixed(2)),
				avgDurationMs: Math.round(avgDurationMs),
				maxDurationMs: Math.round(maxDurationMs),
				maxGameSlug,
				totalQueueWaitMs: Math.round(totalQueueWaitMs),
				avgQueueWaitMs: Math.round(avgQueueWaitMs),
				okCount,
				skippedCount,
				errorCount,
			};
		});

		const traceEvents: ChromeTraceEvent[] = ACTIVE_STAGE_IDS.map((stage, idx) => ({
			name: "thread_name",
			ph: "M",
			pid: 1,
			tid: idx + 1,
			ts: 0,
			args: { name: PIPELINE_STAGES[idx].title },
		}));

		for (const s of sorted) {
			if (s.status === "skipped") continue;
			const tid = ACTIVE_STAGE_IDS.indexOf(s.stage) + 1;
			traceEvents.push({
				name: s.slug,
				cat: s.stage,
				ph: "X",
				pid: 1,
				tid,
				ts: Math.round(s.startMs * 1000),
				dur: Math.max(1, Math.round(s.durationMs * 1000)),
				args: {
					slug: s.slug,
					stage: s.stage,
					status: s.status,
					queueWaitMs: s.queueWaitMs,
					...(s.error ? { error: s.error } : {}),
				},
			});
		}

		return {
			jobId: meta.jobId,
			title: meta.title,
			totalGames: meta.totalGames,
			startedAt: new Date(this.startTimeMs).toISOString(),
			endedAt: new Date(endTimeMs).toISOString(),
			totalDurationMs,
			stagesSummary,
			spans: sorted,
			traceEvents,
		};
	}
}

export interface PipelineJobOptions {
	renderer: any;
	width: number;
	height: number;
	jobId: string;
	title: string;
	slug: string;
	games: GameInfo[];
	updateOptions: UpdateGameOptions;
	mapsDir: string;
	onGameUpdated?: () => void;
	onCompleted?: (success: boolean, summary: string) => void;
	onCloseTab?: () => void;
}

export interface PipelineJobView {
	root: BoxRenderable;
	readonly isPipeline: true;
	readonly status: "running" | "completed" | "failed";
	readonly slug: string;
	readonly title: string;
	readonly logFile: string;
	handleKey(key: KeyEvent): boolean;
	resize(width: number, height: number): void;
	focus?(): void;
	blur?(): void;
	destroy(): void;
}

interface StageRuntimeState {
	id: PipelineStageId;
	activeSlug: string | null;
	queuedCount: number;
	statusLine: string;
	statsLine: string;
	pulse: StagePulseState | null;
	logs: string[];
}

export async function createPipelineJobView(opts: PipelineJobOptions): Promise<PipelineJobView> {
	const renderer = opts.renderer;
	let boxW = opts.width;
	let boxH = opts.height;
	const totalGames = opts.games.length;
	const startTime = Date.now();
	let endTime = 0;
	let jobStatus: "running" | "completed" | "failed" = "running";
	let isDestroyed = false;

	let selectedStageIdx = 0;
	let followedSlug: string | null = null;
	let activeThrobber = throbberFrame(0);

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const logFile = path.join(process.cwd(), "cache", "job-logs", `${stamp}-${opts.jobId}.log`);
	const timingFile = path.join(process.cwd(), "cache", "pipeline-timings", `${stamp}-${opts.jobId}.json`);
	const timingRecorder = new PipelineTimingRecorder(startTime);

	const succeeded: PipelineSuccessRecord[] = [];
	const failed: PipelineFailureRecord[] = [];
	const gameStartTimes = new Map<string, number>();

	const stageStates: StageRuntimeState[] = PIPELINE_STAGES.map((m) => ({
		id: m.id,
		activeSlug: null,
		queuedCount: 0,
		statusLine: "idle",
		statsLine: "",
		pulse: null,
		logs: [],
	}));

	const rootBox = new BoxRenderable(renderer, {
		width: boxW,
		height: boxH,
		flexDirection: "row",
		paddingX: 1,
		paddingY: 0,
		backgroundColor: THEME.bgDark,
	});

	const calcSidebarW = () => Math.max(26, Math.min(34, Math.floor((boxW - 4) * 0.27)));
	let sidebarW = calcSidebarW();
	let mainW = Math.max(30, boxW - 4 - sidebarW);

	// Left Sidebar
	const sidebarBox = new BoxRenderable(renderer, {
		width: sidebarW,
		height: boxH,
		flexDirection: "column",
		paddingRight: 1,
		backgroundColor: THEME.bgDark,
	});
	rootBox.add(sidebarBox);

	const sidebarHeader = new TextRenderable(renderer, {
		content: "PIPELINE STAGES",
		fg: THEME.peach,
	});
	const followHeader = new TextRenderable(renderer, {
		content: "[↑↓/kj] Nav  [f] Follow",
		fg: THEME.textDim,
	});
	sidebarBox.add(sidebarHeader);
	sidebarBox.add(followHeader);

	const calcCardH = () => {
		const avail = Math.max(20, boxH - 2);
		return Math.max(4, Math.min(5, Math.floor(avail / 5)));
	};

	interface StageCardUi {
		box: BoxRenderable;
		fb: FrameBufferRenderable;
	}
	const stageCards: StageCardUi[] = [];
	for (let i = 0; i < PIPELINE_STAGES.length; i++) {
		const cardH = calcCardH();
		const box = new BoxRenderable(renderer, {
			width: sidebarW - 1,
			height: cardH,
			border: true,
			borderColor: i === 0 ? RGBA_THEME.yellow : RGBA_THEME.borderDim,
			backgroundColor: THEME.surface,
			flexDirection: "column",
			paddingX: 0,
			paddingY: 0,
		});
		const fb = new FrameBufferRenderable(renderer, {
			width: Math.max(10, sidebarW - 3),
			height: Math.max(2, cardH - 2),
		});
		box.add(fb);
		sidebarBox.add(box);
		stageCards.push({ box, fb });
	}

	// Right Main Area
	const mainBox = new BoxRenderable(renderer, {
		width: mainW,
		height: boxH,
		flexDirection: "column",
		backgroundColor: THEME.bgDark,
	});
	rootBox.add(mainBox);

	// Main Header
	const headerBox = new BoxRenderable(renderer, {
		width: mainW,
		flexDirection: "column",
		border: true,
		borderColor: RGBA_THEME.borderDim,
		paddingX: 1,
		paddingY: 0,
	});
	const titleRow = new BoxRenderable(renderer, {
		width: Math.max(20, mainW - 4),
		flexDirection: "row",
		justifyContent: "space-between",
	});
	const titleText = new TextRenderable(renderer, {
		content: `PIPELINE: ${opts.title} (${totalGames} games)`,
		fg: THEME.peach,
	});
	const statusBadge = new TextRenderable(renderer, {
		content: ` [${activeThrobber} RUNNING]`,
		fg: THEME.yellow,
	});
	titleRow.add(titleText);
	titleRow.add(statusBadge);
	headerBox.add(titleRow);

	const subRow = new BoxRenderable(renderer, {
		width: Math.max(20, mainW - 4),
		flexDirection: "row",
		justifyContent: "space-between",
	});
	const stageText = new TextRenderable(renderer, {
		content: PIPELINE_STAGES[0].title,
		fg: THEME.teal,
	});
	const elapsedText = new TextRenderable(renderer, {
		content: `Done: 0/${totalGames}   Elapsed: 00:00`,
		fg: THEME.textDim,
	});
	subRow.add(stageText);
	subRow.add(elapsedText);
	headerBox.add(subRow);
	mainBox.add(headerBox);

	// Stage Panes (0..3 have embedded stageContainer + per-stage logBox; 4 is Report)
	const logBoxH = () => Math.max(4, Math.min(8, Math.floor(boxH * 0.22)));
	const stageBoxH = () => Math.max(6, boxH - 4 - logBoxH());

	interface ActiveStagePane {
		pane: BoxRenderable;
		stageContainer: BoxRenderable;
		pendingTitle: TextRenderable;
		pendingSub: TextRenderable;
		logBox: BoxRenderable;
		logLines: TextRenderable[];
	}
	const activePanes: ActiveStagePane[] = [];

	for (let i = 0; i < 4; i++) {
		const pane = new BoxRenderable(renderer, {
			width: mainW,
			height: Math.max(10, boxH - 4),
			flexDirection: "column",
			visible: i === 0,
		});
		const stageContainer = new BoxRenderable(renderer, {
			width: mainW,
			height: stageBoxH(),
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
		});
		const pendingTitle = new TextRenderable(renderer, {
			content: "Stage idle",
			fg: THEME.textDim,
		});
		const pendingSub = new TextRenderable(renderer, {
			content: "Waiting for games…",
			fg: THEME.textDim,
		});
		stageContainer.add(pendingTitle);
		stageContainer.add(pendingSub);
		pane.add(stageContainer);

		const logBox = new BoxRenderable(renderer, {
			width: mainW,
			height: logBoxH(),
			border: true,
			borderColor: RGBA_THEME.borderDim,
			flexDirection: "column",
			paddingX: 1,
			paddingY: 0,
		});
		const logTitle = new TextRenderable(renderer, {
			content: `STREAMING LOGS (${PIPELINE_STAGES[i].shortTitle})`,
			fg: THEME.textDim,
		});
		logBox.add(logTitle);
		const logLines: TextRenderable[] = [];
		pane.add(logBox);
		mainBox.add(pane);
		activePanes.push({ pane, stageContainer, pendingTitle, pendingSub, logBox, logLines });
	}

	// Stage 4: Final Report Pane
	const reportPane = new BoxRenderable(renderer, {
		width: mainW,
		height: Math.max(10, boxH - 4),
		border: true,
		borderColor: RGBA_THEME.borderDim,
		flexDirection: "column",
		paddingX: 1,
		paddingY: 0,
		visible: false,
	});
	const reportHeader = new TextRenderable(renderer, {
		content: "PIPELINE REPORT",
		fg: THEME.peach,
	});
	reportPane.add(reportHeader);
	const reportLinePool: TextRenderable[] = [];
	mainBox.add(reportPane);

	function ensureLogLines(paneIdx: number) {
		const p = activePanes[paneIdx];
		const want = Math.max(2, p.logBox.height - 2);
		while (p.logLines.length < want) {
			const line = new TextRenderable(renderer, { content: "  ·", fg: THEME.textDim });
			p.logLines.push(line);
			p.logBox.add(line);
		}
		while (p.logLines.length > want) {
			const line = p.logLines.pop()!;
			try {
				p.logBox.remove(line);
			} catch {}
		}
	}

	function updatePaneLogs(paneIdx: number) {
		ensureLogLines(paneIdx);
		const p = activePanes[paneIdx];
		const logs = stageStates[paneIdx].logs;
		const display = logs.slice(-p.logLines.length);
		const maxCol = Math.max(20, mainW - 6);
		for (let i = 0; i < p.logLines.length; i++) {
			const item = display[i];
			if (item) {
				p.logLines[i].content = truncateSlug(item, maxCol);
				if (item.includes("ERROR") || item.includes("failed") || item.includes("✗")) {
					p.logLines[i].fg = THEME.red;
				} else if (item.includes("✓") || item.includes("Done")) {
					p.logLines[i].fg = THEME.green;
				} else {
					p.logLines[i].fg = THEME.text;
				}
			} else {
				p.logLines[i].content = "  ·";
				p.logLines[i].fg = THEME.textDim;
			}
		}
	}

	function addStageLog(stageIdx: number, line: string) {
		const trimmed = line.trim();
		if (!trimmed) return;
		const d = new Date();
		const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
		const entry = /^\d{2}:\d{2}:\d{2}\b/.test(trimmed) ? trimmed : `${ts} ${trimmed}`;
		const logs = stageStates[stageIdx].logs;
		logs.push(entry);
		if (logs.length > 500) logs.shift();
		if (selectedStageIdx === stageIdx) {
			updatePaneLogs(stageIdx);
		}
	}

	function triggerPulse(stageIdx: number, kind: PulseKind, durationMs = 650) {
		stageStates[stageIdx].pulse = { kind, startedAt: Date.now(), durationMs };
	}

	function selectStage(idx: number) {
		const next = Math.max(0, Math.min(PIPELINE_STAGES.length - 1, idx));
		selectedStageIdx = next;
		for (let i = 0; i < 4; i++) {
			activePanes[i].pane.visible = next === i;
		}
		reportPane.visible = next === 4;
		if (next < 4) updatePaneLogs(next);
		else renderReportPane();
		updateHeader();
		renderSidebar();
		renderer.requestRender();
	}

	function followGameToStage(slug: string, stageIdx: number) {
		if (followedSlug === slug) {
			selectStage(stageIdx);
		}
	}

	function renderReportPane() {
		const lines: { text: string; fg: string }[] = [];
		const doneCount = succeeded.length + failed.length;
		const remaining = Math.max(0, totalGames - doneCount);
		const elapsed = ((endTime || Date.now()) - startTime) / 1000;
		lines.push({
			text: `Summary: ${succeeded.length} succeeded, ${failed.length} failed, ${remaining} remaining (${totalGames} total)   Elapsed: ${fmtTime(elapsed)}`,
			fg: failed.length > 0 ? THEME.yellow : THEME.green,
		});
		lines.push({ text: `Log file: ${logFile}`, fg: THEME.textDim });
		lines.push({ text: `Timing file: ${timingFile}`, fg: THEME.textDim });
		lines.push({ text: "", fg: THEME.text });

		if (failed.length > 0) {
			lines.push({ text: `Failed (${failed.length}):`, fg: THEME.red });
			for (const f of failed) {
				lines.push({ text: `  ✗ ${f.slug} [${f.stage}]: ${f.error}`, fg: THEME.red });
			}
			lines.push({ text: "", fg: THEME.text });
		}

		if (succeeded.length > 0) {
			lines.push({ text: `Succeeded (${succeeded.length}):`, fg: THEME.green });
			for (const s of succeeded) {
				lines.push({ text: `  ✓ ${s.slug} (${fmtTime(s.elapsedMs / 1000)})`, fg: THEME.green });
			}
		} else if (jobStatus === "running") {
			lines.push({ text: "Waiting for first game to complete pipeline…", fg: THEME.textDim });
		}

		const maxRows = Math.max(4, reportPane.height - 3);
		const visible = lines.slice(0, maxRows);
		while (reportLinePool.length < visible.length) {
			const t = new TextRenderable(renderer, { content: "", fg: THEME.text });
			reportLinePool.push(t);
			reportPane.add(t);
		}
		while (reportLinePool.length > visible.length) {
			const t = reportLinePool.pop()!;
			try {
				reportPane.remove(t);
			} catch {}
		}
		const maxCol = Math.max(20, mainW - 6);
		for (let i = 0; i < visible.length; i++) {
			reportLinePool[i].content = truncateSlug(visible[i].text, maxCol);
			reportLinePool[i].fg = visible[i].fg;
		}
	}

	function updateHeader() {
		const st = stageStates[selectedStageIdx];
		const meta = PIPELINE_STAGES[selectedStageIdx];
		const activePart = st.activeSlug ? ` — ${st.activeSlug}` : "";
		stageText.content = truncateSlug(`${meta.title}${activePart}`, Math.max(20, mainW - 34));
		const doneCount = succeeded.length + failed.length;
		const elapsed = ((endTime || Date.now()) - startTime) / 1000;
		elapsedText.content = `Done: ${doneCount}/${totalGames}   Elapsed: ${fmtTime(elapsed)}`;

		if (followedSlug) {
			followHeader.content = truncateSlug(`Following ${followedSlug} ([f]/Esc)`, sidebarW - 1);
			followHeader.fg = FOLLOW_MAGENTA;
		} else {
			followHeader.content = truncateSlug("[↑↓/kj] Nav  [f] Follow", sidebarW - 1);
			followHeader.fg = THEME.textDim;
		}
	}

	function drawTextOnFb(
		fb: FrameBufferRenderable,
		x: number,
		y: number,
		text: string,
		fg: RGBA,
		attrs: number,
		waveOpts: StageWaveOptions,
		fbW: number,
	) {
		for (let i = 0; i < text.length; i++) {
			const cx = x + i;
			if (cx >= 0 && cx < fbW) {
				const bg = calculateStageCellBg(cx, y, waveOpts);
				fb.frameBuffer.setCell(cx, y, text[i], fg, bg, attrs);
			}
		}
	}

	function renderSidebar() {
		const nowMs = Date.now();
		for (let i = 0; i < PIPELINE_STAGES.length; i++) {
			const st = stageStates[i];
			const meta = PIPELINE_STAGES[i];
			const card = stageCards[i];
			const fbW = Math.max(10, sidebarW - 3);
			const fbH = Math.max(2, card.box.height - 2);
			const isSelected = selectedStageIdx === i;
			const isWorking = i < 4 ? Boolean(st.activeSlug) : jobStatus === "running" && totalGames > 0;
			const followedHere = Boolean(
				followedSlug &&
				((i < 4 && st.activeSlug === followedSlug) ||
					(i === 4 &&
						(succeeded.some((s) => s.slug === followedSlug) ||
							failed.some((f) => f.slug === followedSlug)))),
			);

			if (followedHere) {
				card.box.borderColor = RGBA_FOLLOW_MAGENTA;
			} else if (isSelected) {
				card.box.borderColor = RGBA_THEME.yellow;
			} else if (st.pulse && nowMs - st.pulse.startedAt < st.pulse.durationMs) {
				card.box.borderColor =
					st.pulse.kind === "error"
						? RGBA_THEME.flashRed
						: st.pulse.kind === "success"
							? RGBA_THEME.green
							: RGBA_THEME.flashBlue;
			} else if (isWorking) {
				card.box.borderColor = RGBA_THEME.borderFocus;
			} else {
				card.box.borderColor = RGBA_THEME.borderDim;
			}

			const waveOpts: StageWaveOptions = {
				nowMs,
				working: i < 4 ? isWorking : false,
				selected: isSelected,
				followedHere,
				pulse: st.pulse,
			};

			// Fill background cells
			for (let y = 0; y < fbH; y++) {
				for (let x = 0; x < fbW; x++) {
					const bg = calculateStageCellBg(x, y, waveOpts);
					card.fb.frameBuffer.setCell(x, y, " ", bg, bg);
				}
			}

			// Line 0: Stage icon + name + queue count
			const icon =
				i === 4
					? jobStatus === "completed"
						? "✓"
						: jobStatus === "failed"
							? "✗"
							: "≡"
					: isWorking
						? activeThrobber
						: "·";
			const qBadge = st.queuedCount > 0 ? ` +${st.queuedCount}` : "";
			const titleStr = truncateSlug(`${icon} ${meta.shortTitle}`, Math.max(4, fbW - qBadge.length));
			const titleFg = followedHere
				? RGBA_FOLLOW_MAGENTA
				: isSelected
					? RGBA_THEME.yellow
					: isWorking
						? RGBA_THEME.textBright
						: RGBA_THEME.textDim;
			drawTextOnFb(card.fb, 0, 0, titleStr, titleFg, TextAttributes.BOLD, waveOpts, fbW);
			if (qBadge) {
				drawTextOnFb(
					card.fb,
					Math.max(0, fbW - qBadge.length),
					0,
					qBadge,
					RGBA_THEME.peach,
					TextAttributes.NONE,
					waveOpts,
					fbW,
				);
			}

			// Line 1: Active game slug or idle / report summary
			let line1 = "";
			let line1Fg = RGBA_THEME.textDim;
			if (i === 4) {
				const doneCount = succeeded.length + failed.length;
				line1 = `${succeeded.length}✓ ${failed.length}✗ / ${totalGames} (${doneCount})`;
				line1Fg =
					failed.length > 0 ? RGBA_THEME.red : succeeded.length > 0 ? RGBA_THEME.green : RGBA_THEME.text;
			} else if (followedHere) {
				line1 = `Following ${followedSlug}`;
				line1Fg = RGBA_FOLLOW_MAGENTA;
			} else if (st.activeSlug) {
				line1 = st.activeSlug;
				line1Fg = RGBA_THEME.teal;
			} else {
				line1 = "idle";
			}
			drawTextOnFb(
				card.fb,
				2,
				1,
				truncateSlug(line1, Math.max(4, fbW - 2)),
				line1Fg,
				followedHere || st.activeSlug ? TextAttributes.BOLD : TextAttributes.NONE,
				waveOpts,
				fbW,
			);

			// Line 2: Stats + ETA
			if (fbH >= 3) {
				const line2 = st.statsLine || (st.activeSlug ? st.statusLine : "");
				if (line2) {
					drawTextOnFb(
						card.fb,
						2,
						2,
						truncateSlug(line2, Math.max(4, fbW - 2)),
						RGBA_THEME.text,
						TextAttributes.NONE,
						waveOpts,
						fbW,
					);
				}
			}
		}
	}

	function updatePendingVisibility(stageIdx: number) {
		const p = activePanes[stageIdx];
		const st = stageStates[stageIdx];
		const hasEmbedded = p.stageContainer.getChildren().some((c) => c !== p.pendingTitle && c !== p.pendingSub);
		const show = !hasEmbedded;
		p.pendingTitle.visible = show;
		p.pendingSub.visible = show;
		if (show) {
			if (st.activeSlug) {
				p.pendingTitle.content = `${activeThrobber} ${st.activeSlug}`;
				p.pendingTitle.fg = THEME.yellow;
				p.pendingSub.content = st.statusLine || "Working…";
			} else {
				p.pendingTitle.content = jobStatus === "running" ? "Stage Idle" : "Stage Finished";
				p.pendingTitle.fg = THEME.textDim;
				p.pendingSub.content =
					jobStatus === "running" ? "Waiting for games from previous stage…" : "No active work";
			}
		}
	}

	// Animation & clock ticker (~12 fps for smooth wave + pulse decay)
	const throbber = startThrobber((frame) => {
		if (isDestroyed) return;
		activeThrobber = frame;
	});

	const animTimer = setInterval(() => {
		if (isDestroyed) return;
		for (let i = 0; i < 4; i++) updatePendingVisibility(i);
		updateHeader();
		renderSidebar();
		if (selectedStageIdx === 4) renderReportPane();
		renderer.requestRender();
	}, 85);

	// Launch pipeline workers
	interface QueuedPipelineItem {
		game: GameInfo;
		ctx: PipelineGameContext;
		enqueuedAtMs: number;
	}
	const optimizeQueue = new AsyncQueue<QueuedPipelineItem>();
	const mediaQueue = new AsyncQueue<QueuedPipelineItem>();
	const cardsQueue = new AsyncQueue<QueuedPipelineItem>();

	function syncQueueCounts() {
		stageStates[1].queuedCount = optimizeQueue.size;
		stageStates[2].queuedCount = mediaQueue.size;
		stageStates[3].queuedCount = cardsQueue.size;
	}

	async function writeJobLogFile(summary: string) {
		try {
			await mkdir(path.dirname(logFile), { recursive: true });
			await writeFile(
				logFile,
				JSON.stringify(
					{
						jobId: opts.jobId,
						title: opts.title,
						totalGames,
						startedAt: new Date(startTime).toISOString(),
						endedAt: new Date(endTime || Date.now()).toISOString(),
						summary,
						succeeded,
						failed,
					},
					null,
					2,
				) + "\n",
				"utf8",
			);
		} catch {}
		try {
			await mkdir(path.dirname(timingFile), { recursive: true });
			const report = timingRecorder.buildReport({
				jobId: opts.jobId,
				title: opts.title,
				totalGames,
				endTimeMs: endTime || Date.now(),
			});
			await writeFile(timingFile, JSON.stringify(report, null, 2) + "\n", "utf8");
		} catch {}
	}

	const pendingBranches = new Map<
		string,
		{ remaining: number; firstError?: { stage: PipelineStageId; error: string } }
	>();

	function completeBranch(slug: string, title: string, err?: { stage: PipelineStageId; error: string }) {
		const entry = pendingBranches.get(slug);
		if (!entry) return;
		if (err && !entry.firstError) entry.firstError = err;
		entry.remaining--;
		if (entry.remaining <= 0) {
			pendingBranches.delete(slug);
			if (entry.firstError) {
				failed.push({ slug, title, stage: entry.firstError.stage, error: entry.firstError.error });
				triggerPulse(4, "error", 900);
			} else {
				succeeded.push({
					slug,
					title,
					elapsedMs: Date.now() - (gameStartTimes.get(slug) || Date.now()),
				});
				triggerPulse(4, "success");
				opts.onGameUpdated?.();
			}
			followGameToStage(slug, 4);
		} else if (followedSlug === slug) {
			const nextActive = [1, 2, 3].find((idx) => stageStates[idx].activeSlug === slug);
			if (nextActive !== undefined) followGameToStage(slug, nextActive);
		}
	}

	void (async () => {
		const stage0 = (async () => {
			for (let i = 0; i < opts.games.length; i++) {
				if (isDestroyed) break;
				const g = opts.games[i];
				const slug = g.folder;
				const stage0Start = Date.now();
				gameStartTimes.set(slug, stage0Start);
				stageStates[0].activeSlug = slug;
				stageStates[0].queuedCount = opts.games.length - i - 1;
				stageStates[0].statusLine = "metadata & markers…";
				stageStates[0].statsLine = `[${i + 1}/${totalGames}] metadata…`;
				triggerPulse(0, "arrival");
				addStageLog(0, `==> [${i + 1}/${totalGames}] ${slug}: metadata & tiles`);
				followGameToStage(slug, 0);

				try {
					const pipelineOpts = gameToPipelineOptions(g, opts.updateOptions);
					const ctx = await runPipelineStageMetaAndTiles(pipelineOpts, {
						container: activePanes[0].stageContainer,
						renderer,
						onLog: (line) => addStageLog(0, `[${slug}] ${line}`),
						onStage: (s) => {
							stageStates[0].statusLine = s;
						},
						onTileProgress: (ev) => {
							stageStates[0].statsLine = formatTileSidebarStats(ev);
						},
					});
					const stage0End = Date.now();
					timingRecorder.record({
						slug,
						stage: "meta_tiles",
						status: "ok",
						enqueuedAtAbsMs: startTime,
						startAbsMs: stage0Start,
						endAbsMs: stage0End,
					});
					triggerPulse(0, "success");
					addStageLog(0, `✓ ${slug}: metadata & tiles done`);

					if (ctx.lootAtlasDone) {
						succeeded.push({
							slug,
							title: g.meta?.title || slug,
							elapsedMs: stage0End - stage0Start,
						});
						triggerPulse(4, "success");
						followGameToStage(slug, 4);
						opts.onGameUpdated?.();
					} else {
						pendingBranches.set(slug, { remaining: 3 });
						optimizeQueue.push({ game: g, ctx, enqueuedAtMs: stage0End });
						mediaQueue.push({ game: g, ctx, enqueuedAtMs: stage0End });
						cardsQueue.push({ game: g, ctx, enqueuedAtMs: stage0End });
						syncQueueCounts();
						const needsOpt =
							!ctx.noTiles &&
							((!ctx.noOptimize && ctx.tileJobs.length > 0) ||
								(ctx.redownloadTiles && ctx.tileJobs.length > 0));
						const needsMedia = !ctx.noMedia && ctx.mediaUrls.size > 0;
						const needsCards = !ctx.noCards;
						if (needsOpt) followGameToStage(slug, 1);
						else if (needsMedia) followGameToStage(slug, 2);
						else if (needsCards) followGameToStage(slug, 3);
					}
				} catch (err: any) {
					const msg = err?.message || String(err);
					timingRecorder.record({
						slug,
						stage: "meta_tiles",
						status: "error",
						enqueuedAtAbsMs: startTime,
						startAbsMs: stage0Start,
						endAbsMs: Date.now(),
						error: msg,
					});
					triggerPulse(0, "error", 900);
					addStageLog(0, `[ERROR] ${slug}: ${msg}`);
					failed.push({ slug, title: g.meta?.title || slug, stage: "meta_tiles", error: msg });
					triggerPulse(4, "error", 900);
					followGameToStage(slug, 4);
				}
			}
			stageStates[0].activeSlug = null;
			stageStates[0].queuedCount = 0;
			stageStates[0].statusLine = "done";
			stageStates[0].statsLine = "";
			optimizeQueue.close();
			mediaQueue.close();
			cardsQueue.close();
		})();

		const stage1 = (async () => {
			while (!isDestroyed) {
				const item = await optimizeQueue.next();
				syncQueueCounts();
				if (!item) break;
				const { game, ctx, enqueuedAtMs } = item;
				const slug = game.folder;
				const stage1Start = Date.now();
				const needsWork =
					!ctx.noTiles &&
					((!ctx.noOptimize && ctx.tileJobs.length > 0) || (ctx.redownloadTiles && ctx.tileJobs.length > 0));

				let branchErr: { stage: PipelineStageId; error: string } | undefined;
				if (needsWork) {
					stageStates[1].activeSlug = slug;
					stageStates[1].statusLine = "optimizing tiles…";
					stageStates[1].statsLine = "starting…";
					triggerPulse(1, "arrival");
					addStageLog(1, `==> ${slug}: optimizing tiles`);
					followGameToStage(slug, 1);

					try {
						await runPipelineStageOptimize(ctx, {
							container: activePanes[1].stageContainer,
							renderer,
							onLog: (line) => addStageLog(1, `[${slug}] ${line}`),
							onStage: (s) => {
								stageStates[1].statusLine = s;
							},
							onOptimizeProgress: (ev) => {
								stageStates[1].statsLine = formatOptimizeSidebarStats(ev);
							},
						});
						timingRecorder.record({
							slug,
							stage: "optimize",
							status: "ok",
							enqueuedAtAbsMs: enqueuedAtMs,
							startAbsMs: stage1Start,
							endAbsMs: Date.now(),
						});
						triggerPulse(1, "success");
						addStageLog(1, `✓ ${slug}: optimization done`);
					} catch (err: any) {
						const msg = err?.message || String(err);
						timingRecorder.record({
							slug,
							stage: "optimize",
							status: "error",
							enqueuedAtAbsMs: enqueuedAtMs,
							startAbsMs: stage1Start,
							endAbsMs: Date.now(),
							error: msg,
						});
						triggerPulse(1, "error", 900);
						addStageLog(1, `[ERROR] ${slug}: ${msg}`);
						branchErr = { stage: "optimize", error: msg };
					}
					stageStates[1].activeSlug = null;
					stageStates[1].statusLine = "idle";
					stageStates[1].statsLine = "";
				} else {
					timingRecorder.record({
						slug,
						stage: "optimize",
						status: "skipped",
						enqueuedAtAbsMs: enqueuedAtMs,
						startAbsMs: stage1Start,
						endAbsMs: stage1Start,
					});
				}
				completeBranch(slug, ctx.title, branchErr);
			}
			stageStates[1].activeSlug = null;
			stageStates[1].statusLine = "done";
			stageStates[1].statsLine = "";
		})();

		const stage2 = (async () => {
			while (!isDestroyed) {
				const item = await mediaQueue.next();
				syncQueueCounts();
				if (!item) break;
				const { game, ctx, enqueuedAtMs } = item;
				const slug = game.folder;
				const stage2Start = Date.now();

				let branchErr: { stage: PipelineStageId; error: string } | undefined;
				if (!ctx.noMedia && ctx.mediaUrls.size > 0) {
					stageStates[2].activeSlug = slug;
					stageStates[2].statusLine = "downloading media…";
					stageStates[2].statsLine = `0/${ctx.mediaUrls.size}`;
					triggerPulse(2, "arrival");
					addStageLog(2, `==> ${slug}: media (${ctx.mediaUrls.size} files)`);
					followGameToStage(slug, 2);

					try {
						await runPipelineStageMedia(ctx, {
							container: activePanes[2].stageContainer,
							renderer,
							onLog: (line) => addStageLog(2, `[${slug}] ${line}`),
							onStage: (s) => {
								stageStates[2].statusLine = s;
							},
							onMediaProgress: (ev) => {
								stageStates[2].statsLine = formatMediaSidebarStats(ev);
							},
						});
						timingRecorder.record({
							slug,
							stage: "media",
							status: "ok",
							enqueuedAtAbsMs: enqueuedAtMs,
							startAbsMs: stage2Start,
							endAbsMs: Date.now(),
						});
						triggerPulse(2, "success");
						addStageLog(2, `✓ ${slug}: media done`);
					} catch (err: any) {
						const msg = err?.message || String(err);
						timingRecorder.record({
							slug,
							stage: "media",
							status: "error",
							enqueuedAtAbsMs: enqueuedAtMs,
							startAbsMs: stage2Start,
							endAbsMs: Date.now(),
							error: msg,
						});
						triggerPulse(2, "error", 900);
						addStageLog(2, `[ERROR] ${slug}: ${msg}`);
						branchErr = { stage: "media", error: msg };
					}
					stageStates[2].activeSlug = null;
					stageStates[2].statusLine = "idle";
					stageStates[2].statsLine = "";
				} else {
					timingRecorder.record({
						slug,
						stage: "media",
						status: "skipped",
						enqueuedAtAbsMs: enqueuedAtMs,
						startAbsMs: stage2Start,
						endAbsMs: stage2Start,
					});
				}
				completeBranch(slug, ctx.title, branchErr);
			}
			stageStates[2].activeSlug = null;
			stageStates[2].statusLine = "done";
			stageStates[2].statsLine = "";
		})();

		const stage3 = (async () => {
			while (!isDestroyed) {
				const item = await cardsQueue.next();
				syncQueueCounts();
				if (!item) break;
				const { game, ctx, enqueuedAtMs } = item;
				const slug = game.folder;
				const stage3Start = Date.now();

				let branchErr: { stage: PipelineStageId; error: string } | undefined;
				if (!ctx.noCards) {
					stageStates[3].activeSlug = slug;
					stageStates[3].statusLine = "rendering preview card…";
					stageStates[3].statsLine = "rendering…";
					triggerPulse(3, "arrival");
					addStageLog(3, `==> ${slug}: generating preview card`);
					followGameToStage(slug, 3);

					try {
						await runPipelineStageCards(ctx, {
							onLog: (line) => addStageLog(3, `[${slug}] ${line}`),
							onStage: (s) => {
								stageStates[3].statusLine = s;
							},
						});
						timingRecorder.record({
							slug,
							stage: "cards",
							status: "ok",
							enqueuedAtAbsMs: enqueuedAtMs,
							startAbsMs: stage3Start,
							endAbsMs: Date.now(),
						});
						triggerPulse(3, "success");
						addStageLog(3, `✓ ${slug}: card generated`);
					} catch (err: any) {
						const msg = err?.message || String(err);
						timingRecorder.record({
							slug,
							stage: "cards",
							status: "error",
							enqueuedAtAbsMs: enqueuedAtMs,
							startAbsMs: stage3Start,
							endAbsMs: Date.now(),
							error: msg,
						});
						triggerPulse(3, "error", 900);
						addStageLog(3, `[ERROR] ${slug}: ${msg}`);
						branchErr = { stage: "cards", error: msg };
					}
					stageStates[3].activeSlug = null;
					stageStates[3].statusLine = "idle";
					stageStates[3].statsLine = "";
				} else {
					timingRecorder.record({
						slug,
						stage: "cards",
						status: "skipped",
						enqueuedAtAbsMs: enqueuedAtMs,
						startAbsMs: stage3Start,
						endAbsMs: stage3Start,
					});
				}
				completeBranch(slug, ctx.title, branchErr);
			}
			stageStates[3].activeSlug = null;
			stageStates[3].statusLine = "done";
			stageStates[3].statsLine = "";
		})();

		await Promise.all([stage0, stage1, stage2, stage3]);

		if (!isDestroyed) {
			endTime = Date.now();
			const ok = failed.length === 0;
			jobStatus = ok ? "completed" : "failed";
			throbber.stop();
			statusBadge.content = ok ? " [✓ COMPLETED]" : " [✗ FAILED]";
			statusBadge.fg = ok ? THEME.green : THEME.red;
			const summary = `Completed: ${succeeded.length} ok, ${failed.length} failed (${totalGames} total)`;
			await writeJobLogFile(summary);
			renderReportPane();
			renderSidebar();
			updateHeader();
			opts.onCompleted?.(ok, summary);
			renderer.requestRender();
		}
	})();

	function resize(w: number, h: number) {
		boxW = w;
		boxH = h;
		sidebarW = calcSidebarW();
		mainW = Math.max(30, boxW - 4 - sidebarW);
		rootBox.width = boxW;
		rootBox.height = boxH;
		sidebarBox.width = sidebarW;
		sidebarBox.height = boxH;
		const cardH = calcCardH();
		for (const c of stageCards) {
			c.box.width = sidebarW - 1;
			c.box.height = cardH;
			c.fb.width = Math.max(10, sidebarW - 3);
			c.fb.height = Math.max(2, cardH - 2);
		}
		mainBox.width = mainW;
		mainBox.height = boxH;
		headerBox.width = mainW;
		titleRow.width = Math.max(20, mainW - 4);
		subRow.width = Math.max(20, mainW - 4);
		for (let i = 0; i < 4; i++) {
			const p = activePanes[i];
			p.pane.width = mainW;
			p.pane.height = Math.max(10, boxH - 4);
			p.stageContainer.width = mainW;
			p.stageContainer.height = stageBoxH();
			p.logBox.width = mainW;
			p.logBox.height = logBoxH();
			updatePaneLogs(i);
		}
		reportPane.width = mainW;
		reportPane.height = Math.max(10, boxH - 4);
		renderReportPane();
		renderSidebar();
		updateHeader();
		renderer.requestRender();
	}

	function handleKey(key: KeyEvent): boolean {
		const noMod = !key.ctrl && !key.option && !key.meta && !(key as any).alt;
		if (noMod && (key.name === "up" || key.name === "k")) {
			followedSlug = null;
			selectStage((selectedStageIdx - 1 + PIPELINE_STAGES.length) % PIPELINE_STAGES.length);
			return true;
		}
		if (noMod && (key.name === "down" || key.name === "j")) {
			followedSlug = null;
			selectStage((selectedStageIdx + 1) % PIPELINE_STAGES.length);
			return true;
		}
		if (noMod && key.name === "f") {
			if (followedSlug) {
				followedSlug = null;
			} else {
				const active = stageStates[selectedStageIdx]?.activeSlug;
				if (active) {
					followedSlug = active;
				}
			}
			updateHeader();
			renderSidebar();
			renderer.requestRender();
			return true;
		}
		if (key.name === "escape" || key.raw === "\x1b") {
			if (followedSlug) {
				followedSlug = null;
				updateHeader();
				renderSidebar();
				renderer.requestRender();
				return true;
			}
			return false;
		}
		return false;
	}

	function destroy() {
		if (isDestroyed) return;
		isDestroyed = true;
		throbber.stop();
		clearInterval(animTimer);
	}

	renderSidebar();
	updateHeader();

	return {
		root: rootBox,
		isPipeline: true,
		get status() {
			return jobStatus;
		},
		slug: opts.slug,
		title: opts.title,
		logFile,
		handleKey,
		resize,
		destroy,
	};
}