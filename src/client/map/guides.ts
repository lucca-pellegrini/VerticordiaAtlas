// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Client guide store: IndexedDB persistence, per-guide debounced saves, progress mutations wired into the central
// found/undo path, single-guide import/export, and the "Manage guides" dialog.

import { esc } from "../../shared/escape.ts";
import { type MarkerExistsFn } from "../../shared/guide-progress.ts";
import {
	cleanGuide,
	type Guide,
	GUIDE_ID_PATTERN,
	type GuideIssue,
	type GuideProgress,
	isSafeKey,
	ITEM_ID_PATTERN,
	makeGuideId,
	makeSectionId,
	MAX_GUIDE_STEPS,
	MAX_GUIDE_TITLE,
	MAX_GUIDE_VARIANTS,
	VARIANT_ID_PATTERN,
} from "../../shared/guide.ts";
import { dbAll, dbDelete, dbPut } from "./db.ts";
import { applyFoundChange, type FoundChangeRecord, notifyFoundChange, pushCustomUndo } from "./found.ts";
import { refreshAll } from "./map-view.ts";
import { chooseConflicts, scheduleSave, uniqueName } from "./profiles.ts";
import { $, askDialog, state, syncNote, toast } from "./state.ts";

export const guideStoreKey = (game: string, id: string): string => `${game}:${id}`;
export const guideSyncKey = (game: string, id: string): string => `guide:${game}:${id}`;

// Sanitizes `profile.guides` and lazily prunes entries for deleted guides/steps/variants when `knownGuides` is given.
// Returns `undefined` when no guide has progress so `cleanUserData` omits the `guides` field completely.
export function cleanProfileGuides(
	rawGuides: unknown,
	knownGuides?: readonly Guide[] | null,
	nowSec = Math.floor(Date.now() / 1000),
): Record<string, GuideProgress> | undefined {
	if (!rawGuides || typeof rawGuides !== "object" || Array.isArray(rawGuides)) return undefined;

	const knownById = new Map<string, { steps: Set<string>; variants: Map<string, Set<string>> }>();
	if (knownGuides) {
		for (const g of knownGuides) {
			const steps = new Set<string>();
			for (const sec of g.sections) {
				for (const st of sec.steps) steps.add(st.id);
			}
			const variants = new Map<string, Set<string>>();
			for (const v of g.variants || []) {
				variants.set(v.id, new Set(v.options.map((o) => o.id)));
			}
			knownById.set(g.id, { steps, variants });
		}
	}

	const out: Record<string, GuideProgress> = Object.create(null);
	let guideCount = 0;

	for (const guideId of Object.keys(rawGuides as Record<string, unknown>)) {
		if (!isSafeKey(guideId) || !GUIDE_ID_PATTERN.test(guideId)) continue;
		const known = knownGuides ? knownById.get(guideId) : undefined;
		if (knownGuides && !known) continue; // lazy pruning on load when guide no longer exists

		const rawProg = (rawGuides as Record<string, unknown>)[guideId];
		if (!rawProg || typeof rawProg !== "object" || Array.isArray(rawProg)) continue;
		const progObj = rawProg as Record<string, unknown>;

		const cleanedProg: GuideProgress = {};
		let hasContent = false;

		// done: step id -> epoch seconds
		if (progObj.done && typeof progObj.done === "object" && !Array.isArray(progObj.done)) {
			const doneMap: Record<string, number> = Object.create(null);
			let doneCount = 0;
			for (const [sid, rawAt] of Object.entries(progObj.done as Record<string, unknown>)) {
				if (!isSafeKey(sid) || !ITEM_ID_PATTERN.test(sid)) continue;
				if (known && !known.steps.has(sid)) continue;
				if (typeof rawAt !== "number" || !Number.isInteger(rawAt) || rawAt <= 0) continue;
				doneMap[sid] = rawAt > nowSec ? nowSec : rawAt;
				doneCount++;
			}
			if (doneCount > 0) {
				cleanedProg.done = { ...doneMap };
				hasContent = true;
			}
		}

		// skipped: step ids
		if (Array.isArray(progObj.skipped)) {
			const skipped: string[] = [];
			const seen = new Set<string>();
			for (const rawSid of progObj.skipped) {
				if (typeof rawSid !== "string" || !isSafeKey(rawSid) || !ITEM_ID_PATTERN.test(rawSid)) continue;
				if (known && !known.steps.has(rawSid)) continue;
				if (seen.has(rawSid)) continue;
				seen.add(rawSid);
				skipped.push(rawSid);
				if (skipped.length >= MAX_GUIDE_STEPS) break;
			}
			if (skipped.length > 0) {
				cleanedProg.skipped = skipped;
				hasContent = true;
			}
		}

		// cursor: step id
		if (typeof progObj.cursor === "string" && isSafeKey(progObj.cursor) && ITEM_ID_PATTERN.test(progObj.cursor)) {
			if (!known || known.steps.has(progObj.cursor)) {
				cleanedProg.cursor = progObj.cursor;
				hasContent = true;
			}
		}

		// variants: variant id -> option id
		if (progObj.variants && typeof progObj.variants === "object" && !Array.isArray(progObj.variants)) {
			const varMap: Record<string, string> = Object.create(null);
			let varCount = 0;
			for (const [vid, rawOid] of Object.entries(progObj.variants as Record<string, unknown>)) {
				if (varCount >= MAX_GUIDE_VARIANTS) break;
				if (!isSafeKey(vid) || !VARIANT_ID_PATTERN.test(vid)) continue;
				if (typeof rawOid !== "string" || !isSafeKey(rawOid) || !VARIANT_ID_PATTERN.test(rawOid)) continue;
				if (known) {
					const allowed = known.variants.get(vid);
					if (!allowed || !allowed.has(rawOid)) continue;
				}
				varMap[vid] = rawOid;
				varCount++;
			}
			if (varCount > 0) {
				cleanedProg.variants = { ...varMap };
				hasContent = true;
			}
		}

		if (!hasContent) continue;

		if (typeof progObj.updated === "number" && Number.isFinite(progObj.updated) && progObj.updated >= 0) {
			cleanedProg.updated = Math.floor(progObj.updated);
		}

		out[guideId] = cleanedProg;
		guideCount++;
	}

	return guideCount > 0 ? { ...out } : undefined;
}

/* ---------- Client Guide Store & Per-Guide Debounced Persistence ---------- */

const guideSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function isGuideSavePending(id?: string): boolean {
	if (id !== undefined) return guideSaveTimers.has(id);
	return guideSaveTimers.size > 0;
}

export function scheduleGuideSave(id: string, delayMs = 200): void {
	const prev = guideSaveTimers.get(id);
	if (prev) clearTimeout(prev);
	const timer = setTimeout(() => {
		guideSaveTimers.delete(id);
		void saveGuideNow(id);
	}, delayMs);
	guideSaveTimers.set(id, timer);
}

export async function saveGuideNow(id: string): Promise<void> {
	const timer = guideSaveTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		guideSaveTimers.delete(id);
	}
	const g = (state.guides as Guide[] | undefined)?.find((x) => x.id === id);
	if (!g) return;
	const key = guideStoreKey(g.game, g.id);
	try {
		await dbPut("guides", { ...structuredClone(g), key });
		syncNote([guideSyncKey(g.game, g.id)]);
	} catch (e) {
		console.error(e);
		toast("Could not save guide in this browser.");
	}
}

export async function flushGuideSaves(): Promise<void> {
	const pendingIds = [...guideSaveTimers.keys()];
	for (const id of pendingIds) {
		await saveGuideNow(id);
	}
}

export async function loadGuides(gameId: string = state.entry?.id): Promise<Guide[]> {
	if (!gameId) {
		state.guides = [];
		state.guidesLoaded = false;
		return [];
	}
	const rows = await dbAll("guides");
	const loaded: Guide[] = [];
	for (const r of rows) {
		if (!r || r.game !== gameId) continue;
		const { key: _key, ...rest } = r;
		const { guide } = cleanGuide(rest);
		if (guide && guide.game === gameId) loaded.push(guide);
	}
	loaded.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
	state.guides = loaded;
	state.guidesLoaded = true;

	// Lazily prune profile.guides now that the game's guides are loaded
	if (state.profile?.guides) {
		const pruned = cleanProfileGuides(state.profile.guides, loaded);
		if (pruned) state.profile.guides = pruned;
		else delete state.profile.guides;
	}
	return loaded;
}

export async function reloadGuidesFromStore(gameId: string = state.entry?.id): Promise<Guide[]> {
	if (!gameId) return [];
	const unsaved = new Map<string, Guide>();
	for (const id of guideSaveTimers.keys()) {
		const cur = (state.guides as Guide[] | undefined)?.find((g) => g.id === id);
		if (cur) unsaved.set(id, cur);
	}
	const rows = await dbAll("guides");
	const byId = new Map<string, Guide>();
	for (const r of rows) {
		if (!r || r.game !== gameId) continue;
		const { key: _key, ...rest } = r;
		const { guide } = cleanGuide(rest);
		if (guide && guide.game === gameId) byId.set(guide.id, guide);
	}
	for (const [id, g] of unsaved) {
		byId.set(id, g);
	}
	const list = [...byId.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
	state.guides = list;
	state.guidesLoaded = true;
	return list;
}

export async function createGuide(input: Partial<Guide> & { title: string; game?: string }): Promise<Guide> {
	const game = input.game || state.entry?.id || "game";
	const now = Date.now();
	const raw: Guide = {
		v: 1,
		id: input.id && GUIDE_ID_PATTERN.test(input.id) ? input.id : makeGuideId(),
		game,
		title: input.title.slice(0, MAX_GUIDE_TITLE) || "Untitled Guide",
		...(input.description ? { description: input.description } : {}),
		...(input.author ? { author: input.author } : {}),
		...(input.credits ? { credits: input.credits } : {}),
		...(input.variants ? { variants: input.variants } : {}),
		sections: input.sections?.length ? input.sections : [{ id: makeSectionId(), title: "Section 1", steps: [] }],
		created: input.created ?? now,
		updated: input.updated ?? now,
	};
	const { guide } = cleanGuide(raw);
	if (!guide) throw new Error("Could not create guide");
	if (!Array.isArray(state.guides)) state.guides = [];
	const idx = state.guides.findIndex((g: Guide) => g.id === guide.id);
	if (idx >= 0) state.guides[idx] = guide;
	else state.guides.push(guide);
	await saveGuideNow(guide.id);
	return guide;
}

export async function updateGuide(
	id: string,
	nextOrUpdater: Guide | ((prev: Guide) => Guide),
	opts?: { immediate?: boolean; nowMs?: number },
): Promise<Guide | null> {
	if (!Array.isArray(state.guides)) return null;
	const idx = state.guides.findIndex((g: Guide) => g.id === id);
	if (idx < 0) return null;
	const prev = state.guides[idx] as Guide;
	const candidate = typeof nextOrUpdater === "function" ? nextOrUpdater(structuredClone(prev)) : nextOrUpdater;
	const { guide } = cleanGuide({
		...candidate,
		id: prev.id,
		game: prev.game,
		updated: opts?.nowMs ?? Date.now(),
	});
	if (!guide) return null;
	state.guides[idx] = guide;
	if (opts?.immediate) await saveGuideNow(id);
	else scheduleGuideSave(id);
	return guide;
}

export async function renameGuide(id: string, newTitle: string): Promise<boolean> {
	const trimmed = newTitle.trim().slice(0, MAX_GUIDE_TITLE);
	if (!trimmed) return false;
	const updated = await updateGuide(id, (g) => ({ ...g, title: trimmed }), { immediate: true });
	return updated !== null;
}

export async function deleteGuide(id: string, opts?: { withUndoToast?: boolean }): Promise<Guide | null> {
	if (!Array.isArray(state.guides)) return null;
	const idx = state.guides.findIndex((g: Guide) => g.id === id);
	if (idx < 0) return null;
	const [removed] = state.guides.splice(idx, 1) as [Guide];
	const timer = guideSaveTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		guideSaveTimers.delete(id);
	}
	const storeKey = guideStoreKey(removed.game, removed.id);
	const syncKey = guideSyncKey(removed.game, removed.id);
	await dbDelete("guides", storeKey);
	syncNote([syncKey]);

	if (opts?.withUndoToast !== false) {
		toast(`Deleted guide "${removed.title}".`, 6000, {
			label: "Undo",
			onClick: () => {
				if (!Array.isArray(state.guides)) state.guides = [];
				if (!state.guides.some((g: Guide) => g.id === removed.id)) {
					state.guides.push(removed);
					state.guides.sort((a: Guide, b: Guide) => a.created - b.created || a.id.localeCompare(b.id));
				}
				void dbPut("guides", { ...structuredClone(removed), key: storeKey }).then(() => {
					syncNote([syncKey]);
					if (typeof document !== "undefined") refreshAll();
				});
			},
		});
	}
	return removed;
}

const refreshIfDom = (): void => {
	if (typeof document !== "undefined") refreshAll();
};

/* ---------- Progress Mutators (wired into central found.ts & single undo stack) ---------- */

function ensureGuideProgressEntry(guideId: string): GuideProgress {
	const p = state.profile;
	if (!p) throw new Error("No active profile");
	if (!p.guides || typeof p.guides !== "object") p.guides = {};
	if (!p.guides[guideId]) p.guides[guideId] = {};
	return p.guides[guideId]!;
}

function pruneEmptyGuideEntry(guideId: string): void {
	const p = state.profile;
	if (!p?.guides) return;
	const entry = p.guides[guideId];
	if (!entry) return;
	if (entry.done && Object.keys(entry.done).length === 0) delete entry.done;
	if (entry.skipped && entry.skipped.length === 0) delete entry.skipped;
	if (entry.variants && Object.keys(entry.variants).length === 0) delete entry.variants;
	if (!entry.done && !entry.skipped && !entry.cursor && !entry.variants) {
		delete p.guides[guideId];
	}
	if (Object.keys(p.guides).length === 0) {
		delete p.guides;
	}
}

function findGuideAndStep(
	guideId: string,
	stepId: string,
): { guide: Guide; step: Guide["sections"][0]["steps"][0] } | null {
	const guide = (state.guides as Guide[] | undefined)?.find((g) => g.id === guideId);
	if (!guide) return null;
	for (const sec of guide.sections) {
		for (const st of sec.steps) {
			if (st.id === stepId) return { guide, step: st };
		}
	}
	return null;
}

function defaultMarkerExists(markerId: number): "yes" | "no" | "unknown" {
	if (state.byId && state.byId.has(markerId)) return "yes";
	return "unknown";
}

export function setStepDone(
	guideId: string,
	stepId: string,
	done: boolean,
	opts?: {
		nowSec?: number;
		notify?: boolean;
		recordUndo?: boolean;
		markerExists?: MarkerExistsFn;
	},
): FoundChangeRecord | null {
	if (!state.profile) return null;
	const found = findGuideAndStep(guideId, stepId);
	if (!found || found.step.kind !== "task") return null;
	const { step } = found;
	const existsFn = opts?.markerExists ?? defaultMarkerExists;

	const requiredMarkerIds: number[] = [];
	for (const t of step.targets || []) {
		if (t.kind === "marker" && !t.optional) {
			const ex = existsFn(t.marker);
			if (ex !== "no" && ex !== false) {
				requiredMarkerIds.push(t.marker);
			}
		}
	}

	const at = opts?.nowSec ?? Math.floor(Date.now() / 1000);
	const prevProg = state.profile.guides?.[guideId];
	const wasSkipped = Boolean(prevProg?.skipped?.includes(stepId));

	if (requiredMarkerIds.length > 0) {
		let unskipped = false;
		if (done && wasSkipped) {
			const entry = ensureGuideProgressEntry(guideId);
			entry.skipped = (entry.skipped || []).filter((id) => id !== stepId);
			entry.updated = Date.now();
			pruneEmptyGuideEntry(guideId);
			unskipped = true;
		}
		const rec = applyFoundChange(requiredMarkerIds, done, {
			nowSec: at,
			recordUndo: opts?.recordUndo,
			...(unskipped
				? {
						revert: () => {
							const e = ensureGuideProgressEntry(guideId);
							if (!e.skipped) e.skipped = [];
							if (!e.skipped.includes(stepId)) e.skipped.push(stepId);
							e.updated = Date.now();
						},
					}
				: {}),
		});
		if (!rec) return null;
		scheduleSave();
		refreshIfDom();
		if (opts?.notify !== false) {
			notifyFoundChange(rec, () => {
				scheduleSave();
				refreshIfDom();
			});
		}
		return rec;
	}

	// Manual step (no required marker targets)
	const prevDoneAt = prevProg?.done?.[stepId];
	if ((prevDoneAt !== undefined) === done) return null;

	const entry = ensureGuideProgressEntry(guideId);
	if (done) {
		if (!entry.done) entry.done = {};
		entry.done[stepId] = at;
		if (wasSkipped && entry.skipped) {
			entry.skipped = entry.skipped.filter((id) => id !== stepId);
		}
	} else if (entry.done) {
		delete entry.done[stepId];
	}
	entry.updated = Date.now();
	pruneEmptyGuideEntry(guideId);

	const rec = pushCustomUndo({
		on: done,
		at,
		toastMessage: done ? "Marked step as done" : "Marked step as not done",
		recordUndo: opts?.recordUndo !== false,
		revert: () => {
			if (!state.profile) return;
			const e = ensureGuideProgressEntry(guideId);
			if (prevDoneAt !== undefined) {
				if (!e.done) e.done = {};
				e.done[stepId] = prevDoneAt;
			} else if (e.done) {
				delete e.done[stepId];
			}
			if (wasSkipped) {
				if (!e.skipped) e.skipped = [];
				if (!e.skipped.includes(stepId)) e.skipped.push(stepId);
			}
			e.updated = Date.now();
			pruneEmptyGuideEntry(guideId);
		},
	});

	scheduleSave();
	refreshIfDom();
	if (opts?.notify !== false) {
		notifyFoundChange(rec, () => {
			scheduleSave();
			refreshIfDom();
		});
	}
	return rec;
}

export function setSkipped(
	guideId: string,
	stepId: string,
	skipped: boolean,
	opts?: { notify?: boolean; recordUndo?: boolean; nowSec?: number },
): FoundChangeRecord | null {
	if (!state.profile) return null;
	const found = findGuideAndStep(guideId, stepId);
	if (!found) return null;

	const prevProg = state.profile.guides?.[guideId];
	const wasSkipped = Boolean(prevProg?.skipped?.includes(stepId));
	if (wasSkipped === skipped) return null;

	const entry = ensureGuideProgressEntry(guideId);
	if (skipped) {
		if (!entry.skipped) entry.skipped = [];
		if (!entry.skipped.includes(stepId)) entry.skipped.push(stepId);
	} else if (entry.skipped) {
		entry.skipped = entry.skipped.filter((id) => id !== stepId);
	}
	entry.updated = Date.now();
	pruneEmptyGuideEntry(guideId);

	const rec = pushCustomUndo({
		on: skipped,
		at: opts?.nowSec ?? Math.floor(Date.now() / 1000),
		toastMessage: skipped ? "Step skipped" : "Step unskipped",
		recordUndo: opts?.recordUndo !== false,
		revert: () => {
			if (!state.profile) return;
			const e = ensureGuideProgressEntry(guideId);
			if (wasSkipped) {
				if (!e.skipped) e.skipped = [];
				if (!e.skipped.includes(stepId)) e.skipped.push(stepId);
			} else if (e.skipped) {
				e.skipped = e.skipped.filter((id) => id !== stepId);
			}
			e.updated = Date.now();
			pruneEmptyGuideEntry(guideId);
		},
	});

	scheduleSave();
	refreshIfDom();
	if (opts?.notify !== false) {
		notifyFoundChange(rec, () => {
			scheduleSave();
			refreshIfDom();
		});
	}
	return rec;
}

// Cursor moves are not undoable (section 6.3).
export function setCursor(guideId: string, stepId: string | null): void {
	if (!state.profile) return;
	const found = (state.guides as Guide[] | undefined)?.find((g) => g.id === guideId);
	if (!found) return;
	const entry = ensureGuideProgressEntry(guideId);
	if (stepId) {
		entry.cursor = stepId;
	} else {
		delete entry.cursor;
	}
	entry.updated = Date.now();
	pruneEmptyGuideEntry(guideId);
	scheduleSave();
}

// Variant changes are view-like and not undoable (section 6.3).
export function setVariant(guideId: string, variantId: string, optionId: string): void {
	if (!state.profile) return;
	const guide = (state.guides as Guide[] | undefined)?.find((g) => g.id === guideId);
	const variant = guide?.variants?.find((v) => v.id === variantId);
	if (!variant || !variant.options.some((o) => o.id === optionId)) return;
	const entry = ensureGuideProgressEntry(guideId);
	if (!entry.variants) entry.variants = {};
	entry.variants[variantId] = optionId;
	entry.updated = Date.now();
	pruneEmptyGuideEntry(guideId);
	scheduleSave();
}

/* ---------- Single-Guide Serialization, Export & Import ---------- */

export function serializeGuide(guide: Guide): string {
	const { key: _key, ...rest } = guide as Guide & { key?: string };
	const { guide: cleaned } = cleanGuide(rest);
	return JSON.stringify(cleaned ?? rest, null, "\t");
}

export function downloadGuideJson(guide: Guide): void {
	const json = serializeGuide(guide);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
	a.download = `${guide.game}-guide-${guide.id}.json`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function askSanitizedImportDialog(guide: Guide, issues: GuideIssue[]): Promise<boolean> {
	return new Promise((resolve) => {
		const dlg = $<HTMLDialogElement>("#dlg");
		const form = $<HTMLFormElement>("#dlg-form");
		if (!dlg || !form) return resolve(true);
		const itemsHtml = issues
			.slice(0, 30)
			.map((iss) => `<li><code>${esc(iss.path || "root")}</code>: ${esc(iss.message)}</li>`)
			.join("");
		const more = issues.length > 30 ? `<li>…and ${issues.length - 30} more issue(s)</li>` : "";
		form.innerHTML =
			`<h2>Guide had validation issues</h2>` +
			`<p>"${esc(guide.title)}" had ${issues.length} issue(s) that were automatically sanitized:</p>` +
			`<ul class="guide-issues" style="max-height:200px;overflow:auto;margin:8px 0;padding-left:20px;font-size:0.9em">${itemsHtml}${more}</ul>` +
			`<div class="dlg-actions"><button type="button" data-cancel>Cancel</button>` +
			`<button class="primary">Import sanitized guide</button></div>`;
		const finish = (ok: boolean) => {
			if (dlg.open) dlg.close();
			resolve(ok);
		};
		form.onsubmit = (e) => {
			e.preventDefault();
			finish(true);
		};
		form.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => finish(false);
		dlg.oncancel = () => resolve(false);
		dlg.showModal();
	});
}

function showInvalidGuideDialog(issues: GuideIssue[]): Promise<void> {
	return new Promise((resolve) => {
		const dlg = $<HTMLDialogElement>("#dlg");
		const form = $<HTMLFormElement>("#dlg-form");
		if (!dlg || !form) {
			toast("Guide could not be imported: " + (issues[0]?.message || "invalid format"), 5000);
			return resolve();
		}
		const itemsHtml = issues
			.slice(0, 20)
			.map((iss) => `<li><code>${esc(iss.path || "root")}</code>: ${esc(iss.message)}</li>`)
			.join("");
		form.innerHTML =
			`<h2>Cannot import guide</h2>` +
			`<p>The file could not be validated as a Guide:</p>` +
			`<ul class="guide-issues" style="max-height:200px;overflow:auto;margin:8px 0;padding-left:20px;font-size:0.9em">${itemsHtml}</ul>` +
			`<div class="dlg-actions"><button class="primary">OK</button></div>`;
		const finish = () => {
			if (dlg.open) dlg.close();
			resolve();
		};
		form.onsubmit = (e) => {
			e.preventDefault();
			finish();
		};
		dlg.oncancel = () => resolve();
		dlg.showModal();
	});
}

export async function importGuideText(
	jsonText: string,
	opts?: {
		gameId?: string;
		resolveIssues?: (issues: GuideIssue[], guide: Guide) => Promise<boolean>;
		resolveConflict?: (conflicts: { key: string; label: string }[]) => Promise<Map<string, string> | null>;
	},
): Promise<{ status: "imported" | "cancelled" | "invalid"; guide?: Guide; issues: GuideIssue[] }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		const issues = [{ path: "", message: "File is not valid JSON." }];
		if (!opts?.resolveIssues && typeof document !== "undefined" && $("#dlg")) {
			await showInvalidGuideDialog(issues);
		}
		return { status: "invalid", issues };
	}

	const { guide: sanitized, issues } = cleanGuide(parsed);
	if (!sanitized) {
		if (!opts?.resolveIssues && typeof document !== "undefined" && $("#dlg")) {
			await showInvalidGuideDialog(issues);
		}
		return { status: "invalid", issues };
	}

	const targetGame = opts?.gameId ?? state.entry?.id;
	if (targetGame && sanitized.game !== targetGame) {
		const gameIssues = [
			...issues,
			{ path: "game", message: `This guide is for "${sanitized.game}", not "${targetGame}".` },
		];
		if (!opts?.resolveIssues && typeof document !== "undefined" && $("#dlg")) {
			await showInvalidGuideDialog(gameIssues);
		}
		return { status: "invalid", issues: gameIssues };
	}

	if (issues.length > 0) {
		const confirmFn = opts?.resolveIssues ?? ((iss, g) => askSanitizedImportDialog(g, iss));
		const proceed = await confirmFn(issues, sanitized);
		if (!proceed) return { status: "cancelled", issues };
	}

	if (!Array.isArray(state.guides)) state.guides = [];
	const existing = (state.guides as Guide[]).find((g) => g.id === sanitized.id || g.title === sanitized.title);
	const finalGuide = structuredClone(sanitized);

	if (existing) {
		const conflictFn = opts?.resolveConflict ?? chooseConflicts;
		const decisions = await conflictFn([{ key: `g:${sanitized.id}`, label: `Guide "${sanitized.title}"` }]);
		if (!decisions) return { status: "cancelled", issues };
		const choice = decisions.get(`g:${sanitized.id}`);
		if (choice === "overwrite") {
			const matching = (state.guides as Guide[]).filter(
				(g) => g.id === sanitized.id || g.title === sanitized.title,
			);
			for (const old of matching) {
				await dbDelete("guides", guideStoreKey(old.game, old.id));
				if (old.id !== finalGuide.id) {
					syncNote([guideSyncKey(old.game, old.id)]);
				}
			}
			state.guides = (state.guides as Guide[]).filter((g) => !matching.includes(g));
		} else {
			// Keep both ("rename")
			const takenTitles = new Set<string>((state.guides as Guide[]).map((g) => g.title));
			const usedIds = new Set<string>((state.guides as Guide[]).map((g) => g.id));
			let newId = makeGuideId();
			while (usedIds.has(newId)) newId = makeGuideId();
			finalGuide.id = newId;
			finalGuide.title = uniqueName(finalGuide.title, takenTitles).slice(0, MAX_GUIDE_TITLE);
		}
	}

	state.guides.push(finalGuide);
	state.guides.sort((a: Guide, b: Guide) => a.created - b.created || a.id.localeCompare(b.id));
	await saveGuideNow(finalGuide.id);
	return { status: "imported", guide: finalGuide, issues };
}

export async function importGuideFile(file: File): Promise<void> {
	try {
		const text = await file.text();
		const res = await importGuideText(text);
		if (res.status === "imported" && res.guide) {
			refreshAll();
			toast(`Imported guide "${res.guide.title}".`);
		}
	} catch (e: any) {
		toast("Guide import failed: " + (e?.message || "unknown error"), 5000);
	}
}

export async function exportGuideAction(guideId?: string): Promise<void> {
	await flushGuideSaves();
	const guides: Guide[] = state.guides || [];
	if (!guides.length) {
		toast("No guides to export for this game.");
		return;
	}
	if (guideId) {
		const found = guides.find((g) => g.id === guideId);
		if (found) downloadGuideJson(found);
		return;
	}
	if (guides.length === 1) {
		downloadGuideJson(guides[0]!);
		return;
	}
	openManageGuidesDialog();
}

export function openManageGuidesDialog(): void {
	const dlg = $<HTMLDialogElement>("#dlg");
	const form = $<HTMLFormElement>("#dlg-form");
	if (!dlg || !form) return;

	const render = () => {
		const guides: Guide[] = state.guides || [];
		const rows = guides.length
			? guides
					.map((g) => {
						const stepCount = g.sections.reduce((acc, s) => acc + s.steps.length, 0);
						return (
							`<div class="manage-guide-row" data-gid="${esc(g.id)}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)">` +
							`<div style="min-width:0;flex:1">` +
							`<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.title)}</div>` +
							`<div style="font-size:0.82em;opacity:0.7">${g.sections.length} section(s) · ${stepCount} step(s)</div>` +
							`</div>` +
							`<div style="display:flex;gap:6px;flex-shrink:0">` +
							`<button type="button" class="chip" data-gact="export" data-gid="${esc(g.id)}">Export</button>` +
							`<button type="button" class="chip" data-gact="rename" data-gid="${esc(g.id)}">Rename</button>` +
							`<button type="button" class="chip danger" data-gact="delete" data-gid="${esc(g.id)}">Delete</button>` +
							`</div>` +
							`</div>`
						);
					})
					.join("")
			: `<p style="opacity:0.75">No guides in this game yet.</p>`;

		form.innerHTML =
			`<h2>Manage guides</h2>` +
			`<div class="manage-guides-list" style="max-height:300px;overflow:auto;margin:8px 0">${rows}</div>` +
			`<div class="dlg-actions">` +
			`<button type="button" data-gact="import">Import guide</button>` +
			`<button class="primary">Done</button>` +
			`</div>`;
	};

	render();
	form.onsubmit = (e) => {
		e.preventDefault();
		if (dlg.open) dlg.close();
	};
	form.onclick = async (e) => {
		const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-gact]");
		if (!btn) return;
		const act = btn.dataset.gact;
		const gid = btn.dataset.gid;
		if (act === "import") {
			if (dlg.open) dlg.close();
			$("#import-guide-file")?.click();
			return;
		}
		if (!gid) return;
		const g = (state.guides as Guide[] | undefined)?.find((x) => x.id === gid);
		if (!g) return;
		if (act === "export") {
			downloadGuideJson(g);
		} else if (act === "rename") {
			if (dlg.open) dlg.close();
			const name = await askDialog({
				title: "Rename guide",
				value: g.title,
				okLabel: "Rename",
			});
			if (name) {
				await renameGuide(gid, name);
				refreshAll();
			}
			openManageGuidesDialog();
		} else if (act === "delete") {
			if (dlg.open) dlg.close();
			await deleteGuide(gid, { withUndoToast: true });
			refreshAll();
		}
	};
	dlg.oncancel = () => {
		if (dlg.open) dlg.close();
	};
	if (!dlg.open) dlg.showModal();
}