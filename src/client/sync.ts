// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// sync.ts: keeps this device's progress in step with the server, for signed-in users only. The app never needs it:
// everything is written to IndexedDB first, and this only moves that data around in the background.
//
// Tabs: exactly one tab is the leader (it holds the Web Lock 'va-sync-leader'); it alone talks to the server. Other
// tabs hear about what the leader changed over a BroadcastChannel, and reload from IndexedDB.
// Conflicts: an item is sent with the server timestamp this device last saw ("base"). If the server has something newer
// while this device also has unsent changes to the same item, the user is asked which to keep. Otherwise the newer wins.

import { contentKey, fnv, sendKey } from "../shared/sync-rules.ts";
import type { Profile, SyncItem } from "../shared/types.ts";

const CHANNEL = "va-sync";
const LOCK = "va-sync-leader";
const BATCH = 100;

export interface SyncStore {
	profiles(): Promise<Profile[]>;
	putProfile(p: Profile): Promise<unknown>;
	deleteProfile(key: string): Promise<unknown>;
	metaEntries(): Promise<{ k: string; v: any }[]>;
	getMeta(k: string): Promise<any>;
	putMeta(k: string, v: any): Promise<unknown>;
	removeMeta(k: string): Promise<unknown>;
	isEmpty(p: Profile): boolean;
}

export interface SyncConflictItem {
	key: string;
	label: string;
}

export interface SyncUI {
	status(s: { online: boolean }): void;
	conflicts(list: SyncConflictItem[]): void;
	remoteChanged(keys: string[]): Promise<void> | void;
	signedOut(): void;
}

interface SyncPersistedState {
	sent: Record<string, string | null>;
	content: Record<string, string | null>;
	seen: Record<string, number>;
	conflicts: Record<string, { server: any; updated_at: number }>;
}

export function createSync({
	store,
	ui,
	api,
	socketUrl = null,
}: {
	store: SyncStore;
	ui: SyncUI;
	api: (method: string, path: string, body?: any) => Promise<any>;
	socketUrl?: ((clientId: string) => string) | null;
}) {
	const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
	let leader = false,
		running = false,
		online = typeof navigator !== "undefined" ? navigator.onLine : true;
	let st: SyncPersistedState = { sent: {}, content: {}, seen: {}, conflicts: {} };
	let pushTimer: ReturnType<typeof setTimeout> | null = null;
	let interval: ReturnType<typeof setInterval> | null = null;
	let stopped = false,
		again = false;
	const clientId = crypto.randomUUID();
	let sock: WebSocket | null = null;
	let sockTimer: ReturnType<typeof setTimeout> | null = null;
	let sockFails = 0,
		live = false;

	/* ---------- what this device holds, as sync items ---------- */
	const sendHash = (key: string, v: unknown): string | null =>
		v === null || v === undefined ? null : fnv(sendKey(key, v));
	const contentHash = (key: string, v: unknown): string | null =>
		v === null || v === undefined ? null : fnv(contentKey(key, v));
	async function snapshot(): Promise<Map<string, any>> {
		const map = new Map<string, any>();
		for (const p of await store.profiles()) {
			const { key: _key, ...v } = p;
			map.set(`profile:${p.game}:${p.id}`, v);
		}
		for (const e of await store.metaEntries()) {
			if (/^presets:/.test(e.k)) map.set(`meta:${e.k}`, e.v);
		}
		return map;
	}
	const isDirty = (key: string, snap: Map<string, any>): boolean => {
		if (!(key in st.content) && key in st.sent) {
			return (snap.has(key) ? sendHash(key, snap.get(key)) : null) !== st.sent[key];
		}
		const cur = snap.has(key) ? contentHash(key, snap.get(key)) : null;
		return cur !== (st.content[key] ?? null);
	};

	/* ---------- applying server data to this device ---------- */
	async function applyRemote(item: SyncItem): Promise<void> {
		if (item.key.startsWith("profile:")) {
			const [, game, id] = item.key.split(":");
			if (item.value === null) await store.deleteProfile(`${game}:${id}`);
			else await store.putProfile({ ...(item.value as Profile), key: `${game}:${id}`, game, id });
		} else {
			const k = item.key.slice(5);
			if (item.value === null) await store.removeMeta(k);
			else await store.putMeta(k, item.value);
		}
	}

	async function loadState(): Promise<void> {
		const saved = await store.getMeta("sync:state");
		if (saved)
			st = {
				sent: saved.sent || {},
				content: saved.content || {},
				seen: saved.seen || {},
				conflicts: saved.conflicts || {},
			};
	}
	const saveState = () => store.putMeta("sync:state", st);

	async function adoptOverPlaceholders(key: string): Promise<void> {
		const game = key.split(":")[1];
		for (const p of await store.profiles()) {
			const k = `profile:${p.game}:${p.id}`;
			if (p.game === game && k !== key && !(k in st.sent) && store.isEmpty(p))
				await store.deleteProfile(`${p.game}:${p.id}`);
		}
	}

	/* ---------- pull: the server's newer items ---------- */
	async function pull(): Promise<void> {
		const { items } = await api("GET", "sync");
		const snap = await snapshot();
		const changed: string[] = [];
		for (const item of items as SyncItem[]) {
			if ((st.seen[item.key] ?? 0) >= item.updated_at) continue;
			if (isDirty(item.key, snap)) {
				st.conflicts[item.key] = { server: item.value, updated_at: item.updated_at };
				continue;
			}
			if (item.key.startsWith("profile:") && item.value !== null) await adoptOverPlaceholders(item.key);
			await applyRemote(item);
			st.sent[item.key] = sendHash(item.key, item.value);
			st.content[item.key] = contentHash(item.key, item.value);
			st.seen[item.key] = item.updated_at;
			changed.push(item.key);
		}
		if (changed.length) {
			bc?.postMessage({ type: "remote", keys: changed });
			await ui.remoteChanged(changed);
		}
		if (Object.keys(st.conflicts).length) ui.conflicts(conflictList());
	}

	/* ---------- push: this device's changes ---------- */
	async function push(): Promise<void> {
		const snap = await snapshot();
		const items: { key: string; value: any; base: number }[] = [];
		for (const [key, value] of snap) {
			if (st.sent[key] !== sendHash(key, value)) items.push({ key, value, base: st.seen[key] ?? 0 });
		}
		for (const key of Object.keys(st.sent)) {
			if (!snap.has(key) && st.sent[key] !== null) items.push({ key, value: null, base: st.seen[key] ?? 0 });
		}
		for (let i = 0; i < items.length; i += BATCH) {
			const batch = items.slice(i, i + BATCH);
			const { results } = await api("POST", "sync", { items: batch, client: clientId });
			const sent = new Map(batch.map((it) => [it.key, it]));
			for (const r of results) {
				const it = sent.get(r.key)!;
				if (r.status === "ok") {
					st.sent[r.key] = sendHash(r.key, it.value);
					st.content[r.key] = contentHash(r.key, it.value);
					st.seen[r.key] = r.updated_at;
					delete st.conflicts[r.key];
				} else {
					st.conflicts[r.key] = { server: r.value, updated_at: r.updated_at };
				}
			}
		}
		if (Object.keys(st.conflicts).length) ui.conflicts(conflictList());
	}

	const conflictList = (): SyncConflictItem[] =>
		Object.keys(st.conflicts).map((key) => ({ key, label: labelFor(key) }));
	const labelFor = (key: string): string => {
		if (key.startsWith("profile:")) return `Progress for "${key.split(":")[2]}"`;
		return "Selection presets";
	};

	/* ---------- the cycle (leader only) ---------- */
	async function cycle(): Promise<void> {
		if (!leader || stopped) return;
		if (running) {
			again = true;
			return;
		}
		if (!online) return;
		running = true;
		try {
			await loadState();
			await pull();
			await push();
			await saveState();
			setOnline(true);
		} catch (e: any) {
			if (e.status === 401) {
				stopped = true;
				sock?.close();
				ui.signedOut();
			} else if (e.network) setOnline(false);
			else console.error("sync:", e);
		} finally {
			running = false;
			if (again && !stopped) {
				again = false;
				schedulePush(0);
			}
		}
	}

	/* ---------- live updates ---------- */
	const POLL_FAST = 60_000,
		POLL_SLOW = 5 * 60_000;
	function setPolling(ms: number): void {
		if (interval) clearInterval(interval);
		interval = setInterval(cycle, ms);
		(interval as any).unref?.();
	}

	function openSocket(): void {
		if (!socketUrl || !leader || stopped || !online || sock || typeof WebSocket === "undefined") return;
		let ws: WebSocket;
		try {
			ws = new WebSocket(socketUrl(clientId));
		} catch {
			return scheduleSocket();
		}
		sock = ws;
		ws.onopen = () => {
			sockFails = 0;
		};
		ws.onmessage = (ev) => {
			let m: any = null;
			try {
				m = JSON.parse(String(ev.data));
			} catch {
				/* not ours */
			}
			if (m?.type === "hello") {
				live = true;
				setPolling(POLL_SLOW);
				cycle();
			} else if (m?.type === "changed") cycle();
		};
		ws.onclose = (ev) => {
			if (sock === ws) sock = null;
			if (live) {
				live = false;
				setPolling(POLL_FAST);
			}
			if (ev.code === 4401) return;
			sockFails++;
			scheduleSocket();
		};
		ws.onerror = () => {
			/* onclose follows */
		};
	}
	function scheduleSocket(): void {
		if (sockTimer) clearTimeout(sockTimer);
		if (!socketUrl || !leader || stopped) return;
		const wait = Math.min(5 * 60_000, 1000 * 2 ** Math.min(sockFails, 9)) * (0.75 + Math.random() * 0.5);
		sockTimer = setTimeout(openSocket, wait);
		(sockTimer as any).unref?.();
	}

	function setOnline(v: boolean): void {
		if (online === v) return;
		online = v;
		bc?.postMessage({ type: "status", online: v });
		ui.status({ online: v });
	}

	async function resolveConflicts(choice: "server" | "local"): Promise<void> {
		await loadState();
		const taken: string[] = [];
		for (const key of Object.keys(st.conflicts)) {
			const c = st.conflicts[key];
			if (choice === "server") {
				await applyRemote({ key, value: c.server, updated_at: c.updated_at });
				st.sent[key] = sendHash(key, c.server);
				st.content[key] = contentHash(key, c.server);
				taken.push(key);
			}
			st.seen[key] = c.updated_at;
			delete st.conflicts[key];
		}
		await saveState();
		if (taken.length) {
			bc?.postMessage({ type: "remote", keys: taken });
			await ui.remoteChanged(taken);
		}
		schedulePush(0);
	}

	function schedulePush(ms = 1500): void {
		if (pushTimer) clearTimeout(pushTimer);
		pushTimer = setTimeout(cycle, ms);
		(pushTimer as any).unref?.();
	}

	/* ---------- tabs ---------- */
	bc?.addEventListener("message", (ev) => {
		const m = ev.data || {};
		if (m.type === "local" && leader) schedulePush();
		if (m.type === "remote" && !leader) ui.remoteChanged(m.keys || []);
		if (m.type === "status" && !leader) ui.status({ online: m.online });
	});
	(bc as any)?.unref?.();

	function start(): void {
		const hold = () => new Promise(() => {});
		const becomeLeader = () => {
			leader = true;
			cycle();
			setPolling(POLL_FAST);
			openSocket();
			return hold();
		};
		if (navigator.locks) navigator.locks.request(LOCK, becomeLeader);
		else becomeLeader();
		addEventListener("online", () => {
			setOnline(true);
			cycle();
			sockFails = 0;
			if (sockTimer) clearTimeout(sockTimer);
			openSocket();
		});
		addEventListener("offline", () => {
			setOnline(false);
			sock?.close();
		});
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") cycle();
		});
	}

	function stop(): void {
		stopped = true;
		if (pushTimer) clearTimeout(pushTimer);
		if (interval) clearInterval(interval);
		if (sockTimer) clearTimeout(sockTimer);
		sock?.close();
		bc?.close();
	}

	return {
		start,
		stop,
		noteLocal() {
			bc?.postMessage({ type: "local" });
			if (leader) schedulePush();
		},
		resolveConflicts,
		isLeader: () => leader,
	};
}