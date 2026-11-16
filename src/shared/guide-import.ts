// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Pure URL parsing and text-to-steps helpers for guide authoring and importing (extended with name resolution in M5).

import { GAME_ID_PATTERN, MAX_GUIDE_STEPS, MAX_MAP_SLUG, MAX_STEP_TARGETS, MAX_STEP_TITLE } from "./guide.ts";
import type { GuideStep, GuideTarget, StepKind } from "./types.ts";

export interface ParsedMarkerLink {
	markerId: number;
	mapSlug?: string;
}

// Parses a marker reference from "#loc=<id>", "?loc=<id>", "?locationIds=<id>", or an HTTP(S) URL carrying one of those.
export function parseMarkerLink(href: string): ParsedMarkerLink | null {
	const raw = String(href || "").trim();
	if (!raw) return null;

	const frag = /^#loc=(\d+)$/i.exec(raw);
	if (frag) {
		const id = Number(frag[1]);
		return Number.isSafeInteger(id) && id > 0 ? { markerId: id } : null;
	}

	let u: URL;
	try {
		u = new URL(raw, "https://atlas.verticordia.com/");
	} catch {
		return null;
	}

	if (u.protocol !== "http:" && u.protocol !== "https:") return null;

	let markerId: number | null = null;
	const hashMatch = /^#loc=(\d+)$/i.exec(u.hash);
	if (hashMatch) {
		markerId = Number(hashMatch[1]);
	} else {
		const locParam = u.searchParams.get("loc") || u.searchParams.get("locationIds") || "";
		const m = /^(\d+)/.exec(locParam.trim());
		if (m) markerId = Number(m[1]);
	}

	if (markerId === null || !Number.isSafeInteger(markerId) || markerId <= 0) return null;

	let mapSlug: string | undefined;
	const mapQuery = u.searchParams.get("map")?.trim();
	if (mapQuery && GAME_ID_PATTERN.test(mapQuery.slice(0, MAX_MAP_SLUG))) {
		mapSlug = mapQuery.slice(0, MAX_MAP_SLUG);
	} else {
		const segs = u.pathname.split("/").filter(Boolean);
		const mapsIdx = segs.indexOf("maps");
		if (mapsIdx >= 0 && segs[mapsIdx + 1]) {
			const candidate = decodeURIComponent(segs[mapsIdx + 1]!);
			if (GAME_ID_PATTERN.test(candidate.slice(0, MAX_MAP_SLUG))) {
				mapSlug = candidate.slice(0, MAX_MAP_SLUG);
			}
		}
	}

	return mapSlug ? { markerId, mapSlug } : { markerId };
}

// Extracts unique marker ids from `#loc=<id>`, `locationIds=<id>`, or `?loc=<id>` links within a line or block of text.
export function extractMarkerLinksFromText(text: string): number[] {
	const raw = String(text || "");
	const ids: number[] = [];
	const seen = new Set<number>();
	const pattern = /(?:#loc=(\d+)|[?&](?:locationIds|loc)=(\d+))/gi;
	let m: RegExpExecArray | null;
	while ((m = pattern.exec(raw)) !== null) {
		const id = Number(m[1] || m[2]);
		if (Number.isSafeInteger(id) && id > 0 && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
			if (ids.length >= MAX_STEP_TARGETS) break;
		}
	}
	return ids;
}

// Converts pasted plain-text or markdown list lines into guide steps (one step per non-empty line).
export function linesToSteps(
	text: string,
	opts?: {
		kind?: StepKind;
		makeId?: (index: number) => string;
	},
): GuideStep[] {
	const lines = String(text || "").split(/\r?\n/);
	const steps: GuideStep[] = [];
	const kind: StepKind = opts?.kind ?? "task";

	for (const rawLine of lines) {
		if (steps.length >= MAX_GUIDE_STEPS) break;
		let line = rawLine.trim();
		if (!line) continue;

		// Strip leading list bullets (-, *, +, •), numbered prefixes (1., 1)), and markdown checkboxes ([ ], [x])
		line = line
			.replace(/^(?:[-*+•]|\d+[.)])\s+/, "")
			.replace(/^\[[ xX]?\]\s+/, "")
			.trim();
		if (!line) continue;

		const markerIds = extractMarkerLinksFromText(line);
		// Replace markdown links `[label](url)` with `label` for the clean step title
		const cleanTitle = line
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, MAX_STEP_TITLE);

		const title = cleanTitle || `Step ${steps.length + 1}`;
		const idx = steps.length;
		const id = opts?.makeId ? opts.makeId(idx) : `step-${idx + 1}`;
		const targets: GuideTarget[] | undefined =
			markerIds.length > 0 ? markerIds.map((marker) => ({ kind: "marker" as const, marker })) : undefined;

		steps.push({
			id,
			kind,
			title,
			...(targets ? { targets } : {}),
		});
	}

	return steps;
}

export function pointInRingGeo(lng: number, lat: number, ring: number[][]): boolean {
	if (!Array.isArray(ring) || ring.length < 3) return false;
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i]![0]!,
			yi = ring[i]![1]!;
		const xj = ring[j]![0]!,
			yj = ring[j]![1]!;
		const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function pointInPolyRings(lng: number, lat: number, rings: number[][][]): boolean {
	if (!rings.length || !pointInRingGeo(lng, lat, rings[0]!)) return false;
	for (let i = 1; i < rings.length; i++) {
		if (pointInRingGeo(lng, lat, rings[i]!)) return false;
	}
	return true;
}

export function pointInGeoGeometry(lng: number, lat: number, geom: any): boolean {
	if (!geom || !Array.isArray(geom.coordinates)) return false;
	if (geom.type === "Polygon") {
		return pointInPolyRings(lng, lat, geom.coordinates as number[][][]);
	}
	if (geom.type === "MultiPolygon") {
		for (const poly of geom.coordinates as number[][][][]) {
			if (pointInPolyRings(lng, lat, poly)) return true;
		}
	}
	return false;
}

// Best-effort region title suggestion for a lasso selection of markers.
// Never blocks: falls back cleanly if markers lack regions or polygon geometry is missing.
export function suggestRegionTitle(
	markers: readonly { region?: number | null; lng: number; lat: number }[],
	regions: readonly any[],
	regionById: ReadonlyMap<number, any>,
	fallbackTitle?: string,
): string {
	const fallback =
		fallbackTitle || (markers.length > 0 ? `Selected area (${markers.length} targets)` : "Selected area");
	if (!markers.length) return fallback;

	// 1. Majority vote on explicit marker region assignments
	const counts = new Map<number, number>();
	for (const m of markers) {
		if (m.region != null && regionById.has(m.region)) {
			counts.set(m.region, (counts.get(m.region) || 0) + 1);
		}
	}
	if (counts.size > 0) {
		let bestId = -1;
		let bestCount = -1;
		for (const [id, count] of counts) {
			if (count > bestCount) {
				bestCount = count;
				bestId = id;
			}
		}
		const reg = regionById.get(bestId);
		if (reg?.title) return String(reg.title).slice(0, MAX_STEP_TITLE);
	}

	// 2. Fallback to polygon containment at the selection centroid (prefer subregions over parents)
	let sumLng = 0;
	let sumLat = 0;
	let validPts = 0;
	for (const m of markers) {
		if (Number.isFinite(m.lng) && Number.isFinite(m.lat)) {
			sumLng += m.lng;
			sumLat += m.lat;
			validPts++;
		}
	}
	if (validPts > 0 && regions.length > 0) {
		const cx = sumLng / validPts;
		const cy = sumLat / validPts;
		let matchedParent: any = null;
		for (const r of regions) {
			if (!Array.isArray(r?.features) || !r.title) continue;
			const contains = r.features.some((f: any) => pointInGeoGeometry(cx, cy, f?.geometry));
			if (!contains) continue;
			if (r.parent_region_id) return String(r.title).slice(0, MAX_STEP_TITLE);
			if (!matchedParent) matchedParent = r;
		}
		if (matchedParent?.title) return String(matchedParent.title).slice(0, MAX_STEP_TITLE);
	}

	return fallback;
}