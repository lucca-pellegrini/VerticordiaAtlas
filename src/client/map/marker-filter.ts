// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/**
 * Pure helper for building MapLibre layer filter expressions for locations.
 * Matches the visibility logic of shownOnMap(), search filtering, and pinned selections.
 */

export interface MarkerFilterOptions {
	hiddenCats?: Iterable<number>;
	tag?: number | string | null;
	tagStrict?: boolean;
	hideFound?: boolean;
	matchingRegions?: Iterable<number> | null;
	searchIds?: Iterable<number> | null;
	pinnedIds?: Iterable<number> | null;
}

export type MapLibreFilter = any[] | boolean | null;

/**
 * Builds a MapLibre filter expression matching the map viewer visibility rules.
 *
 * Rules:
 * 1. Pinned markers (selected marker and related link markers) are ALWAYS shown,
 *    even when their category is hidden, a search is active, or hide-found is on.
 * 2. Non-pinned markers must satisfy all active filters:
 *    - Category must not be hidden.
 *    - Region filter (if active): location must belong to matching region IDs.
 *    - Tag filter (if active):
 *      - "untagged": location must have 0 tags.
 *      - numeric tag: location must include the tag, or have 0 tags if not tagStrict.
 *    - Hide-found (if active): location must not be found (f != 1).
 *    - Search (if active): location ID must be in searchIds.
 */
export function buildMarkerFilter(opts: MarkerFilterOptions): MapLibreFilter {
	const pinned = opts.pinnedIds ? Array.from(opts.pinnedIds) : [];
	const hiddenCats = opts.hiddenCats ? Array.from(opts.hiddenCats) : [];
	const conditions: any[] = [];

	if (hiddenCats.length > 0) {
		conditions.push(["!", ["in", ["get", "cat"], ["literal", hiddenCats]]]);
	}

	if (opts.hideFound) {
		conditions.push(["!=", ["get", "f"], 1]);
	}

	if (opts.matchingRegions != null) {
		const regions = Array.from(opts.matchingRegions);
		if (regions.length === 0) {
			// Region filter is active but matches no regions -> show nothing
			conditions.push(false);
		} else {
			conditions.push(["in", ["get", "region"], ["literal", regions]]);
		}
	}

	if (opts.tag != null) {
		if (opts.tag === "untagged") {
			conditions.push(["==", ["length", ["get", "tags"]], 0]);
		} else if (typeof opts.tag === "number") {
			const tagMatch = ["in", opts.tag, ["get", "tags"]];
			if (opts.tagStrict) {
				conditions.push(tagMatch);
			} else {
				conditions.push(["any", tagMatch, ["==", ["length", ["get", "tags"]], 0]]);
			}
		}
	}

	if (opts.searchIds != null) {
		const ids = Array.from(opts.searchIds);
		if (ids.length === 0) {
			conditions.push(false);
		} else {
			conditions.push(["in", ["get", "id"], ["literal", ids]]);
		}
	}

	let baseFilter: any = null;
	if (conditions.length === 1) {
		baseFilter = conditions[0];
	} else if (conditions.length > 1) {
		baseFilter = ["all", ...conditions];
	}

	if (pinned.length > 0) {
		const pinnedMatch = ["in", ["get", "id"], ["literal", pinned]];
		if (baseFilter == null) return null; // No other filters active -> everything is visible
		return ["any", pinnedMatch, baseFilter];
	}

	return baseFilter;
}