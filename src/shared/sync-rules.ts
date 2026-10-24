// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// sync-rules.ts: the one definition of what counts as a change when profiles are synced. The server (api.ts) and the
// browser (sync.ts) both import it, so they cannot disagree about whether two copies of an item are the same.
//
// Three questions, three keys:
//   stable(v)        the canonical JSON text of a value (keys sorted, undefined dropped)
//   contentKey(k,v)  the content of an item: what a conflict is about. Position (map, camera) and the touch time are left out,
//                    so moving the view never looks like an edit to someone else's progress
//   sendKey(k,v)     whether an item needs sending: everything except the touch time (saving without a change is not a change)

export const TOUCH_FIELD = "updated"; // when the profile was last saved
export const POSITION_FIELDS = [TOUCH_FIELD, "map", "cameras"]; // where the view is: last write wins, never a conflict

export function stable(v: unknown): string {
	if (v && typeof v === "object") {
		if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
		const obj = v as Record<string, unknown>;
		return `{${Object.keys(obj)
			.sort()
			.filter((k) => obj[k] !== undefined)
			.map((k) => JSON.stringify(k) + ":" + stable(obj[k]))
			.join(",")}}`;
	}
	return JSON.stringify(v ?? null);
}

// profile records lose the listed fields; other items (meta) are compared whole
function without(key: string, v: unknown, fields: string[]): unknown {
	if (!key.startsWith("profile:") || !v || typeof v !== "object" || Array.isArray(v)) return v;
	return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !fields.includes(k)));
}

export const contentKey = (key: string, v: unknown): string => stable(without(key, v, POSITION_FIELDS));
export const sendKey = (key: string, v: unknown): string => stable(without(key, v, [TOUCH_FIELD]));

// FNV-1a over a string: enough to tell whether something changed, and small to keep in the sync state
export function fnv(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}