// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// log-lock.ts: Millisecond timestamping, ANSI/control sanitization, and locked complete-line buffering for TUI logs.

const TIMESTAMP_PREFIX_RE = /^\d{2}:\d{2}:\d{2}(?:\.\d{3})?\b/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CTRL_RE = /[\x00-\x1f\x7f]/g;

/** Formats a timestamp in local time as `HH:MM:SS.mmm`. */
export function formatLogTimestamp(ms = Date.now()): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const mss = String(d.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${mss}`;
}

/** Strips ANSI escapes and control characters, splitting multi-line or CR-overwritten input into clean lines. */
export function sanitizeLogLines(raw: string): string[] {
	const cleaned = raw.replace(ANSI_RE, "");
	const out: string[] = [];
	for (const segment of cleaned.split("\n")) {
		const parts = segment.split("\r");
		let chosen = "";
		for (let i = parts.length - 1; i >= 0; i--) {
			const candidate = parts[i].replace(CTRL_RE, "").trim();
			if (candidate) {
				chosen = candidate;
				break;
			}
		}
		if (chosen) out.push(chosen);
	}
	return out;
}

export interface LockedLogWriterOptions {
	logs: string[];
	maxLines?: number;
	onFlush: (logs: readonly string[]) => void;
}

export interface LockedLogWriter {
	push(raw: string, timestampMs?: number): void;
	readonly isLocked: boolean;
}

/**
 * Serializes log mutations and display flushes so concurrent or re-entrant callers
 * never interleave partial lines, characters, or colors during a TUI render pass.
 */
export function createLockedLogWriter(opts: LockedLogWriterOptions): LockedLogWriter {
	const { logs, maxLines = 1000, onFlush } = opts;
	const pending: string[] = [];
	let locked = false;

	function drain(): void {
		if (locked) return;
		locked = true;
		try {
			while (pending.length > 0) {
				const batch = pending.splice(0, pending.length);
				for (const entry of batch) {
					logs.push(entry);
					if (logs.length > maxLines) logs.shift();
				}
				onFlush(logs);
			}
		} finally {
			locked = false;
		}
	}

	return {
		get isLocked() {
			return locked;
		},
		push(raw: string, timestampMs?: number): void {
			const lines = sanitizeLogLines(raw);
			if (lines.length === 0) return;
			const ts = formatLogTimestamp(timestampMs);
			for (const line of lines) {
				const entry = TIMESTAMP_PREFIX_RE.test(line) ? line : `${ts} ${line}`;
				pending.push(entry);
			}
			drain();
		},
	};
}

/** Buffers streaming text chunks and emits only complete newline-delimited lines. */
export function createLineStreamBuffer(onLine: (line: string) => void): {
	pushChunk(chunk: string): void;
	flush(): void;
} {
	let buffer = "";
	return {
		pushChunk(chunk: string): void {
			buffer += chunk;
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				for (const line of sanitizeLogLines(part)) {
					onLine(line);
				}
			}
		},
		flush(): void {
			if (!buffer) return;
			const rem = buffer;
			buffer = "";
			for (const line of sanitizeLogLines(rem)) {
				onLine(line);
			}
		},
	};
}