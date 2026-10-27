// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

/* ---------- detail panel, navigation stack, links, and context menu ---------- */

import { esc } from "../../shared/escape.ts";
import { packMarker } from "../../shared/share-link.ts";
import { svgIcon } from "../icons.ts";
import { refreshMap } from "./map-view.ts";
import { internalRefs, renderMd } from "./markdown.ts";
import { scheduleSave } from "./profiles.ts";
import { endPreview, syncSearchActive } from "./search.ts";
import { applicable, onViewChanged, updateSidebar } from "./sidebar.ts";
import { $, askDialog, emptyFC, iconScale, isMobile, state, toast, uid, UNTAGGED } from "./state.ts";

/* ---------- navigation stack ----------
   The trail is the markers opened so far, the last one being the current one. Each push also adds a history
   entry ({ session, depth, loc }), so the device back button walks the trail. Closing the card starts a new
   session: old entries are then skipped over, so they can no longer walk back into the closed trail. */

export function stackPush(id: number): void {
	if (state.trail[state.trail.length - 1] === id) return;
	state.trail.push(id);
	history.pushState({ session: state.session, depth: state.trail.length, loc: id }, "", "#loc=" + id);
}

export function goBack(): void {
	if (state.trail.length > 1) history.back(); // the popstate handler does the actual step
}

export function onPopState(ev: PopStateEvent): void {
	const s = ev.state;
	if (!s || !s.session) return dismiss(); // the page entry below the stack
	if (s.session !== state.session) {
		// an entry from a stack that was closed: jump to the page entry under that stack
		if (s.depth > 0) history.go(-s.depth);
		return;
	}
	state.trail.length = Math.min(state.trail.length, s.depth - 1);
	state.trail.splice(s.depth - 1, 1, s.loc);
	select(s.loc, { fly: true, push: false });
}

// Markers that the description links to, and the markers that link to this one.
export function buildLinkIndex(): void {
	for (const l of state.locs) {
		const out = internalRefs(l.desc, l.id);
		for (const t of l.links || []) if (t !== l.id && state.byId.has(t) && !out.includes(t)) out.push(t); // user links
		state.outLinks.set(l.id, out);
		for (const t of out) {
			if (!state.inLinks.has(t)) state.inLinks.set(t, []);
			state.inLinks.get(t)!.push(l.id);
		}
	}
}

export function linkedLocations(l: { id: number }): any[] {
	return (state.outLinks.get(l.id) || []).map((id: number) => state.byId.get(id)).filter(Boolean);
}

// Locations that link to this one but are not linked back: a two-way link is already shown as a forward link.
export function referrersOneWay(l: { id: number }): any[] {
	const out = new Set(state.outLinks.get(l.id));
	return (state.inLinks.get(l.id) || [])
		.filter((id: number) => !out.has(id))
		.map((id: number) => state.byId.get(id))
		.filter(Boolean)
		.sort((a: any, b: any) => a.title.localeCompare(b.title));
}

export function select(id: number, { fly = true, push = true, closeSide = true } = {}): void {
	const l = state.byId.get(id);
	if (!l) return;
	if (push) stackPush(id);
	state.selected = id;
	refreshMap(); // the card's marker and its links are drawn whatever the filters say
	if (applicable(l) && state.view.hidden.has(l.cat)) {
		// showing the category is a change of the view like any other: the selected preset then shows as modified
		state.view.hidden.delete(l.cat);
		onViewChanged();
	}
	if (state.mapReady) {
		state.map.getSource("sel").setData({
			type: "FeatureCollection",
			features: [{ type: "Feature", geometry: { type: "Point", coordinates: [l.lng, l.lat] }, properties: {} }],
		});
		if (fly) {
			const padding = isMobile() ? { bottom: Math.round(innerHeight * 0.4) } : { right: 384 };
			state.map.flyTo({
				center: [l.lng, l.lat],
				zoom: Math.max(state.map.getZoom(), 13.5),
				padding,
				speed: 1.5,
				essential: true,
			});
		}
	}
	if (closeSide) document.body.classList.remove("side-open");
	renderDetail();
	syncSearchActive(id, state.mapInfo?.slug);
}

export function updateLinks(): void {
	if (!state.mapReady) return;
	const from = state.selected != null ? state.byId.get(state.selected) : null;
	const targets = from ? linkedLocations(from) : [];
	const refs = from ? referrersOneWay(from) : [];
	state.links = { from, targets, refs };
	const line = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) => ({
		type: "Feature",
		geometry: {
			type: "LineString",
			coordinates: [
				[a.lng, a.lat],
				[b.lng, b.lat],
			],
		},
		properties: {},
	});
	state.map
		.getSource("links")
		.setData({ type: "FeatureCollection", features: from ? targets.map((t) => line(from, t)) : [] });
	state.map
		.getSource("backlinks")
		.setData({ type: "FeatureCollection", features: from ? refs.map((r) => line(r, from)) : [] });
	updateLinkHeads();
}

// Arrowheads are placed in screen space so they stay right after panning and zooming.
// Each pair is [from, to]; the head sits just before "to", pointing at it.
export function arrowHeads(pairs: [{ lng: number; lat: number }, { lng: number; lat: number }][]): {
	type: "FeatureCollection";
	features: any[];
} {
	const feats: any[] = [];
	for (const [from, to] of pairs) {
		const a = state.map.project([from.lng, from.lat]);
		const b = state.map.project([to.lng, to.lat]);
		const dx = b.x - a.x,
			dy = b.y - a.y,
			len = Math.hypot(dx, dy);
		if (len < 1) continue;
		const back = Math.min(28, len * 0.5);
		const p = state.map.unproject([b.x - (dx / len) * back, b.y - (dy / len) * back]);
		feats.push({
			type: "Feature",
			geometry: { type: "Point", coordinates: [p.lng, p.lat] },
			properties: { rot: (Math.atan2(dx, -dy) * 180) / Math.PI },
		});
	}
	return { type: "FeatureCollection", features: feats };
}

export function updateLinkHeads(): void {
	if (!state.mapReady || !state.links) return;
	const { from, targets, refs } = state.links;
	state.map.getSource("link-heads").setData(arrowHeads(from ? targets.map((t: any) => [from, t]) : []));
	state.map.getSource("backlink-heads").setData(arrowHeads(from ? refs.map((r: any) => [r, from]) : []));
}

interface DetailElement extends HTMLElement {
	outTimer?: ReturnType<typeof setTimeout>;
}

export interface DetailBodyElement extends HTMLElement {
	hoverLink?: HTMLElement | null;
	pendingLink?: HTMLElement | null;
	hoverTimer?: ReturnType<typeof setTimeout>;
}

// the card leaves with the same panel motion in reverse (style.css #detail.leaving), then is hidden
const DETAIL_OUT_MS = 200;
export function hideDetail(): void {
	const d = $<DetailElement>("#detail");
	if (!d) return;
	clearTimeout(d.outTimer);
	if (d.hidden) return;
	if (d.classList.contains("leaving")) return; // already on its way out
	endPreview(); // a link hovered in the card: the view goes back, as the card leaves
	// a closed card stops its video: an embed unloads (and stops its sound) once its frame is on about:blank
	d.querySelectorAll("iframe").forEach((f) => {
		f.src = "about:blank";
	});
	d.classList.add("leaving");
	d.outTimer = setTimeout(() => {
		d.hidden = true;
		d.classList.remove("leaving");
	}, DETAIL_OUT_MS);
}

// Closes the card and clears the navigation stack. History entries are left alone here (see closeDetail).
export function dismiss(): void {
	state.trail = [];
	state.session = uid();
	state.selected = null;
	refreshMap(); // its links are no longer pinned
	hideDetail();
	document.body.classList.remove("detail-open");
	if (state.mapReady) state.map.getSource("sel").setData(emptyFC);
	updateLinks();
	syncSearchActive(null);
}

export function closeDetail(): void {
	dismiss();
	if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

// the last place the pointer was (for a card that renders under it)
let lastPointer: { x: number; y: number } | null = null;
export function setLastPointer(pt: { x: number; y: number }): void {
	lastPointer = pt;
}

// A card that renders under a stationary pointer gets pointerover on the link there, which is not a hover: that link
// is ignored until the pointer has left it and come back.
export function armCardLinks(): void {
	const body = $<DetailBodyElement>("#detail-body");
	if (!body) return;
	body.hoverLink = null;
	const under = lastPointer ? document.elementFromPoint(lastPointer.x, lastPointer.y) : null;
	body.pendingLink =
		under?.closest?.("a[data-loc]") && body.contains(under) ? under.closest<HTMLElement>("a[data-loc]") : null;
}

export function renderDetail(): void {
	const l = state.byId.get(state.selected);
	if (!l) return closeDetail();
	const cat = state.cats.get(l.cat),
		g = state.groupOfCat.get(l.cat);
	const ok = applicable(l),
		isFound = state.found.has(l.id);
	const refs = referrersOneWay(l);

	let only = "";
	if (l.tags.length && l.tags.length < state.tags.length) {
		const names = l.tags.map((id: number) => state.tags.find((t: any) => t.id === id)?.title).filter(Boolean);
		only = `<p class="d-note">Only on ${esc(names.join(", "))}.</p>`;
	}
	const notHere = !ok
		? `<p class="d-note">This marker is not shown on ${esc(state.tag === UNTAGGED ? "Only untagged" : state.tags.find((t: any) => t.id === state.tag)?.title || "this setting")}.</p>`
		: "";
	const shots = l.media.map((m: any) => mediaHtml(m, l)).join("");

	const backrefs = refs.length
		? `<div class="d-backrefs"><h3>Referenced by</h3><ul>${refs.map((r) => `<li><a href="#loc=${r.id}" data-loc="${r.id}">${esc(r.title)}</a></li>`).join("")}</ul></div>`
		: "";

	const body = $<DetailBodyElement>("#detail-body")!;
	body.innerHTML =
		`<div class="d-cat" style="--c:${l.user && cat?.icon ? "#" + cat.icon.slice(3).replace("-t", "") : g ? g.col : "#888"}"><i></i>${esc(cat?.title || "")}</div>` +
		`<h2 class="d-title">${esc(l.title)}</h2>` +
		(l.user ? state.um.detailHtml(l) : "") +
		`<div class="d-actions">${ok ? `<button class="found-btn${isFound ? " on" : ""}" type="button" aria-pressed="${isFound}">${isFound ? "Found. Tap to undo" : "Mark as found"}</button>` : ""}` +
		'<button class="share-btn" type="button" aria-label="Share this marker" title="Share"><svg viewBox="0 0 24 24" aria-hidden="true"><g class="glyph"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.4 10.8l7.2-4.4M8.4 13.2l7.2 4.4"/></g><path class="tick" d="M5 12.5l4.5 4.5L19 7.5"/></svg></button></div>' +
		`<div class="d-desc">${renderMd(l.desc)}</div>` +
		only +
		notHere +
		(shots ? `<div class="shots">${shots}</div>` : "") +
		backrefs;

	const backBtn = $("#detail-back");
	if (backBtn) backBtn.hidden = state.trail.length < 2;
	const detail = $<DetailElement>("#detail")!;
	clearTimeout(detail.outTimer); // a card closing as this one opens is cancelled
	detail.classList.remove("leaving");
	detail.hidden = false;
	detail.classList.toggle("user-loc", !!l.user);
	// a user marker's card takes its category colour as the accent
	if (l.user && cat?.icon) detail.style.setProperty("--c", "#" + cat.icon.slice(3).replace("-t", ""));
	else detail.style.removeProperty("--c");
	document.body.classList.add("detail-open");
	body.querySelectorAll<HTMLImageElement>(".shots img").forEach((img) =>
		img.addEventListener("error", () => {
			img.replaceWith(
				Object.assign(document.createElement("p"), {
					className: "d-note",
					textContent: "Screenshot not downloaded.",
				}),
			);
		}),
	);
	armCardLinks();
	updateLinks();
}

// one piece of a marker's media on its card. YouTube videos are embedded (nothing is downloaded for them); a picture is
// the copy add-game.mjs saved; anything else (a video page elsewhere) is a link to it.
const YOUTUBE = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/;
export function mediaHtml(m: any, l: { title: string }): string {
	const alt = esc(m.title || l.title);
	const yt =
		YOUTUBE.exec(m.url || "") ||
		(m.type === "youtube" && /^[\w-]{11}$/.test(m.file_name || "") ? [null, m.file_name] : null);
	if (yt) {
		return (
			`<div class="shot-video"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="${alt}" loading="lazy" ` +
			`allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`
		);
	}
	if (!m.url) return "";
	const isImage = m.type === "image" || (m.mime_type || "").startsWith("image/");
	if (!isImage)
		return `<p class="d-note"><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.title || "Video")}</a></p>`;
	const file = decodeURIComponent(new URL(m.url).pathname.split("/").pop()!);
	return `<img loading="lazy" src="${esc(state.folder + "/media/" + file)}" alt="${alt}">`;
}

/* ---------- right-click on the map: what is here ----------
   On an empty spot: add a marker there (either kind), or share the spot. On a marker: found or not found, share;
   a user marker also has its own actions (the card's buttons). Pan and marker tools only; press and hold on touch. */
interface CtxMenuItem {
	sep?: boolean;
	icon?: string;
	label?: string;
	danger?: boolean;
	fn?: () => void;
}

let ctxMenu: HTMLDivElement | null = null;
let ctxItems: CtxMenuItem[] = [];
let ctxOpenedAt = 0;

function ctxEl(): HTMLDivElement {
	if (!ctxMenu) {
		ctxMenu = document.createElement("div");
		ctxMenu.id = "ctx-menu";
		ctxMenu.className = "menu row-menu ctx";
		ctxMenu.hidden = true;
		ctxMenu.setAttribute("role", "menu");
		ctxMenu.onclick = (e) => {
			const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
			if (!b) return;
			const it = ctxItems[+b.dataset.i!];
			closeCtx();
			it?.fn?.();
		};
		document.body.appendChild(ctxMenu);
	}
	return ctxMenu;
}

export function closeCtx(): void {
	if (ctxMenu) ctxMenu.hidden = true;
	ctxItems = [];
}

export function closeCtxIfOutside(e: MouseEvent): void {
	if (!(e.target as HTMLElement).closest("#ctx-menu") && Date.now() - ctxOpenedAt > 350) closeCtx(); // a touch's click can follow its press
}

function openCtx(x: number, y: number, { title = "", items }: { title?: string; items: CtxMenuItem[] }): void {
	const el = ctxEl();
	ctxItems = items;
	el.innerHTML =
		(title
			? `<div class="rm-head"><div class="rm-text"><div class="rm-title">${esc(title)}</div></div></div><hr>`
			: "") +
		items
			.map((it, i) =>
				it.sep
					? "<hr>"
					: `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ""}>${svgIcon(it.icon!)}<span>${esc(it.label)}</span></button>`,
			)
			.join("");
	el.hidden = false;
	const w = el.offsetWidth,
		h = el.offsetHeight,
		pad = 8;
	let lx = x + 4;
	if (lx + w > innerWidth - pad) lx = x - w - 4;
	el.style.left = Math.max(pad, Math.min(lx, innerWidth - w - pad)) + "px";
	el.style.top = Math.max(pad, Math.min(y, innerHeight - h - pad)) + "px";
	ctxOpenedAt = Date.now();
}

export function setFound(id: number, on: boolean): void {
	if (on) state.found.add(id);
	else state.found.delete(id);
	scheduleSave();
	updateSidebar();
	refreshMap();
	if (state.selected === id) renderDetail();
}

export async function shareLocation(pos: { lat: number; lng: number }): Promise<void> {
	const packed = await packMarker({ title: "Shared location", lat: pos.lat, lng: pos.lng, map: state.mapInfo.slug });
	const url = new URL(location.href);
	url.hash = "";
	url.search = new URLSearchParams({ tm: packed, map: state.mapInfo.slug }).toString();
	await deliverLink(url.href, null);
}

function spotMenu(ll: { lat: number; lng: number }, x: number, y: number): void {
	const pos = { lat: ll.lat, lng: ll.lng };
	openCtx(x, y, {
		items: [
			{ icon: "pin", label: "Add marker here", fn: () => state.um.placeAt(pos, false) },
			{ icon: "tempPin", label: "Add temporary marker here", fn: () => state.um.placeAt(pos, true) },
			{ sep: true },
			{ icon: "share", label: "Share this location", fn: () => shareLocation(pos) },
		],
	});
}

function markerMenu(l: any, x: number, y: number): void {
	const found = state.found.has(l.id);
	const items: CtxMenuItem[] = [
		{
			icon: found ? "open" : "check",
			label: found ? "Mark as not found" : "Mark as found",
			fn: () => setFound(l.id, !found),
		},
		{ icon: "share", label: "Share", fn: () => shareMarker(l.id, null) },
		{ icon: "card", label: "Open card", fn: () => select(l.id, { fly: false }) },
	];
	if (l.user) {
		items.push({ sep: true });
		if (l.temp)
			items.push({ icon: "save", label: "Make permanent", fn: () => state.um.detailAction("promote", l.id) });
		items.push({ icon: "pencil", label: "Edit", fn: () => state.um.detailAction("edit", l.id) });
		items.push({ icon: "move", label: "Move", fn: () => state.um.detailAction("move", l.id) });
		items.push({ icon: "trash", label: "Delete", danger: true, fn: () => state.um.detailAction("delete", l.id) });
	}
	openCtx(x, y, { title: l.title, items });
}

// the marker a point is on: the query covers a wide area around the icons (more on touch), so a point counts only
// when it is on the drawn icon, close to its centre
function markerAt(pt: { x: number; y: number }): any {
	const k = iconScale(state.map.getZoom());
	let best: any = null,
		bestD = Infinity;
	for (const f of state.map.queryRenderedFeatures(pt, { layers: ["locs", "locs-circles"] })) {
		const l = state.byId.get(Number(f.properties.id));
		if (!l) continue;
		const p = state.map.project([l.lng, l.lat]);
		// Circle markers sit centered at their point; pin icons sit above their point (22px is about half)
		const isCircle = f.layer?.id === "locs-circles";
		const d = isCircle ? Math.hypot(pt.x - p.x, pt.y - p.y) : Math.hypot(pt.x - p.x, pt.y - (p.y - 22 * k));
		const hitRadius = isCircle ? 14 : 26 * k;
		if (d <= hitRadius && d < bestD) {
			best = l;
			bestD = d;
		}
	}
	return best;
}

export function mapMenuAt(x: number, y: number, pt: { x: number; y: number }, ll: { lat: number; lng: number }): void {
	const l = markerAt(pt);
	if (l) markerMenu(l, x, y);
	else spotMenu(ll, x, y);
}

// the link to a marker: a page link for official markers; for the user's own, the marker itself is in the link
export async function shareMarker(id: number, btn: HTMLElement | null): Promise<void> {
	const l = state.byId.get(id);
	if (!l) return;
	const url = new URL(location.href);
	url.hash = "";
	if (l.user) {
		// the category travels with its colour and icon, so the receiver can use or recreate it; only links to official
		// markers travel (the user's own would point at nothing for anyone else)
		const own = l.temp ? null : (state.profile?.userCats || []).find((c: any) => c.id === l.cat) || null;
		const packed = await packMarker({
			title: l.title,
			category: own?.title || "",
			color: own?.color || null,
			glyph: own?.glyph || null,
			desc: l.desc,
			lat: l.lat,
			lng: l.lng,
			map: state.mapInfo.slug,
			links: (l.links || []).filter((lid: number) => lid > 0),
		});
		url.search = new URLSearchParams({ tm: packed, map: state.mapInfo.slug }).toString();
	} else {
		url.search = new URLSearchParams({ loc: String(id), map: state.mapInfo.slug }).toString();
	}
	await deliverLink(url.href, btn);
}

// on a mouse, the link goes to the clipboard and the button says so; on a phone, the system share sheet opens.
// If the clipboard is not available, the link is shown as a plain link to copy with a right-click.
export async function deliverLink(url: string, btn: HTMLElement | null): Promise<void> {
	const mouse = matchMedia("(pointer: fine)").matches;
	if (!mouse && navigator.share) {
		try {
			return await navigator.share({ title: state.entry.title, url });
		} catch (e: any) {
			if (e.name === "AbortError") return;
		}
	}
	try {
		await navigator.clipboard.writeText(url);
		if (btn) flashCopied(btn);
		else toast("Link copied");
	} catch {
		if (btn) showLinkFallback(url);
		else await askDialog({ title: "Copy this link", value: url, okLabel: "Done" });
	}
}

let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopied(btn: HTMLElement): void {
	if (!btn) return;
	btn.classList.remove("copied");
	void btn.offsetWidth; // restart the animation if it is already showing
	btn.classList.add("copied");
	btn.title = "Link copied";
	if (copiedTimer) clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => {
		btn.classList.remove("copied");
		btn.title = "Share";
	}, 1800);
}

function showLinkFallback(url: string): void {
	const body = $("#detail-body");
	if (!body) return;
	body.querySelector(".share-fallback")?.remove();
	const p = document.createElement("p");
	p.className = "share-fallback";
	p.innerHTML = `Copy this link: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
	(body.querySelector(".d-actions") || body.firstElementChild)?.after(p);
}

export function toggleFound(id: number): void {
	state.found.has(id) ? state.found.delete(id) : state.found.add(id);
	scheduleSave();
	updateSidebar();
	refreshMap();
	renderDetail();
}