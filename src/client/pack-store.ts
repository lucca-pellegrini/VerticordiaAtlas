// pack-store.ts: where a map kept offline lives. One map is one pack: its files (data, markers, icons, every tile) are
// laid end to end in a few large blobs ("segments", in IndexedDB), with a small index that says where each URL's bytes
// are. Nothing here goes through the Cache API: with tens of thousands of entries, its lookups are what made pages crawl.
// Shared by the page (to write and inspect packs) and by the service worker (to read a file out of a pack).

export interface PackStat {
	count: number; // URLs the pack answers
	bytes: number; // bytes of file data stored (a file that answers many URLs is stored once)
	stamp: number;
}

export interface PackWriter {
	add(url: string, contentType: string, bytes: Uint8Array): Promise<void>;
	alias(url: string, sourceUrl: string): Promise<void>;
	commit(): Promise<PackStat>; // only now does the pack exist
	abort(): Promise<void>;
}

export interface PackStore {
	begin(game: string, map: string): Promise<PackWriter>; // replaces any pack of that map once committed
	stat(game: string, map: string): Promise<PackStat | null>;
	maps(game: string): Promise<string[]>; // maps of a game that have a pack
	read(game: string, map: string, url: string): Promise<{ blob: Blob; type: string } | null>;
	remove(game: string, map: string): Promise<void>;
	clear(): Promise<void>;
}

export const SEGMENT_BYTES = 8 * 1024 * 1024;
const DB_NAME = "va-offline-packs";

type Entry = [seg: number, offset: number, length: number, type: number];
interface PackIndex {
	types: string[];
	entries: Record<string, Entry>;
}

/* ---------- in memory (tests, and browsers that block IndexedDB) ---------- */

export function createMemoryPackStore(): PackStore {
	const packs = new Map<string, { stat: PackStat; files: Map<string, { blob: Blob; type: string }> }>();
	const key = (g: string, m: string) => `${g}/${m}`;
	return {
		async begin(game, map) {
			const files = new Map<string, { blob: Blob; type: string }>();
			let bytes = 0;
			return {
				async add(url, contentType, data) {
					bytes += data.byteLength;
					files.set(url, { blob: new Blob([data as BlobPart]), type: contentType });
				},
				async alias(url, sourceUrl) {
					const f = files.get(sourceUrl);
					if (f) files.set(url, f);
				},
				async commit() {
					const stat = { count: files.size, bytes, stamp: Date.now() };
					packs.set(key(game, map), { stat, files });
					return stat;
				},
				async abort() {
					files.clear();
				},
			};
		},
		async stat(game, map) {
			return packs.get(key(game, map))?.stat ?? null;
		},
		async maps(game) {
			return [...packs.keys()].filter((k) => k.startsWith(`${game}/`)).map((k) => k.slice(game.length + 1));
		},
		async read(game, map, url) {
			return packs.get(key(game, map))?.files.get(url) ?? null;
		},
		async remove(game, map) {
			packs.delete(key(game, map));
		},
		async clear() {
			packs.clear();
		},
	};
}

/* ---------- IndexedDB ---------- */

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
	return (dbPromise ??= new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const s of ["packs", "index", "segs"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
		};
		req.onsuccess = () => {
			req.result.onversionchange = () => {
				req.result.close();
				dbPromise = null;
			};
			resolve(req.result);
		};
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error("IndexedDB blocked"));
	}).catch((e) => {
		dbPromise = null;
		throw e;
	}));
}

async function run<T>(
	stores: string[],
	mode: IDBTransactionMode,
	fn: (tx: IDBTransaction) => IDBRequest | void,
): Promise<T> {
	const db = await openDb();
	return new Promise<T>((resolve, reject) => {
		const tx = db.transaction(stores, mode);
		const req = fn(tx);
		tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

const rangeOf = (k: string) => IDBKeyRange.bound(`${k}#`, `${k}#\uffff`);

export function createIdbPackStore(): PackStore {
	// the index of a pack is large: read once, and kept while this page or worker lives
	const indexes = new Map<string, Promise<PackIndex | null>>();
	const segments = new Map<string, Promise<Blob | undefined>>();
	const forget = (k: string) => {
		indexes.delete(k);
		for (const s of [...segments.keys()]) if (s.startsWith(`${k}#`)) segments.delete(s);
	};

	const store: PackStore = {
		async begin(game, map) {
			const k = `${game}/${map}`;
			let seg = 0;
			let parts: BlobPart[] = [];
			let size = 0;
			let bytes = 0;
			const types: string[] = [];
			const entries: Record<string, Entry> = {};
			const flush = async () => {
				if (!size) return;
				const blob = new Blob(parts);
				const n = seg++;
				parts = [];
				size = 0;
				await run(["segs"], "readwrite", (tx) => tx.objectStore("segs").put(blob, `${k}#${n}`));
			};
			// what a half-written earlier pack left behind goes first
			await run(["segs"], "readwrite", (tx) => tx.objectStore("segs").delete(rangeOf(k)));
			return {
				async add(url, contentType, data) {
					if (size >= SEGMENT_BYTES) await flush();
					let t = types.indexOf(contentType);
					if (t < 0) t = types.push(contentType) - 1;
					entries[url] = [seg, size, data.byteLength, t];
					parts.push(data as BlobPart);
					size += data.byteLength;
					bytes += data.byteLength;
				},
				async alias(url, sourceUrl) {
					const e = entries[sourceUrl];
					if (e) entries[url] = e;
				},
				async commit() {
					await flush();
					const stat: PackStat = { count: Object.keys(entries).length, bytes, stamp: Date.now() };
					await run(["packs", "index", "segs"], "readwrite", (tx) => {
						tx.objectStore("segs").delete(IDBKeyRange.bound(`${k}#${seg}`, `${k}#\uffff`)); // stale tail
						tx.objectStore("index").put({ types, entries } satisfies PackIndex, k);
						tx.objectStore("packs").put(stat, k);
					});
					forget(k);
					return stat;
				},
				async abort() {
					parts = [];
					await store.remove(game, map);
				},
			};
		},
		async stat(game, map) {
			try {
				return (
					(await run<PackStat | undefined>(["packs"], "readonly", (tx) =>
						tx.objectStore("packs").get(`${game}/${map}`),
					)) ?? null
				);
			} catch {
				return null;
			}
		},
		async maps(game) {
			try {
				const keys = await run<string[]>(["packs"], "readonly", (tx) =>
					tx.objectStore("packs").getAllKeys(IDBKeyRange.bound(`${game}/`, `${game}/\uffff`)),
				);
				return keys.map((k) => String(k).slice(game.length + 1));
			} catch {
				return [];
			}
		},
		async read(game, map, url) {
			const k = `${game}/${map}`;
			let idx = indexes.get(k);
			if (!idx) {
				idx = run<PackIndex | undefined>(["index"], "readonly", (tx) => tx.objectStore("index").get(k)).then(
					(v) => v ?? null,
					() => null,
				);
				indexes.set(k, idx);
			}
			const e = (await idx)?.entries[url];
			if (!e) return null;
			const sk = `${k}#${e[0]}`;
			let seg = segments.get(sk);
			if (!seg) {
				seg = run<Blob | undefined>(["segs"], "readonly", (tx) => tx.objectStore("segs").get(sk));
				segments.set(sk, seg);
				// a handful of segments are kept as blob handles (cheap: the data stays on disk)
				if (segments.size > 64) segments.delete(segments.keys().next().value!);
			}
			const blob = await seg;
			if (!blob) return null;
			return { blob: blob.slice(e[1], e[1] + e[2]), type: (await idx)!.types[e[3]] };
		},
		async remove(game, map) {
			const k = `${game}/${map}`;
			forget(k);
			await run(["packs", "index", "segs"], "readwrite", (tx) => {
				tx.objectStore("packs").delete(k);
				tx.objectStore("index").delete(k);
				tx.objectStore("segs").delete(rangeOf(k));
			});
		},
		async clear() {
			indexes.clear();
			segments.clear();
			await run(["packs", "index", "segs"], "readwrite", (tx) => {
				for (const s of ["packs", "index", "segs"]) tx.objectStore(s).clear();
			});
		},
	};
	return store;
}

/* ---------- the service worker's side ---------- */

let workerStore: PackStore | null = null;
let kept: { at: number; maps: Map<string, string[]> } = { at: 0, maps: new Map() };
const KEPT_TTL = 3000;

// forget what was read (the page changed a pack)
export function resetPackLookups(): void {
	workerStore = null;
	kept = { at: 0, maps: new Map() };
}

// the file a pack holds for this path (/maps/<game>/...), or null when no pack of that game has it
export async function findInPacks(pathname: string): Promise<{ blob: Blob; type: string } | null> {
	const m = /^\/maps\/([^/]+)\//.exec(pathname);
	if (!m) return null;
	const game = decodeURIComponent(m[1]);
	try {
		workerStore ??= createIdbPackStore();
		const now = Date.now();
		if (now - kept.at > KEPT_TTL) kept = { at: now, maps: new Map() };
		let maps = kept.maps.get(game);
		if (!maps) kept.maps.set(game, (maps = await workerStore.maps(game)));
		for (const map of maps) {
			const hit = await workerStore.read(game, map, pathname);
			if (hit) return hit;
		}
	} catch {
		/* no storage: the network is asked */
	}
	return null;
}