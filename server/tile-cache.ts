// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// tile-cache.ts: the disk cache of made tiles (cache/tiles/<game>/<map>/<tileset>/<z>/...). The files are the truth about
// what is cached; recency and hit counts are kept in memory only and are allowed to be lost on a restart (a tile not seen
// since then is judged by its file date). When the folder grows past maxBytes, the oldest tiles are deleted until it is
// down to targetBytes. A tile of a popular game counts as newer than it is, so rarely opened games go first.

import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
export const DEFAULT_TARGET_BYTES = 1024 ** 3;
const POPULARITY_BONUS = 7 * 24 * 3600 * 1000; // the most popular game's tiles count as a week newer
const HIT_BONUS = 10 * 60 * 1000; // and each doubling of a tile's hits as ten minutes newer

// "2GB", "512 MB", "1.5g", "123456" -> bytes; null when it is not a size
export function parseSize(text: string | undefined | null): number | null {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(String(text ?? ""));
	if (!m) return null;
	const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()]!;
	return Math.round(Number(m[1]) * unit);
}

export interface TileCacheOptions {
	root: string;
	maxBytes?: number;
	targetBytes?: number;
	popularity?: () => Map<string, number>; // game -> how often its maps were opened
	now?: () => number;
}

interface Entry {
	rel: string;
	size: number;
	score: number;
}

export class TileCache {
	readonly root: string;
	readonly maxBytes: number;
	readonly targetBytes: number;
	private popularity: () => Map<string, number>;
	private now: () => number;
	private seen = new Map<string, { at: number; hits: number }>();
	private bytes = 0;
	private ready: Promise<void> | null = null;
	private evicting: Promise<{ removed: number; freed: number }> | null = null;

	constructor(o: TileCacheOptions) {
		this.root = o.root;
		this.maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
		this.targetBytes = Math.min(o.targetBytes ?? DEFAULT_TARGET_BYTES, this.maxBytes);
		this.popularity = o.popularity ?? (() => new Map());
		this.now = o.now ?? Date.now;
	}

	file(rel: string): string {
		return path.join(this.root, rel);
	}

	// every file of the cache. Hard links to one file (the single-colour tiles) are counted once, and never evicted.
	private async walk(): Promise<{ files: Entry[]; total: number }> {
		const pop = this.popularity();
		const top = Math.log1p(Math.max(0, ...pop.values()));
		const inodes = new Set<string>();
		const files: Entry[] = [];
		let total = 0;
		const visit = async (dir: string, rel: string): Promise<void> => {
			let items;
			try {
				items = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const d of items) {
				const r = rel ? `${rel}/${d.name}` : d.name;
				if (d.isDirectory()) {
					await visit(path.join(dir, d.name), r);
					continue;
				}
				if (!d.isFile()) continue;
				let st;
				try {
					st = await stat(path.join(dir, d.name));
				} catch {
					continue;
				}
				const id = `${st.dev}:${st.ino}`;
				if (!inodes.has(id)) {
					inodes.add(id);
					total += st.size;
				}
				if (st.nlink > 1 || d.name.startsWith("solid-") || d.name.endsWith(".tmp")) continue;
				const game = r.split("/")[0];
				const seen = this.seen.get(r);
				const popularity = top > 0 ? Math.log1p(pop.get(game) ?? 0) / top : 0;
				files.push({
					rel: r,
					size: st.size,
					score:
						(seen?.at ?? st.mtimeMs) +
						popularity * POPULARITY_BONUS +
						Math.log2(1 + (seen?.hits ?? 0)) * HIT_BONUS,
				});
			}
		};
		await visit(this.root, "");
		return { files, total };
	}

	// the size of what is already on disk; called once, before the first tile is added
	init(): Promise<void> {
		return (this.ready ??= this.walk().then((w) => {
			this.bytes = w.total;
		}));
	}

	get size(): number {
		return this.bytes;
	}

	// a tile was served from the cache
	touch(rel: string): void {
		const s = this.seen.get(rel);
		if (s) {
			s.at = this.now();
			s.hits++;
		} else this.seen.set(rel, { at: this.now(), hits: 1 });
		if (this.seen.size > 500_000) this.seen.clear();
	}

	// a tile was written to the cache
	async added(rel: string, size: number): Promise<void> {
		await this.init();
		this.touch(rel);
		this.bytes += size;
		if (this.bytes > this.maxBytes) void this.evict().catch((e) => console.error("tile cache:", e));
	}

	// delete the least valuable tiles until the cache is down to targetBytes; one pass at a time
	evict(): Promise<{ removed: number; freed: number }> {
		return (this.evicting ??= (async () => {
			try {
				const { files, total } = await this.walk();
				let left = total,
					removed = 0;
				files.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel));
				for (const f of files) {
					if (left <= this.targetBytes) break;
					try {
						await unlink(this.file(f.rel));
						left -= f.size;
						removed++;
						this.seen.delete(f.rel);
					} catch {
						/* gone already */
					}
				}
				this.bytes = left;
				if (removed)
					console.log(`tile cache: evicted ${removed} tiles, ${((total - left) / 1e6) | 0} MB freed`);
				return { removed, freed: total - left };
			} finally {
				this.evicting = null;
			}
		})());
	}
}