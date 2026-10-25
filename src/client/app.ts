// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Offline map viewer entrypoint. Orchestrates boot, account sync, and top-level event wiring.

import { esc } from "../shared/escape.ts";
import { accountSlot, api, currentUser, initAccount, legalLinks, setOnlineStatus, socketUrl } from "./account.ts";
import { dbAll, emptyProfile, openDB, syncStore } from "./map/db.ts";
import {
	closeCtx,
	closeCtxIfOutside,
	closeDetail,
	DetailBodyElement,
	goBack,
	onPopState,
	select,
	setLastPointer,
	shareMarker,
	toggleFound,
} from "./map/detail.ts";
import {
	agreeCamera,
	applyTheme,
	cameraNow,
	fatal,
	fetchJSON,
	glideTo,
	loadGame,
	refreshAll,
	rememberCamera,
	sameCamera,
	switchMap,
	viewUntouched,
} from "./map/map-view.ts";
import { applyPreset, exitPreset, loadMapState, presetAction, presetById, presetsKey } from "./map/presets.ts";
import {
	applyProfile,
	importFile,
	profileAction,
	renderProfileSelect,
	scheduleViewSave,
	switchProfile,
	syncTagStrict,
	wireTagStrict,
} from "./map/profiles.ts";
import {
	endPreview,
	HOVER_MS,
	leaveSearch,
	moveSearch,
	openResult,
	previewAt,
	previewRow,
	runSearch,
} from "./map/search.ts";
import {
	arrangeSidebar,
	closeRowMenu,
	onViewChanged,
	saveSession,
	setSideCollapsed,
	setupTitleRow,
} from "./map/sidebar.ts";
import { $, setSyncNote, state, toast, UNTAGGED } from "./map/state.ts";
import { createSync } from "./sync.ts";
import { onThemeChange, storeGameTitles } from "./theme.ts";

/* ---------- accounts: sync for signed-in users (see sync.ts). The app never waits for it. ---------- */
let syncer: ReturnType<typeof createSync> | null = null;
setSyncNote(() => syncer?.noteLocal());

let accountReady: Promise<any> = Promise.resolve(null);

export async function startAccountSync(): Promise<void> {
	await accountReady;
	if (!currentUser()) return;
	syncer = createSync({
		store: syncStore,
		api,
		socketUrl,
		ui: {
			status: ({ online }) => setOnlineStatus(online),
			conflicts: (list) => showConflicts(list),
			remoteChanged: async (keys) => {
				await refreshFromStore(keys);
				if (keys.length) toast("Updated from your other device.");
			},
			signedOut: () => location.reload(),
		},
	});
	syncer.start();
}

// the open screen follows what sync wrote into IndexedDB (the profile, its presets and view), so nothing stale is saved over it
async function refreshFromStore(keys: string[]): Promise<void> {
	const gid = state.entry?.id;
	if (!gid || !state.profile) return;
	if (keys.some((k) => k.startsWith(`profile:${gid}:`))) {
		state.profiles = (await dbAll("profiles")).filter((p) => p.game === gid).sort((a, b) => a.created - b.created);
		// a new device starts with an empty profile of its own: when the account's profiles arrive, the one with progress is the one to show
		let cur = state.profiles.find((p: any) => p.id === state.profile.id) || state.profiles[0];
		if (cur && emptyProfile(cur)) {
			const withProgress = state.profiles
				.filter((p: any) => !emptyProfile(p))
				.sort((x: any, y: any) => (y.updated || 0) - (x.updated || 0))[0];
			if (withProgress) cur = withProgress;
		}
		if (cur) {
			state.drawing?.animateNext(); // the drawings that changed elsewhere fade in or out (applyProfile redraws them)
			applyProfile(cur);
			renderProfileSelect();
			// the view belongs to the profile: show this map's view from it, whatever map this is (switchMap below may not run yet)
			if (state.mapInfo) await loadMapState();
			// the profile also carries the map and the camera: follow them, as the other device left them
			// ...but only while this device's own view is as it was left: someone moving the map here keeps it where they put it
			if (viewUntouched()) {
				if (
					cur.map &&
					cur.map !== state.mapInfo?.slug &&
					state.meta.maps.some((m: any) => m.slug === cur.map)
				) {
					await switchMap(cur.map, { remember: false }); // prepareMap loads the view again
					agreeCamera();
				} else {
					const cam = cur.cameras?.[state.mapInfo?.slug];
					if (cam && state.mapReady && !sameCamera(cam, cameraNow())) glideTo(cam);
				}
			}
		}
	}
	if (keys.some((k) => k === `meta:${presetsKey()}`)) await loadMapState();
	refreshAll();
}

// the conflict message: the server has newer data, and this device has changes of its own
function showConflicts(list: { key: string; label: string }[]): void {
	const d = $<HTMLDialogElement>("#dlg")!;
	const form = $<HTMLFormElement>("#dlg-form")!;
	if (!list.length || d.open) return;
	form.innerHTML =
		"<h2>Your changes and the server's disagree</h2>" +
		"<p>You have unsynced changes on this device, and the server has newer data for: " +
		list.map((i) => esc(i.label)).join(", ") +
		".</p>" +
		'<div class="dlg-actions"><button type="button" data-keep="local">Overwrite with this device\'s data</button>' +
		'<button type="button" class="primary" data-keep="server">Use the server\'s data</button></div>';
	form.onsubmit = (e) => e.preventDefault();
	const pick = async (which: "local" | "server") => {
		d.close();
		try {
			await syncer?.resolveConflicts(which);
		} catch (e) {
			console.error(e);
		}
		if (which === "server") location.reload(); // the server's data is in place: start again from it, so nothing stale stays on screen
	};
	form.querySelector<HTMLElement>('[data-keep="server"]')!.onclick = () => pick("server");
	form.querySelector<HTMLElement>('[data-keep="local"]')!.onclick = () => pick("local");
	d.showModal();
}

async function boot(): Promise<void> {
	try {
		await openDB();
	} catch {
		state.memoryOnly = true;
		toast("Storage is unavailable here, so progress will not be kept after this tab closes.", 6000);
	}

	// Each map page lives in maps/<slug>/ next to its data and says which game it is via <body data-game> or the URL.
	let index: { games: any[] };
	try {
		index = await fetchJSON("../index.json");
	} catch {
		fatal('Could not load maps/index.json. Serve this folder over HTTP (for example with "npx serve").');
		return;
	}

	const pathMatch = location.pathname.match(/\/maps\/([^/]+)/);
	const slug = document.body.dataset.game || (pathMatch ? decodeURIComponent(pathMatch[1]) : "");
	const entry = index.games.find((g) => g.slug === slug);
	if (!entry) {
		fatal(`maps/index.json has no game with slug "${slug}".`);
		return;
	}
	if (index.games) storeGameTitles(index.games);
	document.body.dataset.game = entry.slug;
	if (!document.title || document.title === "Verticordia Atlas" || document.title === "Map · Verticordia Atlas") {
		document.title = `${entry.title} · Verticordia Atlas`;
	}
	const ok = await loadGame(entry);
	if (ok) startAccountSync(); // signed-in users only; a no-op otherwise
}

interface ResultsElement extends HTMLElement {
	hoverRow?: HTMLElement | null;
	hoverTimer?: ReturnType<typeof setTimeout>;
}

function wire(): void {
	setupTitleRow();
	arrangeSidebar();
	wireTagStrict();
	// the throbber for a map switch: sticky at the top of the scrolling sidebar, so it stays in the middle of what is visible
	const scroll = document.querySelector("#side .side-scroll"),
		groups = document.getElementById("groups");
	if (scroll && groups && !scroll.querySelector(".groups-throbber")) {
		const t = document.createElement("div");
		t.className = "groups-throbber";
		t.setAttribute("aria-hidden", "true");
		scroll.insertBefore(t, groups);
	}
	// while a map loads, the side panel takes no input, from the mouse or the keyboard (its content is dimmed, see style.css)
	new MutationObserver(() => {
		const side = document.getElementById("side") as (HTMLElement & { inert?: boolean }) | null;
		if (side)
			side.inert =
				document.body.classList.contains("loading-map") || document.body.classList.contains("profile-switch");
	}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

	onThemeChange(() => {
		if (state.entry) applyTheme(state.entry.theme);
	});
	document.querySelector(".side-scroll")?.appendChild(accountSlot());
	document.querySelector(".side-scroll")?.appendChild(legalLinks());
	accountReady = initAccount({ toast }); // resolves once we know whether someone is signed in

	$<HTMLSelectElement>("#profile-select")!.onchange = (e) => switchProfile((e.target as HTMLSelectElement).value);
	const menu = $("#profile-menu")!,
		menuBtn = $("#profile-menu-btn")!;
	menuBtn.onclick = (e) => {
		e.stopPropagation();
		menu.hidden = !menu.hidden;
		menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
	};
	menu.onclick = (e) => {
		const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-act]");
		if (b && b.dataset.act) {
			menu.hidden = true;
			profileAction(b.dataset.act);
		}
	};
	$<HTMLInputElement>("#import-file")!.onchange = (e) => {
		const input = e.target as HTMLInputElement;
		const f = input.files?.[0];
		input.value = "";
		if (f) importFile(f);
	};

	const presetMenu = $("#preset-menu")!,
		presetMenuBtn = $("#preset-menu-btn")!;
	$<HTMLSelectElement>("#preset-select")!.onchange = (e) => {
		const p = presetById((e.target as HTMLSelectElement).value);
		if (p) applyPreset(p);
		else exitPreset();
	};
	$("#preset-bar")!.onclick = (e) => {
		const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-act]");
		if (b && b.dataset.act) presetAction(b.dataset.act);
	};
	presetMenuBtn.onclick = (e) => {
		e.stopPropagation();
		presetMenu.hidden = !presetMenu.hidden;
		presetMenuBtn.setAttribute("aria-expanded", String(!presetMenu.hidden));
	};
	presetMenu.onclick = (e) => {
		const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
		if (b && !b.disabled && b.dataset.act) {
			presetMenu.hidden = true;
			presetAction(b.dataset.act);
		}
	};

	$<HTMLSelectElement>("#tag-select")!.onchange = (e) => {
		const val = (e.target as HTMLSelectElement).value;
		state.tag = val === "" ? null : val === UNTAGGED ? UNTAGGED : Number(val);
		syncTagStrict();
		scheduleViewSave();
		refreshAll();
	};
	$<HTMLInputElement>("#hide-found")!.onchange = (e) => {
		state.view.hideFound = (e.target as HTMLInputElement).checked;
		onViewChanged();
	};
	$("#show-all")!.onclick = () => {
		state.view.hidden.clear();
		onViewChanged();
	};
	$("#hide-all")!.onclick = () => {
		state.cats.forEach((c: any) => state.view.hidden.add(c.id));
		onViewChanged();
	};

	const search = $<HTMLInputElement>("#search")!;
	const results = $<ResultsElement>("#results")!;
	const resultsBar = $("#results-bar")!;
	search.oninput = () => runSearch();
	search.onfocus = () => {
		if (search.value.trim()) runSearch();
	};
	search.onkeydown = (e) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			moveSearch(e.key === "ArrowDown" ? 1 : -1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const all = results.querySelectorAll<HTMLElement>("li.result");
			const target = state.search.idx >= 0 ? all[state.search.idx] : all[0];
			if (target) openResult(target);
		}
	};
	document.addEventListener("keydown", (e) => {
		// Ctrl/Cmd+F or Ctrl/Cmd+K searches this map, instead of the browser's find
		if (
			!(e.ctrlKey || e.metaKey) ||
			e.shiftKey ||
			e.altKey ||
			!["f", "k"].includes(e.key.toLowerCase()) ||
			$<HTMLDialogElement>("#dlg")!.open
		)
			return;
		e.preventDefault();
		search.focus();
		search.select();
	});
	document.addEventListener("keydown", (e) => {
		// Esc leaves the search, wherever the focus is
		if (e.key !== "Escape" || !state.search.active || $<HTMLDialogElement>("#dlg")!.open) return;
		search.value = "";
		leaveSearch();
	});
	results.onclick = (e) => {
		const target = e.target as HTMLElement;
		const a = target.closest<HTMLElement>("a");
		if (a) {
			if (a.dataset.loc) {
				e.preventDefault();
				select(Number(a.dataset.loc));
			}
			return;
		} // links in a description
		const li = target.closest<HTMLElement>("li.result");
		if (li) openResult(li);
	};
	// a hover moves the map once the pointer has rested a moment (HOVER_MS), and only for a mouse: on a touch screen the
	// pointer "hovers" just before the tap, and that must not move the map
	results.onpointerover = (e) => {
		if (e.pointerType !== "mouse") return;
		const li = (e.target as HTMLElement).closest<HTMLElement>("li.result");
		if (!li || li === results.hoverRow) return;
		results.hoverRow = li;
		clearTimeout(results.hoverTimer);
		results.hoverTimer = setTimeout(() => previewRow(li), HOVER_MS);
	};
	results.onpointerout = (e) => {
		const row = results.hoverRow;
		if (
			row &&
			(e.target as HTMLElement).closest("li.result") === row &&
			!row.contains(e.relatedTarget as Node | null)
		) {
			clearTimeout(results.hoverTimer);
			results.hoverRow = null;
		}
	};
	results.onpointerleave = () => {
		clearTimeout(results.hoverTimer);
		results.hoverRow = null;
		endPreview();
	};
	resultsBar.onclick = (e) => {
		const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-scope]");
		if (b) {
			state.search.scope = b.dataset.scope;
			runSearch();
		}
	};
	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		if (!target.closest("#row-menu, .row-menu-btn")) closeRowMenu();
		if (!target.closest(".profile-row")) menu.hidden = true;
		if (!target.closest(".preset-row")) presetMenu.hidden = true;
		if (!target.closest("#side-more")) {
			const smm = $("#side-more-menu");
			if (smm && !smm.hidden) {
				smm.hidden = true;
				$("#side-more-btn")?.setAttribute("aria-expanded", "false");
			}
		}
		closeCtxIfOutside(e);
	});

	$("#detail-close")!.onclick = closeDetail;
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			closeCtx();
			closeRowMenu();
			const smm = $("#side-more-menu");
			if (smm && !smm.hidden) {
				smm.hidden = true;
				$("#side-more-btn")?.setAttribute("aria-expanded", "false");
			}
		}
	});
	addEventListener("resize", closeRowMenu);
	document.addEventListener(
		"scroll",
		(e) => {
			if (!(e.target as HTMLElement).closest?.("#row-menu")) closeRowMenu();
		},
		true,
	);
	$("#detail-back")!.onclick = goBack;
	addEventListener("popstate", onPopState);
	// hovering a link in the card moves the map to what it points at, as hovering a search result does
	const detailBody = $<DetailBodyElement>("#detail-body")!;
	// (mouse only, and after a moment of rest: see results.onpointerover)
	detailBody.addEventListener("pointerover", (e: PointerEvent) => {
		if (e.pointerType !== "mouse") return;
		const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-loc]");
		if (!a || a === detailBody.hoverLink || a === detailBody.pendingLink) return;
		detailBody.hoverLink = a;
		clearTimeout(detailBody.hoverTimer);
		detailBody.hoverTimer = setTimeout(() => {
			if (detailBody.hoverLink === a) previewAt(state.byId.get(Number(a.dataset.loc)));
		}, HOVER_MS);
	});
	detailBody.addEventListener("pointerout", (e: PointerEvent) => {
		const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-loc]");
		if (a && !a.contains(e.relatedTarget as Node | null)) {
			if (a === detailBody.pendingLink) detailBody.pendingLink = null;
			if (a === detailBody.hoverLink) {
				clearTimeout(detailBody.hoverTimer);
				detailBody.hoverLink = null;
			}
		}
	});
	detailBody.addEventListener("pointerleave", () => {
		clearTimeout(detailBody.hoverTimer);
		detailBody.hoverLink = null;
		endPreview();
	});
	document.addEventListener(
		"pointermove",
		(e) => {
			setLastPointer({ x: e.clientX, y: e.clientY });
		},
		{ passive: true },
	);
	detailBody.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		if (target.closest(".found-btn")) return toggleFound(state.selected);
		if (target.closest(".share-btn")) {
			shareMarker(state.selected, target.closest<HTMLElement>(".share-btn"));
			return;
		}
		const um = target.closest<HTMLElement>("[data-um]");
		if (um) return state.um.detailAction(um.dataset.um, state.selected);
		const cross = target.closest<HTMLElement>("a[data-cross-loc]");
		if (cross) {
			e.preventDefault();
			toast("This marker is on another map. Map switching on link follow is planned.", 4000);
			return;
		}
		const a = target.closest<HTMLElement>("a[data-loc]");
		if (a) {
			e.preventDefault();
			endPreview({ restore: false });
			const id = Number(a.dataset.loc);
			if (!state.byId.has(id)) {
				toast("This marker is on another map. Map switching on link follow is planned.", 4000);
				return;
			}
			return select(id);
		}
		const img = target.closest<HTMLImageElement>(".shots img");
		if (img) {
			const lb = $("#lightbox")!;
			lb.querySelector<HTMLImageElement>("img")!.src = img.src;
			lb.hidden = false;
		}
	});
	$("#lightbox")!.onclick = () => {
		$("#lightbox")!.hidden = true;
	};
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		const lb = $("#lightbox")!;
		if (!lb.hidden) lb.hidden = true;
		else if (!$<HTMLDialogElement>("#dlg")!.open && state.selected != null && document.activeElement !== search)
			closeDetail();
	});

	$("#side-toggle")!.onclick = () => document.body.classList.add("side-open");
	// the list's close button: it closes the panel, or while searching it closes the search (see syncSideClose)
	$("#side-close")!.onclick = () => {
		if (state.search.active) {
			$<HTMLInputElement>("#search")!.value = "";
			leaveSearch();
		} else document.body.classList.remove("side-open");
	};
	$("#side-collapse")!.onclick = () => setSideCollapsed(!document.body.classList.contains("side-collapsed"));

	addEventListener("online", () => setOnlineStatus(true));
	addEventListener("offline", () => setOnlineStatus(false));
	if (typeof navigator !== "undefined" && !navigator.onLine) {
		setOnlineStatus(false);
	}

	addEventListener("pagehide", () => {
		saveSession();
		rememberCamera(true);
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") rememberCamera(true);
	});
}

if (typeof document !== "undefined") {
	wire();
	boot().catch((e) => fatal(e.message));
}