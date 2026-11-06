// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/**
 * Deduplicate consecutive identical coordinates and ensure a linear ring is closed
 * per GeoJSON RFC 7946 §3.1.6 (first and last positions must be identical).
 */
export function closeRing(ring: number[][]): number[][] {
	if (!Array.isArray(ring) || ring.length === 0) return ring;
	const dedup: number[][] = [];
	for (let i = 0; i < ring.length; i++) {
		const pt = ring[i];
		if (!Array.isArray(pt) || pt.length < 2) continue;
		const prev = dedup[dedup.length - 1];
		if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
			dedup.push([pt[0], pt[1]]);
		}
	}
	if (dedup.length < 3) return dedup;
	const first = dedup[0];
	const last = dedup[dedup.length - 1];
	if (first[0] !== last[0] || first[1] !== last[1]) {
		dedup.push([first[0], first[1]]);
	}
	return dedup;
}

/**
 * Normalizes GeoJSON geometry objects by closing open polygon rings and removing
 * consecutive identical vertices across Polygons, MultiPolygons, and LineStrings.
 */
export function sanitizeGeometry(geom: any): any {
	if (!geom || typeof geom !== "object") return geom;
	const type = geom.type;
	if (type === "Polygon") {
		if (!Array.isArray(geom.coordinates)) return geom;
		const cleanedRings = (geom.coordinates as number[][][]).map(closeRing).filter((r) => r.length >= 4);
		return { ...geom, coordinates: cleanedRings };
	}
	if (type === "MultiPolygon") {
		if (!Array.isArray(geom.coordinates)) return geom;
		const cleanedPolys = (geom.coordinates as number[][][][])
			.map((poly) => (Array.isArray(poly) ? poly.map(closeRing).filter((r) => r.length >= 4) : poly))
			.filter((poly) => poly.length > 0);
		return { ...geom, coordinates: cleanedPolys };
	}
	if (type === "LineString") {
		if (!Array.isArray(geom.coordinates)) return geom;
		const dedup: number[][] = [];
		for (const pt of geom.coordinates as number[][]) {
			if (!Array.isArray(pt) || pt.length < 2) continue;
			const prev = dedup[dedup.length - 1];
			if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
				dedup.push([pt[0], pt[1]]);
			}
		}
		return { ...geom, coordinates: dedup };
	}
	if (type === "MultiLineString") {
		if (!Array.isArray(geom.coordinates)) return geom;
		const cleanedLines = (geom.coordinates as number[][][]).map((line) => {
			if (!Array.isArray(line)) return line;
			const dedup: number[][] = [];
			for (const pt of line) {
				if (!Array.isArray(pt) || pt.length < 2) continue;
				const prev = dedup[dedup.length - 1];
				if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
					dedup.push([pt[0], pt[1]]);
				}
			}
			return dedup;
		});
		return { ...geom, coordinates: cleanedLines };
	}
	return geom;
}

/**
 * Normalizes all region and location feature geometries inside a mapData object.
 * Returns true if any geometry was modified.
 */
export function sanitizeMapData(data: any): boolean {
	if (!data || typeof data !== "object") return false;
	let changed = false;

	if (Array.isArray(data.regions)) {
		for (const r of data.regions) {
			if (!r || !Array.isArray(r.features)) continue;
			for (const f of r.features) {
				if (!f?.geometry) continue;
				const before = JSON.stringify(f.geometry);
				f.geometry = sanitizeGeometry(f.geometry);
				if (JSON.stringify(f.geometry) !== before) changed = true;
			}
		}
	}

	if (Array.isArray(data.locations)) {
		for (const loc of data.locations) {
			if (!loc || !Array.isArray(loc.features)) continue;
			for (const f of loc.features) {
				if (!f?.geometry) continue;
				const before = JSON.stringify(f.geometry);
				f.geometry = sanitizeGeometry(f.geometry);
				if (JSON.stringify(f.geometry) !== before) changed = true;
			}
		}
	}

	return changed;
}