// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// sync-rules.ts: the one definition of what counts as a change when profiles are synced. The server (api.ts) and the
// browser (sync.ts) both import it, so they cannot disagree about whether two copies of an item are the same.
//
// Three questions, three keys:
//   stable(v)        the canonical JSON text of a value (keys sorted, undefined dropped)
//   contentKey(k,v)  the content of an item: what a conflict is about. Position (map, camera), advisory metadata (foundAt),
//                    and the touch time are left out, so moving the view or differing find timestamps never look like a
//                    conflict between devices
//   sendKey(k,v)     whether an item needs sending: everything except the touch time (saving without a change is not a
//                    change, and foundAt still replicates to other devices)

export const TOUCH_FIELD = "updated"; // when the profile or guide was last saved
export const POSITION_FIELDS = [TOUCH_FIELD, "map", "cameras"]; // where the view is: last write wins, never a conflict
export const METADATA_FIELDS = ["foundAt"]; // advisory per-marker find timestamps: replicated, never a conflict
export const CONTENT_IGNORED_FIELDS = [...POSITION_FIELDS, ...METADATA_FIELDS];
export const GUIDE_PROGRESS_VOLATILE_FIELDS = ["cursor", "variants", TOUCH_FIELD]; // view/position inside a guide: replicated, never a conflict

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

function cleanGuidesForKey(guides: unknown, ignoredNestedFields: string[]): Record<string, unknown> | undefined {
	if (!guides || typeof guides !== "object" || Array.isArray(guides)) return undefined;
	const out: Record<string, unknown> = {};
	let count = 0;
	for (const [gid, rawProg] of Object.entries(guides as Record<string, unknown>)) {
		if (!rawProg || typeof rawProg !== "object" || Array.isArray(rawProg)) continue;
		const progEntries = Object.entries(rawProg as Record<string, unknown>).filter(([k, val]) => {
			if (ignoredNestedFields.includes(k) || val === undefined) return false;
			if (k === "done" && val && typeof val === "object" && !Array.isArray(val)) {
				return Object.keys(val as Record<string, unknown>).length > 0;
			}
			if (k === "skipped" && Array.isArray(val)) {
				return val.length > 0;
			}
			if (k === "variants" && val && typeof val === "object" && !Array.isArray(val)) {
				return Object.keys(val as Record<string, unknown>).length > 0;
			}
			return true;
		});
		if (progEntries.length > 0) {
			out[gid] = Object.fromEntries(progEntries);
			count++;
		}
	}
	return count > 0 ? out : undefined;
}

// profile records lose the listed fields (plus volatile nested guide progress fields); guide records lose `updated`;
// other items (meta) are compared whole
function without(key: string, v: unknown, fields: string[], stripGuideVolatile = false): unknown {
	if (!v || typeof v !== "object" || Array.isArray(v)) return v;
	if (key.startsWith("guide:")) {
		return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !fields.includes(k)));
	}
	if (!key.startsWith("profile:")) return v;
	const entries: [string, unknown][] = [];
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (fields.includes(k)) continue;
		if (k === "guides") {
			const cleaned = cleanGuidesForKey(val, stripGuideVolatile ? GUIDE_PROGRESS_VOLATILE_FIELDS : [TOUCH_FIELD]);
			if (cleaned !== undefined) entries.push(["guides", cleaned]);
			continue;
		}
		entries.push([k, val]);
	}
	return Object.fromEntries(entries);
}

export const contentKey = (key: string, v: unknown): string => stable(without(key, v, CONTENT_IGNORED_FIELDS, true));
export const sendKey = (key: string, v: unknown): string => stable(without(key, v, [TOUCH_FIELD], false));

// FNV-1a over a string: enough to tell whether something changed, and small to keep in the sync state
export function fnv(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}