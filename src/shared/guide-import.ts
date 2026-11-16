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