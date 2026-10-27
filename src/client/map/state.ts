// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Shared map viewer state and core UI/math helpers.

import { esc } from "../../shared/escape.ts";

export const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T | null =>
	r.querySelector<T>(s);

export const fmt = (n: number | string): string => Number(n).toLocaleString();

export const isMobile = (): boolean => typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches;

export function uid(): string {
	return (
		(typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
		Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
	);
}

export function vivid(hex?: string | null): string {
	// Lighten very dark group colours so they stay readable on the dark panel.
	const h = String(hex || "888888").replace("#", "");
	let [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	if (lum < 0.45) {
		const t = (0.45 - lum) / (1 - lum);
		[r, g, b] = [r, g, b].map((v) => Math.round(v + (255 - v) * t));
	}
	return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// tag filter value for "only markers with no tag" (tag ids are numbers, so this cannot clash)
export const UNTAGGED = "untagged";

export const emptyFC = { type: "FeatureCollection" as const, features: [] as any[] };

export const ICON_STOPS: [number, number][] = [
	[8, 0.5],
	[11, 0.7],
	[13, 0.9],
	[15, 1],
];
export function iconScale(z: number): number {
	if (z <= ICON_STOPS[0][0]) return ICON_STOPS[0][1];
	for (let i = 1; i < ICON_STOPS.length; i++) {
		const [z1, s1] = ICON_STOPS[i];
		if (z <= z1) {
			const [z0, s0] = ICON_STOPS[i - 1];
			return s0 + ((s1 - s0) * (z - z0)) / (z1 - z0);
		}
	}
	return 1;
}

export const state: Record<string, any> = {
	entry: null,
	folder: "",
	data: null,
	sprite: null,
	groups: [],
	cats: new Map(),
	locs: [],
	byId: new Map(),
	tags: [],
	profiles: [],
	profile: null,
	found: new Set<number>(),
	tag: null,
	tagStrict: false,
	view: { hidden: new Set<number>(), hideFound: false, collapsed: new Set<string | number>() },
	selected: null,
	map: null,
	mapReady: false,
	memoryOnly: false,
	stats: new Map<number, { total: number; found: number }>(),
	// search: see the search section. ids: the matches on this map while searching (null when not searching)
	search: {
		active: false,
		scope: "map",
		ids: null,
		rows: [],
		idx: 0,
		preview: null,
		run: 0,
		busy: false,
		wild: false,
	},
	presets: [],
	presetId: null,
	activeTileset: null as string | null,
	baseline: null, // baseline: the view before the first preset was picked
	trail: [],
	session: uid(), // navigation stack of opened markers (last = current); session ties history entries to it
	outLinks: new Map<number, number[]>(),
	inLinks: new Map<number, number[]>(), // location id -> ids its description links to / ids linking to it
	capturing: false,
	capture: null, // a screenshot is being rendered (the camera is not saved then)
	meta: null,
	spriteFile: null, // the game's meta.json, and which sprite file it uses
	tempMarkers: [], // temporary markers: kept for this tab only, never saved
	officialLocs: null,
	um: null, // the game's own markers (the rest of state.locs is the user's); the user-markers module
	tool: "pan",
	shape: "box",
	sel: null,
	drag: null, // map tool; selection shape kind; the selection (map coordinates) and the one being drawn
};

let syncNoteFn: (() => void) | null = null;
export function setSyncNote(fn: () => void): void {
	syncNoteFn = fn;
}
export function syncNote(): void {
	syncNoteFn?.();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, ms = 2600): void {
	const t = $("#toast");
	if (!t) return;
	t.textContent = msg;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		t.hidden = true;
	}, ms);
}

export interface AskDialogOptions {
	title: string;
	message?: string;
	value?: string | null;
	okLabel?: string;
	danger?: boolean;
}

export function askDialog({
	title,
	message = "",
	value = null,
	okLabel = "OK",
	danger = false,
}: AskDialogOptions): Promise<any> {
	return new Promise((resolve) => {
		const dlg = $<HTMLDialogElement>("#dlg")!;
		const form = $<HTMLFormElement>("#dlg-form")!;
		form.innerHTML =
			`<h2>${esc(title)}</h2>` +
			(message ? `<p>${esc(message)}</p>` : "") +
			(value !== null
				? `<input type="text" name="v" value="${esc(value)}" maxlength="60" autocomplete="off">`
				: "") +
			`<div class="dlg-actions"><button type="button" data-cancel>Cancel</button>` +
			`<button class="${danger ? "danger" : "primary"}">${esc(okLabel)}</button></div>`;
		const finish = (r: any) => {
			if (dlg.open) dlg.close();
			resolve(r);
		};
		form.onsubmit = (ev) => {
			ev.preventDefault();
			const vInput = form.elements.namedItem("v") as HTMLInputElement | null;
			finish(value !== null ? vInput?.value.trim() || null : true);
		};
		form.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => finish(null);
		dlg.oncancel = () => resolve(null);
		dlg.showModal();
		if (value !== null) (form.elements.namedItem("v") as HTMLInputElement | null)?.select();
	});
}