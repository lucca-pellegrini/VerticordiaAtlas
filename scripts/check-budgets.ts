#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Checks client bundle and largest-map payload sizes against scripts/budgets.json.
// Run after `bun run build`. Exit 1 on a hard budget failure; soft budgets only warn.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export type Metric = "raw" | "gzip" | "brotli";
export interface Budget {
	id: string;
	file: string;
	metric: Metric;
	/** Size when the threshold was set; shown in messages. */
	measured: number;
	hard?: number;
	soft?: number;
	/** Aspirational goal (roadmap); reported while exceeded, never fails. */
	target?: number;
	/** Skip silently-with-a-note if the file is absent (e.g. map data not checked out). */
	optional?: boolean;
	note?: string;
}
export type Status = "pass" | "warn" | "fail" | "skip";
export interface Result {
	status: Status;
	message: string;
}

const BUDGETS_PATH = "scripts/budgets.json";
const n = (v: number) => `${v.toLocaleString("en-US")} B`;

export function evaluate(b: Budget, actual: number | null): Result {
	const what = `${b.id} (${b.file}, ${b.metric})`;
	if (actual === null) {
		return b.optional
			? { status: "skip", message: `SKIP ${what}: file not found.` }
			: { status: "fail", message: `FAIL ${what}: file not found. Run \`bun run build\` first.` };
	}
	const base = `${what}: ${n(actual)}, baseline ${n(b.measured)}`;
	const raise = `If this is intentional, raise it in ${BUDGETS_PATH} (update "measured" too) and explain why in the commit.`;
	if (b.hard !== undefined && actual > b.hard) {
		return {
			status: "fail",
			message: `FAIL ${base}, over hard budget ${n(b.hard)}. Shrink the payload. ${raise}`,
		};
	}
	if (b.soft !== undefined && actual > b.soft) {
		return {
			status: "warn",
			message: `WARN ${base}, over soft budget ${n(b.soft)}. Not a failure: a scraper update may have legitimately grown it. ${raise}`,
		};
	}
	const tgt = b.target !== undefined && actual > b.target ? ` Roadmap target ${n(b.target)} not yet met.` : "";
	return { status: "pass", message: `ok   ${base}.${tgt}` };
}

export function measure(path: string, metric: Metric): number | null {
	if (!existsSync(path)) return null;
	const buf = readFileSync(path);
	if (metric === "raw") return buf.length;
	if (metric === "gzip") return gzipSync(buf, { level: 9 }).length;
	return brotliCompressSync(buf, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
	}).length;
}

export function runBudgets(budgets: Budget[], root: string): { results: Result[]; exitCode: number } {
	const results = budgets.map((b) => evaluate(b, measure(join(root, b.file), b.metric)));
	return { results, exitCode: results.some((r) => r.status === "fail") ? 1 : 0 };
}

if (import.meta.main) {
	const root = join(dirname(Bun.fileURLToPath(import.meta.url)), "..");
	const budgets: Budget[] = JSON.parse(readFileSync(join(root, BUDGETS_PATH), "utf8"));
	const { results, exitCode } = runBudgets(budgets, root);
	for (const r of results) console.log(r.message);
	const c = (s: Status) => results.filter((r) => r.status === s).length;
	console.log(`\n${c("pass")} ok, ${c("warn")} warning(s), ${c("fail")} failure(s), ${c("skip")} skipped.`);
	process.exit(exitCode);
}