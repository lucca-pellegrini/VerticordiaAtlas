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
	rampIntervalMs?: number;
	settleIntervalMs?: number;
}

export interface AdaptiveSnapshot {
	concurrency: number;
	delayMs: number;
	avgLatencyMs: number;
	p90LatencyMs: number;
	baselineLatencyMs: number;
	recentErrors: number;
	currentThroughput: number;
	state: "ramping" | "holding" | "throttling" | "backed-off";
}

/**
 * Adaptive AIMD-style concurrency and cooldown rate controller for tile downloads.
 * Dynamically maximizes requests-per-second against CDN edges while avoiding
 * queue congestion, latency spikes, and 429 / 5xx rate-limit errors.
 *
 * Rules:
 * 1. Only back off / throttle down if requests return rate-limit / server errors (429, 5xx),
 *    OR if latency increases by a lot (> 600ms / 3.5x baseline) AND throughput does NOT improve.
 * 2. Never bounce or throttle down during the settling period after a rate change.
 * 3. Hold steady without reducing concurrency when latency is moderately elevated.
 */
export class AdaptiveRateController {
	concurrency: number;
	delayMs: number;

	readonly minConcurrency: number;
	readonly maxConcurrency: number;
	readonly minDelayMs: number;
	readonly maxDelayMs: number;
	readonly rampIntervalMs: number;
	readonly settleIntervalMs: number;
	readonly enabled: boolean;

	private baselineLatencyMs = Infinity;
	private recentLatencies: number[] = [];
	private completionTimes: number[] = [];
	private recentErrors = 0;
	private recentSuccesses = 0;
	private lastAdjustTime = Date.now();
	private lastBackoffTime = 0;
	private lastRateChangeTime = Date.now();
	private prevStepThroughput = 0;
	private currentThroughput = 0;
	private currentState: "ramping" | "holding" | "throttling" | "backed-off" = "ramping";

	constructor(opts: AdaptiveRateOptions = {}) {
		this.enabled = opts.enabled !== false;
		this.minConcurrency = Math.max(1, opts.minConcurrency ?? 4);
		this.maxConcurrency = Math.max(this.minConcurrency, opts.maxConcurrency ?? 64);
		this.minDelayMs = Math.max(0, opts.minDelayMs ?? 0);
		this.maxDelayMs = Math.max(this.minDelayMs, opts.maxDelayMs ?? 250);

		const isTest = typeof process !== "undefined" && process.argv?.some((a) => a.includes("test"));
		this.rampIntervalMs = opts.rampIntervalMs ?? (isTest ? 20 : 2000);
		this.settleIntervalMs = opts.settleIntervalMs ?? (isTest ? 20 : 2000);

		const initC = opts.initialConcurrency ?? 16;
		this.concurrency = Math.min(this.maxConcurrency, Math.max(this.minConcurrency, initC));

		const initD = opts.initialDelayMs ?? 0;
		this.delayMs = Math.min(this.maxDelayMs, Math.max(this.minDelayMs, initD));
	}

	/**
	 * Record the HTTP status and round-trip duration of a tile network request.
	 * Perimeter voids (404, 410, or isVoid=true) do not count towards rates and never throttle workers.
	 * Returns true if concurrency or delayMs was modified as a result.
	 */
	recordResult(status: number, latencyMs?: number, isVoid = false): boolean {
		if (!this.enabled) return false;

		// Voids do not count for rates and must never throttle workers down
		if (isVoid || status === 404 || status === 410) {
			return false;
		}

		const now = Date.now();

		// Record completion timestamp to calculate real throughput (req/s)
		this.completionTimes.push(now);
		while (this.completionTimes.length > 0 && now - this.completionTimes[0] > 3000) {
			this.completionTimes.shift();
		}
		if (this.completionTimes.length >= 2) {
			const dt = (now - this.completionTimes[0]) / 1000;
			this.currentThroughput = dt > 0.1 ? this.completionTimes.length / dt : 0;
		}

		// 200 (image found) is normal expected response from CDN
		const isUnexpectedError = status !== 200 && status !== 403;

		if (isUnexpectedError) {
			this.recentErrors++;
			// Fast backoff on unexpected error (e.g. 429 Too Many Requests, 5xx server error, or connection drop)
			if (now - this.lastBackoffTime > 800) {
				this.lastBackoffTime = now;
				this.lastRateChangeTime = now;
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

		// Re-evaluate window periodically
		if (
			(now - this.lastAdjustTime >= 150 && this.recentLatencies.length >= 4) ||
			this.recentLatencies.length >= 15
		) {
			return this.adjust();
		}

		return false;
	}

	private adjust(): boolean {
		const now = Date.now();
		this.lastAdjustTime = now;
		if (this.recentLatencies.length === 0) return false;

		const prevC = this.concurrency;
		const prevD = this.delayMs;

		const sorted = [...this.recentLatencies].sort((a, b) => a - b);
		const p50 = sorted[Math.floor(sorted.length * 0.5)];
		const p90 = sorted[Math.floor(sorted.length * 0.9)];
		const avg = this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length;

		// If recently backed off from a 429/5xx, allow network to settle
		if (now - this.lastBackoffTime < 1500) {
			return false;
		}

		const base = Math.max(40, this.baselineLatencyMs);

		// Rule 1: Latency increased by A LOT
		// True severe queue bloat occurs when latency balloons into multiple hundreds of ms (> 600ms average or > 1000ms tail)
		const latencyIncreasedByALot =
			(avg > Math.max(500, base * 3.5) && p90 > Math.max(800, base * 4.0)) || p50 > 750;

		// Moderate latency elevation (e.g. 200-450ms): pause rate increases but DO NOT throttle down
		const isLatencyClimbing = p90 > base * 2.2 + 60 || avg > base * 1.8 + 40 || p50 > 300;

		// Has throughput / speed improved compared to the previous step?
		const speedGotBetter = this.currentThroughput > this.prevStepThroughput * 1.08;

		// Allow newly adjusted rate time to settle before measuring whether speed improved
		const hasHadTimeToSettle = now - this.lastRateChangeTime >= this.settleIntervalMs;

		// WE ONLY GO BACK DOWN IF:
		// 1) Latency increased by A LOT
		// 2) AND speed did NOT get better
		// 3) AND it has had time to settle
		if (latencyIncreasedByALot && !speedGotBetter && hasHadTimeToSettle) {
			this.currentState = "throttling";
			this.concurrency = Math.max(this.minConcurrency, this.concurrency - 2);
			this.delayMs = Math.min(this.maxDelayMs, this.delayMs + 10);
			this.lastRateChangeTime = now;
			this.prevStepThroughput = this.currentThroughput;
		} else if (isLatencyClimbing && !speedGotBetter) {
			// Hold steady: do not increase rate while latency is elevated, but DO NOT drop down!
			this.currentState = "holding";
		} else {
			// Healthy responses or speed is improving: ramp up!
			this.currentState = "ramping";

			// Only take an upward step every rampIntervalMs (takes a couple seconds between each step)
			if (now - this.lastRateChangeTime >= this.rampIntervalMs) {
				this.lastRateChangeTime = now;
				this.prevStepThroughput = this.currentThroughput;

				// 1. First, drain delay cooldown
				if (this.delayMs > 0) {
					this.delayMs = Math.max(this.minDelayMs, this.delayMs - 50);
				} else if (this.concurrency < this.maxConcurrency) {
					// 2. Then, gradually ramp up workers with steady step sizes
					const step = this.concurrency < 16 ? 2 : this.concurrency < 48 ? 4 : 2;
					this.concurrency = Math.min(this.maxConcurrency, this.concurrency + step);
				}
			}
		}

		// Slowly adapt baseline towards recent median so network route shifts are tracked
		if (p50 > this.baselineLatencyMs) {
			this.baselineLatencyMs = this.baselineLatencyMs * 0.95 + p50 * 0.05;
		}

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
			currentThroughput: Math.round(this.currentThroughput * 10) / 10,
			state: this.currentState,
		};
	}
}