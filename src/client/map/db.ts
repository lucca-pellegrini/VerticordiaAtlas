// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- storage: IndexedDB with an in-memory fallback ---------- */

import type { SyncStore } from "../sync.ts";
import { state, syncNote } from "./state.ts";

type StoreName = "profiles" | "meta";

const mem: Record<StoreName, Map<string, any>> = { profiles: new Map(), meta: new Map() };
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		if (typeof window === "undefined" || !("indexedDB" in window))
			return reject(new Error("IndexedDB unavailable"));
		const req = indexedDB.open("offline-map-viewer", 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			db.createObjectStore("profiles", { keyPath: "key" });
			db.createObjectStore("meta", { keyPath: "k" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error("IndexedDB blocked"));
	});
	return dbPromise;
}

async function withStore<T = any>(
	store: StoreName,
	mode: IDBTransactionMode,
	fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const t = db.transaction(store, mode);
		const r = fn(t.objectStore(store));
		t.oncomplete = () => resolve(r ? r.result : undefined);
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error || new Error("transaction aborted"));
	});
}

const keyField = (store: StoreName): "key" | "k" => (store === "profiles" ? "key" : "k");

export async function dbAll(store: StoreName): Promise<any[]> {
	if (state.memoryOnly) return [...mem[store].values()];
	return (await withStore<any[]>(store, "readonly", (s) => s.getAll())) || [];
}

export async function dbGet(store: StoreName, key: string): Promise<any> {
	if (state.memoryOnly) return mem[store].get(key);
	return withStore(store, "readonly", (s) => s.get(key));
}

export async function dbPut(store: StoreName, value: any): Promise<void> {
	if (state.memoryOnly) {
		mem[store].set(value[keyField(store)], structuredClone(value));
		return;
	}
	await withStore(store, "readwrite", (s) => s.put(value));
}

export async function dbDelete(store: StoreName, key: string): Promise<void> {
	if (state.memoryOnly) {
		mem[store].delete(key);
		return;
	}
	await withStore(store, "readwrite", (s) => s.delete(key));
}

export const getMeta = async (k: string): Promise<any> => (await dbGet("meta", k))?.v;

export const setMeta = (k: string, v: any): Promise<void> => {
	const done = dbPut("meta", { k, v });
	if (/^presets:/.test(k)) syncNote();
	return done;
};

// a profile with no progress yet (what a new device starts with)
export const emptyProfile = (p: any): boolean =>
	!p.found?.length && !p.drawings?.length && !p.userMarkers?.length && !p.userCats?.length;

// what sync reads and writes: this device's IndexedDB
export const syncStore: SyncStore = {
	profiles: () => dbAll("profiles"),
	isEmpty: emptyProfile,
	metaEntries: async () => (await dbAll("meta")).map((r) => ({ k: r.k, v: r.v })),
	putProfile: (rec) => dbPut("profiles", rec),
	deleteProfile: (key) => dbDelete("profiles", key),
	putMeta: (k, v) => dbPut("meta", { k, v }),
	removeMeta: (k) => dbDelete("meta", k),
	getMeta: async (k) => (await dbGet("meta", k))?.v ?? null,
};