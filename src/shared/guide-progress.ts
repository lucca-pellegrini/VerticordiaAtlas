// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Pure derived state for guides: visibility, step completion, missing-marker fallback, cursor resolution, and tallies.

import type { Guide, GuideProgress, GuideSection, GuideStep, GuideTarget } from "./types.ts";

export type MarkerExistence = "yes" | "no" | "unknown";
export type MarkerExistsFn = (markerId: number) => MarkerExistence | boolean;

export interface GuideTally {
	total: number;
	required: number;
	done: number;
	doneRequired: number;
	skipped: number;
	remaining: number;
}

export interface DerivedTarget {
	target: GuideTarget;
	index: number;
	kind: "marker" | "point";
	markerId?: number;
	point: { lat: number; lng: number; map: string } | null;
	label: string | undefined;
	missing: boolean;
	optional: boolean;
	required: boolean;
	found: boolean;
}

export type StepStatus = "done" | "partial" | "skipped" | "pending" | "info" | "waypoint";

export interface DerivedStep {
	step: GuideStep;
	sectionId: string;
	visible: boolean;
	optional: boolean;
	status: StepStatus;
	done: boolean;
	partial: boolean;
	skipped: boolean;
	current: boolean;
	passed: boolean;
	targets: DerivedTarget[];
	requiredTargets: number;
	foundRequiredTargets: number;
	manualDoneAt: number | null;
	effectivePlace?: string;
}

export interface DerivedSection {
	section: GuideSection;
	visible: boolean;
	steps: DerivedStep[];
	counts: GuideTally;
}

export interface GuideView {
	guide: Guide;
	variants: Record<string, string>;
	cursor: string | null;
	sections: DerivedSection[];
	stepsById: Map<string, DerivedStep>;
	visibleSteps: DerivedStep[];
	counts: GuideTally;
}

export interface DeriveGuideOptions {
	guide: Guide;
	found: ReadonlySet<number>;
	markerExists?: MarkerExistsFn;
	progress?: GuideProgress | null;
	variants?: Record<string, string> | null;
}

export function resolveVariants(
	guide: Guide,
	progress?: GuideProgress | null,
	overrides?: Record<string, string> | null,
): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	for (const v of guide.variants || []) {
		const validOpts = new Set(v.options.map((o) => o.id));
		const fromOverride =
			overrides && Object.prototype.hasOwnProperty.call(overrides, v.id) ? overrides[v.id] : undefined;
		const fromProg =
			progress?.variants && Object.prototype.hasOwnProperty.call(progress.variants, v.id)
				? progress.variants[v.id]
				: undefined;
		if (fromOverride && validOpts.has(fromOverride)) {
			out[v.id] = fromOverride;
		} else if (fromProg && validOpts.has(fromProg)) {
			out[v.id] = fromProg;
		} else {
			out[v.id] = v.default;
		}
	}
	return { ...out };
}

export function isStepVisible(
	step: GuideStep,
	chosenVariants: Record<string, string>,
	guideVariants?: Guide["variants"],
): boolean {
	if (!step.only) return true;
	const knownVariants = guideVariants ? new Set(guideVariants.map((v) => v.id)) : null;
	for (const varId of Object.keys(step.only)) {
		if (knownVariants && !knownVariants.has(varId)) continue;
		const chosen = chosenVariants[varId];
		if (chosen === undefined) continue;
		const allowed = step.only[varId];
		if (Array.isArray(allowed) && !allowed.includes(chosen)) {
			return false;
		}
	}
	return true;
}

function emptyTally(): GuideTally {
	return {
		total: 0,
		required: 0,
		done: 0,
		doneRequired: 0,
		skipped: 0,
		remaining: 0,
	};
}

export function deriveGuideView({
	guide,
	found,
	markerExists,
	progress,
	variants: variantOverrides,
}: DeriveGuideOptions): GuideView {
	const chosenVariants = resolveVariants(guide, progress, variantOverrides);
	const skippedSet = new Set<string>(progress?.skipped || []);
	const manualDoneMap = progress?.done || null;

	const sections: DerivedSection[] = [];
	const stepsById = new Map<string, DerivedStep>();
	const visibleSteps: DerivedStep[] = [];
	const overallCounts = emptyTally();

	let lastPlace: string | undefined;

	for (const section of guide.sections) {
		const secCounts = emptyTally();
		const derivedSteps: DerivedStep[] = [];
		let secHasVisible = false;

		for (const step of section.steps) {
			const effectivePlace = step.samePlace ? (step.place ?? lastPlace) : step.place;
			if (effectivePlace !== undefined) lastPlace = effectivePlace;

			const visible = isStepVisible(step, chosenVariants, guide.variants);
			if (visible) secHasVisible = true;

			const targets: DerivedTarget[] = [];
			let requiredTargets = 0;
			let foundRequiredTargets = 0;
			let existingMarkerTargets = 0;

			if (step.targets?.length) {
				for (let i = 0; i < step.targets.length; i++) {
					const t = step.targets[i]!;
					if (t.kind === "marker") {
						const ex = markerExists ? markerExists(t.marker) : "unknown";
						const missing = ex === "no" || ex === false;
						const tOpt = Boolean(t.optional);
						const req = !missing && !tOpt;
						const isFound = !missing && found.has(t.marker);
						if (!missing) existingMarkerTargets++;
						if (req) {
							requiredTargets++;
							if (isFound) foundRequiredTargets++;
						}
						const fallbackPt = t.snapshot
							? { lat: t.snapshot.lat, lng: t.snapshot.lng, map: t.snapshot.map }
							: null;
						targets.push({
							target: t,
							index: i,
							kind: "marker",
							markerId: t.marker,
							point: fallbackPt,
							label: t.label ?? t.snapshot?.title,
							missing,
							optional: tOpt,
							required: req,
							found: isFound,
						});
					} else {
						targets.push({
							target: t,
							index: i,
							kind: "point",
							point: t.point,
							label: t.label ?? t.snapshot?.title,
							missing: false,
							optional: Boolean(t.optional),
							required: false,
							found: false,
						});
					}
				}
			}

			// A step is optional if it, its section, or all of its remaining (non-missing) marker targets are flagged optional.
			const allRemainingTargetsOptional = existingMarkerTargets > 0 && requiredTargets === 0;
			const isOptional = Boolean(step.optional || section.optional || allRemainingTargetsOptional);

			let manualDoneAt: number | null = null;
			if (
				manualDoneMap &&
				Object.prototype.hasOwnProperty.call(manualDoneMap, step.id) &&
				typeof manualDoneMap[step.id] === "number" &&
				Number.isFinite(manualDoneMap[step.id]) &&
				manualDoneMap[step.id]! > 0
			) {
				manualDoneAt = manualDoneMap[step.id]!;
			}

			let done = false;
			let partial = false;
			let skipped = false;
			let status: StepStatus;

			if (step.kind === "task") {
				if (requiredTargets > 0) {
					done = foundRequiredTargets === requiredTargets;
					partial = foundRequiredTargets > 0 && foundRequiredTargets < requiredTargets;
				} else {
					done = manualDoneAt !== null;
				}
				skipped = !done && skippedSet.has(step.id);
				status = done ? "done" : partial ? "partial" : skipped ? "skipped" : "pending";
			} else if (step.kind === "waypoint") {
				skipped = skippedSet.has(step.id);
				status = "waypoint";
			} else {
				skipped = skippedSet.has(step.id);
				status = "info";
			}

			const ds: DerivedStep = {
				step,
				sectionId: section.id,
				visible,
				optional: isOptional,
				status,
				done,
				partial,
				skipped,
				current: false,
				passed: false,
				targets,
				requiredTargets,
				foundRequiredTargets,
				manualDoneAt,
				...(effectivePlace !== undefined ? { effectivePlace } : {}),
			};

			derivedSteps.push(ds);
			stepsById.set(step.id, ds);

			if (visible) {
				visibleSteps.push(ds);
				if (step.kind === "task") {
					secCounts.total++;
					overallCounts.total++;
					if (!isOptional) {
						secCounts.required++;
						overallCounts.required++;
					}
					if (done) {
						secCounts.done++;
						overallCounts.done++;
						if (!isOptional) {
							secCounts.doneRequired++;
							overallCounts.doneRequired++;
						}
					} else if (skipped) {
						secCounts.skipped++;
						overallCounts.skipped++;
					}
				}
			}
		}

		secCounts.remaining = Math.max(0, secCounts.total - secCounts.done - secCounts.skipped);
		sections.push({
			section,
			visible: secHasVisible,
			steps: derivedSteps,
			counts: secCounts,
		});
	}

	overallCounts.remaining = Math.max(0, overallCounts.total - overallCounts.done - overallCounts.skipped);

	// Resolve effective cursor
	let cursor: string | null = null;
	const rawCursor = progress?.cursor;
	if (rawCursor && stepsById.has(rawCursor) && stepsById.get(rawCursor)!.visible) {
		cursor = rawCursor;
	} else {
		const fallback = visibleSteps.find((s) => !s.done && !s.skipped);
		cursor = fallback ? fallback.step.id : null;
	}

	let cursorVisIdx = -1;
	if (cursor !== null) {
		cursorVisIdx = visibleSteps.findIndex((s) => s.step.id === cursor);
		if (cursorVisIdx >= 0) {
			visibleSteps[cursorVisIdx]!.current = true;
		}
	}

	for (let i = 0; i < visibleSteps.length; i++) {
		const vs = visibleSteps[i]!;
		const beforeCursor = cursorVisIdx >= 0 && i < cursorVisIdx;
		if (vs.step.kind === "task") {
			vs.passed = vs.done || vs.skipped || beforeCursor;
		} else {
			vs.passed = beforeCursor || vs.skipped;
		}
	}

	return {
		guide,
		variants: chosenVariants,
		cursor,
		sections,
		stepsById,
		visibleSteps,
		counts: overallCounts,
	};
}

// "Next" means the next visible step after the cursor in guide order, whatever its kind.
export function nextVisibleStepId(view: GuideView, fromStepId: string | null = view.cursor): string | null {
	if (!view.visibleSteps.length) return null;
	if (!fromStepId) return view.visibleSteps[0]!.step.id;
	const idx = view.visibleSteps.findIndex((s) => s.step.id === fromStepId);
	if (idx < 0) return view.visibleSteps[0]!.step.id;
	return idx + 1 < view.visibleSteps.length ? view.visibleSteps[idx + 1]!.step.id : null;
}

export function prevVisibleStepId(view: GuideView, fromStepId: string | null = view.cursor): string | null {
	if (!view.visibleSteps.length || !fromStepId) return null;
	const idx = view.visibleSteps.findIndex((s) => s.step.id === fromStepId);
	if (idx <= 0) return null;
	return view.visibleSteps[idx - 1]!.step.id;
}

// Auto-advance after completing a step moves the cursor to the next visible step that is not done and not skipped.
export function nextAutoAdvanceStepId(view: GuideView, completedStepId: string | null = view.cursor): string | null {
	if (!view.visibleSteps.length) return null;
	const startIdx = completedStepId ? view.visibleSteps.findIndex((s) => s.step.id === completedStepId) : -1;
	for (let i = startIdx + 1; i < view.visibleSteps.length; i++) {
		const s = view.visibleSteps[i]!;
		if (!s.done && !s.skipped) return s.step.id;
	}
	for (let i = 0; i <= startIdx && i < view.visibleSteps.length; i++) {
		const s = view.visibleSteps[i]!;
		if (s.step.id !== completedStepId && !s.done && !s.skipped) return s.step.id;
	}
	return null;
}