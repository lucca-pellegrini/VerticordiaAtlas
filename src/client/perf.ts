// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Debug-only performance instrumentation. Off by default; enabled with ?perf=1 or localStorage "perf" = "1".
// Nothing leaves the browser: results go to console.debug and to perfReport() (console.table).

/** true when the query string or the stored value asks for instrumentation */
export function parsePerfFlag(search: string, stored: string | null): boolean {
	const q = new URLSearchParams(search).get("perf");
	return q !== null ? q === "1" : stored === "1";
}

function readFlag(): boolean {
	try {
		return typeof location !== "undefined" && parsePerfFlag(location.search, localStorage.getItem("perf"));
	} catch {
		return false; // storage blocked
	}
}

let on = readFlag();

type Row = { count: number; total: number; max: number };
const rows = new Map<string, Row>();

function record(name: string, start: number, end = performance.now()): void {
	const ms = end - start;
	const r = rows.get(name) ?? { count: 0, total: 0, max: 0 };
	r.count++;
	r.total += ms;
	if (ms > r.max) r.max = ms;
	rows.set(name, r);
	try {
		performance.measure(name, { start, end }); // shows in the DevTools Performance timeline
	} catch {}
	console.debug(`[perf] ${name} ${ms.toFixed(1)} ms`);
}

/** runs fn; when enabled, times it. Disabled cost is one boolean check, and the result passes through untouched. */
export function perf<T>(name: string, fn: () => T): T {
	if (!on) return fn();
	const t0 = performance.now();
	try {
		return fn();
	} finally {
		record(name, t0);
	}
}

/** like perf() for async functions: the time covers the whole promise */
export function perfAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
	if (!on) return fn();
	const t0 = performance.now();
	return fn().finally(() => record(name, t0));
}

/** prints the table of everything measured so far (count, total, mean, max in ms) */
export function perfReport(): void {
	console.table(
		Object.fromEntries(
			[...rows].map(([k, r]) => [
				k,
				{
					count: r.count,
					totalMs: +r.total.toFixed(1),
					meanMs: +(r.total / r.count).toFixed(1),
					maxMs: +r.max.toFixed(1),
				},
			]),
		),
	);
}

/** test hook: forces the flag and clears the rows */
export function setPerfEnabled(v: boolean): void {
	on = v;
	rows.clear();
}

export function perfRows(): ReadonlyMap<string, Row> {
	return rows;
}

if (on && typeof window !== "undefined") {
	(window as any).perfReport = perfReport;
	try {
		// long tasks (>50 ms of main-thread work) are rows of their own: count, total and max
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) record("longtask", e.startTime, e.startTime + e.duration);
		}).observe({ type: "longtask", buffered: true });
	} catch {} // unsupported (Safari, Firefox)
	console.debug("[perf] on: call perfReport() in the console for the table");
}