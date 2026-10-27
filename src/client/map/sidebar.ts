// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- filtering, stats, and sidebar ---------- */

import { esc, formatBytes } from "../../shared/escape.ts";
import { glyphInk, iconInner, iconsReady, loadIconLibrary } from "../icons-lib.ts";
import { svgIcon } from "../icons.ts";
import { downloadOfflineGame, getGameOfflineManifests, removeOfflineGame } from "../offline.ts";
import type { OfflineStatus } from "../offline.ts";
import { themeToggle } from "../theme.ts";
import { buildLinkIndex } from "./detail.ts";
import {
	refreshAll,
	refreshMap,
	refreshRegions,
	resolveTilesets,
	switchTileset,
	updateTilesetControl,
} from "./map-view.ts";
import { renderPresets } from "./presets.ts";
import { HEX, saveProfileNow, scheduleSave, scheduleViewSave } from "./profiles.ts";
import { runSearch } from "./search.ts";
import { $, askDialog, fmt, state, toast, UNTAGGED } from "./state.ts";
import { TEMP_CAT } from "./usermarkers.ts";

// with a tag selected, untagged markers are shown unless "only markers with this tag" is on
export const applicable = (l: { tags: number[] }): boolean => {
	if (state.tag == null) return true;
	if (state.tag === UNTAGGED) return l.tags.length === 0;
	return l.tags.includes(state.tag) || (!state.tagStrict && l.tags.length === 0);
};

export const shownOnMap = (l: { id: number; cat: number; tags: number[] }): boolean =>
	applicable(l) && !state.view.hidden.has(l.cat) && !(state.view.hideFound && state.found.has(l.id));

export function computeStats(): void {
	const st = new Map<number, { total: number; found: number }>();
	for (const l of state.locs) {
		if (!applicable(l)) continue;
		let s = st.get(l.cat);
		if (!s) st.set(l.cat, (s = { total: 0, found: 0 }));
		s.total++;
		if (state.found.has(l.id)) s.found++;
	}
	state.stats = st;
}

const BLACK_OR_WHITE = new Set(["#000", "#000000", "#fff", "#ffffff"]); // layers the site leaves to the category colour
export function iconHtml(name?: string | null, color?: string | null): string {
	// the sidebar logo: the game's own glyph for this category, in the category colour (the map keeps the marker sprite)
	const glyph = name && state.glyphs?.map[name];
	if (glyph !== undefined) {
		const tint = HEX.test(color || "") ? color : "var(--ink)";
		if (state.glyphs.image) {
			const x = typeof glyph === "number" ? 0 : glyph.x || 0;
			const y = typeof glyph === "number" ? glyph : glyph.y || 0;
			const sz = state.glyphs.size;
			const m = `url('${state.glyphs.image}') -${x}px -${y}px / ${sz}px auto no-repeat`;
			return `<span class="ico-img" style="width:${sz}px;height:${sz}px;background:${tint};-webkit-mask:${m};mask:${m}"></span>`;
		}
		// one glyph, or stacked layers; a layer in black takes the category colour, the others keep the site's colours
		const layers = (Array.isArray(glyph) ? glyph : [{ cp: glyph }])
			.map(
				(l: any) =>
					`<span style="color:${l.color && !BLACK_OR_WHITE.has(l.color) ? l.color : tint}${l.ml ? `;margin-left:${l.ml}` : ""}">&#x${l.cp};</span>`,
			)
			.join("");
		return `<span class="ico-font" style="font-family:'${state.glyphs.family}'">${layers}</span>`;
	}
	if (name && name.startsWith("ic-")) {
		const m = /^ic-(.+)-([0-9a-f]{6})$/i.exec(name),
			inner = m && iconInner(m[1]);
		if (inner && m)
			return `<span class="ico-glyph" style="--c:#${m[2]};--g:${glyphInk("#" + m[2])}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg></span>`;
		return `<span class="ico-ping" style="--c:#${m ? m[2] : "e5484d"}"></span>`; // the library has not arrived yet
	}
	if (name && name.startsWith("up-")) {
		const hex = name.slice(3).replace("-t", "");
		return `<span class="ico-ping${name.endsWith("-t") ? " temp" : ""}" style="--c:${HEX.test("#" + hex) ? "#" + hex : "#e5484d"}"></span>`;
	}
	const d = name ? state.sprite?.defs?.[name] : null;
	if (!d) return "";
	const s = 28 / d.height;
	return (
		`<span class="ico" style="width:${d.width}px;height:${d.height}px;background-image:url('${state.folder}/${state.sprite.png}');` +
		`background-position:-${d.x}px -${d.y}px;transform:scale(${s})"></span>`
	);
}

// Desktop only: hides the left panel so the map takes the full width.
export function setSideCollapsed(collapsed: boolean): void {
	document.body.classList.toggle("side-collapsed", collapsed);
	const b = $("#side-collapse");
	if (!b) return;
	b.innerHTML = collapsed
		? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l6 6-6 6M13 6l6 6-6 6"/></svg>'
		: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6l-6 6 6 6M11 6l-6 6 6 6"/></svg>';
	const label = collapsed ? "Show panel" : "Hide panel";
	b.title = label;
	b.setAttribute("aria-label", label);
	b.setAttribute("aria-expanded", String(!collapsed));
}

/* ---------- a map switch morphs the sidebar's numbers and progress bar to the new map ----------
   The numbers count from the old totals to the new ones, and the bar segments grow or shrink to the new sizes. Both use
   the same curve and length (MORPH_MS, cubic in-out, as the CSS in style.css .bar.morph). Outside a switch nothing animates. */
const MORPH_MS = 1500;
const barSegs = new Map<any, HTMLDivElement>(); // group id -> its segment in #progress-bar, kept across map switches
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
let morphing = false;
let shownCounts: { found: number; total: number } | null = null; // { found, total } as last drawn, so a tween starts from what the user sees
let countRaf = 0;

export function resetShownCounts(): void {
	shownCounts = { found: 0, total: 0 };
}

export function startMorph(): void {
	morphing = true;
	$("#progress-bar")?.classList.add("morph");
}

export function endMorph({ later = false } = {}): void {
	const done = () => {
		morphing = false;
		$("#progress-bar")?.classList.remove("morph");
	};
	if (later) setTimeout(done, MORPH_MS);
	else done();
}

export function showCounts(found: number, total: number): void {
	const fEl = $("#found-count"),
		tEl = $("#total-count");
	if (!fEl || !tEl) return;
	cancelAnimationFrame(countRaf);
	if (!morphing || !shownCounts) {
		// first draw, or a plain change: no count
		shownCounts = { found, total };
		fEl.textContent = fmt(found);
		tEl.textContent = fmt(total);
		return;
	}
	const from = shownCounts,
		start = performance.now();
	const step = (now: number) => {
		// clamped to [0, 1]: a frame's timestamp can precede `start`, and the curve would dip below zero there
		const k = easeInOutCubic(Math.min(1, Math.max(0, (now - start) / MORPH_MS)));
		shownCounts =
			k < 1
				? {
						found: Math.round(from.found + (found - from.found) * k),
						total: Math.round(from.total + (total - from.total) * k),
					}
				: { found, total };
		fEl.textContent = fmt(shownCounts.found);
		tEl.textContent = fmt(shownCounts.total);
		if (k < 1) countRaf = requestAnimationFrame(step);
	};
	countRaf = requestAnimationFrame(step);
}

export function buildSidebar(): void {
	const root = $("#groups");
	const bar = $("#progress-bar");
	if (!root || !bar) return;
	root.textContent = "";
	state.ui = { groups: new Map(), cats: new Map(), segs: new Map() };

	for (const g of state.groups) {
		// segments persist across map switches, so the bar morphs to the new sizes instead of being rebuilt
		let seg = barSegs.get(g.id);
		if (!seg) {
			seg = document.createElement("div");
			seg.className = "seg";
			seg.style.flexGrow = "0.0001";
			seg.innerHTML = "<i></i>";
			barSegs.set(g.id, seg);
		}
		seg.style.setProperty("--c", g.col);
		seg.title = g.title;
		bar.appendChild(seg); // moving an existing node keeps the bar in group order
		state.ui.segs.set(g.id, seg);

		const el = document.createElement("section");
		el.className = "group" + (state.view.collapsed.has(g.id) ? " collapsed" : "");
		el.style.setProperty("--c", g.col);
		el.innerHTML =
			`<div class="group-head">${menuBtnHtml(g.title)}<button class="name" type="button">${esc(g.title)}</button>` +
			`<span class="tally"></span><input type="checkbox" class="g-toggle" aria-label="Show all in ${esc(g.title)}"></div>` +
			`<div class="cats"></div>`;
		const catsEl = el.querySelector<HTMLElement>(".cats")!;
		const gToggle = el.querySelector<HTMLInputElement>(".g-toggle")!;
		el.querySelector<HTMLElement>(".name")!.onclick = () => {
			el.classList.toggle("collapsed");
			el.classList.contains("collapsed") ? state.view.collapsed.add(g.id) : state.view.collapsed.delete(g.id);
			scheduleViewSave();
		};
		gToggle.onchange = () => {
			for (const c of g.cats) gToggle.checked ? state.view.hidden.delete(c.id) : state.view.hidden.add(c.id);
			onViewChanged();
		};
		el.querySelector<HTMLElement>(".group-head")!.oncontextmenu = (e) => {
			e.preventDefault();
			showOnly(g.cats.map((c: any) => c.id));
		};
		el.querySelector<HTMLElement>(".row-menu-btn")!.onclick = (e) =>
			openRowMenu(e, { title: g.title, color: g.col, cats: g.cats, user: g.user ? { kind: "group" } : null });

		const rows: any[] = [];
		for (const c of g.cats) {
			const row = document.createElement("label");
			row.className = "cat-row";
			if (c.info) row.title = c.info;
			row.innerHTML = `${menuBtnHtml(c.title)}<span class="ico-wrap">${iconHtml(c.icon, c.color || g.col)}</span><span class="label">${esc(c.title)}</span><span class="tally"></span><input type="checkbox">`;
			// the row is a label: it must activate the checkbox. Without this it would activate the first button inside it
			// (the three-dot menu), so a click on the name would open that menu instead of toggling the category
			const cb = row.querySelector<HTMLInputElement>("input")!;
			cb.id = `cat-${c.id}`;
			row.htmlFor = cb.id;
			cb.onchange = () => {
				cb.checked ? state.view.hidden.delete(c.id) : state.view.hidden.add(c.id);
				onViewChanged();
			};
			row.oncontextmenu = (e) => {
				e.preventDefault();
				showOnly([c.id]);
			};
			row.querySelector<HTMLElement>(".row-menu-btn")!.onclick = (e) =>
				openRowMenu(e, {
					title: c.title,
					icon: c.icon,
					cats: [c],
					user: c.user ? { kind: "cat", id: c.id } : null,
				});
			catsEl.appendChild(row);
			rows.push({ c, row, cb, tally: row.querySelector(".tally") });
			state.ui.cats.set(c.id, rows[rows.length - 1]);
		}
		state.ui.groups.set(g.id, { g, el, gToggle, tally: el.querySelector(".group-head .tally"), rows });
		root.appendChild(el);
	}
	// groups the new map does not have: shrink their segments away, then drop them
	for (const [id, seg] of barSegs) {
		if (state.ui.segs.has(id)) continue;
		barSegs.delete(id);
		seg.style.flexGrow = "0.0001";
		(seg.firstChild as HTMLElement).style.width = "0";
		setTimeout(() => seg.remove(), MORPH_MS);
	}
}

const menuBtnHtml = (name: string): string =>
	`<button type="button" class="row-menu-btn" aria-haspopup="menu" aria-label="Actions for ${esc(name)}" title="Actions">` +
	'<svg viewBox="0 0 4 16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg></button>';

interface RowMenuElement extends HTMLDivElement {
	_cats?: any[] | null;
	_user?: { kind: "group" | "cat"; id?: number } | null;
}

// Pop-up for a whole category or group: mark every rendering marker in it found or not found.
let rowMenuBtn: HTMLElement | null = null;
function rowMenuEl(): RowMenuElement {
	let el = document.getElementById("row-menu") as RowMenuElement | null;
	if (el) return el;
	el = document.createElement("div") as RowMenuElement;
	el.id = "row-menu";
	el.className = "menu row-menu";
	el.hidden = true;
	el.setAttribute("role", "menu");
	el.innerHTML =
		'<div class="rm-head"></div><hr>' +
		`<button type="button" role="menuitem" data-act="found">${svgIcon("check")}<span>Mark all as found</span></button>` +
		`<button type="button" role="menuitem" data-act="unfound">${svgIcon("open")}<span>Mark all as not found</span></button>` +
		`<button type="button" role="menuitem" data-act="list">${svgIcon("list")}<span>List these markers</span></button>`;
	el.onclick = (e) => {
		const target = e.target as HTMLElement;
		const um = target.closest<HTMLElement>("[data-um]");
		if (um) {
			const user = el!._user;
			closeRowMenu();
			state.um?.menuAction(um.dataset.um, user);
			return;
		}
		const b = target.closest<HTMLButtonElement>("button[data-act]");
		if (!b || b.disabled || !el!._cats) return;
		if (b.dataset.act === "list") {
			const cats = el!._cats;
			closeRowMenu();
			listCats(cats);
			return;
		}
		const locs = rowLocs(el!._cats);
		for (const l of locs) b.dataset.act === "found" ? state.found.add(l.id) : state.found.delete(l.id);
		closeRowMenu();
		saveProfileNow();
		refreshAll();
	};
	document.body.appendChild(el);
	return el;
}

// the markers a row covers right now: all its categories, filtered by the tag selection
function rowLocs(cats: any[]): any[] {
	const ids = new Set(cats.map((c) => c.id));
	return state.locs.filter((l: any) => ids.has(l.cat) && applicable(l));
}

export function openRowMenu(
	e: MouseEvent,
	{
		title,
		icon,
		color,
		cats,
		user = null,
	}: { title: string; icon?: string; color?: string; cats: any[]; user?: any },
): void {
	e.preventDefault();
	e.stopPropagation();
	const btn = e.currentTarget as HTMLElement;
	const el = rowMenuEl();
	if (rowMenuBtn === btn && !el.hidden) return closeRowMenu();
	const locs = rowLocs(cats);
	const found = locs.filter((l: any) => state.found.has(l.id)).length;
	const head = icon
		? `<span class="ico-wrap">${iconHtml(icon, color)}</span>`
		: `<span class="rm-dot" style="--c:${esc(color || "#888")}"></span>`;
	const kind = icon ? "Category" : "Group";
	el.querySelector(".rm-head")!.innerHTML =
		`${head}<div class="rm-text"><div class="rm-title">${esc(title)}</div>` +
		`<div class="rm-sub">${kind} · ${locs.length ? `${found}/${locs.length} found` : "No markers shown"}</div></div>`;
	el._cats = cats;
	el._user = user;
	el.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
		b.disabled = locs.length === 0;
	});
	// a user category or group gets its own items: edit, delete, new
	el.querySelectorAll("[data-um]").forEach((b) => b.remove());
	for (const it of state.um?.menuItems(user) || []) {
		const b = document.createElement("button");
		b.type = "button";
		b.setAttribute("role", "menuitem");
		b.dataset.um = it.act;
		b.innerHTML = svgIcon(it.icon) + `<span>${esc(it.label)}</span>`;
		if (it.danger) b.className = "danger";
		el.appendChild(b);
	}
	rowMenuBtn = btn;
	btn.setAttribute("aria-expanded", "true");
	el.hidden = false;
	const r = btn.getBoundingClientRect(),
		pad = 8;
	const w = el.offsetWidth,
		h = el.offsetHeight;
	let left = r.right + 8;
	if (left + w > innerWidth - pad) left = Math.max(pad, r.left - w - 8);
	el.style.left = left + "px";
	el.style.top = Math.max(pad, Math.min(r.top, innerHeight - h - pad)) + "px";
}

export function closeRowMenu(): void {
	const el = document.getElementById("row-menu") as RowMenuElement | null;
	if (el) {
		el.hidden = true;
		el._cats = null;
	}
	if (rowMenuBtn) rowMenuBtn.setAttribute("aria-expanded", "false");
	rowMenuBtn = null;
}

// Right-click on a category or group: show only those categories, hide everything else.
export function showOnly(ids: Iterable<number>): void {
	const keep = new Set(ids);
	for (const id of state.cats.keys()) keep.has(id) ? state.view.hidden.delete(id) : state.view.hidden.add(id);
	onViewChanged();
}

// "List these markers": the categories shown alone, and the search lists everything they show (the wildcard "*")
export function listCats(cats: any[]): void {
	showOnly(cats.map((c) => c.id));
	const search = $<HTMLInputElement>("#search");
	if (search) search.value = "*";
	runSearch();
}

export function updateSidebar(): void {
	if (!state.ui) return;
	computeStats();
	let total = 0,
		found = 0;
	for (const { g, gToggle, tally, rows } of state.ui.groups.values()) {
		let gt = 0,
			gf = 0,
			shown = 0,
			visibleRows = 0;
		for (const { c, row, cb, tally: t } of rows) {
			const s = state.stats.get(c.id) || { total: 0, found: 0 };
			row.hidden = s.total === 0;
			cb.checked = !state.view.hidden.has(c.id);
			row.classList.toggle("off", !cb.checked);
			t.textContent = `${s.found}/${s.total}`;
			t.classList.toggle("done", s.total > 0 && s.found === s.total);
			if (s.total) {
				visibleRows++;
				if (cb.checked) shown++;
			}
			gt += s.total;
			gf += s.found;
		}
		tally.textContent = `${gf}/${gt}`;
		gToggle.checked = visibleRows > 0 && shown === visibleRows;
		gToggle.indeterminate = shown > 0 && shown < visibleRows;
		gToggle.hidden = visibleRows === 0;
		const seg = state.ui.segs.get(g.id);
		seg.style.flexGrow = String(Math.max(gt, 0.0001));
		(seg.firstChild as HTMLElement).style.width = gt ? (100 * gf) / gt + "%" : "0";
		total += gt;
		found += gf;
	}
	showCounts(found, total);
	renderTilesetMenu();
	updateSidebarRegionsBtn();
	updateTilesetControl();
	saveSessionSoon();
}

/* ---------- the homepage's "continue" card: a small summary of this session, kept in localStorage only ----------
   Never sent anywhere (see the privacy policy): the homepage reads it to show where the user left off. */
let sessionTimer: ReturnType<typeof setTimeout> | undefined;
export function saveSessionSoon(): void {
	clearTimeout(sessionTimer);
	sessionTimer = setTimeout(saveSession, 400);
}

export function saveSession(): void {
	clearTimeout(sessionTimer);
	if (!state.entry || !state.mapInfo || !state.ui) return;
	try {
		const groups: any[] = [];
		for (const { g, rows } of state.ui.groups.values()) {
			let n = 0,
				f = 0;
			for (const { c } of rows) {
				const s = state.stats.get(c.id);
				if (s) {
					n += s.total;
					f += s.found;
				}
			}
			if (n) groups.push({ t: g.title, c: g.col, f, n });
		}
		const near: any[] = [];
		for (const [id, s] of state.stats) {
			if (s.total < 2 || s.found >= s.total || !s.found) continue;
			const c = state.cats.get(id);
			if (!c) continue;
			near.push({ t: c.title, c: state.groupOfCat?.get(id)?.col || null, f: s.found, n: s.total });
		}
		const score = (item: { f: number; n: number }) => (item.f / item.n) * (1 - 1 / Math.sqrt(item.n + 1));
		near.sort((a, b) => score(b) - score(a) || b.f / b.n - a.f / a.n || b.n - a.n);
		const recent: any[] = [];
		for (const id of [...state.found].reverse()) {
			const l = state.byId.get(id);
			if (!l) continue;
			const c = state.cats.get(l.cat);
			recent.push({
				t: l.title || c?.title || "Marker",
				cat: c?.title || "",
				c: state.groupOfCat?.get(l.cat)?.col || null,
			});
			if (recent.length >= 4) break;
		}
		const map = state.mapInfo.slug;
		const tag =
			state.tag === UNTAGGED ? "Only untagged" : state.tags.find((t: any) => t.id === state.tag)?.title || null;
		const visited = new Set(Object.keys(state.profile?.cameras || {}));
		const allMaps = (state.meta?.maps || []).map((m: any) => ({ slug: m.slug, title: m.title || m.slug }));
		allMaps.sort((a: any, b: any) => (visited.has(b.slug) ? 1 : 0) - (visited.has(a.slug) ? 1 : 0));

		const snap = {
			v: 1,
			slug: state.entry.slug,
			updated: Date.now(),
			map,
			mapTitle: state.mapInfo.title || map,
			maps: allMaps,
			profile: state.profile?.name || null,
			profileId: state.profile?.id || null,
			profiles: (state.profiles || []).map((p: any) => ({ id: p.id, name: p.name })),
			tagLabel: state.entry.tagLabel || null,
			tag,
			found: groups.reduce((a, g) => a + g.f, 0),
			total: groups.reduce((a, g) => a + g.n, 0),
			groups,
			near: near.slice(0, 5),
			recent,
			userMarkers: (state.profile?.userMarkers || []).filter((m: any) => m.map === map).length,
			drawings: (state.profile?.drawings || []).filter((d: any) => d.map === map).length,
			presets: state.presets.length,
		};
		localStorage.setItem("va_last_session", JSON.stringify(snap));
	} catch {
		/* storage full or unavailable: the homepage just shows its usual hero */
	}
}

export function onViewChanged(): void {
	scheduleViewSave();
	updateSidebar();
	refreshMap();
	renderPresets();
	if (state.search.active) runSearch(); // hidden categories and "hide found" change what matches
}

const USER_GROUP = "user-markers";
// a category's icon: its library glyph in its colour, or the plain dot of that colour
const iconFor = (c: { glyph?: string | null; color: string; temp?: boolean }) =>
	c.glyph ? `ic-${c.glyph}-${String(c.color).replace("#", "")}` : iconName(c.color, c.temp);
const iconName = (color: string, temp?: boolean) => `up-${color.replace("#", "")}${temp ? "-t" : ""}`;

// Rebuilds the user side of the data: the "User markers" group (only when there are categories), the user markers
// and the temporary ones, and the link index. Called whenever the profile or the temporary markers change.
export function rebuildUserData(): void {
	if (!state.officialLocs) return;
	const p = state.profile,
		here = state.mapInfo?.slug,
		temps = state.tempMarkers.filter((m: any) => m.map === here);
	const cats: any[] = [...(p?.userCats || [])];
	if (temps.length) cats.push(TEMP_CAT);
	for (const id of [...state.cats.keys()]) if (id < 0) state.cats.delete(id);
	// a category with a library icon needs the library: fetch it once, then draw again with it
	if (cats.some((c) => c.glyph) && !iconsReady())
		loadIconLibrary()
			.then(() => {
				rebuildUserData();
				refreshAll();
			})
			.catch(() => {});
	state.groups = state.groups.filter((g: any) => g.id !== USER_GROUP);
	if (cats.length) {
		const made = cats.map((c, i) => {
			const cat = {
				id: c.id,
				title: c.title,
				group_id: USER_GROUP,
				order: 1000 + i,
				icon: iconFor(c),
				user: true,
			};
			state.cats.set(c.id, cat);
			return cat;
		});
		state.groups.push({ id: USER_GROUP, title: "User markers", col: "var(--accent-soft)", user: true, cats: made });
	}
	state.groupOfCat = new Map();
	for (const g of state.groups) for (const c of g.cats) state.groupOfCat.set(c.id, g);

	const userLocs = [...(p?.userMarkers || []).filter((m: any) => m.map === here), ...temps].map((m: any) => {
		const cat = state.cats.get(m.cat);
		return {
			id: m.id,
			cat: m.cat,
			title: m.title || "",
			desc: m.desc || "",
			lat: m.lat,
			lng: m.lng,
			tags: [],
			media: [],
			icon: cat?.icon || iconName("#e5484d"),
			user: true,
			temp: !!m.temp,
			links: m.links || [],
		};
	});
	state.locs = [...state.officialLocs, ...userLocs];
	state.byId = new Map(state.locs.map((l: any) => [l.id, l]));
	state.outLinks = new Map();
	state.inLinks = new Map();
	buildLinkIndex();
	if (state.ui) buildSidebar();
}

// a change to the user's markers or categories: rebuild, save with the profile, redraw
export function userChanged(): void {
	rebuildUserData();
	scheduleSave();
	refreshAll();
}

// The side panel: the title, the counter and the map selector stay put at the top; everything under them (profile,
// difficulty, preset, search, the list) scrolls as one, so a small screen still has room for the list.
export function arrangeSidebar(): void {
	const head = document.querySelector("#side .side-head");
	if (!head || head.nextElementSibling?.classList.contains("side-scroll")) return;
	const scroll = document.createElement("div");
	scroll.className = "side-scroll";
	for (const el of [...head.children]) if (!el.matches(".title-row, .progress")) scroll.appendChild(el);
	for (const sel of [".list-tools", "#results-bar", "#results", "#groups"]) {
		const el = document.querySelector("#side " + sel);
		if (el) scroll.appendChild(el);
	}
	head.after(scroll);
}

export function setupTitleRow(): void {
	const row = document.querySelector("#side .title-row");
	if (!row || row.querySelector(".side-top-tools")) return;
	row.querySelector(".home-link")?.remove();

	const tools = document.createElement("div");
	tools.className = "side-top-tools";
	tools.innerHTML =
		`<div class="side-more" id="side-more">` +
		`<button id="side-more-btn" class="icon-btn side-more-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Menu" aria-label="Menu">` +
		DOTS_SVG +
		`</button>` +
		`<div id="side-more-menu" class="menu side-more-menu" hidden>` +
		`<a class="side-menu-link" href="../../">` +
		`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10.5 9-7.5 9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-4.5h-2v4.5A1.5 1.5 0 0 1 7.5 21h-5A1.5 1.5 0 0 1 1 19.5v-9z"/></svg>` +
		`<span>All maps</span>` +
		`</a>` +
		`<button id="side-offline-btn" class="side-menu-link side-offline-btn" type="button" aria-pressed="false">` +
		`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>` +
		`<span>Keep map offline</span>` +
		`</button>` +
		`<button id="side-regions-btn" class="side-menu-link side-regions-btn" type="button" aria-pressed="true" hidden>` +
		`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>` +
		`<span>Region borders</span>` +
		`</button>` +
		`<div id="side-tileset-section" class="side-menu-tileset" hidden>` +
		`<span class="side-menu-label">Layer / Tile Set</span>` +
		`<select id="side-tileset-select" class="side-tileset-select" aria-label="Tile Set"></select>` +
		`</div>` +
		`<hr>` +
		`<div class="side-menu-theme">` +
		`<span class="side-menu-label">Theme</span>` +
		`</div>` +
		`</div>` +
		`</div>` +
		`<button id="side-drawer-close" class="side-drawer-close" type="button" title="Close panel" aria-label="Close panel">` +
		`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>` +
		`</button>`;

	tools.querySelector(".side-menu-theme")?.appendChild(themeToggle("side-dropdown-theme"));
	row.appendChild(tools);

	const moreBtn = tools.querySelector<HTMLButtonElement>("#side-more-btn")!;
	const moreMenu = tools.querySelector<HTMLElement>("#side-more-menu")!;
	const closeBtn = tools.querySelector<HTMLButtonElement>("#side-drawer-close")!;
	const offlineBtn = tools.querySelector<HTMLButtonElement>("#side-offline-btn")!;

	moreBtn.onclick = (e) => {
		e.stopPropagation();
		const open = !moreMenu.hidden;
		moreMenu.hidden = open;
		moreBtn.setAttribute("aria-expanded", String(!open));
		if (!open) {
			renderTilesetMenu();
			updateSidebarRegionsBtn();
		}
	};
	closeBtn.onclick = () => document.body.classList.remove("side-open");
	offlineBtn.onclick = () => toggleCurrentMapOffline();

	const regionsBtn = tools.querySelector<HTMLButtonElement>("#side-regions-btn");
	if (regionsBtn) {
		const hasRegions = (state.regions || []).length > 0;
		regionsBtn.hidden = !hasRegions;
		regionsBtn.setAttribute("aria-pressed", String(state.showRegions));
		regionsBtn.onclick = () => {
			state.showRegions = !state.showRegions;
			regionsBtn.setAttribute("aria-pressed", String(state.showRegions));
			refreshRegions();
		};
	}

	const tilesetSection = tools.querySelector<HTMLElement>("#side-tileset-section");
	const tilesetSelect = tools.querySelector<HTMLSelectElement>("#side-tileset-select");
	if (tilesetSection && tilesetSelect) {
		renderTilesetMenu(tilesetSection, tilesetSelect);
	}
}

export function updateSidebarRegionsBtn(): void {
	if (typeof document === "undefined") return;
	const regionsBtn = document.querySelector<HTMLButtonElement>("#side-regions-btn");
	if (regionsBtn) {
		const hasRegions = (state.regions || []).length > 0;
		regionsBtn.hidden = !hasRegions;
		regionsBtn.setAttribute("aria-pressed", String(state.showRegions));
	}
}

export function renderTilesetMenu(
	section: HTMLElement | null = typeof document !== "undefined"
		? document.getElementById("side-tileset-section")
		: null,
	select: HTMLSelectElement | null = typeof document !== "undefined"
		? (document.getElementById("side-tileset-select") as HTMLSelectElement)
		: null,
): void {
	if (!section || !select) return;
	const sets = resolveTilesets(state.mapInfo, state.data);
	if (!sets || sets.length <= 1) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	select.innerHTML = sets.map((ts) => `<option value="${esc(ts.name)}">${esc(ts.name)}</option>`).join("");
	const cur = state.activeTileset || sets[0]?.name;
	select.value = cur;
	select.onchange = () => {
		switchTileset(select.value);
	};
}

export const DOTS_SVG =
	'<svg class="dots" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>';
const DL_SVG =
	'<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>';
const OK_SVG = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
let mapOfflineCtrl: AbortController | null = null;
let prepareTimer: ReturnType<typeof setTimeout> | null = null;

export interface ActiveDownloadState {
	started: boolean;
	completedBytes: number;
	currentDone: number;
	currentTotal: number;
	map: number;
	maps: number;
}
let activeDownload: ActiveDownloadState | null = null;

export function _setActiveDownloadForTest(st: ActiveDownloadState | null): void {
	activeDownload = st;
}

export function downloadDiscardSummary(): string | null {
	if (!activeDownload || !activeDownload.started) return null;
	const downloaded = activeDownload.completedBytes + activeDownload.currentDone;
	const formattedBytes = formatBytes(downloaded);
	if (activeDownload.maps > 1) {
		const pct =
			activeDownload.currentTotal > 0
				? Math.round((activeDownload.currentDone / activeDownload.currentTotal) * 100)
				: 0;
		return `${formattedBytes} (${pct}% of map ${activeDownload.map}/${activeDownload.maps})`;
	}
	if (activeDownload.currentTotal > 0) {
		const pct = Math.round((activeDownload.currentDone / activeDownload.currentTotal) * 100);
		return `${formattedBytes} of ${formatBytes(activeDownload.currentTotal)} (${pct}%)`;
	}
	return formattedBytes;
}

export async function confirmNavigationLoss(): Promise<boolean> {
	const summary = downloadDiscardSummary();
	if (!summary) return true;
	const ok = await askDialog({
		title: "Interrupt download?",
		message:
			"A download is in place and navigating away will interrupt it. If you try to redownload, " +
			`it will restart from scratch. Already downloaded: ${summary}, which will be discarded.`,
		okLabel: "Leave",
		danger: true,
	});
	if (ok) {
		if (mapOfflineCtrl) {
			mapOfflineCtrl.abort();
			mapOfflineCtrl = null;
		}
		activeDownload = null;
		return true;
	}
	return false;
}

const SPIN = '<span class="spinner" role="status" aria-hidden="true"></span>';

export function moreBtnProgressIcon(spinner: boolean, progress: number): string {
	const c = 62.83;
	const pct = Math.max(0, Math.min(100, progress));
	const offset = ((100 - pct) / 100) * c;
	const wheel = spinner
		? '<circle class="more-wheel-throbber" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="16 47"/>'
		: '<circle class="more-wheel-track" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2"/>' +
			`<circle class="more-wheel-progress" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 12 12)"/>`;
	return (
		'<svg class="more-dl-svg" viewBox="0 0 24 24" aria-hidden="true">' +
		wheel +
		'<path class="more-dl-arrow" d="M12 6.5v7.5m0 0-2.8-2.8m2.8 2.8 2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
		'<path class="more-dl-tray" d="M8.5 16.5h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
		"</svg>"
	);
}

function setMapOfflineButtons(mode: "off" | "on" | "busy", text?: string, spinner = false, progress = 0): void {
	const moreBtn = document.getElementById("side-more-btn") as HTMLButtonElement | null;
	if (moreBtn) {
		if (mode === "busy") {
			moreBtn.dataset.busy = "1";
			moreBtn.title = text || "Downloading…";
			moreBtn.setAttribute("aria-label", text || "Downloading…");
			moreBtn.innerHTML = moreBtnProgressIcon(spinner, progress);
		} else {
			delete moreBtn.dataset.busy;
			moreBtn.title = "Menu";
			moreBtn.setAttribute("aria-label", "Menu");
			moreBtn.innerHTML = DOTS_SVG;
		}
	}
	const btn = document.getElementById("side-offline-btn") as HTMLButtonElement | null;
	if (!btn) return;
	const many = (state.meta?.maps?.length ?? 1) > 1;
	btn.setAttribute("aria-pressed", String(mode === "on"));
	if (mode === "busy") {
		btn.dataset.busy = "1";
		btn.style.setProperty("--progress", `${Math.max(0, Math.min(100, progress))}%`);
	} else {
		delete btn.dataset.busy;
		btn.style.removeProperty("--progress");
	}
	btn.innerHTML =
		mode === "on"
			? `${OK_SVG}<span>Kept offline</span>`
			: mode === "busy"
				? `${spinner ? SPIN : DL_SVG}<span>${esc(text || "Preparing…")}</span>`
				: `${DL_SVG}<span>${many ? "Keep game offline" : "Keep map offline"}</span>`;
}

// the line on the button: waiting for the server to get a map ready, or the transfer of it
function offlineStatusText(s: OfflineStatus): { text: string; spinner: boolean; progress: number } {
	const of = s.maps > 1 ? ` ${s.map}/${s.maps}` : "";
	if (s.phase === "preparing") return { text: `Preparing map${of}…`, spinner: true, progress: 0 };
	const pct = s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0;
	return { text: s.maps > 1 ? `Downloading ${s.map}/${s.maps}` : "Downloading…", spinner: false, progress: pct };
}

export async function toggleCurrentMapOffline(): Promise<void> {
	const gameSlug = state.entry?.slug || state.entry?.id;
	if (!gameSlug) return;
	const gameTitle = state.entry?.title || state.meta?.title || gameSlug;

	if (mapOfflineCtrl) {
		if (prepareTimer) {
			clearTimeout(prepareTimer);
			prepareTimer = null;
		}
		activeDownload = null;
		mapOfflineCtrl.abort();
		mapOfflineCtrl = null;
		await removeOfflineGame(gameSlug);
		setMapOfflineButtons("off");
		toast(`Cancelled offline download for ${gameTitle}.`);
		return;
	}

	if (await gameKeptOffline(gameSlug)) {
		await removeOfflineGame(gameSlug);
		setMapOfflineButtons("off");
		toast(`Removed offline data for ${gameTitle}.`);
		return;
	}

	const ctrl = new AbortController();
	mapOfflineCtrl = ctrl;
	activeDownload = {
		started: false,
		completedBytes: 0,
		currentDone: 0,
		currentTotal: 0,
		map: 1,
		maps: state.meta?.maps?.length ?? 1,
	};
	setMapOfflineButtons("busy", "Preparing…", true);

	let notifiedPrepare = false;
	const startPrepareTimer = () => {
		if (notifiedPrepare || prepareTimer) return;
		prepareTimer = setTimeout(() => {
			prepareTimer = null;
			notifiedPrepare = true;
			toast(
				"The server is preparing the map pack to download. You can keep using the map, but do not " +
					"navigate away or close the tab.",
				8000,
			);
		}, 10000);
	};
	const clearPrepareTimer = () => {
		if (prepareTimer) {
			clearTimeout(prepareTimer);
			prepareTimer = null;
		}
	};

	startPrepareTimer();

	try {
		await downloadOfflineGame({
			gameSlug,
			gameTitle,
			signal: ctrl.signal,
			onStatus: (s) => {
				if (s.phase === "preparing") {
					startPrepareTimer();
				} else {
					clearPrepareTimer();
				}
				if (activeDownload) {
					if (s.phase === "downloading") {
						activeDownload.started = true;
						if (s.map > activeDownload.map) {
							activeDownload.completedBytes += activeDownload.currentTotal;
						}
						activeDownload.map = s.map;
						activeDownload.maps = s.maps;
						activeDownload.currentDone = s.done;
						activeDownload.currentTotal = s.total;
					} else if (s.phase === "preparing") {
						if (s.map > activeDownload.map) {
							activeDownload.completedBytes += activeDownload.currentTotal;
							activeDownload.currentDone = 0;
							activeDownload.currentTotal = 0;
						}
						activeDownload.map = s.map;
						activeDownload.maps = s.maps;
					}
				}
				const { text, spinner, progress } = offlineStatusText(s);
				setMapOfflineButtons("busy", text, spinner, progress);
			},
		});
		clearPrepareTimer();
		activeDownload = null;
		if (mapOfflineCtrl === ctrl) mapOfflineCtrl = null;
		setMapOfflineButtons("on");
		toast(`${gameTitle} is ready for offline use.`);
	} catch {
		clearPrepareTimer();
		activeDownload = null;
		if (mapOfflineCtrl === ctrl) mapOfflineCtrl = null;
		if (!ctrl.signal.aborted) {
			setMapOfflineButtons("off");
			toast(`Could not download ${gameTitle} for offline use.`);
		}
	}
}

// every map of the game is stored whole
async function gameKeptOffline(gameSlug: string): Promise<boolean> {
	const have = new Set((await getGameOfflineManifests(gameSlug)).map((m) => m.map));
	const maps: { slug: string }[] = state.meta?.maps || [];
	return maps.length > 0 && maps.every((m) => have.has(m.slug));
}

export async function syncMapOfflineState(): Promise<void> {
	const gameSlug = state.entry?.slug || state.entry?.id;
	if (!gameSlug || mapOfflineCtrl) return;
	try {
		setMapOfflineButtons((await gameKeptOffline(gameSlug)) ? "on" : "off");
	} catch {}
}

if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", (e) => {
		if (downloadDiscardSummary()) {
			e.preventDefault();
			e.returnValue = "";
		}
	});
}

if (typeof document !== "undefined") {
	document.addEventListener(
		"click",
		async (e) => {
			const target = e.target as HTMLElement | null;
			const a = target?.closest?.("a");
			if (!a || !a.href || a.target || a.hasAttribute("download")) return;
			try {
				const targetUrl = new URL(a.href, location.href);
				if (
					targetUrl.origin === location.origin &&
					targetUrl.pathname === location.pathname &&
					targetUrl.search === location.search
				) {
					return;
				}
			} catch {
				return;
			}
			if (!downloadDiscardSummary()) return;
			e.preventDefault();
			e.stopPropagation();
			const allow = await confirmNavigationLoss();
			if (allow) {
				location.href = a.href;
			}
		},
		true,
	);
}