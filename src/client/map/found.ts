// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Single mutation path for `state.found` and `state.foundAt`, plus the in-memory undo stack.
// `state.found` (Set<number>) is the source of truth; `state.foundAt` (Map<number, number>) stores
// advisory epoch-second timestamps for ids that have one.

import { state, toast } from "./state.ts";

export interface FoundChangeRecord {
	ids: number[];
	on: boolean;
	prevAt: Map<number, number | undefined>;
	at: number;
}

const MAX_UNDO = 50;
const undoStack: FoundChangeRecord[] = [];

export function applyFoundChange(
	ids: Iterable<number>,
	on: boolean,
	opts?: { nowSec?: number; recordUndo?: boolean },
): FoundChangeRecord | null {
	const at = opts?.nowSec ?? Math.floor(Date.now() / 1000);
	const seen = new Set<number>();
	const changed: number[] = [];
	const prevAt = new Map<number, number | undefined>();
	if (!state.foundAt) state.foundAt = new Map<number, number>();
	for (const id of ids) {
		if (!Number.isFinite(id) || seen.has(id)) continue;
		seen.add(id);
		if (state.found.has(id) === on) continue;
		changed.push(id);
		prevAt.set(id, state.foundAt.get(id));
		if (on) {
			state.found.add(id);
			state.foundAt.set(id, at);
		} else {
			state.found.delete(id);
			state.foundAt.delete(id);
		}
	}
	if (!changed.length) return null;
	const rec: FoundChangeRecord = { ids: changed, on, prevAt, at };
	if (opts?.recordUndo !== false) {
		undoStack.push(rec);
		if (undoStack.length > MAX_UNDO) undoStack.shift();
	}
	return rec;
}

export function undoFoundChange(): FoundChangeRecord | null {
	const rec = undoStack.pop();
	if (!rec) return null;
	if (!state.foundAt) state.foundAt = new Map<number, number>();
	for (const id of rec.ids) {
		if (rec.on) state.found.delete(id);
		else state.found.add(id);
		const old = rec.prevAt.get(id);
		if (old !== undefined) state.foundAt.set(id, old);
		else state.foundAt.delete(id);
	}
	return rec;
}

export function clearFoundUndo(): void {
	undoStack.length = 0;
}

export function canUndoFound(): boolean {
	return undoStack.length > 0;
}

export function loadFoundFromProfile(p: { found?: number[]; foundAt?: Record<string, number> }): void {
	state.found = new Set(p.found || []);
	state.foundAt = new Map<number, number>();
	if (p.foundAt && typeof p.foundAt === "object") {
		for (const [k, v] of Object.entries(p.foundAt)) {
			const id = Number(k);
			if (Number.isFinite(id) && state.found.has(id) && typeof v === "number" && Number.isInteger(v) && v > 0) {
				state.foundAt.set(id, v);
			}
		}
	}
	clearFoundUndo();
}

export function writeFoundToProfile(p: { found: number[]; foundAt?: Record<string, number> }): void {
	p.found = [...state.found];
	const out: Record<string, number> = {};
	let count = 0;
	for (const id of state.found) {
		const at = state.foundAt?.get(id);
		if (typeof at === "number" && Number.isInteger(at) && at > 0) {
			out[String(id)] = at;
			count++;
		}
	}
	if (count > 0) p.foundAt = out;
	else delete p.foundAt;
}

export function formatFoundToast(rec: FoundChangeRecord): string {
	const n = rec.ids.length;
	if (n === 1) return rec.on ? "Marked as found" : "Marked as not found";
	return rec.on ? `Marked ${n} as found` : `Marked ${n} as not found`;
}

export function notifyFoundChange(rec: FoundChangeRecord | null, onUndo: (rec: FoundChangeRecord) => void): void {
	if (!rec) return;
	toast(formatFoundToast(rec), 6000, {
		label: "Undo",
		onClick: () => {
			const undone = undoFoundChange();
			if (undone) onUndo(undone);
		},
	});
}