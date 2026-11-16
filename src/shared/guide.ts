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
const keySet = (csv: string): ReadonlySet<string> => new Set(csv.split(","));
const ROOT_KEYS = keySet("v,id,game,title,description,author,credits,variants,sections,created,updated");
const VARIANT_KEYS = keySet("id,label,options,default");
const OPTION_KEYS = keySet("id,label");
const SECTION_KEYS = keySet("id,title,notes,level,gate,after,optional,steps");
const STEP_KEYS = keySet(
	"id,kind,title,notes,targets,place,samePlace,reward,consequence,optional,missable,thread,only,links,zone",
);
const TARGET_KEYS = keySet("kind,marker,point,optional,label,snapshot");
const POINT_KEYS = keySet("lat,lng,map");
const SNAPSHOT_KEYS = keySet("title,cat,lat,lng,map");
const LINK_KEYS = keySet("url,label");
const ZONE_KEYS = keySet("map,region,polygon,avoid");
const AVOID_KEYS = keySet("marker,polygon,note");
const POLY_PT_KEYS = keySet("lng,lat");

export interface GuideIssue {
	path: string;
	message: string;
}

export const isSafeKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && !FORBIDDEN_KEYS.has(k);

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
	Boolean(v && typeof v === "object" && !Array.isArray(v));

const own = (obj: Record<string, unknown>, k: string): unknown =>
	Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined;

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isFinNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const utf8Encoder = new TextEncoder();
export const guideByteLength = (g: Guide): number => utf8Encoder.encode(JSON.stringify(g)).byteLength;

function checkUnknownKeys(
	obj: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
	issues: GuideIssue[],
): void {
	for (const k of Object.keys(obj)) {
		const p = path ? `${path}.${k}` : k;
		if (FORBIDDEN_KEYS.has(k)) issues.push({ path: p, message: `Rejected reserved key "${k}".` });
		else if (!allowed.has(k)) issues.push({ path: p, message: `Dropped unknown field "${k}".` });
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

function cleanBool(obj: Record<string, unknown>, key: string, path: string, issues: GuideIssue[]): boolean | undefined {
	const v = own(obj, key);
	if (v === undefined) return undefined;
	if (typeof v === "boolean") return v;
	issues.push({ path: `${path}.${key}`, message: `Dropped non-boolean ${key} flag.` });
	return undefined;
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
		const lng = own(pt, "lng"),
			lat = own(pt, "lat");
		if (!isFinNum(lng) || !isFinNum(lat)) {
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
		issues.push({ path, message: "Dropped invalid zone." });
		return undefined;
	}
	checkUnknownKeys(raw, ZONE_KEYS, path, issues);
	const rawMap = own(raw, "map");
	if (typeof rawMap !== "string" || !rawMap.trim() || !GAME_ID_PATTERN.test(rawMap.trim().slice(0, MAX_MAP_SLUG))) {
		issues.push({ path: `${path}.map`, message: "Dropped zone with invalid map slug." });
		return undefined;
	}
	const zone: GuideZone = { map: rawMap.trim().slice(0, MAX_MAP_SLUG) };
	const rawRegion = own(raw, "region");
	if (rawRegion !== undefined) {
		if (isPosInt(rawRegion)) zone.region = rawRegion;
		else issues.push({ path: `${path}.region`, message: "Dropped invalid zone region id." });
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
			const list = rawAvoid.length > MAX_ZONE_AVOID ? rawAvoid.slice(0, MAX_ZONE_AVOID) : rawAvoid;
			if (rawAvoid.length > MAX_ZONE_AVOID) {
				issues.push({ path: `${path}.avoid`, message: `Clipped zone avoid list to ${MAX_ZONE_AVOID}.` });
			}
			const cleanedAvoid: NonNullable<GuideZone["avoid"]> = [];
			for (let i = 0; i < list.length; i++) {
				const item = list[i],
					itemPath = `${path}.avoid[${i}]`;
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
				const rawMarker = own(item, "marker");
				let marker: number | undefined;
				if (rawMarker !== undefined) {
					if (isPosInt(rawMarker)) marker = rawMarker;
					else issues.push({ path: `${itemPath}.marker`, message: "Dropped invalid avoid marker id." });
				}
				const rawItemPoly = own(item, "polygon");
				const polygon =
					rawItemPoly !== undefined ? cleanPolygon(rawItemPoly, `${itemPath}.polygon`, issues) : undefined;
				if (marker === undefined && polygon === undefined) {
					issues.push({ path: itemPath, message: "Dropped empty avoid entry." });
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
		issues.push({ path, message: "Dropped zone without region or polygon." });
		return undefined;
	}
	return zone;
}

function cleanTarget(raw: unknown, path: string, issues: GuideIssue[]): GuideTarget | null {
	if (!isPlainObj(raw)) {
		issues.push({ path, message: "Dropped invalid target." });
		return null;
	}
	checkUnknownKeys(raw, TARGET_KEYS, path, issues);
	const kind = own(raw, "kind");
	let base: { kind: "marker"; marker: number } | { kind: "point"; point: { lat: number; lng: number; map: string } };
	if (kind === "marker") {
		const m = own(raw, "marker");
		if (!isPosInt(m)) {
			issues.push({ path: `${path}.marker`, message: "Dropped marker target with invalid id." });
			return null;
		}
		base = { kind: "marker", marker: m };
	} else if (kind === "point") {
		const pt = own(raw, "point");
		if (!isPlainObj(pt)) {
			issues.push({ path: `${path}.point`, message: "Dropped point target without point." });
			return null;
		}
		checkUnknownKeys(pt, POINT_KEYS, `${path}.point`, issues);
		const lat = own(pt, "lat"),
			lng = own(pt, "lng"),
			map = own(pt, "map");
		if (
			!isFinNum(lat) ||
			!isFinNum(lng) ||
			typeof map !== "string" ||
			!map.trim() ||
			!GAME_ID_PATTERN.test(map.trim().slice(0, MAX_MAP_SLUG))
		) {
			issues.push({ path: `${path}.point`, message: "Dropped invalid point target." });
			return null;
		}
		base = { kind: "point", point: { lat, lng, map: map.trim().slice(0, MAX_MAP_SLUG) } };
	} else {
		issues.push({ path: `${path}.kind`, message: "Dropped target with unknown kind." });
		return null;
	}

	const out: GuideTarget = { ...base };
	const opt = cleanBool(raw, "optional", path, issues);
	if (opt !== undefined) out.optional = opt;
	const lbl = cleanString(own(raw, "label"), MAX_TARGET_LABEL, `${path}.label`, issues, { singleLine: true });
	if (lbl) out.label = lbl;

	const rawSnap = own(raw, "snapshot");
	if (rawSnap !== undefined) {
		if (!isPlainObj(rawSnap)) {
			issues.push({ path: `${path}.snapshot`, message: "Dropped non-object target snapshot." });
		} else {
			checkUnknownKeys(rawSnap, SNAPSHOT_KEYS, `${path}.snapshot`, issues);
			const sLat = own(rawSnap, "lat"),
				sLng = own(rawSnap, "lng"),
				sMap = own(rawSnap, "map");
			const sTitle = cleanString(own(rawSnap, "title"), MAX_STEP_TITLE, `${path}.snapshot.title`, issues, {
				required: true,
				fallback: "Marker",
				singleLine: true,
			});
			if (isFinNum(sLat) && isFinNum(sLng) && typeof sMap === "string" && sMap.trim() && sTitle) {
				const sCat = cleanString(own(rawSnap, "cat"), MAX_SNAPSHOT_CAT, `${path}.snapshot.cat`, issues, {
					singleLine: true,
				});
				out.snapshot = {
					title: sTitle,
					...(sCat ? { cat: sCat } : {}),
					lat: sLat,
					lng: sLng,
					map: sMap.trim().slice(0, MAX_MAP_SLUG),
				};
			} else {
				issues.push({ path: `${path}.snapshot`, message: "Dropped invalid target snapshot." });
			}
		}
	}
	return out;
}

function enforceByteBudget(guide: Guide, issues: GuideIssue[]): Guide {
	let currentBytes = guideByteLength(guide);
	if (currentBytes <= MAX_GUIDE_BYTES) return guide;

	for (let s = guide.sections.length - 1; s >= 0 && currentBytes > MAX_GUIDE_BYTES; s--) {
		const sec = guide.sections[s]!;
		for (let i = sec.steps.length - 1; i >= 0 && currentBytes > MAX_GUIDE_BYTES; i--) {
			const step = sec.steps[i]!;
			for (const k of ["notes", "consequence", "reward", "links", "zone"] as const) {
				if (step[k] !== undefined) {
					currentBytes -= JSON.stringify(step[k]).length + k.length + 4;
					delete step[k];
				}
			}
			if (currentBytes <= MAX_GUIDE_BYTES) currentBytes = guideByteLength(guide);
		}
		delete sec.notes;
		delete sec.gate;
		delete sec.after;
		currentBytes = guideByteLength(guide);
	}
	for (let s = guide.sections.length - 1; s >= 0 && currentBytes > MAX_GUIDE_BYTES; s--) {
		for (let i = guide.sections[s]!.steps.length - 1; i >= 0 && currentBytes > MAX_GUIDE_BYTES; i--) {
			const step = guide.sections[s]!.steps[i]!;
			if (step.targets && step.targets.length > 1) {
				currentBytes -= step.targets.splice(1).length * 28;
				if (currentBytes <= MAX_GUIDE_BYTES) currentBytes = guideByteLength(guide);
			}
		}
		currentBytes = guideByteLength(guide);
	}
	while (currentBytes > MAX_GUIDE_BYTES && guide.sections.length > 0) {
		const lastSec = guide.sections[guide.sections.length - 1]!;
		if (lastSec.steps.length > 1) {
			currentBytes -= JSON.stringify(lastSec.steps.pop()).length;
			if (currentBytes <= MAX_GUIDE_BYTES) currentBytes = guideByteLength(guide);
		} else if (guide.sections.length > 1) {
			guide.sections.pop();
			currentBytes = guideByteLength(guide);
		} else {
			lastSec.steps = [];
			break;
		}
	}
	issues.push({ path: "", message: `Guide exceeded ${MAX_GUIDE_BYTES} bytes and was compacted.` });
	return guide;
}

export function cleanGuide(input: unknown): { guide: Guide | null; issues: GuideIssue[] } {
	const issues: GuideIssue[] = [];
	if (!isPlainObj(input)) {
		return { guide: null, issues: [{ path: "", message: "Guide must be a JSON object." }] };
	}
	checkUnknownKeys(input, ROOT_KEYS, "", issues);

	const v = own(input, "v");
	if (typeof v === "number" && v > GUIDE_VERSION) {
		return {
			guide: null,
			issues: [
				...issues,
				{ path: "v", message: `Unsupported guide format version ${v} (supports v${GUIDE_VERSION}).` },
			],
		};
	}
	if (v !== GUIDE_VERSION) {
		return { guide: null, issues: [...issues, { path: "v", message: `Expected guide version ${GUIDE_VERSION}.` }] };
	}

	const rawGame = own(input, "game");
	if (typeof rawGame !== "string" || !rawGame.trim()) {
		return { guide: null, issues: [...issues, { path: "game", message: "Missing game identifier." }] };
	}
	const trimmedGame = rawGame.trim();
	const game = trimmedGame.slice(0, MAX_GAME_ID);
	if (trimmedGame.length > MAX_GAME_ID) {
		issues.push({ path: "game", message: `Clipped game id to ${MAX_GAME_ID} chars.` });
	}
	if (!GAME_ID_PATTERN.test(game) || !isSafeKey(game)) {
		return { guide: null, issues: [...issues, { path: "game", message: "Invalid game identifier." }] };
	}

	const rawSections = own(input, "sections");
	if (!Array.isArray(rawSections) || rawSections.length === 0) {
		return {
			guide: null,
			issues: [...issues, { path: "sections", message: "Guide must have at least one section." }],
		};
	}

	const rawId = own(input, "id");
	let id: string;
	if (typeof rawId === "string" && GUIDE_ID_PATTERN.test(rawId) && isSafeKey(rawId)) {
		id = rawId;
	} else {
		id = deterministicGuideId(rawId, own(input, "title"));
		issues.push({ path: "id", message: `Regenerated guide id as "${id}".` });
	}

	const title = cleanString(own(input, "title"), MAX_GUIDE_TITLE, "title", issues, {
		required: true,
		fallback: "Untitled Guide",
		singleLine: true,
	})!;
	const description = cleanString(own(input, "description"), MAX_DESCRIPTION, "description", issues);
	const author = cleanString(own(input, "author"), MAX_AUTHOR, "author", issues, { singleLine: true });
	const credits = cleanString(own(input, "credits"), MAX_CREDITS, "credits", issues);

	const variantOptionSets = new Map<string, Set<string>>();
	let cleanedVariants: GuideVariant[] | undefined;
	const rawVariants = own(input, "variants");
	if (rawVariants !== undefined) {
		if (!Array.isArray(rawVariants)) {
			issues.push({ path: "variants", message: "Dropped non-array variants." });
		} else {
			const vList =
				rawVariants.length > MAX_GUIDE_VARIANTS ? rawVariants.slice(0, MAX_GUIDE_VARIANTS) : rawVariants;
			if (rawVariants.length > MAX_GUIDE_VARIANTS) {
				issues.push({ path: "variants", message: `Clipped variants to ${MAX_GUIDE_VARIANTS}.` });
			}
			const validVariants: GuideVariant[] = [];
			for (let i = 0; i < vList.length; i++) {
				const rv = vList[i],
					vPath = `variants[${i}]`;
				if (!isPlainObj(rv)) {
					issues.push({ path: vPath, message: "Dropped non-object variant." });
					continue;
				}
				checkUnknownKeys(rv, VARIANT_KEYS, vPath, issues);
				const vid = own(rv, "id");
				if (
					typeof vid !== "string" ||
					!VARIANT_ID_PATTERN.test(vid) ||
					!isSafeKey(vid) ||
					variantOptionSets.has(vid)
				) {
					issues.push({ path: `${vPath}.id`, message: "Dropped invalid or duplicate variant." });
					continue;
				}
				const vLabel = cleanString(own(rv, "label"), MAX_VARIANT_LABEL, `${vPath}.label`, issues, {
					required: true,
					fallback: vid,
					singleLine: true,
				})!;
				const rawOpts = own(rv, "options");
				if (!Array.isArray(rawOpts)) {
					issues.push({ path: `${vPath}.options`, message: "Dropped variant without options." });
					continue;
				}
				const oList = rawOpts.length > MAX_VARIANT_OPTIONS ? rawOpts.slice(0, MAX_VARIANT_OPTIONS) : rawOpts;
				if (rawOpts.length > MAX_VARIANT_OPTIONS) {
					issues.push({ path: `${vPath}.options`, message: `Clipped options to ${MAX_VARIANT_OPTIONS}.` });
				}
				const optIds = new Set<string>();
				const validOpts: { id: string; label: string }[] = [];
				for (let j = 0; j < oList.length; j++) {
					const ro = oList[j],
						oPath = `${vPath}.options[${j}]`;
					if (!isPlainObj(ro)) {
						issues.push({ path: oPath, message: "Dropped non-object option." });
						continue;
					}
					checkUnknownKeys(ro, OPTION_KEYS, oPath, issues);
					const oid = own(ro, "id");
					if (
						typeof oid !== "string" ||
						!VARIANT_ID_PATTERN.test(oid) ||
						!isSafeKey(oid) ||
						optIds.has(oid)
					) {
						issues.push({ path: `${oPath}.id`, message: "Dropped invalid or duplicate option." });
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
					issues.push({ path: `${vPath}.options`, message: "Dropped variant with < 2 options." });
					continue;
				}
				const rawDef = own(rv, "default");
				let def = typeof rawDef === "string" && optIds.has(rawDef) ? rawDef : "";
				if (!def) {
					def = validOpts[0]!.id;
					issues.push({ path: `${vPath}.default`, message: `Defaulted variant "${vid}" to "${def}".` });
				}
				variantOptionSets.set(vid, optIds);
				validVariants.push({ id: vid, label: vLabel, options: validOpts, default: def });
			}
			if (validVariants.length > 0) cleanedVariants = validVariants;
		}
	}

	const usedSectionIds = new Set<string>();
	const usedStepIds = new Set<string>();
	const secCounter = { n: 1 },
		stepCounter = { n: 1 };

	const sectionList =
		rawSections.length > MAX_GUIDE_SECTIONS ? rawSections.slice(0, MAX_GUIDE_SECTIONS) : rawSections;
	if (rawSections.length > MAX_GUIDE_SECTIONS) {
		issues.push({ path: "sections", message: `Clipped guide to ${MAX_GUIDE_SECTIONS} sections.` });
	}

	let totalSteps = 0,
		stepCapReached = false;
	const sections: GuideSection[] = [];

	for (let sIdx = 0; sIdx < sectionList.length; sIdx++) {
		const rs = sectionList[sIdx],
			sPath = `sections[${sIdx}]`;
		if (!isPlainObj(rs)) {
			issues.push({ path: sPath, message: "Dropped non-object section." });
			continue;
		}
		checkUnknownKeys(rs, SECTION_KEYS, sPath, issues);

		const rawSecId = own(rs, "id");
		let secId: string;
		if (
			typeof rawSecId === "string" &&
			ITEM_ID_PATTERN.test(rawSecId) &&
			isSafeKey(rawSecId) &&
			!usedSectionIds.has(rawSecId)
		) {
			secId = rawSecId;
			usedSectionIds.add(secId);
		} else {
			secId = nextDeterministicId("sec", usedSectionIds, secCounter);
			issues.push({ path: `${sPath}.id`, message: `Regenerated section id as "${secId}".` });
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
		const secOptional = cleanBool(rs, "optional", sPath, issues);

		const rawSteps = own(rs, "steps");
		const stepArray = Array.isArray(rawSteps) ? rawSteps : [];
		if (!Array.isArray(rawSteps)) {
			issues.push({ path: `${sPath}.steps`, message: "Section steps defaulted to empty." });
		}

		const steps: GuideStep[] = [];
		for (let i = 0; i < stepArray.length; i++) {
			if (totalSteps >= MAX_GUIDE_STEPS) {
				if (!stepCapReached) {
					stepCapReached = true;
					issues.push({
						path: `${sPath}.steps[${i}]`,
						message: `Clipped guide to ${MAX_GUIDE_STEPS} steps.`,
					});
				}
				break;
			}
			const rStep = stepArray[i],
				stPath = `${sPath}.steps[${i}]`;
			if (!isPlainObj(rStep)) {
				issues.push({ path: stPath, message: "Dropped non-object step." });
				continue;
			}
			checkUnknownKeys(rStep, STEP_KEYS, stPath, issues);

			const rawStepId = own(rStep, "id");
			let stepId: string;
			if (
				typeof rawStepId === "string" &&
				ITEM_ID_PATTERN.test(rawStepId) &&
				isSafeKey(rawStepId) &&
				!usedStepIds.has(rawStepId)
			) {
				stepId = rawStepId;
				usedStepIds.add(stepId);
			} else {
				stepId = nextDeterministicId("step", usedStepIds, stepCounter);
				issues.push({ path: `${stPath}.id`, message: `Regenerated step id as "${stepId}".` });
			}

			const rawKind = own(rStep, "kind");
			let kind: StepKind = "task";
			if (typeof rawKind === "string" && (STEP_KINDS as readonly string[]).includes(rawKind)) {
				kind = rawKind as StepKind;
			} else {
				issues.push({ path: `${stPath}.kind`, message: 'Defaulted step kind to "task".' });
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
					const tList =
						rawTargets.length > MAX_STEP_TARGETS ? rawTargets.slice(0, MAX_STEP_TARGETS) : rawTargets;
					if (rawTargets.length > MAX_STEP_TARGETS) {
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
			const samePlace = cleanBool(rStep, "samePlace", stPath, issues);
			if (samePlace !== undefined) step.samePlace = samePlace;
			const stReward = cleanString(own(rStep, "reward"), MAX_REWARD, `${stPath}.reward`, issues, {
				singleLine: true,
			});
			if (stReward !== undefined) step.reward = stReward;
			const stConseq = cleanString(own(rStep, "consequence"), MAX_CONSEQUENCE, `${stPath}.consequence`, issues, {
				singleLine: true,
			});
			if (stConseq !== undefined) step.consequence = stConseq;
			const stOpt = cleanBool(rStep, "optional", stPath, issues);
			if (stOpt !== undefined) step.optional = stOpt;
			const stMiss = cleanBool(rStep, "missable", stPath, issues);
			if (stMiss !== undefined) step.missable = stMiss;

			const rawThread = own(rStep, "thread");
			if (rawThread !== undefined) {
				const stThread = cleanString(rawThread, MAX_THREAD, `${stPath}.thread`, issues, { singleLine: true });
				if (stThread && THREAD_PATTERN.test(stThread)) step.thread = stThread;
				else issues.push({ path: `${stPath}.thread`, message: "Dropped invalid thread tag." });
			}

			const rawOnly = own(rStep, "only");
			if (rawOnly !== undefined) {
				if (!isPlainObj(rawOnly)) {
					issues.push({ path: `${stPath}.only`, message: "Dropped non-object only filter." });
				} else {
					const cleanOnly: Record<string, string[]> = Object.create(null);
					let onlyCount = 0;
					for (const varId of Object.keys(rawOnly)) {
						const oPath = `${stPath}.only.${varId}`;
						const validOpts = isSafeKey(varId) ? variantOptionSets.get(varId) : undefined;
						const optArr = isSafeKey(varId) ? own(rawOnly, varId) : undefined;
						if (!validOpts || !Array.isArray(optArr)) {
							issues.push({ path: oPath, message: "Removed invalid only filter entry." });
							continue;
						}
						const keptOpts: string[] = [];
						for (const o of optArr) {
							if (typeof o === "string" && isSafeKey(o) && validOpts.has(o)) {
								if (!keptOpts.includes(o)) keptOpts.push(o);
							} else {
								issues.push({ path: oPath, message: "Removed unknown variant option." });
							}
						}
						if (keptOpts.length > 0) {
							cleanOnly[varId] = keptOpts;
							onlyCount++;
						} else {
							issues.push({ path: oPath, message: "Removed empty only filter." });
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
					const lList = rawLinks.length > MAX_STEP_LINKS ? rawLinks.slice(0, MAX_STEP_LINKS) : rawLinks;
					if (rawLinks.length > MAX_STEP_LINKS) {
						issues.push({ path: `${stPath}.links`, message: `Clipped step links to ${MAX_STEP_LINKS}.` });
					}
					const validLinks: { url: string; label?: string }[] = [];
					for (let lIdx = 0; lIdx < lList.length; lIdx++) {
						const rl = lList[lIdx],
							lPath = `${stPath}.links[${lIdx}]`;
						if (!isPlainObj(rl)) {
							issues.push({ path: lPath, message: "Dropped non-object step link." });
							continue;
						}
						checkUnknownKeys(rl, LINK_KEYS, lPath, issues);
						const rawUrl = own(rl, "url");
						let url: string | null = null;
						if (typeof rawUrl === "string" && rawUrl.trim() && rawUrl.trim().length <= MAX_URL_LENGTH) {
							try {
								const u = new URL(rawUrl.trim());
								if (u.protocol === "http:" || u.protocol === "https:") url = rawUrl.trim();
							} catch {}
						}
						if (!url) {
							issues.push({ path: `${lPath}.url`, message: "Dropped invalid link URL." });
							continue;
						}
						const lbl = cleanString(own(rl, "label"), MAX_LINK_LABEL, `${lPath}.label`, issues, {
							singleLine: true,
						});
						validLinks.push(lbl ? { url, label: lbl } : { url });
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

		sections.push({
			id: secId,
			title: secTitle,
			...(secNotes !== undefined ? { notes: secNotes } : {}),
			...(secLevel !== undefined ? { level: secLevel } : {}),
			...(secGate !== undefined ? { gate: secGate } : {}),
			...(secAfter !== undefined ? { after: secAfter } : {}),
			...(secOptional !== undefined ? { optional: secOptional } : {}),
			steps,
		});
	}

	if (sections.length === 0) {
		return { guide: null, issues: [...issues, { path: "sections", message: "No usable sections found." }] };
	}

	const rawCreated = own(input, "created");
	let created = 0;
	if (isFinNum(rawCreated) && rawCreated >= 0) created = Math.floor(rawCreated);
	else issues.push({ path: "created", message: "Defaulted created timestamp to 0." });

	const rawUpdated = own(input, "updated");
	let updated = created;
	if (isFinNum(rawUpdated) && rawUpdated >= 0) updated = Math.floor(rawUpdated);
	else issues.push({ path: "updated", message: "Defaulted updated timestamp to created." });

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

	return { guide: enforceByteBudget(guide, issues), issues };
}

/* ---------- Pure immutable editing operations ---------- */

function randomShortId(prefix = "id", len = 8): string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	const bytes = new Uint8Array(len);
	if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
	else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
	let out = "";
	for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
	return `${prefix}-${out}`;
}

export const makeGuideId = (): string => randomShortId("g", 10);

export function makeSectionId(guide?: Guide): string {
	const existing = new Set((guide?.sections || []).map((s) => s.id));
	let id = randomShortId("sec", 8);
	while (existing.has(id)) id = randomShortId("sec", 8);
	return id;
}

export function makeStepId(guide?: Guide): string {
	const existing = new Set<string>();
	for (const sec of guide?.sections || []) for (const st of sec.steps) existing.add(st.id);
	let id = randomShortId("st", 8);
	while (existing.has(id)) id = randomShortId("st", 8);
	return id;
}

const cloneGuideWithSections = (guide: Guide, sections: GuideSection[], nowMs = Date.now()): Guide => ({
	...structuredClone(guide),
	sections: structuredClone(sections),
	updated: nowMs,
});

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
	for (const [k, max] of [
		["notes", MAX_NOTES],
		["level", MAX_SECTION_LEVEL],
		["gate", MAX_SECTION_GATE],
		["after", MAX_SECTION_AFTER],
	] as const) {
		if (k in patch) {
			if (patch[k]) cur[k] = patch[k]!.slice(0, max);
			else delete cur[k];
		}
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
	return next.length === guide.sections.length ? structuredClone(guide) : cloneGuideWithSections(guide, next, nowMs);
}

export function moveSection(guide: Guide, sectionId: string, toIndex: number, nowMs = Date.now()): Guide {
	const fromIndex = guide.sections.findIndex((s) => s.id === sectionId);
	if (fromIndex < 0) return structuredClone(guide);
	const next = guide.sections.map((s) => structuredClone(s));
	const [moved] = next.splice(fromIndex, 1);
	next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved!);
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
	if (!newSecId || usedSecIds.has(newSecId) || !ITEM_ID_PATTERN.test(newSecId)) newSecId = makeSectionId(guide);
	usedSecIds.add(newSecId);

	const copySteps = orig.steps.map((st) => {
		const c = structuredClone(st);
		let sid = opts?.makeStepId?.();
		while (!sid || usedStIds.has(sid) || !ITEM_ID_PATTERN.test(sid)) sid = randomShortId("st", 8);
		usedStIds.add(sid);
		c.id = sid;
		return c;
	});

	const next = guide.sections.map((s) => structuredClone(s));
	next.splice(idx + 1, 0, {
		...structuredClone(orig),
		id: newSecId,
		title: `${orig.title} (copy)`.slice(0, MAX_SECTION_TITLE),
		steps: copySteps,
	});
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
	next.splice(idx + 1, 0, {
		id: sec2Id,
		title: newTitle.slice(0, MAX_SECTION_TITLE) || `${first.title} (part 2)`.slice(0, MAX_SECTION_TITLE),
		...(first.optional ? { optional: true } : {}),
		steps: tailSteps,
	});
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
	const first = next[idx1]!,
		second = next[idx2]!;
	first.steps.push(...second.steps);
	if (second.notes) first.notes = [first.notes, second.notes].filter(Boolean).join("\n\n").slice(0, MAX_NOTES);
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
		const updated: GuideStep = { ...cur, ...structuredClone(patch), id: cur.id };
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
	const destSec = foundStep ? next.find((s) => s.id === toSectionId) : null;
	if (!foundStep || !destSec) return structuredClone(guide);
	destSec.steps.splice(Math.max(0, Math.min(destSec.steps.length, toIndex)), 0, foundStep);
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
		sec.steps.splice(idx + 1, 0, {
			...structuredClone(orig),
			id: copyId,
			title: `${orig.title} (copy)`.slice(0, MAX_STEP_TITLE),
		});
		return cloneGuideWithSections(guide, next, nowMs);
	}
	return structuredClone(guide);
}

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

export function mergeSteps(guide: Guide, firstStepId: string, secondStepId: string, nowMs = Date.now()): Guide {
	if (firstStepId === secondStepId) return structuredClone(guide);
	const next = guide.sections.map((s) => structuredClone(s));
	let firstStep: GuideStep | null = null,
		secondStep: GuideStep | null = null,
		secondSec: GuideSection | null = null,
		secondIdx = -1;

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