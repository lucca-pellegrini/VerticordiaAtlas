// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

export interface AdaptiveRateOptions {
	enabled?: boolean;
	minConcurrency?: number;
	maxConcurrency?: number;
	initialConcurrency?: number;
	minDelayMs?: number;
	maxDelayMs?: number;
	initialDelayMs?: number;
}

export interface AdaptiveSnapshot {
	concurrency: number;
	delayMs: number;
	avgLatencyMs: number;
	p90LatencyMs: number;
	baselineLatencyMs: number;
	recentErrors: number;
	state: "ramping" | "holding" | "throttling" | "backed-off";
}

/**
 * Adaptive AIMD-style concurrency and cooldown rate controller for tile downloads.
 * Dynamically maximizes requests-per-second against CDN edges while avoiding
 * queue congestion, latency spikes, and 429 / 5xx rate-limit errors.
 */
export class AdaptiveRateController {
	concurrency: number;
	delayMs: number;

	readonly minConcurrency: number;
	readonly maxConcurrency: number;
	readonly minDelayMs: number;
	readonly maxDelayMs: number;
	readonly enabled: boolean;

	private baselineLatencyMs = Infinity;
	private recentLatencies: number[] = [];
	private recentErrors = 0;
	private recentSuccesses = 0;
	private lastAdjustTime = Date.now();
	private lastBackoffTime = 0;
	private currentState: "ramping" | "holding" | "throttling" | "backed-off" = "ramping";

	constructor(opts: AdaptiveRateOptions = {}) {
		this.enabled = opts.enabled !== false;
		this.minConcurrency = Math.max(1, opts.minConcurrency ?? 4);
		this.maxConcurrency = Math.max(this.minConcurrency, opts.maxConcurrency ?? 64);
		this.minDelayMs = Math.max(0, opts.minDelayMs ?? 0);
		this.maxDelayMs = Math.max(this.minDelayMs, opts.maxDelayMs ?? 250);

		const initC = opts.initialConcurrency ?? 16;
		this.concurrency = Math.min(this.maxConcurrency, Math.max(this.minConcurrency, initC));

		const initD = opts.initialDelayMs ?? 0;
		this.delayMs = Math.min(this.maxDelayMs, Math.max(this.minDelayMs, initD));
	}

	/**
	 * Record the HTTP status and round-trip duration of a tile network request.
	 * Returns true if concurrency or delayMs was modified as a result.
	 */
	recordResult(status: number, latencyMs?: number): boolean {
		if (!this.enabled) return false;

		// 200 (image found) and 404 (perimeter void) are normal expected responses from CDN
		const isUnexpectedError = status !== 200 && status !== 404 && status !== 403 && status !== 410;

		if (isUnexpectedError) {
			this.recentErrors++;
			const now = Date.now();
			// Fast backoff on unexpected error (e.g. 429 Too Many Requests, 5xx server error, or connection drop)
			if (now - this.lastBackoffTime > 800) {
				this.lastBackoffTime = now;
				this.currentState = "backed-off";
				const prevC = this.concurrency;
				const prevD = this.delayMs;

				this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency * 0.7));
				this.delayMs = Math.min(this.maxDelayMs, Math.max(25, this.delayMs * 2 + 20));
				this.recentLatencies = [];
				return this.concurrency !== prevC || this.delayMs !== prevD;
			}
			return false;
		}

		this.recentSuccesses++;
		if (typeof latencyMs === "number" && latencyMs > 0) {
			this.recentLatencies.push(latencyMs);
			if (this.recentLatencies.length > 50) this.recentLatencies.shift();
			if (latencyMs < this.baselineLatencyMs) {
				this.baselineLatencyMs = latencyMs;
			}
		}

		const now = Date.now();
		// Re-evaluate window every 200ms or every 12 requests
		if (
			(now - this.lastAdjustTime >= 200 && this.recentLatencies.length >= 5) ||
			this.recentLatencies.length >= 15
		) {
			return this.adjust();
		}

		return false;
	}

	private adjust(): boolean {
		this.lastAdjustTime = Date.now();
		if (this.recentLatencies.length === 0) return false;

		const prevC = this.concurrency;
		const prevD = this.delayMs;

		const sorted = [...this.recentLatencies].sort((a, b) => a - b);
		const p50 = sorted[Math.floor(sorted.length * 0.5)];
		const p90 = sorted[Math.floor(sorted.length * 0.9)];
		const avg = this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length;

		// If recently backed off, allow latency and queue to settle before ramping again
		if (Date.now() - this.lastBackoffTime < 1500) {
			return false;
		}

		const base = Math.max(30, this.baselineLatencyMs);

		// Congestion detection:
		// If tail latency (p90) is elevated > 2.2x baseline, or average > 1.8x baseline, or median > 450ms
		const isLatencyClimbing = p90 > base * 2.2 || avg > base * 1.8 || p50 > 450;
		const isSeverelyCongested = avg > base * 2.5 || p90 > Math.max(500, base * 3.0);

		if (isSeverelyCongested) {
			// Throttle down: ease back concurrency and insert cooldown
			this.currentState = "throttling";
			this.concurrency = Math.max(this.minConcurrency, this.concurrency - 2);
			this.delayMs = Math.min(this.maxDelayMs, this.delayMs + 10);
		} else if (isLatencyClimbing) {
			// Hold steady: do not increase rate while latency is elevated
			this.currentState = "holding";
		} else {
			// Low, stable latency with no recent errors: ramp up towards maximum throughput
			this.currentState = "ramping";

			// 1. First, drain cooldown delay to minimum
			if (this.delayMs > 0) {
				this.delayMs = Math.max(this.minDelayMs, this.delayMs - 20);
			} else if (this.concurrency < this.maxConcurrency) {
				// 2. Then, gradually ramp up workers: +2 when below 32, +1 when above 32 for smooth convergence
				const step = this.concurrency < 32 ? 2 : 1;
				this.concurrency = Math.min(this.maxConcurrency, this.concurrency + step);
			}
		}

		// Slowly decay baseline so permanent route / CDN changes are tracked
		this.baselineLatencyMs = Math.min(this.baselineLatencyMs * 1.02, p50);

		return this.concurrency !== prevC || this.delayMs !== prevD;
	}

	getSnapshot(): AdaptiveSnapshot {
		const sorted = [...this.recentLatencies].sort((a, b) => a - b);
		const p90 = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;
		const avg = this.recentLatencies.length
			? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
			: 0;

		return {
			concurrency: this.concurrency,
			delayMs: this.delayMs,
			avgLatencyMs: Math.round(avg),
			p90LatencyMs: Math.round(p90),
			baselineLatencyMs: Number.isFinite(this.baselineLatencyMs) ? Math.round(this.baselineLatencyMs) : 0,
			recentErrors: this.recentErrors,
			state: this.currentState,
		};
	}
}