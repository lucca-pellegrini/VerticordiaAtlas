/* ---------- map tools: hand (move the map) and selection (box, ellipse, free) ----------
   A selection lives in map coordinates (so it moves and zooms with the map) and is not saved: it is
   forgotten on reload. Counting and marking use the markers that are currently rendered inside it. */

import { svgIcon } from "../icons.ts";
import { CAPTURE_CONTROL_HTML } from "./capture.ts";
import { DRAW_CONTROLS_HTML, INK_CONTROL_HTML } from "./drawing.ts";
import { refreshAll } from "./map-view.ts";
import { saveProfileNow } from "./profiles.ts";
import { closeRowMenu, shownOnMap } from "./sidebar.ts";
import { state } from "./state.ts";
import { MARKER_CONTROL_HTML } from "./usermarkers.ts";

export type ShapeKind = "box" | "ellipse" | "free";

const SHAPE_NAMES: Record<ShapeKind, string> = { box: "Box select", ellipse: "Ellipse select", free: "Free select" };
const SHAPE_ICONS: Record<ShapeKind, string> = {
	box: '<rect x="4" y="6" width="16" height="12" rx="1" stroke-dasharray="2.5 2"/>',
	ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6" stroke-dasharray="2.5 2"/>',
	free: '<path d="M5 9c1.5-3 5-4 7-2s4-1.5 6 .5 1 6-2 6.5-3-2-5 0-4 2.5-6 1-4.5-.5-3-3.5z" stroke-dasharray="2.5 2"/>',
};
const HAND_ICON =
	'<path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/>' +
	'<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>';

export type ScreenGeom =
	| { shape: "box"; x: number; y: number; w: number; h: number }
	| { shape: "ellipse"; cx: number; cy: number; rx: number; ry: number }
	| { shape: "free"; pts: { x: number; y: number }[] };

// Shape geometry in screen pixels. `to` converts one stored point to a screen point.
export function geomOf<P>(
	s: { shape: ShapeKind; pts: P[]; circle?: boolean },
	to: (p: P) => { x: number; y: number },
): ScreenGeom {
	if (s.shape === "free") return { shape: "free", pts: s.pts.map(to) };
	const [a, b] = s.pts.map(to);
	if (s.shape === "box")
		return {
			shape: "box",
			x: Math.min(a.x, b.x),
			y: Math.min(a.y, b.y),
			w: Math.abs(b.x - a.x),
			h: Math.abs(b.y - a.y),
		};
	if (s.circle) {
		const r = Math.hypot(b.x - a.x, b.y - a.y);
		return { shape: "ellipse", cx: a.x, cy: a.y, rx: r, ry: r };
	}
	return { shape: "ellipse", cx: a.x, cy: a.y, rx: Math.abs(b.x - a.x), ry: Math.abs(b.y - a.y) };
}

export function insideGeom(g: ScreenGeom, x: number, y: number): boolean {
	if (g.shape === "box") return x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
	if (g.shape === "ellipse") return g.rx > 0 && g.ry > 0 && ((x - g.cx) / g.rx) ** 2 + ((y - g.cy) / g.ry) ** 2 <= 1;
	// free: even-odd ray casting; the outline closes itself back to the first point
	let inside = false;
	const p = g.pts;
	for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
		if (p[i].y > y !== p[j].y > y && x < ((p[j].x - p[i].x) * (y - p[i].y)) / (p[j].y - p[i].y) + p[i].x)
			inside = !inside;
	}
	return inside;
}

// the selection has its own menu: a point inside it is left to that one
export function inSelection(pt: { x: number; y: number }): boolean {
	if (!state.sel) return false;
	const g = geomOf(state.sel, (p: { lng: number; lat: number }) => state.map.project([p.lng, p.lat]));
	return insideGeom(g, pt.x, pt.y);
}

export function setupSelection(map: any): { setTool: (t: string) => void } {
	const canvasBox: HTMLElement = map.getCanvasContainer();
	const mapEl: HTMLElement = map.getContainer();
	const proj = (q: { lng: number; lat: number }) => map.project([q.lng, q.lat]);
	const localPos = (e: PointerEvent | MouseEvent) => {
		const r = canvasBox.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	// --- controls under the zoom buttons: hand above selection; the selection button's notch shows it has a flyout
	map.addControl(
		{
			onAdd() {
				const c = document.createElement("div");
				c.className = "maplibregl-ctrl maplibregl-ctrl-group tool-ctrl";
				c.innerHTML =
					`<button type="button" id="tool-pan" title="Move the map" aria-label="Move the map">` +
					`<svg viewBox="0 0 24 24" aria-hidden="true">${HAND_ICON}</svg></button>` +
					`<button type="button" id="tool-select" class="notched" title="Select markers. Right-click or hold for shapes" aria-label="Selection tool">` +
					`<svg viewBox="0 0 24 24" aria-hidden="true"></svg></button>` +
					DRAW_CONTROLS_HTML +
					INK_CONTROL_HTML;
				return c;
			},
			onRemove() {},
		},
		"top-right",
	);
	// the marker tool is its own group, below the drawing tools and the colour chip
	map.addControl(
		{
			onAdd() {
				const c = document.createElement("div");
				c.className = "maplibregl-ctrl maplibregl-ctrl-group tool-ctrl";
				c.innerHTML = MARKER_CONTROL_HTML;
				return c;
			},
			onRemove() {},
		},
		"top-right",
	);
	map.addControl(
		{
			onAdd() {
				const c = document.createElement("div");
				c.className = "maplibregl-ctrl maplibregl-ctrl-group tool-ctrl";
				c.innerHTML = CAPTURE_CONTROL_HTML;
				return c;
			},
			onRemove() {},
		},
		"top-right",
	);
	const panBtn = document.getElementById("tool-pan")!;
	const selBtn = document.getElementById("tool-select")!;

	const shapeMenu = document.createElement("div");
	shapeMenu.id = "shape-menu";
	shapeMenu.className = "menu row-menu";
	shapeMenu.hidden = true;
	shapeMenu.setAttribute("role", "menu");
	shapeMenu.innerHTML = Object.entries(SHAPE_NAMES)
		.map(
			([k, v]) =>
				`<button type="button" role="menuitemradio" data-shape="${k}" aria-checked="false">${svgIcon(k)}<span>${v}</span></button>`,
		)
		.join("");
	document.body.appendChild(shapeMenu);

	const selMenu = document.createElement("div");
	selMenu.id = "sel-menu";
	selMenu.className = "menu row-menu";
	selMenu.hidden = true;
	selMenu.setAttribute("role", "menu");
	selMenu.innerHTML =
		'<div class="rm-head"><div class="rm-text"><div class="rm-title">Selection</div><div class="rm-sub"></div></div></div><hr>' +
		`<button type="button" role="menuitem" data-act="found">${svgIcon("check")}<span>Mark all as found</span></button>` +
		`<button type="button" role="menuitem" data-act="unfound">${svgIcon("open")}<span>Mark all as not found</span></button>` +
		`<button type="button" role="menuitem" data-act="delete-user" class="danger" hidden>${svgIcon("trash")}<span>Delete user markers</span></button>`;
	document.body.appendChild(selMenu);

	// the drawn shapes, above the map canvas
	const NS = "http://www.w3.org/2000/svg";
	const overlay = document.createElementNS(NS, "svg");
	overlay.setAttribute("class", "sel-overlay");
	mapEl.appendChild(overlay);

	// --- tool state
	function setTool(t: string): void {
		state.tool = t;
		t === "pan" ? map.dragPan.enable() : map.dragPan.disable();
		t === "pan" ? map.doubleClickZoom.enable() : map.doubleClickZoom.disable();
		t === "pan" ? map.boxZoom.enable() : map.boxZoom.disable();
		mapEl.classList.toggle("tool-select", t === "select");
		panBtn.setAttribute("aria-pressed", String(t === "pan"));
		selBtn.setAttribute("aria-pressed", String(t === "select"));
		selBtn.querySelector("svg")!.innerHTML = SHAPE_ICONS[state.shape as ShapeKind];
		if (state.drawing) state.drawing.setActive(t === "draw");
		state.um?.setActive(t === "marker");
		state.capture?.setActive(t === "capture");
		selBtn.setAttribute("aria-label", `Selection tool: ${SHAPE_NAMES[state.shape as ShapeKind]}`);
	}
	state.tool = "pan";
	setTool("pan");

	// --- menus
	function closeToolMenus(): void {
		shapeMenu.hidden = true;
		selMenu.hidden = true;
	}
	// places a menu at (x, y): to the lower right of it, or to the left when `left` is set; flips to stay on screen
	function placeMenu(el: HTMLElement, x: number, y: number, left = false): void {
		el.hidden = false;
		const w = el.offsetWidth,
			h = el.offsetHeight,
			pad = 8;
		let lx = left ? x - w : x + 4;
		if (!left && lx + w > innerWidth - pad) lx = x - w - 4;
		lx = Math.max(pad, Math.min(lx, innerWidth - w - pad));
		const ty = Math.max(pad, Math.min(y, innerHeight - h - pad));
		el.style.left = lx + "px";
		el.style.top = ty + "px";
	}

	function openShapeMenu(btn: HTMLElement): void {
		closeRowMenu();
		shapeMenu
			.querySelectorAll<HTMLElement>("[data-shape]")
			.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.shape === state.shape)));
		const r = btn.getBoundingClientRect();
		placeMenu(shapeMenu, r.left - 8, r.top, true);
	}
	shapeMenu.onclick = (e) => {
		const b = (e.target as HTMLElement).closest<HTMLElement>("[data-shape]");
		if (!b) return;
		state.shape = b.dataset.shape;
		closeToolMenus();
		setTool("select");
	};

	function markersInSelection(): any[] {
		if (!state.sel) return [];
		const g = geomOf(state.sel, proj);
		return state.locs.filter((l: any) => {
			if (!shownOnMap(l)) return false;
			const q = map.project([l.lng, l.lat]);
			return insideGeom(g, q.x, q.y);
		});
	}
	// every user marker inside the selection, whether or not it is currently shown
	function userInSelection(): any[] {
		if (!state.sel) return [];
		const g = geomOf(state.sel, proj);
		return state.locs.filter((l: any) => {
			if (!l.user) return false;
			const q = map.project([l.lng, l.lat]);
			return insideGeom(g, q.x, q.y);
		});
	}
	function openSelMenu(x: number, y: number): void {
		closeRowMenu();
		const n = markersInSelection().length;
		selMenu.querySelector(".rm-sub")!.textContent = n
			? `${n} visible marker${n === 1 ? "" : "s"}`
			: "No visible markers inside";
		selMenu
			.querySelectorAll<HTMLButtonElement>('button[data-act="found"], button[data-act="unfound"]')
			.forEach((b) => {
				b.disabled = n === 0;
			});
		const users = userInSelection().length;
		const del = selMenu.querySelector<HTMLButtonElement>('[data-act="delete-user"]')!;
		del.hidden = users === 0;
		del.querySelector("span")!.textContent = `Delete ${users} user marker${users === 1 ? "" : "s"}`;
		placeMenu(selMenu, x, y);
	}
	selMenu.onclick = (e) => {
		const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
		if (!b || b.disabled) return;
		if (b.dataset.act === "delete-user") {
			const ids = userInSelection().map((l) => l.id);
			closeToolMenus();
			state.um.deleteMany(ids);
			return;
		}
		const found = b.dataset.act === "found";
		for (const l of markersInSelection()) found ? state.found.add(l.id) : state.found.delete(l.id);
		closeToolMenus();
		saveProfileNow();
		refreshAll();
	};

	// the tool stack folds away to the right: the hand is already on, so tapping it again (or Esc) does this.
	// Whatever is selected goes with it. A button brings the stack back.
	function collapseTools(): void {
		closeToolMenus();
		state.sel = null;
		cancelDrag();
		mapEl.classList.add("tools-collapsed");
	}
	function expandTools(): void {
		mapEl.classList.remove("tools-collapsed");
	}
	const reopen = document.createElement("button");
	reopen.id = "tools-open";
	reopen.type = "button";
	reopen.title = "Show tools";
	reopen.setAttribute("aria-label", "Show tools");
	reopen.innerHTML =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/></svg>';
	reopen.onclick = expandTools;
	mapEl.appendChild(reopen);
	mapEl.classList.add("tools-collapsed"); // the tools start folded away; the button brings them back

	// --- the selection button: tap = selection tool; right-click or hold = shape menu
	let btnTimer: ReturnType<typeof setTimeout> | null = null,
		btnHeld = false;
	selBtn.addEventListener("pointerdown", (e: PointerEvent) => {
		if (e.button !== 0) return;
		btnHeld = false;
		btnTimer = setTimeout(() => {
			btnHeld = true;
			openShapeMenu(selBtn);
		}, 500);
	});
	(["pointerup", "pointerleave", "pointercancel"] as const).forEach((t) =>
		selBtn.addEventListener(t, () => {
			if (btnTimer) clearTimeout(btnTimer);
		}),
	);
	selBtn.addEventListener("click", () => {
		if (btnHeld) {
			btnHeld = false;
			return;
		}
		if (state.tool === "select") {
			// already on it: tap again to open its shapes
			if (shapeMenu.hidden) openShapeMenu(selBtn);
			else closeToolMenus();
			return;
		}
		closeToolMenus();
		setTool("select");
	});
	selBtn.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		openShapeMenu(selBtn);
	});
	panBtn.addEventListener("click", () => {
		if (state.tool === "pan") return collapseTools(); // already the hand: fold the tools away
		closeToolMenus();
		setTool("pan");
	});

	// --- drawing on the map (select tool), and press-and-hold on the selection (both tools)
	const pointers = new Map<number, { x: number; y: number }>(); // pointer id -> screen position, for detecting pinch gestures
	let press: {
		id: number;
		x: number;
		y: number;
		inside: boolean;
		timer: ReturnType<typeof setTimeout> | null;
		held: boolean;
		drawing: boolean;
	} | null = null;
	const selInside = (p: { x: number; y: number }) => !!state.sel && insideGeom(geomOf(state.sel, proj), p.x, p.y);

	function cancelDrag(): void {
		state.drag = null;
		if (press) {
			if (press.timer) clearTimeout(press.timer);
			press = null;
		}
		renderSelection();
	}

	canvasBox.addEventListener("pointerdown", (e: PointerEvent) => {
		if (e.button !== 0 || state.tool === "draw" || state.tool === "marker" || state.tool === "capture") return;
		pointers.set(e.pointerId, localPos(e));
		if (pointers.size > 1) {
			cancelDrag();
			return;
		} // a second finger means pinch-zoom, not a selection
		const p = localPos(e);
		press = { id: e.pointerId, x: p.x, y: p.y, inside: selInside(p), timer: null, held: false, drawing: false };
		if (press.inside) {
			press.timer = setTimeout(() => {
				if (press) press.held = true;
				openSelMenu(e.clientX, e.clientY);
			}, 500);
		}
	});

	canvasBox.addEventListener("pointermove", (e: PointerEvent) => {
		if (state.tool === "draw" || state.tool === "marker" || state.tool === "capture") return;
		if (pointers.has(e.pointerId)) pointers.set(e.pointerId, localPos(e));
		if (!press || press.id !== e.pointerId || press.held || pointers.size > 1) return;
		const p = localPos(e);
		if (!press.drawing) {
			if (Math.hypot(p.x - press.x, p.y - press.y) < 4) return;
			if (press.timer) clearTimeout(press.timer);
			if (state.tool !== "select") return; // hand: the map is being dragged
			press.drawing = true;
			try {
				canvasBox.setPointerCapture(e.pointerId);
			} catch {}
			const shape = state.shape as ShapeKind;
			state.drag = { shape, pts: [{ x: press.x, y: press.y }, p], circle: false };
			if (shape === "free") state.drag.pts = [{ x: press.x, y: press.y }];
		}
		const d = state.drag;
		if (!d) return;
		if (d.shape === "free") {
			const last = d.pts[d.pts.length - 1];
			if (Math.hypot(p.x - last.x, p.y - last.y) >= 3) d.pts.push(p);
		} else {
			const a = d.pts[0];
			let dx = p.x - a.x,
				dy = p.y - a.y;
			if (d.shape === "box" && e.shiftKey) {
				// square: the longer side sets both
				const s = Math.max(Math.abs(dx), Math.abs(dy));
				dx = (dx < 0 ? -1 : 1) * s;
				dy = (dy < 0 ? -1 : 1) * s;
			}
			d.circle = d.shape === "ellipse" && e.shiftKey;
			d.pts[1] = { x: a.x + dx, y: a.y + dy }; // for ellipses this is the rim point; the shift flag makes it a circle
		}
		renderSelection();
	});

	const endPointer = (e: PointerEvent) => {
		pointers.delete(e.pointerId);
		if (!press || press.id !== e.pointerId) return;
		const p = press;
		press = null;
		if (p.timer) clearTimeout(p.timer);
		if (p.held) return;
		if (p.drawing) {
			if (state.drag) commitDrag();
			return;
		}
		// a tap: outside the selection it clears it (select tool only)
		if (e.type === "pointerup" && state.tool === "select" && state.sel && !p.inside) {
			state.sel = null;
			renderSelection();
		}
	};
	canvasBox.addEventListener("pointerup", endPointer);
	canvasBox.addEventListener("pointercancel", (e: PointerEvent) => {
		pointers.delete(e.pointerId);
		if (press && press.id === e.pointerId) {
			if (press.timer) clearTimeout(press.timer);
			press = null;
		}
		state.drag = null;
		renderSelection();
	});

	function commitDrag(): void {
		const d = state.drag;
		state.drag = null;
		const toGeo = (q: { x: number; y: number }) => {
			const ll = map.unproject([q.x, q.y]);
			return { lng: ll.lng, lat: ll.lat };
		};
		if (d.shape === "free") {
			// any outline counts once it encloses some area; it closes itself back to the start
			let area = 0;
			for (let i = 0, j = d.pts.length - 1; i < d.pts.length; j = i++)
				area += (d.pts[j].x + d.pts[i].x) * (d.pts[j].y - d.pts[i].y);
			if (d.pts.length >= 3 && Math.abs(area) / 2 > 9) state.sel = { shape: "free", pts: d.pts.map(toGeo) };
		} else {
			const [a, b] = d.pts;
			if (Math.abs(b.x - a.x) >= 3 || Math.abs(b.y - a.y) >= 3)
				state.sel = { shape: d.shape, pts: [toGeo(a), toGeo(b)], circle: d.circle };
		}
		renderSelection();
	}

	// right-click or long press on the selection: its menu
	canvasBox.addEventListener("contextmenu", (e) => {
		if (state.tool !== "pan") e.preventDefault(); // no browser menu over the map while selecting or drawing
		if (selInside(localPos(e))) {
			e.preventDefault();
			openSelMenu(e.clientX, e.clientY);
		}
	});

	// --- drawing the overlay
	function renderSelection(): void {
		const g = state.drag
			? geomOf(state.drag, (p: { x: number; y: number }) => p)
			: state.sel
				? geomOf(state.sel, proj)
				: null;
		overlay.textContent = "";
		if (!g) return;
		let el: SVGElement;
		if (g.shape === "box") {
			el = document.createElementNS(NS, "rect");
			el.setAttribute("x", String(g.x));
			el.setAttribute("y", String(g.y));
			el.setAttribute("width", String(g.w));
			el.setAttribute("height", String(g.h));
		} else if (g.shape === "ellipse") {
			el = document.createElementNS(NS, "ellipse");
			el.setAttribute("cx", String(g.cx));
			el.setAttribute("cy", String(g.cy));
			el.setAttribute("rx", String(g.rx));
			el.setAttribute("ry", String(g.ry));
		} else {
			el = document.createElementNS(NS, "polygon");
			el.setAttribute("points", g.pts.map((p) => `${p.x},${p.y}`).join(" "));
		}
		el.setAttribute("class", "sel-shape");
		overlay.appendChild(el);
	}
	map.on("move", renderSelection);
	map.on("resize", renderSelection);

	// --- Escape clears the selection and closes its menus; clicks elsewhere close the menus
	document.addEventListener("keydown", (e) => {
		if (state.drawing?.keydown(e)) {
			e.preventDefault();
			return;
		} // drawing first: it may own Esc, Enter or Ctrl+Z
		if (e.key !== "Escape") return;
		const hadSomething = !shapeMenu.hidden || !selMenu.hidden || !!state.sel || !!state.drag;
		closeToolMenus();
		if (state.sel || state.drag) {
			state.sel = null;
			cancelDrag();
		}
		// with nothing left to clear, Esc goes back to the hand
		else if (!hadSomething && state.tool !== "pan") setTool("pan");
		else if (!hadSomething) collapseTools(); // the hand is already on: fold the tools away
	});
	document.addEventListener("click", (e) => {
		if (!(e.target as HTMLElement).closest("#shape-menu, #sel-menu, #tool-select")) closeToolMenus();
	});
	return { setTool };
}