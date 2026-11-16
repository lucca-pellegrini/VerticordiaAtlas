// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Guide schema constants, total sanitizer/validator (`cleanGuide`), and pure immutable editing operations.

import type {
	Guide,
	GuideProgress,
	GuideSection,
	GuideStep,
	GuideTarget,
	GuideVariant,
	GuideZone,
	StepKind,
} from "./types.ts";

export type { Guide, GuideProgress, GuideSection, GuideStep, GuideTarget, GuideVariant, GuideZone, StepKind };

export const GUIDE_VERSION = 1;

export const MAX_GUIDE_STEPS = 2000;
export const MAX_GUIDE_SECTIONS = 300;
export const MAX_STEP_TARGETS = 100;
export const MAX_GUIDE_VARIANTS = 8;
export const MIN_VARIANT_OPTIONS = 2;
export const MAX_VARIANT_OPTIONS = 8;
export const MAX_STEP_LINKS = 5;
export const MAX_ZONE_AVOID = 30;
export const MAX_POLYGON_POINTS = 500;

export const MAX_GUIDE_TITLE = 120;
export const MAX_SECTION_TITLE = 120;
export const MAX_STEP_TITLE = 120;
export const MAX_NOTES = 5000;
export const MAX_DESCRIPTION = 2000;
export const MAX_REWARD = 500;
export const MAX_CONSEQUENCE = 1000;
export const MAX_PLACE = 120;
export const MAX_THREAD = 40;
export const MAX_LINK_LABEL = 80;

export const MAX_AUTHOR = 120;
export const MAX_CREDITS = 1000;
export const MAX_SECTION_LEVEL = 40;
export const MAX_SECTION_GATE = 500;
export const MAX_SECTION_AFTER = 500;
export const MAX_VARIANT_LABEL = 60;
export const MAX_OPTION_LABEL = 60;
export const MAX_TARGET_LABEL = 120;
export const MAX_SNAPSHOT_CAT = 80;
export const MAX_AVOID_NOTE = 240;
export const MAX_URL_LENGTH = 2000;
export const MAX_MAP_SLUG = 80;
export const MAX_GAME_ID = 80;

export const MAX_GUIDE_BYTES = 1_500_000;

export const GUIDE_ID_PATTERN = /^[A-Za-z0-9_-]{4,24}$/;
export const GAME_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
export const VARIANT_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
export const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const THREAD_PATTERN = /^[^\r\n]{1,40}$/;

export const STEP_KINDS: readonly StepKind[] = ["task", "waypoint", "info"];

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const ROOT_KEYS = new Set([
	"v",
	"id",
	"game",
	"title",
	"description",
	"author",
	"credits",
	"variants",
	"sections",
	"created",
	"updated",
]);
const VARIANT_KEYS = new Set(["id", "label", "options", "default"]);
const OPTION_KEYS = new Set(["id", "label"]);
const SECTION_KEYS = new Set(["id", "title", "notes", "level", "gate", "after", "optional", "steps"]);
const STEP_KEYS = new Set([
	"id",
	"kind",
	"title",
	"notes",
	"targets",
	"place",
	"samePlace",
	"reward",
	"consequence",
	"optional",
	"missable",
	"thread",
	"only",
	"links",
	"zone",
]);
const TARGET_KEYS = new Set(["kind", "marker", "point", "optional", "label", "snapshot"]);
const POINT_KEYS = new Set(["lat", "lng", "map"]);
const SNAPSHOT_KEYS = new Set(["title", "cat", "lat", "lng", "map"]);
const LINK_KEYS = new Set(["url", "label"]);
const ZONE_KEYS = new Set(["map", "region", "polygon", "avoid"]);
const AVOID_KEYS = new Set(["marker", "polygon", "note"]);
const POLY_PT_KEYS = new Set(["lng", "lat"]);

export interface GuideIssue {
	path: string;
	message: string;
}

export function isSafeKey(k: unknown): k is string {
	return typeof k === "string" && k.length > 0 && !FORBIDDEN_KEYS.has(k);
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
	Boolean(v && typeof v === "object" && !Array.isArray(v));

const own = (obj: Record<string, unknown>, k: string): unknown =>
	Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined;

const utf8Encoder = new TextEncoder();
export function guideByteLength(g: Guide): number {
	return utf8Encoder.encode(JSON.stringify(g)).byteLength;
}

function checkUnknownKeys(
	obj: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
	issues: GuideIssue[],
): void {
	for (const k of Object.keys(obj)) {
		if (FORBIDDEN_KEYS.has(k)) {
			issues.push({ path: path ? `${path}.${k}` : k, message: `Rejected reserved key "${k}".` });
		} else if (!allowed.has(k)) {
			issues.push({ path: path ? `${path}.${k}` : k, message: `Dropped unknown field "${k}".` });
		}
	}
}

function cleanString(
	val: unknown,
	max: number,
	path: string,
	issues: GuideIssue[],
	opts?: { required?: boolean; fallback?: string; singleLine?: boolean },
): string | undefined {
	if (val === undefined) {
		if (opts?.required) {
			issues.push({ path, message: "Missing required text; used default." });
			return opts.fallback ?? "";
		}
		return undefined;
	}
	if (typeof val !== "string") {
		issues.push({ path, message: "Expected a string." });
		return opts?.required ? (opts.fallback ?? "") : undefined;
	}
	let s = opts?.singleLine ? val.replace(/[\r\n]+/g, " ").trim() : val;
	if ([...s].length > max || s.length > max) {
		s = s.slice(0, max);
		issues.push({ path, message: `Clipped text to ${max} characters.` });
	}
	if (opts?.required && !s.trim()) {
		issues.push({ path, message: "Empty text is not allowed; used default." });
		return opts.fallback ?? "Untitled";
	}
	return s;
}

function deterministicGuideId(rawId: unknown, rawTitle: unknown): string {
	const base = typeof rawId === "string" && rawId.trim() ? rawId : typeof rawTitle === "string" ? rawTitle : "guide";
	const cleaned = base
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	if (GUIDE_ID_PATTERN.test(cleaned) && isSafeKey(cleaned)) return cleaned;
	const padded = (cleaned || "guide").padEnd(4, "0").slice(0, 24);
	return GUIDE_ID_PATTERN.test(padded) && isSafeKey(padded) ? padded : "guide-0001";
}

function nextDeterministicId(prefix: string, used: Set<string>, startCounter: { n: number }): string {
	while (true) {
		const candidate = `${prefix}-${startCounter.n++}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
}

function cleanHttpUrl(raw: unknown, path: string, issues: GuideIssue[]): string | null {
	if (typeof raw !== "string" || !raw.trim()) {
		issues.push({ path, message: "Expected a non-empty URL string." });
		return null;
	}
	const trimmed = raw.trim();
	if (trimmed.length > MAX_URL_LENGTH) {
		issues.push({ path, message: `Dropped URL exceeding ${MAX_URL_LENGTH} characters.` });
		return null;
	}
	try {
		const u = new URL(trimmed);
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			issues.push({ path, message: `Dropped URL with unsupported scheme "${u.protocol}".` });
			return null;
		}
		return trimmed;
	} catch {
		issues.push({ path, message: "Dropped malformed URL." });
		return null;
	}
}

function cleanPolygon(raw: unknown, path: string, issues: GuideIssue[]): { lng: number; lat: number }[] | undefined {
	if (!Array.isArray(raw)) {
		issues.push({ path, message: "Expected an array of polygon points." });
		return undefined;
	}
	let list = raw;
	if (list.length > MAX_POLYGON_POINTS) {
		list = list.slice(0, MAX_POLYGON_POINTS);
		issues.push({ path, message: `Clipped polygon to ${MAX_POLYGON_POINTS} points.` });
	}
	const pts: { lng: number; lat: number }[] = [];
	for (let i = 0; i < list.length; i++) {
		const pt = list[i];
		const ptPath = `${path}[${i}]`;
		if (!isPlainObj(pt)) {
			issues.push({ path: ptPath, message: "Dropped invalid polygon point." });
			continue;
		}
		checkUnknownKeys(pt, POLY_PT_KEYS, ptPath, issues);
		const lng = own(pt, "lng");
		const lat = own(pt, "lat");
		if (typeof lng !== "number" || !Number.isFinite(lng) || typeof lat !== "number" || !Number.isFinite(lat)) {
			issues.push({ path: ptPath, message: "Dropped polygon point with non-finite coordinates." });
			continue;
		}
		pts.push({ lng, lat });
	}
	if (pts.length < 3) {
		issues.push({ path, message: "Dropped polygon with fewer than 3 valid points." });
		return undefined;
	}
	return pts;
}

function cleanZone(raw: unknown, path: string, issues: GuideIssue[]): GuideZone | undefined {
	if (!isPlainObj(raw)) {
		issues.push({ path, message: "Dropped invalid zone (expected an object)." });
		return undefined;
	}
	checkUnknownKeys(raw, ZONE_KEYS, path, issues);
	const rawMap = own(raw, "map");
	if (typeof rawMap !== "string" || !rawMap.trim() || !GAME_ID_PATTERN.test(rawMap.trim().slice(0, MAX_MAP_SLUG))) {
		issues.push({ path: `${path}.map`, message: "Dropped zone with missing or invalid map slug." });
		return undefined;
	}
	const map = rawMap.trim().slice(0, MAX_MAP_SLUG);
	if (rawMap.length > MAX_MAP_SLUG) {
		issues.push({ path: `${path}.map`, message: `Clipped map slug to ${MAX_MAP_SLUG} characters.` });
	}

	const zone: GuideZone = { map };

	const rawRegion = own(raw, "region");
	if (rawRegion !== undefined) {
		if (typeof rawRegion === "number" && Number.isInteger(rawRegion) && rawRegion > 0) {
			zone.region = rawRegion;
		} else {
			issues.push({ path: `${path}.region`, message: "Dropped invalid zone region id." });
		}
	}

	const rawPoly = own(raw, "polygon");
	if (rawPoly !== undefined) {
		const poly = cleanPolygon(rawPoly, `${path}.polygon`, issues);
		if (poly) zone.polygon = poly;
	}

	const rawAvoid = own(raw, "avoid");
	if (rawAvoid !== undefined) {
		if (!Array.isArray(rawAvoid)) {
			issues.push({ path: `${path}.avoid`, message: "Dropped non-array zone avoid list." });
		} else {
			let list = rawAvoid;
			if (list.length > MAX_ZONE_AVOID) {
				list = list.slice(0, MAX_ZONE_AVOID);
				issues.push({
					path: `${path}.avoid`,
					message: `Clipped zone avoid list to ${MAX_ZONE_AVOID} entries.`,
				});
			}
			const cleanedAvoid: NonNullable<GuideZone["avoid"]> = [];
			for (let i = 0; i < list.length; i++) {
				const item = list[i];
				const itemPath = `${path}.avoid[${i}]`;
				if (!isPlainObj(item)) {
					issues.push({ path: itemPath, message: "Dropped invalid avoid entry." });
					continue;
				}
				checkUnknownKeys(item, AVOID_KEYS, itemPath, issues);
				const note = cleanString(own(item, "note"), MAX_AVOID_NOTE, `${itemPath}.note`, issues, {
					required: true,
					fallback: "Avoid",
					singleLine: true,
				})!;
				let marker: number | undefined;
				const rawMarker = own(item, "marker");
				if (rawMarker !== undefined) {
					if (typeof rawMarker === "number" && Number.isInteger(rawMarker) && rawMarker > 0) {
						marker = rawMarker;
					} else {
						issues.push({ path: `${itemPath}.marker`, message: "Dropped invalid avoid marker id." });
					}
				}
				let polygon: { lng: number; lat: number }[] | undefined;
				const rawItemPoly = own(item, "polygon");
				if (rawItemPoly !== undefined) {
					polygon = cleanPolygon(rawItemPoly, `${itemPath}.polygon`, issues);
				}
				if (marker === undefined && polygon === undefined) {
					issues.push({
						path: itemPath,
						message: "Dropped avoid entry with neither a valid marker nor a valid polygon.",
					});
					continue;
				}
				cleanedAvoid.push({
					...(marker !== undefined ? { marker } : {}),
					...(polygon !== undefined ? { polygon } : {}),
					note,
				});
			}
			if (cleanedAvoid.length > 0) zone.avoid = cleanedAvoid;
		}
	}

	if (zone.region === undefined && zone.polygon === undefined) {
		issues.push({ path, message: "Dropped zone with neither a valid region nor a valid polygon." });
		return undefined;
	}
	return zone;
}

function cleanTarget(raw: unknown, path: string, issues: GuideIssue[]): GuideTarget | null {
	if (!isPlainObj(raw)) {
		issues.push({ path, message: "Dropped invalid target (expected an object)." });
		return null;
	}
	checkUnknownKeys(raw, TARGET_KEYS, path, issues);

	const kind = own(raw, "kind");
	let base: { kind: "marker"; marker: number } | { kind: "point"; point: { lat: number; lng: number; map: string } };
	if (kind === "marker") {
		const m = own(raw, "marker");
		if (typeof m !== "number" || !Number.isInteger(m) || m <= 0) {
			issues.push({ path: `${path}.marker`, message: "Dropped marker target with invalid or non-positive id." });
			return null;
		}
		base = { kind: "marker", marker: m };
	} else if (kind === "point") {
		const pt = own(raw, "point");
		if (!isPlainObj(pt)) {
			issues.push({ path: `${path}.point`, message: "Dropped point target with missing point object." });
			return null;
		}
		checkUnknownKeys(pt, POINT_KEYS, `${path}.point`, issues);
		const lat = own(pt, "lat");
		const lng = own(pt, "lng");
		const map = own(pt, "map");
		if (
			typeof lat !== "number" ||
			!Number.isFinite(lat) ||
			typeof lng !== "number" ||
			!Number.isFinite(lng) ||
			typeof map !== "string" ||
			!map.trim() ||
			!GAME_ID_PATTERN.test(map.trim().slice(0, MAX_MAP_SLUG))
		) {
			issues.push({
				path: `${path}.point`,
				message: "Dropped point target with non-finite coordinates or invalid map.",
			});
			return null;
		}
		const cleanMap = map.trim().slice(0, MAX_MAP_SLUG);
		base = { kind: "point", point: { lat, lng, map: cleanMap } };
	} else {
		issues.push({
			path: `${path}.kind`,
			message: "Dropped target with unknown kind (expected 'marker' or 'point').",
		});
		return null;
	}

	const out: GuideTarget = { ...base };
	const rawOpt = own(raw, "optional");
	if (rawOpt !== undefined) {
		if (typeof rawOpt === "boolean") out.optional = rawOpt;
		else issues.push({ path: `${path}.optional`, message: "Dropped non-boolean optional flag." });
	}
	const rawLabel = own(raw, "label");
	if (rawLabel !== undefined) {
		const lbl = cleanString(rawLabel, MAX_TARGET_LABEL, `${path}.label`, issues, { singleLine: true });
		if (lbl !== undefined && lbl.length > 0) out.label = lbl;
	}
	const rawSnap = own(raw, "snapshot");
	if (rawSnap !== undefined) {
		if (!isPlainObj(rawSnap)) {
			issues.push({ path: `${path}.snapshot`, message: "Dropped non-object target snapshot." });
		} else {
			checkUnknownKeys(rawSnap, SNAPSHOT_KEYS, `${path}.snapshot`, issues);
			const sLat = own(rawSnap, "lat");
			const sLng = own(rawSnap, "lng");
			const sMap = own(rawSnap, "map");
			const sTitle = cleanString(own(rawSnap, "title"), MAX_STEP_TITLE, `${path}.snapshot.title`, issues, {
				required: true,
				fallback: "Marker",
				singleLine: true,
			});
			if (
				typeof sLat === "number" &&
				Number.isFinite(sLat) &&
				typeof sLng === "number" &&
				Number.isFinite(sLng) &&
				typeof sMap === "string" &&
				sMap.trim() &&
				sTitle
			) {
				const snap: NonNullable<GuideTarget["snapshot"]> = {
					title: sTitle,
					lat: sLat,
					lng: sLng,
					map: sMap.trim().slice(0, MAX_MAP_SLUG),
				};
				const sCat = own(rawSnap, "cat");
				if (sCat !== undefined) {
					const cleanedCat = cleanString(sCat, MAX_SNAPSHOT_CAT, `${path}.snapshot.cat`, issues, {
						singleLine: true,
					});
					if (cleanedCat) snap.cat = cleanedCat;
				}
				out.snapshot = snap;
			} else {
				issues.push({
					path: `${path}.snapshot`,
					message: "Dropped target snapshot with non-finite coordinates or missing map.",
				});
			}
		}
	}
	return out;
}

function enforceByteBudget(guide: Guide, issues: GuideIssue[]): Guide {
	let currentBytes = guideByteLength(guide);
	if (currentBytes <= MAX_GUIDE_BYTES) return guide;

	// Pass 1: trim step and section markdown notes from the end until within budget
	for (let s = guide.sections.length - 1; s >= 0 && currentBytes > MAX_GUIDE_BYTES; s--) {
		const sec = guide.sections[s]!;
		for (let i = sec.steps.length - 1; i >= 0 && currentBytes > MAX_GUIDE_BYTES; i--) {
			const step = sec.steps[i]!;
			let removed = 0;
			if (step.notes) {
				removed += step.notes.length + 10;
				delete step.notes;
			}
			if (step.consequence) {
				removed += step.consequence.length + 16;
				delete step.consequence;
			}
			if (step.reward) {
				removed += step.reward.length + 11;
				delete step.reward;
			}
			if (step.links) {
				removed += JSON.stringify(step.links).length + 10;
				delete step.links;
			}
			if (step.zone) {
				removed += JSON.stringify(step.zone).length + 9;
				delete step.zone;
			}
			if (removed > 0) {
				currentBytes -= removed;
				if (currentBytes <= MAX_GUIDE_BYTES) currentBytes = guideByteLength(guide);
			}
		}
		if (sec.notes) delete sec.notes;
		if (sec.gate) delete sec.gate;
		if (sec.after) delete sec.after;
		currentBytes = guideByteLength(guide);
	}

	// Pass 2: trim excess targets per step from the end
	for (let s = guide.sections.length - 1; s >= 0 && currentBytes > MAX_GUIDE_BYTES; s--) {
		const sec = guide.sections[s]!;
		for (let i = sec.steps.length - 1; i >= 0 && currentBytes > MAX_GUIDE_BYTES; i--) {
			const step = sec.steps[i]!;
			if (step.targets && step.targets.length > 1) {
				const removedTargets = step.targets.splice(1);
				currentBytes -= removedTargets.length * 28;
				if (currentBytes <= MAX_GUIDE_BYTES) currentBytes = guideByteLength(guide);
			}
		}
		currentBytes = guideByteLength(guide);
	}

	// Pass 3: drop trailing steps/sections if still above budget
	while (currentBytes > MAX_GUIDE_BYTES && guide.sections.length > 0) {
		const lastSec = guide.sections[guide.sections.length - 1]!;
		if (lastSec.steps.length > 1) {
			const popped = lastSec.steps.pop()!;
			currentBytes -= JSON.stringify(popped).length;
			if (currentBytes <= MAX_GUIDE_BYTES) currentBytes = guideByteLength(guide);
		} else if (guide.sections.length > 1) {
			guide.sections.pop();
			currentBytes = guideByteLength(guide);
		} else {
			lastSec.steps = [];
			break;
		}
	}

	issues.push({
		path: "",
		message: `Guide exceeded the ${MAX_GUIDE_BYTES.toLocaleString("en-US")}-byte limit and was compacted to fit.`,
	});
	return guide;
}

export function cleanGuide(input: unknown): { guide: Guide | null; issues: GuideIssue[] } {
	const issues: GuideIssue[] = [];
	if (!isPlainObj(input)) {
		return {
			guide: null,
			issues: [{ path: "", message: "Guide must be a JSON object." }],
		};
	}

	checkUnknownKeys(input, ROOT_KEYS, "", issues);

	const v = own(input, "v");
	if (typeof v === "number" && v > GUIDE_VERSION) {
		return {
			guide: null,
			issues: [
				...issues,
				{
					path: "v",
					message: `Unsupported guide format version ${v} (this app supports version ${GUIDE_VERSION}).`,
				},
			],
		};
	}
	if (v !== GUIDE_VERSION) {
		return {
			guide: null,
			issues: [
				...issues,
				{ path: "v", message: `Invalid or missing guide version (expected v: ${GUIDE_VERSION}).` },
			],
		};
	}

	const rawGame = own(input, "game");
	if (typeof rawGame !== "string" || !rawGame.trim()) {
		return {
			guide: null,
			issues: [...issues, { path: "game", message: "Missing or invalid game identifier." }],
		};
	}
	const trimmedGame = rawGame.trim();
	const game = trimmedGame.slice(0, MAX_GAME_ID);
	if (trimmedGame.length > MAX_GAME_ID) {
		issues.push({ path: "game", message: `Clipped game identifier to ${MAX_GAME_ID} characters.` });
	}
	if (!GAME_ID_PATTERN.test(game) || !isSafeKey(game)) {
		return {
			guide: null,
			issues: [...issues, { path: "game", message: "Game identifier contains invalid characters." }],
		};
	}

	const rawSections = own(input, "sections");
	if (!Array.isArray(rawSections) || rawSections.length === 0) {
		return {
			guide: null,
			issues: [...issues, { path: "sections", message: "Guide must contain at least one section." }],
		};
	}

	const rawId = own(input, "id");
	let id: string;
	if (typeof rawId === "string" && GUIDE_ID_PATTERN.test(rawId) && isSafeKey(rawId)) {
		id = rawId;
	} else {
		id = deterministicGuideId(rawId, own(input, "title"));
		issues.push({ path: "id", message: `Invalid or missing guide id; regenerated as "${id}".` });
	}

	const title = cleanString(own(input, "title"), MAX_GUIDE_TITLE, "title", issues, {
		required: true,
		fallback: "Untitled Guide",
		singleLine: true,
	})!;

	const description = cleanString(own(input, "description"), MAX_DESCRIPTION, "description", issues);
	const author = cleanString(own(input, "author"), MAX_AUTHOR, "author", issues, { singleLine: true });
	const credits = cleanString(own(input, "credits"), MAX_CREDITS, "credits", issues);

	// Validate variants first so step `only` filters can be checked against them
	const variantOptionSets = new Map<string, Set<string>>();
	let cleanedVariants: GuideVariant[] | undefined;
	const rawVariants = own(input, "variants");
	if (rawVariants !== undefined) {
		if (!Array.isArray(rawVariants)) {
			issues.push({ path: "variants", message: "Dropped non-array variants field." });
		} else {
			let vList = rawVariants;
			if (vList.length > MAX_GUIDE_VARIANTS) {
				vList = vList.slice(0, MAX_GUIDE_VARIANTS);
				issues.push({ path: "variants", message: `Clipped variants to ${MAX_GUIDE_VARIANTS}.` });
			}
			const validVariants: GuideVariant[] = [];
			for (let i = 0; i < vList.length; i++) {
				const rv = vList[i];
				const vPath = `variants[${i}]`;
				if (!isPlainObj(rv)) {
					issues.push({ path: vPath, message: "Dropped non-object variant." });
					continue;
				}
				checkUnknownKeys(rv, VARIANT_KEYS, vPath, issues);
				const vid = own(rv, "id");
				if (typeof vid !== "string" || !VARIANT_ID_PATTERN.test(vid) || !isSafeKey(vid)) {
					issues.push({ path: `${vPath}.id`, message: "Dropped variant with invalid id." });
					continue;
				}
				if (variantOptionSets.has(vid)) {
					issues.push({ path: `${vPath}.id`, message: `Dropped duplicate variant "${vid}".` });
					continue;
				}
				const vLabel = cleanString(own(rv, "label"), MAX_VARIANT_LABEL, `${vPath}.label`, issues, {
					required: true,
					fallback: vid,
					singleLine: true,
				})!;
				const rawOpts = own(rv, "options");
				if (!Array.isArray(rawOpts)) {
					issues.push({
						path: `${vPath}.options`,
						message: `Dropped variant "${vid}" without an options array.`,
					});
					continue;
				}
				let oList = rawOpts;
				if (oList.length > MAX_VARIANT_OPTIONS) {
					oList = oList.slice(0, MAX_VARIANT_OPTIONS);
					issues.push({
						path: `${vPath}.options`,
						message: `Clipped options of variant "${vid}" to ${MAX_VARIANT_OPTIONS}.`,
					});
				}
				const optIds = new Set<string>();
				const validOpts: { id: string; label: string }[] = [];
				for (let j = 0; j < oList.length; j++) {
					const ro = oList[j];
					const oPath = `${vPath}.options[${j}]`;
					if (!isPlainObj(ro)) {
						issues.push({ path: oPath, message: "Dropped non-object variant option." });
						continue;
					}
					checkUnknownKeys(ro, OPTION_KEYS, oPath, issues);
					const oid = own(ro, "id");
					if (typeof oid !== "string" || !VARIANT_ID_PATTERN.test(oid) || !isSafeKey(oid)) {
						issues.push({ path: `${oPath}.id`, message: "Dropped variant option with invalid id." });
						continue;
					}
					if (optIds.has(oid)) {
						issues.push({ path: `${oPath}.id`, message: `Dropped duplicate option "${oid}".` });
						continue;
					}
					const oLabel = cleanString(own(ro, "label"), MAX_OPTION_LABEL, `${oPath}.label`, issues, {
						required: true,
						fallback: oid,
						singleLine: true,
					})!;
					optIds.add(oid);
					validOpts.push({ id: oid, label: oLabel });
				}
				if (validOpts.length < MIN_VARIANT_OPTIONS) {
					issues.push({
						path: `${vPath}.options`,
						message: `Dropped variant "${vid}" because it has fewer than ${MIN_VARIANT_OPTIONS} valid options.`,
					});
					continue;
				}
				const rawDef = own(rv, "default");
				let def = typeof rawDef === "string" && optIds.has(rawDef) ? rawDef : "";
				if (!def) {
					def = validOpts[0]!.id;
					issues.push({
						path: `${vPath}.default`,
						message: `Invalid or missing default option for variant "${vid}"; defaulted to "${def}".`,
					});
				}
				variantOptionSets.set(vid, optIds);
				validVariants.push({ id: vid, label: vLabel, options: validOpts, default: def });
			}
			if (validVariants.length > 0) cleanedVariants = validVariants;
		}
	}

	// Pre-collect all valid section and step ids to avoid collisions when deterministically regenerating duplicates
	const usedSectionIds = new Set<string>();
	const usedStepIds = new Set<string>();
	const secCounter = { n: 1 };
	const stepCounter = { n: 1 };

	let sectionList = rawSections;
	if (sectionList.length > MAX_GUIDE_SECTIONS) {
		sectionList = sectionList.slice(0, MAX_GUIDE_SECTIONS);
		issues.push({ path: "sections", message: `Clipped guide to ${MAX_GUIDE_SECTIONS} sections.` });
	}

	let totalSteps = 0;
	let stepCapReached = false;
	const sections: GuideSection[] = [];

	for (let sIdx = 0; sIdx < sectionList.length; sIdx++) {
		const rs = sectionList[sIdx];
		const sPath = `sections[${sIdx}]`;
		if (!isPlainObj(rs)) {
			issues.push({ path: sPath, message: "Dropped non-object section." });
			continue;
		}
		checkUnknownKeys(rs, SECTION_KEYS, sPath, issues);

		const rawSecId = own(rs, "id");
		let secId: string;
		if (typeof rawSecId === "string" && ITEM_ID_PATTERN.test(rawSecId) && isSafeKey(rawSecId)) {
			if (!usedSectionIds.has(rawSecId)) {
				secId = rawSecId;
				usedSectionIds.add(secId);
			} else {
				secId = nextDeterministicId("sec", usedSectionIds, secCounter);
				issues.push({
					path: `${sPath}.id`,
					message: `Duplicate section id "${rawSecId}"; regenerated as "${secId}".`,
				});
			}
		} else {
			secId = nextDeterministicId("sec", usedSectionIds, secCounter);
			issues.push({ path: `${sPath}.id`, message: `Invalid or missing section id; regenerated as "${secId}".` });
		}

		const secTitle = cleanString(own(rs, "title"), MAX_SECTION_TITLE, `${sPath}.title`, issues, {
			required: true,
			fallback: `Section ${sections.length + 1}`,
			singleLine: true,
		})!;

		const secNotes = cleanString(own(rs, "notes"), MAX_NOTES, `${sPath}.notes`, issues);
		const secLevel = cleanString(own(rs, "level"), MAX_SECTION_LEVEL, `${sPath}.level`, issues, {
			singleLine: true,
		});
		const secGate = cleanString(own(rs, "gate"), MAX_SECTION_GATE, `${sPath}.gate`, issues, { singleLine: true });
		const secAfter = cleanString(own(rs, "after"), MAX_SECTION_AFTER, `${sPath}.after`, issues, {
			singleLine: true,
		});

		let secOptional: boolean | undefined;
		const rawSecOpt = own(rs, "optional");
		if (rawSecOpt !== undefined) {
			if (typeof rawSecOpt === "boolean") secOptional = rawSecOpt;
			else issues.push({ path: `${sPath}.optional`, message: "Dropped non-boolean section optional flag." });
		}

		const rawSteps = own(rs, "steps");
		let stepArray: unknown[] = [];
		if (!Array.isArray(rawSteps)) {
			issues.push({ path: `${sPath}.steps`, message: "Section steps was not an array; defaulted to empty." });
		} else {
			stepArray = rawSteps;
		}

		const steps: GuideStep[] = [];
		for (let i = 0; i < stepArray.length; i++) {
			if (totalSteps >= MAX_GUIDE_STEPS) {
				if (!stepCapReached) {
					stepCapReached = true;
					issues.push({
						path: `${sPath}.steps[${i}]`,
						message: `Clipped guide to the maximum of ${MAX_GUIDE_STEPS} steps.`,
					});
				}
				break;
			}
			const rStep = stepArray[i];
			const stPath = `${sPath}.steps[${i}]`;
			if (!isPlainObj(rStep)) {
				issues.push({ path: stPath, message: "Dropped non-object step." });
				continue;
			}
			checkUnknownKeys(rStep, STEP_KEYS, stPath, issues);

			const rawStepId = own(rStep, "id");
			let stepId: string;
			if (typeof rawStepId === "string" && ITEM_ID_PATTERN.test(rawStepId) && isSafeKey(rawStepId)) {
				if (!usedStepIds.has(rawStepId)) {
					stepId = rawStepId;
					usedStepIds.add(stepId);
				} else {
					stepId = nextDeterministicId("step", usedStepIds, stepCounter);
					issues.push({
						path: `${stPath}.id`,
						message: `Duplicate step id "${rawStepId}"; regenerated as "${stepId}".`,
					});
				}
			} else {
				stepId = nextDeterministicId("step", usedStepIds, stepCounter);
				issues.push({
					path: `${stPath}.id`,
					message: `Invalid or missing step id; regenerated as "${stepId}".`,
				});
			}

			const rawKind = own(rStep, "kind");
			let kind: StepKind = "task";
			if (typeof rawKind === "string" && (STEP_KINDS as readonly string[]).includes(rawKind)) {
				kind = rawKind as StepKind;
			} else {
				issues.push({ path: `${stPath}.kind`, message: 'Invalid or missing step kind; defaulted to "task".' });
			}

			const stTitle = cleanString(own(rStep, "title"), MAX_STEP_TITLE, `${stPath}.title`, issues, {
				required: true,
				fallback: `Step ${totalSteps + 1}`,
				singleLine: true,
			})!;

			const step: GuideStep = { id: stepId, kind, title: stTitle };

			const stNotes = cleanString(own(rStep, "notes"), MAX_NOTES, `${stPath}.notes`, issues);
			if (stNotes !== undefined) step.notes = stNotes;

			const rawTargets = own(rStep, "targets");
			if (rawTargets !== undefined) {
				if (!Array.isArray(rawTargets)) {
					issues.push({ path: `${stPath}.targets`, message: "Dropped non-array step targets." });
				} else {
					let tList = rawTargets;
					if (tList.length > MAX_STEP_TARGETS) {
						tList = tList.slice(0, MAX_STEP_TARGETS);
						issues.push({
							path: `${stPath}.targets`,
							message: `Clipped step targets to ${MAX_STEP_TARGETS}.`,
						});
					}
					const validTargets: GuideTarget[] = [];
					for (let tIdx = 0; tIdx < tList.length; tIdx++) {
						const ct = cleanTarget(tList[tIdx], `${stPath}.targets[${tIdx}]`, issues);
						if (ct) validTargets.push(ct);
					}
					if (validTargets.length > 0) step.targets = validTargets;
				}
			}

			const stPlace = cleanString(own(rStep, "place"), MAX_PLACE, `${stPath}.place`, issues, {
				singleLine: true,
			});
			if (stPlace !== undefined) step.place = stPlace;

			const rawSamePlace = own(rStep, "samePlace");
			if (rawSamePlace !== undefined) {
				if (typeof rawSamePlace === "boolean") step.samePlace = rawSamePlace;
				else issues.push({ path: `${stPath}.samePlace`, message: "Dropped non-boolean samePlace flag." });
			}

			const stReward = cleanString(own(rStep, "reward"), MAX_REWARD, `${stPath}.reward`, issues, {
				singleLine: true,
			});
			if (stReward !== undefined) step.reward = stReward;

			const stConsequence = cleanString(
				own(rStep, "consequence"),
				MAX_CONSEQUENCE,
				`${stPath}.consequence`,
				issues,
				{
					singleLine: true,
				},
			);
			if (stConsequence !== undefined) step.consequence = stConsequence;

			const rawOpt = own(rStep, "optional");
			if (rawOpt !== undefined) {
				if (typeof rawOpt === "boolean") step.optional = rawOpt;
				else issues.push({ path: `${stPath}.optional`, message: "Dropped non-boolean optional flag." });
			}

			const rawMissable = own(rStep, "missable");
			if (rawMissable !== undefined) {
				if (typeof rawMissable === "boolean") step.missable = rawMissable;
				else issues.push({ path: `${stPath}.missable`, message: "Dropped non-boolean missable flag." });
			}

			const rawThread = own(rStep, "thread");
			if (rawThread !== undefined) {
				const stThread = cleanString(rawThread, MAX_THREAD, `${stPath}.thread`, issues, { singleLine: true });
				if (stThread !== undefined && stThread.length > 0 && THREAD_PATTERN.test(stThread)) {
					step.thread = stThread;
				} else {
					issues.push({ path: `${stPath}.thread`, message: "Dropped empty or invalid thread tag." });
				}
			}

			const rawOnly = own(rStep, "only");
			if (rawOnly !== undefined) {
				if (!isPlainObj(rawOnly)) {
					issues.push({ path: `${stPath}.only`, message: "Dropped non-object step `only` filter." });
				} else {
					const cleanOnly: Record<string, string[]> = Object.create(null);
					let onlyCount = 0;
					for (const varId of Object.keys(rawOnly)) {
						const oPath = `${stPath}.only.${varId}`;
						if (!isSafeKey(varId)) {
							issues.push({ path: oPath, message: `Rejected reserved key "${varId}" in only filter.` });
							continue;
						}
						const validOpts = variantOptionSets.get(varId);
						if (!validOpts) {
							issues.push({
								path: oPath,
								message: `Removed only entry referencing unknown variant "${varId}".`,
							});
							continue;
						}
						const optArr = own(rawOnly, varId);
						if (!Array.isArray(optArr)) {
							issues.push({
								path: oPath,
								message: `Dropped non-array option list for variant "${varId}".`,
							});
							continue;
						}
						const keptOpts: string[] = [];
						for (const o of optArr) {
							if (typeof o === "string" && isSafeKey(o) && validOpts.has(o)) {
								if (!keptOpts.includes(o)) keptOpts.push(o);
							} else {
								issues.push({
									path: oPath,
									message: `Removed unknown option "${String(o)}" for variant "${varId}".`,
								});
							}
						}
						if (keptOpts.length > 0) {
							cleanOnly[varId] = keptOpts;
							onlyCount++;
						} else {
							issues.push({
								path: oPath,
								message: `Removed empty only filter for variant "${varId}".`,
							});
						}
					}
					if (onlyCount > 0) step.only = { ...cleanOnly };
				}
			}

			const rawLinks = own(rStep, "links");
			if (rawLinks !== undefined) {
				if (!Array.isArray(rawLinks)) {
					issues.push({ path: `${stPath}.links`, message: "Dropped non-array step links." });
				} else {
					let lList = rawLinks;
					if (lList.length > MAX_STEP_LINKS) {
						lList = lList.slice(0, MAX_STEP_LINKS);
						issues.push({ path: `${stPath}.links`, message: `Clipped step links to ${MAX_STEP_LINKS}.` });
					}
					const validLinks: { url: string; label?: string }[] = [];
					for (let lIdx = 0; lIdx < lList.length; lIdx++) {
						const rl = lList[lIdx];
						const lPath = `${stPath}.links[${lIdx}]`;
						if (!isPlainObj(rl)) {
							issues.push({ path: lPath, message: "Dropped non-object step link." });
							continue;
						}
						checkUnknownKeys(rl, LINK_KEYS, lPath, issues);
						const url = cleanHttpUrl(own(rl, "url"), `${lPath}.url`, issues);
						if (!url) continue;
						const linkObj: { url: string; label?: string } = { url };
						const rawLbl = own(rl, "label");
						if (rawLbl !== undefined) {
							const lbl = cleanString(rawLbl, MAX_LINK_LABEL, `${lPath}.label`, issues, {
								singleLine: true,
							});
							if (lbl !== undefined && lbl.length > 0) linkObj.label = lbl;
						}
						validLinks.push(linkObj);
					}
					if (validLinks.length > 0) step.links = validLinks;
				}
			}

			const rawZone = own(rStep, "zone");
			if (rawZone !== undefined) {
				const z = cleanZone(rawZone, `${stPath}.zone`, issues);
				if (z) step.zone = z;
			}

			steps.push(step);
			totalSteps++;
		}

		const section: GuideSection = {
			id: secId,
			title: secTitle,
			...(secNotes !== undefined ? { notes: secNotes } : {}),
			...(secLevel !== undefined ? { level: secLevel } : {}),
			...(secGate !== undefined ? { gate: secGate } : {}),
			...(secAfter !== undefined ? { after: secAfter } : {}),
			...(secOptional !== undefined ? { optional: secOptional } : {}),
			steps,
		};
		sections.push(section);
	}

	if (sections.length === 0) {
		return {
			guide: null,
			issues: [...issues, { path: "sections", message: "No usable sections found in guide." }],
		};
	}

	const rawCreated = own(input, "created");
	let created = 0;
	if (typeof rawCreated === "number" && Number.isFinite(rawCreated) && rawCreated >= 0) {
		created = Math.floor(rawCreated);
	} else {
		issues.push({ path: "created", message: "Missing or invalid created timestamp; defaulted to 0." });
	}

	const rawUpdated = own(input, "updated");
	let updated = created;
	if (typeof rawUpdated === "number" && Number.isFinite(rawUpdated) && rawUpdated >= 0) {
		updated = Math.floor(rawUpdated);
	} else {
		issues.push({ path: "updated", message: "Missing or invalid updated timestamp; defaulted to created." });
	}

	const guide: Guide = {
		v: GUIDE_VERSION,
		id,
		game,
		title,
		...(description !== undefined ? { description } : {}),
		...(author !== undefined ? { author } : {}),
		...(credits !== undefined ? { credits } : {}),
		...(cleanedVariants !== undefined ? { variants: cleanedVariants } : {}),
		sections,
		created,
		updated,
	};

	return {
		guide: enforceByteBudget(guide, issues),
		issues,
	};
}

/* ---------- Pure immutable editing operations ---------- */

function randomShortId(prefix = "id", len = 8): string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	const bytes = new Uint8Array(len);
	if (typeof crypto !== "undefined" && crypto.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	let out = "";
	for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
	return `${prefix}-${out}`;
}

export function makeGuideId(): string {
	return randomShortId("g", 10);
}

export function makeSectionId(guide?: Guide): string {
	const existing = new Set((guide?.sections || []).map((s) => s.id));
	let id = randomShortId("sec", 8);
	while (existing.has(id)) id = randomShortId("sec", 8);
	return id;
}

export function makeStepId(guide?: Guide): string {
	const existing = new Set<string>();
	for (const sec of guide?.sections || []) {
		for (const st of sec.steps) existing.add(st.id);
	}
	let id = randomShortId("st", 8);
	while (existing.has(id)) id = randomShortId("st", 8);
	return id;
}

function cloneGuideWithSections(guide: Guide, sections: GuideSection[], nowMs = Date.now()): Guide {
	return {
		...structuredClone(guide),
		sections: structuredClone(sections),
		updated: nowMs,
	};
}

export function insertSection(
	guide: Guide,
	section: Partial<GuideSection> & { title: string },
	index?: number,
	nowMs = Date.now(),
): Guide {
	if (guide.sections.length >= MAX_GUIDE_SECTIONS) return structuredClone(guide);
	const existingSecIds = new Set(guide.sections.map((s) => s.id));
	const secId =
		section.id && ITEM_ID_PATTERN.test(section.id) && isSafeKey(section.id) && !existingSecIds.has(section.id)
			? section.id
			: makeSectionId(guide);
	const newSec: GuideSection = {
		id: secId,
		title: section.title.slice(0, MAX_SECTION_TITLE) || "Section",
		...(section.notes !== undefined ? { notes: section.notes.slice(0, MAX_NOTES) } : {}),
		...(section.level !== undefined ? { level: section.level.slice(0, MAX_SECTION_LEVEL) } : {}),
		...(section.gate !== undefined ? { gate: section.gate.slice(0, MAX_SECTION_GATE) } : {}),
		...(section.after !== undefined ? { after: section.after.slice(0, MAX_SECTION_AFTER) } : {}),
		...(section.optional !== undefined ? { optional: Boolean(section.optional) } : {}),
		steps: structuredClone(section.steps || []),
	};
	const next = guide.sections.map((s) => structuredClone(s));
	const at = index === undefined ? next.length : Math.max(0, Math.min(next.length, index));
	next.splice(at, 0, newSec);
	return cloneGuideWithSections(guide, next, nowMs);
}

export function updateSection(
	guide: Guide,
	sectionId: string,
	patch: Partial<Omit<GuideSection, "id" | "steps">>,
	nowMs = Date.now(),
): Guide {
	const idx = guide.sections.findIndex((s) => s.id === sectionId);
	if (idx < 0) return structuredClone(guide);
	const next = guide.sections.map((s) => structuredClone(s));
	const cur = next[idx]!;
	if (patch.title !== undefined) cur.title = patch.title.slice(0, MAX_SECTION_TITLE) || cur.title;
	if ("notes" in patch) {
		if (patch.notes) cur.notes = patch.notes.slice(0, MAX_NOTES);
		else delete cur.notes;
	}
	if ("level" in patch) {
		if (patch.level) cur.level = patch.level.slice(0, MAX_SECTION_LEVEL);
		else delete cur.level;
	}
	if ("gate" in patch) {
		if (patch.gate) cur.gate = patch.gate.slice(0, MAX_SECTION_GATE);
		else delete cur.gate;
	}
	if ("after" in patch) {
		if (patch.after) cur.after = patch.after.slice(0, MAX_SECTION_AFTER);
		else delete cur.after;
	}
	if ("optional" in patch) {
		if (patch.optional !== undefined) cur.optional = Boolean(patch.optional);
		else delete cur.optional;
	}
	return cloneGuideWithSections(guide, next, nowMs);
}

export function removeSection(guide: Guide, sectionId: string, nowMs = Date.now()): Guide {
	if (guide.sections.length <= 1) return structuredClone(guide);
	const next = guide.sections.filter((s) => s.id !== sectionId).map((s) => structuredClone(s));
	if (next.length === guide.sections.length) return structuredClone(guide);
	return cloneGuideWithSections(guide, next, nowMs);
}

export function moveSection(guide: Guide, sectionId: string, toIndex: number, nowMs = Date.now()): Guide {
	const fromIndex = guide.sections.findIndex((s) => s.id === sectionId);
	if (fromIndex < 0) return structuredClone(guide);
	const next = guide.sections.map((s) => structuredClone(s));
	const [moved] = next.splice(fromIndex, 1);
	const clamped = Math.max(0, Math.min(next.length, toIndex));
	next.splice(clamped, 0, moved!);
	return cloneGuideWithSections(guide, next, nowMs);
}

export function duplicateSection(
	guide: Guide,
	sectionId: string,
	opts?: { newSectionId?: string; makeStepId?: () => string; nowMs?: number },
): Guide {
	if (guide.sections.length >= MAX_GUIDE_SECTIONS) return structuredClone(guide);
	const idx = guide.sections.findIndex((s) => s.id === sectionId);
	if (idx < 0) return structuredClone(guide);
	const orig = guide.sections[idx]!;
	const currentSteps = guide.sections.reduce((acc, s) => acc + s.steps.length, 0);
	if (currentSteps + orig.steps.length > MAX_GUIDE_STEPS) return structuredClone(guide);

	const usedSecIds = new Set(guide.sections.map((s) => s.id));
	const usedStIds = new Set<string>();
	for (const s of guide.sections) for (const st of s.steps) usedStIds.add(st.id);

	let newSecId = opts?.newSectionId;
	if (!newSecId || usedSecIds.has(newSecId) || !ITEM_ID_PATTERN.test(newSecId)) {
		newSecId = makeSectionId(guide);
	}
	usedSecIds.add(newSecId);

	const copySteps = orig.steps.map((st) => {
		const c = structuredClone(st);
		let sid = opts?.makeStepId?.();
		while (!sid || usedStIds.has(sid) || !ITEM_ID_PATTERN.test(sid)) {
			sid = randomShortId("st", 8);
		}
		usedStIds.add(sid);
		c.id = sid;
		return c;
	});

	const copySec: GuideSection = {
		...structuredClone(orig),
		id: newSecId,
		title: `${orig.title} (copy)`.slice(0, MAX_SECTION_TITLE),
		steps: copySteps,
	};
	const next = guide.sections.map((s) => structuredClone(s));
	next.splice(idx + 1, 0, copySec);
	return cloneGuideWithSections(guide, next, opts?.nowMs);
}

export function splitSection(
	guide: Guide,
	sectionId: string,
	beforeStepIndex: number,
	newTitle: string,
	newSectionId?: string,
	nowMs = Date.now(),
): Guide {
	if (guide.sections.length >= MAX_GUIDE_SECTIONS) return structuredClone(guide);
	const idx = guide.sections.findIndex((s) => s.id === sectionId);
	if (idx < 0) return structuredClone(guide);
	const sec = guide.sections[idx]!;
	if (beforeStepIndex <= 0 || beforeStepIndex >= sec.steps.length) return structuredClone(guide);

	const usedSecIds = new Set(guide.sections.map((s) => s.id));
	const sec2Id =
		newSectionId && ITEM_ID_PATTERN.test(newSectionId) && isSafeKey(newSectionId) && !usedSecIds.has(newSectionId)
			? newSectionId
			: makeSectionId(guide);

	const next = guide.sections.map((s) => structuredClone(s));
	const first = next[idx]!;
	const tailSteps = first.steps.splice(beforeStepIndex);
	const second: GuideSection = {
		id: sec2Id,
		title: newTitle.slice(0, MAX_SECTION_TITLE) || `${first.title} (part 2)`.slice(0, MAX_SECTION_TITLE),
		...(first.optional ? { optional: true } : {}),
		steps: tailSteps,
	};
	next.splice(idx + 1, 0, second);
	return cloneGuideWithSections(guide, next, nowMs);
}

export function mergeSections(
	guide: Guide,
	firstSectionId: string,
	secondSectionId: string,
	nowMs = Date.now(),
): Guide {
	if (firstSectionId === secondSectionId) return structuredClone(guide);
	const idx1 = guide.sections.findIndex((s) => s.id === firstSectionId);
	const idx2 = guide.sections.findIndex((s) => s.id === secondSectionId);
	if (idx1 < 0 || idx2 < 0) return structuredClone(guide);
	const next = guide.sections.map((s) => structuredClone(s));
	const first = next[idx1]!;
	const second = next[idx2]!;
	first.steps.push(...second.steps);
	if (second.notes) {
		first.notes = [first.notes, second.notes].filter(Boolean).join("\n\n").slice(0, MAX_NOTES);
	}
	next.splice(idx2, 1);
	return cloneGuideWithSections(guide, next, nowMs);
}

export function insertStep(
	guide: Guide,
	sectionId: string,
	step: Partial<GuideStep> & { title: string },
	index?: number,
	nowMs = Date.now(),
): Guide {
	const totalSteps = guide.sections.reduce((acc, s) => acc + s.steps.length, 0);
	if (totalSteps >= MAX_GUIDE_STEPS) return structuredClone(guide);
	const secIdx = guide.sections.findIndex((s) => s.id === sectionId);
	if (secIdx < 0) return structuredClone(guide);

	const usedStepIds = new Set<string>();
	for (const s of guide.sections) for (const st of s.steps) usedStepIds.add(st.id);

	const stId =
		step.id && ITEM_ID_PATTERN.test(step.id) && isSafeKey(step.id) && !usedStepIds.has(step.id)
			? step.id
			: makeStepId(guide);

	const newStep: GuideStep = {
		...structuredClone(step),
		id: stId,
		kind: step.kind && (STEP_KINDS as readonly string[]).includes(step.kind) ? step.kind : "task",
		title: step.title.slice(0, MAX_STEP_TITLE) || "Step",
	};

	const next = guide.sections.map((s) => structuredClone(s));
	const targetSteps = next[secIdx]!.steps;
	const at = index === undefined ? targetSteps.length : Math.max(0, Math.min(targetSteps.length, index));
	targetSteps.splice(at, 0, newStep);
	return cloneGuideWithSections(guide, next, nowMs);
}

export function updateStep(
	guide: Guide,
	stepId: string,
	patch: Partial<Omit<GuideStep, "id">>,
	nowMs = Date.now(),
): Guide {
	const next = guide.sections.map((s) => structuredClone(s));
	for (const sec of next) {
		const idx = sec.steps.findIndex((st) => st.id === stepId);
		if (idx < 0) continue;
		const cur = sec.steps[idx]!;
		const updated: GuideStep = {
			...cur,
			...structuredClone(patch),
			id: cur.id,
		};
		for (const k of Object.keys(updated) as (keyof GuideStep)[]) {
			if (updated[k] === undefined) delete updated[k];
		}
		sec.steps[idx] = updated;
		return cloneGuideWithSections(guide, next, nowMs);
	}
	return structuredClone(guide);
}

export function removeStep(guide: Guide, stepId: string, nowMs = Date.now()): Guide {
	const next = guide.sections.map((s) => structuredClone(s));
	for (const sec of next) {
		const idx = sec.steps.findIndex((st) => st.id === stepId);
		if (idx >= 0) {
			sec.steps.splice(idx, 1);
			return cloneGuideWithSections(guide, next, nowMs);
		}
	}
	return structuredClone(guide);
}

export function moveStep(
	guide: Guide,
	stepId: string,
	toSectionId: string,
	toIndex: number,
	nowMs = Date.now(),
): Guide {
	const next = guide.sections.map((s) => structuredClone(s));
	let foundStep: GuideStep | null = null;
	for (const sec of next) {
		const idx = sec.steps.findIndex((st) => st.id === stepId);
		if (idx >= 0) {
			[foundStep] = sec.steps.splice(idx, 1);
			break;
		}
	}
	if (!foundStep) return structuredClone(guide);
	const destSec = next.find((s) => s.id === toSectionId);
	if (!destSec) return structuredClone(guide);
	const clamped = Math.max(0, Math.min(destSec.steps.length, toIndex));
	destSec.steps.splice(clamped, 0, foundStep);
	return cloneGuideWithSections(guide, next, nowMs);
}

export function duplicateStep(guide: Guide, stepId: string, newStepId?: string, nowMs = Date.now()): Guide {
	const totalSteps = guide.sections.reduce((acc, s) => acc + s.steps.length, 0);
	if (totalSteps >= MAX_GUIDE_STEPS) return structuredClone(guide);

	const usedStepIds = new Set<string>();
	for (const s of guide.sections) for (const st of s.steps) usedStepIds.add(st.id);

	const next = guide.sections.map((s) => structuredClone(s));
	for (const sec of next) {
		const idx = sec.steps.findIndex((st) => st.id === stepId);
		if (idx < 0) continue;
		const orig = sec.steps[idx]!;
		const copyId =
			newStepId && ITEM_ID_PATTERN.test(newStepId) && isSafeKey(newStepId) && !usedStepIds.has(newStepId)
				? newStepId
				: makeStepId(guide);
		const copy: GuideStep = {
			...structuredClone(orig),
			id: copyId,
			title: `${orig.title} (copy)`.slice(0, MAX_STEP_TITLE),
		};
		sec.steps.splice(idx + 1, 0, copy);
		return cloneGuideWithSections(guide, next, nowMs);
	}
	return structuredClone(guide);
}

// Splits a multi-target step into two steps (first target stays on the original step id; remaining targets move to a
// new step immediately after), or splits a step at a given target index. If the step has <= 1 target, duplicates it
// as a second step with the remaining half.
export function splitStep(
	guide: Guide,
	stepId: string,
	opts?: { afterTargetIndex?: number; newStepId?: string; secondTitle?: string; nowMs?: number },
): Guide {
	const totalSteps = guide.sections.reduce((acc, s) => acc + s.steps.length, 0);
	if (totalSteps >= MAX_GUIDE_STEPS) return structuredClone(guide);

	const usedStepIds = new Set<string>();
	for (const s of guide.sections) for (const st of s.steps) usedStepIds.add(st.id);

	const next = guide.sections.map((s) => structuredClone(s));
	for (const sec of next) {
		const idx = sec.steps.findIndex((st) => st.id === stepId);
		if (idx < 0) continue;
		const first = sec.steps[idx]!;
		const newId =
			opts?.newStepId &&
			ITEM_ID_PATTERN.test(opts.newStepId) &&
			isSafeKey(opts.newStepId) &&
			!usedStepIds.has(opts.newStepId)
				? opts.newStepId
				: makeStepId(guide);

		const second: GuideStep = {
			...structuredClone(first),
			id: newId,
			title: (opts?.secondTitle || `${first.title} (part 2)`).slice(0, MAX_STEP_TITLE),
		};
		if (first.targets && first.targets.length >= 2) {
			const splitAt =
				opts?.afterTargetIndex !== undefined
					? Math.max(1, Math.min(first.targets.length - 1, opts.afterTargetIndex))
					: 1;
			second.targets = first.targets.splice(splitAt);
		}
		sec.steps.splice(idx + 1, 0, second);
		return cloneGuideWithSections(guide, next, opts?.nowMs);
	}
	return structuredClone(guide);
}

// Merges `secondStepId` into `firstStepId`, preserving `firstStepId` and combining targets, notes, and links.
export function mergeSteps(guide: Guide, firstStepId: string, secondStepId: string, nowMs = Date.now()): Guide {
	if (firstStepId === secondStepId) return structuredClone(guide);
	const next = guide.sections.map((s) => structuredClone(s));
	let firstStep: GuideStep | null = null;
	let secondStep: GuideStep | null = null;
	let secondSec: GuideSection | null = null;
	let secondIdx = -1;

	for (const sec of next) {
		for (let i = 0; i < sec.steps.length; i++) {
			const st = sec.steps[i]!;
			if (st.id === firstStepId) firstStep = st;
			if (st.id === secondStepId) {
				secondStep = st;
				secondSec = sec;
				secondIdx = i;
			}
		}
	}
	if (!firstStep || !secondStep || !secondSec || secondIdx < 0) return structuredClone(guide);

	if (secondStep.targets?.length) {
		firstStep.targets = [...(firstStep.targets || []), ...secondStep.targets].slice(0, MAX_STEP_TARGETS);
	}
	if (secondStep.notes) {
		firstStep.notes = [firstStep.notes, secondStep.notes].filter(Boolean).join("\n\n").slice(0, MAX_NOTES);
	}
	if (secondStep.links?.length) {
		firstStep.links = [...(firstStep.links || []), ...secondStep.links].slice(0, MAX_STEP_LINKS);
	}
	if (!firstStep.reward && secondStep.reward) firstStep.reward = secondStep.reward;
	if (!firstStep.consequence && secondStep.consequence) firstStep.consequence = secondStep.consequence;
	if (!firstStep.place && secondStep.place) firstStep.place = secondStep.place;

	secondSec.steps.splice(secondIdx, 1);
	return cloneGuideWithSections(guide, next, nowMs);
}