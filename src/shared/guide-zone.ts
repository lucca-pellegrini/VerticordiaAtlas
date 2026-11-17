// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Pure Guide v1 zone and exception geometry helpers shared by follow mode, editor, and tests.

import { closeRing, sanitizeGeometry } from "./geometry.ts";
import { MAX_POLYGON_POINTS } from "./guide.ts";
import type { GuideTarget, GuideZone } from "./types.ts";

export interface ZonePoint {
	lng: number;
	lat: number;
}

export interface ZoneMarkerCoord {
	lng: number;
	lat: number;
	map?: string;
	title?: string;
}

export interface ZoneMapPoint {
	x: number;
	y: number;
}

export interface SelectionShapeInput {
	shape: "box" | "ellipse" | "free";
	pts: readonly ZonePoint[];
	circle?: boolean;
}

export interface ResolvedZoneGeometry {
	onCurrentMap: boolean;
	areaFeatures: any[];
	avoidAreaFeatures: any[];
	avoidMarkerFeatures: any[];
	bounds: [number, number, number, number] | null;
	centroid: [number, number] | null;
}

export type StepCameraFit =
	{ kind: "bounds"; bounds: [[number, number], [number, number]] } | { kind: "point"; lng: number; lat: number };

const EMPTY_ZONE_GEO: ResolvedZoneGeometry = {
	onCurrentMap: false,
	areaFeatures: [],
	avoidAreaFeatures: [],
	avoidMarkerFeatures: [],
	bounds: null,
	centroid: null,
};

function expandBoundsFromRing(
	bounds: [number, number, number, number] | null,
	ring: readonly number[][],
): [number, number, number, number] | null {
	let b = bounds;
	for (const pt of ring) {
		if (!Array.isArray(pt) || pt.length < 2) continue;
		const lng = pt[0]!;
		const lat = pt[1]!;
		if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
		if (!b) b = [lng, lat, lng, lat];
		else {
			if (lng < b[0]) b[0] = lng;
			if (lat < b[1]) b[1] = lat;
			if (lng > b[2]) b[2] = lng;
			if (lat > b[3]) b[3] = lat;
		}
	}
	return b;
}

function expandBoundsFromGeometry(
	bounds: [number, number, number, number] | null,
	geom: any,
): [number, number, number, number] | null {
	if (!geom || typeof geom !== "object") return bounds;
	let b = bounds;
	if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
		for (const ring of geom.coordinates) {
			if (Array.isArray(ring)) b = expandBoundsFromRing(b, ring);
		}
	} else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
		for (const poly of geom.coordinates) {
			if (!Array.isArray(poly)) continue;
			for (const ring of poly) {
				if (Array.isArray(ring)) b = expandBoundsFromRing(b, ring);
			}
		}
	}
	return b;
}

/**
 * Deduplicates consecutive identical coordinates and uniformly downsamples long polygons
 * to stay within `maxPoints` while preserving perimeter extremes cleanly.
 */
export function clampPolygonPoints(pts: readonly ZonePoint[], maxPoints = MAX_POLYGON_POINTS): ZonePoint[] {
	const dedup: ZonePoint[] = [];
	for (const pt of pts) {
		if (!pt || !Number.isFinite(pt.lng) || !Number.isFinite(pt.lat)) continue;
		const prev = dedup[dedup.length - 1];
		if (!prev || prev.lng !== pt.lng || prev.lat !== pt.lat) {
			dedup.push({ lng: pt.lng, lat: pt.lat });
		}
	}
	// Drop explicit closing duplicate before clamping so resampling stays evenly distributed
	if (dedup.length > 3) {
		const first = dedup[0]!;
		const last = dedup[dedup.length - 1]!;
		if (first.lng === last.lng && first.lat === last.lat) dedup.pop();
	}
	if (dedup.length < 3) return [];
	if (dedup.length <= maxPoints) return dedup;

	const cap = Math.max(3, maxPoints);
	const out: ZonePoint[] = [];
	let prevIdx = -1;
	for (let i = 0; i < cap; i++) {
		const idx = Math.min(dedup.length - 1, Math.round((i * (dedup.length - 1)) / (cap - 1)));
		if (idx !== prevIdx) {
			out.push(dedup[idx]!);
			prevIdx = idx;
		}
	}
	return out.length >= 3 ? out : dedup.slice(0, cap);
}

/** Converts ZonePoint array into a closed GeoJSON linear ring (`number[][]`). */
export function polygonToRing(pts: readonly ZonePoint[]): number[][] {
	const cleaned = clampPolygonPoints(pts);
	if (cleaned.length < 3) return [];
	return closeRing(cleaned.map((p) => [p.lng, p.lat]));
}

/**
 * Converts a selection tool shape (box, ellipse/circle, or freehand polygon) into a
 * bounded polygon (`ZonePoint[]`) in map coordinates.
 */
export function selectionShapeToPolygon(
	sel: SelectionShapeInput,
	project: (p: ZonePoint) => ZoneMapPoint,
	unproject: (pt: ZoneMapPoint) => ZonePoint,
	ellipseSteps = 48,
): ZonePoint[] {
	if (!sel || !Array.isArray(sel.pts)) return [];
	if (sel.shape === "free") {
		return clampPolygonPoints(sel.pts);
	}
	if (sel.pts.length < 2) return [];
	const a = project(sel.pts[0]!);
	const b = project(sel.pts[1]!);
	if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
		return [];
	}

	if (sel.shape === "box") {
		const x0 = Math.min(a.x, b.x);
		const x1 = Math.max(a.x, b.x);
		const y0 = Math.min(a.y, b.y);
		const y1 = Math.max(a.y, b.y);
		if (x1 - x0 < 2 || y1 - y0 < 2) return [];
		return clampPolygonPoints([
			unproject({ x: x0, y: y0 }),
			unproject({ x: x1, y: y0 }),
			unproject({ x: x1, y: y1 }),
			unproject({ x: x0, y: y1 }),
		]);
	}

	// Ellipse (or shift-constrained circle) around center `a` with rim `b`
	const rx = sel.circle ? Math.hypot(b.x - a.x, b.y - a.y) : Math.abs(b.x - a.x);
	const ry = sel.circle ? rx : Math.abs(b.y - a.y);
	if (rx < 2 || ry < 2) return [];
	const n = Math.max(12, Math.min(MAX_POLYGON_POINTS, Math.round(ellipseSteps)));
	const pts: ZonePoint[] = [];
	for (let i = 0; i < n; i++) {
		const t = (i / n) * Math.PI * 2;
		pts.push(unproject({ x: a.x + rx * Math.cos(t), y: a.y + ry * Math.sin(t) }));
	}
	return clampPolygonPoints(pts);
}

/** Resolves a `GuideZone` into GeoJSON features, bounding box, and centroid on `curMap`. */
export function resolveZoneGeometry(
	zone: GuideZone | undefined | null,
	curMap: string,
	regionById: ReadonlyMap<number, any>,
	lookupMarker: (id: number) => ZoneMarkerCoord | null,
): ResolvedZoneGeometry {
	if (!zone || (zone.map && zone.map !== curMap)) {
		return EMPTY_ZONE_GEO;
	}

	const areaFeatures: any[] = [];
	const avoidAreaFeatures: any[] = [];
	const avoidMarkerFeatures: any[] = [];
	let bounds: [number, number, number, number] | null = null;
	let fallbackCentroid: [number, number] | null = null;

	if (zone.region != null) {
		const reg = regionById.get(zone.region);
		if (reg && Array.isArray(reg.features)) {
			for (const f of reg.features) {
				const geom = f?.geometry;
				if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;
				const clean = sanitizeGeometry(geom);
				if (!clean?.coordinates?.length) continue;
				areaFeatures.push({
					type: "Feature",
					geometry: clean,
					properties: { kind: "region", regionId: zone.region, title: reg.title || "" },
				});
				bounds = expandBoundsFromGeometry(bounds, clean);
			}
		}
		if (reg) {
			const cx = typeof reg.center_x === "number" ? reg.center_x : parseFloat(reg.center_x);
			const cy = typeof reg.center_y === "number" ? reg.center_y : parseFloat(reg.center_y);
			if (Number.isFinite(cx) && Number.isFinite(cy)) {
				fallbackCentroid = [cx, cy];
			}
		}
	}

	if (zone.polygon) {
		const ring = polygonToRing(zone.polygon);
		if (ring.length >= 4) {
			const geom = { type: "Polygon", coordinates: [ring] };
			areaFeatures.push({
				type: "Feature",
				geometry: geom,
				properties: { kind: "polygon" },
			});
			bounds = expandBoundsFromRing(bounds, ring);
		}
	}

	const avoid = zone.avoid || [];
	for (let ai = 0; ai < avoid.length; ai++) {
		const item = avoid[ai]!;
		let polyCenter: [number, number] | null = null;
		if (item.polygon) {
			const ring = polygonToRing(item.polygon);
			if (ring.length >= 4) {
				const polyBounds = expandBoundsFromRing(null, ring);
				if (polyBounds) {
					polyCenter = [(polyBounds[0] + polyBounds[2]) / 2, (polyBounds[1] + polyBounds[3]) / 2];
					if (areaFeatures.length === 0) bounds = expandBoundsFromRing(bounds, ring);
				}
				avoidAreaFeatures.push({
					type: "Feature",
					geometry: { type: "Polygon", coordinates: [ring] },
					properties: { avoidIndex: ai, note: item.note },
				});
			}
		}
		if (item.marker !== undefined) {
			const loc = lookupMarker(item.marker);
			if (loc && (!loc.map || loc.map === curMap) && Number.isFinite(loc.lng) && Number.isFinite(loc.lat)) {
				avoidMarkerFeatures.push({
					type: "Feature",
					geometry: { type: "Point", coordinates: [loc.lng, loc.lat] },
					properties: {
						avoidIndex: ai,
						markerId: item.marker,
						title: loc.title || `Marker #${item.marker}`,
						note: item.note,
					},
				});
				if (!bounds && !polyCenter) bounds = [loc.lng, loc.lat, loc.lng, loc.lat];
			}
		}
	}

	const centroid: [number, number] | null = bounds
		? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
		: fallbackCentroid;

	return {
		onCurrentMap: true,
		areaFeatures,
		avoidAreaFeatures,
		avoidMarkerFeatures,
		bounds,
		centroid,
	};
}

/**
 * Computes camera target (bounding box or single point) for a step considering
 * both its targets and its `zone` on `curMap`.
 */
export function computeStepCameraFit(
	targets: readonly GuideTarget[] | undefined,
	zone: GuideZone | undefined,
	curMap: string,
	regionById: ReadonlyMap<number, any>,
	lookupMarker: (id: number) => ZoneMarkerCoord | null,
): StepCameraFit | null {
	let bounds: [number, number, number, number] | null = null;
	const zoneGeo = resolveZoneGeometry(zone, curMap, regionById, lookupMarker);
	if (zoneGeo.bounds) {
		bounds = [...zoneGeo.bounds];
	} else if (zoneGeo.centroid) {
		const [cx, cy] = zoneGeo.centroid;
		bounds = [cx, cy, cx, cy];
	}

	const addPt = (lng: number, lat: number) => {
		if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
		if (!bounds) bounds = [lng, lat, lng, lat];
		else {
			if (lng < bounds[0]) bounds[0] = lng;
			if (lat < bounds[1]) bounds[1] = lat;
			if (lng > bounds[2]) bounds[2] = lng;
			if (lat > bounds[3]) bounds[3] = lat;
		}
	};

	for (const t of targets || []) {
		if (t.kind === "marker") {
			const loc = lookupMarker(t.marker);
			if (loc && (!loc.map || loc.map === curMap)) {
				addPt(loc.lng, loc.lat);
			} else if (!loc && t.snapshot && (!t.snapshot.map || t.snapshot.map === curMap)) {
				addPt(t.snapshot.lng, t.snapshot.lat);
			}
		} else if (t.kind === "point" && (!t.point.map || t.point.map === curMap)) {
			addPt(t.point.lng, t.point.lat);
		}
	}

	if (!bounds) return null;
	const spanLng = Math.abs(bounds[2] - bounds[0]);
	const spanLat = Math.abs(bounds[3] - bounds[1]);
	if (spanLng > 1e-6 || spanLat > 1e-6) {
		return {
			kind: "bounds",
			bounds: [
				[bounds[0], bounds[1]],
				[bounds[2], bounds[3]],
			],
		};
	}
	return { kind: "point", lng: bounds[0], lat: bounds[1] };
}

/** Computes a focus target (point or bounds) for an individual zone `avoid` entry on `curMap`. */
export function resolveAvoidEntryFocus(
	item: NonNullable<GuideZone["avoid"]>[number],
	zoneMap: string,
	curMap: string,
	lookupMarker: (id: number) => ZoneMarkerCoord | null,
): StepCameraFit | null {
	if (zoneMap && zoneMap !== curMap) return null;
	if (item.polygon) {
		const ring = polygonToRing(item.polygon);
		const b = expandBoundsFromRing(null, ring);
		if (b && (Math.abs(b[2] - b[0]) > 1e-6 || Math.abs(b[3] - b[1]) > 1e-6)) {
			return {
				kind: "bounds",
				bounds: [
					[b[0], b[1]],
					[b[2], b[3]],
				],
			};
		}
	}
	if (item.marker !== undefined) {
		const loc = lookupMarker(item.marker);
		if (loc && (!loc.map || loc.map === curMap)) {
			return { kind: "point", lng: loc.lng, lat: loc.lat };
		}
	}
	return null;
}