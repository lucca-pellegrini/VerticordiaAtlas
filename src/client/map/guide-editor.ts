// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- guide editor: lazily loaded authoring UI, edit undo/redo, step fields, reordering, and raw JSON ---------- */

import { esc } from "../../shared/escape.ts";
import { linesToSteps, parseMarkerLink, suggestRegionTitle } from "../../shared/guide-import.ts";
import {
	cleanGuide,
	duplicateStep,
	insertSection,
	insertStep,
	ITEM_ID_PATTERN,
	makeSectionId,
	makeStepId,
	MAX_AUTHOR,
	MAX_CONSEQUENCE,
	MAX_CREDITS,
	MAX_DESCRIPTION,
	MAX_GUIDE_SECTIONS,
	MAX_GUIDE_STEPS,
	MAX_GUIDE_TITLE,
	MAX_GUIDE_VARIANTS,
	MAX_LINK_LABEL,
	MAX_NOTES,
	MAX_OPTION_LABEL,
	MAX_PLACE,
	MAX_REWARD,
	MAX_SECTION_AFTER,
	MAX_SECTION_GATE,
	MAX_SECTION_LEVEL,
	MAX_SECTION_TITLE,
	MAX_STEP_LINKS,
	MAX_STEP_TARGETS,
	MAX_STEP_TITLE,
	MAX_TARGET_LABEL,
	MAX_THREAD,
	MAX_URL_LENGTH,
	MAX_VARIANT_LABEL,
	MAX_VARIANT_OPTIONS,
	mergeSteps,
	moveSection,
	moveStep,
	removeSection,
	removeStep,
	splitStep,
	STEP_KINDS,
	updateSection,
	updateStep,
	VARIANT_ID_PATTERN,
} from "../../shared/guide.ts";
import type { Guide, GuideStep, GuideTarget, GuideVariant, StepKind } from "../../shared/types.ts";
import type { CtxMenuItem } from "./detail.ts";

export type EditorSaveStatus = "saved" | "saving" | "unsaved" | "error";

export interface GuideEditorHost {
	state: Record<string, any>;
	mapData: (info: any, keep?: boolean) => Promise<any>;
	createGuide: (input: Partial<Guide> & { title: string; game?: string }) => Promise<Guide>;
	updateGuide: (
		id: string,
		nextOrUpdater: Guide | ((prev: Guide) => Guide),
		opts?: { immediate?: boolean; nowMs?: number },
	) => Promise<Guide | null>;
	saveGuideNow: (id: string) => Promise<void>;
	flushGuideSaves: () => Promise<void>;
	isGuideSavePending: (id?: string) => boolean;
	deleteGuide: (id: string, opts?: { withUndoToast?: boolean }) => Promise<Guide | null>;
	downloadGuideJson: (guide: Guide) => void;
	openGuideById: (guideId: string, opts?: { scrollToCursor?: boolean; selectCursorStep?: boolean }) => Promise<void>;
	closeGuidePanelIfOpen: () => boolean;
	closeDetail: () => void;
	hideDetail: () => void;
	openCtx: (x: number, y: number, opts: { title?: string; items: CtxMenuItem[] }) => void;
	closeCtx: () => void;
	switchMap: (slug: string, opts?: { remember?: boolean }) => Promise<void>;
	refreshAll: (opts?: { immediate?: boolean }) => void;
	refreshMap: () => void;
	saveSessionSoon: () => void;
	renderMd: (md?: string | null) => string;
	ensureMarked: () => Promise<void>;
	detailsReady: () => boolean;
	ensureDetails: () => Promise<void>;
	iconHtml: (name?: string | null, color?: string | null) => string;
	svgIcon: (name: string) => string;
	syncSideClose: () => void;
	syncRegionBanners: () => void;
	closeRowMenu: () => void;
	toast: (msg: string, ms?: number, action?: { label: string; onClick: () => void }) => void;
	askDialog: (opts: any) => Promise<any>;
	perf: <T>(name: string, fn: () => T) => T;
	hasPendingRemoteConflict: (id: string) => boolean;
}

/* ---------- Pure Helper Functions (exported for unit tests) ---------- */

// Converts a user marker into a self-contained point snapshot target; never keeps its local negative id.
export function userMarkerToPointTarget(
	marker: { title?: string; lat: number; lng: number; map?: string },
	fallbackMapSlug = "default",
): GuideTarget {
	const map = (marker.map || fallbackMapSlug || "default").trim();
	const point = {
		lat: marker.lat,
		lng: marker.lng,
		map,
	};
	const label = String(marker.title || "Waypoint")
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, MAX_TARGET_LABEL);
	return {
		kind: "point",
		point,
		...(label ? { label } : {}),
	};
}

export function officialMarkerToTarget(
	loc: { id: number; title?: string; lat?: number; lng?: number; cat?: number; map?: string },
	catTitle?: string,
	mapSlug?: string,
): GuideTarget {
	const resolvedMap = String(loc.map || mapSlug || "").slice(0, 80);
	const resolvedTitle = String(loc.title || `Marker #${loc.id}`).slice(0, MAX_TARGET_LABEL);
	const snapshot =
		typeof loc.lat === "number" && typeof loc.lng === "number" && resolvedMap
			? {
					title: resolvedTitle,
					...(catTitle ? { cat: String(catTitle).slice(0, 80) } : {}),
					lat: loc.lat,
					lng: loc.lng,
					map: resolvedMap,
				}
			: undefined;
	return {
		kind: "marker",
		marker: loc.id,
		...(snapshot ? { snapshot } : {}),
	};
}

export function computeMoveStepIndex(
	fromSecId: string,
	fromIdx: number,
	destSecId: string,
	targetIdx: number,
	placeAfter: boolean,
): number {
	if (fromSecId !== destSecId) {
		return placeAfter ? targetIdx + 1 : targetIdx;
	}
	if (placeAfter) {
		return targetIdx < fromIdx ? targetIdx + 1 : targetIdx;
	}
	return targetIdx > fromIdx ? targetIdx - 1 : targetIdx;
}

export function addTargetToStepTargets(step: GuideStep, target: GuideTarget): GuideStep {
	const existing = [...(step.targets || [])];
	if (existing.length >= MAX_STEP_TARGETS) return structuredClone(step);
	if (target.kind === "marker" && target.marker !== undefined) {
		if (existing.some((t) => t.kind === "marker" && t.marker === target.marker)) {
			return structuredClone(step);
		}
	}
	existing.push(structuredClone(target));
	return { ...structuredClone(step), targets: existing };
}

export interface EditorHistorySnapshot {
	guide: Guide;
	selectedStepId: string | null;
}

export class GuideEditHistory {
	private undoStack: EditorHistorySnapshot[] = [];
	private redoStack: EditorHistorySnapshot[] = [];
	private lastCoalesceKey: string | null = null;
	private lastCoalesceAt = 0;
	readonly maxEntries: number;

	constructor(maxEntries = 80) {
		this.maxEntries = maxEntries;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
		this.lastCoalesceKey = null;
		this.lastCoalesceAt = 0;
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	record(before: EditorHistorySnapshot, coalesceKey?: string, nowMs = Date.now()): void {
		const isCoalesced =
			Boolean(coalesceKey) &&
			this.lastCoalesceKey === coalesceKey &&
			nowMs - this.lastCoalesceAt < 1200 &&
			this.undoStack.length > 0;

		this.redoStack = [];
		if (isCoalesced) {
			this.lastCoalesceAt = nowMs;
			return;
		}
		this.undoStack.push({
			guide: structuredClone(before.guide),
			selectedStepId: before.selectedStepId,
		});
		if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
		this.lastCoalesceKey = coalesceKey ?? null;
		this.lastCoalesceAt = nowMs;
	}

	undo(current: EditorHistorySnapshot): EditorHistorySnapshot | null {
		const prev = this.undoStack.pop();
		if (!prev) return null;
		this.lastCoalesceKey = null;
		this.redoStack.push({
			guide: structuredClone(current.guide),
			selectedStepId: current.selectedStepId,
		});
		if (this.redoStack.length > this.maxEntries) this.redoStack.shift();
		return prev;
	}

	redo(current: EditorHistorySnapshot): EditorHistorySnapshot | null {
		const next = this.redoStack.pop();
		if (!next) return null;
		this.lastCoalesceKey = null;
		this.undoStack.push({
			guide: structuredClone(current.guide),
			selectedStepId: current.selectedStepId,
		});
		if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
		return next;
	}
}

/* ---------- Module State ---------- */

let host: GuideEditorHost | null = null;
let initialized = false;
let mode: "closed" | "new" | "edit" = "closed";
let editingGuideId: string | null = null;
let selectedStepId: string | null = null;
let notesPreview = false;
let saveStatus: EditorSaveStatus = "saved";
let remoteConflictNotice = false;
let addStepsActive = false;

const collapsedSections = new Set<string>();
const dirtyGuideIds = new Set<string>();
const history = new GuideEditHistory(80);
const crossMapLookup = new Map<
	number,
	{ id: number; title: string; lat: number; lng: number; map: string; cat?: number }
>();
let crossMapIndexBuiltForGame: string | null = null;
let crossMapIndexPromise: Promise<void> | null = null;

export function initGuideEditor(h: GuideEditorHost): void {
	host = h;
	if (!initialized && typeof document !== "undefined") {
		initialized = true;
		wireEditorGlobalShortcuts();
	}
}

export function isOpen(): boolean {
	return mode !== "closed";
}

export function getEditingGuideId(): string | null {
	return mode === "edit" ? editingGuideId : null;
}

export function hasUnsavedChanges(id: string): boolean {
	return dirtyGuideIds.has(id);
}

export function markGuideSaved(id: string, _savedGuide?: Guide): void {
	dirtyGuideIds.delete(id);
	if (editingGuideId === id) {
		remoteConflictNotice = false;
		saveStatus = "saved";
		updateSaveBadge();
	}
}

export function onSaveStatusChange(id: string, status: EditorSaveStatus): void {
	if (status === "saved") dirtyGuideIds.delete(id);
	else if (status === "saving" || status === "unsaved") dirtyGuideIds.add(id);
	if (editingGuideId === id) {
		saveStatus = status;
		updateSaveBadge();
	}
}

export function onRemoteConflictNotice(id: string): void {
	if (editingGuideId === id) {
		remoteConflictNotice = true;
		renderEditorNotice();
		updateSaveBadge();
	}
}

export function onRemoteReload(id: string, nextGuide: Guide | null): void {
	if (editingGuideId !== id || mode !== "edit") return;
	if (!nextGuide) {
		host?.toast("This guide was removed on another device.");
		closeGuideEditor({ switchToFollow: false });
		return;
	}
	dirtyGuideIds.delete(id);
	remoteConflictNotice = false;
	saveStatus = "saved";
	if (selectedStepId && !findStepInGuide(nextGuide, selectedStepId)) {
		selectedStepId = firstStepId(nextGuide);
	}
	renderEditor();
	if (selectedStepId && document.body.classList.contains("detail-open")) {
		renderStepEditor();
	}
}

export function isAddStepsActive(): boolean {
	return mode === "edit" && addStepsActive;
}

export function setAddStepsActive(on: boolean): void {
	if (mode !== "edit" && on) return;
	addStepsActive = on;
	if (typeof document !== "undefined") {
		document.body.classList.toggle("guide-add-steps", addStepsActive);
		const btn = document.querySelector<HTMLButtonElement>("[data-ge-act='toggle-add-steps']");
		if (btn) btn.setAttribute("aria-pressed", String(addStepsActive));
		renderAddStepsBanner();
		if (addStepsActive && window.innerWidth <= 760) {
			document.body.classList.remove("side-open");
		} else if (!addStepsActive && mode === "edit" && window.innerWidth <= 760) {
			document.body.classList.add("side-open");
		}
	}
}

/* ---------- Cross-map marker resolution (cached per game) ---------- */

async function ensureCrossMapMarkers(): Promise<void> {
	if (!host) return;
	const gameId = host.state.entry?.id || "";
	if (crossMapIndexBuiltForGame === gameId && crossMapLookup.size > 0) return;
	if (crossMapIndexPromise) return crossMapIndexPromise;
	crossMapIndexPromise = (async () => {
		const maps: any[] = host?.state.meta?.maps || [];
		const currentSlug = host?.state.mapInfo?.slug;
		const ingest = (locs: any[], slug: string) => {
			for (const l of locs) {
				if (!l || typeof l.id !== "number" || l.user) continue;
				crossMapLookup.set(l.id, {
					id: l.id,
					title: String(l.title || ""),
					lat: l.lat,
					lng: l.lng,
					map: slug,
					cat: l.cat,
				});
			}
		};
		if (currentSlug && Array.isArray(host?.state.locs)) ingest(host.state.locs, currentSlug);
		for (const m of maps) {
			if (!m?.slug || m.slug === currentSlug) continue;
			try {
				const d = await host!.mapData(m, false);
				if (Array.isArray(d?.locations)) ingest(d.locations, m.slug);
			} catch {}
		}
		crossMapIndexBuiltForGame = gameId;
	})().finally(() => {
		crossMapIndexPromise = null;
	});
	return crossMapIndexPromise;
}

function lookupAnyMarker(
	id: number,
): { id: number; title: string; lat: number; lng: number; map: string; cat?: number } | null {
	const local = host?.state.byId?.get(id);
	if (local) {
		return {
			id: local.id,
			title: local.title || `Marker #${id}`,
			lat: local.lat,
			lng: local.lng,
			map: local.map || host?.state.mapInfo?.slug || "",
			cat: local.cat,
		};
	}
	return crossMapLookup.get(id) ?? null;
}

/* ---------- Helpers ---------- */

function currentGuide(): Guide | null {
	if (!host || !editingGuideId) return null;
	return ((host.state.guides || []) as Guide[]).find((g) => g.id === editingGuideId) ?? null;
}

function findStepInGuide(guide: Guide, stepId: string): { secIdx: number; stepIdx: number; step: GuideStep } | null {
	for (let sIdx = 0; sIdx < guide.sections.length; sIdx++) {
		const sec = guide.sections[sIdx]!;
		const stIdx = sec.steps.findIndex((st) => st.id === stepId);
		if (stIdx >= 0) return { secIdx: sIdx, stepIdx: stIdx, step: sec.steps[stIdx]! };
	}
	return null;
}

function firstStepId(guide: Guide): string | null {
	for (const sec of guide.sections) {
		if (sec.steps.length > 0) return sec.steps[0]!.id;
	}
	return null;
}

function flatStepOrder(guide: Guide): { secId: string; stepId: string }[] {
	const out: { secId: string; stepId: string }[] = [];
	for (const sec of guide.sections) {
		for (const st of sec.steps) out.push({ secId: sec.id, stepId: st.id });
	}
	return out;
}

function currentSectionIdForInsert(guide: Guide): string {
	if (selectedStepId) {
		const found = findStepInGuide(guide, selectedStepId);
		if (found) return guide.sections[found.secIdx]!.id;
	}
	return guide.sections[guide.sections.length - 1]!.id;
}

function nextInsertionIndexInSection(guide: Guide, secId: string): number | undefined {
	if (selectedStepId) {
		const found = findStepInGuide(guide, selectedStepId);
		if (found && guide.sections[found.secIdx]!.id === secId) {
			return found.stepIdx + 1;
		}
	}
	return undefined;
}

/* ---------- Edit Mutation Engine ---------- */

async function applyEdit(
	mutator: (prev: Guide) => Guide,
	opts?: {
		selectStepId?: string | null;
		coalesceKey?: string;
		immediate?: boolean;
		openStepCard?: boolean;
		reRenderOutline?: boolean;
		reRenderStepEditor?: boolean;
	},
): Promise<Guide | null> {
	if (!host || !editingGuideId) return null;
	const prev = currentGuide();
	if (!prev) return null;

	const prevStep = selectedStepId;
	const candidate = mutator(structuredClone(prev));
	const { guide: nextCleaned } = cleanGuide({
		...candidate,
		id: prev.id,
		game: prev.game,
		updated: Date.now(),
	});
	if (!nextCleaned) return null;

	history.record({ guide: prev, selectedStepId: prevStep }, opts?.coalesceKey);
	dirtyGuideIds.add(prev.id);
	saveStatus = opts?.immediate ? "saving" : host.hasPendingRemoteConflict(prev.id) ? "unsaved" : "saving";

	if (opts?.selectStepId !== undefined) {
		selectedStepId = opts.selectStepId;
	} else if (selectedStepId && !findStepInGuide(nextCleaned, selectedStepId)) {
		selectedStepId = firstStepId(nextCleaned);
	}

	const saved = await host.updateGuide(prev.id, nextCleaned, { immediate: opts?.immediate });
	if (!saved) return null;

	if (opts?.reRenderOutline !== false) renderEditor();
	else updateUndoRedoAndSaveButtons();

	const shouldRenderStep =
		opts?.openStepCard || (opts?.reRenderStepEditor !== false && selectedStepId && isStepEditorShowing());
	if (shouldRenderStep) {
		if (selectedStepId) renderStepEditor();
		else clearStepEditorIfShowing();
	}
	if (host.state.guide) host.state.guide.activeId = saved.id;
	host.refreshMap();
	return saved;
}

export async function undoGuideEdit(): Promise<boolean> {
	if (!host || !editingGuideId) return false;
	const cur = currentGuide();
	if (!cur) return false;
	const prev = history.undo({ guide: cur, selectedStepId });
	if (!prev) return false;
	dirtyGuideIds.add(cur.id);
	selectedStepId = prev.selectedStepId;
	await host.updateGuide(cur.id, prev.guide);
	renderEditor();
	if (isStepEditorShowing() || selectedStepId) {
		if (selectedStepId) renderStepEditor();
		else clearStepEditorIfShowing();
	}
	host.refreshMap();
	return true;
}

export async function redoGuideEdit(): Promise<boolean> {
	if (!host || !editingGuideId) return false;
	const cur = currentGuide();
	if (!cur) return false;
	const next = history.redo({ guide: cur, selectedStepId });
	if (!next) return false;
	dirtyGuideIds.add(cur.id);
	selectedStepId = next.selectedStepId;
	await host.updateGuide(cur.id, next.guide);
	renderEditor();
	if (isStepEditorShowing() || selectedStepId) {
		if (selectedStepId) renderStepEditor();
		else clearStepEditorIfShowing();
	}
	host.refreshMap();
	return true;
}

/* ---------- Open & Close Editor Lifecycle ---------- */

function ensureEditorContainer(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	let el = document.getElementById("guide-editor");
	if (!el) {
		const scroll = document.querySelector("#side .side-scroll");
		const panel = document.getElementById("guide-panel");
		el = document.createElement("div");
		el.id = "guide-editor";
		el.className = "guide-editor";
		el.hidden = true;
		if (panel?.parentNode) panel.after(el);
		else scroll?.appendChild(el);
	}
	return el;
}

export function openNewGuideEditor(): void {
	if (!host || typeof document === "undefined") return;
	host.closeDetail();
	host.closeGuidePanelIfOpen();
	mode = "new";
	editingGuideId = null;
	selectedStepId = null;
	notesPreview = false;
	remoteConflictNotice = false;
	setAddStepsActive(false);
	history.clear();

	document.body.classList.add("guide-editing", "side-open");
	document.body.classList.remove("side-collapsed");
	const el = ensureEditorContainer();
	if (el) {
		el.hidden = false;
		renderNewGuideForm(el);
	}
	host.syncSideClose();
	host.syncRegionBanners();
}

export function openGuideEditor(guideId: string): void {
	if (!host || typeof document === "undefined") return;
	const g = ((host.state.guides || []) as Guide[]).find((x) => x.id === guideId);
	if (!g) {
		host.toast("Guide not found.");
		return;
	}
	host.closeDetail();
	host.closeGuidePanelIfOpen();

	mode = "edit";
	editingGuideId = g.id;
	selectedStepId = firstStepId(g);
	notesPreview = false;
	remoteConflictNotice = host.hasPendingRemoteConflict(g.id);
	saveStatus = host.isGuideSavePending(g.id) || dirtyGuideIds.has(g.id) ? "unsaved" : "saved";
	setAddStepsActive(false);
	history.clear();

	document.body.classList.add("guide-editing", "side-open");
	document.body.classList.remove("side-collapsed");
	if (host.state.guide) host.state.guide.activeId = g.id;

	const el = ensureEditorContainer();
	if (el) el.hidden = false;
	renderEditor();
	if (selectedStepId && window.innerWidth > 760) {
		renderStepEditor();
	}
	void ensureCrossMapMarkers();
	host.syncSideClose();
	host.syncRegionBanners();
	host.refreshMap();
}

export function closeGuideEditor(opts?: { switchToFollow?: boolean }): void {
	if (!host || typeof document === "undefined" || mode === "closed") return;
	finishDrag(false);
	const prevGuideId = editingGuideId;
	setAddStepsActive(false);
	mode = "closed";
	editingGuideId = null;
	selectedStepId = null;
	notesPreview = false;
	remoteConflictNotice = false;
	history.clear();

	document.body.classList.remove("guide-editing", "ge-step-open");
	const el = document.getElementById("guide-editor");
	if (el) {
		el.hidden = true;
		el.innerHTML = "";
	}
	clearStepEditorIfShowing();
	host.syncSideClose();
	host.syncRegionBanners();

	if (opts?.switchToFollow && prevGuideId) {
		void host.flushGuideSaves().then(() => {
			void host?.openGuideById(prevGuideId, { scrollToCursor: true });
		});
	} else {
		host.refreshAll();
	}
}

/* ---------- New Guide Creation Form ---------- */

function renderNewGuideForm(root: HTMLElement): void {
	if (!host) return;
	root.innerHTML =
		`<div class="ge-header">` +
		`<div class="ge-top-bar">` +
		`<button type="button" class="gp-back-btn" data-ge-new="cancel">${host.svgIcon("arrowLeft")}<span>Cancel</span></button>` +
		`<span class="gp-badge">New guide</span>` +
		`</div>` +
		`<h2 class="gp-title">Create a guide</h2>` +
		`</div>` +
		`<form id="ge-new-form" class="ge-new-form">` +
		`<label class="field"><span>Title</span><input type="text" name="title" maxlength="${MAX_GUIDE_TITLE}" required placeholder="e.g. All Collectibles Route" autocomplete="off"></label>` +
		`<label class="field"><span>Author (optional)</span><input type="text" name="author" maxlength="${MAX_AUTHOR}" placeholder="Your name or handle" autocomplete="off"></label>` +
		`<label class="field"><span>Description (optional)</span><textarea name="description" rows="3" maxlength="${MAX_DESCRIPTION}" placeholder="Short overview for players"></textarea></label>` +
		`<label class="field"><span>First section title</span><input type="text" name="sec" maxlength="${MAX_SECTION_TITLE}" value="Section 1" autocomplete="off"></label>` +
		`<div class="dlg-actions">` +
		`<button type="button" data-ge-new="cancel">Cancel</button>` +
		`<button type="submit" class="primary">Create guide</button>` +
		`</div>` +
		`</form>`;

	root.querySelectorAll<HTMLElement>('[data-ge-new="cancel"]').forEach((btn) => {
		btn.onclick = () => closeGuideEditor({ switchToFollow: false });
	});

	const form = root.querySelector<HTMLFormElement>("#ge-new-form")!;
	const titleInp = form.elements.namedItem("title") as HTMLInputElement;
	setTimeout(() => titleInp?.focus(), 0);

	form.onsubmit = async (e) => {
		e.preventDefault();
		if (!host) return;
		const title = titleInp.value.trim();
		if (!title) {
			titleInp.focus();
			return;
		}
		const author = (form.elements.namedItem("author") as HTMLInputElement).value.trim() || undefined;
		const description = (form.elements.namedItem("description") as HTMLTextAreaElement).value.trim() || undefined;
		const secTitle = (form.elements.namedItem("sec") as HTMLInputElement).value.trim() || "Section 1";
		try {
			const created = await host.createGuide({
				title,
				...(author ? { author } : {}),
				...(description ? { description } : {}),
				sections: [{ id: makeSectionId(), title: secTitle, steps: [] }],
			});
			openGuideEditor(created.id);
			host.refreshAll();
		} catch (err: any) {
			host.toast("Could not create guide: " + (err?.message || "unknown error"));
		}
	};
}

/* ---------- Outline & Main Editor Render ---------- */

function saveStatusLabel(): string {
	if (remoteConflictNotice) return "Remote update · Save";
	if (saveStatus === "saving") return "Saving…";
	if (saveStatus === "unsaved") return "Save changes";
	if (saveStatus === "error") return "Save error · Retry";
	return "Saved";
}

function updateSaveBadge(): void {
	const btn = document.querySelector<HTMLButtonElement>("[data-ge-act='save']");
	if (!btn) return;
	btn.textContent = saveStatusLabel();
	btn.dataset.status = remoteConflictNotice ? "conflict" : saveStatus;
}

function renderEditorNotice(): void {
	const box = document.getElementById("ge-remote-notice");
	if (!box) return;
	box.hidden = !remoteConflictNotice;
}

function updateUndoRedoAndSaveButtons(): void {
	const u = document.querySelector<HTMLButtonElement>("[data-ge-act='undo']");
	const r = document.querySelector<HTMLButtonElement>("[data-ge-act='redo']");
	if (u) u.disabled = !history.canUndo();
	if (r) r.disabled = !history.canRedo();
	updateSaveBadge();
	renderEditorNotice();
}

export function renderEditor(): void {
	if (!host || typeof document === "undefined" || mode !== "edit") return;
	const root = ensureEditorContainer();
	const guide = currentGuide();
	if (!root || !guide) return;

	host.perf("renderEditor", () => {
		const scroller = document.querySelector<HTMLElement>("#side .side-scroll");
		const prevScrollTop = scroller?.scrollTop ?? 0;

		const totalSteps = guide.sections.reduce((acc, s) => acc + s.steps.length, 0);
		let globalNum = 0;

		const sectionsHtml = guide.sections
			.map((sec, sIdx) => {
				const isCol = collapsedSections.has(sec.id);
				const stepsHtml = isCol
					? ""
					: sec.steps
							.map((st, stIdx) => {
								globalNum++;
								const isSel = selectedStepId === st.id;
								const tCount = st.targets?.length ?? 0;
								const kindShort = st.kind === "waypoint" ? "WP" : st.kind === "info" ? "Info" : "";
								return (
									`<div class="ge-step-row${isSel ? " is-selected" : ""}" data-ge-step="${esc(st.id)}" data-ge-sec-id="${esc(sec.id)}" data-ge-step-idx="${stIdx}" tabindex="0">` +
									`<button type="button" class="ge-drag" data-ge-drag="${esc(st.id)}" aria-label="Drag to reorder ${esc(st.title)}" title="Drag to reorder">${host!.svgIcon("grip")}</button>` +
									`<button type="button" class="ge-step-select" data-ge-select-step="${esc(st.id)}">` +
									`<span class="ge-step-num">${globalNum}</span>` +
									`<span class="ge-step-title">${esc(st.title)}</span>` +
									(kindShort ? `<span class="gp-badge gp-badge-kind">${kindShort}</span>` : "") +
									(st.missable ? `<span class="gp-badge gp-badge-missable">M</span>` : "") +
									(tCount > 0 ? `<span class="gp-badge">${tCount}</span>` : "") +
									`</button>` +
									`<button type="button" class="ge-icon-sm" data-ge-step-up="${esc(st.id)}" aria-label="Move step up" title="Move up (Alt+Up)">${host!.svgIcon("chevUp")}</button>` +
									`<button type="button" class="ge-icon-sm" data-ge-step-down="${esc(st.id)}" aria-label="Move step down" title="Move down (Alt+Down)">${host!.svgIcon("chevDown")}</button>` +
									`<button type="button" class="ge-icon-sm danger" data-ge-step-del="${esc(st.id)}" aria-label="Delete step" title="Delete step">${host!.svgIcon("trash")}</button>` +
									`</div>`
								);
							})
							.join("");

				return (
					`<div class="ge-sec${isCol ? " is-collapsed" : ""}" data-ge-sec="${esc(sec.id)}">` +
					`<div class="ge-sec-head" data-ge-sec-drop="${esc(sec.id)}">` +
					`<button type="button" class="ge-sec-toggle" data-ge-sec-toggle="${esc(sec.id)}" aria-expanded="${!isCol}">${esc(sec.title)} <span class="ge-sec-count">(${sec.steps.length})</span></button>` +
					`<div class="ge-sec-btns">` +
					`<button type="button" class="ge-icon-sm" data-ge-sec-up="${esc(sec.id)}" ${sIdx === 0 ? "disabled" : ""} aria-label="Move section up" title="Move section up">${host!.svgIcon("chevUp")}</button>` +
					`<button type="button" class="ge-icon-sm" data-ge-sec-down="${esc(sec.id)}" ${sIdx === guide.sections.length - 1 ? "disabled" : ""} aria-label="Move section down" title="Move section down">${host!.svgIcon("chevDown")}</button>` +
					`<button type="button" class="ge-icon-sm" data-ge-sec-edit="${esc(sec.id)}" aria-label="Edit section details" title="Edit section details">${host!.svgIcon("pencil")}</button>` +
					`<button type="button" class="ge-icon-sm" data-ge-sec-add-step="${esc(sec.id)}" aria-label="Add step to ${esc(sec.title)}" title="Add step">${host!.svgIcon("plus")}</button>` +
					(guide.sections.length > 1
						? `<button type="button" class="ge-icon-sm danger" data-ge-sec-del="${esc(sec.id)}" aria-label="Delete section" title="Delete section">${host!.svgIcon("trash")}</button>`
						: "") +
					`</div>` +
					`</div>` +
					(sec.steps.length === 0 && !isCol
						? `<div class="ge-empty-sec" data-ge-empty-sec="${esc(sec.id)}">No steps yet. Tap + or use Add steps / Paste text.</div>`
						: `<div class="ge-sec-steps">${stepsHtml}</div>`) +
					`</div>`
				);
			})
			.join("");

		const variantsHtml = (guide.variants || [])
			.map(
				(v, vi) =>
					`<div class="ge-var-card" data-ge-var="${esc(v.id)}">` +
					`<div class="ge-var-row">` +
					`<input type="text" class="ge-var-label" data-ge-var-label="${vi}" value="${esc(v.label)}" maxlength="${MAX_VARIANT_LABEL}" aria-label="Variant label">` +
					`<button type="button" class="ge-icon-sm danger" data-ge-var-del="${vi}" aria-label="Delete variant">${host!.svgIcon("trash")}</button>` +
					`</div>` +
					`<div class="ge-var-opts">${v.options
						.map(
							(o, oi) =>
								`<label class="ge-var-opt">` +
								`<input type="radio" name="ge-vdef-${vi}" data-ge-var-def="${vi}" value="${esc(o.id)}" ${v.default === o.id ? "checked" : ""} title="Default option">` +
								`<input type="text" data-ge-var-opt="${vi}:${oi}" value="${esc(o.label)}" maxlength="${MAX_OPTION_LABEL}" aria-label="Option label">` +
								(v.options.length > 2
									? `<button type="button" class="ge-icon-sm danger" data-ge-var-opt-del="${vi}:${oi}" aria-label="Remove option">&times;</button>`
									: "") +
								`</label>`,
						)
						.join("")}` +
					(v.options.length < MAX_VARIANT_OPTIONS
						? `<button type="button" class="chip" data-ge-var-add-opt="${vi}">+ Option</button>`
						: "") +
					`</div></div>`,
			)
			.join("");

		root.innerHTML =
			`<div class="ge-header">` +
			`<div class="ge-top-bar">` +
			`<button type="button" class="gp-back-btn" data-ge-act="done">${host!.svgIcon("arrowLeft")}<span>Done</span></button>` +
			`<div class="ge-top-right">` +
			`<button type="button" class="ge-icon-btn" data-ge-act="undo" ${history.canUndo() ? "" : "disabled"} title="Undo edit" aria-label="Undo edit">${host!.svgIcon("undo")}</button>` +
			`<button type="button" class="ge-icon-btn" data-ge-act="redo" ${history.canRedo() ? "" : "disabled"} title="Redo edit" aria-label="Redo edit">${host!.svgIcon("redo")}</button>` +
			`<button type="button" class="ge-save-pill" data-ge-act="save" data-status="${remoteConflictNotice ? "conflict" : saveStatus}">${esc(saveStatusLabel())}</button>` +
			`</div>` +
			`</div>` +
			`<div id="ge-remote-notice" class="ge-remote-notice" role="status"${remoteConflictNotice ? "" : " hidden"}>` +
			`<span>A remote update arrived. Your edits are kept; click <b>Save</b> to resolve.</span>` +
			`</div>` +
			`<div class="ge-title-wrap">` +
			`<input type="text" id="ge-guide-title" value="${esc(guide.title)}" maxlength="${MAX_GUIDE_TITLE}" aria-label="Guide title" placeholder="Guide title">` +
			`</div>` +
			`<div class="ge-toolbar">` +
			`<button type="button" class="ge-tool-btn" data-ge-act="toggle-add-steps" aria-pressed="${addStepsActive}">${host!.svgIcon("pin")}<span>Add steps</span></button>` +
			`<button type="button" class="ge-tool-btn" data-ge-act="add-section">${host!.svgIcon("plus")}<span>Section</span></button>` +
			`<button type="button" class="ge-tool-btn" data-ge-act="paste-text">${host!.svgIcon("list")}<span>Paste</span></button>` +
			`<button type="button" class="ge-tool-btn" data-ge-act="raw-json">${host!.svgIcon("code")}<span>JSON</span></button>` +
			`</div>` +
			`<details class="ge-meta-acc">` +
			`<summary>Guide details, variants &amp; stats (${guide.sections.length} sec · ${totalSteps} steps)</summary>` +
			`<div class="ge-meta-body">` +
			`<label class="field"><span>Author</span><input type="text" data-ge-meta="author" value="${esc(guide.author || "")}" maxlength="${MAX_AUTHOR}" placeholder="Author"></label>` +
			`<label class="field"><span>Description</span><textarea rows="2" data-ge-meta="description" maxlength="${MAX_DESCRIPTION}" placeholder="Description">${esc(guide.description || "")}</textarea></label>` +
			`<label class="field"><span>Credits</span><textarea rows="2" data-ge-meta="credits" maxlength="${MAX_CREDITS}" placeholder="Credits">${esc(guide.credits || "")}</textarea></label>` +
			`<div class="ge-variants-box"><div class="ge-sub-head"><span>Variants</span>` +
			((guide.variants?.length ?? 0) < MAX_GUIDE_VARIANTS
				? `<button type="button" class="chip" data-ge-act="add-variant">+ Variant</button>`
				: "") +
			`</div>${variantsHtml || '<p class="ge-dim">No route variants (e.g. Normal vs NG+).</p>'}</div>` +
			`</div>` +
			`</details>` +
			`</div>` +
			`<div class="ge-outline" id="ge-outline">${sectionsHtml}</div>`;

		wireEditorOutlineEvents(root, guide);
		renderAddStepsBanner();

		if (scroller) scroller.scrollTop = prevScrollTop;
	});
}

function wireEditorOutlineEvents(root: HTMLElement, guide: Guide): void {
	if (!host) return;
	const titleInp = root.querySelector<HTMLInputElement>("#ge-guide-title");
	if (titleInp) {
		titleInp.oninput = () => {
			const val = titleInp.value;
			if (!val.trim()) return;
			void applyEdit((g) => ({ ...g, title: val.slice(0, MAX_GUIDE_TITLE) }), {
				coalesceKey: "guide-title",
				reRenderOutline: false,
				reRenderStepEditor: false,
			});
		};
	}

	root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-ge-meta]").forEach((inp) => {
		inp.oninput = () => {
			const field = inp.dataset.geMeta as "author" | "description" | "credits";
			const raw = inp.value;
			void applyEdit(
				(g) => {
					const next = { ...g };
					if (raw.trim()) next[field] = raw;
					else delete next[field];
					return next;
				},
				{ coalesceKey: `meta-${field}`, reRenderOutline: false, reRenderStepEditor: false },
			);
		};
	});

	root.querySelectorAll<HTMLInputElement>("[data-ge-var-label]").forEach((inp) => {
		inp.oninput = () => {
			const vi = Number(inp.dataset.geVarLabel);
			const val = inp.value.trim();
			if (!val) return;
			void applyEdit(
				(g) => {
					const vars = structuredClone(g.variants || []);
					if (vars[vi]) vars[vi]!.label = val.slice(0, MAX_VARIANT_LABEL);
					return { ...g, variants: vars };
				},
				{ coalesceKey: `var-lbl-${vi}`, reRenderOutline: false, reRenderStepEditor: false },
			);
		};
	});

	root.querySelectorAll<HTMLInputElement>("[data-ge-var-opt]").forEach((inp) => {
		inp.oninput = () => {
			const [vi, oi] = inp.dataset.geVarOpt!.split(":").map(Number);
			const val = inp.value.trim();
			if (!val) return;
			void applyEdit(
				(g) => {
					const vars = structuredClone(g.variants || []);
					if (vars[vi]?.options[oi]) vars[vi]!.options[oi]!.label = val.slice(0, MAX_OPTION_LABEL);
					return { ...g, variants: vars };
				},
				{ coalesceKey: `var-opt-${vi}-${oi}`, reRenderOutline: false, reRenderStepEditor: false },
			);
		};
	});

	root.querySelectorAll<HTMLInputElement>("[data-ge-var-def]").forEach((inp) => {
		inp.onchange = () => {
			const vi = Number(inp.dataset.geVarDef);
			const optId = inp.value;
			void applyEdit((g) => {
				const vars = structuredClone(g.variants || []);
				if (vars[vi]) vars[vi]!.default = optId;
				return { ...g, variants: vars };
			});
		};
	});

	root.onclick = async (e) => {
		if (!host) return;
		const t = e.target as HTMLElement;

		const actBtn = t.closest<HTMLElement>("[data-ge-act]");
		if (actBtn) {
			const act = actBtn.dataset.geAct;
			if (act === "done") {
				closeGuideEditor({ switchToFollow: true });
			} else if (act === "undo") {
				await undoGuideEdit();
			} else if (act === "redo") {
				await redoGuideEdit();
			} else if (act === "save") {
				if (editingGuideId) await host.saveGuideNow(editingGuideId);
			} else if (act === "toggle-add-steps") {
				setAddStepsActive(!addStepsActive);
			} else if (act === "add-section") {
				const cur = currentGuide();
				if (!cur) return;
				const title = await host.askDialog({
					title: "New section",
					value: `Section ${cur.sections.length + 1}`,
					okLabel: "Add section",
				});
				if (title) {
					await applyEdit((g) => insertSection(g, { title: title.slice(0, MAX_SECTION_TITLE) }));
				}
			} else if (act === "add-variant") {
				await addVariantPrompt();
			} else if (act === "paste-text") {
				openPasteTextModal();
			} else if (act === "raw-json") {
				openRawJsonModal();
			}
			return;
		}

		const varDel = t.closest<HTMLElement>("[data-ge-var-del]");
		if (varDel) {
			const vi = Number(varDel.dataset.geVarDel);
			await applyEdit((g) => {
				const vars = structuredClone(g.variants || []);
				vars.splice(vi, 1);
				return { ...g, ...(vars.length ? { variants: vars } : { variants: undefined }) };
			});
			return;
		}

		const optAdd = t.closest<HTMLElement>("[data-ge-var-add-opt]");
		if (optAdd) {
			const vi = Number(optAdd.dataset.geVarAddOpt);
			await applyEdit((g) => {
				const vars = structuredClone(g.variants || []);
				const v = vars[vi];
				if (!v || v.options.length >= MAX_VARIANT_OPTIONS) return g;
				const used = new Set(v.options.map((o) => o.id));
				let n = v.options.length + 1;
				while (used.has(`opt-${n}`)) n++;
				v.options.push({ id: `opt-${n}`, label: `Option ${n}` });
				return { ...g, variants: vars };
			});
			return;
		}

		const optDel = t.closest<HTMLElement>("[data-ge-var-opt-del]");
		if (optDel) {
			const [vi, oi] = optDel.dataset.geVarOptDel!.split(":").map(Number);
			await applyEdit((g) => {
				const vars = structuredClone(g.variants || []);
				const v = vars[vi];
				if (!v || v.options.length <= 2) return g;
				const [removed] = v.options.splice(oi, 1);
				if (removed && v.default === removed.id) v.default = v.options[0]!.id;
				return { ...g, variants: vars };
			});
			return;
		}

		const secToggle = t.closest<HTMLElement>("[data-ge-sec-toggle]");
		if (secToggle) {
			const secId = secToggle.dataset.geSecToggle!;
			if (collapsedSections.has(secId)) collapsedSections.delete(secId);
			else collapsedSections.add(secId);
			renderEditor();
			return;
		}

		const secUp = t.closest<HTMLElement>("[data-ge-sec-up]");
		if (secUp) {
			const secId = secUp.dataset.geSecUp!;
			const cur = currentGuide();
			const idx = cur?.sections.findIndex((s) => s.id === secId) ?? -1;
			if (idx > 0) await applyEdit((g) => moveSection(g, secId, idx - 1));
			return;
		}

		const secDown = t.closest<HTMLElement>("[data-ge-sec-down]");
		if (secDown) {
			const secId = secDown.dataset.geSecDown!;
			const cur = currentGuide();
			const idx = cur?.sections.findIndex((s) => s.id === secId) ?? -1;
			if (cur && idx >= 0 && idx < cur.sections.length - 1)
				await applyEdit((g) => moveSection(g, secId, idx + 1));
			return;
		}

		const secEdit = t.closest<HTMLElement>("[data-ge-sec-edit]");
		if (secEdit) {
			await openEditSectionModal(secEdit.dataset.geSecEdit!);
			return;
		}

		const secAddStep = t.closest<HTMLElement>("[data-ge-sec-add-step]");
		if (secAddStep) {
			const secId = secAddStep.dataset.geSecAddStep!;
			const cur = currentGuide();
			if (!cur) return;
			const newId = makeStepId(cur);
			collapsedSections.delete(secId);
			await applyEdit((g) => insertStep(g, secId, { id: newId, kind: "task", title: "New step" }), {
				selectStepId: newId,
				openStepCard: true,
			});
			focusStepTitleInput();
			return;
		}

		const secDel = t.closest<HTMLElement>("[data-ge-sec-del]");
		if (secDel) {
			const secId = secDel.dataset.geSecDel!;
			await applyEdit((g) => removeSection(g, secId));
			return;
		}

		const stUp = t.closest<HTMLElement>("[data-ge-step-up]");
		if (stUp) {
			await nudgeSelectedStep(stUp.dataset.geStepUp!, -1);
			return;
		}

		const stDown = t.closest<HTMLElement>("[data-ge-step-down]");
		if (stDown) {
			await nudgeSelectedStep(stDown.dataset.geStepDown!, 1);
			return;
		}

		const stDel = t.closest<HTMLElement>("[data-ge-step-del]");
		if (stDel) {
			const stepId = stDel.dataset.geStepDel!;
			await applyEdit((g) => removeStep(g, stepId));
			return;
		}

		const stSel = t.closest<HTMLElement>("[data-ge-select-step]");
		if (stSel) {
			const stepId = stSel.dataset.geSelectStep!;
			selectedStepId = stepId;
			renderEditor();
			renderStepEditor();
			if (window.innerWidth <= 760) {
				document.body.classList.remove("side-open");
			}
		}
	};

	wireOutlineReorder(root, guide);
}

async function addVariantPrompt(): Promise<void> {
	if (!host) return;
	const dlg = document.getElementById("dlg") as HTMLDialogElement | null;
	const form = document.getElementById("dlg-form") as HTMLFormElement | null;
	if (!dlg || !form) return;
	form.innerHTML =
		`<h2>Add guide variant</h2>` +
		`<label class="field"><span>Variant label</span><input type="text" name="label" maxlength="${MAX_VARIANT_LABEL}" required placeholder="e.g. Playthrough / Alignment"></label>` +
		`<label class="field"><span>Options (comma-separated, at least 2)</span><input type="text" name="options" required value="Default, Alternate"></label>` +
		`<div class="dlg-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Add</button></div>`;
	form.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => dlg.close();
	form.onsubmit = async (e) => {
		e.preventDefault();
		const label = (form.elements.namedItem("label") as HTMLInputElement).value.trim();
		const rawOpts = (form.elements.namedItem("options") as HTMLInputElement).value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (!label || rawOpts.length < 2) return;
		const slugify = (s: string) =>
			s
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 32) || "opt";

		dlg.close();
		await applyEdit((g) => {
			const curVars = structuredClone(g.variants || []);
			const usedVarIds = new Set(curVars.map((v) => v.id));
			let vid = slugify(label);
			if (!VARIANT_ID_PATTERN.test(vid) || usedVarIds.has(vid)) {
				let n = curVars.length + 1;
				while (usedVarIds.has(`var-${n}`)) n++;
				vid = `var-${n}`;
			}
			const usedOptIds = new Set<string>();
			const options = rawOpts.slice(0, MAX_VARIANT_OPTIONS).map((oLabel, idx) => {
				let oid = slugify(oLabel);
				if (!VARIANT_ID_PATTERN.test(oid) || usedOptIds.has(oid)) oid = `opt-${idx + 1}`;
				usedOptIds.add(oid);
				return { id: oid, label: oLabel.slice(0, MAX_OPTION_LABEL) };
			});
			const nextVar: GuideVariant = {
				id: vid,
				label: label.slice(0, MAX_VARIANT_LABEL),
				options,
				default: options[0]!.id,
			};
			curVars.push(nextVar);
			return { ...g, variants: curVars };
		});
	};
	dlg.showModal();
}

async function openEditSectionModal(secId: string): Promise<void> {
	const g = currentGuide();
	const sec = g?.sections.find((s) => s.id === secId);
	const dlg = document.getElementById("dlg") as HTMLDialogElement | null;
	const form = document.getElementById("dlg-form") as HTMLFormElement | null;
	if (!sec || !dlg || !form) return;

	form.innerHTML =
		`<h2>Edit section</h2>` +
		`<label class="field"><span>Title</span><input type="text" name="title" maxlength="${MAX_SECTION_TITLE}" required value="${esc(sec.title)}"></label>` +
		`<label class="field"><span>Recommended level</span><input type="text" name="level" maxlength="${MAX_SECTION_LEVEL}" value="${esc(sec.level || "")}" placeholder="e.g. 12–18"></label>` +
		`<label class="field"><span>Unlock gate</span><input type="text" name="gate" maxlength="${MAX_SECTION_GATE}" value="${esc(sec.gate || "")}" placeholder="e.g. Requires Double Jump"></label>` +
		`<label class="field"><span>After section</span><input type="text" name="after" maxlength="${MAX_SECTION_AFTER}" value="${esc(sec.after || "")}" placeholder="Optional prerequisite note"></label>` +
		`<label class="check" style="margin:6px 0"><input type="checkbox" name="optional" ${sec.optional ? "checked" : ""}><span>Optional section</span></label>` +
		`<label class="field"><span>Section notes (Markdown)</span><textarea name="notes" rows="3" maxlength="${MAX_NOTES}">${esc(sec.notes || "")}</textarea></label>` +
		`<div class="dlg-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Apply</button></div>`;

	form.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => dlg.close();
	form.onsubmit = async (e) => {
		e.preventDefault();
		const title = (form.elements.namedItem("title") as HTMLInputElement).value.trim() || sec.title;
		const level = (form.elements.namedItem("level") as HTMLInputElement).value.trim();
		const gate = (form.elements.namedItem("gate") as HTMLInputElement).value.trim();
		const after = (form.elements.namedItem("after") as HTMLInputElement).value.trim();
		const optional = (form.elements.namedItem("optional") as HTMLInputElement).checked;
		const notes = (form.elements.namedItem("notes") as HTMLTextAreaElement).value;
		dlg.close();
		await applyEdit((gr) =>
			updateSection(gr, secId, {
				title,
				level: level || undefined,
				gate: gate || undefined,
				after: after || undefined,
				optional: optional ? true : undefined,
				notes: notes.trim() ? notes : undefined,
			}),
		);
	};
	dlg.showModal();
}

/* ---------- Step Editor inside #detail ---------- */

function isStepEditorShowing(): boolean {
	if (typeof document === "undefined") return false;
	return Boolean(document.getElementById("ge-step-form"));
}

function clearStepEditorIfShowing(): void {
	if (!host || typeof document === "undefined") return;
	if (isStepEditorShowing()) {
		document.body.classList.remove("ge-step-open");
		host.closeDetail();
	}
}

function focusStepTitleInput(): void {
	if (typeof document === "undefined") return;
	const el = document.querySelector<HTMLInputElement>("#ge-step-form input[name='title']");
	el?.focus();
	el?.select();
}

export function renderStepEditor(): void {
	if (!host || typeof document === "undefined" || mode !== "edit") return;
	const guide = currentGuide();
	if (!guide || !selectedStepId) return;
	const found = findStepInGuide(guide, selectedStepId);
	if (!found) return;

	const { secIdx, stepIdx, step } = found;
	const sec = guide.sections[secIdx]!;
	const order = flatStepOrder(guide);
	const flatIdx = order.findIndex((o) => o.stepId === step.id);
	const nextFlat = flatIdx >= 0 && flatIdx + 1 < order.length ? order[flatIdx + 1]! : null;

	const existingThreads = new Set<string>();
	for (const s of guide.sections) {
		for (const st of s.steps) {
			if (st.thread) existingThreads.add(st.thread);
		}
	}

	const userMarkers = ((host.state.locs || []) as any[]).filter((l) => l && l.user && !l.temp);
	const allUserMarkers = ((host.state.locs || []) as any[]).filter((l) => l && l.user);

	const targetsHtml = (step.targets || [])
		.map((t, ti) => {
			if (t.kind === "marker" && t.marker !== undefined) {
				const loc = lookupAnyMarker(t.marker);
				const labelText = loc?.title || t.snapshot?.title || `Marker #${t.marker}`;
				const mapName = loc?.map || t.snapshot?.map || "";
				return (
					`<div class="ge-target-card" data-ge-ti="${ti}">` +
					`<div class="ge-target-top">` +
					`<span class="ge-target-name">${esc(labelText)}</span>` +
					(mapName ? `<span class="gp-badge">${esc(mapName)}</span>` : "") +
					`<button type="button" class="ge-icon-sm danger" data-ge-rm-target="${ti}" aria-label="Remove target">${host!.svgIcon("trash")}</button>` +
					`</div>` +
					`<div class="ge-target-opts">` +
					`<input type="text" data-ge-target-label="${ti}" value="${esc(t.label || "")}" maxlength="${MAX_TARGET_LABEL}" placeholder="Custom target label (optional)">` +
					`<label class="check"><input type="checkbox" data-ge-target-opt="${ti}" ${t.optional ? "checked" : ""}><span>Optional</span></label>` +
					`</div></div>`
				);
			}
			const p = (t.kind === "point" ? t.point : null) || { lat: 0, lng: 0 };
			return (
				`<div class="ge-target-card" data-ge-ti="${ti}">` +
				`<div class="ge-target-top">` +
				`<span class="ge-target-name">${esc(t.label || "Point waypoint")}</span>` +
				`<span class="gp-badge">${p.lat.toFixed(1)}, ${p.lng.toFixed(1)}</span>` +
				`<button type="button" class="ge-icon-sm danger" data-ge-rm-target="${ti}" aria-label="Remove target">${host!.svgIcon("trash")}</button>` +
				`</div>` +
				`<div class="ge-target-opts">` +
				`<input type="text" data-ge-target-label="${ti}" value="${esc(t.label || "")}" maxlength="${MAX_TARGET_LABEL}" placeholder="Waypoint label">` +
				`<label class="check"><input type="checkbox" data-ge-target-opt="${ti}" ${t.optional ? "checked" : ""}><span>Optional</span></label>` +
				`</div></div>`
			);
		})
		.join("");

	const variantsHtml = (guide.variants || [])
		.map((v) => {
			const allowed = new Set(step.only?.[v.id] || []);
			return (
				`<div class="ge-only-row">` +
				`<span class="ge-only-lbl">${esc(v.label)}</span>` +
				`<div class="ge-only-opts">${v.options
					.map(
						(o) =>
							`<label class="check"><input type="checkbox" data-ge-only="${esc(v.id)}:${esc(o.id)}" ${allowed.has(o.id) ? "checked" : ""}><span>${esc(o.label)}</span></label>`,
					)
					.join("")}</div>` +
				`</div>`
			);
		})
		.join("");

	const linksHtml = (step.links || [])
		.map(
			(lnk, li) =>
				`<div class="ge-link-row" data-ge-li="${li}">` +
				`<input type="url" data-ge-link-url="${li}" value="${esc(lnk.url)}" maxlength="${MAX_URL_LENGTH}" placeholder="https://...">` +
				`<input type="text" data-ge-link-lbl="${li}" value="${esc(lnk.label || "")}" maxlength="${MAX_LINK_LABEL}" placeholder="Link label">` +
				`<button type="button" class="ge-icon-sm danger" data-ge-rm-link="${li}" aria-label="Remove link">${host!.svgIcon("trash")}</button>` +
				`</div>`,
		)
		.join("");

	const userMarkerPickerHtml =
		allUserMarkers.length > 0
			? `<div class="ge-um-add">` +
				`<select id="ge-um-select" aria-label="Pick user marker to add as point">` +
				allUserMarkers
					.map(
						(m) =>
							`<option value="${m.id}">${esc(m.title || "User marker")}${m.temp ? " (temp)" : ""}</option>`,
					)
					.join("") +
				`</select>` +
				`<button type="button" class="chip" data-ge-step-act="add-user-marker">+ Point target</button>` +
				`</div>`
			: "";

	const notesSectionHtml = notesPreview
		? `<div class="ge-notes-head"><span>Notes (Preview)</span><button type="button" class="chip" data-ge-step-act="toggle-notes-preview">Edit</button></div>` +
			`<div class="d-desc ge-notes-preview">${step.notes ? host.renderMd(step.notes) : '<p class="ge-dim">Nothing written yet.</p>'}</div>`
		: `<div class="ge-notes-head"><span>Notes (Markdown)</span><button type="button" class="chip" data-ge-step-act="toggle-notes-preview">Preview</button></div>` +
			`<textarea name="notes" rows="4" maxlength="${MAX_NOTES}" placeholder="Markdown instructions, links, hints">${esc(step.notes || "")}</textarea>`;

	const body = document.getElementById("detail-body");
	const detail = document.getElementById("detail") as (HTMLElement & { outTimer?: any }) | null;
	if (!body || !detail) return;

	body.innerHTML =
		`<div class="ge-step-head-bar">` +
		`<div class="d-cat gs-eyebrow" style="--c:var(--accent-soft)"><i></i><span>Editing · ${esc(sec.title)} · Step ${flatIdx + 1}/${order.length}</span></div>` +
		`<button type="button" class="chip mobile-only" data-ge-step-act="open-outline">Outline</button>` +
		`</div>` +
		`<form id="ge-step-form" class="ge-step-form">` +
		`<label class="field"><span>Title</span><input type="text" name="title" value="${esc(step.title)}" maxlength="${MAX_STEP_TITLE}" required autocomplete="off"></label>` +
		`<div class="ge-row-2">` +
		`<label class="field"><span>Kind</span><select name="kind">${STEP_KINDS.map((k) => `<option value="${k}" ${step.kind === k ? "selected" : ""}>${k === "task" ? "Task" : k === "waypoint" ? "Waypoint" : "Info"}</option>`).join("")}</select></label>` +
		`<label class="field"><span>Thread</span><input type="text" name="thread" value="${esc(step.thread || "")}" maxlength="${MAX_THREAD}" list="ge-thread-list" placeholder="Questline tag"><datalist id="ge-thread-list">${[...existingThreads].map((th) => `<option value="${esc(th)}">`).join("")}</datalist></label>` +
		`</div>` +
		`<div class="ge-notes-box">${notesSectionHtml}</div>` +
		`<div class="ge-targets-box">` +
		`<div class="ge-sub-head"><span>Targets (${step.targets?.length ?? 0})</span></div>` +
		`<div class="ge-targets-list">${targetsHtml || '<p class="ge-dim">No targets yet. Bind a marker link or tap markers in Add steps mode.</p>'}</div>` +
		`<div class="ge-link-bind">` +
		`<input type="text" id="ge-bind-link" placeholder="Paste marker link (#loc=123 or URL)" autocomplete="off" aria-label="Marker link">` +
		`<button type="button" class="chip" data-ge-step-act="bind-link">Bind</button>` +
		`</div>` +
		userMarkerPickerHtml +
		`</div>` +
		`<div class="ge-row-2">` +
		`<label class="field"><span>Place</span><input type="text" name="place" value="${esc(step.place || "")}" maxlength="${MAX_PLACE}" placeholder="Sub-area or room"></label>` +
		`<div class="ge-flags-col">` +
		`<label class="check"><input type="checkbox" name="samePlace" ${step.samePlace ? "checked" : ""}><span>Same place</span></label>` +
		`<label class="check"><input type="checkbox" name="optional" ${step.optional ? "checked" : ""}><span>Optional</span></label>` +
		`<label class="check"><input type="checkbox" name="missable" ${step.missable ? "checked" : ""}><span>Missable</span></label>` +
		`</div>` +
		`</div>` +
		`<label class="field"><span>Reward</span><input type="text" name="reward" value="${esc(step.reward || "")}" maxlength="${MAX_REWARD}" placeholder="Item, XP, unlock"></label>` +
		`<label class="field"><span>Consequence / missable note</span><textarea name="consequence" rows="2" maxlength="${MAX_CONSEQUENCE}" placeholder="Warning if missed or mutually exclusive">${esc(step.consequence || "")}</textarea></label>` +
		(variantsHtml
			? `<div class="ge-only-box"><div class="ge-sub-head"><span>Variant visibility</span></div>${variantsHtml}</div>`
			: "") +
		`<div class="ge-links-box"><div class="ge-sub-head"><span>External links</span>` +
		((step.links?.length ?? 0) < MAX_STEP_LINKS
			? `<button type="button" class="chip" data-ge-step-act="add-link">+ Link</button>`
			: "") +
		`</div>${linksHtml}</div>` +
		`<div class="ge-step-actions">` +
		`<button type="button" class="chip" data-ge-step-act="dup">Duplicate</button>` +
		`<button type="button" class="chip" data-ge-step-act="split">Split</button>` +
		`<button type="button" class="chip" data-ge-step-act="merge" ${nextFlat ? "" : "disabled"}>Merge next</button>` +
		`<button type="button" class="chip danger" data-ge-step-act="del">Delete</button>` +
		`</div>` +
		`</form>`;

	const backBtn = document.getElementById("detail-back");
	if (backBtn) backBtn.hidden = true;
	clearTimeout(detail.outTimer);
	detail.classList.remove("leaving", "user-loc");
	detail.style.removeProperty("--c");
	detail.hidden = false;
	document.body.classList.add("detail-open", "ge-step-open");

	wireStepEditorForm(body, guide, secIdx, stepIdx, step, userMarkers);
}

function wireStepEditorForm(
	root: HTMLElement,
	_guide: Guide,
	_secIdx: number,
	_stepIdx: number,
	step: GuideStep,
	_userMarkers: any[],
): void {
	if (!host) return;
	const form = root.querySelector<HTMLFormElement>("#ge-step-form");
	if (!form) return;

	form.onsubmit = (e) => e.preventDefault();

	const patchStep = (patch: Partial<Omit<GuideStep, "id">>, coalesceKey?: string, reRenderOutline = false) => {
		const sid = step.id;
		void applyEdit((g) => updateStep(g, sid, patch), {
			coalesceKey,
			reRenderOutline,
			reRenderStepEditor: false,
		});
	};

	const titleEl = form.elements.namedItem("title") as HTMLInputElement;
	titleEl.oninput = () => {
		const v = titleEl.value;
		if (!v.trim()) return;
		const rowTitle = document.querySelector<HTMLElement>(`[data-ge-step="${CSS.escape(step.id)}"] .ge-step-title`);
		if (rowTitle) rowTitle.textContent = v.slice(0, MAX_STEP_TITLE);
		patchStep({ title: v.slice(0, MAX_STEP_TITLE) }, `st-title-${step.id}`, false);
	};

	const kindEl = form.elements.namedItem("kind") as HTMLSelectElement;
	kindEl.onchange = () => {
		patchStep({ kind: kindEl.value as StepKind }, undefined, true);
	};

	const threadEl = form.elements.namedItem("thread") as HTMLInputElement;
	threadEl.oninput = () => {
		const v = threadEl.value.trim();
		patchStep({ thread: v ? v.slice(0, MAX_THREAD) : undefined }, `st-thread-${step.id}`);
	};

	const notesEl = form.elements.namedItem("notes") as HTMLTextAreaElement | null;
	if (notesEl) {
		notesEl.oninput = () => {
			const v = notesEl.value;
			patchStep({ notes: v.trim() ? v.slice(0, MAX_NOTES) : undefined }, `st-notes-${step.id}`);
		};
	}

	const placeEl = form.elements.namedItem("place") as HTMLInputElement;
	placeEl.oninput = () => {
		const v = placeEl.value.trim();
		patchStep({ place: v ? v.slice(0, MAX_PLACE) : undefined }, `st-place-${step.id}`);
	};

	const rewardEl = form.elements.namedItem("reward") as HTMLInputElement;
	rewardEl.oninput = () => {
		const v = rewardEl.value.trim();
		patchStep({ reward: v ? v.slice(0, MAX_REWARD) : undefined }, `st-reward-${step.id}`);
	};

	const conseqEl = form.elements.namedItem("consequence") as HTMLTextAreaElement;
	conseqEl.oninput = () => {
		const v = conseqEl.value.trim();
		patchStep({ consequence: v ? v.slice(0, MAX_CONSEQUENCE) : undefined }, `st-conseq-${step.id}`);
	};

	for (const flagName of ["samePlace", "optional", "missable"] as const) {
		const cb = form.elements.namedItem(flagName) as HTMLInputElement;
		cb.onchange = () => {
			patchStep({ [flagName]: cb.checked ? true : undefined }, undefined, flagName === "missable");
		};
	}

	// Target custom labels & optional flags
	form.querySelectorAll<HTMLInputElement>("[data-ge-target-label]").forEach((inp) => {
		inp.oninput = () => {
			const ti = Number(inp.dataset.geTargetLabel);
			const val = inp.value;
			void applyEdit(
				(g) => {
					const found = findStepInGuide(g, step.id);
					const targets = structuredClone(found?.step.targets || []);
					if (!targets[ti]) return g;
					if (val.trim()) targets[ti]!.label = val.slice(0, MAX_TARGET_LABEL);
					else delete targets[ti]!.label;
					return updateStep(g, step.id, { targets });
				},
				{ coalesceKey: `st-tlbl-${step.id}-${ti}`, reRenderOutline: false, reRenderStepEditor: false },
			);
		};
	});

	form.querySelectorAll<HTMLInputElement>("[data-ge-target-opt]").forEach((cb) => {
		cb.onchange = () => {
			const ti = Number(cb.dataset.geTargetOpt);
			void applyEdit(
				(g) => {
					const found = findStepInGuide(g, step.id);
					const targets = structuredClone(found?.step.targets || []);
					if (!targets[ti]) return g;
					if (cb.checked) targets[ti]!.optional = true;
					else delete targets[ti]!.optional;
					return updateStep(g, step.id, { targets });
				},
				{ reRenderOutline: false, reRenderStepEditor: false },
			);
		};
	});

	// Variant visibility (`only`)
	form.querySelectorAll<HTMLInputElement>("[data-ge-only]").forEach((cb) => {
		cb.onchange = () => {
			const [vid, oid] = cb.dataset.geOnly!.split(":");
			void applyEdit(
				(g) => {
					const found = findStepInGuide(g, step.id);
					if (!found) return g;
					const nextOnly: Record<string, string[]> = structuredClone(found.step.only || {});
					const curSet = new Set(nextOnly[vid!] || []);
					if (cb.checked) curSet.add(oid!);
					else curSet.delete(oid!);
					if (curSet.size > 0) nextOnly[vid!] = [...curSet];
					else delete nextOnly[vid!];
					return updateStep(g, step.id, { only: Object.keys(nextOnly).length ? nextOnly : undefined });
				},
				{ reRenderOutline: false, reRenderStepEditor: false },
			);
		};
	});

	// Links url & label
	form.querySelectorAll<HTMLInputElement>("[data-ge-link-url], [data-ge-link-lbl]").forEach((inp) => {
		inp.oninput = () => {
			const isUrl = inp.hasAttribute("data-ge-link-url");
			const li = Number(isUrl ? inp.dataset.geLinkUrl : inp.dataset.geLinkLbl);
			const val = inp.value;
			void applyEdit(
				(g) => {
					const found = findStepInGuide(g, step.id);
					const links = structuredClone(found?.step.links || []);
					if (!links[li]) return g;
					if (isUrl) links[li]!.url = val.slice(0, MAX_URL_LENGTH);
					else if (val.trim()) links[li]!.label = val.slice(0, MAX_LINK_LABEL);
					else delete links[li]!.label;
					return updateStep(g, step.id, { links });
				},
				{
					coalesceKey: `st-lnk-${step.id}-${li}-${isUrl ? "u" : "l"}`,
					reRenderOutline: false,
					reRenderStepEditor: false,
				},
			);
		};
	});

	root.onclick = async (e) => {
		if (!host) return;
		const t = e.target as HTMLElement;

		const rmTarget = t.closest<HTMLElement>("[data-ge-rm-target]");
		if (rmTarget) {
			const ti = Number(rmTarget.dataset.geRmTarget);
			await applyEdit(
				(g) => {
					const found = findStepInGuide(g, step.id);
					const targets = structuredClone(found?.step.targets || []);
					targets.splice(ti, 1);
					return updateStep(g, step.id, { targets: targets.length ? targets : undefined });
				},
				{ openStepCard: true },
			);
			return;
		}

		const rmLink = t.closest<HTMLElement>("[data-ge-rm-link]");
		if (rmLink) {
			const li = Number(rmLink.dataset.geRmLink);
			await applyEdit(
				(g) => {
					const found = findStepInGuide(g, step.id);
					const links = structuredClone(found?.step.links || []);
					links.splice(li, 1);
					return updateStep(g, step.id, { links: links.length ? links : undefined });
				},
				{ openStepCard: true },
			);
			return;
		}

		const actBtn = t.closest<HTMLElement>("[data-ge-step-act]");
		if (!actBtn) return;
		const act = actBtn.dataset.geStepAct;

		if (act === "open-outline") {
			document.body.classList.add("side-open");
		} else if (act === "toggle-notes-preview") {
			notesPreview = !notesPreview;
			if (notesPreview) await host.ensureMarked();
			renderStepEditor();
		} else if (act === "bind-link") {
			const inp = document.getElementById("ge-bind-link") as HTMLInputElement | null;
			const parsed = parseMarkerLink(inp?.value || "");
			if (!parsed) {
				host.toast("Could not parse a marker link (#loc=123 or URL with ?loc=123).");
				return;
			}
			await ensureCrossMapMarkers();
			const loc = lookupAnyMarker(parsed.markerId);
			const catTitle = loc?.cat != null ? host.state.cats?.get(loc.cat)?.title : undefined;
			const target = loc
				? officialMarkerToTarget(loc, catTitle, parsed.mapSlug || loc.map)
				: ({
						kind: "marker",
						marker: parsed.markerId,
						...(parsed.mapSlug
							? { snapshot: { lat: 0, lng: 0, map: parsed.mapSlug, title: `Marker #${parsed.markerId}` } }
							: {}),
					} as GuideTarget);
			await applyEdit(
				(g) => {
					const f = findStepInGuide(g, step.id);
					if (!f) return g;
					const nextStep = addTargetToStepTargets(f.step, target);
					return updateStep(g, step.id, { targets: nextStep.targets });
				},
				{ openStepCard: true },
			);
			if (inp) inp.value = "";
		} else if (act === "add-user-marker") {
			const sel = document.getElementById("ge-um-select") as HTMLSelectElement | null;
			const umId = Number(sel?.value);
			const marker = ((host.state.locs || []) as any[]).find((l) => l && l.user && l.id === umId);
			if (!marker) return;
			const ptTarget = userMarkerToPointTarget(marker, host.state.mapInfo?.slug);
			await applyEdit(
				(g) => {
					const f = findStepInGuide(g, step.id);
					if (!f) return g;
					const nextStep = addTargetToStepTargets(f.step, ptTarget);
					return updateStep(g, step.id, { targets: nextStep.targets });
				},
				{ openStepCard: true },
			);
		} else if (act === "add-link") {
			await applyEdit(
				(g) => {
					const f = findStepInGuide(g, step.id);
					if (!f) return g;
					const links = structuredClone(f.step.links || []);
					if (links.length >= MAX_STEP_LINKS) return g;
					links.push({ url: "https://", label: "" });
					return updateStep(g, step.id, { links });
				},
				{ openStepCard: true },
			);
		} else if (act === "dup") {
			const g = currentGuide();
			if (!g) return;
			const copyId = makeStepId(g);
			await applyEdit((gr) => duplicateStep(gr, step.id, copyId), {
				selectStepId: copyId,
				openStepCard: true,
			});
		} else if (act === "split") {
			const g = currentGuide();
			if (!g) return;
			const newId = makeStepId(g);
			await applyEdit((gr) => splitStep(gr, step.id, { newStepId: newId }), {
				selectStepId: newId,
				openStepCard: true,
			});
		} else if (act === "merge") {
			const g = currentGuide();
			if (!g) return;
			const order = flatStepOrder(g);
			const idx = order.findIndex((o) => o.stepId === step.id);
			const nextId = idx >= 0 && idx + 1 < order.length ? order[idx + 1]!.stepId : null;
			if (!nextId) return;
			await applyEdit((gr) => mergeSteps(gr, step.id, nextId), {
				selectStepId: step.id,
				openStepCard: true,
			});
		} else if (act === "del") {
			await applyEdit((gr) => removeStep(gr, step.id), { openStepCard: true });
		}
	};
}

/* ---------- Slice 2 Hook: Keyboard & Drag Reordering (implemented cleanly in Slice 2) ---------- */

export async function nudgeSelectedStep(stepId: string, delta: -1 | 1): Promise<boolean> {
	const cur = currentGuide();
	if (!cur) return false;
	const found = findStepInGuide(cur, stepId);
	if (!found) return false;

	const { secIdx, stepIdx } = found;
	const curSec = cur.sections[secIdx]!;
	let destSecId = curSec.id;
	let destIdx = stepIdx + delta;

	if (destIdx < 0) {
		if (secIdx === 0) return false;
		const prevSec = cur.sections[secIdx - 1]!;
		destSecId = prevSec.id;
		destIdx = prevSec.steps.length;
	} else if (destIdx >= curSec.steps.length) {
		if (secIdx >= cur.sections.length - 1) return false;
		const nextSec = cur.sections[secIdx + 1]!;
		destSecId = nextSec.id;
		destIdx = 0;
	}

	collapsedSections.delete(destSecId);
	const saved = await applyEdit((g) => moveStep(g, stepId, destSecId, destIdx), {
		selectStepId: stepId,
		openStepCard: false,
	});
	return Boolean(saved);
}

interface DropSlot {
	el: HTMLElement;
	kind: "step" | "empty-sec" | "sec-head";
	secId: string;
	stepId?: string;
	stepIdx: number;
	top: number;
	bottom: number;
	mid: number;
}

interface ActiveDrag {
	pointerId: number;
	handleEl: HTMLElement;
	rowEl: HTMLElement;
	stepId: string;
	fromSecId: string;
	fromIdx: number;
	startX: number;
	startY: number;
	lastClientY: number;
	started: boolean;
	scroller: HTMLElement | null;
	scrollerRect: DOMRect | null;
	slots: DropSlot[];
	hoverSlot: DropSlot | null;
	placeAfter: boolean;
	raf: number;
}

let activeDrag: ActiveDrag | null = null;
let dragGlobalListenersWired = false;

function buildDropSlots(outline: HTMLElement, scroller: HTMLElement | null): DropSlot[] {
	const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
	const scrollY = scroller ? scroller.scrollTop : 0;
	const slots: DropSlot[] = [];
	const nodes = outline.querySelectorAll<HTMLElement>("[data-ge-step], [data-ge-empty-sec], [data-ge-sec-drop]");
	for (const el of nodes) {
		const r = el.getBoundingClientRect();
		const top = r.top - scrollerTop + scrollY;
		const bottom = r.bottom - scrollerTop + scrollY;
		const mid = (top + bottom) / 2;
		if (el.hasAttribute("data-ge-step")) {
			slots.push({
				el,
				kind: "step",
				secId: el.dataset.geSecId!,
				stepId: el.dataset.geStep!,
				stepIdx: Number(el.dataset.geStepIdx || 0),
				top,
				bottom,
				mid,
			});
		} else if (el.hasAttribute("data-ge-empty-sec")) {
			slots.push({
				el,
				kind: "empty-sec",
				secId: el.dataset.geEmptySec!,
				stepIdx: 0,
				top,
				bottom,
				mid,
			});
		} else if (el.hasAttribute("data-ge-sec-drop")) {
			slots.push({
				el,
				kind: "sec-head",
				secId: el.dataset.geSecDrop!,
				stepIdx: 0,
				top,
				bottom,
				mid,
			});
		}
	}
	return slots;
}

function findClosestSlot(slots: DropSlot[], contentY: number): { slot: DropSlot; placeAfter: boolean } | null {
	if (!slots.length) return null;
	let lo = 0;
	let hi = slots.length - 1;
	while (lo < hi) {
		const midIdx = (lo + hi) >> 1;
		if (slots[midIdx]!.mid < contentY) lo = midIdx + 1;
		else hi = midIdx;
	}
	let bestIdx = lo;
	if (lo > 0 && Math.abs(slots[lo - 1]!.mid - contentY) < Math.abs(slots[lo]!.mid - contentY)) {
		bestIdx = lo - 1;
	}
	const slot = slots[bestIdx]!;
	const placeAfter = slot.kind === "step" ? contentY >= slot.mid : false;
	return { slot, placeAfter };
}

function clearDropHighlight(d: ActiveDrag | null): void {
	if (!d?.hoverSlot) return;
	d.hoverSlot.el.classList.remove("drop-before", "drop-after", "drop-sec");
	d.hoverSlot = null;
}

function updateDragHover(d: ActiveDrag): void {
	if (!d.started || !d.slots.length) return;
	const scrollerTop = d.scrollerRect ? d.scrollerRect.top : 0;
	const scrollY = d.scroller ? d.scroller.scrollTop : 0;
	const contentY = d.lastClientY - scrollerTop + scrollY;
	const hit = findClosestSlot(d.slots, contentY);
	if (!hit) return;

	if (d.hoverSlot && d.hoverSlot.el === hit.slot.el && d.placeAfter === hit.placeAfter) return;
	clearDropHighlight(d);
	d.hoverSlot = hit.slot;
	d.placeAfter = hit.placeAfter;
	if (hit.slot.kind === "step") {
		hit.slot.el.classList.add(hit.placeAfter ? "drop-after" : "drop-before");
	} else {
		hit.slot.el.classList.add("drop-sec");
	}
}

function stopDragAutoScroll(d: ActiveDrag): void {
	if (d.raf) {
		cancelAnimationFrame(d.raf);
		d.raf = 0;
	}
}

function tickDragAutoScroll(): void {
	const d = activeDrag;
	if (!d || !d.started || !d.scroller || !d.scrollerRect) return;
	const edge = 44;
	let delta = 0;
	if (d.lastClientY < d.scrollerRect.top + edge) {
		delta = -Math.max(4, Math.round((d.scrollerRect.top + edge - d.lastClientY) * 0.35));
	} else if (d.lastClientY > d.scrollerRect.bottom - edge) {
		delta = Math.max(4, Math.round((d.lastClientY - (d.scrollerRect.bottom - edge)) * 0.35));
	}
	if (delta !== 0) {
		d.scroller.scrollTop += delta;
		updateDragHover(d);
		d.raf = requestAnimationFrame(tickDragAutoScroll);
	} else {
		d.raf = 0;
	}
}

function finishDrag(commit: boolean): void {
	const d = activeDrag;
	if (!d) return;
	activeDrag = null;
	stopDragAutoScroll(d);
	const slot = d.hoverSlot;
	const placeAfter = d.placeAfter;
	clearDropHighlight(d);
	d.rowEl.classList.remove("is-dragging");
	document.body.classList.remove("ge-dragging");
	try {
		if (d.handleEl.hasPointerCapture?.(d.pointerId)) d.handleEl.releasePointerCapture(d.pointerId);
	} catch {}

	if (!commit || !d.started || !slot) return;
	if (slot.kind === "step" && slot.stepId === d.stepId) return;

	const destSecId = slot.secId;
	const destIdx =
		slot.kind === "step" ? computeMoveStepIndex(d.fromSecId, d.fromIdx, destSecId, slot.stepIdx, placeAfter) : 0;

	collapsedSections.delete(destSecId);
	host?.perf("dragReorderStep", () => {
		void applyEdit((g) => moveStep(g, d.stepId, destSecId, destIdx), {
			selectStepId: d.stepId,
			openStepCard: false,
		});
	});
}

function wireDragGlobalListeners(): void {
	if (dragGlobalListenersWired || typeof document === "undefined") return;
	dragGlobalListenersWired = true;

	document.addEventListener(
		"pointermove",
		(e: PointerEvent) => {
			const d = activeDrag;
			if (!d || e.pointerId !== d.pointerId) return;
			d.lastClientY = e.clientY;
			if (!d.started) {
				if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
				d.started = true;
				d.rowEl.classList.add("is-dragging");
				document.body.classList.add("ge-dragging");
				const outline = document.getElementById("ge-outline");
				d.scroller = document.querySelector<HTMLElement>("#side .side-scroll");
				d.scrollerRect = d.scroller ? d.scroller.getBoundingClientRect() : null;
				d.slots = outline ? buildDropSlots(outline, d.scroller) : [];
				try {
					d.handleEl.setPointerCapture(d.pointerId);
				} catch {}
			}
			e.preventDefault();
			updateDragHover(d);
			if (d.scroller && d.scrollerRect && !d.raf) {
				const edge = 44;
				if (d.lastClientY < d.scrollerRect.top + edge || d.lastClientY > d.scrollerRect.bottom - edge) {
					d.raf = requestAnimationFrame(tickDragAutoScroll);
				}
			}
		},
		{ passive: false },
	);

	document.addEventListener("pointerup", (e: PointerEvent) => {
		if (activeDrag && e.pointerId === activeDrag.pointerId) {
			finishDrag(true);
		}
	});
	document.addEventListener("pointercancel", (e: PointerEvent) => {
		if (activeDrag && e.pointerId === activeDrag.pointerId) {
			finishDrag(false);
		}
	});
}

function wireOutlineReorder(root: HTMLElement, _guide: Guide): void {
	wireDragGlobalListeners();
	const outline = root.querySelector<HTMLElement>("#ge-outline");
	if (!outline) return;

	outline.addEventListener("pointerdown", (e: PointerEvent) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		const handleEl = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-ge-drag]");
		if (!handleEl) return;
		const rowEl = handleEl.closest<HTMLElement>("[data-ge-step]");
		if (!rowEl) return;
		e.preventDefault();
		finishDrag(false);
		activeDrag = {
			pointerId: e.pointerId,
			handleEl,
			rowEl,
			stepId: rowEl.dataset.geStep!,
			fromSecId: rowEl.dataset.geSecId!,
			fromIdx: Number(rowEl.dataset.geStepIdx || 0),
			startX: e.clientX,
			startY: e.clientY,
			lastClientY: e.clientY,
			started: false,
			scroller: null,
			scrollerRect: null,
			slots: [],
			hoverSlot: null,
			placeAfter: false,
			raf: 0,
		};
	});
}

function wireEditorGlobalShortcuts(): void {
	document.addEventListener("keydown", (e) => {
		if (mode !== "edit") return;
		const dlg = document.getElementById("dlg") as HTMLDialogElement | null;
		if (dlg?.open) return;

		if ((e.ctrlKey || e.metaKey) && !e.altKey) {
			const k = e.key.toLowerCase();
			const activeTag = document.activeElement?.tagName;
			const inInput = activeTag === "INPUT" || activeTag === "TEXTAREA";
			if (k === "z" && !inInput) {
				e.preventDefault();
				if (e.shiftKey) void redoGuideEdit();
				else void undoGuideEdit();
				return;
			}
			if (k === "y" && !inInput) {
				e.preventDefault();
				void redoGuideEdit();
				return;
			}
		}

		if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			const focusedRow = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-ge-step]");
			const targetId = focusedRow?.dataset.geStep || selectedStepId;
			if (!targetId) return;
			e.preventDefault();
			const delta = e.key === "ArrowUp" ? -1 : 1;
			void nudgeSelectedStep(targetId, delta).then(() => {
				document.querySelector<HTMLElement>(`[data-ge-step="${CSS.escape(targetId)}"]`)?.focus();
			});
		}
	});
}

/* ---------- Slice 3/4/5 Stubs & Integration Hooks ---------- */

function renderAddStepsBanner(): void {
	let banner = document.getElementById("guide-add-banner");
	if (!addStepsActive || mode !== "edit") {
		if (banner) banner.hidden = true;
		return;
	}
	const stage = document.getElementById("stage");
	if (!stage) return;
	if (!banner) {
		banner = document.createElement("div");
		banner.id = "guide-add-banner";
		banner.className = "guide-add-banner";
		banner.setAttribute("role", "status");
		stage.appendChild(banner);
	}
	const g = currentGuide();
	banner.innerHTML =
		`<span class="gab-dot" aria-hidden="true"></span>` +
		`<span class="gab-text">Adding steps to <b>${esc(g?.title || "guide")}</b> · Tap markers on map</span>` +
		`<button type="button" class="gab-done" data-gab-done>Done</button>`;
	banner.hidden = false;
	banner.querySelector<HTMLButtonElement>("[data-gab-done]")!.onclick = () => setAddStepsActive(false);
}

function buildTargetForLoc(loc: any): GuideTarget {
	if (loc.user) {
		return userMarkerToPointTarget(loc, host?.state.mapInfo?.slug);
	}
	const catTitle = loc.cat != null ? host?.state.cats?.get(loc.cat)?.title : undefined;
	return officialMarkerToTarget(loc, catTitle, host?.state.mapInfo?.slug);
}

async function appendStepWithTarget(title: string, target: GuideTarget, kind: StepKind = "task"): Promise<void> {
	const g = currentGuide();
	if (!g) return;
	const secId = currentSectionIdForInsert(g);
	const insertAt = nextInsertionIndexInSection(g, secId);
	const newId = makeStepId(g);
	collapsedSections.delete(secId);
	await applyEdit(
		(gr) =>
			insertStep(
				gr,
				secId,
				{
					id: newId,
					kind,
					title: title.slice(0, MAX_STEP_TITLE) || "Step",
					targets: [target],
				},
				insertAt,
			),
		{ selectStepId: newId, openStepCard: !addStepsActive },
	);
	host?.toast(`Added step "${title.slice(0, MAX_STEP_TITLE)}"`);
}

async function addTargetToCurrentStep(stepId: string, curTitle: string, target: GuideTarget): Promise<void> {
	await applyEdit(
		(g) => {
			const f = findStepInGuide(g, stepId);
			if (!f) return g;
			const nextStep = addTargetToStepTargets(f.step, target);
			return updateStep(g, stepId, { targets: nextStep.targets });
		},
		{ selectStepId: stepId, openStepCard: !addStepsActive },
	);
	host?.toast(`Added target to "${curTitle}"`);
}

function promptChoiceOrCreateStep(loc: any, x?: number, y?: number): void {
	if (!host || mode !== "edit") return;
	const g = currentGuide();
	if (!g) return;
	const target = buildTargetForLoc(loc);
	const title = String(loc.title || "Step").trim() || "Step";
	const curFound = selectedStepId ? findStepInGuide(g, selectedStepId) : null;

	if (!curFound) {
		void appendStepWithTarget(title, target, "task");
		return;
	}

	const cx = typeof x === "number" && Number.isFinite(x) ? x : Math.round(window.innerWidth / 2);
	const cy = typeof y === "number" && Number.isFinite(y) ? y : Math.round(window.innerHeight / 2);
	host.openCtx(cx, cy, {
		title,
		items: [
			{
				icon: "plus",
				label: "New step",
				fn: () => void appendStepWithTarget(title, target, "task"),
			},
			{
				icon: "pin",
				label: `Add to current step (${curFound.step.title.slice(0, 28)})`,
				fn: () => void addTargetToCurrentStep(curFound.step.id, curFound.step.title, target),
			},
		],
	});
}

export function onAddStepsMarkerTap(markerId: number, x?: number, y?: number): void {
	if (!host || mode !== "edit" || !addStepsActive) return;
	const loc = host.state.byId?.get(markerId);
	if (!loc) return;
	promptChoiceOrCreateStep(loc, x, y);
}

export async function addFreeWaypointAt(pos: { lat: number; lng: number }): Promise<void> {
	if (!host || mode !== "edit") return;
	const title = await host.askDialog({
		title: "New waypoint step",
		value: "Waypoint",
		okLabel: "Add step",
	});
	if (!title) return;
	const target: GuideTarget = {
		kind: "point",
		point: { lat: pos.lat, lng: pos.lng, map: host.state.mapInfo?.slug || "default" },
		label: title.slice(0, MAX_TARGET_LABEL),
	};
	await appendStepWithTarget(title, target, "waypoint");
}

export function addMarkerTargetPromptOrStep(loc: any): void {
	if (!host || mode !== "edit" || !loc) return;
	promptChoiceOrCreateStep(loc);
}

export async function createMultiTargetStepFromMarkers(markers: any[], titleSuggestion?: string): Promise<void> {
	if (!host || mode !== "edit" || !markers.length) return;
	const guide = currentGuide();
	if (!guide) return;

	const targets: GuideTarget[] = [];
	const seenOfficial = new Set<number>();
	for (const m of markers) {
		if (!m) continue;
		const tgt = buildTargetForLoc(m);
		if (tgt.kind === "marker") {
			if (seenOfficial.has(tgt.marker)) continue;
			seenOfficial.add(tgt.marker);
		}
		targets.push(tgt);
		if (targets.length >= MAX_STEP_TARGETS) break;
	}
	if (!targets.length) return;

	const suggested =
		titleSuggestion || suggestRegionTitle(markers, host.state.regions || [], host.state.regionById || new Map());
	const chosen = await host.askDialog({
		title: "Create guide step",
		message: `${targets.length} marker target${targets.length === 1 ? "" : "s"} selected.`,
		value: suggested.slice(0, MAX_STEP_TITLE),
		okLabel: "Add step",
	});
	if (!chosen) return;

	const secId = currentSectionIdForInsert(guide);
	const insertAt = nextInsertionIndexInSection(guide, secId);
	const newId = makeStepId(guide);
	collapsedSections.delete(secId);
	await applyEdit(
		(g) =>
			insertStep(
				g,
				secId,
				{
					id: newId,
					kind: "task",
					title: chosen.slice(0, MAX_STEP_TITLE),
					targets,
				},
				insertAt,
			),
		{ selectStepId: newId, openStepCard: true },
	);
	host.toast(`Created step "${chosen}" (${targets.length} targets)`);
}

function openPasteTextModal(): void {
	if (!host || mode !== "edit") return;
	const g = currentGuide();
	const dlg = document.getElementById("dlg") as HTMLDialogElement | null;
	const form = document.getElementById("dlg-form") as HTMLFormElement | null;
	if (!g || !dlg || !form) return;

	const secOptions =
		g.sections.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join("") +
		`<option value="__new__">+ New section…</option>`;
	const curSecId = currentSectionIdForInsert(g);

	form.innerHTML =
		`<h2>Paste text as steps</h2>` +
		`<p style="font-size:0.86em;opacity:0.8">Paste one step per line. Marker links like <code>#loc=123</code> or full marker URLs bind automatically.</p>` +
		`<textarea name="lines" rows="8" placeholder="- Find the Hidden Shrine (#loc=101)\n- Unlock the Watchtower\n- Speak to the Merchant" required></textarea>` +
		`<div class="ge-row-2" style="margin-top:8px">` +
		`<label class="field"><span>Section</span><select name="sec">${secOptions}</select></label>` +
		`<label class="field"><span>Default kind</span><select name="kind">${STEP_KINDS.map((k) => `<option value="${k}">${k === "task" ? "Task" : k === "waypoint" ? "Waypoint" : "Info"}</option>`).join("")}</select></label>` +
		`</div>` +
		`<label class="field" data-ge-newsec hidden><span>New section title</span><input type="text" name="newsec" maxlength="${MAX_SECTION_TITLE}" value="Section ${g.sections.length + 1}"></label>` +
		`<div class="ge-dim" data-ge-paste-count>0 step(s) parsed</div>` +
		`<div class="dlg-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Add steps</button></div>`;

	const secSel = form.elements.namedItem("sec") as HTMLSelectElement;
	secSel.value = curSecId;
	const newSecRow = form.querySelector<HTMLElement>("[data-ge-newsec]")!;
	const linesEl = form.elements.namedItem("lines") as HTMLTextAreaElement;
	const kindSel = form.elements.namedItem("kind") as HTMLSelectElement;
	const countEl = form.querySelector<HTMLElement>("[data-ge-paste-count]")!;

	const refreshCount = () => {
		const parsed = linesToSteps(linesEl.value, { kind: kindSel.value as StepKind });
		const bound = parsed.reduce((n, st) => n + (st.targets?.length ? 1 : 0), 0);
		countEl.textContent = `${parsed.length} step(s) parsed${bound ? ` · ${bound} bound to markers` : ""}`;
	};
	secSel.onchange = () => {
		newSecRow.hidden = secSel.value !== "__new__";
	};
	linesEl.oninput = refreshCount;
	kindSel.onchange = refreshCount;
	form.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => dlg.close();

	form.onsubmit = async (e) => {
		e.preventDefault();
		if (!host) return;
		const parsed = linesToSteps(linesEl.value, { kind: kindSel.value as StepKind });
		if (!parsed.length) return;
		await ensureCrossMapMarkers();

		const enrichedSteps = parsed.map((st) => {
			if (!st.targets?.length) return st;
			return {
				...st,
				targets: st.targets.map((t) => {
					if (t.kind !== "marker") return t;
					const loc = lookupAnyMarker(t.marker);
					if (!loc) return t;
					const catTitle = loc.cat != null ? host!.state.cats?.get(loc.cat)?.title : undefined;
					return officialMarkerToTarget(loc, catTitle, loc.map);
				}),
			};
		});

		const wantNewSec = secSel.value === "__new__";
		const targetSecId = secSel.value;
		const newSecTitle = (form.elements.namedItem("newsec") as HTMLInputElement).value.trim() || "New Section";
		dlg.close();

		let firstAddedId: string | null = null;
		await host.perf("pasteSteps", () =>
			applyEdit(
				(gr) => {
					let nextG = structuredClone(gr);
					let destSecId = targetSecId;
					if (wantNewSec) {
						const newId = makeSectionId(nextG);
						nextG = insertSection(nextG, { id: newId, title: newSecTitle });
						destSecId = newId;
					}
					for (const st of enrichedSteps) {
						const sid = makeStepId(nextG);
						if (!firstAddedId) firstAddedId = sid;
						nextG = insertStep(nextG, destSecId, { ...st, id: sid });
					}
					collapsedSections.delete(destSecId);
					return nextG;
				},
				{ selectStepId: firstAddedId ?? selectedStepId, openStepCard: Boolean(firstAddedId) },
			),
		);
		host.toast(`Added ${enrichedSteps.length} step(s)`);
	};

	dlg.showModal();
	setTimeout(() => linesEl.focus(), 0);
}

function openRawJsonModal(): void {
	// Wired in Slice 5
}