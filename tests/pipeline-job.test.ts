// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";

import {
	AsyncQueue,
	calculateStageCellBg,
	formatMediaSidebarStats,
	formatOptimizeSidebarStats,
	formatTileSidebarStats,
	PIPELINE_STAGES,
	PipelineTimingRecorder,
	truncateSlug,
} from "../scripts/tui/pipeline-job.js";
import { RGBA_THEME } from "../scripts/tui/theme.js";

describe("Pipeline job helpers", () => {
	test.concurrent("PIPELINE_STAGES has 5 stages ending in report", () => {
		expect(PIPELINE_STAGES.length).toBe(5);
		expect(PIPELINE_STAGES[0].id).toBe("meta_tiles");
		expect(PIPELINE_STAGES[1].id).toBe("optimize");
		expect(PIPELINE_STAGES[2].id).toBe("media");
		expect(PIPELINE_STAGES[3].id).toBe("cards");
		expect(PIPELINE_STAGES[4].id).toBe("report");
	});

	test.concurrent("truncateSlug truncates long slugs with ellipsis", () => {
		expect(truncateSlug("botw", 10)).toBe("botw");
		expect(truncateSlug("elden-ring-shadow-of-the-erdtree", 10)).toBe("elden-rin…");
		expect(truncateSlug("abc", 1)).toBe("…");
		expect(truncateSlug("abc", 0)).toBe("");
	});

	test.concurrent("formatTileSidebarStats shows tileset index, mode, and ETA", () => {
		expect(
			formatTileSidebarStats({
				tilesetIndex: 1,
				totalTilesets: 2,
				done: 3742,
				total: 4096,
				mode: "exact",
				etaSeconds: 90,
			}),
		).toBe("1/2 3742/4096 ~01:30");

		expect(
			formatTileSidebarStats({
				tilesetIndex: 2,
				totalTilesets: 3,
				done: 500,
				total: 1000,
				mode: "estimated",
				etaSeconds: 45,
			}),
		).toBe("2/3 500/1000 est ~00:45");

		expect(
			formatTileSidebarStats({
				tilesetIndex: 1,
				totalTilesets: 1,
				done: 120,
				total: 0,
				mode: "unknown",
				etaSeconds: -1,
			}),
		).toBe("1/1 120/?");
	});

	test.concurrent("formatMediaSidebarStats and formatOptimizeSidebarStats format progress", () => {
		expect(formatMediaSidebarStats({ done: 15, total: 100, failed: 0, etaSeconds: 90 })).toBe(
			"15/100 (ETA ~01:30)",
		);
		expect(formatMediaSidebarStats({ done: 10, total: 10, failed: 1, etaSeconds: -1 })).toBe("10/10");
		expect(
			formatOptimizeSidebarStats({
				tilesetIndex: 1,
				totalTilesets: 2,
				phase: "solid",
				tilesDone: 420,
				solid: 420,
				overview: 0,
				freedBytes: 1024 * 1024,
			}),
		).toBe("1/2 solid (420) -1.0 MB");
	});

	test.concurrent("AsyncQueue delivers items FIFO and returns null after close", async () => {
		const q = new AsyncQueue<string>();
		q.push("a");
		q.push("b");
		expect(q.size).toBe(2);
		expect(await q.next()).toBe("a");
		expect(await q.next()).toBe("b");
		expect(q.size).toBe(0);

		const pending = q.next();
		q.push("c");
		expect(await pending).toBe("c");

		const waiting = q.next();
		q.close();
		expect(await waiting).toBeNull();
		expect(await q.next()).toBeNull();
	});

	test.concurrent("calculateStageCellBg renders flat idle, rightward wave, and pulses", () => {
		const idle = calculateStageCellBg(0, 0, {
			nowMs: 1000,
			working: false,
			selected: false,
			followedHere: false,
			pulse: null,
		});
		expect(idle.r).toBeCloseTo(RGBA_THEME.surface.r, 2);
		expect(idle.g).toBeCloseTo(RGBA_THEME.surface.g, 2);
		expect(idle.b).toBeCloseTo(RGBA_THEME.surface.b, 2);

		// Working wave varies across x and time
		const w0 = calculateStageCellBg(0, 0, {
			nowMs: 0,
			working: true,
			selected: false,
			followedHere: false,
			pulse: null,
		});
		const w5 = calculateStageCellBg(5, 0, {
			nowMs: 0,
			working: true,
			selected: false,
			followedHere: false,
			pulse: null,
		});
		expect(w0.r !== w5.r || w0.g !== w5.g || w0.b !== w5.b).toBe(true);

		// Error pulse boosts red channel
		const err = calculateStageCellBg(0, 0, {
			nowMs: 1050,
			working: true,
			selected: false,
			followedHere: false,
			pulse: { kind: "error", startedAt: 1000, durationMs: 600 },
		});
		expect(err.r).toBeGreaterThan(err.g);
		expect(err.r).toBeGreaterThan(err.b);

		// Arrival pulse boosts blue channel
		const arr = calculateStageCellBg(0, 0, {
			nowMs: 1050,
			working: true,
			selected: false,
			followedHere: false,
			pulse: { kind: "arrival", startedAt: 1000, durationMs: 600 },
		});
		expect(arr.b).toBeGreaterThan(arr.r);
	});

	test.concurrent("PipelineTimingRecorder builds stage summaries and Chrome traceEvents", () => {
		const rec = new PipelineTimingRecorder(1000);
		rec.record({
			slug: "botw",
			stage: "meta_tiles",
			status: "ok",
			enqueuedAtAbsMs: 1000,
			startAbsMs: 1000,
			endAbsMs: 1500,
		});
		rec.record({
			slug: "botw",
			stage: "optimize",
			status: "ok",
			enqueuedAtAbsMs: 1500,
			startAbsMs: 1600,
			endAbsMs: 1900,
		});
		rec.record({
			slug: "totk",
			stage: "meta_tiles",
			status: "error",
			enqueuedAtAbsMs: 1000,
			startAbsMs: 1500,
			endAbsMs: 2000,
			error: "429",
		});

		const report = rec.buildReport({
			jobId: "job1",
			title: "All games",
			totalGames: 2,
			endTimeMs: 2000,
		});

		expect(report.totalDurationMs).toBe(1000);
		expect(report.spans.length).toBe(3);

		const metaSummary = report.stagesSummary.find((s) => s.stage === "meta_tiles")!;
		expect(metaSummary.busyMs).toBe(1000);
		expect(metaSummary.utilizationPct).toBe(100);
		expect(metaSummary.okCount).toBe(1);
		expect(metaSummary.errorCount).toBe(1);

		const optSummary = report.stagesSummary.find((s) => s.stage === "optimize")!;
		expect(optSummary.busyMs).toBe(300);
		expect(optSummary.totalQueueWaitMs).toBe(100);
		expect(optSummary.maxGameSlug).toBe("botw");

		// 4 thread_name metadata events + 3 X events
		expect(report.traceEvents.length).toBe(7);
		expect(report.traceEvents.filter((e) => e.ph === "X").length).toBe(3);
	});
});