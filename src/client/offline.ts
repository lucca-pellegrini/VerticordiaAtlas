// offline.ts: device-local "Keep offline" manager.
// A map kept offline is one pack (see pack-store.ts) that the server streams in a single request (server/offline-pack.ts).
// The pack is stored as a few large blobs plus an index in IndexedDB, and the service worker answers the page's requests
// out of it. A small manifest per map (IndexedDB -> offline-map-viewer -> meta store, key "offline:<game>:<map>") is what
// the sidebar and the account page list.

import type { GameMeta } from "../shared/types.ts";
import { createIdbPackStore, createMemoryPackStore } from "./pack-store.ts";
import type { PackStore } from "./pack-store.ts";

export const OFFLINE_KEY_PREFIX = "offline:";
export const VAOP_MAGIC = "VAOP";
export const VAOP_VERSION = 1;
export const LEGACY_OFFLINE_CACHE = "va-offline-tiles"; // earlier versions kept every file as a Cache API entry

export interface OfflineSampleHash {
	url: string;
	size: number;
	hash: string;
}

export interface OfflineManifest {
	k: string;
	game: string;
	map: string;
	gameTitle: string;
	mapTitle: string;
	enabled: boolean;
	expectedCount: number; // URLs the pack answers
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

// what a download is doing: asking the server to get the map ready (nothing arrives yet), or receiving it
export type OfflineStatus =
	| { phase: "preparing"; map: number; maps: number }
	| { phase: "downloading"; map: number; maps: number; done: number; total: number };

export interface OfflineManagerDeps {
	storage?: OfflineStorageAdapter;
	packs?: PackStore;
	fetchMeta?: (gameSlug: string) => Promise<GameMeta>;
	fetchPack?: (gameSlug: string, mapSlug: string, signal?: AbortSignal) => Promise<Response>;
	rootUrl?: string;
	now?: () => number;
	notifyChanged?: () => void;
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

export function pickSampleUrls(urls: string[], maxSamples = 5): string[] {
	if (!urls.length || maxSamples <= 0) return [];
	if (urls.length <= maxSamples) return urls.slice();
	const out: string[] = [];
	for (let i = 0; i < maxSamples; i++) out.push(urls[Math.floor((i * (urls.length - 1)) / (maxSamples - 1))]);
	return out;
}

export async function unpackVaopStream(
	stream: ReadableStream<Uint8Array>,
	onEntry: (entry: {
		type: 0 | 1;
		url: string;
		sourceUrl?: string;
		contentType: string;
		bytes?: Uint8Array;
	}) => Promise<void>,
	onProgress?: (bytesRead: number, totalBytes: number) => void,
	signal?: AbortSignal,
): Promise<{ totalEntries: number; totalBytes: number }> {
	const reader = stream.getReader();
	let buf = new Uint8Array(0);

	const append = (chunk: Uint8Array) => {
		const next = new Uint8Array(buf.length + chunk.length);
		next.set(buf, 0);
		next.set(chunk, buf.length);
		buf = next;
	};

	let bytesRead = 0;
	let totalBytes = 0;
	let totalEntries = 0;

	const ensure = async (n: number): Promise<boolean> => {
		while (buf.length < n) {
			if (signal?.aborted) throw new Error("Download cancelled");
			const { done, value } = await reader.read();
			if (done) return false;
			append(value);
		}
		return true;
	};

	const consume = (n: number): Uint8Array => {
		const slice = buf.subarray(0, n);
		buf = buf.subarray(n);
		return slice;
	};

	if (!(await ensure(17))) throw new Error("Truncated offline pack stream");
	const hdr = consume(17);
	bytesRead += 17;

	const magic = String.fromCharCode(...hdr.subarray(0, 4));
	if (magic !== VAOP_MAGIC) throw new Error(`Invalid pack format: expected VAOP, got ${magic}`);
	const version = hdr[4];
	if (version !== VAOP_VERSION) throw new Error(`Unsupported pack version: ${version}`);

	const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
	totalEntries = dv.getUint32(5);
	totalBytes = Number(dv.getBigUint64(9));
	onProgress?.(bytesRead, totalBytes);

	const td = new TextDecoder();
	let entriesRead = 0;

	while (entriesRead < totalEntries) {
		if (signal?.aborted) throw new Error("Download cancelled");
		if (!(await ensure(1))) break;
		const type = buf[0];

		if (type === 0) {
			if (!(await ensure(1 + 2))) break;
			const uLen = (buf[1] << 8) | buf[2];
			if (!(await ensure(1 + 2 + uLen + 1))) break;
			const mLen = buf[1 + 2 + uLen];
			if (!(await ensure(1 + 2 + uLen + 1 + mLen + 4))) break;

			const hdrView = new DataView(buf.buffer, buf.byteOffset, 1 + 2 + uLen + 1 + mLen + 4);
			const dLen = hdrView.getUint32(1 + 2 + uLen + 1 + mLen);
			const totalEntrySize = 1 + 2 + uLen + 1 + mLen + 4 + dLen;

			if (!(await ensure(totalEntrySize))) break;
			const entryBytes = consume(totalEntrySize);
			bytesRead += totalEntrySize;

			const url = td.decode(entryBytes.subarray(3, 3 + uLen));
			const contentType = td.decode(entryBytes.subarray(3 + uLen + 1, 3 + uLen + 1 + mLen));
			const data = entryBytes.subarray(3 + uLen + 1 + mLen + 4);

			await onEntry({ type: 0, url, contentType, bytes: data });
			entriesRead++;
			onProgress?.(bytesRead, totalBytes);
		} else if (type === 1) {
			if (!(await ensure(1 + 2))) break;
			const tLen = (buf[1] << 8) | buf[2];
			if (!(await ensure(1 + 2 + tLen + 2))) break;
			const sLen = (buf[3 + tLen] << 8) | buf[4 + tLen];
			if (!(await ensure(1 + 2 + tLen + 2 + sLen + 1))) break;
			const mLen = buf[1 + 2 + tLen + 2 + sLen];
			const totalEntrySize = 1 + 2 + tLen + 2 + sLen + 1 + mLen;

			if (!(await ensure(totalEntrySize))) break;
			const entryBytes = consume(totalEntrySize);
			bytesRead += totalEntrySize;

			const targetUrl = td.decode(entryBytes.subarray(3, 3 + tLen));
			const srcUrl = td.decode(entryBytes.subarray(5 + tLen, 5 + tLen + sLen));
			const contentType = td.decode(entryBytes.subarray(6 + tLen + sLen));

			await onEntry({ type: 1, url: targetUrl, sourceUrl: srcUrl, contentType });
			entriesRead++;
			onProgress?.(bytesRead, totalBytes);
		} else {
			throw new Error(`Unknown pack entry type: ${type}`);
		}
	}

	return { totalEntries, totalBytes };
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

function resolveRelUrl(rel: string, rootUrl: string): string {
	return new URL(rel.replace(/^\/+/, ""), rootUrl).href;
}

// the service worker keeps what it read of the packs: tell it a pack changed
function tellWorker(): void {
	try {
		navigator.serviceWorker?.controller?.postMessage({ type: "va-offline-changed" });
	} catch {}
}

export function createOfflineManager(deps: OfflineManagerDeps = {}) {
	const rootUrl =
		deps.rootUrl ?? (typeof location !== "undefined" ? new URL("/", location.origin).href : "http://localhost/");
	const storage = deps.storage ?? createBrowserStorage();
	const packs = deps.packs ?? (typeof indexedDB !== "undefined" ? createIdbPackStore() : createMemoryPackStore());
	const now = deps.now ?? Date.now;
	const changed = deps.notifyChanged ?? tellWorker;

	const fetchPack =
		deps.fetchPack ??
		(async (gameSlug: string, mapSlug: string, signal?: AbortSignal): Promise<Response> => {
			const res = await fetch(
				resolveRelUrl(
					`api/maps/${encodeURIComponent(gameSlug)}/${encodeURIComponent(mapSlug)}/offline-pack`,
					rootUrl,
				),
				{ credentials: "same-origin", signal, cache: "no-store" },
			);
			if (!res.ok || !res.body)
				throw new Error(`The server could not pack ${gameSlug}/${mapSlug} (HTTP ${res.status})`);
			return res;
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

	async function sampleHashes(game: string, map: string, urls: string[]): Promise<OfflineSampleHash[]> {
		const out: OfflineSampleHash[] = [];
		for (const url of pickSampleUrls(urls, 5)) {
			const hit = await packs.read(game, map, url);
			if (!hit) continue;
			const bytes = new Uint8Array(await hit.blob.arrayBuffer());
			out.push({ url, size: bytes.byteLength, hash: fnvBytes(bytes) });
		}
		return out;
	}

	// asks the server for the map and keeps what it sends. The server may take a while to answer (it makes the tiles it
	// lacks first): "preparing" lasts until the first byte; the numbers only run while bytes arrive.
	async function downloadOfflineMap(opts: {
		gameSlug: string;
		gameTitle?: string;
		meta?: GameMeta;
		mapSlug: string;
		mapIndex?: number; // 1-based, for the status line
		mapCount?: number;
		onStatus?: (s: OfflineStatus) => void;
		signal?: AbortSignal;
	}): Promise<OfflineManifest> {
		const meta = opts.meta ?? (await fetchMeta(opts.gameSlug));
		const mapMeta = meta.maps.find((m) => m.slug === opts.mapSlug);
		if (!mapMeta) throw new Error(`Map "${opts.mapSlug}" not found in ${opts.gameSlug}`);
		const map = opts.mapIndex ?? 1;
		const maps = opts.mapCount ?? 1;

		opts.onStatus?.({ phase: "preparing", map, maps });
		const res = await fetchPack(opts.gameSlug, mapMeta.slug, opts.signal);
		if (!res.body) throw new Error("The server sent no data");

		const writer = await packs.begin(opts.gameSlug, mapMeta.slug);
		const urls: string[] = [];
		try {
			opts.onStatus?.({ phase: "downloading", map, maps, done: 0, total: 1 });
			await unpackVaopStream(
				res.body,
				async (e) => {
					if (e.type === 0 && e.bytes) await writer.add(e.url, e.contentType, e.bytes);
					else if (e.type === 1 && e.sourceUrl) await writer.alias(e.url, e.sourceUrl);
					else return;
					urls.push(e.url);
				},
				(done, total) => opts.onStatus?.({ phase: "downloading", map, maps, done, total: total || 1 }),
				opts.signal,
			);
			if (!urls.length) throw new Error("The server sent an empty pack");
			const stat = await writer.commit();
			const ts = now();
			const manifest: OfflineManifest = {
				k: offlineKey(opts.gameSlug, mapMeta.slug),
				game: opts.gameSlug,
				map: mapMeta.slug,
				gameTitle: opts.gameTitle || meta.title || opts.gameSlug,
				mapTitle: mapMeta.title || mapMeta.slug,
				enabled: true,
				expectedCount: stat.count,
				totalBytes: stat.bytes,
				sampleHashes: await sampleHashes(opts.gameSlug, mapMeta.slug, urls),
				lastVerified: ts,
				updatedAt: ts,
			};
			await storage.put(manifest);
			changed();
			return manifest;
		} catch (e) {
			await writer.abort().catch(() => {});
			throw e;
		}
	}

	async function downloadOfflineGame(opts: {
		gameSlug: string;
		gameTitle?: string;
		onStatus?: (s: OfflineStatus) => void;
		signal?: AbortSignal;
	}): Promise<OfflineManifest[]> {
		const meta = await fetchMeta(opts.gameSlug);
		const out: OfflineManifest[] = [];
		for (let i = 0; i < meta.maps.length; i++) {
			out.push(
				await downloadOfflineMap({
					gameSlug: opts.gameSlug,
					gameTitle: opts.gameTitle || meta.title,
					meta,
					mapSlug: meta.maps[i].slug,
					mapIndex: i + 1,
					mapCount: meta.maps.length,
					onStatus: opts.onStatus,
					signal: opts.signal,
				}),
			);
		}
		return out;
	}

	// is the pack still whole? Not a download: nothing is asked of the network
	async function verifyOfflineMap(opts: {
		gameSlug: string;
		mapSlug: string;
	}): Promise<{ status: "disabled" | "intact" | "damaged"; manifest: OfflineManifest | null }> {
		const manifest = await storage.get(offlineKey(opts.gameSlug, opts.mapSlug));
		if (!manifest || !manifest.enabled) return { status: "disabled", manifest: null };
		const stat = await packs.stat(opts.gameSlug, opts.mapSlug);
		if (!stat || stat.count !== manifest.expectedCount) return { status: "damaged", manifest };
		for (const s of manifest.sampleHashes || []) {
			const hit = await packs.read(opts.gameSlug, opts.mapSlug, s.url);
			if (!hit || hit.blob.size !== s.size) return { status: "damaged", manifest };
			if (fnvBytes(new Uint8Array(await hit.blob.arrayBuffer())) !== s.hash)
				return { status: "damaged", manifest };
		}
		manifest.lastVerified = now();
		await storage.put(manifest);
		return { status: "intact", manifest };
	}

	async function getOfflineManifest(gameSlug: string, mapSlug: string): Promise<OfflineManifest | null> {
		return storage.get(offlineKey(gameSlug, mapSlug));
	}

	async function listOfflineManifests(): Promise<OfflineManifest[]> {
		return (await storage.list())
			.filter((m) => m && m.enabled)
			.sort((a, b) => a.gameTitle.localeCompare(b.gameTitle) || a.mapTitle.localeCompare(b.mapTitle));
	}

	// every kept map with how much of it is really stored (the account page)
	async function inspectOfflineManifests(): Promise<
		{ manifest: OfflineManifest; cachedCount: number; intact: boolean }[]
	> {
		const out = [];
		for (const manifest of await listOfflineManifests()) {
			const stat = await packs.stat(manifest.game, manifest.map);
			const cachedCount = stat?.count ?? 0;
			out.push({ manifest, cachedCount, intact: cachedCount > 0 && cachedCount === manifest.expectedCount });
		}
		return out;
	}

	// the kept maps of a game that are really stored
	async function getGameOfflineManifests(gameSlug: string): Promise<OfflineManifest[]> {
		const items = await inspectOfflineManifests();
		return items.filter((i) => i.manifest.game === gameSlug && i.intact).map((i) => i.manifest);
	}

	async function removeOfflineMap(gameSlug: string, mapSlug: string): Promise<void> {
		await storage.remove(offlineKey(gameSlug, mapSlug));
		await packs.remove(gameSlug, mapSlug);
		changed();
	}

	async function removeOfflineGame(gameSlug: string): Promise<void> {
		for (const m of (await storage.list()).filter((m) => m.game === gameSlug))
			await removeOfflineMap(gameSlug, m.map);
		for (const map of await packs.maps(gameSlug)) await removeOfflineMap(gameSlug, map);
	}

	async function clearAllOfflineMaps(): Promise<void> {
		for (const m of await storage.list()) await storage.remove(m.k);
		await packs.clear();
		try {
			await caches.delete(LEGACY_OFFLINE_CACHE);
		} catch {}
		changed();
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