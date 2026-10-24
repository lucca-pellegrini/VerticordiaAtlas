/* ---------- profiles ---------- */

import { esc } from "../../shared/escape.ts";
import { dbAll, dbDelete, dbPut, getMeta, setMeta } from "./db.ts";
import { closeDetail } from "./detail.ts";
import { refreshAll, rememberCamera, syncMapToProfile } from "./map-view.ts";
import { loadMapState, renderPresets, savePresets, tagOnly, tagSwitchUsable } from "./presets.ts";
import { easeInOutCubic, endMorph, rebuildUserData, startMorph } from "./sidebar.ts";
import { $, askDialog, state, syncNote, toast, uid } from "./state.ts";

export const HEX = /^#[0-9a-f]{6}$/i;
export const GLYPH = /^[a-z0-9-]{1,60}$/;
export const DRAW_KINDS = ["pen", "highlighter", "line", "arrow", "path", "rect", "ellipse", "text"];

const finite = (v: any): number | undefined => (Number.isFinite(v) ? v : undefined);
const clip = (v: any, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

// the "only this tag" switch means nothing under "Everything", so it is dimmed then (and only shows a hint)
export function syncTagStrict(): void {
	const btn = $("#tag-strict");
	const row = $("#tag-row");
	if (row) row.hidden = !state.tags.length;
	if (!btn) return;
	btn.setAttribute("aria-pressed", String(tagOnly()));
	btn.setAttribute("aria-disabled", String(!tagSwitchUsable()));
}

// a tap toggles the switch; holding it down shows the description instead (the hover bubble is CSS)
export function wireTagStrict(): void {
	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	let tipTimer: ReturnType<typeof setTimeout> | undefined;
	let held = false;
	const showTip = (btn: HTMLElement) => {
		btn.classList.add("tip");
		clearTimeout(tipTimer);
		tipTimer = setTimeout(() => btn.classList.remove("tip"), 1800);
	};
	const btn = $("#tag-strict");
	if (!btn) return;
	btn.addEventListener("pointerdown", (e: PointerEvent) => {
		held = false;
		if (e.pointerType === "mouse") return; // mouse users get the hover bubble
		pressTimer = setTimeout(() => {
			held = true;
			showTip(btn);
		}, 450);
	});
	(["pointerup", "pointerleave", "pointercancel"] as const).forEach((t) =>
		btn.addEventListener(t, () => clearTimeout(pressTimer)),
	);
	btn.addEventListener("click", () => {
		if (held) {
			held = false;
			return;
		}
		if (!tagSwitchUsable()) {
			showTip(btn);
			return;
		}
		state.tagStrict = !state.tagStrict;
		syncTagStrict();
		scheduleViewSave();
		refreshAll();
	});
}

export function makeProfile(name: string, tag: any): any {
	const id = uid();
	return {
		key: `${state.entry.id}:${id}`,
		id,
		game: state.entry.id,
		name,
		tag,
		found: [],
		created: Date.now(),
		updated: Date.now(),
	};
}

export async function loadProfiles(): Promise<void> {
	state.profiles = (await dbAll("profiles"))
		.filter((p) => p.game === state.entry.id)
		.sort((a, b) => a.created - b.created);
	if (!state.profiles.length) {
		const p = makeProfile("Default", null);
		await dbPut("profiles", p);
		state.profiles = [p];
	}
	const wantProfile = new URLSearchParams(location.search).get("profile");
	const last = wantProfile || (await getMeta("last-profile:" + state.entry.id));
	applyProfile(state.profiles.find((p: any) => p.id === last || p.name === last) || state.profiles[0]);
	if (wantProfile && state.profile) setMeta("last-profile:" + state.entry.id, state.profile.id);
}

// A profile's own data (categories, markers, drawings, cameras) can come from an imported file, so nothing in it is
// trusted: every field is checked and clipped to what the page expects, and anything else is dropped.
export function cleanUserData<T extends Record<string, any>>(p: T): T {
	const firstMap: string = state.meta?.maps?.[0]?.slug || "";
	const list = (v: any): any[] => (Array.isArray(v) ? v : []);
	(p as any).userCats = list(p.userCats)
		.filter((c) => c && finite(c.id) !== undefined)
		.map((c) => ({
			id: c.id,
			title: clip(c.title, 40) || "Category",
			color: HEX.test(c.color) ? c.color : "#e5484d",
			glyph: GLYPH.test(c.glyph || "") ? c.glyph : null,
		}));
	(p as any).userMarkers = list(p.userMarkers)
		.filter((m) => m && finite(m.id) !== undefined && finite(m.lat) !== undefined && finite(m.lng) !== undefined)
		.map((m) => ({
			id: m.id,
			cat: finite(m.cat) ?? null,
			title: clip(m.title, 80) || "Marker",
			desc: clip(m.desc, 5000),
			lat: m.lat,
			lng: m.lng,
			links: list(m.links)
				.filter((id) => finite(id) !== undefined)
				.slice(0, 200),
			map: clip(m.map, 80) || firstMap,
			created: finite(m.created) ?? Date.now(),
		}));
	(p as any).drawings = list(p.drawings)
		.filter(
			(d) =>
				d &&
				DRAW_KINDS.includes(d.kind) &&
				Array.isArray(d.pts) &&
				d.pts.length &&
				d.pts.every((q: any) => q && finite(q.lng) !== undefined && finite(q.lat) !== undefined),
		)
		.slice(0, 5000)
		.map((d) => ({
			id: clip(d.id, 40) || uid(),
			kind: d.kind,
			color: HEX.test(d.color) ? d.color : "#e5484d",
			size: ["s", "m", "l"].includes(d.size) ? d.size : "m",
			pts: d.pts.slice(0, 5000).map((q: any) => ({ lng: q.lng, lat: q.lat })),
			circle: !!d.circle,
			text: clip(d.text, 2000),
			z: finite(d.z),
			map: clip(d.map, 80) || firstMap,
		}));
	const cams: Record<string, { lng: number; lat: number; zoom: number }> = {};
	if (p.cameras && typeof p.cameras === "object") {
		for (const [k, c] of Object.entries<any>(p.cameras)) {
			if (c && finite(c.lng) !== undefined && finite(c.lat) !== undefined && finite(c.zoom) !== undefined) {
				cams[clip(k, 80)] = { lng: c.lng, lat: c.lat, zoom: c.zoom };
			}
		}
	}
	(p as any).cameras = cams;
	(p as any).map = clip(p.map, 80) || null;
	(p as any).found = list(p.found).filter((id) => finite(id) !== undefined);
	return p;
}

export function applyProfile(p: any): void {
	cleanUserData(p);
	state.profile = p;
	// records from before there were several maps belong to the game's first map
	const first = state.meta?.maps?.[0]?.slug;
	if (first) {
		for (const d of p.drawings || []) d.map ??= first;
		for (const m of p.userMarkers || []) m.map ??= first;
	}
	rebuildUserData(); // the profile's own categories and markers
	state.drawing?.reset(); // drawings belong to the profile: each one has its own undo history
	state.found = new Set(p.found || []);
	renderProfileSelect();
	syncTagStrict();
}

export function renderProfileSelect(): void {
	const sel = $<HTMLSelectElement>("#profile-select");
	if (!sel || !state.profile) return;
	sel.innerHTML = state.profiles.map((p: any) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
	sel.value = state.profile.id;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePending = false;
export const isSavePending = (): boolean => savePending;

export function scheduleSave(): void {
	clearTimeout(saveTimer);
	savePending = true;
	saveTimer = setTimeout(saveProfileNow, 200);
}

export async function saveProfileNow(): Promise<void> {
	clearTimeout(saveTimer);
	savePending = false;
	const p = state.profile;
	if (!p) return;
	p.found = [...state.found];
	p.updated = Date.now();
	try {
		await dbPut("profiles", p);
		syncNote();
	} catch (e) {
		console.error(e);
		toast("Could not save progress in this browser.");
	}
}

let viewTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleViewSave(): void {
	clearTimeout(viewTimer);
	viewTimer = setTimeout(() => {
		const p = state.profile,
			slug = state.mapInfo?.slug;
		if (!p || !slug) return;
		p.view = {
			...(p.view || {}),
			[slug]: {
				hidden: [...state.view.hidden],
				hideFound: state.view.hideFound,
				collapsed: [...state.view.collapsed],
				presetId: state.presetId,
				baseline: state.baseline,
				tag: state.tag,
				tagStrict: state.tagStrict,
			},
		};
		scheduleSave();
	}, 250);
}

// A profile switch: the sidebar goes to loading and comes back (body.profile-switch, as a map switch does), its numbers and
// bar morph, and the markers and drawings fade out and back in (the veil). The map itself stays put; if the profile is on
// another map, syncMapToProfile runs the map switch, which keeps its own fade.
const VEIL_OUT_MS = 350,
	VEIL_IN_MS = 1500;
let veil = 1,
	veilRaf = 0,
	veilDone: (() => void) | null = null;
export function setVeil(v: number): void {
	veil = v;
	const clear = v >= 1; // full strength: no inline style, so the stylesheet's own opacity rules apply again
	if (state.mapReady && state.map.getLayer("locs")) {
		state.map.setPaintProperty(
			"locs",
			"icon-opacity",
			clear ? ["case", ["==", ["get", "f"], 1], 0.4, 1] : ["*", ["case", ["==", ["get", "f"], 1], 0.4, 1], v],
		);
		if (state.map.getLayer("hover-loc")) state.map.setPaintProperty("hover-loc", "icon-opacity", v);
	}
	// the stylesheet eases drawings in over 1.6s; the veil sets them every frame, so their own transition is switched off
	for (const el of document.querySelectorAll<HTMLElement>("#map .draw-layer, #map .text-layer")) {
		el.style.transition = clear ? "" : "none";
		el.style.opacity = clear ? "" : String(v);
	}
}

export function tweenVeil(to: number, ms: number): Promise<void> {
	return new Promise((resolve) => {
		cancelAnimationFrame(veilRaf);
		veilDone?.();
		veilDone = resolve;
		const from = veil,
			start = performance.now();
		const step = (now: number) => {
			const k = easeInOutCubic(Math.min(1, Math.max(0, (now - start) / ms)));
			setVeil(from + (to - from) * k);
			if (k < 1) veilRaf = requestAnimationFrame(step);
			else {
				veilDone = null;
				resolve();
			}
		};
		veilRaf = requestAnimationFrame(step);
	});
}

export async function switchProfile(id: string): Promise<void> {
	rememberCamera(false); // the camera belongs to the profile being left
	await saveProfileNow();
	const p = state.profiles.find((x: any) => x.id === id);
	if (!p) return;
	closeDetail(); // a card open on the old profile's marker closes the way a close does
	document.body.classList.add("profile-switch");
	startMorph();
	await tweenVeil(0, VEIL_OUT_MS);
	applyProfile(p);
	await loadMapState(); // the view belongs to the profile
	await syncMapToProfile();
	await setMeta("last-profile:" + state.entry.id, p.id).catch(() => {});
	refreshAll();
	endMorph({ later: true });
	document.body.classList.remove("profile-switch");
	await tweenVeil(1, VEIL_IN_MS);
}

export async function profileAction(act: string): Promise<void> {
	const p = state.profile;
	if (act === "new") {
		const name = await askDialog({
			title: "New profile",
			message: "One profile per save file keeps found markers separate.",
			value: `Playthrough ${state.profiles.length + 1}`,
			okLabel: "Create",
		});
		if (!name) return;
		await saveProfileNow();
		const np = makeProfile(name, state.tag);
		await dbPut("profiles", np);
		state.profiles.push(np);
		await switchProfile(np.id);
	} else if (act === "rename") {
		const name = await askDialog({ title: "Rename profile", value: p.name, okLabel: "Rename" });
		if (!name) return;
		p.name = name;
		await saveProfileNow();
		renderProfileSelect();
	} else if (act === "reset") {
		const ok = await askDialog({
			title: "Clear found markers?",
			message: `Every marker in "${p.name}" will be unmarked.`,
			okLabel: "Clear",
			danger: true,
		});
		if (!ok) return;
		state.found.clear();
		await saveProfileNow();
		refreshAll();
	} else if (act === "delete") {
		const ok = await askDialog({
			title: "Delete profile?",
			message: `"${p.name}" and its found markers will be removed from this browser.`,
			okLabel: "Delete",
			danger: true,
		});
		if (!ok) return;
		await dbDelete("profiles", p.key);
		state.profiles = state.profiles.filter((x: any) => x.id !== p.id);
		if (!state.profiles.length) {
			const np = makeProfile("Default", null);
			await dbPut("profiles", np);
			state.profiles.push(np);
		}
		state.profile = null;
		applyProfile(state.profiles[0]);
		await loadMapState();
		await setMeta("last-profile:" + state.entry.id, state.profile.id).catch(() => {});
		refreshAll();
	} else if (act === "export") {
		await saveProfileNow();
		// every profile with what is in it: found markers, drawings, the user's own categories and markers, and the
		// map and camera it was on; plus the game's presets (they are per game, so there is one list)
		const presets = state.presets.map((q: any) => ({ id: q.id, name: q.name, hidden: q.hidden }));
		const payload = {
			app: "offline-map-viewer",
			version: 1,
			game: state.entry.id,
			exported: new Date().toISOString(),
			profiles: state.profiles.map(
				({ id, name, tag, found, created, updated, map, cameras, drawings, userCats, userMarkers }: any) => ({
					id,
					name,
					tag,
					found,
					created,
					updated,
					map: map ?? null,
					cameras: cameras || {},
					drawings: drawings || [],
					userCats: userCats || [],
					userMarkers: userMarkers || [],
				}),
			),
			presets,
		};
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
		a.download = `${state.entry.id}-progress-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 2000);
	} else if (act === "import") {
		$("#import-file")?.click();
	}
}

export async function importFile(file: File): Promise<void> {
	try {
		const payload = JSON.parse(await file.text());
		if (payload.app !== "offline-map-viewer" || !Array.isArray(payload.profiles))
			throw new Error("not a progress file");
		if (payload.game !== state.entry.id)
			throw new Error(`this file is for "${payload.game}", not "${state.entry.id}"`);
		const profs = payload.profiles.filter((q: any) => q && q.id && Array.isArray(q.found));
		const pres = (Array.isArray(payload.presets) ? payload.presets : []).filter(
			(p: any) => p && p.id && Array.isArray(p.hidden),
		);

		// what would collide: a profile with the same id or name; a preset with the same id or name in this game
		const conflicts: { key: string; label: string }[] = [];
		for (const q of profs) {
			if (state.profiles.some((p: any) => p.id === q.id || p.name === String(q.name || ""))) {
				conflicts.push({ key: "p:" + q.id, label: `Profile "${q.name || "Imported"}"` });
			}
		}
		for (const p of pres) {
			if (state.presets.some((x: any) => x.id === String(p.id) || x.name === String(p.name || ""))) {
				conflicts.push({ key: `s:${p.id}`, label: `Preset "${p.name || "Imported"}"` });
			}
		}
		let decisions: Map<string, string> | null = new Map();
		if (conflicts.length) {
			decisions = await chooseConflicts(conflicts);
			if (!decisions) return;
		} else {
			const ok = await askDialog({
				title: "Import progress?",
				message: `${profs.length} profile(s) and ${pres.length} preset(s) will be added.`,
				okLabel: "Import",
			});
			if (!ok) return;
		}

		await saveProfileNow();
		const takenNames = new Set<string>(state.profiles.map((p: any) => p.name));
		for (const q of profs) {
			let id = q.id,
				name = String(q.name || "Imported");
			const d = decisions.get("p:" + q.id);
			if (d === "rename") {
				id = uid();
				name = uniqueName(name, takenNames);
			}
			if (d === "overwrite") {
				const gone = state.profiles.filter((p: any) => p.id === q.id || p.name === name);
				for (const old of gone) await dbDelete("profiles", old.key);
				state.profiles = state.profiles.filter((p: any) => !gone.includes(p));
			}
			takenNames.add(name);
			const rec = cleanUserData({
				key: `${state.entry.id}:${id}`,
				id,
				game: state.entry.id,
				name: clip(name, 60) || "Imported",
				tag: typeof q.tag === "string" ? q.tag : null,
				found: q.found,
				drawings: q.drawings,
				userCats: q.userCats,
				userMarkers: q.userMarkers,
				map: q.map,
				cameras: q.cameras,
				created: finite(q.created) ?? Date.now(),
				updated: Date.now(),
			});
			await dbPut("profiles", rec);
			const at = state.profiles.findIndex((x: any) => x.id === rec.id);
			if (at >= 0) state.profiles[at] = rec;
			else state.profiles.push(rec);
		}

		// presets are per game: they all go into the game's one list
		const list = [...state.presets];
		for (const p of pres) {
			let id = String(p.id),
				name = String(p.name || "Imported");
			const d = decisions.get(`s:${p.id}`);
			if (d === "overwrite") {
				const at = list.findIndex((x: any) => x.id === id || x.name === name);
				if (at >= 0) list.splice(at, 1);
			} else if (d === "rename") {
				id = uid();
				name = uniqueName(name, new Set(list.map((x: any) => x.name)));
			}
			list.push({ id, name, hidden: p.hidden.filter(Number.isFinite) });
		}
		state.presets = list;
		await savePresets();

		const cur = state.profiles.find((x: any) => x.id === state.profile.id) || state.profiles[0];
		applyProfile(cur);
		await loadMapState();
		await syncMapToProfile();
		refreshAll();
		renderPresets();
		toast("Progress imported.");
	} catch (e: any) {
		toast("Import failed: " + e.message, 5000);
	}
}

// "Name - copy" (then "- copy 2"...), not already in the set; the name is added to it
export function uniqueName(base: string, taken: Set<string>): string {
	let name = `${base} - copy`,
		n = 2;
	while (taken.has(name)) name = `${base} - copy ${n++}`;
	taken.add(name);
	return name;
}

// one row per collision: keep both (the copy gets a new name) or overwrite the existing one. Resolves to a Map of
// key -> 'rename' | 'overwrite', or null when cancelled.
export function chooseConflicts(items: { key: string; label: string }[]): Promise<Map<string, string> | null> {
	return new Promise((resolve) => {
		const d = $<HTMLDialogElement>("#dlg")!;
		const form = $<HTMLFormElement>("#dlg-form")!;
		const rows = items
			.map(
				(it, i) =>
					`<fieldset class="conflict"><legend>${esc(it.label)}</legend>` +
					`<label><input type="radio" name="c${i}" value="rename" checked> Keep both</label>` +
					`<label><input type="radio" name="c${i}" value="overwrite"> Overwrite the existing one</label></fieldset>`,
			)
			.join("");
		form.innerHTML =
			`<h2>Some items already exist</h2>` +
			`<p>Keeping both imports a copy under a new name ("- copy" is added).</p>` +
			`<div class="bulk"><button type="button" data-all="rename">Keep all</button><button type="button" data-all="overwrite">Overwrite all</button></div>` +
			`<div class="conflicts um">${rows}</div>` +
			`<div class="dlg-actions"><button type="button" data-cancel>Cancel</button><button class="primary">Import</button></div>`;
		d.classList.add("um");
		const finish = (r: Map<string, string> | null) => {
			d.classList.remove("um");
			if (d.open) d.close();
			resolve(r);
		};
		form.onsubmit = (e) => {
			e.preventDefault();
			const out = new Map<string, string>();
			items.forEach((it, i) => out.set(it.key, (form.elements.namedItem(`c${i}`) as RadioNodeList).value));
			finish(out);
		};
		form.querySelectorAll<HTMLButtonElement>("[data-all]").forEach(
			(b) =>
				(b.onclick = () => {
					items.forEach((_, i) => {
						const input = form.querySelector<HTMLInputElement>(
							`input[name="c${i}"][value="${b.dataset.all}"]`,
						);
						if (input) input.checked = true;
					});
				}),
		);
		form.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => finish(null);
		d.oncancel = () => finish(null);
		d.showModal();
	});
}