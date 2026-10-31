export interface RateLimiter {
	allow(bucket: string, key: string, maxHits: number, windowMs: number): boolean;
	checkOnly(bucket: string, key: string, maxHits: number, windowMs: number): boolean;
	record(bucket: string, key: string, windowMs: number): void;
	reset(bucket: string, key: string): void;
}

export function createRateLimiter(nowFn: () => number = () => Date.now()): RateLimiter {
	const windows = new Map<string, { start: number; count: number }>();

	function prune(t: number, maxWindowMs: number) {
		if (windows.size <= 20_000) return;
		for (const [k, v] of windows) {
			if (t - v.start > maxWindowMs) windows.delete(k);
		}
		if (windows.size > 20_000) windows.clear();
	}

	return {
		allow(bucket: string, key: string, maxHits: number, windowMs: number): boolean {
			const t = nowFn();
			prune(t, windowMs);
			const fullKey = `${bucket}:${key}`;
			let w = windows.get(fullKey);
			if (!w || t - w.start > windowMs) {
				w = { start: t, count: 0 };
				windows.set(fullKey, w);
			}
			w.count++;
			return w.count <= maxHits;
		},

		checkOnly(bucket: string, key: string, maxHits: number, windowMs: number): boolean {
			const t = nowFn();
			const fullKey = `${bucket}:${key}`;
			const w = windows.get(fullKey);
			if (!w || t - w.start > windowMs) return true;
			return w.count < maxHits;
		},

		record(bucket: string, key: string, windowMs: number): void {
			const t = nowFn();
			prune(t, windowMs);
			const fullKey = `${bucket}:${key}`;
			let w = windows.get(fullKey);
			if (!w || t - w.start > windowMs) {
				w = { start: t, count: 0 };
				windows.set(fullKey, w);
			}
			w.count++;
		},

		reset(bucket: string, key: string): void {
			windows.delete(`${bucket}:${key}`);
		},
	};
}