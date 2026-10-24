// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Map drawing: pencil and highlighter (perfect-freehand), lines, arrows, paths, rectangles, ellipses, text,
// an eraser, and undo / redo. Items are kept in map coordinates in the active profile (profile.drawings), so
// they move with the map. Each item remembers the zoom it was drawn at, and is drawn at the same scale relative
// to the map from then on: zooming out thins a line and shrinks its text, just like the map itself.
import { getStroke } from "../../../public/vendor/perfect-freehand.mjs";
import type { DrawingItem, DrawingKind, DrawingPoint, DrawingSize, Profile } from "../../shared/types.ts";

export const PALETTE = [
	"#f2f2f2",
	"#1b1d21",
	"#e5484d",
	"#f76b15",
	"#f5c544",
	"#46a758",
	"#12a594",
	"#3e63dd",
	"#8e4ec6",
	"#e93d82",
];
const SIZES: Record<DrawingSize, number> = { s: 2.5, m: 4.5, l: 7.5 };
const SIZE_NAMES: Record<DrawingSize, string> = { s: "Thin", m: "Medium", l: "Thick" };
const TOOLS: Record<string, { name: string; icon: string }> = {
	pen: { name: "Pencil", icon: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>' },
	highlighter: { name: "Highlighter", icon: '<path d="M15 4l5 5-9 9H6v-5z"/><path d="M4 20h16"/>' },
	line: { name: "Line", icon: '<path d="M5 19L19 5"/>' },
	arrow: { name: "Arrow", icon: '<path d="M5 19L18 6M10 6h8v8"/>' },
	path: {
		name: "Path",
		icon: '<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 17l4-5 4 2 2-4"/>',
	},
	rect: { name: "Rectangle", icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
	ellipse: { name: "Ellipse", icon: '<ellipse cx="12" cy="12" rx="8" ry="6"/>' },
	text: { name: "Text", icon: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>' },
	eraser: {
		name: "Eraser",
		icon: '<path d="M7 19h10M5.5 14.5l8-8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 18H7.5z"/>',
	},
};
const DRAW_ORDER: DrawingKind[] = ["pen", "highlighter", "line", "arrow", "path", "rect", "ellipse", "text"];
const ICON_CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
const ICON_CROSS = '<path d="M6 6l12 12M18 6L6 18"/>';
const ICON_UNDO = '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>';
const ICON_REDO = '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>';

export const DRAW_CONTROLS_HTML =
	'<button type="button" id="tool-draw" class="notched" aria-label="Drawing tools" title="Draw. Tap again, or right-click or hold, for more tools">' +
	'<svg viewBox="0 0 24 24" aria-hidden="true"></svg></button>' +
	`<button type="button" id="tool-eraser" aria-label="Eraser" title="Eraser"><svg viewBox="0 0 24 24" aria-hidden="true">${TOOLS.eraser.icon}</svg></button>`;
export const INK_CONTROL_HTML =
	'<button type="button" id="tool-ink" aria-label="Colour and size" title="Colour and size"><span class="ink-dot"></span></button>';

export interface ScreenPoint {
	x: number;
	y: number;
}

/* ---------- small pure helpers (exported for tests) ---------- */

export function hsvToHex(h: number, s: number, v: number): string {
	const f = (n: number) => {
		const k = (n + h / 60) % 6;
		const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
		return Math.round(c * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return "#" + f(5) + f(3) + f(1);
}

export function hexToHsv(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	const r = (n >> 16) / 255,
		g = ((n >> 8) & 255) / 255,
		b = (n & 255) / 255;
	const mx = Math.max(r, g, b),
		mn = Math.min(r, g, b),
		d = mx - mn;
	let h = 0;
	if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

function segDist(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
	const dx = b.x - a.x,
		dy = b.y - a.y,
		len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Ramer-Douglas-Peucker: keeps the points that matter within `eps` pixels, so a stroke has a bounded point count
export function simplify<T extends ScreenPoint>(pts: T[], eps: number): T[] {
	if (pts.length < 3) return pts.slice();
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	while (stack.length) {
		const [i, j] = stack.pop()!;
		let max = 0,
			at = -1;
		for (let k = i + 1; k < j; k++) {
			const d = segDist(pts[k], pts[i], pts[j]);
			if (d > max) {
				max = d;
				at = k;
			}
		}
		if (max > eps) {
			keep[at] = 1;
			stack.push([i, at], [at, j]);
		}
	}
	return pts.filter((_, k) => keep[k]);
}

const boxOf = (pts: ScreenPoint[]) => ({
	x: Math.min(pts[0].x, pts[1].x),
	y: Math.min(pts[0].y, pts[1].y),
	w: Math.abs(pts[1].x - pts[0].x),
	h: Math.abs(pts[1].y - pts[0].y),
});
const ellipseOf = (pts: ScreenPoint[], circle?: boolean) => {
	const [a, b] = pts;
	if (circle) {
		const r = Math.hypot(b.x - a.x, b.y - a.y);
		return { cx: a.x, cy: a.y, rx: r, ry: r };
	}
	return { cx: a.x, cy: a.y, rx: Math.abs(b.x - a.x), ry: Math.abs(b.y - a.y) };
};

/* ---------- the drawing layer ---------- */

interface DraftItem {
	kind: DrawingKind;
	color: string;
	size: DrawingSize;
	pts: ScreenPoint[];
	hover?: ScreenPoint | null;
	circle?: boolean;
}

interface HistorySnapshot {
	pid: string;
	json: string;
	at: DrawingPoint;
	z: number;
}

export interface DrawingController {
	setActive(on: boolean): void;
	render(): void;
	snapshot(cssW: number, cssH: number): string;
	reset(): void;
	animateNext(): void;
	keydown(e: KeyboardEvent): boolean;
}

export function setupDrawing({
	map,
	mapEl,
	canvasBox,
	getProfile,
	getMap,
	onChange,
	requestTool,
	renderMd,
}: {
	map: maplibregl.Map;
	mapEl: HTMLElement;
	canvasBox: HTMLElement;
	getProfile: () => Profile | null;
	getMap: () => string;
	onChange: () => void;
	requestTool: (tool: string) => void;
	renderMd: (md?: string) => string;
}): DrawingController {
	const NS = "http://www.w3.org/2000/svg";
	const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	const zoom = () => map.getZoom();
	const sp = (q: DrawingPoint): ScreenPoint => map.project([q.lng, q.lat]);
	const local = (e: PointerEvent): ScreenPoint => {
		const r = canvasBox.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};
	const toGeo = (q: ScreenPoint): DrawingPoint => {
		const ll = map.unproject([q.x, q.y]);
		return { lng: ll.lng, lat: ll.lat };
	};
	const dist = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y);
	const scaleOf = (it: { z?: number }) => 2 ** (zoom() - (it.z ?? zoom()));

	let drawTool: DrawingKind | "eraser" = "pen";
	let penCat: DrawingKind = "pen";
	const ink: { color: string; size: DrawingSize } = { color: PALETTE[2], size: "m" };
	let active = false;
	let draft: DraftItem | null = null;
	let gesture: { id: number; erase?: boolean; snapped?: boolean } | null = null;
	let editor: {
		el: HTMLDivElement;
		ta: HTMLTextAreaElement;
		id: string | null;
		color: string;
		at: ScreenPoint;
	} | null = null;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let holdAt: ScreenPoint | null = null;
	const pointers = new Map<number, ScreenPoint>();
	const history: HistorySnapshot[] = [];
	const redoStack: HistorySnapshot[] = [];

	const items = (): DrawingItem[] => {
		const p = getProfile();
		return p ? (p.drawings ||= []) : [];
	};
	const here = (): DrawingItem[] => items().filter((it) => it.map === getMap());

	/* ---- layers: under the selection overlay, above the map canvas ---- */
	const layer = document.createElementNS(NS, "svg");
	layer.setAttribute("class", "draw-layer");
	const texts = document.createElement("div");
	texts.className = "text-layer";
	const hint = document.createElement("div");
	hint.className = "path-hint";
	hint.hidden = true;
	hint.textContent = "Tap to add points. Hold or double-tap to finish, Esc to cancel";
	const before = mapEl.querySelector(".sel-overlay");
	mapEl.insertBefore(layer, before);
	mapEl.insertBefore(texts, before);
	mapEl.appendChild(hint);

	function el(tag: string, attrs: Record<string, string | number>): SVGElement {
		const e = document.createElementNS(NS, tag);
		for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
		return e;
	}
	function strokeOutline(pts: ScreenPoint[], it: { kind: DrawingKind; size: DrawingSize }, k: number): number[][] {
		const hl = it.kind === "highlighter";
		const size = SIZES[it.size] * k * (hl ? 4 : 1);
		const input = pts.map((p) => [p.x, p.y]);
		return getStroke(
			input,
			hl
				? { size, thinning: 0, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last: true }
				: { size, thinning: 0.5, smoothing: 0.55, streamline: 0.45, simulatePressure: true, last: true },
		);
	}
	function smoothPath(o: number[][]): string {
		if (o.length < 2) return "";
		const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
		const m0 = mid(o[o.length - 1], o[0]);
		let d = `M${m0[0]},${m0[1]}`;
		for (let i = 0; i < o.length; i++) {
			const a = o[i],
				m = mid(a, o[(i + 1) % o.length]);
			d += `Q${a[0]},${a[1]} ${m[0]},${m[1]}`;
		}
		return d + "Z";
	}
	function arrowHead(a: ScreenPoint, b: ScreenPoint, len: number): string {
		const ang = Math.atan2(b.y - a.y, b.x - a.x),
			spread = Math.PI / 7;
		const p = (t: number) => `${b.x - len * Math.cos(ang + t)},${b.y - len * Math.sin(ang + t)}`;
		return `${b.x},${b.y} ${p(spread)} ${p(-spread)}`;
	}
	function svgFor<P>(
		it: { kind: DrawingKind; size: DrawingSize; color: string; pts: P[]; circle?: boolean },
		to: (p: P) => ScreenPoint,
		k: number,
	): SVGElement[] {
		const w = SIZES[it.size] * k,
			c = it.color,
			pts = it.pts.map(to);
		const line = () =>
			el("line", {
				x1: pts[0].x,
				y1: pts[0].y,
				x2: pts[1].x,
				y2: pts[1].y,
				stroke: c,
				"stroke-width": w,
				"stroke-linecap": "round",
			});
		switch (it.kind) {
			case "pen":
			case "highlighter":
				return [
					el("path", {
						d: smoothPath(strokeOutline(pts, it, k)),
						fill: c,
						opacity: it.kind === "highlighter" ? 0.4 : 1,
					}),
				];
			case "line":
				return [line()];
			case "arrow":
				return [
					line(),
					el("polygon", { points: arrowHead(pts[0], pts[1], (9 + SIZES[it.size] * 2.2) * k), fill: c }),
				];
			case "path":
				return [
					el("polyline", {
						points: pts.map((p) => `${p.x},${p.y}`).join(" "),
						fill: "none",
						stroke: c,
						"stroke-width": w,
						"stroke-linecap": "round",
						"stroke-linejoin": "round",
					}),
				];
			case "rect": {
				const r = boxOf(pts);
				return [
					el("rect", {
						x: r.x,
						y: r.y,
						width: r.w,
						height: r.h,
						stroke: c,
						"stroke-width": w,
						fill: c,
						"fill-opacity": 0.12,
					}),
				];
			}
			case "ellipse": {
				const g = ellipseOf(pts, it.circle);
				return [
					el("ellipse", {
						cx: g.cx,
						cy: g.cy,
						rx: g.rx,
						ry: g.ry,
						stroke: c,
						"stroke-width": w,
						fill: c,
						"fill-opacity": 0.12,
					}),
				];
			}
			default:
				return [];
		}
	}

	const worldAt = (q: DrawingPoint, z: number): ScreenPoint => {
		const size = 512 * 2 ** z,
			sin = Math.sin((q.lat * Math.PI) / 180);
		return { x: ((q.lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
	};
	const strokes = new WeakMap<DrawingItem, { z0: number; path: SVGElement }>();
	function strokeNode(it: DrawingItem): SVGElement {
		let e = strokes.get(it);
		if (!e) {
			const z0 = it.z ?? zoom();
			const anchor = worldAt(it.pts[0], z0);
			const rel = it.pts.map((q) => {
				const w = worldAt(q, z0);
				return { x: w.x - anchor.x, y: w.y - anchor.y };
			});
			const path = el("path", {
				d: smoothPath(strokeOutline(rel, it, 1)),
				fill: it.color,
				opacity: it.kind === "highlighter" ? 0.4 : 1,
			});
			e = { z0, path };
			strokes.set(it, e);
		}
		const at = sp(it.pts[0]),
			k = 2 ** (zoom() - e.z0);
		const g = el("g", { transform: `translate(${at.x} ${at.y}) scale(${k})` });
		g.appendChild(e.path);
		return g;
	}
	const textNodes = new WeakMap<DrawingItem, HTMLDivElement>();
	function textNode(it: DrawingItem): HTMLDivElement {
		let node = textNodes.get(it);
		if (!node) {
			node = document.createElement("div");
			node.className = "ann";
			node.dataset.id = it.id;
			node.style.color = it.color;
			node.innerHTML = renderMd(it.text);
			textNodes.set(it, node);
		}
		const at = sp(it.pts[0]);
		node.style.transform = `translate(${at.x}px, ${at.y}px) scale(${scaleOf(it)})`;
		return node;
	}

	const FADE_MS = 1100;
	let animate = false;
	let shown: { map: string; nodes: Map<string, SVGElement | HTMLElement> } | null = null;
	const fades = new Map<string, { kind: "in" | "out"; t0: number; node?: SVGElement | HTMLElement }>();
	let fadeFrame = 0;
	const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
	const alphaOf = (f: { kind: "in" | "out"; t0: number }, now: number) => {
		const e = easeInOut(Math.min(1, (now - f.t0) / FADE_MS));
		return f.kind === "in" ? e : 1 - e;
	};
	const setAlpha = (node: SVGElement | HTMLElement, a: number) => {
		if (node instanceof SVGElement) node.setAttribute("opacity", a.toFixed(3));
		else node.style.opacity = a.toFixed(3);
	};
	function render(): void {
		const mapNow = getMap(),
			fade = animate && shown && shown.map === mapNow;
		animate = false;
		if (shown && shown.map !== mapNow) fades.clear();
		const prev = fade && shown ? shown.nodes : new Map<string, SVGElement | HTMLElement>();
		const nodes = new Map<string, SVGElement | HTMLElement>();
		const now = performance.now();
		layer.textContent = "";
		texts.textContent = "";
		for (const it of here()) {
			let node: SVGElement | HTMLElement;
			if (it.kind === "text") {
				node = textNode(it);
				texts.appendChild(node);
			} else if (it.kind === "pen" || it.kind === "highlighter") {
				node = strokeNode(it);
				layer.appendChild(node);
			} else {
				node = el("g", {});
				for (const e of svgFor(it, sp, scaleOf(it))) node.appendChild(e);
				layer.appendChild(node);
			}
			if (fade && !prev.has(it.id)) fades.set(it.id, { kind: "in", t0: now });
			nodes.set(it.id, node);
		}
		if (fade)
			for (const [id, old] of prev)
				if (!nodes.has(id) && !fades.has(id)) fades.set(id, { kind: "out", t0: now, node: old });
		for (const [id, f] of fades) {
			const over = now - f.t0 >= FADE_MS;
			if (f.kind === "in") {
				if (over || !nodes.has(id)) {
					fades.delete(id);
					continue;
				}
				setAlpha(nodes.get(id)!, alphaOf(f, now));
			} else {
				if (over || nodes.has(id) || !f.node) {
					fades.delete(id);
					continue;
				}
				setAlpha(f.node, alphaOf(f, now));
				(f.node instanceof SVGElement ? layer : texts).appendChild(f.node);
			}
		}
		shown = { map: mapNow, nodes };
		if (fades.size && !fadeFrame)
			fadeFrame = requestAnimationFrame(() => {
				fadeFrame = 0;
				render();
			});
		if (draft) {
			const d = draft.kind === "path" && draft.hover ? { ...draft, pts: [...draft.pts, draft.hover] } : draft;
			for (const e of svgFor(d, (p) => p, 1)) layer.appendChild(e);
		}
		hint.hidden = !(draft && draft.kind === "path");
		syncButtons();
	}

	/* ---- hit testing, for the eraser and to edit text ---- */
	function hits(it: DrawingItem, p: ScreenPoint): boolean {
		if (it.kind === "text") {
			const node = texts.querySelector(`[data-id="${it.id}"]`);
			if (!node) return false;
			const r = node.getBoundingClientRect(),
				b = mapEl.getBoundingClientRect();
			return (
				p.x >= r.left - b.left - 4 &&
				p.x <= r.right - b.left + 4 &&
				p.y >= r.top - b.top - 4 &&
				p.y <= r.bottom - b.top + 4
			);
		}
		const pts = it.pts.map(sp);
		const tol = (SIZES[it.size] * scaleOf(it) * (it.kind === "highlighter" ? 4 : 1)) / 2 + 6;
		if (it.kind === "ellipse") {
			const g = ellipseOf(pts, it.circle);
			if (!g.rx || !g.ry) return false;
			const f = Math.hypot((p.x - g.cx) / g.rx, (p.y - g.cy) / g.ry);
			return Math.abs(f - 1) * Math.min(g.rx, g.ry) <= tol;
		}
		let segs: [ScreenPoint, ScreenPoint][] = [];
		if (it.kind === "rect") {
			const r = boxOf(pts),
				c = [
					{ x: r.x, y: r.y },
					{ x: r.x + r.w, y: r.y },
					{ x: r.x + r.w, y: r.y + r.h },
					{ x: r.x, y: r.y + r.h },
				];
			segs = c.map((q, i): [ScreenPoint, ScreenPoint] => [q, c[(i + 1) % 4]]);
		} else {
			for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
			if (pts.length === 1) segs.push([pts[0], pts[0]]);
		}
		return segs.some(([a, b]) => segDist(p, a, b) <= tol);
	}
	function hitTest(p: ScreenPoint): DrawingItem | null {
		const list = here();
		for (let i = list.length - 1; i >= 0; i--) if (hits(list[i], p)) return list[i];
		return null;
	}

	/* ---- committing changes, with undo and redo ---- */
	const snapshot = (p: Profile) => JSON.stringify(p.drawings || []);
	const centroid = (pts: DrawingPoint[]): DrawingPoint => ({
		lng: pts.reduce((s, q) => s + q.lng, 0) / pts.length,
		lat: pts.reduce((s, q) => s + q.lat, 0) / pts.length,
	});
	function pushHistory(at: DrawingPoint): void {
		const p = getProfile();
		if (!p) return;
		history.push({ pid: p.id, json: snapshot(p), at, z: zoom() });
		if (history.length > 80) history.shift();
		redoStack.length = 0;
	}
	function step(src: HistorySnapshot[], dst: HistorySnapshot[]): void {
		const p = getProfile();
		if (!p) return;
		const at = src.map((h) => h.pid).lastIndexOf(p.id);
		if (at < 0) return;
		const [h] = src.splice(at, 1);
		dst.push({ pid: p.id, json: snapshot(p), at: h.at, z: h.z });
		p.drawings = JSON.parse(h.json);
		draft = null;
		gesture = null;
		onChange();
		render();
		showEdit(h);
	}
	function showEdit(h: HistorySnapshot): void {
		if (!h.at || map.getBounds().contains([h.at.lng, h.at.lat])) return;
		map.easeTo({ center: [h.at.lng, h.at.lat], zoom: h.z, duration: 450 });
	}
	const undo = () => step(history, redoStack);
	const redo = () => step(redoStack, history);
	function commit(item: Omit<DrawingItem, "id" | "z" | "map">): void {
		pushHistory(centroid(item.pts));
		items().push({ id: uid(), z: Math.round(zoom() * 1000) / 1000, map: getMap(), ...item });
		draft = null;
		onChange();
		render();
	}
	const toItem = (d: DraftItem): Omit<DrawingItem, "id" | "z" | "map"> => ({
		kind: d.kind,
		color: d.color,
		size: d.size,
		pts: d.pts.map(toGeo),
		circle: !!d.circle,
	});

	function eraseAt(p: ScreenPoint): void {
		const hit = hitTest(p);
		if (!hit || !gesture) return;
		if (!gesture.snapped) {
			pushHistory(centroid(hit.pts));
			gesture.snapped = true;
		}
		const list = items();
		list.splice(list.indexOf(hit), 1);
		onChange();
		render();
	}

	/* ---- text editor ---- */
	function closeEditor(): void {
		const ed = editor;
		editor = null;
		if (ed) ed.el.remove();
	}
	function commitEditor(): void {
		if (!editor) return;
		const ed = editor;
		closeEditor();
		const text = ed.ta.value.trim();
		if (ed.id) {
			const list = items(),
				it = list.find((x) => x.id === ed.id);
			if (!it || text === it.text) {
				render();
				return;
			}
			pushHistory(it.pts[0]);
			textNodes.delete(it);
			if (text) it.text = text;
			else list.splice(list.indexOf(it), 1);
			onChange();
			render();
			return;
		}
		if (text) commit({ kind: "text", color: ed.color, size: ink.size, pts: [toGeo(ed.at)], text });
		else render();
	}
	function openEditor(p: ScreenPoint, item: DrawingItem | null): void {
		commitEditor();
		const at = item ? sp(item.pts[0]) : p;
		const color = item ? item.color : ink.color;
		const wrap = document.createElement("div");
		wrap.className = "ann-editor";
		wrap.style.transform = `translate(${at.x}px, ${at.y}px)`;
		wrap.innerHTML =
			'<textarea rows="2" spellcheck="false" placeholder="Write something. Markdown works"></textarea>' +
			'<div class="ann-bar"><span class="ann-hint">Enter to place, Shift+Enter for a new line</span>' +
			`<button type="button" class="ann-cancel" aria-label="Cancel"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_CROSS}</svg></button>` +
			`<button type="button" class="ann-ok" aria-label="Place text"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_CHECK}</svg></button></div>`;
		const ta = wrap.querySelector("textarea")!;
		ta.value = item ? item.text || "" : "";
		ta.style.color = color;
		mapEl.appendChild(wrap);
		editor = { el: wrap, ta, id: item ? item.id : null, color, at };
		wrap.querySelector(".ann-ok")!.addEventListener("click", commitEditor);
		wrap.querySelector(".ann-cancel")!.addEventListener("click", closeEditor);
		setTimeout(() => ta.focus(), 0);
	}

	/* ---- pointer handling ---- */
	function cancelDraft(): void {
		draft = null;
		gesture = null;
		if (holdTimer) clearTimeout(holdTimer);
		render();
	}
	function finishPath(): void {
		if (holdTimer) clearTimeout(holdTimer);
		const d = draft;
		draft = null;
		if (d && d.pts.length >= 2) commit(toItem(d));
		else render();
	}

	canvasBox.addEventListener("pointerdown", (e) => {
		if (!active || e.button !== 0) return;
		const p = local(e);
		pointers.set(e.pointerId, p);
		if (pointers.size > 1) {
			cancelDraft();
			return;
		}
		if (editor) commitEditor();

		if (drawTool === "eraser") {
			gesture = { id: e.pointerId, erase: true, snapped: false };
			eraseAt(p);
			return;
		}
		if (drawTool === "text") {
			const hit = hitTest(p);
			openEditor(p, hit && hit.kind === "text" ? hit : null);
			return;
		}
		if (drawTool === "path") {
			if (!draft) draft = { kind: "path", color: ink.color, size: ink.size, pts: [p], hover: null };
			else if (dist(draft.pts[draft.pts.length - 1], p) > 4) draft.pts.push(p);
			if (e.detail >= 2) {
				finishPath();
				return;
			}
			holdAt = p;
			if (holdTimer) clearTimeout(holdTimer);
			holdTimer = setTimeout(finishPath, 500);
			render();
			return;
		}
		gesture = { id: e.pointerId };
		try {
			canvasBox.setPointerCapture(e.pointerId);
		} catch {}
		draft = { kind: drawTool, color: ink.color, size: ink.size, pts: [p, p] };
		if (drawTool === "pen" || drawTool === "highlighter") draft.pts = [p];
		render();
	});

	canvasBox.addEventListener("pointermove", (e) => {
		if (!active) return;
		const p = local(e);
		if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
		if (gesture && gesture.erase && gesture.id === e.pointerId) {
			eraseAt(p);
			return;
		}
		if (draft && draft.kind === "path") {
			if (holdAt && dist(holdAt, p) > 8 && holdTimer) clearTimeout(holdTimer);
			draft.hover = p;
			render();
			return;
		}
		if (!draft || !gesture || gesture.id !== e.pointerId || pointers.size > 1) return;

		if (draft.kind === "pen" || draft.kind === "highlighter") {
			if (dist(draft.pts[draft.pts.length - 1], p) >= 1.5) draft.pts.push(p);
		} else {
			const a = draft.pts[0];
			let dx = p.x - a.x,
				dy = p.y - a.y;
			if (e.shiftKey && (draft.kind === "line" || draft.kind === "arrow")) {
				const stepAngle = Math.PI / 12,
					ang = Math.round(Math.atan2(dy, dx) / stepAngle) * stepAngle,
					len = Math.hypot(dx, dy);
				dx = Math.cos(ang) * len;
				dy = Math.sin(ang) * len;
			}
			if (e.shiftKey && draft.kind === "rect") {
				const s = Math.max(Math.abs(dx), Math.abs(dy));
				dx = (Math.sign(dx) || 1) * s;
				dy = (Math.sign(dy) || 1) * s;
			}
			draft.circle = draft.kind === "ellipse" && e.shiftKey;
			draft.pts[1] = { x: a.x + dx, y: a.y + dy };
		}
		render();
	});

	function endPointer(e: PointerEvent, cancelled: boolean): void {
		pointers.delete(e.pointerId);
		if (drawTool === "path" && holdTimer) clearTimeout(holdTimer);
		if (!gesture || gesture.id !== e.pointerId) return;
		const g = gesture;
		gesture = null;
		if (g.erase) return;
		if (!draft || cancelled) {
			draft = null;
			render();
			return;
		}
		const d = draft;
		draft = null;
		if (d.kind === "pen" || d.kind === "highlighter") {
			d.pts = simplify(d.pts, 1.1);
		} else if (dist(d.pts[0], d.pts[1]) < 3) {
			render();
			return;
		}
		commit(toItem(d));
	}
	canvasBox.addEventListener("pointerup", (e) => endPointer(e, false));
	canvasBox.addEventListener("pointercancel", (e) => endPointer(e, true));
	canvasBox.addEventListener("contextmenu", (e) => {
		if (active) e.preventDefault();
	});

	/* ---- keyboard ---- */
	const typing = (e: KeyboardEvent) => {
		const t = e.target as HTMLElement | null;
		return !!t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable);
	};
	function keydown(e: KeyboardEvent): boolean {
		if (e.isComposing) return false;
		if (editor) {
			if (e.key === "Escape") {
				closeEditor();
				return true;
			}
			if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
				commitEditor();
				return true;
			}
			return false;
		}
		if (typing(e)) return false;
		if (e.key === "Escape" && (draft || gesture)) {
			cancelDraft();
			return true;
		}
		if (e.key === "Enter" && draft && draft.kind === "path") {
			finishPath();
			return true;
		}
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && history.length) {
			undo();
			return true;
		}
		if (mod && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") && redoStack.length) {
			redo();
			return true;
		}
		return false;
	}

	/* ---- undo and redo buttons ---- */
	map.addControl(
		{
			onAdd() {
				const c = document.createElement("div");
				c.className = "maplibregl-ctrl maplibregl-ctrl-group history-ctrl";
				c.innerHTML =
					`<button type="button" id="undo-btn" aria-label="Undo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_UNDO}</svg></button>` +
					`<button type="button" id="redo-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_REDO}</svg></button>`;
				return c;
			},
			onRemove() {},
		},
		"bottom-right",
	);
	const undoBtn = document.getElementById("undo-btn")!;
	const redoBtn = document.getElementById("redo-btn")!;
	undoBtn.addEventListener("click", undo);
	redoBtn.addEventListener("click", redo);

	/* ---- the draw and eraser buttons ---- */
	const drawBtn = document.getElementById("tool-draw")!;
	const eraserBtn = document.getElementById("tool-eraser")!;
	const inkBtn = document.getElementById("tool-ink")!;
	const drawMenu = document.createElement("div");
	drawMenu.id = "draw-menu";
	drawMenu.className = "menu row-menu";
	drawMenu.hidden = true;
	drawMenu.setAttribute("role", "menu");
	drawMenu.innerHTML = DRAW_ORDER.map(
		(k) =>
			`<button type="button" role="menuitemradio" data-tool="${k}" aria-checked="false">` +
			`<svg viewBox="0 0 24 24" aria-hidden="true">${TOOLS[k].icon}</svg>${TOOLS[k].name}</button>`,
	).join("");
	document.body.appendChild(drawMenu);

	function placeBeside(elm: HTMLElement, rect: DOMRect): void {
		elm.hidden = false;
		const w = elm.offsetWidth,
			h = elm.offsetHeight,
			pad = 8;
		const x = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad));
		elm.style.left = x + "px";
		elm.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + "px";
	}
	function syncButtons(): void {
		if (drawBtn.dataset.kind !== penCat) {
			drawBtn.dataset.kind = penCat;
			drawBtn.querySelector("svg")!.innerHTML = TOOLS[penCat].icon;
			drawBtn.setAttribute("aria-label", `Drawing tool: ${TOOLS[penCat].name}`);
		}
		drawBtn.setAttribute("aria-pressed", String(active && drawTool !== "eraser"));
		eraserBtn.setAttribute("aria-pressed", String(active && drawTool === "eraser"));
		drawMenu
			.querySelectorAll<HTMLElement>("[data-tool]")
			.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tool === penCat)));
		const pid = getProfile()?.id;
		const canUndo = !!pid && history.some((h) => h.pid === pid);
		const canRedo = !!pid && redoStack.some((h) => h.pid === pid);
		undoBtn.hidden = !canUndo;
		redoBtn.hidden = !canRedo;
		undoBtn.parentElement!.hidden = !canUndo && !canRedo;
	}
	function pickDrawing(kind: DrawingKind): void {
		penCat = kind;
		drawTool = kind;
		drawMenu.hidden = true;
		requestTool("draw");
	}
	function openDrawMenu(): void {
		closeInk();
		syncButtons();
		placeBeside(drawMenu, drawBtn.getBoundingClientRect());
	}
	drawMenu.onclick = (e) => {
		const b = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tool]");
		if (b && b.dataset.tool) pickDrawing(b.dataset.tool as DrawingKind);
	};
	let drawTimer: ReturnType<typeof setTimeout> | null = null,
		drawHeld = false;
	drawBtn.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		drawHeld = false;
		drawTimer = setTimeout(() => {
			drawHeld = true;
			openDrawMenu();
		}, 500);
	});
	(["pointerup", "pointerleave", "pointercancel"] as const).forEach((t) =>
		drawBtn.addEventListener(t, () => {
			if (drawTimer) clearTimeout(drawTimer);
		}),
	);
	drawBtn.addEventListener("click", () => {
		if (drawHeld) {
			drawHeld = false;
			return;
		}
		if (active && drawTool !== "eraser") {
			if (drawMenu.hidden) openDrawMenu();
			else drawMenu.hidden = true;
			return;
		}
		drawMenu.hidden = true;
		pickDrawing(penCat);
	});
	drawBtn.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		openDrawMenu();
	});
	eraserBtn.addEventListener("click", () => {
		drawMenu.hidden = true;
		closeInk();
		if (active && drawTool === "eraser") return;
		drawTool = "eraser";
		requestTool("draw");
	});

	/* ---- colour and size ---- */
	const inkPop = document.createElement("div");
	inkPop.id = "ink-pop";
	inkPop.className = "menu row-menu ink-pop";
	inkPop.hidden = true;
	inkPop.innerHTML =
		`<div class="ink-swatches">${PALETTE.map((c) => `<button type="button" class="sw" data-color="${c}" style="--c:${c}" aria-label="${c}"></button>`).join("")}</div>` +
		'<div class="ink-wheel"><div class="ring" id="ink-ring"><i class="ring-knob"></i></div>' +
		'<div class="sv" id="ink-sv"><i class="sv-knob"></i></div></div>' +
		'<div class="ink-row"><span class="ink-prev"></span><input class="ink-hex" id="ink-hex" maxlength="7" spellcheck="false" aria-label="Hex colour"></div>' +
		`<div class="ink-sizes">${(Object.keys(SIZES) as DrawingSize[]).map((k) => `<button type="button" data-size="${k}" title="${SIZE_NAMES[k]}" aria-label="${SIZE_NAMES[k]}"><i style="--w:${SIZES[k] * 2 + 2}px"></i></button>`).join("")}</div>`;
	document.body.appendChild(inkPop);
	const ring = inkPop.querySelector<HTMLElement>("#ink-ring")!;
	const sv = inkPop.querySelector<HTMLElement>("#ink-sv")!;
	const hex = inkPop.querySelector<HTMLInputElement>("#ink-hex")!;
	let hsv = hexToHsv(ink.color);
	const RING_R = 67.5,
		SV = 92;

	function renderInk(): void {
		const [h, s, v] = hsv;
		const rad = (h * Math.PI) / 180;
		const ringKnob = ring.querySelector<HTMLElement>(".ring-knob")!;
		ringKnob.style.left = 75 + RING_R * Math.sin(rad) + "px";
		ringKnob.style.top = 75 - RING_R * Math.cos(rad) + "px";
		sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h} 100% 50%))`;
		const svKnob = sv.querySelector<HTMLElement>(".sv-knob")!;
		svKnob.style.left = s * SV + "px";
		svKnob.style.top = (1 - v) * SV + "px";
		if (document.activeElement !== hex) hex.value = ink.color;
		inkPop.querySelector<HTMLElement>(".ink-prev")!.style.background = ink.color;
		inkPop
			.querySelectorAll<HTMLElement>(".sw")
			.forEach((b) => b.classList.toggle("on", b.dataset.color === ink.color));
		inkPop
			.querySelectorAll<HTMLElement>("[data-size]")
			.forEach((b) => b.classList.toggle("on", b.dataset.size === ink.size));
		inkBtn.querySelector<HTMLElement>(".ink-dot")!.style.background = ink.color;
	}
	function setColor(c: string): void {
		ink.color = c;
		hsv = hexToHsv(c);
		renderInk();
	}
	function setFromHsv(): void {
		ink.color = hsvToHex(...hsv);
		renderInk();
	}
	const drag = (node: HTMLElement, fn: (e: PointerEvent) => void) =>
		node.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			node.setPointerCapture(e.pointerId);
			fn(e);
			const move = (ev: PointerEvent) => fn(ev);
			node.addEventListener("pointermove", move);
			node.addEventListener("pointerup", () => node.removeEventListener("pointermove", move), { once: true });
		});
	drag(ring, (e) => {
		const r = ring.getBoundingClientRect();
		const deg =
			(Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
		hsv[0] = (deg + 360) % 360;
		setFromHsv();
	});
	drag(sv, (e) => {
		const r = sv.getBoundingClientRect();
		hsv[1] = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
		hsv[2] = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
		setFromHsv();
	});
	inkPop
		.querySelectorAll<HTMLElement>(".sw")
		.forEach((b) => b.addEventListener("click", () => setColor(b.dataset.color!)));
	inkPop.querySelectorAll<HTMLElement>("[data-size]").forEach((b) =>
		b.addEventListener("click", () => {
			ink.size = b.dataset.size as DrawingSize;
			renderInk();
		}),
	);
	hex.addEventListener("input", () => {
		const v = hex.value.trim();
		if (/^#?[0-9a-f]{6}$/i.test(v)) setColor("#" + v.replace("#", "").toLowerCase());
	});
	hex.addEventListener("change", () => renderInk());

	function closeInk(): void {
		inkPop.hidden = true;
	}
	inkBtn.addEventListener("click", () => {
		if (!inkPop.hidden) return closeInk();
		drawMenu.hidden = true;
		hsv = hexToHsv(ink.color);
		renderInk();
		placeBeside(inkPop, inkBtn.getBoundingClientRect());
	});

	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement | null;
		if (!target?.closest("#draw-menu, #tool-draw")) drawMenu.hidden = true;
		if (!target?.closest("#ink-pop, #tool-ink")) closeInk();
	});
	renderInk();
	syncButtons();

	function setActive(on: boolean): void {
		if (!on && editor) commitEditor();
		if (!on) cancelDraft();
		active = on;
		mapEl.classList.toggle("tool-draw", on);
		render();
	}

	map.on("move", render);
	map.on("resize", render);

	return {
		setActive,
		render,
		snapshot(cssW: number, cssH: number): string {
			const c = layer.cloneNode(true) as SVGElement;
			c.setAttribute("width", String(cssW));
			c.setAttribute("height", String(cssH));
			c.setAttribute("viewBox", `0 0 ${cssW} ${cssH}`);
			return new XMLSerializer().serializeToString(c);
		},
		reset() {
			history.length = 0;
			redoStack.length = 0;
			draft = null;
			gesture = null;
			if (holdTimer) clearTimeout(holdTimer);
			closeEditor();
			render();
		},
		animateNext() {
			animate = true;
		},
		keydown,
	};
}