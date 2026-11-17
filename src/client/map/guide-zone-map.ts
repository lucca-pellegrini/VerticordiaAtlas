// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Shared offline MapLibre renderer for guide step zones and hatched exceptions (loaded lazily by follow & editor).

import { resolveZoneGeometry, type ZoneMarkerCoord } from "../../shared/guide-zone.ts";
import type { GuideZone } from "../../shared/types.ts";

export interface ZoneThemeColors {
	accent: string;
	accentSoft: string;
	panel: string;
	night: string;
	err: string;
}

const emptyFC = { type: "FeatureCollection" as const, features: [] as any[] };
const hatchCache = new Map<string, ImageData>();
const avoidPinCache = new Map<string, ImageData>();
const wiredZoneMaps = new WeakSet<object>();
const activePopups = new WeakMap<object, any>();
const mapToolFns = new WeakMap<object, () => string>();

function parseHexRgb(hex: string): [number, number, number] {
	const clean = hex.trim().replace(/^#/, "");
	if (/^[0-9a-fA-F]{6}$/.test(clean)) {
		return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
	}
	if (/^[0-9a-fA-F]{3}$/.test(clean)) {
		return [
			parseInt(clean[0]! + clean[0]!, 16),
			parseInt(clean[1]! + clean[1]!, 16),
			parseInt(clean[2]! + clean[2]!, 16),
		];
	}
	return [239, 68, 68];
}

/** Generates a seamless tileable diagonal hatch pattern without external image assets. */
export function renderHatchPatternImageData(colorHex = "#ef4444", size = 24): ImageData | null {
	const key = `${colorHex}|${size}`;
	const hit = hatchCache.get(key);
	if (hit) return hit;
	if (typeof document === "undefined") return null;

	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const g = c.getContext("2d");
	if (!g) return null;

	const [r, gr, b] = parseHexRgb(colorHex);
	g.fillStyle = `rgba(${r}, ${gr}, ${b}, 0.14)`;
	g.fillRect(0, 0, size, size);

	g.strokeStyle = `rgba(${r}, ${gr}, ${b}, 0.72)`;
	g.lineWidth = 2.5;
	g.lineCap = "square";

	// Tile 45-degree stripes across neighbors (-size..+2*size) for seamless pattern wrapping
	const step = size / 2;
	g.beginPath();
	for (let offset = -size; offset <= size * 2; offset += step) {
		g.moveTo(offset, size);
		g.lineTo(offset + size, 0);
	}
	g.stroke();

	const img = g.getImageData(0, 0, size, size);
	hatchCache.set(key, img);
	return img;
}

/** Generates an offline hatched badge icon for marker-level zone exceptions. */
export function renderAvoidPinImageData(colorHex = "#ef4444", nightHex = "#0b0e10"): ImageData | null {
	const key = `${colorHex}|${nightHex}`;
	const hit = avoidPinCache.get(key);
	if (hit) return hit;
	if (typeof document === "undefined") return null;

	const size = 44;
	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const g = c.getContext("2d");
	if (!g) return null;

	const cx = size / 2;
	const cy = size / 2;
	const r = 16;
	const [red, green, blue] = parseHexRgb(colorHex);

	g.beginPath();
	g.arc(cx, cy, r + 2.5, 0, Math.PI * 2);
	g.fillStyle = nightHex || "#0b0e10";
	g.fill();

	g.save();
	g.beginPath();
	g.arc(cx, cy, r, 0, Math.PI * 2);
	g.clip();
	g.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.28)`;
	g.fillRect(0, 0, size, size);
	g.strokeStyle = `rgba(${red}, ${green}, ${blue}, 0.85)`;
	g.lineWidth = 2.5;
	g.beginPath();
	for (let d = -size; d <= size; d += 8) {
		g.moveTo(d, size);
		g.lineTo(d + size, 0);
	}
	g.stroke();
	g.restore();

	g.beginPath();
	g.arc(cx, cy, r, 0, Math.PI * 2);
	g.lineWidth = 2.4;
	g.strokeStyle = "#ffffff";
	g.stroke();

	// Crisp exclamation mark inside the hatched badge
	g.fillStyle = "#ffffff";
	g.fillRect(cx - 1.5, cy - 8, 3, 10);
	g.beginPath();
	g.arc(cx, cy + 6.5, 1.8, 0, Math.PI * 2);
	g.fill();

	const img = g.getImageData(0, 0, size, size);
	avoidPinCache.set(key, img);
	return img;
}

export function clearZonePopup(map: any): void {
	const existing = map ? activePopups.get(map) : null;
	if (existing && typeof existing.remove === "function") {
		existing.remove();
	}
	if (map) activePopups.delete(map);
}

function showAvoidNotePopup(map: any, lngLat: [number, number], title: string, note: string): void {
	const ml = (globalThis as any).maplibregl;
	if (!ml?.Popup) return;
	clearZonePopup(map);

	const el = document.createElement("div");
	el.className = "gz-popup";
	const head = document.createElement("div");
	head.className = "gz-popup-head";
	head.textContent = title ? `Avoid · ${title}` : "Exception";
	const body = document.createElement("div");
	body.className = "gz-popup-note";
	body.textContent = note;
	el.append(head, body);

	const popup = new ml.Popup({ closeButton: true, closeOnClick: false, className: "tip gz-tip", maxWidth: "260px" })
		.setLngLat(lngLat)
		.setDOMContent(el)
		.addTo(map);
	activePopups.set(map, popup);
}

export function ensureZoneMapLayers(
	map: any,
	colors: ZoneThemeColors,
	getTool?: () => string,
): { hatchId: string; pinId: string } {
	if (getTool) mapToolFns.set(map, getTool);

	const hatchColor = colors.err || "#ef4444";
	const hatchId = `guide-zone-hatch-${hatchColor.replace(/[^a-zA-Z0-9]/g, "")}`;
	if (typeof map.hasImage === "function" && !map.hasImage(hatchId)) {
		const img = renderHatchPatternImageData(hatchColor);
		if (img) map.addImage(hatchId, img);
	}

	const pinId = `guide-zone-avoid-pin-${hatchColor.replace(/[^a-zA-Z0-9]/g, "")}`;
	if (typeof map.hasImage === "function" && !map.hasImage(pinId)) {
		const pinImg = renderAvoidPinImageData(hatchColor, colors.night);
		if (pinImg) map.addImage(pinId, pinImg, { pixelRatio: 2 });
	}

	const belowMarkers = map.getLayer?.("locs-circles") ? "locs-circles" : map.getLayer?.("locs") ? "locs" : undefined;

	if (!map.getSource("guide-zone-area")) {
		map.addSource("guide-zone-area", { type: "geojson", data: emptyFC });
	}
	if (!map.getLayer("guide-zone-fill")) {
		map.addLayer(
			{
				id: "guide-zone-fill",
				type: "fill",
				source: "guide-zone-area",
				paint: {
					"fill-color": colors.accentSoft || colors.accent || "#e56b61",
					"fill-opacity": 0.16,
				},
			},
			belowMarkers,
		);
	}
	if (!map.getLayer("guide-zone-outline")) {
		map.addLayer(
			{
				id: "guide-zone-outline",
				type: "line",
				source: "guide-zone-area",
				layout: { "line-cap": "round", "line-join": "round" },
				paint: {
					"line-color": colors.accentSoft || colors.accent || "#e56b61",
					"line-width": 2.2,
					"line-opacity": 0.85,
					"line-dasharray": [3, 2],
				},
			},
			belowMarkers,
		);
	}

	if (!map.getSource("guide-zone-avoid-area")) {
		map.addSource("guide-zone-avoid-area", { type: "geojson", data: emptyFC });
	}
	if (!map.getLayer("guide-zone-avoid-fill")) {
		map.addLayer(
			{
				id: "guide-zone-avoid-fill",
				type: "fill",
				source: "guide-zone-avoid-area",
				paint: {
					"fill-pattern": hatchId,
					"fill-opacity": 0.85,
				},
			},
			belowMarkers,
		);
	}
	if (!map.getLayer("guide-zone-avoid-outline")) {
		map.addLayer(
			{
				id: "guide-zone-avoid-outline",
				type: "line",
				source: "guide-zone-avoid-area",
				layout: { "line-cap": "round", "line-join": "round" },
				paint: {
					"line-color": hatchColor,
					"line-width": 2,
					"line-opacity": 0.92,
				},
			},
			belowMarkers,
		);
	}

	if (!map.getSource("guide-zone-avoid-markers")) {
		map.addSource("guide-zone-avoid-markers", { type: "geojson", data: emptyFC });
	}
	if (!map.getLayer("guide-zone-avoid-markers")) {
		const belowPins = map.getLayer?.("guide-route-pins") ? "guide-route-pins" : undefined;
		map.addLayer(
			{
				id: "guide-zone-avoid-markers",
				type: "symbol",
				source: "guide-zone-avoid-markers",
				layout: {
					"icon-image": pinId,
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
					"icon-offset": [0, -18],
				},
			},
			belowPins,
		);
	}

	if (!wiredZoneMaps.has(map) && typeof map.on === "function") {
		wiredZoneMaps.add(map);

		const isPan = () => (mapToolFns.get(map)?.() ?? "pan") === "pan";

		map.on("click", "guide-zone-avoid-markers", (ev: any) => {
			if (!isPan()) return;
			const f = ev.features?.[0];
			if (!f?.properties?.note) return;
			const coords = f.geometry?.coordinates;
			const lngLat: [number, number] =
				Array.isArray(coords) && coords.length >= 2 ? [coords[0], coords[1]] : [ev.lngLat.lng, ev.lngLat.lat];
			showAvoidNotePopup(map, lngLat, String(f.properties.title || ""), String(f.properties.note));
		});

		map.on("click", "guide-zone-avoid-fill", (ev: any) => {
			if (!isPan()) return;
			// Prefer avoid-marker badge or regular marker if directly underneath
			const markerHits = map.queryRenderedFeatures?.(ev.point, {
				layers: ["guide-zone-avoid-markers", "locs", "locs-circles", "locs-text"].filter((id) =>
					map.getLayer?.(id),
				),
			});
			if (markerHits && markerHits.length > 0) return;
			const f = ev.features?.[0];
			if (!f?.properties?.note) return;
			showAvoidNotePopup(map, [ev.lngLat.lng, ev.lngLat.lat], "", String(f.properties.note));
		});

		for (const layerId of ["guide-zone-avoid-markers", "guide-zone-avoid-fill"]) {
			map.on("mouseenter", layerId, () => {
				if (isPan()) map.getCanvas().style.cursor = "pointer";
			});
			map.on("mouseleave", layerId, () => {
				map.getCanvas().style.cursor = "";
			});
		}
	}

	return { hatchId, pinId };
}

export function clearZoneMapLayers(map: any): void {
	if (!map) return;
	clearZonePopup(map);
	map.getSource?.("guide-zone-area")?.setData(emptyFC);
	map.getSource?.("guide-zone-avoid-area")?.setData(emptyFC);
	map.getSource?.("guide-zone-avoid-markers")?.setData(emptyFC);
}

export function renderZoneOnMap(
	map: any,
	zone: GuideZone | undefined | null,
	curMap: string,
	regionById: ReadonlyMap<number, any>,
	lookupMarker: (id: number) => ZoneMarkerCoord | null,
	colors: ZoneThemeColors,
	getTool?: () => string,
): void {
	if (!map) return;
	ensureZoneMapLayers(map, colors, getTool);
	if (!zone || (zone.map && zone.map !== curMap)) {
		clearZoneMapLayers(map);
		return;
	}
	const geo = resolveZoneGeometry(zone, curMap, regionById, lookupMarker);
	map.getSource?.("guide-zone-area")?.setData({ type: "FeatureCollection", features: geo.areaFeatures });
	map.getSource?.("guide-zone-avoid-area")?.setData({ type: "FeatureCollection", features: geo.avoidAreaFeatures });
	map.getSource?.("guide-zone-avoid-markers")?.setData({
		type: "FeatureCollection",
		features: geo.avoidMarkerFeatures,
	});
}