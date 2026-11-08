// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- all-maps search index ----------
   Pure helpers (no DOM, no state). Only what a search needs is kept per location: id, title, its normalised form, the
   category (title, icon, colour), the map and the tags (the title is normalised by textOf() in search.ts when the index
   is built). No description, no media, no coordinates: the full map data is dropped once indexed. So a description
   never matches on another map, and its result shows none. */

import { locationsOf } from "../../shared/compact-map.ts";

export interface IndexEntry {
	l: { id: number; title: string; desc: string; tags: number[] };
	slug: string;
	catId: number;
	cat: any;
	col: string | undefined;
}

// the entries of one map; `colorOf` turns a group colour into the one the sidebar shows
export function indexMap(slug: string, data: any, colorOf: (c: string) => string): IndexEntry[] {
	const cats = new Map<number, any>(Object.values<any>(data.categories || {}).map((c) => [c.id, c]));
	const groupCol = new Map<number, string>((data.groups || []).map((g: any) => [g.id, colorOf(g.color)]));
	const out: IndexEntry[] = [];
	for (const d of locationsOf(data)) {
		// a location without a point is never listed
		if (!Number.isFinite(parseFloat(d.latitude)) || !Number.isFinite(parseFloat(d.longitude))) continue;
		const cat = cats.get(d.category_id);
		out.push({
			l: { id: d.id, title: d.title || "", desc: "", tags: d.tags || [] },
			slug,
			catId: d.category_id,
			cat: cat && { id: cat.id, title: cat.title, icon: cat.icon, color: cat.color, group_id: cat.group_id },
			col: groupCol.get(cat?.group_id),
		});
	}
	return out;
}

// the entries a search may match: another map than `cur`, in a category its saved view shows, found ones only when
// that view shows them. Order is the index's, which the ranking then sorts.
export function indexedOthers(
	index: IndexEntry[],
	cur: string,
	views: Record<string, any> | undefined,
	found: { has(id: number): boolean },
): IndexEntry[] {
	const hidden = new Map<string, Set<number>>();
	return index.filter((e) => {
		if (e.slug === cur) return false;
		const v = views?.[e.slug] || {};
		let h = hidden.get(e.slug);
		if (!h) hidden.set(e.slug, (h = new Set<number>(v.hidden || [])));
		return !h.has(e.catId) && !(v.hideFound && found.has(e.l.id));
	});
}