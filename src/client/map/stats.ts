// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- progress & stats dialog: overview, per-map progress, current-map breakdown, exports ---------- */

import { esc } from "../../shared/escape.ts";
import { mapData, refreshAll, switchMap } from "./map-view.ts";
import { saveProfileNow, scheduleViewSave, syncTagStrict } from "./profiles.ts";
import { focusRegion, iconHtml, listCats, setRegionFilter, updateSidebar } from "./sidebar.ts";
import { fmt, state, toast, UNTAGGED, vivid } from "./state.ts";

export interface Tally {
	total: number;
	found: number;
}
export interface Row extends Tally {
	id: number;
	title: string;
}
export interface GroupRow extends Tally {
	id: number;
	title: string;
	color: string;
	cats: Row[];
}
export interface RegionRow extends Tally {
	id: number;
	title: string;
	subs: Row[];
}
export interface Breakdown {
	groups: GroupRow[];
	regions: RegionRow[];
	unassigned: Tally;
	tags: Row[];
	untagged: Tally;
}

const MILESTONES = [25, 50, 75, 100];
const CSV_HEADER = ["Map", "Group", "Category", "Region", "Title", "Found", "Tags", "Id"];

// markers the map shows: the same coordinate rule as prepareMap
const placed = (data: any): any[] =>
	(data?.locations || []).filter(
		(l: any) => Number.isFinite(parseFloat(l.latitude)) && Number.isFinite(parseFloat(l.longitude)),
	);

// counts the markers a map shows and how many of them are found
export function aggregate(data: any, found: ReadonlySet<number>): Tally {
	const locs = placed(data);
	return { total: locs.length, found: locs.filter((l: any) => found.has(l.id)).length };
}

// whole-number percentage, clamped to 100 (stale found ids can exceed the total)
export function percent(found: number, total: number): number {
	return total > 0 ? Math.min(100, Math.round((found / total) * 100)) : 0;
}

// groups in sidebar order, with their categories (a group lists categories by id, or by group_id)
export function groupsOf(data: any): { id: number; title: string; color: string; cats: any[] }[] {
	const cats = new Map<number, any>(Object.values<any>(data?.categories || {}).map((c: any) => [c.id, c]));
	return [...(data?.groups || [])]
		.sort((a: any, b: any) => a.order - b.order)
		.map((g: any) => {
			const ids: number[] = (g.categories || []).map((c: any) => c.id);
			const list = (
				ids.length ? ids.map((id) => cats.get(id)) : [...cats.values()].filter((c: any) => c.group_id === g.id)
			)
				.filter(Boolean)
				.sort((a: any, b: any) => a.order - b.order);
			return { id: g.id, title: g.title, color: g.color, cats: list };
		});
}

const tally = <K>(m: Map<K, Tally>, k: K): Tally => {
	let t = m.get(k);
	if (!t) m.set(k, (t = { total: 0, found: 0 }));
	return t;
};
const count = (t: Tally, hit: boolean): void => {
	t.total++;
	if (hit) t.found++;
};
const sum = (rows: Tally[]): Tally =>
	rows.reduce((a, r) => ({ total: a.total + r.total, found: a.found + r.found }), { total: 0, found: 0 });

// per-group, per-region (sub-regions roll up into their parent), and per-tag counts for one map
// tags overlap: a marker with two tags counts in both; "untagged" counts markers with no tag
export function breakdown(data: any, found: ReadonlySet<number>): Breakdown {
	const regs: any[] = data?.regions || [];
	const regionIds = new Set<number>(regs.map((r) => r.id));
	const catTally = new Map<number, Tally>();
	const regTally = new Map<number, Tally>();
	const tagTally = new Map<number, Tally>();
	const unassigned: Tally = { total: 0, found: 0 };
	const untagged: Tally = { total: 0, found: 0 };
	for (const l of placed(data)) {
		const hit = found.has(l.id);
		count(tally(catTally, l.category_id), hit);
		if (regionIds.has(l.region_id)) count(tally(regTally, l.region_id), hit);
		else count(unassigned, hit);
		if (!l.tags?.length) count(untagged, hit);
		for (const t of l.tags || []) count(tally(tagTally, t), hit);
	}

	const groups: GroupRow[] = [];
	for (const g of groupsOf(data)) {
		const cats: Row[] = g.cats
			.map((c: any) => ({ id: c.id, title: c.title || "", ...(catTally.get(c.id) ?? { total: 0, found: 0 }) }))
			.filter((r: Row) => r.total > 0);
		if (cats.length) groups.push({ id: g.id, title: g.title, color: g.color, ...sum(cats), cats });
	}

	const row = (r: any): Row => ({
		id: r.id,
		title: r.title || "",
		...(regTally.get(r.id) ?? { total: 0, found: 0 }),
	});
	const regions: RegionRow[] = [];
	for (const r of regs) {
		if (regionIds.has(r.parent_region_id)) continue; // a sub-region rolls up into its parent below
		const subs = regs
			.filter((s) => s.parent_region_id === r.id)
			.map(row)
			.filter((s) => s.total > 0);
		const own = row(r);
		const agg = sum([own, ...subs]);
		if (agg.total > 0) regions.push({ id: r.id, title: own.title, ...agg, subs });
	}

	const tagTitle = new Map<number, string>((data?.tags || []).map((t: any) => [t.id, t.title]));
	const tags: Row[] = [...tagTally]
		.map(([id, t]) => ({ id, title: tagTitle.get(id) || "", ...t }))
		.sort((a, b) => a.title.localeCompare(b.title));

	return { groups, regions, unassigned, tags, untagged };
}

// the top 3 started-but-unfinished categories (closest to done) and the top 3 by markers left
export function callouts(cats: Row[]): { closest: Row[]; gaps: Row[] } {
	const open = cats.filter((c) => c.found < c.total);
	return {
		closest: open
			.filter((c) => c.found > 0)
			.sort((a, b) => b.found / b.total - a.found / a.total)
			.slice(0, 3),
		gaps: [...open].sort((a, b) => b.total - b.found - (a.total - a.found)).slice(0, 3),
	};
}

// found ids that no known marker has
export function staleIds(found: Iterable<number>, known: ReadonlySet<number>): number[] {
	return [...found].filter((id) => !known.has(id));
}

// quotes fields with commas, quotes or line breaks; neutralises leading = + - @ so spreadsheets do not run them
export function csvCell(v: unknown): string {
	let s = String(v ?? "");
	if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
	return "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function csvRows(data: any, found: ReadonlySet<number>, mapTitle: string): unknown[][] {
	const group = new Map<number, string>();
	for (const g of groupsOf(data)) for (const c of g.cats) group.set(c.id, g.title);
	const cats = new Map<number, any>(Object.values<any>(data?.categories || {}).map((c: any) => [c.id, c]));
	const regions = new Map<number, any>((data?.regions || []).map((r: any) => [r.id, r]));
	const tags = new Map<number, string>((data?.tags || []).map((t: any) => [t.id, t.title]));
	return placed(data).map((l: any) => [
		mapTitle,
		group.get(l.category_id) || "",
		cats.get(l.category_id)?.title || "",
		regions.get(l.region_id)?.title || "",
		l.title || "",
		found.has(l.id) ? "yes" : "no",
		(l.tags || []).map((t: number) => tags.get(t) || t).join("; "),
		l.id,
	]);
}

// plain-text summary for the clipboard; tally undefined = not loaded, null = not available offline
export function summaryText(
	game: string,
	total: number,
	found: number,
	maps: { title: string; tally?: Tally | null }[],
): string {
	const head = total
		? `${game}: ${fmt(found)} of ${fmt(total)} markers found (${percent(found, total)}%)`
		: `${game}: ${fmt(found)} markers found`;
	const lines = maps.map((m) => {
		if (m.tally === undefined) return `${m.title}: not loaded`;
		if (m.tally === null) return `${m.title}: not available offline`;
		return `${m.title}: ${fmt(m.tally.found)} of ${fmt(m.tally.total)} (${percent(m.tally.found, m.tally.total)}%)`;
	});
	return [head, ...lines].join("\n");
}

let gen = 0; // bumped on every open and close; a stale loader checks it and stops

const bar = (pct: number, label: string): string =>
	`<span class="sd-bar" role="img" aria-label="${esc(label)}"><span class="sd-fill" style="width:${pct}%"></span></span>`;
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`;

// a button row with a found/total count and a bar; title is plain text, escaped here
const tallyBtn = (attrs: string, title: string, t: Tally, lead = ""): string => {
	const count = `${fmt(t.found)} / ${fmt(t.total)}`;
	return (
		`<button type="button" class="sd-row" ${attrs}><span class="sd-row-top">` +
		`<span class="sd-row-title">${lead}${esc(title)}</span><span class="sd-row-count">${count}</span></span>` +
		bar(percent(t.found, t.total), `${title}: ${count}`) +
		`</button>`
	);
};

function rowsHtml(maps: any[], results: Map<string, Tally | null>, current: string): string {
	return maps
		.map((m) => {
			const r = results.get(m.slug);
			const isCur = m.slug === current;
			let count = "not loaded";
			let pct = 0;
			if (r === null) count = "not available offline";
			else if (r) {
				pct = percent(r.found, r.total);
				count = `${fmt(r.found)} / ${fmt(r.total)}`;
			}
			return (
				`<li><button type="button" class="sd-row" data-slug="${esc(m.slug)}"${isCur ? ' aria-current="true"' : ""}>` +
				`<span class="sd-row-top"><span class="sd-row-title">${esc(m.title)}${isCur ? " <em>(current)</em>" : ""}</span>` +
				`<span class="sd-row-count">${count}</span></span>` +
				bar(pct, `${m.title}: ${count}`) +
				`</button></li>`
			);
		})
		.join("");
}

export function openStats(): void {
	const d = document.getElementById("dlg") as HTMLDialogElement;
	const form = document.getElementById("dlg-form") as HTMLFormElement;
	const me = ++gen;
	const returnFocus = document.activeElement as HTMLElement | null;
	const maps: any[] = state.meta?.maps || [];
	const current: string = state.mapInfo?.slug;
	const cur = maps.find((m) => m.slug === current);
	const multi = maps.length > 1;
	const indexTotal = Number(state.entry?.stats?.find((s: any) => s.label === "markers")?.value) || 0;
	const results = new Map<string, Tally | null>();
	const raw = new Map<string, any>();
	let here: Breakdown | null = null;
	let hereFailed = false;
	let loading = false;
	let armed = false; // stale cleanup needs a second click

	const allLoaded = (): boolean => maps.length > 0 && maps.every((m) => results.get(m.slug));
	const gameTotal = (): number =>
		allLoaded() ? maps.reduce((s, m) => s + results.get(m.slug)!.total, 0) : indexTotal;
	const knownIds = (): Set<number> => {
		const k = new Set<number>();
		for (const data of raw.values()) for (const l of data?.locations || []) k.add(l.id);
		for (const m of state.profile?.userMarkers || []) k.add(m.id);
		return k;
	};

	const chips = (pct: number) =>
		MILESTONES.map((m) => `<span class="sd-chip${pct >= m ? " on" : ""}" title="${m}%">${m}%</span>`).join("");

	d.classList.add("stats-dlg");
	form.innerHTML =
		`<h2>Progress &amp; stats</h2>` +
		`<p class="sd-scope">${esc(state.profile?.name || "")}. Game totals ignore the current filters and hidden categories.</p>` +
		`<div data-slot="head"></div>` +
		`<div data-slot="here"></div>` +
		`<section data-slot="maps" class="sd-maps" aria-label="Progress per map"${multi ? "" : " hidden"}>` +
		`<div class="sd-maps-head"><span class="sd-label">Maps</span>` +
		`<button type="button" class="sd-load" data-load>Load all maps</button></div>` +
		`<p class="sd-status" data-status aria-live="polite"></p><ul class="sd-rows"></ul></section>` +
		`<div data-slot="stale"></div>` +
		`<div data-slot="add"></div>` +
		`<div class="dlg-actions sd-actions">` +
		`<button type="button" data-copy>Copy summary</button>` +
		`<button type="button" data-export="here">Export this map</button>` +
		`<button type="button" data-export="all" disabled>Export all maps</button>` +
		`<button type="button" data-close>Close</button></div>`;

	const slot = (n: string) => form.querySelector<HTMLElement>(`[data-slot="${n}"]`)!;
	const status = form.querySelector<HTMLElement>("[data-status]");
	const loadBtn = form.querySelector<HTMLButtonElement>("[data-load]")!;
	const exportAll = form.querySelector<HTMLButtonElement>('[data-export="all"]')!;
	const list = form.querySelector<HTMLElement>(".sd-rows")!;

	const renderHead = () => {
		const total = gameTotal();
		const found = state.found.size;
		const pct = percent(found, total);
		slot("head").innerHTML =
			`<div class="sd-head"><div class="sd-big">${pct}%</div>` +
			`<div class="sd-line">${total ? `${fmt(found)} of ${fmt(total)} markers found · ${fmt(Math.max(0, total - found))} to go` : "No marker total for this game"}</div>` +
			bar(pct, `${pct}% of markers found`) +
			`<div class="sd-chips">${chips(pct)}</div>` +
			`<p class="sd-status">${allLoaded() ? "Total from all maps" : "Total from the game index"}</p></div>`;
	};

	const renderHere = () => {
		const el = slot("here");
		if (!here) {
			el.innerHTML = `<p class="sd-status">${hereFailed ? "This map's markers are not available offline." : "Loading this map…"}</p>`;
			return;
		}
		const b = here;
		const co = callouts(b.groups.flatMap((g) => g.cats));
		const callRow = (c: Row) => `<li>${tallyBtn(`data-cat="${c.id}"`, c.title, c)}</li>`;
		const callBlock =
			co.closest.length || co.gaps.length
				? `<div class="sd-callouts">` +
					(co.closest.length
						? `<div><span class="sd-label">Closest to done</span><ul class="sd-rows">${co.closest.map(callRow).join("")}</ul></div>`
						: "") +
					(co.gaps.length
						? `<div><span class="sd-label">Biggest gaps</span><ul class="sd-rows">${co.gaps.map(callRow).join("")}</ul></div>`
						: "") +
					`</div>`
				: "";
		const regionBlock =
			(state.regions || []).length && (b.regions.length || b.unassigned.total)
				? `<h3 class="sd-sub-h">Regions</h3><ul class="sd-rows">` +
					b.regions
						.map(
							(r) =>
								`<li>${tallyBtn(`data-region="${r.id}"`, r.title, r)}</li>` +
								r.subs
									.map(
										(s) =>
											`<li class="sd-sub">${tallyBtn(`data-region="${s.id}"`, s.title, s)}</li>`,
									)
									.join(""),
						)
						.join("") +
					(b.unassigned.total
						? `<li class="sd-note">Unassigned: ${fmt(b.unassigned.found)} / ${fmt(b.unassigned.total)}</li>`
						: "") +
					`</ul>`
				: "";
		const tagBlock = b.tags.length
			? `<h3 class="sd-sub-h">Tags</h3><ul class="sd-rows">` +
				b.tags.map((t) => `<li>${tallyBtn(`data-tag="${t.id}"`, t.title, t)}</li>`).join("") +
				(b.untagged.total
					? `<li>${tallyBtn(`data-tag="${UNTAGGED}"`, "Only untagged", b.untagged)}</li>`
					: "") +
				`</ul>`
			: "";
		const groupBlock = b.groups
			.map((g) => {
				const col = vivid(g.color);
				return (
					`<details class="sd-group"><summary><span class="sd-dot" style="--c:${esc(col)}"></span>` +
					`${esc(g.title)} <span class="sd-row-count">${fmt(g.found)} / ${fmt(g.total)}</span></summary>` +
					bar(percent(g.found, g.total), `${g.title}: ${fmt(g.found)} of ${fmt(g.total)}`) +
					`<button type="button" class="sd-load" data-group="${g.id}">List all in group</button>` +
					`<ul class="sd-rows">` +
					g.cats
						.map(
							(c) =>
								`<li>${tallyBtn(`data-cat="${c.id}"`, c.title, c, iconHtml(state.cats?.get(c.id)?.icon, col))}</li>`,
						)
						.join("") +
					`</ul></details>`
				);
			})
			.join("");
		el.innerHTML =
			`<h3 class="sd-sub-h">${esc(state.mapInfo?.title || "This map")}</h3>` +
			callBlock +
			regionBlock +
			tagBlock +
			(groupBlock ? `<h3 class="sd-sub-h">Categories</h3>${groupBlock}` : "");
	};

	const renderMaps = () => {
		if (multi) list.innerHTML = rowsHtml(maps, results, current);
		loadBtn.disabled = loading || allLoaded();
	};

	const renderStale = () => {
		const el = slot("stale");
		if (!allLoaded()) {
			el.innerHTML = "";
			return;
		}
		const ids = staleIds(state.found, knownIds());
		if (!ids.length) {
			el.innerHTML = `<p class="sd-status">No stale found ids.</p>`;
			return;
		}
		el.innerHTML =
			`<div class="sd-stale"><p>${plural(ids.length, "found id matches", "found ids match")} no marker in any map. ` +
			`They can push progress past 100%.</p>` +
			`<button type="button" class="danger" data-clean>${armed ? `Confirm: remove ${fmt(ids.length)}` : `Remove ${fmt(ids.length)} stale`}</button></div>`;
	};

	const renderAdd = () => {
		const here = state.mapInfo?.slug;
		const p = state.profile || {};
		const m = (p.userMarkers || []).filter((x: any) => x.map === here).length;
		const dr = (p.drawings || []).filter((x: any) => x.map === here).length;
		const cats = (p.userCats || []).length;
		slot("add").innerHTML =
			`<p class="sd-add">On this map: ${plural(m, "custom marker", "custom markers")}, ${plural(dr, "drawing", "drawings")}. ` +
			`For this game: ${plural(cats, "custom category", "custom categories")}, ${plural(state.presets?.length || 0, "preset", "presets")}.</p>`;
	};

	const renderAll = () => {
		renderHead();
		renderMaps();
		renderStale();
		exportAll.disabled = !allLoaded();
	};

	const loadOne = async (m: any): Promise<void> => {
		try {
			const data = await mapData(m);
			raw.set(m.slug, data);
			results.set(m.slug, aggregate(data, state.found));
		} catch {
			results.set(m.slug, null);
		}
	};
	const loadMaps = async (todo: any[]): Promise<void> => {
		loading = true;
		loadBtn.disabled = true;
		for (const m of todo) {
			if (me !== gen) return;
			if (status) status.textContent = `Loading ${results.size + 1}/${maps.length}`;
			await loadOne(m);
			if (me !== gen) return;
			renderAll();
		}
		loading = false;
		if (me !== gen || !status) return;
		const failed = [...results.values()].filter((r) => r === null).length;
		status.textContent = failed ? `${failed} map(s) not available offline` : `All ${maps.length} maps loaded`;
		renderAll();
	};

	const setTag = (v: number | string | null) => {
		state.tag = v;
		const sel = document.getElementById("tag-select") as HTMLSelectElement | null;
		if (sel) sel.value = v == null ? "" : String(v);
		syncTagStrict();
		scheduleViewSave();
		refreshAll();
	};
	const listIds = (ids: number[]) => {
		setTag(null);
		setRegionFilter(null);
		listCats(ids.map((id) => state.cats.get(id)).filter(Boolean));
		d.close();
	};

	const download = (name: string, text: string) => {
		const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	const exportCsv = (all: boolean) => {
		const list = all ? maps : maps.filter((m) => m.slug === current);
		if (!raw.has(current)) return toast("This map's markers are not available offline");
		const rows = list.flatMap((m) => csvRows(raw.get(m.slug), state.found, m.title));
		download(`${state.entry?.slug || "game"}-${all ? "all-maps" : current}.csv`, toCsv([CSV_HEADER, ...rows]));
	};

	const copySummary = async () => {
		const text = summaryText(
			state.entry?.title || "Game",
			gameTotal(),
			state.found.size,
			maps.map((m) => ({ title: m.title, tally: results.get(m.slug) })),
		);
		try {
			await navigator.clipboard.writeText(text);
			toast("Summary copied");
		} catch {
			toast("Could not copy: clipboard unavailable");
		}
	};

	const cleanStale = () => {
		const ids = staleIds(state.found, knownIds());
		if (!armed) {
			armed = true;
			renderStale();
			return;
		}
		armed = false;
		for (const id of ids) state.found.delete(id);
		void saveProfileNow();
		updateSidebar();
		refreshAll();
		renderAll();
		renderHere();
		renderAdd();
		toast(`Removed ${fmt(ids.length)} stale id(s)`);
	};

	form.onsubmit = (e) => e.preventDefault();
	form.onclick = (e) => {
		const t = (e.target as HTMLElement).closest<HTMLElement>("button");
		if (!t) return;
		const ds = t.dataset;
		if (t.hasAttribute("data-close")) return d.close();
		if (t.hasAttribute("data-load")) return void loadMaps(maps.filter((m) => !results.has(m.slug)));
		if (t.hasAttribute("data-copy")) return void copySummary();
		if (t.hasAttribute("data-clean")) return cleanStale();
		if (t.hasAttribute("data-export")) return exportCsv(ds.export === "all");
		if (ds.slug !== undefined) {
			d.close();
			if (ds.slug !== current) void switchMap(ds.slug);
			return;
		}
		if (ds.cat !== undefined) return listIds([Number(ds.cat)]);
		if (ds.group !== undefined) {
			const g = here?.groups.find((x) => x.id === Number(ds.group));
			return listIds(g ? g.cats.map((c) => c.id) : []);
		}
		if (ds.region !== undefined) {
			const id = Number(ds.region);
			setTag(null);
			setRegionFilter(id);
			const r = state.regionById?.get(id);
			if (r) focusRegion(r);
			return d.close();
		}
		if (ds.tag !== undefined) {
			setTag(ds.tag === UNTAGGED ? UNTAGGED : Number(ds.tag));
			return d.close();
		}
	};
	d.onclose = () => {
		gen++; // stops any loader still running
		d.classList.remove("stats-dlg");
		returnFocus?.focus?.();
	};

	renderHead();
	renderHere();
	renderMaps();
	renderStale();
	renderAdd();
	d.showModal();

	// the current map is cached by the viewer, so this is quick; it fills the breakdown and its row
	if (cur) {
		void loadOne(cur).then(() => {
			if (me !== gen) return;
			here = raw.has(current) ? breakdown(raw.get(current), state.found) : null;
			hereFailed = !raw.has(current);
			renderHere();
			renderAll();
		});
	}
}