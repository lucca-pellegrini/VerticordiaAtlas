// offline.ts: device-local "Keep offline" manager.
// Stores a compact per-map manifest in IndexedDB (offline-map-viewer -> meta store, key "offline:<game>:<map>")
// and downloads map tiles + metadata into the Cache API ("va-offline-tiles") driven from the page.

import type { GameMeta, MapMeta } from "../shared/types.ts";

export const OFFLINE_CACHE_NAME = "va-offline-tiles";
export const OFFLINE_KEY_PREFIX = "offline:";

export interface TileZoomRange {
	z: number;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

export interface OfflineSampleHash {
	url: string;
	size: number;
	hash: string;
}

export interface OfflineTileSpec {
	dataUrls: string[];
	template: string;
	ranges: TileZoomRange[];
	missingUrls?: string[];
}

export interface OfflineManifest extends OfflineTileSpec {
	k: string;
	game: string;
	map: string;
	gameTitle: string;
	mapTitle: string;
	enabled: boolean;
	expectedCount: number;
	totalBytes: number;
	sampleHashes: OfflineSampleHash[];
	lastVerified: number;
	updatedAt: number;
}

export interface OfflineStorageAdapter {
	get(k: string): Promise<OfflineManifest | null>;
	put(manifest: OfflineManifest): Promise<void>;
	remove(k: string): Promise<void>;
	list(): Promise<OfflineManifest[]>;
}

export interface OfflineCacheEntry {
	size: number;
	bytes(): Promise<Uint8Array>;
}

export interface OfflineCacheAdapter {
	keys(): Promise<string[]>;
	match(url: string): Promise<OfflineCacheEntry | null>;
	put(url: string, bytes: Uint8Array, contentType: string): Promise<void>;
	delete(url: string): Promise<boolean>;
	clear(): Promise<void>;
}

export interface OfflineManagerDeps {
	storage?: OfflineStorageAdapter;
	cache?: OfflineCacheAdapter;
	fetchUrl?: (
		url: string,
		signal?: AbortSignal,
	) => Promise<{ status: number; bytes: Uint8Array; contentType: string }>;
	fetchMeta?: (gameSlug: string) => Promise<GameMeta>;
	rootUrl?: string;
	concurrency?: number;
	now?: () => number;
}

export const offlineKey = (game: string, map: string): string => `${OFFLINE_KEY_PREFIX}${game}:${map}`;

// 32-bit FNV-1a over raw bytes
export function fnvBytes(bytes: Uint8Array): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

const lon2x = (lon: number, n: number): number => ((lon + 180) / 360) * n;
const lat2y = (lat: number, n: number): number => {
	const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
	return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};

export function computeZoomRanges(
	bounds: [number, number, number, number] | number[],
	minZoom: number,
	maxZoom: number,
): TileZoomRange[] {
	const [w, s, e, nn] = bounds;
	const out: TileZoomRange[] = [];
	const zStart = Math.max(0, Math.floor(minZoom));
	const zEnd = Math.max(zStart, Math.floor(maxZoom));
	for (let z = zStart; z <= zEnd; z++) {
		const n = 2 ** z;
		const x0 = Math.max(0, Math.floor(lon2x(w, n)));
		const x1 = Math.min(n - 1, Math.max(Math.floor(lon2x(w, n)), Math.ceil(lon2x(e, n)) - 1));
		const y0 = Math.max(0, Math.floor(lat2y(nn, n)));
		const y1 = Math.min(n - 1, Math.max(Math.floor(lat2y(nn, n)), Math.ceil(lat2y(s, n)) - 1));
		out.push({ z, x0, x1, y0, y1 });
	}
	return out;
}

export function buildOfflineTileSpec(gameSlug: string, meta: GameMeta, mapMeta: MapMeta): OfflineTileSpec {
	const base = `maps/${gameSlug}`;
	const dataSet = new Set<string>([`${base}/meta.json`, `${base}/${mapMeta.data}`]);
	if (meta.markers) {
		if (meta.markers.json) dataSet.add(`${base}/${meta.markers.json}`);
		if (meta.markers.png) dataSet.add(`${base}/${meta.markers.png}`);
		if (meta.markers.json2x) dataSet.add(`${base}/${meta.markers.json2x}`);
		if (meta.markers.png2x) dataSet.add(`${base}/${meta.markers.png2x}`);
	}
	if (meta.icons?.font) dataSet.add(`${base}/${meta.icons.font}`);
	if (meta.icons?.image) dataSet.add(`${base}/${meta.icons.image}`);

	const ts = mapMeta.tilesets[0];
	if (!ts) {
		return { dataUrls: [...dataSet], template: "", ranges: [] };
	}
	const bounds = ts.bounds || [-180, -85, 180, 85];
	const minZoom = ts.minzoom ?? 0;
	const maxZoom = ts.maxzoom ?? 14;
	return {
		dataUrls: [...dataSet],
		template: `${base}/${ts.template}`,
		ranges: computeZoomRanges(bounds, minZoom, maxZoom),
	};
}

export function expandSpecUrls(spec: OfflineTileSpec): string[] {
	const missing = spec.missingUrls?.length ? new Set(spec.missingUrls) : null;
	const urls: string[] = [];
	for (const u of spec.dataUrls) {
		if (!missing?.has(u)) urls.push(u);
	}
	if (spec.template) {
		for (const r of spec.ranges) {
			for (let x = r.x0; x <= r.x1; x++) {
				for (let y = r.y0; y <= r.y1; y++) {
					const u = spec.template
						.replace("{z}", String(r.z))
						.replace("{x}", String(x))
						.replace("{y}", String(y));
					if (!missing?.has(u)) urls.push(u);
				}
			}
		}
	}
	return urls;
}

export function pickSampleUrls(urls: string[], maxSamples = 5): string[] {
	if (!urls.length || maxSamples <= 0) return [];
	if (urls.length <= maxSamples) return urls.slice();
	const out: string[] = [];
	for (let i = 0; i < maxSamples; i++) {
		const idx = Math.floor((i * (urls.length - 1)) / (maxSamples - 1));
		out.push(urls[idx]);
	}
	return out;
}

/* ---------- browser adapters (IndexedDB + Cache API) with in-memory fallback ---------- */

const memManifests = new Map<string, OfflineManifest>();
let idbPromise: Promise<IDBDatabase> | null = null;

function openOfflineDB(): Promise<IDBDatabase> {
	if (idbPromise) return idbPromise;
	idbPromise = new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
		const req = indexedDB.open("offline-map-viewer", 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("profiles")) db.createObjectStore("profiles", { keyPath: "key" });
			if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "k" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error("IndexedDB blocked"));
	});
	return idbPromise;
}

function createBrowserStorage(): OfflineStorageAdapter {
	return {
		async get(k: string): Promise<OfflineManifest | null> {
			try {
				const db = await openOfflineDB();
				return await new Promise((resolve, reject) => {
					const tx = db.transaction("meta", "readonly");
					const req = tx.objectStore("meta").get(k);
					tx.oncomplete = () => resolve(req.result?.v ?? null);
					tx.onerror = () => reject(tx.error);
				});
			} catch {
				return memManifests.get(k) ?? null;
			}
		},
		async put(manifest: OfflineManifest): Promise<void> {
			memManifests.set(manifest.k, structuredClone(manifest));
			try {
				const db = await openOfflineDB();
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction("meta", "readwrite");
					tx.objectStore("meta").put({ k: manifest.k, v: manifest });
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
				});
			} catch {}
		},
		async remove(k: string): Promise<void> {
			memManifests.delete(k);
			try {
				const db = await openOfflineDB();
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction("meta", "readwrite");
					tx.objectStore("meta").delete(k);
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
				});
			} catch {}
		},
		async list(): Promise<OfflineManifest[]> {
			try {
				const db = await openOfflineDB();
				const rows = await new Promise<any[]>((resolve, reject) => {
					const tx = db.transaction("meta", "readonly");
					const req = tx.objectStore("meta").getAll();
					tx.oncomplete = () => resolve(req.result || []);
					tx.onerror = () => reject(tx.error);
				});
				return rows
					.filter((r) => r && typeof r.k === "string" && r.k.startsWith(OFFLINE_KEY_PREFIX) && r.v)
					.map((r) => r.v as OfflineManifest);
			} catch {
				return [...memManifests.values()];
			}
		},
	};
}

function getRootUrl(): string {
	if (typeof document === "undefined") return "http://localhost/";
	return new URL(
		/\/(signin|account)\/[^/]*$|\/maps\/[^/]+\/[^/]*$/.test(location.pathname) ? "../../" : "./",
		location.href,
	).href;
}

function resolveRelUrl(rel: string, rootUrl: string): string {
	const clean = rel.replace(/^\/+/, "");
	return new URL(clean, rootUrl).href;
}

function toRelFromRoot(fullUrl: string, rootUrl: string): string {
	const root = new URL(rootUrl);
	const u = new URL(fullUrl, root);
	if (u.origin === root.origin && u.pathname.startsWith(root.pathname)) {
		return u.pathname.slice(root.pathname.length).replace(/^\/+/, "");
	}
	return fullUrl;
}

function createBrowserCache(rootUrl: string): OfflineCacheAdapter {
	const memCache = new Map<string, { bytes: Uint8Array; contentType: string }>();
	return {
		async keys(): Promise<string[]> {
			if (typeof caches === "undefined") return [...memCache.keys()];
			try {
				const cache = await caches.open(OFFLINE_CACHE_NAME);
				const reqs = await cache.keys();
				return reqs.map((r) => toRelFromRoot(r.url, rootUrl));
			} catch {
				return [...memCache.keys()];
			}
		},
		async match(relUrl: string): Promise<OfflineCacheEntry | null> {
			if (typeof caches === "undefined") {
				const m = memCache.get(relUrl);
				if (!m) return null;
				return { size: m.bytes.byteLength, bytes: async () => m.bytes };
			}
			try {
				const cache = await caches.open(OFFLINE_CACHE_NAME);
				const res = await cache.match(resolveRelUrl(relUrl, rootUrl));
				if (!res) return null;
				const lenHeader = res.headers.get("x-va-size") || res.headers.get("content-length");
				let cachedBuf: Uint8Array | null = null;
				const loadBytes = async (): Promise<Uint8Array> => {
					if (!cachedBuf) cachedBuf = new Uint8Array(await res.clone().arrayBuffer());
					return cachedBuf;
				};
				const size = lenHeader ? Number(lenHeader) : (await loadBytes()).byteLength;
				return { size, bytes: loadBytes };
			} catch {
				return null;
			}
		},
		async put(relUrl: string, bytes: Uint8Array, contentType: string): Promise<void> {
			if (typeof caches === "undefined") {
				memCache.set(relUrl, { bytes, contentType });
				return;
			}
			try {
				const cache = await caches.open(OFFLINE_CACHE_NAME);
				const headers = new Headers({
					"Content-Type": contentType || "application/octet-stream",
					"x-va-size": String(bytes.byteLength),
					"x-va-cached-at": String(Date.now()),
				});
				await cache.put(
					resolveRelUrl(relUrl, rootUrl),
					new Response(bytes as BodyInit, { status: 200, headers }),
				);
			} catch {
				memCache.set(relUrl, { bytes, contentType });
			}
		},
		async delete(relUrl: string): Promise<boolean> {
			memCache.delete(relUrl);
			if (typeof caches === "undefined") return true;
			try {
				const cache = await caches.open(OFFLINE_CACHE_NAME);
				return await cache.delete(resolveRelUrl(relUrl, rootUrl));
			} catch {
				return false;
			}
		},
		async clear(): Promise<void> {
			memCache.clear();
			if (typeof caches === "undefined") return;
			try {
				await caches.delete(OFFLINE_CACHE_NAME);
			} catch {}
		},
	};
}

export function createOfflineManager(deps: OfflineManagerDeps = {}) {
	const rootUrl =
		deps.rootUrl ?? (typeof location !== "undefined" ? new URL("/", location.origin).href : "http://localhost/");
	const storage = deps.storage ?? createBrowserStorage();
	const cache = deps.cache ?? createBrowserCache(rootUrl);
	const concurrency = deps.concurrency ?? 12;
	const now = deps.now ?? Date.now;

	const fetchUrl =
		deps.fetchUrl ??
		(async (relUrl: string, signal?: AbortSignal) => {
			const res = await fetch(resolveRelUrl(relUrl, rootUrl), { signal, credentials: "same-origin" });
			if (!res.ok) return { status: res.status, bytes: new Uint8Array(0), contentType: "" };
			const bytes = new Uint8Array(await res.arrayBuffer());
			return {
				status: res.status,
				bytes,
				contentType: res.headers.get("content-type") || "application/octet-stream",
			};
		});

	const fetchMeta =
		deps.fetchMeta ??
		(async (gameSlug: string): Promise<GameMeta> => {
			const res = await fetch(resolveRelUrl(`maps/${gameSlug}/meta.json`, rootUrl), {
				credentials: "same-origin",
			});
			if (!res.ok) throw new Error(`Could not load meta.json for ${gameSlug} (HTTP ${res.status})`);
			return res.json();
		});

	async function runPool<T>(items: T[], fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
		let idx = 0;
		const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (idx < items.length) {
				if (signal?.aborted) throw new Error("Download cancelled");
				const item = items[idx++];
				await fn(item);
			}
		});
		await Promise.all(workers);
	}

	async function computeSamples(urls: string[]): Promise<OfflineSampleHash[]> {
		const picked = pickSampleUrls(urls, 5);
		const samples: OfflineSampleHash[] = [];
		for (const u of picked) {
			const entry = await cache.match(u);
			if (!entry) continue;
			const bytes = await entry.bytes();
			samples.push({ url: u, size: bytes.byteLength, hash: fnvBytes(bytes) });
		}
		return samples;
	}

	async function downloadOfflineMap(opts: {
		gameSlug: string;
		gameTitle?: string;
		meta?: GameMeta;
		mapSlug: string;
		onProgress?: (done: number, total: number) => void;
		signal?: AbortSignal;
	}): Promise<OfflineManifest> {
		const meta = opts.meta ?? (await fetchMeta(opts.gameSlug));
		const mapMeta = meta.maps.find((m) => m.slug === opts.mapSlug) || meta.maps[0];
		if (!mapMeta) throw new Error(`Map "${opts.mapSlug}" not found in ${opts.gameSlug}`);

		const spec = buildOfflineTileSpec(opts.gameSlug, meta, mapMeta);
		const allCandidateUrls = expandSpecUrls(spec);
		const existingKeys = new Set(await cache.keys());

		const missingUrls: string[] = [];
		let totalBytes = 0;
		let done = 0;
		const total = allCandidateUrls.length;
		opts.onProgress?.(0, total);

		const toFetch: string[] = [];
		for (const u of allCandidateUrls) {
			if (existingKeys.has(u)) {
				const entry = await cache.match(u);
				if (entry) {
					totalBytes += entry.size;
					done++;
					continue;
				}
			}
			toFetch.push(u);
		}
		if (done > 0) opts.onProgress?.(done, total);

		await runPool(
			toFetch,
			async (u) => {
				const res = await fetchUrl(u, opts.signal);
				if (res.status === 200) {
					await cache.put(u, res.bytes, res.contentType);
					totalBytes += res.bytes.byteLength;
				} else if (res.status === 404 || res.status === 403 || res.status === 410) {
					missingUrls.push(u);
				} else {
					throw new Error(`Failed to download ${u} (HTTP ${res.status})`);
				}
				done++;
				opts.onProgress?.(done, total);
			},
			opts.signal,
		);

		const finalSpec: OfflineTileSpec = {
			...spec,
			...(missingUrls.length ? { missingUrls: missingUrls.sort() } : {}),
		};
		const validUrls = expandSpecUrls(finalSpec);
		const sampleHashes = await computeSamples(validUrls);
		const ts = now();

		const manifest: OfflineManifest = {
			k: offlineKey(opts.gameSlug, mapMeta.slug),
			game: opts.gameSlug,
			map: mapMeta.slug,
			gameTitle: opts.gameTitle || meta.title || opts.gameSlug,
			mapTitle: mapMeta.title || mapMeta.slug,
			enabled: true,
			...finalSpec,
			expectedCount: validUrls.length,
			totalBytes,
			sampleHashes,
			lastVerified: ts,
			updatedAt: ts,
		};
		await storage.put(manifest);
		return manifest;
	}

	async function downloadOfflineGame(opts: {
		gameSlug: string;
		gameTitle?: string;
		onProgress?: (done: number, total: number) => void;
		signal?: AbortSignal;
	}): Promise<OfflineManifest[]> {
		const meta = await fetchMeta(opts.gameSlug);
		const specs = meta.maps.map((m) => ({
			map: m,
			urls: expandSpecUrls(buildOfflineTileSpec(opts.gameSlug, meta, m)),
		}));
		const grandTotal = specs.reduce((acc, s) => acc + s.urls.length, 0);
		let completedBefore = 0;
		const manifests: OfflineManifest[] = [];

		for (const s of specs) {
			const m = await downloadOfflineMap({
				gameSlug: opts.gameSlug,
				gameTitle: opts.gameTitle || meta.title,
				meta,
				mapSlug: s.map.slug,
				signal: opts.signal,
				onProgress: (mapDone) => {
					opts.onProgress?.(completedBefore + mapDone, grandTotal);
				},
			});
			completedBefore += s.urls.length;
			manifests.push(m);
		}
		return manifests;
	}

	async function verifyOfflineMap(opts: {
		gameSlug: string;
		mapSlug: string;
		onProgress?: (done: number, total: number) => void;
	}): Promise<{
		status: "disabled" | "intact" | "repaired";
		missingCount: number;
		manifest: OfflineManifest | null;
	}> {
		const k = offlineKey(opts.gameSlug, opts.mapSlug);
		const manifest = await storage.get(k);
		if (!manifest || !manifest.enabled) {
			return { status: "disabled", missingCount: 0, manifest: null };
		}

		const expectedUrls = expandSpecUrls(manifest);
		const existingKeys = new Set(await cache.keys());
		const toRedownload = new Set<string>();

		for (const u of expectedUrls) {
			if (!existingKeys.has(u)) toRedownload.add(u);
		}

		// Verify sample sizes and FNV-1a hashes
		for (const sample of manifest.sampleHashes || []) {
			if (toRedownload.has(sample.url)) continue;
			const entry = await cache.match(sample.url);
			if (!entry || entry.size !== sample.size) {
				toRedownload.add(sample.url);
				continue;
			}
			const bytes = await entry.bytes();
			if (bytes.byteLength !== sample.size || fnvBytes(bytes) !== sample.hash) {
				toRedownload.add(sample.url);
			}
		}

		if (toRedownload.size === 0) {
			manifest.lastVerified = now();
			await storage.put(manifest);
			return { status: "intact", missingCount: 0, manifest };
		}

		const repairList = [...toRedownload];
		let done = 0;
		opts.onProgress?.(0, repairList.length);
		await runPool(repairList, async (u) => {
			const res = await fetchUrl(u);
			if (res.status === 200) {
				await cache.put(u, res.bytes, res.contentType);
			}
			done++;
			opts.onProgress?.(done, repairList.length);
		});

		// Recompute totalBytes and sampleHashes after repair
		let totalBytes = 0;
		for (const u of expectedUrls) {
			const entry = await cache.match(u);
			if (entry) totalBytes += entry.size;
		}
		manifest.totalBytes = totalBytes;
		manifest.expectedCount = expectedUrls.length;
		manifest.sampleHashes = await computeSamples(expectedUrls);
		manifest.lastVerified = now();
		manifest.updatedAt = now();
		await storage.put(manifest);

		return { status: "repaired", missingCount: repairList.length, manifest };
	}

	async function getOfflineManifest(gameSlug: string, mapSlug: string): Promise<OfflineManifest | null> {
		return storage.get(offlineKey(gameSlug, mapSlug));
	}

	async function listOfflineManifests(): Promise<OfflineManifest[]> {
		const all = await storage.list();
		return all
			.filter((m) => m && m.enabled)
			.sort((a, b) => a.gameTitle.localeCompare(b.gameTitle) || a.mapTitle.localeCompare(b.mapTitle));
	}

	async function getGameOfflineManifests(gameSlug: string): Promise<OfflineManifest[]> {
		const all = await listOfflineManifests();
		return all.filter((m) => m.game === gameSlug);
	}

	async function inspectOfflineManifests(): Promise<
		{ manifest: OfflineManifest; cachedCount: number; intact: boolean }[]
	> {
		const manifests = await listOfflineManifests();
		const existingKeys = new Set(await cache.keys());
		return manifests.map((manifest) => {
			const urls = expandSpecUrls(manifest);
			let cachedCount = 0;
			for (const u of urls) {
				if (existingKeys.has(u)) cachedCount++;
			}
			return {
				manifest,
				cachedCount,
				intact: cachedCount === urls.length && urls.length > 0,
			};
		});
	}

	async function removeOfflineMap(gameSlug: string, mapSlug: string): Promise<void> {
		const k = offlineKey(gameSlug, mapSlug);
		const manifest = await storage.get(k);
		await storage.remove(k);
		if (!manifest) return;

		// Keep any shared game-level URLs (e.g. meta.json, markers.png) if another map of the same game is still kept offline
		const remainingForGame = (await listOfflineManifests()).filter((m) => m.game === gameSlug && m.map !== mapSlug);
		const protectedUrls = new Set<string>();
		for (const other of remainingForGame) {
			for (const u of expandSpecUrls(other)) protectedUrls.add(u);
		}

		for (const u of expandSpecUrls(manifest)) {
			if (!protectedUrls.has(u)) {
				await cache.delete(u);
			}
		}
	}

	async function removeOfflineGame(gameSlug: string): Promise<void> {
		const maps = await getGameOfflineManifests(gameSlug);
		for (const m of maps) {
			await removeOfflineMap(gameSlug, m.map);
		}
	}

	async function clearAllOfflineMaps(): Promise<void> {
		const all = await storage.list();
		for (const m of all) {
			await storage.remove(m.k);
		}
		await cache.clear();
	}

	return {
		downloadOfflineMap,
		downloadOfflineGame,
		verifyOfflineMap,
		getOfflineManifest,
		getGameOfflineManifests,
		listOfflineManifests,
		inspectOfflineManifests,
		removeOfflineMap,
		removeOfflineGame,
		clearAllOfflineMaps,
	};
}

const defaultManager = createOfflineManager();

export const downloadOfflineMap = defaultManager.downloadOfflineMap;
export const downloadOfflineGame = defaultManager.downloadOfflineGame;
export const verifyOfflineMap = defaultManager.verifyOfflineMap;
export const getOfflineManifest = defaultManager.getOfflineManifest;
export const getGameOfflineManifests = defaultManager.getGameOfflineManifests;
export const listOfflineManifests = defaultManager.listOfflineManifests;
export const inspectOfflineManifests = defaultManager.inspectOfflineManifests;
export const removeOfflineMap = defaultManager.removeOfflineMap;
export const removeOfflineGame = defaultManager.removeOfflineGame;
export const clearAllOfflineMaps = defaultManager.clearAllOfflineMaps;