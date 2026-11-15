// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Pure, deterministic analytics over per-marker find timestamps (`foundAt`, epoch seconds).
// All date-bucketing functions take `nowSec` (epoch seconds) and `tzOffsetMin` (minutes east of UTC,
// i.e. `-new Date().getTimezoneOffset()`) so tests are completely deterministic across timezones.

export const BATCH_THRESHOLD = 8;
export const SESSION_GAP_SEC = 45 * 60;
export const PACE_WINDOW_DAYS = 14;
export const PACE_MIN_FINDS = 20;
export const PACE_MIN_DAYS = 3;
export const TIMELINE_DAYS = 30;

export interface StampedFind {
	id: number;
	at: number;
}

export interface FoundSession {
	start: number;
	end: number;
	count: number;
	ids: number[];
}

export interface DailyCount {
	dayKey: string;
	dayUtcMs: number;
	count: number;
}

export interface PaceEstimate {
	findsPerDay: number;
	activeDays: number;
	finds: number;
	estimatedDays: number;
}

export type RecentFeedItem = { kind: "single"; id: number; at: number } | { kind: "batch"; at: number; ids: number[] };

const DAY_MS = 86_400_000;

function readStamp(foundAt: Map<number, number> | Record<string, number> | undefined, id: number): number | undefined {
	if (!foundAt) return undefined;
	const v = foundAt instanceof Map ? foundAt.get(id) : foundAt[String(id)];
	return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Extracts valid stamped finds for `found` ids, sorted ascending by `(at, id)`. */
export function extractStampedFinds(
	found: Iterable<number>,
	foundAt: Map<number, number> | Record<string, number> | undefined,
): StampedFind[] {
	if (!foundAt) return [];
	const out: StampedFind[] = [];
	for (const id of found) {
		const at = readStamp(foundAt, id);
		if (at !== undefined) out.push({ id, at });
	}
	out.sort((a, b) => a.at - b.at || a.id - b.id);
	return out;
}

/** Returns timestamps shared by at least `minSize` finds (bulk-marking batches). */
export function detectBatchTimestamps(entries: StampedFind[], minSize = BATCH_THRESHOLD): Set<number> {
	const counts = new Map<number, number>();
	for (const e of entries) counts.set(e.at, (counts.get(e.at) ?? 0) + 1);
	const batches = new Set<number>();
	for (const [at, n] of counts) {
		if (n >= minSize) batches.add(at);
	}
	return batches;
}

/** Groups non-batch finds into play sessions separated by gaps of at least `gapSec` seconds. */
export function computeSessions(
	entries: StampedFind[],
	batchTimestamps: Set<number>,
	gapSec = SESSION_GAP_SEC,
): FoundSession[] {
	const filtered = entries.filter((e) => !batchTimestamps.has(e.at)).sort((a, b) => a.at - b.at || a.id - b.id);
	const sessions: FoundSession[] = [];
	let cur: FoundSession | null = null;
	for (const e of filtered) {
		if (!cur || e.at - cur.end >= gapSec) {
			cur = { start: e.at, end: e.at, count: 1, ids: [e.id] };
			sessions.push(cur);
		} else {
			cur.end = e.at;
			cur.count++;
			cur.ids.push(e.id);
		}
	}
	return sessions;
}

/** Returns the most recent session and whether it is still active (`nowSec - end < gapSec`). */
export function latestSession(
	sessions: FoundSession[],
	nowSec: number,
	gapSec = SESSION_GAP_SEC,
): { session: FoundSession; active: boolean } | null {
	if (!sessions.length) return null;
	const session = sessions[sessions.length - 1]!;
	return { session, active: nowSec - session.end < gapSec };
}

/** Returns the local calendar day index (days since Unix epoch) for `sec` at `tzOffsetMin` east of UTC. */
export function localDayIndex(sec: number, tzOffsetMin: number): number {
	return Math.floor((sec * 1000 + tzOffsetMin * 60_000) / DAY_MS);
}

/** Formats a local day index as `YYYY-MM-DD`. */
export function formatDayKey(dayIdx: number): string {
	const d = new Date(dayIdx * DAY_MS);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Returns `YYYY-MM-DD` for `sec` in the given timezone offset (minutes east of UTC). */
export function localDayKey(sec: number, tzOffsetMin: number): string {
	return formatDayKey(localDayIndex(sec, tzOffsetMin));
}

/** Counts non-batch finds per local day over the trailing `days` calendar days (oldest to newest). */
export function dailyCounts(
	entries: StampedFind[],
	batchTimestamps: Set<number>,
	nowSec: number,
	tzOffsetMin: number,
	days = TIMELINE_DAYS,
): DailyCount[] {
	const endIdx = localDayIndex(nowSec, tzOffsetMin);
	const startIdx = endIdx - days + 1;
	const byDay = new Map<number, number>();
	for (const e of entries) {
		if (batchTimestamps.has(e.at)) continue;
		const idx = localDayIndex(e.at, tzOffsetMin);
		if (idx >= startIdx && idx <= endIdx) {
			byDay.set(idx, (byDay.get(idx) ?? 0) + 1);
		}
	}
	const out: DailyCount[] = [];
	for (let idx = startIdx; idx <= endIdx; idx++) {
		out.push({
			dayKey: formatDayKey(idx),
			dayUtcMs: idx * DAY_MS,
			count: byDay.get(idx) ?? 0,
		});
	}
	return out;
}

/**
 * Estimates remaining play days from trailing 14-day non-batch pace.
 * Returns null when there are fewer than 20 non-batch finds, fewer than 3 distinct active days, or nothing remaining.
 */
export function computePace(
	entries: StampedFind[],
	batchTimestamps: Set<number>,
	remaining: number,
	nowSec: number,
	tzOffsetMin: number,
): PaceEstimate | null {
	if (remaining <= 0) return null;
	const endIdx = localDayIndex(nowSec, tzOffsetMin);
	const startIdx = endIdx - PACE_WINDOW_DAYS + 1;
	let finds = 0;
	const activeDaySet = new Set<number>();
	for (const e of entries) {
		if (batchTimestamps.has(e.at)) continue;
		const idx = localDayIndex(e.at, tzOffsetMin);
		if (idx >= startIdx && idx <= endIdx) {
			finds++;
			activeDaySet.add(idx);
		}
	}
	const activeDays = activeDaySet.size;
	if (finds < PACE_MIN_FINDS || activeDays < PACE_MIN_DAYS) return null;
	const findsPerDay = finds / activeDays;
	return {
		findsPerDay,
		activeDays,
		finds,
		estimatedDays: Math.max(1, Math.ceil(remaining / findsPerDay)),
	};
}

/** Builds the newest-first feed of up to `limit` items, collapsing each batch into a single entry. */
export function recentFeed(entries: StampedFind[], batchTimestamps: Set<number>, limit = 10): RecentFeedItem[] {
	const sorted = [...entries].sort((a, b) => b.at - a.at || b.id - a.id);
	const batches = new Map<number, number[]>();
	for (const e of sorted) {
		if (batchTimestamps.has(e.at)) {
			let list = batches.get(e.at);
			if (!list) {
				list = [];
				batches.set(e.at, list);
			}
			list.push(e.id);
		}
	}
	const seenBatches = new Set<number>();
	const out: RecentFeedItem[] = [];
	for (const e of sorted) {
		if (out.length >= limit) break;
		if (batchTimestamps.has(e.at)) {
			if (seenBatches.has(e.at)) continue;
			seenBatches.add(e.at);
			out.push({ kind: "batch", at: e.at, ids: batches.get(e.at)! });
		} else {
			out.push({ kind: "single", id: e.id, at: e.at });
		}
	}
	return out;
}