// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { esc } from "../../shared/escape.ts";
import { unpackMarker } from "../../shared/share-link.ts";
import type { UserCategory, UserMarker } from "../../shared/types.ts";
import { iconInner, iconsReady, loadIconLibrary, pinImage, searchIcons } from "../icons-lib.ts";
import { ICONS, svgIcon } from "../icons.ts";
// User markers: your own markers and categories, saved with the profile, plus temporary markers that only live
// in this tab. They are drawn as a ping in their category colour, can hold notes (markdown), and link to any
// other marker the same way official markers link to each other. Export and import carry the profile's copy.
import { PALETTE } from "./drawing.ts";

export const TEMP_CAT_ID = -1;
export const TEMP_CAT: UserCategory = { id: TEMP_CAT_ID, title: "Temporary", color: "#ffb547", temp: true };
const NEW_CAT = "__new";

export const MARKER_CONTROL_HTML =
	'<button type="button" id="tool-marker" class="notched" aria-label="Place marker" title="Place a marker. Tap again, or right-click or hold, for more">' +
	'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="5.5"/><circle cx="12" cy="11" r="1.8"/><path d="M12 16.5V21"/></svg></button>';

const newId = (): number => -(Math.floor(Math.random() * 2e9) + 1);

export function pingImage(name: string): ImageData {
	return pinImage("#" + name.slice(3).replace("-t", ""), name.endsWith("-t"));
}

function iconField(current?: string | null): string {
	return (
		'<div class="field um-icon"><span>Icon</span>' +
		'<input type="search" class="um-icon-q" placeholder="Search icons, e.g. key, skull, tree" autocomplete="off" aria-label="Search icons">' +
		'<div class="um-icon-grid" role="listbox" aria-label="Icons"></div>' +
		`<input type="hidden" name="glyph" value="${esc(current || "")}"></div>`
	);
}
function wireIcon(root: HTMLElement): void {
	const q = root.querySelector<HTMLInputElement>(".um-icon-q")!;
	const grid = root.querySelector<HTMLElement>(".um-icon-grid")!;
	const hid = root.querySelector<HTMLInputElement>('input[name="glyph"]')!;
	const color = root.querySelector<HTMLInputElement>('input[name="color"]');
	const paintColor = () => grid.style.setProperty("--c", color?.value || "#e5484d");
	root.addEventListener("um-color", paintColor);
	const draw = () => {
		const tile = (val: string, label: string, inner: string) =>
			`<button type="button" class="ic-tile${hid.value === val ? " on" : ""}" data-glyph="${val}" aria-label="${label}" title="${label}">${inner}</button>`;
		const names = searchIcons(q.value, 120);
		grid.innerHTML =
			tile("", "Plain dot", '<span class="ico-ping-mini"></span>') +
			names
				.map((n) =>
					tile(
						n,
						n.replace(/-/g, " "),
						`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${iconInner(n)}</svg>`,
					),
				)
				.join("") +
			(names.length ? "" : '<p class="none">No icon matches.</p>');
	};
	q.addEventListener("input", draw);
	grid.addEventListener("click", (e) => {
		const b = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-glyph]");
		if (!b) return;
		hid.value = b.dataset.glyph || "";
		draw();
	});
	paintColor();
	if (iconsReady()) draw();
	else {
		grid.innerHTML = '<p class="none">Loading icons…</p>';
		loadIconLibrary().then(draw, () => {
			grid.innerHTML = '<p class="none">The icons could not be loaded.</p>';
		});
	}
}

export interface UserMarkersController {
	setActive(on: boolean): void;
	menuItems(
		user: { kind: string; id?: number } | null | undefined,
	): { act: string; label: string; icon: string; danger?: boolean }[];
	menuAction(act: string, user: { kind: string; id?: number }): Promise<void>;
	detailHtml(l: any): string;
	detailAction(act: string, id: number): Promise<void>;
	deleteMany(ids: number[]): Promise<void>;
	addSharedTemp(packed: string): Promise<void>;
	placeAt(pos: { lat: number; lng: number }, temp: boolean): Promise<void>;
	startMove(m: { id: number; title: string }): void;
}

export function setupUserMarkers({
	map,
	state,
	mapEl,
	canvasBox,
	changed,
	select,
	closeDetail,
	askDialog,
	toast,
	requestTool,
}: {
	map: maplibregl.Map;
	state: any;
	mapEl: HTMLElement;
	canvasBox: HTMLElement;
	changed: () => void;
	select: (id: number, opts?: { fly?: boolean; push?: boolean }) => void;
	closeDetail: () => void;
	askDialog: (opts: any) => Promise<any>;
	toast: (msg: string, ms?: number) => void;
	requestTool: (tool: string) => void;
}): UserMarkersController {
	const profileCats = (): UserCategory[] => (state.profile.userCats ||= []);
	const profileMarkers = (): UserMarker[] => (state.profile.userMarkers ||= []);
	const findMarker = (id: number): UserMarker | null =>
		profileMarkers().find((m) => m.id === id) || state.tempMarkers.find((m: UserMarker) => m.id === id) || null;
	const local = (e: PointerEvent) => {
		const r = canvasBox.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	let active = false,
		kind: "perm" | "temp" = "perm",
		moveId: number | null = null;

	function dialog(
		title: string,
		body: string,
		{
			ok = "Save",
			danger = null,
			onReady,
		}: { ok?: string; danger?: string | null; onReady?: (form: HTMLFormElement) => void } = {},
	): Promise<{ form?: HTMLFormElement; del?: boolean } | null> {
		return new Promise((resolve) => {
			const d = document.getElementById("dlg") as HTMLDialogElement;
			const form = document.getElementById("dlg-form") as HTMLFormElement;
			form.innerHTML =
				`<h2>${esc(title)}</h2>${body}<div class="dlg-actions">` +
				(danger ? `<button type="button" class="danger" data-del>${esc(danger)}</button>` : "") +
				`<button type="button" data-cancel>Cancel</button><button class="primary">${esc(ok)}</button></div>`;
			d.classList.add("um");
			const finish = (r: { form?: HTMLFormElement; del?: boolean } | null) => {
				d.classList.remove("um");
				if (d.open) d.close();
				resolve(r);
			};
			form.onsubmit = (e) => {
				e.preventDefault();
				finish({ form });
			};
			form.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => finish(null);
			form.querySelector<HTMLElement>("[data-del]")?.addEventListener("click", () => finish({ del: true }));
			d.oncancel = () => finish(null);
			onReady?.(form);
			d.showModal();
		});
	}
	function colorField(c: string): string {
		return (
			`<div class="field um-color"><span>Colour</span><div class="um-sw">${PALETTE.map(
				(p) =>
					`<button type="button" class="sw" data-color="${p}" style="--c:${p}" aria-label="${p}"></button>`,
			).join("")}</div>` +
			`<div class="um-colorrow"><input type="color" name="color" value="${esc(c)}" aria-label="Colour wheel">` +
			`<input class="um-hex" maxlength="7" value="${esc(c)}" spellcheck="false" aria-label="Hex colour"></div></div>`
		);
	}
	function wireColor(root: HTMLElement): void {
		const color = root.querySelector<HTMLInputElement>('input[name="color"]')!;
		const hex = root.querySelector<HTMLInputElement>(".um-hex")!;
		const set = (c: string) => {
			color.value = c;
			hex.value = c;
			root.querySelectorAll<HTMLElement>(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
			root.dispatchEvent(new Event("um-color"));
		};
		root.querySelectorAll<HTMLElement>(".sw").forEach((b) =>
			b.addEventListener("click", () => set(b.dataset.color!)),
		);
		color.addEventListener("input", () => set(color.value));
		hex.addEventListener("input", () => {
			const v = hex.value.trim();
			if (/^#?[0-9a-f]{6}$/i.test(v)) set("#" + v.replace("#", "").toLowerCase());
		});
		set(color.value);
	}

	/* ---- records ---- */
	function removeRecords(ids: number[]): void {
		const gone = new Set(ids);
		state.profile.userMarkers = profileMarkers().filter((m) => !gone.has(m.id));
		state.tempMarkers = state.tempMarkers.filter((m: UserMarker) => !gone.has(m.id));
		for (const id of ids) state.found.delete(id);
		for (const m of [...state.profile.userMarkers, ...state.tempMarkers]) {
			if (m.links?.length) m.links = m.links.filter((x: number) => !gone.has(x));
		}
	}

	function pruneEmptyCategories(catIds: (number | undefined)[]): void {
		const used = new Set(profileMarkers().map((m) => m.cat));
		state.profile.userCats = profileCats().filter((c) => !catIds.includes(c.id) || used.has(c.id));
	}

	async function deleteMarker(m: UserMarker): Promise<void> {
		const ok = await askDialog({
			title: "Delete marker?",
			message: `"${m.title}" will be removed.`,
			okLabel: "Delete",
			danger: true,
		});
		if (!ok) return;
		const cat = m.cat;
		removeRecords([m.id]);
		pruneEmptyCategories([cat]);
		if (state.selected === m.id) closeDetail();
		changed();
	}

	async function deleteMany(ids: number[]): Promise<void> {
		if (!ids.length) return;
		const n = ids.length;
		const ok = await askDialog({
			title: `Delete ${n} user marker${n === 1 ? "" : "s"}?`,
			message: "They will be removed from this profile.",
			okLabel: "Delete",
			danger: true,
		});
		if (!ok) return;
		const cats = [...new Set(ids.map((id) => findMarker(id)?.cat))];
		removeRecords(ids);
		pruneEmptyCategories(cats);
		if (ids.includes(state.selected)) closeDetail();
		changed();
	}

	async function deleteCategory(cat: UserCategory): Promise<void> {
		const ids = profileMarkers()
			.filter((m) => m.cat === cat.id)
			.map((m) => m.id);
		const message = ids.length
			? `"${cat.title}" and its ${ids.length} marker${ids.length === 1 ? "" : "s"} will be removed.`
			: `"${cat.title}" will be removed.`;
		const ok = await askDialog({ title: "Delete category?", message, okLabel: "Delete", danger: true });
		if (!ok) return;
		removeRecords(ids);
		state.profile.userCats = profileCats().filter((c) => c.id !== cat.id);
		if (ids.includes(state.selected)) closeDetail();
		changed();
	}

	/* ---- the marker form ---- */
	async function markerForm({
		marker = null,
		pos = null,
		temp = false,
		promote = false,
	}: {
		marker?: UserMarker | null;
		pos?: { lat: number; lng: number } | null;
		temp?: boolean;
		promote?: boolean;
	}): Promise<UserMarker | null> {
		const isTemp = promote ? false : marker ? !!marker.temp : temp;
		const cats = profileCats();
		const links = [...(marker?.links || [])];
		const sh = marker?.shared || null;
		const sameName = sh ? cats.find((c) => c.title.trim().toLowerCase() === sh.name.trim().toLowerCase()) : null;
		const selCat =
			marker && !marker.temp ? marker.cat : sameName ? sameName.id : sh ? NEW_CAT : (cats[0]?.id ?? NEW_CAT);
		const fresh = sh && !sameName ? sh : null;
		const opts =
			cats
				.map((c) => `<option value="${c.id}"${c.id === selCat ? " selected" : ""}>${esc(c.title)}</option>`)
				.join("") + `<option value="${NEW_CAT}"${selCat === NEW_CAT ? " selected" : ""}>New category…</option>`;
		const body =
			`<label class="field"><span>Name</span><input name="title" maxlength="80" required value="${esc(marker?.title || "")}" autocomplete="off"></label>` +
			(isTemp
				? '<p class="d-note">Temporary: this marker is gone when the tab closes.</p>'
				: `<label class="field"><span>Category</span><select name="cat">${opts}</select></label>` +
					`<div class="um-newcat" ${selCat === NEW_CAT ? "" : "hidden"}><label class="field"><span>New category</span>` +
					`<input name="newcat" maxlength="40" placeholder="e.g. Keys" autocomplete="off" value="${esc(fresh?.name || "")}"></label>${colorField(fresh?.color || PALETTE[0])}${iconField(fresh?.glyph || "")}</div>`) +
			`<label class="field"><span>Notes</span><textarea name="desc" rows="4" placeholder="Markdown works">${esc(marker?.desc || "")}</textarea></label>` +
			'<div class="field"><span>Links</span><div class="um-chips"></div>' +
			'<input type="search" class="um-q" placeholder="Find a marker to link" autocomplete="off"><ul class="um-pick" hidden></ul></div>';

		const onReady = (form: HTMLFormElement) => {
			const sel = form.elements.namedItem("cat") as HTMLSelectElement | null;
			const block = form.querySelector<HTMLElement>(".um-newcat");
			if (sel && block)
				sel.addEventListener("change", () => {
					block.hidden = sel.value !== NEW_CAT;
				});
			if (block) {
				wireColor(block);
				wireIcon(block);
			}
			const chips = form.querySelector<HTMLElement>(".um-chips")!;
			const q = form.querySelector<HTMLInputElement>(".um-q")!;
			const pick = form.querySelector<HTMLElement>(".um-pick")!;
			const drawChips = () => {
				chips.innerHTML = links
					.map((id) => {
						const t = state.byId.get(id);
						return `<span class="um-chip">${esc(t ? t.title : id > 0 ? "Marker on another map" : "Missing marker")}<button type="button" data-rm="${id}" aria-label="Remove link">&times;</button></span>`;
					})
					.join("");
			};
			chips.onclick = (e) => {
				const b = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-rm]");
				if (!b) return;
				const i = links.indexOf(Number(b.dataset.rm));
				if (i >= 0) links.splice(i, 1);
				drawChips();
			};
			const drawPick = () => {
				const s = q.value.trim().toLowerCase();
				if (!s) {
					pick.hidden = true;
					pick.innerHTML = "";
					return;
				}
				const hits = state.locs
					.filter(
						(l: any) => l.id !== marker?.id && !links.includes(l.id) && l.title.toLowerCase().includes(s),
					)
					.slice(0, 8);
				pick.innerHTML = hits.length
					? hits
							.map(
								(l: any) =>
									`<li data-add="${l.id}">${esc(l.title)}<small>${esc(state.cats.get(l.cat)?.title || "")}</small></li>`,
							)
							.join("")
					: '<li class="none">No marker matches</li>';
				pick.hidden = false;
			};
			q.addEventListener("input", drawPick);
			q.addEventListener("keydown", (e) => {
				if (e.key === "Enter") e.preventDefault();
			});
			pick.onclick = (e) => {
				const li = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-add]");
				if (!li) return;
				links.push(Number(li.dataset.add));
				q.value = "";
				drawPick();
				drawChips();
			};
			drawChips();
		};

		const heading = promote ? "Make permanent" : marker ? "Edit marker" : "New marker";
		const res = await dialog(heading, body, {
			ok: marker && !promote ? "Save" : promote ? "Make permanent" : "Place",
			danger: marker && !promote ? "Delete" : null,
			onReady,
		});
		if (!res) return null;
		if (res.del && marker) {
			await deleteMarker(marker);
			return null;
		}

		const f = res.form!.elements as any;
		const title = f.title.value.trim();
		if (!title) {
			toast("A marker needs a name.");
			return null;
		}
		let cat: number | string = TEMP_CAT_ID;
		if (!isTemp) {
			cat = f.cat.value;
			if (cat === NEW_CAT) {
				const name = f.newcat.value.trim();
				if (!name) {
					toast("Give the new category a name.");
					return null;
				}
				const c: UserCategory = {
					id: newId(),
					title: name,
					color: f.color.value,
					glyph: f.glyph?.value || null,
				};
				profileCats().push(c);
				cat = c.id;
			} else cat = Number(cat);
		}
		const data = {
			title,
			cat: Number(cat),
			desc: f.desc.value,
			links: links.filter((id) => id !== marker?.id && (id > 0 || state.byId.has(id))),
		};
		let saved: UserMarker;
		const oldCat = marker?.cat;
		if (promote && marker) {
			state.tempMarkers = state.tempMarkers.filter((x: UserMarker) => x.id !== marker.id);
			saved = { id: marker.id, ...data, lat: marker.lat, lng: marker.lng, created: Date.now(), map: marker.map };
			profileMarkers().push(saved);
		} else if (marker) saved = Object.assign(marker, data);
		else if (isTemp && pos) {
			saved = { id: newId(), ...data, lat: pos.lat, lng: pos.lng, temp: true, map: state.mapInfo.slug };
			state.tempMarkers.push(saved);
		} else {
			saved = {
				id: newId(),
				...data,
				lat: pos!.lat,
				lng: pos!.lng,
				created: Date.now(),
				map: state.mapInfo.slug,
			};
			profileMarkers().push(saved);
		}
		if (oldCat !== undefined && oldCat !== saved.cat) pruneEmptyCategories([oldCat]);
		changed();
		return saved;
	}

	async function categoryForm(cat: UserCategory | null): Promise<void> {
		const body =
			`<label class="field"><span>Name</span><input name="title" maxlength="40" required value="${esc(cat?.title || "")}" autocomplete="off"></label>` +
			colorField(cat?.color || PALETTE[2]) +
			iconField(cat?.glyph || "");
		const res = await dialog(cat ? "Edit category" : "New category", body, {
			ok: cat ? "Save" : "Create",
			danger: cat ? "Delete category" : null,
			onReady: (form) => {
				wireColor(form);
				wireIcon(form);
			},
		});
		if (!res) return;
		if (res.del && cat) return deleteCategory(cat);
		const f = res.form!.elements as any;
		const title = f.title.value.trim();
		if (!title) return;
		const glyph = f.glyph.value || null;
		if (cat) {
			cat.title = title;
			cat.color = f.color.value;
			cat.glyph = glyph;
		} else profileCats().push({ id: newId(), title, color: f.color.value, glyph });
		changed();
	}

	/* ---- placing, moving ---- */
	async function addMarker(pos: { lat: number; lng: number }, temp: boolean): Promise<void> {
		const m = await markerForm({ pos, temp });
		if (!m) return;
		select(m.id, { fly: false });
		requestTool("pan");
	}
	function startMove(m: { id: number; title: string }): void {
		moveId = m.id;
		requestTool("marker");
		toast(`Click the map to move "${m.title}". Esc cancels.`, 4000);
	}

	canvasBox.addEventListener("pointerdown", (e) => {
		if (!active || e.button !== 0) return;
		const p = local(e);
		const ll = map.unproject([p.x, p.y]);
		const pos = { lat: ll.lat, lng: ll.lng };
		if (moveId != null) {
			const m = findMarker(moveId);
			moveId = null;
			if (m) {
				m.lat = pos.lat;
				m.lng = pos.lng;
				changed();
				select(m.id, { fly: false, push: false });
				requestTool("pan");
			}
			return;
		}
		addMarker(pos, kind === "temp");
	});

	/* ---- the marker button ---- */
	const markerBtn = document.getElementById("tool-marker")!;
	const pickMenu = document.createElement("div");
	pickMenu.id = "marker-menu";
	pickMenu.className = "menu row-menu";
	pickMenu.hidden = true;
	pickMenu.setAttribute("role", "menu");
	pickMenu.innerHTML =
		'<button type="button" role="menuitemradio" data-kind="perm" aria-checked="false">' +
		svgIcon("pin") +
		"<span>Permanent marker</span></button>" +
		'<button type="button" role="menuitemradio" data-kind="temp" aria-checked="false">' +
		svgIcon("tempPin") +
		"<span>Temporary marker</span></button>";
	function syncToolIcon(): void {
		markerBtn.querySelector("svg")!.innerHTML = ICONS[kind === "temp" ? "tempPin" : "pin"];
	}
	syncToolIcon();
	document.body.appendChild(pickMenu);

	function placeBeside(elm: HTMLElement, rect: DOMRect): void {
		elm.hidden = false;
		const w = elm.offsetWidth,
			h = elm.offsetHeight,
			pad = 8;
		elm.style.left = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad)) + "px";
		elm.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + "px";
	}
	function openPick(): void {
		pickMenu
			.querySelectorAll<HTMLElement>("[data-kind]")
			.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.kind === kind)));
		placeBeside(pickMenu, markerBtn.getBoundingClientRect());
	}
	let holdT: ReturnType<typeof setTimeout> | null = null,
		held = false;
	markerBtn.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		held = false;
		holdT = setTimeout(() => {
			held = true;
			openPick();
		}, 500);
	});
	(["pointerup", "pointerleave", "pointercancel"] as const).forEach((t) =>
		markerBtn.addEventListener(t, () => {
			if (holdT) clearTimeout(holdT);
		}),
	);
	markerBtn.addEventListener("click", () => {
		if (held) {
			held = false;
			return;
		}
		if (active) {
			if (pickMenu.hidden) openPick();
			else pickMenu.hidden = true;
			return;
		}
		pickMenu.hidden = true;
		requestTool("marker");
	});
	markerBtn.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		openPick();
	});
	pickMenu.onclick = (e) => {
		const b = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-kind]");
		if (!b || !b.dataset.kind) return;
		kind = b.dataset.kind as "perm" | "temp";
		syncToolIcon();
		pickMenu.hidden = true;
		requestTool("marker");
	};
	document.addEventListener("click", (e) => {
		if (!(e.target as HTMLElement | null)?.closest("#marker-menu, #tool-marker")) pickMenu.hidden = true;
	});
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		pickMenu.hidden = true;
		if (moveId != null) {
			moveId = null;
			toast("Move cancelled");
		}
	});

	function setActive(on: boolean): void {
		active = on;
		if (!on) moveId = null;
		mapEl.classList.toggle("tool-marker", on);
		markerBtn.setAttribute("aria-pressed", String(on));
	}

	async function addSharedTemp(packed: string): Promise<void> {
		const d = await unpackMarker(packed);
		if (!d) {
			toast("That link does not hold a valid marker.", 5000);
			return;
		}
		const shared = d.category ? { name: d.category, color: d.color, glyph: d.glyph } : null;
		const m: UserMarker = {
			id: newId(),
			title: d.title,
			desc: d.desc,
			cat: TEMP_CAT_ID,
			lat: d.lat,
			lng: d.lng,
			links: d.links,
			temp: true,
			map: state.mapInfo.slug,
			shared,
		};
		state.tempMarkers.push(m);
		changed();
		select(m.id, { fly: true });
		toast("Shared marker added as temporary. Make it permanent from its card.", 5000);
	}

	function menuItems(user: { kind: string; id?: number } | null | undefined) {
		if (!user) return [];
		if (user.kind === "group") return [{ act: "newcat", label: "New category", icon: "plus" }];
		if (user.kind === "cat" && user.id === TEMP_CAT_ID)
			return [{ act: "clear-temp", label: "Clear temporary markers", icon: "trash", danger: true }];
		if (user.kind === "cat")
			return [
				{ act: "editcat", label: "Edit category", icon: "pencil" },
				{ act: "delcat", label: "Delete category", icon: "trash", danger: true },
			];
		return [];
	}
	async function menuAction(act: string, user: { kind: string; id?: number }): Promise<void> {
		if (act === "newcat") return categoryForm(null);
		if (act === "clear-temp") {
			const n = state.tempMarkers.length;
			const ok = await askDialog({
				title: "Clear temporary markers?",
				message: `${n} temporary marker${n === 1 ? "" : "s"} will be removed.`,
				okLabel: "Clear",
				danger: true,
			});
			if (!ok) return;
			removeRecords(state.tempMarkers.map((m: UserMarker) => m.id));
			changed();
			return;
		}
		const cat = profileCats().find((c) => c.id === user.id);
		if (!cat) return;
		if (act === "editcat") return categoryForm(cat);
		if (act === "delcat") return deleteCategory(cat);
	}

	function detailHtml(l: any): string {
		const links = (l.links || []).map((id: number) => state.byId.get(id)).filter(Boolean);
		const list = links.length
			? `<div class="d-links"><h3>Links</h3><ul>${links.map((t: any) => `<li><a href="#loc=${t.id}" data-loc="${t.id}">${esc(t.title)}</a></li>`).join("")}</ul></div>`
			: "";
		const btn = (act: string, label: string, icon: string, danger?: boolean) =>
			`<button type="button" class="ibtn${danger ? " danger" : ""}" data-um="${act}" data-tip="${label}" aria-label="${label}">${svgIcon(icon)}</button>`;
		return (
			`<div class="um-bar"><span class="um-badge">${l.temp ? "Temporary" : "Your marker"}</span>` +
			(l.temp ? btn("promote", "Make permanent", "save") : "") +
			btn("edit", "Edit", "pencil") +
			btn("move", "Move", "move") +
			btn("delete", "Delete", "trash", true) +
			"</div>" +
			list
		);
	}
	async function detailAction(act: string, id: number): Promise<void> {
		const m = findMarker(id);
		if (!m) return;
		if (act === "promote") await markerForm({ marker: m, promote: true });
		else if (act === "edit") await markerForm({ marker: m });
		else if (act === "move") startMove(m);
		else if (act === "delete") await deleteMarker(m);
	}

	return {
		setActive,
		menuItems,
		menuAction,
		detailHtml,
		detailAction,
		deleteMany,
		addSharedTemp,
		placeAt: addMarker,
		startMove,
	};
}