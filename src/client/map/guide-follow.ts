// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- guide follow mode: sidebar section, windowed guide panel, step card, and map route layer ----------
   Loaded lazily via ensureGuideFollow() when a game has guides or the user imports/opens one, so initial map
   boot for games without guides carries zero follow-mode overhead. */

import { esc, fmt } from "../../shared/escape.ts";
import {
	type DerivedStep,
	deriveGuideView,
	type GuideView,
	type MarkerExistsFn,
	nextAutoAdvanceStepId,
	nextVisibleStepId,
	prevVisibleStepId,
} from "../../shared/guide-progress.ts";
import {
	computeStepCameraFit,
	resolveAvoidEntryFocus,
	resolveZoneGeometry,
	type StepCameraFit,
} from "../../shared/guide-zone.ts";
import { glyphInk } from "../../shared/theme-math.ts";
import type { Guide } from "../../shared/types.ts";
import { clearZoneMapLayers, renderZoneOnMap } from "./guide-zone-map.ts";

export interface MarkerCoordInfo {
	id?: number;
	title?: string;
	lng: number;
	lat: number;
	map?: string;
	cat?: number;
	media?: any[];
}

export interface RouteBadgeSpec {
	icon: string;
	num: number;
	role: "prev" | "current" | "next";
	done: boolean;
}

export interface GuideRouteWindow {
	pinFeatures: any[];
	lineFeatures: any[];
	windowMarkerIds: Set<number>;
	badgesNeeded: RouteBadgeSpec[];
}

export interface GuideFollowHost {
	state: Record<string, any>;
	mapData: (info: any, keep?: boolean) => Promise<any>;
	setStepDone: (
		guideId: string,
		stepId: string,
		done: boolean,
		opts?: { notify?: boolean; markerExists?: MarkerExistsFn; onUndo?: () => void },
	) => any;
	setSkipped: (
		guideId: string,
		stepId: string,
		skipped: boolean,
		opts?: { notify?: boolean; onUndo?: () => void },
	) => any;
	setCursor: (guideId: string, stepId: string | null) => void;
	setVariant: (guideId: string, variantId: string, optionId: string) => void;
	toggleMarkerFound: (markerId: number, found: boolean) => void;
	renameGuidePrompt: (guideId: string) => Promise<void>;
	deleteGuideWithUndo: (guideId: string) => Promise<void>;
	downloadGuideJson: (guide: Guide) => void;
	openGuideEditor: (guideId: string) => Promise<void>;
	openNewGuideEditor: () => Promise<void>;
	closeDetail: () => void;
	hideDetail: () => void;
	updateLinks: () => void;
	switchMap: (slug: string, opts?: { remember?: boolean }) => Promise<void>;
	refreshAll: (opts?: { immediate?: boolean }) => void;
	refreshMap: () => void;
	saveSessionSoon: () => void;
	renderMd: (md?: string | null) => string;
	ensureMarked: () => Promise<void>;
	detailsReady: () => boolean;
	ensureDetails: () => Promise<void>;
	mediaHtml: (m: any, l: { title: string }) => string;
	iconHtml: (name?: string | null, color?: string | null) => string;
	svgIcon: (name: string) => string;
	syncSideClose: () => void;
	syncRegionBanners: () => void;
	closeRowMenu: () => void;
	themeVar: (name: string) => string;
	perf: <T>(name: string, fn: () => T) => T;
}

/* ---------- Pure Helpers (exported for unit tests) ---------- */

export function stripMdInline(md?: string | null, maxLen = 110): string {
	if (!md) return "";
	const plain = md
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[`*_~#>]+/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (plain.length <= maxLen) return plain;
	const cut = plain.slice(0, maxLen);
	const sp = cut.lastIndexOf(" ");
	return (sp > 30 ? cut.slice(0, sp) : cut) + "…";
}

export function stepHintText(
	ds: DerivedStep,
	currentMapSlug?: string | null,
	mapTitleLookup?: (slug: string) => string,
	markerMapLookup?: (id: number) => string | null,
): string {
	const parts: string[] = [];
	if (ds.effectivePlace) parts.push(ds.effectivePlace);

	// Check if step targets or explore zone are on another map
	if (currentMapSlug && (ds.targets.length > 0 || ds.step.zone)) {
		const otherMaps = new Set<string>();
		if (ds.step.zone?.map && ds.step.zone.map !== currentMapSlug) {
			otherMaps.add(mapTitleLookup ? mapTitleLookup(ds.step.zone.map) : ds.step.zone.map);
		}
		for (const t of ds.targets) {
			let mSlug: string | null = null;
			if (t.kind === "point" && t.point?.map) {
				mSlug = t.point.map;
			} else if (t.kind === "marker" && t.markerId !== undefined) {
				mSlug = markerMapLookup?.(t.markerId) ?? t.target.snapshot?.map ?? null;
			}
			if (mSlug && mSlug !== currentMapSlug) {
				otherMaps.add(mapTitleLookup ? mapTitleLookup(mSlug) : mSlug);
			}
		}
		if (otherMaps.size > 0) {
			parts.push(`Map: ${[...otherMaps].join(", ")}`);
		}
	}
	if (ds.step.zone && !ds.effectivePlace) {
		const exCount = ds.step.zone.avoid?.length ?? 0;
		parts.push(exCount > 0 ? `Explore area (${exCount} avoid)` : "Explore area");
	}

	if (ds.step.consequence) {
		parts.push(`⚠ ${stripMdInline(ds.step.consequence, 70)}`);
	} else if (ds.step.reward) {
		parts.push(`Reward: ${stripMdInline(ds.step.reward, 60)}`);
	} else if (ds.step.notes && parts.length === 0) {
		parts.push(stripMdInline(ds.step.notes, 90));
	}
	return parts.join(" · ");
}

export function computeRemainingMarkerIds(view: GuideView): Set<number> {
	const out = new Set<number>();
	for (const ds of view.visibleSteps) {
		if (ds.done || ds.skipped) continue;
		for (const t of ds.targets) {
			if (t.kind === "marker" && t.markerId !== undefined && !t.missing && !t.found) {
				out.add(t.markerId);
			}
		}
	}
	return out;
}

export function findStepsForMarker(
	view: GuideView,
	markerId: number,
): { stepId: string; stepNumber: number; title: string; status: string }[] {
	const hits: { stepId: string; stepNumber: number; title: string; status: string }[] = [];
	for (let i = 0; i < view.visibleSteps.length; i++) {
		const ds = view.visibleSteps[i]!;
		if (ds.targets.some((t) => t.kind === "marker" && t.markerId === markerId)) {
			hits.push({
				stepId: ds.step.id,
				stepNumber: i + 1,
				title: ds.step.title,
				status: ds.status,
			});
		}
	}
	return hits;
}

export function computeGuideRouteWindow(
	view: GuideView,
	mapSlug: string,
	lookupMarker: (id: number) => MarkerCoordInfo | null,
	opts?: { before?: number; after?: number; lookupZoneCentroid?: (ds: DerivedStep) => [number, number] | null },
): GuideRouteWindow {
	const before = opts?.before ?? 1;
	const after = opts?.after ?? 4;
	const pinFeatures: any[] = [];
	const lineFeatures: any[] = [];
	const windowMarkerIds = new Set<number>();
	const badgesNeeded: RouteBadgeSpec[] = [];
	const seenBadges = new Set<string>();

	if (!view.visibleSteps.length || !view.cursor) {
		return { pinFeatures, lineFeatures, windowMarkerIds, badgesNeeded };
	}

	const cursorIdx = view.visibleSteps.findIndex((s) => s.step.id === view.cursor);
	if (cursorIdx < 0) {
		return { pinFeatures, lineFeatures, windowMarkerIds, badgesNeeded };
	}

	const startIdx = Math.max(0, cursorIdx - before);
	const endIdx = Math.min(view.visibleSteps.length - 1, cursorIdx + after);

	const stepAnchors: { idx: number; role: "prev" | "current" | "next"; coords: [number, number][] }[] = [];

	for (let idx = startIdx; idx <= endIdx; idx++) {
		const ds = view.visibleSteps[idx]!;
		const stepNumber = idx + 1;
		const role: "prev" | "current" | "next" = idx < cursorIdx ? "prev" : idx === cursorIdx ? "current" : "next";
		const isDone = ds.done || ds.skipped;
		const coords: [number, number][] = [];

		for (const t of ds.targets) {
			if (t.kind === "marker" && t.markerId !== undefined) {
				const loc = lookupMarker(t.markerId);
				if (loc && (!loc.map || loc.map === mapSlug)) {
					windowMarkerIds.add(t.markerId);
					coords.push([loc.lng, loc.lat]);
				} else if (
					t.missing &&
					t.target.snapshot &&
					(!t.target.snapshot.map || t.target.snapshot.map === mapSlug)
				) {
					coords.push([t.target.snapshot.lng, t.target.snapshot.lat]);
				}
			} else if (t.kind === "point" && t.point) {
				if (!t.point.map || t.point.map === mapSlug) {
					coords.push([t.point.lng, t.point.lat]);
				}
			}
		}
		if (coords.length === 0 && ds.step.zone && (!ds.step.zone.map || ds.step.zone.map === mapSlug)) {
			const c = opts?.lookupZoneCentroid?.(ds);
			if (c) coords.push(c);
		}

		if (coords.length === 0) continue;

		const badgeIcon = `guide-badge-${stepNumber}-${role}-${isDone ? "done" : "open"}`;
		if (!seenBadges.has(badgeIcon)) {
			seenBadges.add(badgeIcon);
			badgesNeeded.push({ icon: badgeIcon, num: stepNumber, role, done: isDone });
		}

		for (const [lng, lat] of coords) {
			pinFeatures.push({
				type: "Feature",
				geometry: { type: "Point", coordinates: [lng, lat] },
				properties: {
					stepId: ds.step.id,
					stepNumber,
					role,
					done: isDone ? 1 : 0,
					badgeIcon,
					title: ds.step.title,
				},
			});
		}

		if (coords.length > 1) {
			lineFeatures.push({
				type: "Feature",
				geometry: { type: "LineString", coordinates: coords },
				properties: {
					role: role === "prev" ? "prev" : "next",
					stepId: ds.step.id,
				},
			});
		}

		stepAnchors.push({ idx, role, coords });
	}

	for (let i = 0; i + 1 < stepAnchors.length; i++) {
		const a = stepAnchors[i]!;
		const b = stepAnchors[i + 1]!;
		const fromPt = a.coords[a.coords.length - 1]!;
		const toPt = b.coords[0]!;
		if (fromPt[0] === toPt[0] && fromPt[1] === toPt[1]) continue;
		const segRole = b.idx <= cursorIdx ? "prev" : "next";
		lineFeatures.push({
			type: "Feature",
			geometry: { type: "LineString", coordinates: [fromPt, toPt] },
			properties: { role: segRole },
		});
	}

	return { pinFeatures, lineFeatures, windowMarkerIds, badgesNeeded };
}

const badgeCache = new Map<string, ImageData>();

export function clearGuideBadgeCache(): void {
	badgeCache.clear();
}

export function renderGuideBadgeImageData(
	spec: RouteBadgeSpec,
	colors: { accent: string; accentSoft: string; panel: string; night: string },
): ImageData | null {
	const cacheKey = `${spec.icon}|${colors.accent}|${colors.panel}`;
	const cached = badgeCache.get(cacheKey);
	if (cached) return cached;
	if (typeof document === "undefined") return null;

	const size = 64;
	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const g = c.getContext("2d");
	if (!g) return null;

	const cx = size / 2;
	const cy = size / 2;
	const label = String(spec.num);
	const isCurrent = spec.role === "current";
	const r = isCurrent ? 22 : 19;
	const pillHalfW = label.length >= 3 ? Math.min(28, r + (label.length - 2) * 5) : r;

	// Helper to trace rounded pill/circle
	const tracePill = (halfW: number, rad: number) => {
		g.beginPath();
		if (halfW <= rad) {
			g.arc(cx, cy, rad, 0, Math.PI * 2);
		} else {
			const dx = halfW - rad;
			g.arc(cx - dx, cy, rad, Math.PI * 0.5, Math.PI * 1.5);
			g.arc(cx + dx, cy, rad, Math.PI * 1.5, Math.PI * 0.5);
			g.closePath();
		}
	};

	if (isCurrent) {
		const glow = g.createRadialGradient(cx, cy, r * 0.4, cx, cy, r + 9);
		glow.addColorStop(0, colors.accent + "88");
		glow.addColorStop(1, colors.accent + "00");
		g.fillStyle = glow;
		g.fillRect(0, 0, size, size);
	}

	// Outer dark halo for contrast on bright map tiles
	tracePill(pillHalfW + 2.5, r + 2.5);
	g.fillStyle = colors.night || "#0b0e10";
	g.fill();

	// Main badge body
	tracePill(pillHalfW, r);
	if (isCurrent) {
		g.fillStyle = colors.accent || "#d6453b";
	} else {
		g.fillStyle = colors.panel || "#14191e";
	}
	g.fill();

	g.lineWidth = isCurrent ? 3 : 2.2;
	g.strokeStyle = isCurrent ? "#ffffff" : colors.accentSoft || colors.accent || "#e56b61";
	g.stroke();

	// Number label rendered via canvas font (no MapLibre PBF glyphs required)
	const fontSize = label.length >= 4 ? 17 : label.length === 3 ? 19 : isCurrent ? 23 : 20;
	g.font = `700 ${fontSize}px "Instrument Sans", system-ui, -apple-system, sans-serif`;
	g.textAlign = "center";
	g.textBaseline = "middle";
	g.fillStyle = isCurrent ? glyphInk(colors.accent || "#d6453b") : "#f3f5f7";
	g.fillText(label, cx, cy + 1);

	const img = g.getImageData(0, 0, size, size);
	badgeCache.set(cacheKey, img);
	return img;
}

/* ---------- Follow Mode Runtime State & UI ---------- */

let host: GuideFollowHost | null = null;
const collapsedSections = new Set<string>();
const lastEffectiveCursor = new Map<string, string | null>();
const lastCursorDoneState = new Map<string, boolean>();
let guidesGroupCollapsed = false;

const cursorStateKey = (guideId: string): string => `${host?.state.profile?.id || "anon"}:${guideId}`;

// Virtual list windowing constants for 2,000-step guides
const VIRTUAL_THRESHOLD = 120;
const VIRTUAL_OVERSCAN = 36;
const SEC_ROW_H = 40;
const STEP_ROW_H = 56;
let scrollWired = false;
let lastWindowStart = -1;
let lastWindowEnd = -1;
let cachedFlatItems: PanelItem[] = [];

type PanelItem =
	| {
			kind: "section";
			secId: string;
			title: string;
			level?: string;
			optional?: boolean;
			gate?: string;
			notes?: string;
			done: number;
			total: number;
			collapsed: boolean;
			top: number;
			height: number;
	  }
	| {
			kind: "step";
			ds: DerivedStep;
			stepNumber: number;
			hint: string;
			top: number;
			height: number;
	  };

function loadFollowPrefs(): void {
	if (!host || typeof localStorage === "undefined") return;
	try {
		const raw = JSON.parse(localStorage.getItem("va_guide_prefs") || "null");
		if (raw && typeof raw === "object") {
			if (typeof raw.autoAdvance === "boolean") host.state.guide.autoAdvance = raw.autoAdvance;
			if (typeof raw.autoSwitchMap === "boolean") host.state.guide.autoSwitchMap = raw.autoSwitchMap;
		}
	} catch {}
}

function saveFollowPrefs(): void {
	if (!host || typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(
			"va_guide_prefs",
			JSON.stringify({
				autoAdvance: host.state.guide.autoAdvance,
				autoSwitchMap: host.state.guide.autoSwitchMap,
			}),
		);
	} catch {}
}

export function initGuideFollow(h: GuideFollowHost): void {
	host = h;
	loadFollowPrefs();
	const gid = h.state.entry?.id;
	if (gid && typeof localStorage !== "undefined") {
		try {
			const savedId = localStorage.getItem(`va_active_guide:${gid}`);
			if (savedId && (h.state.guides as Guide[]).some((g) => g.id === savedId)) {
				h.state.guide.activeId = savedId;
			}
		} catch {}
	}
	wireGuideScroll();
}

function activeGuide(): Guide | null {
	if (!host) return null;
	const guides = (host.state.guides || []) as Guide[];
	if (!guides.length) return null;
	const activeId = host.state.guide?.activeId;
	if (activeId) {
		const found = guides.find((g) => g.id === activeId);
		if (found) return found;
	}
	return null;
}

// Cross-map marker lookup cache for multi-map games
let gameMarkerCache: {
	meta: unknown;
	ready: boolean;
	byId: Map<number, MarkerCoordInfo>;
	promise: Promise<void> | null;
} | null = null;

function ensureGameMarkerIndex(): Promise<void> {
	if (!host?.state.meta?.maps) return Promise.resolve();
	if (host.state.meta.maps.length <= 1) {
		gameMarkerCache = { meta: host.state.meta, ready: true, byId: new Map(), promise: Promise.resolve() };
		return Promise.resolve();
	}
	if (gameMarkerCache && gameMarkerCache.meta === host.state.meta && gameMarkerCache.promise) {
		return gameMarkerCache.promise;
	}
	const byId = new Map<number, MarkerCoordInfo>();
	const currentMeta = host.state.meta;
	const p = Promise.all(
		host.state.meta.maps.map(async (info: any) => {
			try {
				const d = await host!.mapData(info, false);
				for (const loc of d?.locations || []) {
					const lat = typeof loc.latitude === "number" ? loc.latitude : parseFloat(loc.latitude);
					const lng = typeof loc.longitude === "number" ? loc.longitude : parseFloat(loc.longitude);
					if (Number.isFinite(loc.id) && Number.isFinite(lat) && Number.isFinite(lng)) {
						byId.set(Number(loc.id), {
							id: Number(loc.id),
							title: loc.title || "",
							lat,
							lng,
							map: info.slug,
							cat: Number(loc.category_id),
							media: loc.media || [],
						});
					}
				}
			} catch {}
		}),
	).then(() => {
		if (gameMarkerCache && gameMarkerCache.meta === currentMeta) {
			gameMarkerCache.ready = true;
		}
	});
	gameMarkerCache = { meta: currentMeta, ready: false, byId, promise: p };
	return p;
}

function lookupMarkerAcrossGame(markerId: number): MarkerCoordInfo | null {
	if (!host) return null;
	const local = host.state.byId?.get(markerId);
	if (local) {
		return {
			id: local.id,
			title: local.title,
			lng: local.lng,
			lat: local.lat,
			map: host.state.mapInfo?.slug,
			cat: local.cat,
			media: local.media,
		};
	}
	if (gameMarkerCache && gameMarkerCache.meta === host.state.meta) {
		return gameMarkerCache.byId.get(markerId) ?? null;
	}
	return null;
}

function followMarkerExists(markerId: number): "yes" | "no" | "unknown" {
	if (!host) return "unknown";
	if (host.state.byId && host.state.byId.has(markerId)) return "yes";
	if (host.state.meta?.maps && host.state.meta.maps.length === 1 && host.state.byId && host.state.byId.size > 0) {
		return "no";
	}
	if (gameMarkerCache && gameMarkerCache.meta === host.state.meta && gameMarkerCache.ready) {
		return gameMarkerCache.byId.has(markerId) ? "yes" : "no";
	}
	return "unknown";
}

export function deriveForGuide(guide: Guide): GuideView {
	if (!host) {
		return deriveGuideView({ guide, found: new Set() });
	}
	const prog = host.state.profile?.guides?.[guide.id] ?? null;
	return host.perf("deriveGuideView", () =>
		deriveGuideView({
			guide,
			progress: prog,
			found: host!.state.found,
			markerExists: followMarkerExists,
		}),
	);
}

function announceLive(text: string): void {
	if (typeof document === "undefined") return;
	const el = document.getElementById("guide-live");
	if (el) el.textContent = text;
}

function prefersReducedMotion(): boolean {
	return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function mapTitleOf(slug: string): string {
	if (!host) return slug;
	return host.state.meta?.maps?.find((m: any) => m.slug === slug)?.title || slug;
}

function flyToCoords(lng: number, lat: number, closeSideOnMobile = false): void {
	if (!host || !host.state.mapReady || !host.state.map) return;
	const map = host.state.map;
	const isMob = typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches;
	const padding = isMob ? { bottom: Math.round(innerHeight * 0.4) } : { right: 384 };
	const zoom = Math.max(map.getZoom(), 13.5);
	if (closeSideOnMobile && isMob) {
		document.body.classList.remove("side-open");
	}
	if (prefersReducedMotion()) {
		map.jumpTo({ center: [lng, lat], zoom, padding });
	} else {
		map.flyTo({ center: [lng, lat], zoom, padding, speed: 1.5, essential: true });
	}
}

function applyCameraFit(fit: StepCameraFit, closeSideOnMobile = false): void {
	if (!host || !host.state.mapReady || !host.state.map) return;
	if (fit.kind === "point") {
		flyToCoords(fit.lng, fit.lat, closeSideOnMobile);
		return;
	}
	const map = host.state.map;
	const isMob = typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches;
	const padding = isMob
		? { top: 44, bottom: Math.round(innerHeight * 0.42), left: 20, right: 20 }
		: { top: 44, bottom: 44, left: 44, right: 400 };
	if (closeSideOnMobile && isMob) {
		document.body.classList.remove("side-open");
	}
	map.fitBounds(fit.bounds, {
		padding,
		maxZoom: 15.5,
		duration: prefersReducedMotion() ? 0 : 750,
		essential: true,
	});
}

function resolveStepCameraOnMap(ds: DerivedStep, curMap: string): StepCameraFit | null {
	if (!host) return null;
	return computeStepCameraFit(
		ds.step.targets,
		ds.step.zone,
		curMap,
		host.state.regionById || new Map(),
		lookupMarkerAcrossGame,
	);
}

function resolveStepPrimaryTarget(
	ds: DerivedStep,
): { lng: number; lat: number; map: string; markerId?: number } | null {
	if (!host) return null;
	const curMap = host.state.mapInfo?.slug || "";
	let fallbackOtherMap: { lng: number; lat: number; map: string; markerId?: number } | null = null;

	for (const t of ds.targets) {
		if (t.kind === "marker" && t.markerId !== undefined) {
			const loc = lookupMarkerAcrossGame(t.markerId);
			if (loc) {
				const mSlug = loc.map || curMap;
				const item = { lng: loc.lng, lat: loc.lat, map: mSlug, markerId: t.markerId };
				if (mSlug === curMap && !t.found) return item;
				if (mSlug === curMap && !fallbackOtherMap) fallbackOtherMap = item;
				if (!fallbackOtherMap) fallbackOtherMap = item;
			} else if (t.target.snapshot) {
				const snap = t.target.snapshot;
				const item = { lng: snap.lng, lat: snap.lat, map: snap.map || curMap };
				if (item.map === curMap) return item;
				if (!fallbackOtherMap) fallbackOtherMap = item;
			}
		} else if (t.kind === "point" && t.point) {
			const item = { lng: t.point.lng, lat: t.point.lat, map: t.point.map || curMap };
			if (item.map === curMap) return item;
			if (!fallbackOtherMap) fallbackOtherMap = item;
		}
	}
	return fallbackOtherMap;
}

/* ---------- Sidebar "Guides" Section (above Category Groups) ---------- */

const BOOK_ICON =
	'<svg class="i" viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>';

export function renderGuidesSidebarSection(): void {
	if (!host || typeof document === "undefined") return;
	const sec = document.getElementById("guides-section");
	if (!sec) return;
	const guides = (host.state.guides || []) as Guide[];
	if (!guides.length) {
		sec.hidden = true;
		sec.innerHTML = "";
		return;
	}
	sec.hidden = false;
	sec.classList.toggle("collapsed", guidesGroupCollapsed);
	sec.style.setProperty("--c", "var(--accent-soft)");

	const rowsHtml = guides
		.map((g) => {
			const view = deriveForGuide(g);
			const done = view.counts.done;
			const total = view.counts.total;
			const isDone = total > 0 && done === total;
			const isActive = host!.state.guide.activeId === g.id;
			const isFiltered = isActive && host!.state.guide.remainingOnly;
			return (
				`<div class="cat-row guide-row${isActive ? " active-guide" : ""}" data-guide-open="${esc(g.id)}" role="button" tabindex="0" aria-label="Open guide ${esc(g.title)} (${done} of ${total})">` +
				`<button type="button" class="row-menu-btn" data-guide-menu="${esc(g.id)}" aria-haspopup="menu" aria-label="Actions for ${esc(g.title)}" title="Actions">` +
				`<svg viewBox="0 0 4 16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg>` +
				`</button>` +
				`<span class="ico-wrap guide-ico">${BOOK_ICON}</span>` +
				`<span class="label">${esc(g.title)}${isFiltered ? ' <span class="gp-badge gp-badge-partial">Filtered</span>' : ""}</span>` +
				`<span class="tally${isDone ? " done" : ""}">${fmt(done)}/${fmt(total)}</span>` +
				`</div>`
			);
		})
		.join("");

	sec.innerHTML =
		`<div class="group-head">` +
		`<button class="name" type="button" data-guides-collapse>${esc("Guides")}</button>` +
		`<button class="link-btn gp-new-link" type="button" data-guides-new title="Create a new guide">+ New</button>` +
		`<span class="tally">${guides.length}</span>` +
		`</div>` +
		`<div class="cats guides-cats">${rowsHtml}</div>`;

	const newBtn = sec.querySelector<HTMLElement>("[data-guides-new]");
	if (newBtn) {
		newBtn.onclick = (e) => {
			e.stopPropagation();
			void host?.openNewGuideEditor();
		};
	}

	const collapseBtn = sec.querySelector<HTMLElement>("[data-guides-collapse]");
	if (collapseBtn) {
		collapseBtn.onclick = () => {
			guidesGroupCollapsed = !guidesGroupCollapsed;
			sec.classList.toggle("collapsed", guidesGroupCollapsed);
		};
	}

	sec.querySelectorAll<HTMLElement>("[data-guide-open]").forEach((row) => {
		const gId = row.dataset.guideOpen!;
		row.onclick = (e) => {
			if ((e.target as HTMLElement).closest("[data-guide-menu]")) return;
			openGuidePanel(gId, { scrollToCursor: true });
		};
		row.onkeydown = (e) => {
			if (e.key === "Enter" || e.key === " ") {
				if ((e.target as HTMLElement).closest("[data-guide-menu]")) return;
				e.preventDefault();
				openGuidePanel(gId, { scrollToCursor: true });
			}
		};
	});

	sec.querySelectorAll<HTMLButtonElement>("[data-guide-menu]").forEach((btn) => {
		btn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			openGuideRowMenu(btn, btn.dataset.guideMenu!);
		};
	});
}

let guideMenuEl: HTMLDivElement | null = null;
let guideMenuBtn: HTMLElement | null = null;

export function closeGuideRowMenu(): void {
	if (guideMenuEl) guideMenuEl.hidden = true;
	if (guideMenuBtn) guideMenuBtn.setAttribute("aria-expanded", "false");
	guideMenuBtn = null;
}

function openGuideRowMenu(btn: HTMLElement, guideId: string): void {
	if (!host) return;
	host.closeRowMenu();
	const guide = (host.state.guides as Guide[]).find((g) => g.id === guideId);
	if (!guide) return;

	if (!guideMenuEl) {
		guideMenuEl = document.createElement("div");
		guideMenuEl.id = "guide-row-menu";
		guideMenuEl.className = "menu row-menu";
		guideMenuEl.hidden = true;
		guideMenuEl.setAttribute("role", "menu");
		document.body.appendChild(guideMenuEl);
		document.addEventListener("click", (ev) => {
			if (
				guideMenuEl &&
				!guideMenuEl.hidden &&
				!(ev.target as HTMLElement).closest("#guide-row-menu, [data-guide-menu]")
			) {
				closeGuideRowMenu();
			}
		});
	}

	if (guideMenuBtn === btn && !guideMenuEl.hidden) {
		closeGuideRowMenu();
		return;
	}

	const view = deriveForGuide(guide);
	const isRemOnly = host.state.guide.activeId === guide.id && host.state.guide.remainingOnly;
	guideMenuEl.innerHTML =
		`<div class="rm-head"><span class="ico-wrap guide-ico">${BOOK_ICON}</span>` +
		`<div class="rm-text"><div class="rm-title">${esc(guide.title)}</div>` +
		`<div class="rm-sub">Guide · ${fmt(view.counts.done)}/${fmt(view.counts.total)} done</div></div></div><hr>` +
		`<button type="button" role="menuitem" data-gm-act="open">${host.svgIcon("list")}<span>Open guide</span></button>` +
		`<button type="button" role="menuitem" data-gm-act="edit">${host.svgIcon("pencil")}<span>Edit guide</span></button>` +
		`<button type="button" role="menuitem" data-gm-act="remaining">${host.svgIcon("check")}<span>${isRemOnly ? "Show all map markers" : "Show only remaining on map"}</span></button>` +
		`<button type="button" role="menuitem" data-gm-act="rename">${host.svgIcon("pen")}<span>Rename guide</span></button>` +
		`<button type="button" role="menuitem" data-gm-act="export">${host.svgIcon("share")}<span>Export guide (JSON)</span></button>` +
		`<button type="button" role="menuitem" data-gm-act="delete" class="danger">${host.svgIcon("trash")}<span>Delete guide</span></button>`;

	guideMenuEl.onclick = async (e) => {
		const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-gm-act]");
		if (!b) return;
		const act = b.dataset.gmAct;
		closeGuideRowMenu();
		if (!host) return;
		if (act === "open") {
			openGuidePanel(guide.id, { scrollToCursor: true });
		} else if (act === "edit") {
			void host.openGuideEditor(guide.id);
		} else if (act === "remaining") {
			host.state.guide.activeId = guide.id;
			host.state.guide.remainingOnly = !isRemOnly;
			host.refreshAll();
		} else if (act === "rename") {
			await host.renameGuidePrompt(guide.id);
			renderGuidesSidebarSection();
			if (host.state.guide.panelOpen) renderGuidePanel();
		} else if (act === "export") {
			host.downloadGuideJson(guide);
		} else if (act === "delete") {
			await host.deleteGuideWithUndo(guide.id);
		}
	};

	guideMenuBtn = btn;
	btn.setAttribute("aria-expanded", "true");
	guideMenuEl.hidden = false;
	const r = btn.getBoundingClientRect(),
		pad = 8;
	const w = guideMenuEl.offsetWidth,
		h = guideMenuEl.offsetHeight;
	let left = r.right + 8;
	if (left + w > innerWidth - pad) left = Math.max(pad, r.left - w - 8);
	guideMenuEl.style.left = left + "px";
	guideMenuEl.style.top = Math.max(pad, Math.min(r.top, innerHeight - h - pad)) + "px";
}

/* ---------- The Guide Panel (replaces #groups in sidebar) ---------- */

function wireGuideScroll(): void {
	if (scrollWired || typeof document === "undefined") return;
	const scroller = document.querySelector<HTMLElement>("#side .side-scroll");
	if (!scroller) return;
	scrollWired = true;
	let raf = 0;
	scroller.addEventListener(
		"scroll",
		() => {
			if (!host?.state.guide.panelOpen || cachedFlatItems.length <= VIRTUAL_THRESHOLD) return;
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				updateVirtualStepSlice(false);
			});
		},
		{ passive: true },
	);
}

export function openGuidePanel(guideId: string, opts?: { scrollToCursor?: boolean; selectCursorStep?: boolean }): void {
	if (!host || typeof document === "undefined") return;
	const guide = (host.state.guides as Guide[]).find((g) => g.id === guideId);
	if (!guide) return;

	host.perf("openGuidePanel", () => {
		if (!scrollWired) wireGuideScroll();
		host!.state.guide.activeId = guide.id;
		host!.state.guide.panelOpen = true;
		try {
			if (host!.state.entry?.id) {
				localStorage.setItem(`va_active_guide:${host!.state.entry.id}`, guide.id);
			}
		} catch {}

		// Warm up cross-map marker lookup for multi-map games
		void ensureGameMarkerIndex().then(() => {
			if (host?.state.guide.panelOpen && host.state.guide.activeId === guide.id) {
				renderGuidePanel();
				if (host.state.guide.selectedStepId) renderStepCard();
				host.refreshMap();
			}
		});

		const view = deriveForGuide(guide);
		const cKey = cursorStateKey(guide.id);
		lastEffectiveCursor.set(cKey, view.cursor);
		const curStep = view.cursor ? view.stepsById.get(view.cursor) : null;
		lastCursorDoneState.set(cKey, Boolean(curStep?.done || curStep?.skipped));

		document.body.classList.add("guide-open");
		const panel = document.getElementById("guide-panel");
		if (panel) panel.hidden = false;

		host!.syncSideClose();
		host!.syncRegionBanners();
		renderGuidePanel({ forceFullHeader: true });

		if (opts?.scrollToCursor && view.cursor) {
			scrollToStepInPanel(view.cursor);
		}
		if (opts?.selectCursorStep && view.cursor) {
			openStepCard(guide.id, view.cursor, { fly: true });
		}

		host!.refreshMap();
		host!.saveSessionSoon();
	});
}

export function closeGuidePanel(): void {
	if (!host || typeof document === "undefined") return;
	host.state.guide.panelOpen = false;
	if (host.state.guide.selectedStepId) {
		host.state.guide.selectedStepId = null;
		host.closeDetail();
	}
	document.body.classList.remove("guide-open");
	const panel = document.getElementById("guide-panel");
	if (panel) panel.hidden = true;
	host.syncSideClose();
	host.syncRegionBanners();
	renderGuidesSidebarSection();
	host.refreshMap();
	host.saveSessionSoon();
}

function buildFlatPanelItems(view: GuideView, threadFilter: string | null): PanelItem[] {
	const items: PanelItem[] = [];
	let top = 0;
	const curMap = host?.state.mapInfo?.slug ?? null;
	const stepIdxMap = new Map<string, number>();
	for (let i = 0; i < view.visibleSteps.length; i++) {
		stepIdxMap.set(view.visibleSteps[i]!.step.id, i + 1);
	}

	for (const sec of view.sections) {
		if (!sec.visible) continue;
		const matchingSteps = sec.steps.filter((s) => s.visible && (!threadFilter || s.step.thread === threadFilter));
		if (matchingSteps.length === 0 && threadFilter) continue;

		const isCollapsed = collapsedSections.has(sec.section.id);
		items.push({
			kind: "section",
			secId: sec.section.id,
			title: sec.section.title,
			level: sec.section.level,
			optional: sec.section.optional,
			gate: sec.section.gate,
			notes: sec.section.notes,
			done: sec.counts.done,
			total: sec.counts.total,
			collapsed: isCollapsed,
			top,
			height: SEC_ROW_H,
		});
		top += SEC_ROW_H;

		if (!isCollapsed) {
			for (const ds of matchingSteps) {
				const stepNumber = stepIdxMap.get(ds.step.id) ?? 0;
				const hint = stepHintText(ds, curMap, mapTitleOf, (id) => lookupMarkerAcrossGame(id)?.map ?? null);
				items.push({
					kind: "step",
					ds,
					stepNumber,
					hint,
					top,
					height: STEP_ROW_H,
				});
				top += STEP_ROW_H;
			}
		}
	}
	return items;
}

function renderPanelItemHtml(item: PanelItem): string {
	if (item.kind === "section") {
		const lvl = item.level ? `<span class="gp-badge gp-badge-lvl">Lv ${esc(item.level)}</span>` : "";
		const opt = item.optional ? `<span class="gp-badge gp-badge-opt">Optional</span>` : "";
		const gate = item.gate
			? `<div class="gp-sec-gate" title="${esc(item.gate)}">Gate: ${esc(item.gate)}</div>`
			: "";
		return (
			`<div class="gp-sec${item.collapsed ? " collapsed" : ""}" data-gp-sec="${esc(item.secId)}">` +
			`<button type="button" class="gp-sec-head" data-gp-sec-toggle="${esc(item.secId)}" aria-expanded="${!item.collapsed}">` +
			`<span class="gp-sec-title">${esc(item.title)}</span>` +
			lvl +
			opt +
			`<span class="gp-sec-tally">${fmt(item.done)}/${fmt(item.total)}</span>` +
			`</button>` +
			gate +
			`</div>`
		);
	}

	const { ds, stepNumber, hint } = item;
	const st = ds.step;
	const isCur = ds.current;
	const isSel = host?.state.guide.selectedStepId === st.id;
	const stateClasses = [
		"gp-step",
		`kind-${st.kind}`,
		ds.done ? "is-done" : "",
		ds.partial ? "is-partial" : "",
		ds.skipped ? "is-skipped" : "",
		isCur ? "is-current" : "",
		isSel ? "is-selected" : "",
	]
		.filter(Boolean)
		.join(" ");

	const badges: string[] = [];
	if (ds.partial) {
		badges.push(
			`<span class="gp-badge gp-badge-partial">${ds.foundRequiredTargets} of ${ds.requiredTargets}</span>`,
		);
	} else if (ds.skipped) {
		badges.push(`<span class="gp-badge gp-badge-skip">Skipped</span>`);
	} else if (st.kind === "waypoint") {
		badges.push(`<span class="gp-badge gp-badge-kind">Waypoint</span>`);
	} else if (st.kind === "info") {
		badges.push(`<span class="gp-badge gp-badge-kind">Info</span>`);
	}
	if (ds.optional) {
		badges.push(`<span class="gp-badge gp-badge-opt">Optional</span>`);
	}
	if (st.missable) {
		badges.push(`<span class="gp-badge gp-badge-missable">Missable</span>`);
	}

	const checkControl =
		st.kind === "task"
			? `<button type="button" class="gp-step-check${ds.done ? " on" : ds.partial ? " partial" : ""}" ` +
				`data-gp-check="${esc(st.id)}" aria-pressed="${ds.done}" ` +
				`aria-label="${ds.done ? `Mark ${st.title} as not done` : `Mark ${st.title} as done`}" ` +
				`title="${ds.done ? "Done (click to undo)" : "Mark step as done"}">` +
				(ds.done ? "✓" : ds.partial ? "◐" : "") +
				`</button>`
			: `<span class="gp-step-bullet" aria-hidden="true">${st.kind === "waypoint" ? "◎" : "ℹ"}</span>`;

	return (
		`<div class="${stateClasses}" role="listitem" data-step-id="${esc(st.id)}"${isCur ? ' aria-current="step"' : ""}>` +
		checkControl +
		`<button type="button" class="gp-step-main" data-gp-open-step="${esc(st.id)}">` +
		`<div class="gp-step-top">` +
		`<span class="gp-step-num">#${stepNumber}</span>` +
		`<span class="gp-step-title">${esc(st.title)}</span>` +
		(badges.length ? `<span class="gp-step-badges">${badges.join("")}</span>` : "") +
		`</div>` +
		(hint ? `<div class="gp-step-hint">${esc(hint)}</div>` : "") +
		`</button>` +
		`</div>`
	);
}

function updateVirtualStepSlice(force = false): void {
	if (!host || typeof document === "undefined") return;
	const listEl = document.getElementById("gp-step-list");
	const scroller = document.querySelector<HTMLElement>("#side .side-scroll");
	if (!listEl) return;

	const items = cachedFlatItems;
	if (items.length === 0) {
		listEl.innerHTML = `<div class="gp-empty">No steps match this filter.</div>`;
		lastWindowStart = -1;
		lastWindowEnd = -1;
		return;
	}

	// Capture active focus inside the list so we can preserve it across updates
	const activeEl = document.activeElement as HTMLElement | null;
	const focusedStepRow =
		activeEl && listEl.contains(activeEl) ? activeEl.closest<HTMLElement>("[data-step-id]") : null;
	const focusedStepId = focusedStepRow?.dataset.stepId ?? null;
	const focusedWasCheck = Boolean(activeEl?.hasAttribute("data-gp-check"));

	let startIdx = 0;
	let endIdx = items.length;
	let topPad = 0;
	let bottomPad = 0;

	if (items.length > VIRTUAL_THRESHOLD && scroller) {
		const listOffset = listEl.offsetTop;
		const relScrollTop = Math.max(0, scroller.scrollTop - listOffset);
		const viewH = Math.max(400, scroller.clientHeight || 600);

		// Binary search first item intersecting relScrollTop
		let lo = 0,
			hi = items.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const it = items[mid]!;
			if (it.top + it.height < relScrollTop) lo = mid + 1;
			else hi = mid;
		}
		startIdx = Math.max(0, lo - VIRTUAL_OVERSCAN);
		const targetBottom = relScrollTop + viewH;
		let endScan = lo;
		while (endScan < items.length && items[endScan]!.top < targetBottom) endScan++;
		endIdx = Math.min(items.length, endScan + VIRTUAL_OVERSCAN);

		if (
			!force &&
			lastWindowStart >= 0 &&
			Math.abs(startIdx - lastWindowStart) < 12 &&
			Math.abs(endIdx - lastWindowEnd) < 12
		) {
			return;
		}

		topPad = items[startIdx]!.top;
		const lastItem = items[items.length - 1]!;
		const totalH = lastItem.top + lastItem.height;
		const sliceEndItem = items[endIdx - 1]!;
		bottomPad = Math.max(0, totalH - (sliceEndItem.top + sliceEndItem.height));
	}

	lastWindowStart = startIdx;
	lastWindowEnd = endIdx;

	const sliceHtml = items.slice(startIdx, endIdx).map(renderPanelItemHtml).join("");
	listEl.innerHTML =
		(topPad > 0 ? `<div class="gp-spacer" style="height:${topPad}px" aria-hidden="true"></div>` : "") +
		sliceHtml +
		(bottomPad > 0 ? `<div class="gp-spacer" style="height:${bottomPad}px" aria-hidden="true"></div>` : "");

	if (focusedStepId) {
		const row = listEl.querySelector<HTMLElement>(`[data-step-id="${CSS.escape(focusedStepId)}"]`);
		const targetFocus = row?.querySelector<HTMLElement>(
			focusedWasCheck ? "[data-gp-check]" : "[data-gp-open-step]",
		);
		targetFocus?.focus({ preventScroll: true });
	}
}

export function scrollToStepInPanel(stepId: string): void {
	if (typeof document === "undefined") return;
	const scroller = document.querySelector<HTMLElement>("#side .side-scroll");
	const listEl = document.getElementById("gp-step-list");
	if (!scroller || !listEl) return;

	const item = cachedFlatItems.find((it) => it.kind === "step" && it.ds.step.id === stepId);
	if (!item) return;

	const targetScroll = Math.max(0, listEl.offsetTop + item.top - Math.round((scroller.clientHeight || 400) * 0.3));
	scroller.scrollTop = targetScroll;
	updateVirtualStepSlice(true);
}

export function renderGuidePanel(opts?: { forceFullHeader?: boolean }): void {
	if (!host || typeof document === "undefined") return;
	const panel = document.getElementById("guide-panel");
	if (!panel || !host.state.guide.panelOpen) return;

	const guide = activeGuide();
	if (!guide) {
		closeGuidePanel();
		return;
	}

	host.perf("renderGuidePanel", () => {
		const scroller = document.querySelector<HTMLElement>("#side .side-scroll");
		const prevScrollTop = scroller ? scroller.scrollTop : 0;

		const view = deriveForGuide(guide);
		const { counts } = view;
		const pct = counts.total > 0 ? Math.round((100 * counts.done) / counts.total) : 0;
		const cursorIdx = view.cursor ? view.visibleSteps.findIndex((s) => s.step.id === view.cursor) : -1;
		const prevId = prevVisibleStepId(view, view.cursor);
		const nextId = nextVisibleStepId(view, view.cursor);

		// Collect unique threads across visible steps
		const threads: string[] = [];
		const seenThreads = new Set<string>();
		for (const ds of view.visibleSteps) {
			if (ds.step.thread && !seenThreads.has(ds.step.thread)) {
				seenThreads.add(ds.step.thread);
				threads.push(ds.step.thread);
			}
		}
		if (host!.state.guide.threadFilter && !seenThreads.has(host!.state.guide.threadFilter)) {
			host!.state.guide.threadFilter = null;
		}

		let headEl = panel.querySelector<HTMLElement>(".gp-header");
		if (!headEl || opts?.forceFullHeader || headEl.dataset.guideId !== guide.id) {
			panel.innerHTML =
				`<div class="gp-header" data-guide-id="${esc(guide.id)}"></div>` +
				`<div id="gp-step-list" class="gp-list" role="list" aria-label="Steps in ${esc(guide.title)}"></div>`;
			headEl = panel.querySelector<HTMLElement>(".gp-header")!;
			wireGuidePanelDelegation(panel);
		}

		const variantsHtml = (guide.variants || [])
			.map((v) => {
				const chosen = view.variants[v.id] || v.default;
				const optsHtml = v.options
					.map(
						(o) =>
							`<option value="${esc(o.id)}"${o.id === chosen ? " selected" : ""}>${esc(o.label)}</option>`,
					)
					.join("");
				return (
					`<label class="gp-variant">` +
					`<span>${esc(v.label)}</span>` +
					`<select data-gp-variant="${esc(v.id)}">${optsHtml}</select>` +
					`</label>`
				);
			})
			.join("");

		const threadsHtml =
			threads.length > 0
				? `<div class="gp-threads" role="group" aria-label="Filter by questline thread">` +
					`<button type="button" class="gp-thread-chip" data-gp-thread="" aria-pressed="${!host!.state.guide.threadFilter}">All</button>` +
					threads
						.map(
							(th) =>
								`<button type="button" class="gp-thread-chip" data-gp-thread="${esc(th)}" aria-pressed="${host!.state.guide.threadFilter === th}">${esc(th)}</button>`,
						)
						.join("") +
					`</div>`
				: "";

		const reqNote =
			counts.required < counts.total ? ` · ${fmt(counts.doneRequired)}/${fmt(counts.required)} req` : "";
		const skipNote = counts.skipped > 0 ? ` · ${fmt(counts.skipped)} skipped` : "";
		const multiMap = (host!.state.meta?.maps?.length ?? 1) > 1;

		headEl.innerHTML =
			`<div class="gp-top-bar">` +
			`<button type="button" class="gp-back-btn" data-gp-act="back" aria-label="Back to categories">${host!.svgIcon("arrowLeft")}<span>Categories</span></button>` +
			`<div class="gp-top-actions">` +
			`<button type="button" class="gp-back-btn" data-gp-act="edit" aria-label="Edit guide">${host!.svgIcon("pencil")}<span>Edit</span></button>` +
			`<button type="button" class="row-menu-btn gp-head-menu" data-guide-menu="${esc(guide.id)}" aria-haspopup="menu" aria-label="Guide actions" title="Guide actions">` +
			`<svg viewBox="0 0 4 16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg>` +
			`</button>` +
			`</div>` +
			`</div>` +
			`<h2 class="gp-title">${esc(guide.title)}</h2>` +
			(guide.author ? `<div class="gp-meta">By ${esc(guide.author)}</div>` : "") +
			`<div class="gp-progress-row">` +
			`<span class="gp-progress-text"><b>${fmt(counts.done)}</b> / ${fmt(counts.total)} done (${pct}%)${reqNote}${skipNote}</span>` +
			`<div class="gp-progress-bar" role="img" aria-label="${pct}% complete"><i style="width:${pct}%"></i></div>` +
			`</div>` +
			`<div class="gp-nav-bar">` +
			`<button type="button" class="gp-nav-btn" data-gp-act="prev" ${prevId ? "" : "disabled"} title="Previous step ([)">${host!.svgIcon("arrowLeft")}<span>Prev</span></button>` +
			`<button type="button" class="gp-nav-cur" data-gp-act="jump-cursor" ${view.cursor ? "" : "disabled"} title="Jump to current step">` +
			(cursorIdx >= 0 ? `Step ${cursorIdx + 1} of ${view.visibleSteps.length}` : "All steps complete") +
			`</button>` +
			`<button type="button" class="gp-nav-btn" data-gp-act="next" ${nextId ? "" : "disabled"} title="Next step (])"><span>Next</span>${host!.svgIcon("arrowRight")}</button>` +
			`</div>` +
			`<div class="gp-toggles">` +
			`<label class="gp-check"><input type="checkbox" data-gp-toggle="remaining" ${host!.state.guide.remainingOnly ? "checked" : ""}/><span>Only remaining on map</span></label>` +
			`<label class="gp-check"><input type="checkbox" data-gp-toggle="autoadvance" ${host!.state.guide.autoAdvance ? "checked" : ""}/><span>Auto-advance</span></label>` +
			(multiMap
				? `<label class="gp-check"><input type="checkbox" data-gp-toggle="autoswitch" ${host!.state.guide.autoSwitchMap ? "checked" : ""}/><span>Auto-switch map</span></label>`
				: "") +
			`</div>` +
			(variantsHtml ? `<div class="gp-variants">${variantsHtml}</div>` : "") +
			threadsHtml;

		cachedFlatItems = buildFlatPanelItems(view, host!.state.guide.threadFilter);
		updateVirtualStepSlice(true);

		if (scroller && !opts?.forceFullHeader) {
			scroller.scrollTop = prevScrollTop;
		}
	});
}

function wireGuidePanelDelegation(panel: HTMLElement): void {
	panel.onclick = (e) => {
		if (!host) return;
		const target = e.target as HTMLElement;
		const guide = activeGuide();
		if (!guide) return;

		const menuBtn = target.closest<HTMLElement>("[data-guide-menu]");
		if (menuBtn) {
			e.preventDefault();
			e.stopPropagation();
			openGuideRowMenu(menuBtn, menuBtn.dataset.guideMenu!);
			return;
		}

		const actBtn = target.closest<HTMLButtonElement>("button[data-gp-act]");
		if (actBtn && !actBtn.disabled) {
			const act = actBtn.dataset.gpAct;
			if (act === "back") {
				closeGuidePanel();
			} else if (act === "edit") {
				void host.openGuideEditor(guide.id);
			} else if (act === "prev") {
				void stepGuideCursor(-1);
			} else if (act === "next") {
				void stepGuideCursor(1);
			} else if (act === "jump-cursor") {
				const v = deriveForGuide(guide);
				if (v.cursor) {
					scrollToStepInPanel(v.cursor);
					openStepCard(guide.id, v.cursor, { fly: true });
				}
			}
			return;
		}

		const threadBtn = target.closest<HTMLButtonElement>("button[data-gp-thread]");
		if (threadBtn) {
			const th = threadBtn.dataset.gpThread || null;
			host.state.guide.threadFilter = host.state.guide.threadFilter === th ? null : th;
			renderGuidePanel();
			return;
		}

		const secBtn = target.closest<HTMLElement>("[data-gp-sec-toggle]");
		if (secBtn) {
			const secId = secBtn.dataset.gpSecToggle!;
			if (collapsedSections.has(secId)) collapsedSections.delete(secId);
			else collapsedSections.add(secId);
			renderGuidePanel();
			return;
		}

		const checkBtn = target.closest<HTMLElement>("[data-gp-check]");
		if (checkBtn) {
			e.stopPropagation();
			const stepId = checkBtn.dataset.gpCheck!;
			toggleStepDoneFromUI(guide, stepId);
			return;
		}

		const openStepBtn = target.closest<HTMLElement>("[data-gp-open-step]");
		if (openStepBtn) {
			const stepId = openStepBtn.dataset.gpOpenStep!;
			host.setCursor(guide.id, stepId);
			const v = deriveForGuide(guide);
			const cKey = cursorStateKey(guide.id);
			lastEffectiveCursor.set(cKey, v.cursor);
			const ds = v.stepsById.get(stepId);
			lastCursorDoneState.set(cKey, Boolean(ds?.done || ds?.skipped));
			openStepCard(guide.id, stepId, { fly: true, closeSideOnMobile: true });
			renderGuidePanel();
			host.refreshMap();
			host.saveSessionSoon();
		}
	};

	panel.onchange = (e) => {
		if (!host) return;
		const target = e.target as HTMLElement;
		const guide = activeGuide();
		if (!guide) return;

		if (target.matches("select[data-gp-variant]")) {
			const sel = target as HTMLSelectElement;
			host.setVariant(guide.id, sel.dataset.gpVariant!, sel.value);
			renderGuidePanel();
			if (host.state.guide.selectedStepId) renderStepCard();
			host.refreshMap();
			host.saveSessionSoon();
			return;
		}

		if (target.matches("input[data-gp-toggle]")) {
			const inp = target as HTMLInputElement;
			const kind = inp.dataset.gpToggle;
			if (kind === "remaining") {
				host.state.guide.remainingOnly = inp.checked;
				host.refreshMap();
			} else if (kind === "autoadvance") {
				host.state.guide.autoAdvance = inp.checked;
				saveFollowPrefs();
			} else if (kind === "autoswitch") {
				host.state.guide.autoSwitchMap = inp.checked;
				saveFollowPrefs();
			}
		}
	};
}

function toggleStepDoneFromUI(guide: Guide, stepId: string, forceNext = false): void {
	if (!host) return;
	const viewBefore = deriveForGuide(guide);
	const dsBefore = viewBefore.stepsById.get(stepId);
	if (!dsBefore || dsBefore.step.kind !== "task") return;

	const prevCursor = viewBefore.cursor;
	const wasExplicitCursor = host.state.profile?.guides?.[guide.id]?.cursor;
	const markDone = !dsBefore.done;

	// Pin the previous cursor before mutating if completing a non-current step out of order
	if (stepId !== prevCursor && prevCursor && !wasExplicitCursor) {
		host.setCursor(guide.id, prevCursor);
	}

	host.setStepDone(guide.id, stepId, markDone, {
		notify: true,
		markerExists: followMarkerExists,
		onUndo: () => {
			if (!host) return;
			if (wasExplicitCursor !== undefined) {
				host.setCursor(guide.id, wasExplicitCursor);
			} else if (prevCursor) {
				host.setCursor(guide.id, prevCursor);
			}
			const vUndo = deriveForGuide(guide);
			const cKey = cursorStateKey(guide.id);
			lastEffectiveCursor.set(cKey, vUndo.cursor);
			const curUndo = vUndo.cursor ? vUndo.stepsById.get(vUndo.cursor) : null;
			lastCursorDoneState.set(cKey, Boolean(curUndo?.done || curUndo?.skipped));
			if (host.state.guide.selectedStepId) {
				host.state.guide.selectedStepId = prevCursor;
				renderStepCard();
			}
			renderGuidesSidebarSection();
			renderGuidePanel();
			host.refreshMap();
			host.saveSessionSoon();
		},
	});

	const viewAfter = deriveForGuide(guide);
	const cKey = cursorStateKey(guide.id);
	if (markDone && (forceNext || (stepId === prevCursor && host.state.guide.autoAdvance))) {
		const nextId = forceNext
			? (nextVisibleStepId(viewAfter, stepId) ?? nextAutoAdvanceStepId(viewAfter, stepId))
			: nextAutoAdvanceStepId(viewAfter, stepId);
		if (nextId) {
			host.setCursor(guide.id, nextId);
			lastEffectiveCursor.set(cKey, nextId);
			const nextDs = viewAfter.stepsById.get(nextId);
			lastCursorDoneState.set(cKey, Boolean(nextDs?.done || nextDs?.skipped));
			if (host.state.guide.selectedStepId === stepId || forceNext) {
				host.state.guide.selectedStepId = nextId;
				void navigateToStepTarget(guide.id, nextDs, forceNext);
			}
			announceLive(`Step completed. Current step: ${nextDs?.step.title || nextId}`);
		} else {
			announceLive(`Guide "${guide.title}" complete!`);
		}
	} else {
		// Out-of-order completion or auto-advance off: keep cursor on prevCursor
		if (prevCursor) {
			host.setCursor(guide.id, prevCursor);
			lastEffectiveCursor.set(cKey, prevCursor);
			const curAfter = viewAfter.stepsById.get(prevCursor);
			lastCursorDoneState.set(cKey, Boolean(curAfter?.done || curAfter?.skipped));
		}
		announceLive(`${dsBefore.step.title}: ${markDone ? "Done" : "Not done"}`);
	}

	renderGuidesSidebarSection();
	renderGuidePanel();
	if (host.state.guide.selectedStepId) renderStepCard();
	host.refreshMap();
	host.saveSessionSoon();
}

async function navigateToStepTarget(
	guideId: string,
	ds: DerivedStep | undefined,
	allowAutoSwitch = false,
): Promise<void> {
	if (!host || !ds) return;
	const curMap = host.state.mapInfo?.slug || "";
	const fitNow = resolveStepCameraOnMap(ds, curMap);
	if (fitNow) {
		applyCameraFit(fitNow);
		return;
	}
	const fallbackMap = ds.step.zone?.map || resolveStepPrimaryTarget(ds)?.map;
	if (fallbackMap && fallbackMap !== curMap && allowAutoSwitch && host.state.guide.autoSwitchMap) {
		const hadCardOpen = host.state.guide.selectedStepId === ds.step.id;
		await host.switchMap(fallbackMap);
		if (hadCardOpen) openStepCard(guideId, ds.step.id, { fly: false });
		const fitAfter = resolveStepCameraOnMap(ds, fallbackMap);
		if (fitAfter) applyCameraFit(fitAfter);
	}
}

export async function stepGuideCursor(delta: 1 | -1): Promise<void> {
	if (!host) return;
	const guide = activeGuide();
	if (!guide) return;
	const view = deriveForGuide(guide);
	const fromId = host.state.guide.selectedStepId || view.cursor;
	const targetId = delta > 0 ? nextVisibleStepId(view, fromId) : prevVisibleStepId(view, fromId);
	if (!targetId) return;

	host.setCursor(guide.id, targetId);
	const cKey = cursorStateKey(guide.id);
	lastEffectiveCursor.set(cKey, targetId);
	const ds = view.stepsById.get(targetId);
	lastCursorDoneState.set(cKey, Boolean(ds?.done || ds?.skipped));

	if (host.state.guide.panelOpen) {
		renderGuidePanel();
		scrollToStepInPanel(targetId);
	}
	if (host.state.guide.selectedStepId || ds) {
		openStepCard(guide.id, targetId, { fly: false });
	}
	await navigateToStepTarget(guide.id, ds, delta > 0);
	if (ds) announceLive(`Current step: ${ds.step.title}`);
	host.refreshMap();
	host.saveSessionSoon();
}

/* ---------- The Step Card (rendered in #detail) ---------- */

export function openStepCard(
	guideId: string,
	stepId: string,
	opts?: { fly?: boolean; closeSideOnMobile?: boolean },
): void {
	if (!host || typeof document === "undefined") return;
	const guide = (host.state.guides as Guide[]).find((g) => g.id === guideId);
	if (!guide) return;

	host.state.guide.activeId = guide.id;
	host.state.guide.selectedStepId = stepId;

	// Clear any selected marker so #detail shows this step card
	if (host.state.selected != null) {
		host.state.selected = null;
		if (host.state.mapReady && host.state.map?.getSource("sel")) {
			host.state.map.getSource("sel").setData({ type: "FeatureCollection", features: [] });
		}
		host.updateLinks();
	}

	renderStepCard();

	if (opts?.fly !== false) {
		const view = deriveForGuide(guide);
		const ds = view.stepsById.get(stepId);
		const curMap = host.state.mapInfo?.slug || "";
		if (ds) {
			const fit = resolveStepCameraOnMap(ds, curMap);
			if (fit) {
				applyCameraFit(fit, opts?.closeSideOnMobile);
			} else if (opts?.closeSideOnMobile) {
				const isMob = typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches;
				if (isMob) document.body.classList.remove("side-open");
			}
		}
	}
}

export function renderStepCard(): void {
	if (!host || typeof document === "undefined") return;
	const stepId = host.state.guide.selectedStepId;
	const guide = activeGuide();
	if (!stepId || !guide) return;

	const view = deriveForGuide(guide);
	const ds = view.stepsById.get(stepId);
	if (!ds) {
		host.state.guide.selectedStepId = null;
		host.hideDetail();
		return;
	}

	const stepIdx = view.visibleSteps.findIndex((s) => s.step.id === stepId);
	const stepNum = stepIdx >= 0 ? stepIdx + 1 : 1;
	const sec = view.sections.find((s) => s.section.id === ds.sectionId)?.section;
	const prevId = prevVisibleStepId(view, stepId);
	const nextId = nextVisibleStepId(view, stepId);
	const curMap = host.state.mapInfo?.slug || "";

	// Determine if any targets or zone are on another map
	const otherMapSlugs = new Set<string>();
	if (ds.step.zone?.map && ds.step.zone.map !== curMap) {
		otherMapSlugs.add(ds.step.zone.map);
	}
	for (const t of ds.targets) {
		if (t.kind === "point" && t.point?.map && t.point.map !== curMap) {
			otherMapSlugs.add(t.point.map);
		} else if (t.kind === "marker" && t.markerId !== undefined) {
			const loc = lookupMarkerAcrossGame(t.markerId);
			const mSlug = loc?.map || t.target.snapshot?.map;
			if (mSlug && mSlug !== curMap) otherMapSlugs.add(mSlug);
		}
	}

	const crossMapHtml = [...otherMapSlugs]
		.map(
			(slug) =>
				`<div class="gs-cross-map">` +
				`<span>Targets on <b>${esc(mapTitleOf(slug))}</b></span>` +
				`<button type="button" class="chip primary" data-gs-switch-map="${esc(slug)}">Switch to ${esc(mapTitleOf(slug))}</button>` +
				`</div>`,
		)
		.join("");

	const badges: string[] = [];
	if (ds.done) badges.push(`<span class="gp-badge gp-badge-done">Done</span>`);
	else if (ds.partial)
		badges.push(
			`<span class="gp-badge gp-badge-partial">${ds.foundRequiredTargets} of ${ds.requiredTargets}</span>`,
		);
	else if (ds.skipped) badges.push(`<span class="gp-badge gp-badge-skip">Skipped</span>`);
	if (ds.optional) badges.push(`<span class="gp-badge gp-badge-opt">Optional</span>`);
	if (ds.step.missable) badges.push(`<span class="gp-badge gp-badge-missable">Missable</span>`);
	if (ds.step.thread) badges.push(`<span class="gp-badge gp-badge-thread">${esc(ds.step.thread)}</span>`);

	const actionsHtml =
		ds.step.kind === "task"
			? `<div class="gs-actions">` +
				`<button type="button" class="found-btn gs-done-btn${ds.done ? " on" : ""}" data-gs-act="toggle-done" aria-pressed="${ds.done}">` +
				(ds.done
					? "Done · Tap to undo"
					: ds.partial
						? `Mark all as done (${ds.foundRequiredTargets} of ${ds.requiredTargets})`
						: "Mark as done") +
				`</button>` +
				`<div class="gs-sub-actions">` +
				(!ds.done && nextId
					? `<button type="button" class="gs-btn primary" data-gs-act="done-and-next"><span>Mark done &amp; next</span>${host.svgIcon("arrowRight")}</button>`
					: "") +
				`<button type="button" class="gs-btn" data-gs-act="toggle-skip" aria-pressed="${ds.skipped}">` +
				(ds.skipped ? "Skipped · Unskip" : "Skip step") +
				`</button>` +
				`</div>` +
				`</div>`
			: "";

	const navRowHtml =
		`<div class="gs-nav-row">` +
		`<button type="button" class="gs-btn" data-gs-act="prev" ${prevId ? "" : "disabled"}>${host.svgIcon("arrowLeft")}<span>Previous</span></button>` +
		`<button type="button" class="gs-btn" data-gs-act="next" ${nextId ? "" : "disabled"}><span>Next</span>${host.svgIcon("arrowRight")}</button>` +
		`</div>`;

	const consequenceHtml = ds.step.consequence
		? `<div class="gs-consequence" role="note"><strong>Missable / Consequence:</strong> ${esc(ds.step.consequence)}</div>`
		: "";
	const rewardHtml = ds.step.reward
		? `<div class="gs-reward"><strong>Reward:</strong> ${esc(ds.step.reward)}</div>`
		: "";

	// Render targets and their screenshots
	const shotsList: string[] = [];
	const targetsHtml =
		ds.targets.length > 0
			? `<div class="gs-targets"><h3>Targets (${ds.targets.length})</h3><ul class="gs-target-list">` +
				ds.targets
					.map((t) => {
						if (t.kind === "marker" && t.markerId !== undefined) {
							if (t.missing) {
								const snap = t.target.snapshot;
								const title = t.label || snap?.title || `Marker #${t.markerId}`;
								const coordsAttr = snap
									? ` data-gs-fly-lng="${snap.lng}" data-gs-fly-lat="${snap.lat}" data-gs-fly-map="${esc(snap.map || curMap)}"`
									: "";
								return (
									`<li class="gs-target-row is-missing">` +
									`<span class="gs-target-missing-tag">No longer present</span>` +
									`<button type="button" class="gs-target-btn"${coordsAttr}><span class="gs-target-title">${esc(title)}</span></button>` +
									`</li>`
								);
							}
							const loc = lookupMarkerAcrossGame(t.markerId);
							const cat = loc?.cat != null ? host!.state.cats?.get(loc.cat) : null;
							const grp = loc?.cat != null ? host!.state.groupOfCat?.get(loc.cat) : null;
							const icon = cat ? host!.iconHtml(cat.icon, cat.color || grp?.col) : "";
							const title = t.label || loc?.title || t.target.snapshot?.title || `Marker #${t.markerId}`;
							const mSlug = loc?.map || t.target.snapshot?.map || curMap;
							const mapBadge =
								mSlug && mSlug !== curMap
									? `<span class="gp-badge">${esc(mapTitleOf(mSlug))}</span>`
									: "";
							const optBadge = t.optional ? `<span class="gp-badge gp-badge-opt">Optional</span>` : "";

							if (loc?.media?.length) {
								for (const m of loc.media) {
									const mh = host!.mediaHtml(m, { title });
									if (mh) shotsList.push(mh);
								}
							}

							return (
								`<li class="gs-target-row${t.found ? " is-found" : ""}">` +
								`<input type="checkbox" class="gs-target-cb" data-gs-target-cb="${t.markerId}" ${t.found ? "checked" : ""} aria-label="Mark ${esc(title)} as found" />` +
								`<button type="button" class="gs-target-btn" data-gs-target-marker="${t.markerId}" data-gs-fly-map="${esc(mSlug)}">` +
								(icon ? `<span class="ico-wrap">${icon}</span>` : "") +
								`<span class="gs-target-title">${esc(title)}</span>` +
								optBadge +
								mapBadge +
								`</button>` +
								`</li>`
							);
						}

						if (t.kind === "point" && t.point) {
							const title = t.label || ds.step.title || "Waypoint";
							const mSlug = t.point.map || curMap;
							const mapBadge =
								mSlug && mSlug !== curMap
									? `<span class="gp-badge">${esc(mapTitleOf(mSlug))}</span>`
									: "";
							return (
								`<li class="gs-target-row is-point">` +
								`<span class="gp-step-bullet" aria-hidden="true">◎</span>` +
								`<button type="button" class="gs-target-btn" data-gs-fly-lng="${t.point.lng}" data-gs-fly-lat="${t.point.lat}" data-gs-fly-map="${esc(mSlug)}">` +
								`<span class="gs-target-title">${esc(title)}</span>` +
								mapBadge +
								`</button>` +
								`</li>`
							);
						}
						return "";
					})
					.join("") +
				`</ul></div>`
			: "";

	const z = ds.step.zone;
	let zoneHtml = "";
	if (z) {
		const regObj = z.region != null ? host.state.regionById?.get(z.region) : null;
		const zoneLabel = z.region != null ? regObj?.title || `Region #${z.region}` : "Custom area";
		const zoneMapLabel = z.map && z.map !== curMap ? ` (${mapTitleOf(z.map)})` : "";
		const canFocusZone = !z.map || z.map === curMap ? Boolean(resolveStepCameraOnMap(ds, curMap)) : true;
		const avoidItems = (z.avoid || [])
			.map((av, ai) => {
				const markerLoc = av.marker !== undefined ? lookupMarkerAcrossGame(av.marker) : null;
				const kindLabel =
					av.marker !== undefined
						? markerLoc?.title || `Marker #${av.marker}`
						: av.polygon
							? "Marked area"
							: "Note";
				const focusTarget =
					!z.map || z.map === curMap
						? resolveAvoidEntryFocus(av, z.map, curMap, lookupMarkerAcrossGame)
						: null;
				const canFocusAvoid = Boolean(focusTarget) || Boolean(z.map && z.map !== curMap);
				return (
					`<li class="gs-avoid-item">` +
					`<span class="gs-avoid-tag">Avoid</span>` +
					`<span class="gs-avoid-body"><strong>${esc(kindLabel)}</strong>: ${esc(av.note)}</span>` +
					(canFocusAvoid
						? `<button type="button" class="chip gs-avoid-focus" data-gs-avoid-focus="${ai}">Focus</button>`
						: "") +
					`</li>`
				);
			})
			.join("");
		zoneHtml =
			`<div class="gs-zone">` +
			`<div class="gs-zone-head"><h3>Explore Area</h3>` +
			(canFocusZone ? `<button type="button" class="chip" data-gs-act="fit-zone">Focus area</button>` : "") +
			`</div>` +
			`<div class="gs-zone-desc"><span class="gp-badge">${esc(zoneLabel)}${esc(zoneMapLabel)}</span></div>` +
			(avoidItems
				? `<div class="gs-avoid-block"><h4>Exceptions (${z.avoid!.length})</h4><ul class="gs-avoid-list">${avoidItems}</ul></div>`
				: "") +
			`</div>`;
	}

	const linksHtml =
		ds.step.links && ds.step.links.length > 0
			? `<div class="gs-links"><h3>External Links</h3><ul>` +
				ds.step.links
					.map(
						(l) =>
							`<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.url)}</a></li>`,
					)
					.join("") +
				`</ul></div>`
			: "";

	const notesHtml = ds.step.notes ? `<div class="d-desc gs-notes">${host.renderMd(ds.step.notes)}</div>` : "";
	const shotsHtml = shotsList.length > 0 ? `<div class="shots gs-shots">${shotsList.join("")}</div>` : "";

	const body = document.getElementById("detail-body");
	const detail = document.getElementById("detail") as (HTMLElement & { outTimer?: any }) | null;
	if (!body || !detail) return;

	body.innerHTML =
		`<div class="d-cat gs-eyebrow" style="--c:var(--accent-soft)"><i></i>` +
		`<span>${esc(guide.title)}${sec ? ` · ${esc(sec.title)}` : ""} · Step ${stepNum} of ${view.visibleSteps.length}</span>` +
		`</div>` +
		(badges.length ? `<div class="gs-badges-row">${badges.join("")}</div>` : "") +
		`<h2 class="d-title">${esc(ds.step.title)}</h2>` +
		(ds.effectivePlace ? `<div class="d-region">${esc(ds.effectivePlace)}</div>` : "") +
		crossMapHtml +
		consequenceHtml +
		rewardHtml +
		actionsHtml +
		navRowHtml +
		notesHtml +
		zoneHtml +
		targetsHtml +
		shotsHtml +
		linksHtml;

	const backBtn = document.getElementById("detail-back");
	if (backBtn) backBtn.hidden = true;

	clearTimeout(detail.outTimer);
	detail.classList.remove("leaving", "user-loc");
	detail.style.removeProperty("--c");
	detail.hidden = false;
	document.body.classList.add("detail-open");

	wireStepCardEvents(body, guide, ds);

	if ((ds.step.notes && typeof (globalThis as any).marked === "undefined") || !host.detailsReady()) {
		Promise.all([host.ensureMarked(), host.ensureDetails()]).then(() => {
			if (host?.state.guide.selectedStepId === stepId) {
				renderStepCard();
			}
		});
	}
}

function wireStepCardEvents(body: HTMLElement, guide: Guide, ds: DerivedStep): void {
	if (!host) return;

	body.querySelectorAll<HTMLImageElement>(".shots img").forEach((img) =>
		img.addEventListener("error", () => {
			const fb = img.dataset.fallback;
			if (fb) {
				delete img.dataset.fallback;
				img.src = fb;
				return;
			}
			img.replaceWith(
				Object.assign(document.createElement("p"), {
					className: "d-note",
					textContent: "Screenshot not downloaded.",
				}),
			);
		}),
	);

	body.querySelectorAll<HTMLButtonElement>("button[data-gs-act]").forEach((btn) => {
		btn.onclick = (e) => {
			e.stopPropagation();
			if (!host) return;
			const act = btn.dataset.gsAct;
			if (act === "toggle-done") {
				toggleStepDoneFromUI(guide, ds.step.id, false);
			} else if (act === "done-and-next") {
				toggleStepDoneFromUI(guide, ds.step.id, true);
			} else if (act === "toggle-skip") {
				const skipNow = !ds.skipped;
				const prevCur = deriveForGuide(guide).cursor;
				host.setSkipped(guide.id, ds.step.id, skipNow, {
					notify: true,
					onUndo: () => {
						if (!host) return;
						if (prevCur) host.setCursor(guide.id, prevCur);
						renderGuidesSidebarSection();
						renderGuidePanel();
						if (host.state.guide.selectedStepId) renderStepCard();
						host.refreshMap();
						host.saveSessionSoon();
					},
				});
				if (skipNow && ds.step.id === prevCur && host.state.guide.autoAdvance) {
					const vAfter = deriveForGuide(guide);
					const nextId = nextAutoAdvanceStepId(vAfter, ds.step.id);
					if (nextId) {
						host.setCursor(guide.id, nextId);
						host.state.guide.selectedStepId = nextId;
						void navigateToStepTarget(guide.id, vAfter.stepsById.get(nextId), true);
					}
				}
				renderGuidesSidebarSection();
				renderGuidePanel();
				renderStepCard();
				host.refreshMap();
				host.saveSessionSoon();
			} else if (act === "prev") {
				void stepGuideCursor(-1);
			} else if (act === "next") {
				void stepGuideCursor(1);
			} else if (act === "fit-zone") {
				const zMap = ds.step.zone?.map || host.state.mapInfo?.slug || "";
				void (async () => {
					if (!host) return;
					if (zMap && zMap !== host.state.mapInfo?.slug) {
						await host.switchMap(zMap);
						openStepCard(guide.id, ds.step.id, { fly: false });
					}
					const fit = resolveStepCameraOnMap(ds, host.state.mapInfo?.slug || "");
					if (fit) applyCameraFit(fit);
				})();
			}
		};
	});

	body.querySelectorAll<HTMLButtonElement>("button[data-gs-avoid-focus]").forEach((btn) => {
		btn.onclick = async (e) => {
			e.stopPropagation();
			if (!host || !ds.step.zone) return;
			const ai = Number(btn.dataset.gsAvoidFocus);
			const av = ds.step.zone.avoid?.[ai];
			if (!av) return;
			const zMap = ds.step.zone.map || host.state.mapInfo?.slug || "";
			if (zMap && zMap !== host.state.mapInfo?.slug) {
				await host.switchMap(zMap);
				openStepCard(guide.id, ds.step.id, { fly: false });
			}
			const fit = resolveAvoidEntryFocus(
				av,
				ds.step.zone.map,
				host.state.mapInfo?.slug || "",
				lookupMarkerAcrossGame,
			);
			if (fit) applyCameraFit(fit);
		};
	});

	body.querySelectorAll<HTMLButtonElement>("button[data-gs-switch-map]").forEach((btn) => {
		btn.onclick = async (e) => {
			e.stopPropagation();
			if (!host) return;
			const slug = btn.dataset.gsSwitchMap!;
			await host.switchMap(slug);
			openStepCard(guide.id, ds.step.id, { fly: false });
			const target = resolveStepPrimaryTarget(ds);
			if (target && target.map === slug) {
				flyToCoords(target.lng, target.lat);
			}
		};
	});

	body.querySelectorAll<HTMLInputElement>("input[data-gs-target-cb]").forEach((cb) => {
		cb.onchange = (e) => {
			e.stopPropagation();
			if (!host) return;
			const markerId = Number(cb.dataset.gsTargetCb);
			if (Number.isFinite(markerId)) {
				host.toggleMarkerFound(markerId, cb.checked);
			}
		};
	});

	body.querySelectorAll<HTMLButtonElement>("button.gs-target-btn").forEach((btn) => {
		btn.onclick = async (e) => {
			e.stopPropagation();
			if (!host) return;
			const targetMap = btn.dataset.gsFlyMap;
			if (targetMap && targetMap !== host.state.mapInfo?.slug) {
				await host.switchMap(targetMap);
				openStepCard(guide.id, ds.step.id, { fly: false });
			}
			const markerId = btn.dataset.gsTargetMarker ? Number(btn.dataset.gsTargetMarker) : null;
			if (markerId != null && Number.isFinite(markerId)) {
				const loc = lookupMarkerAcrossGame(markerId);
				if (loc) {
					flyToCoords(loc.lng, loc.lat);
				}
				return;
			}
			const lng = Number(btn.dataset.gsFlyLng);
			const lat = Number(btn.dataset.gsFlyLat);
			if (Number.isFinite(lng) && Number.isFinite(lat)) {
				flyToCoords(lng, lat);
			}
		};
	});
}

/* ---------- Marker Detail Card Back-Link ("Step n in <guide>") ---------- */

export function guideBacklinksHtml(markerId: number): string {
	if (!host) return "";
	const guide = activeGuide() || ((host.state.guides as Guide[])?.[0] ?? null);
	if (!guide) return "";
	const view = deriveForGuide(guide);
	const steps = findStepsForMarker(view, markerId);
	if (!steps.length) return "";
	return (
		`<div class="d-guide-links">` +
		steps
			.map(
				(s) =>
					`<button type="button" class="d-guide-link" data-jump-guide="${esc(guide.id)}" data-jump-step="${esc(s.stepId)}">` +
					`Step ${s.stepNumber} in ${esc(guide.title)}` +
					`</button>`,
			)
			.join("") +
		`</div>`
	);
}

/* ---------- Live Found/Progress Change Handler ---------- */

export function onGuideFoundOrProgressChanged(): void {
	if (!host) return;
	const guide = activeGuide();
	if (guide) {
		const cKey = cursorStateKey(guide.id);
		const prevCur = lastEffectiveCursor.get(cKey) ?? host.state.profile?.guides?.[guide.id]?.cursor ?? null;
		const wasDone = lastCursorDoneState.get(cKey) ?? false;
		const view = deriveForGuide(guide);

		if (prevCur && view.stepsById.has(prevCur)) {
			const curStepNow = view.stepsById.get(prevCur)!;
			const isDoneNow = curStepNow.done || curStepNow.skipped;
			if (!wasDone && isDoneNow) {
				// Current step just transitioned to done!
				if (host.state.guide.autoAdvance) {
					const nextId = nextAutoAdvanceStepId(view, prevCur);
					if (nextId) {
						host.setCursor(guide.id, nextId);
						lastEffectiveCursor.set(cKey, nextId);
						const nextStep = view.stepsById.get(nextId);
						lastCursorDoneState.set(cKey, Boolean(nextStep?.done || nextStep?.skipped));
						if (host.state.guide.selectedStepId === prevCur) {
							host.state.guide.selectedStepId = nextId;
						}
					} else {
						lastEffectiveCursor.set(cKey, prevCur);
						lastCursorDoneState.set(cKey, isDoneNow);
					}
				} else {
					host.setCursor(guide.id, prevCur);
					lastEffectiveCursor.set(cKey, prevCur);
					lastCursorDoneState.set(cKey, isDoneNow);
				}
			} else {
				// Out-of-order marker tick on the map: never move the cursor or mutate profile state
				lastEffectiveCursor.set(cKey, view.cursor);
				const curStep = view.cursor ? view.stepsById.get(view.cursor) : null;
				lastCursorDoneState.set(cKey, Boolean(curStep?.done || curStep?.skipped));
			}
		} else {
			lastEffectiveCursor.set(cKey, view.cursor);
			const curStep = view.cursor ? view.stepsById.get(view.cursor) : null;
			lastCursorDoneState.set(cKey, Boolean(curStep?.done || curStep?.skipped));
		}
	}

	renderGuidesSidebarSection();
	if (host.state.guide.panelOpen) renderGuidePanel();
	if (host.state.guide.selectedStepId) renderStepCard();
}

/* ---------- MapLibre Route Window Sources & Layers ---------- */

const emptyFC = { type: "FeatureCollection" as const, features: [] as any[] };
let routeMapWired = new WeakSet<object>();

function ensureGuideMapLayers(map: any): void {
	if (!map || !host) return;
	if (!map.getSource("guide-route-lines")) {
		map.addSource("guide-route-lines", { type: "geojson", data: emptyFC });
	}
	if (!map.getLayer("guide-route-prev")) {
		map.addLayer({
			id: "guide-route-prev",
			type: "line",
			source: "guide-route-lines",
			filter: ["==", ["get", "role"], "prev"],
			layout: { "line-cap": "round", "line-join": "round" },
			paint: {
				"line-color": host.themeVar("accent-soft"),
				"line-width": 2.5,
				"line-opacity": 0.42,
			},
		});
	}
	if (!map.getLayer("guide-route-next")) {
		map.addLayer({
			id: "guide-route-next",
			type: "line",
			source: "guide-route-lines",
			filter: ["!=", ["get", "role"], "prev"],
			layout: { "line-cap": "round", "line-join": "round" },
			paint: {
				"line-color": host.themeVar("accent-soft"),
				"line-width": 2.75,
				"line-opacity": 0.88,
				"line-dasharray": [2.2, 1.6],
			},
		});
	}
	if (!map.getSource("guide-route-pins")) {
		map.addSource("guide-route-pins", { type: "geojson", data: emptyFC });
	}
	if (!map.getLayer("guide-route-pins")) {
		map.addLayer({
			id: "guide-route-pins",
			type: "symbol",
			source: "guide-route-pins",
			layout: {
				"icon-image": ["get", "badgeIcon"],
				"icon-allow-overlap": true,
				"icon-ignore-placement": true,
				"icon-offset": [0, -22],
				"symbol-sort-key": ["case", ["==", ["get", "role"], "current"], 10, 5],
			},
			paint: {
				"icon-opacity": ["case", ["==", ["get", "done"], 1], 0.5, ["==", ["get", "role"], "prev"], 0.58, 1],
			},
		});
	}

	if (!routeMapWired.has(map) && typeof map.on === "function") {
		routeMapWired.add(map);
		map.on("click", "guide-route-pins", (ev: any) => {
			if (!host || host.state.tool !== "pan") return;
			const f = ev.features?.[0];
			const stepId = f?.properties?.stepId;
			const guide = activeGuide();
			if (stepId && guide) {
				host.setCursor(guide.id, stepId);
				openStepCard(guide.id, stepId, { fly: false });
				if (host.state.guide.panelOpen) renderGuidePanel();
				host.refreshMap();
			}
		});
	}
}

export function prepareGuideMapFilterState(): void {
	if (!host) return;
	const guide = activeGuide();
	const showRoute = Boolean(guide && (host.state.guide.panelOpen || host.state.guide.remainingOnly));
	if (!guide || !showRoute) {
		host.state.guide.windowIds = null;
		host.state.guide.remainingIds = null;
		return;
	}
	const view = deriveForGuide(guide);
	const mapSlug = host.state.mapInfo?.slug || "";
	const win = computeGuideRouteWindow(view, mapSlug, lookupMarkerAcrossGame);
	host.state.guide.windowIds = win.windowMarkerIds;
	host.state.guide.remainingIds = host.state.guide.remainingOnly ? computeRemainingMarkerIds(view) : null;
}

export function clearFollowRouteLayers(map: any): void {
	if (!map || !host?.state.mapReady) return;
	ensureGuideMapLayers(map);
	map.getSource("guide-route-lines")?.setData(emptyFC);
	map.getSource("guide-route-pins")?.setData(emptyFC);
}

export function refreshGuideMapLayers(map: any): void {
	if (!host || !map || !host.state.mapReady) return;
	host.perf("refreshGuideRoute", () => {
		ensureGuideMapLayers(map);
		const guide = activeGuide();
		const selectedId = host!.state.guide.selectedStepId as string | null;
		const showRoute = Boolean(guide && (host!.state.guide.panelOpen || host!.state.guide.remainingOnly));
		if (!guide || (!showRoute && !selectedId)) {
			map.getSource("guide-route-lines")?.setData(emptyFC);
			map.getSource("guide-route-pins")?.setData(emptyFC);
			clearZoneMapLayers(map);
			return;
		}

		const view = deriveForGuide(guide);
		const mapSlug = host!.state.mapInfo?.slug || "";
		const regById = host!.state.regionById || new Map();

		const colors = {
			accent: host!.themeVar("accent"),
			accentSoft: host!.themeVar("accent-soft"),
			panel: host!.themeVar("panel"),
			night: host!.themeVar("night"),
			err: host!.themeVar("err") || "#ef4444",
		};

		const zoneStep =
			(selectedId ? view.stepsById.get(selectedId) : null) ||
			(view.cursor ? view.stepsById.get(view.cursor) : null);
		renderZoneOnMap(
			map,
			zoneStep?.step.zone,
			mapSlug,
			regById,
			lookupMarkerAcrossGame,
			colors,
			() => host?.state.tool || "pan",
		);

		if (!showRoute) {
			map.getSource("guide-route-lines")?.setData(emptyFC);
			map.getSource("guide-route-pins")?.setData(emptyFC);
			return;
		}

		const win = computeGuideRouteWindow(view, mapSlug, lookupMarkerAcrossGame, {
			lookupZoneCentroid: (ds) =>
				resolveZoneGeometry(ds.step.zone, mapSlug, regById, lookupMarkerAcrossGame).centroid,
		});

		for (const spec of win.badgesNeeded) {
			if (!map.hasImage(spec.icon)) {
				const img = renderGuideBadgeImageData(spec, colors);
				if (img) map.addImage(spec.icon, img, { pixelRatio: 2 });
			}
		}

		map.getSource("guide-route-lines")?.setData({
			type: "FeatureCollection",
			features: win.lineFeatures,
		});
		map.getSource("guide-route-pins")?.setData({
			type: "FeatureCollection",
			features: win.pinFeatures,
		});
	});
}

/* ---------- Homepage Session Summary Helper ---------- */

export function getFollowedGuideSummary(): {
	id: string;
	title: string;
	done: number;
	total: number;
	nextStep: string | null;
} | null {
	if (!host) return null;
	const guides = (host.state.guides || []) as Guide[];
	if (!guides.length) return null;
	let guide = activeGuide();
	if (!guide) {
		const touchedIds = Object.keys(host.state.profile?.guides || {});
		if (touchedIds.length) {
			guide = guides.find((g) => touchedIds.includes(g.id)) ?? null;
		}
	}
	if (!guide) return null;

	const view = deriveForGuide(guide);
	const curStep = view.cursor ? view.stepsById.get(view.cursor) : null;
	return {
		id: guide.id,
		title: guide.title,
		done: view.counts.done,
		total: view.counts.total,
		nextStep: curStep?.step.title ?? null,
	};
}