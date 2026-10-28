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
	probeIntervalMs?: number;
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
	readonly rampIntervalMs: number;
	readonly probeIntervalMs: number;
	readonly enabled: boolean;

	private baselineLatencyMs = Infinity;
	private recentLatencies: number[] = [];
	private recentErrors = 0;
	private recentSuccesses = 0;
	private consecutiveSuccesses = 0;
	private lastAdjustTime = Date.now();
	private lastBackoffTime = 0;
	private lastRampTime = 0;
	private lastErrorTime = 0;
	private currentState: "ramping" | "holding" | "throttling" | "backed-off" = "ramping";

	constructor(opts: AdaptiveRateOptions = {}) {
		this.enabled = opts.enabled !== false;
		this.minConcurrency = Math.max(1, opts.minConcurrency ?? 4);
		this.maxConcurrency = Math.max(this.minConcurrency, opts.maxConcurrency ?? 64);
		this.minDelayMs = Math.max(0, opts.minDelayMs ?? 0);
		this.maxDelayMs = Math.max(this.minDelayMs, opts.maxDelayMs ?? 250);

		const isTest = typeof process !== "undefined" && process.argv?.some((a) => a.includes("test"));
		this.rampIntervalMs = opts.rampIntervalMs ?? (isTest ? 20 : 2000);
		this.probeIntervalMs = opts.probeIntervalMs ?? (isTest ? 50 : 2500);

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

		// 200 (image found) is normal expected response from CDN
		const isUnexpectedError = status !== 200 && status !== 403;

		if (isUnexpectedError) {
			this.recentErrors++;
			this.consecutiveSuccesses = 0;
			const now = Date.now();
			this.lastErrorTime = now;
			// Fast backoff on unexpected error (e.g. 429 Too Many Requests, 5xx server error, or connection drop)
			if (now - this.lastBackoffTime > 800) {
				this.lastBackoffTime = now;
				this.lastRampTime = now;
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
		this.consecutiveSuccesses++;
		if (typeof latencyMs === "number" && latencyMs > 0) {
			this.recentLatencies.push(latencyMs);
			if (this.recentLatencies.length > 50) this.recentLatencies.shift();
			if (latencyMs < this.baselineLatencyMs) {
				this.baselineLatencyMs = latencyMs;
			}
		}

		const now = Date.now();
		// Re-evaluate window every 200ms or when enough samples have accumulated
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

		// Congestion detection:
		// Queue bloat / congestion adds significant absolute delay over baseline RTT.
		// Normal internet latency (50-150ms) with minor jitter must never be falsely flagged as congested.
		const isSeverelyCongested = (avg > base * 2.5 + 80 && avg > 200) || p90 > Math.max(450, base * 3.2);

		const isLatencyClimbing = p90 > base * 2.0 + 40 || avg > base * 1.8 + 30 || p50 > 350;

		// Active probing when stuck at minimum:
		// If stuck at min concurrency or high delay for >= probeIntervalMs with ZERO errors
		// and steady 200 OKs, risk an upward probe rather than starving throughput indefinitely.
		const isStuckAtMin =
			(this.concurrency <= this.minConcurrency + 1 || this.delayMs >= Math.floor(this.maxDelayMs * 0.5)) &&
			(this.currentState === "holding" ||
				this.currentState === "throttling" ||
				this.currentState === "backed-off");

		const canRiskProbe =
			isStuckAtMin &&
			now - this.lastErrorTime >= this.probeIntervalMs &&
			this.consecutiveSuccesses >= 4 &&
			this.recentErrors === 0 &&
			p50 < 800;

		if (isSeverelyCongested && !canRiskProbe) {
			// Throttle down: ease back concurrency and insert cooldown
			this.currentState = "throttling";
			this.concurrency = Math.max(this.minConcurrency, this.concurrency - 2);
			this.delayMs = Math.min(this.maxDelayMs, this.delayMs + 10);
		} else if (isLatencyClimbing && !canRiskProbe) {
			// Hold steady: do not increase rate while latency is climbing
			this.currentState = "holding";
		} else {
			// Ramping or active probe: pace upward rate increases so each step takes a couple seconds
			this.currentState = "ramping";

			if (canRiskProbe) {
				// Adapt baseline towards current median so subsequent requests are evaluated fairly
				this.baselineLatencyMs = Math.min(p50, Math.max(this.baselineLatencyMs, p50 * 0.8));
			}

			// Pacing: require at least rampIntervalMs (default 2s) between each upward step
			if (now - this.lastRampTime >= this.rampIntervalMs) {
				this.lastRampTime = now;

				// 1. First, drain cooldown delay in measured chunks
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
			state: this.currentState,
		};
	}
}