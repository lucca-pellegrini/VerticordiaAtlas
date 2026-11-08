// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- compact map payload (version 1) ----------
   Pure, isomorphic. A map's data.json stays the source for server cards and tooling. From it a build step derives two
   files beside it: data.compact.json (the client's first payload) and data.details.json (fetched when a detail card,
   the link graph or a search needs descriptions and media).

   Compact: every key of data.json except `locations`, plus `v` and `locs`, the locations as parallel arrays:
   i id, c category_id, r region_id, t title, y latitude, x longitude (numbers; null if not a number), g tags,
   f features. Fields no client code reads (map_id, ign_page_id) are dropped.
   Details: { v, d: { [locationId]: [description, media] } }, only for locations that have either. */

export const COMPACT_VERSION = 1;

export interface CompactLocs {
	i: number[];
	c: number[];
	r: (number | null)[];
	t: string[];
	y: (number | null)[];
	x: (number | null)[];
	g: number[][];
	f: any[];
}
export interface CompactMap {
	v: number;
	locs: CompactLocs;
	[key: string]: any;
}
export interface MapDetails {
	v: number;
	d: Record<string, [string, any[]]>;
}

// the compact and details files that belong to a data.json path or URL
export const compactPath = (dataPath: string): string => dataPath.replace(/\.json$/, ".compact.json");
export const detailsPath = (dataPath: string): string => dataPath.replace(/\.json$/, ".details.json");

export const isCompact = (data: any): data is CompactMap =>
	!!data && data.v === COMPACT_VERSION && !!data.locs && Array.isArray(data.locs.i);

// null for anything parseFloat cannot read: such a location is never shown
const num = (s: unknown): number | null => {
	const n = parseFloat(s as string);
	return Number.isFinite(n) ? n : null;
};

export function toCompact(data: any): { compact: CompactMap; details: MapDetails } {
	const { locations, ...rest } = data;
	const locs: CompactLocs = { i: [], c: [], r: [], t: [], y: [], x: [], g: [], f: [] };
	const details: MapDetails = { v: COMPACT_VERSION, d: {} };
	for (const l of locations || []) {
		locs.i.push(l.id);
		locs.c.push(l.category_id);
		locs.r.push(l.region_id ?? null);
		locs.t.push(l.title || "");
		locs.y.push(num(l.latitude));
		locs.x.push(num(l.longitude));
		locs.g.push(l.tags || []);
		locs.f.push(l.features || null);
		const media = l.media || [];
		if (l.description || media.length) details.d[l.id] = [l.description || "", media];
	}
	return { compact: { ...rest, v: COMPACT_VERSION, locs }, details };
}

// the client's location records (the shape of state.locs) from a compact map; unplaced ones are left out, as before
export function locsOfCompact(c: CompactMap, iconOf: (cat: number) => string | undefined): any[] {
	const { i, c: cat, r, t, y, x, g, f } = c.locs;
	const out: any[] = [];
	for (let k = 0; k < i.length; k++) {
		const lat = y[k],
			lng = x[k];
		if (lat == null || lng == null) continue;
		out.push({
			id: i[k],
			cat: cat[k],
			region: r[k],
			title: t[k] || "",
			desc: "",
			lat,
			lng,
			tags: g[k] || [],
			media: [],
			icon: iconOf(cat[k]),
			features: f[k] || null,
		});
	}
	return out;
}

// the data.json locations of a map in either format (descriptions and media only when `details` is given)
export function locationsOf(data: any, details?: MapDetails | null): any[] {
	if (!isCompact(data)) return data?.locations || [];
	const { i, c, r, t, y, x, g, f } = data.locs;
	return i.map((id, k) => {
		const d = details?.d[id];
		return {
			id,
			region_id: r[k],
			category_id: c[k],
			title: t[k],
			description: d?.[0] || null,
			latitude: y[k],
			longitude: x[k],
			features: f[k],
			tags: g[k],
			media: d?.[1] || [],
		};
	});
}

// data.json shape again; the round trip keeps every field the client reads
export function fromCompact(c: CompactMap, details?: MapDetails | null): any {
	const { v, locs, ...rest } = c;
	return { ...rest, locations: locationsOf(c, details) };
}