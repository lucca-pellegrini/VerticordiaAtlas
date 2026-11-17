// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Offline map viewer entrypoint. Orchestrates boot, account sync, and top-level event wiring.

import { esc } from "../shared/escape.ts";
import { accountSlot, api, currentUser, initAccount, legalLinks, setOnlineStatus, socketUrl } from "./account.ts";
import { dbAll, emptyProfile, openDB, setMeta, syncStore } from "./map/db.ts";
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
	addMarkerToGuide,
	closeGuideMenuIfOpen,
	closeGuidePanelIfOpen,
	exitGuideAddStepsIfActive,
	flushGuideSaves,
	importGuideFile,
	isGuideSyncKeyUnsaved,
	jumpToGuideStep,
	onGuideRemoteConflictPending,
	reloadGuidesFromStore,
	setGuideConflictFlush,
	stepActiveGuideCursor,
} from "./map/guides.ts";
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
	cancelSearchDebounce,
	debounceSearch,
	endPreview,
	HOVER_MS,
	leaveSearch,
	moveSearch,
	openResult,
	previewAt,
	previewRow,
	runSearch,
	showMoreResults,
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
setSyncNote((keys) => syncer?.noteLocal(keys));

let accountReady: Promise<any> = Promise.resolve(null);

export async function startAccountSync(): Promise<void> {
	await accountReady;
	if (!currentUser()) return;
	syncer = createSync({
		store: {
			...syncStore,
			isUnsaved: isGuideSyncKeyUnsaved,
		},
		api,
		socketUrl,
		ui: {
			status: ({ online }) => setOnlineStatus(online),
			conflicts: (list) => showConflicts(list),
			deferredConflict: (list) => {
				for (const item of list) onGuideRemoteConflictPending(item.key);
				if (list.length) {
					toast(
						`Remote update arrived for ${list.map((i) => i.label).join(", ")}. Your local edits were kept; save to resolve.`,
						5000,
					);
				}
			},
			remoteChanged: async (keys) => {
				await refreshFromStore(keys);
				if (keys.length) toast("Updated from your other device.");
			},
			signedOut: () => location.reload(),
		},
	});
	setGuideConflictFlush(() => syncer?.flushDeferredConflicts());
	syncer.start();
}

// the open screen follows what sync wrote into IndexedDB (the profile, its presets and view), so nothing stale is saved over it
export async function refreshFromStore(keys: string[]): Promise<void> {
	const gid = state.entry?.id;
	if (!gid || !state.profile) return;
	if (keys.some((k) => k.startsWith(`guide:${gid}:`))) {
		await reloadGuidesFromStore(gid);
	}
	if (keys.some((k) => k.startsWith(`profile:${gid}:`))) {
		state.profiles = (await dbAll("profiles")).filter((p) => p.game === gid).sort((a, b) => a.created - b.created);
		// a new device starts with an empty profile of its own (deleted by adoptOverPlaceholders when the account's
		// profiles arrive): only when the open profile is gone do we pick the arriving profile with progress
		let cur = state.profiles.find((p: any) => p.id === state.profile.id);
		const replaced = !cur;
		if (!cur) {
			cur =
				state.profiles
					.filter((p: any) => !emptyProfile(p))
					.sort((x: any, y: any) => (y.updated || 0) - (x.updated || 0))[0] || state.profiles[0];
			if (cur) void setMeta("last-profile:" + gid, cur.id).catch(() => {});
		}
		if (cur) {
			if (!replaced && !keys.includes(`profile:${gid}:${cur.id}`)) {
				const idx = state.profiles.findIndex((p: any) => p.id === cur.id);
				if (idx >= 0) state.profiles[idx] = state.profile;
				renderProfileSelect();
			} else {
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
	}
	if (keys.some((k) => k === `meta:${presetsKey()}`)) await loadMapState();
	if (typeof document !== "undefined") refreshAll();
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
	const importGuideInput = $<HTMLInputElement>("#import-guide-file");
	if (importGuideInput) {
		importGuideInput.onchange = (e) => {
			const input = e.target as HTMLInputElement;
			const f = input.files?.[0];
			input.value = "";
			if (f) importGuideFile(f);
		};
	}

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
		for (const { rows } of state.ui?.groups.values() || []) {
			for (const { row, cb } of rows) {
				cb.checked = true;
				row.classList.remove("off");
			}
		}
		onViewChanged();
	};
	$("#hide-all")!.onclick = () => {
		state.cats.forEach((c: any) => state.view.hidden.add(c.id));
		for (const { rows } of state.ui?.groups.values() || []) {
			for (const { row, cb } of rows) {
				cb.checked = false;
				row.classList.add("off");
			}
		}
		onViewChanged();
	};

	const search = $<HTMLInputElement>("#search")!;
	const results = $<ResultsElement>("#results")!;
	const resultsBar = $("#results-bar")!;
	search.oninput = () => debounceSearch(() => runSearch());
	search.onfocus = () => {
		if (search.value.trim()) {
			cancelSearchDebounce();
			runSearch();
		}
	};
	search.onkeydown = (e) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			moveSearch(e.key === "ArrowDown" ? 1 : -1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			cancelSearchDebounce();
			const all = results.querySelectorAll<HTMLElement>("li.result");
			const target = state.search.idx >= 0 ? all[state.search.idx] : all[0];
			if (target) openResult(target);
			else if (search.value.trim()) runSearch();
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
		// [ and ] move to the previous or next step while a guide is open and focus is not in a text field
		if (
			!state.guide?.panelOpen ||
			e.ctrlKey ||
			e.metaKey ||
			e.altKey ||
			(e.key !== "[" && e.key !== "]") ||
			$<HTMLDialogElement>("#dlg")!.open
		)
			return;
		const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
		if (typing) return;
		e.preventDefault();
		stepActiveGuideCursor(e.key === "]" ? 1 : -1);
	});
	results.onclick = (e) => {
		const target = e.target as HTMLElement;
		if (target.closest("#results-more-btn")) {
			showMoreResults();
			return;
		}
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
	addEventListener("resize", () => {
		closeRowMenu();
		closeGuideMenuIfOpen();
	});
	document.addEventListener(
		"scroll",
		(e) => {
			if (!(e.target as HTMLElement).closest?.("#row-menu, #guide-row-menu")) {
				closeRowMenu();
				closeGuideMenuIfOpen();
			}
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
		const jumpGuideBtn = target.closest<HTMLElement>("button[data-jump-guide][data-jump-step]");
		if (jumpGuideBtn) {
			void jumpToGuideStep(jumpGuideBtn.dataset.jumpGuide!, jumpGuideBtn.dataset.jumpStep!);
			return;
		}
		if (target.closest(".found-btn:not(.gs-done-btn)")) return toggleFound(state.selected);
		const guideAddBtn = target.closest<HTMLElement>(".guide-add-btn");
		if (guideAddBtn) {
			const loc = state.byId.get(state.selected);
			if (loc) {
				const r = guideAddBtn.getBoundingClientRect();
				const x = e.clientX || Math.round(r.left + r.width / 2);
				const y = e.clientY || Math.round(r.top + r.height / 2);
				void addMarkerToGuide(loc, x, y);
			}
			return;
		}
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
	// Escape closes one layer at a time, innermost first:
	// 1. dialog (#dlg) -> 2. menus -> 3. lightbox -> 4. detail / step card -> 5. search -> 6. guide panel
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || $<HTMLDialogElement>("#dlg")!.open) return;

		const ctxEl = document.getElementById("ctx-menu");
		const rowEl = document.getElementById("row-menu");
		const gRowEl = document.getElementById("guide-row-menu");
		const smm = $("#side-more-menu");
		const hasOpenMenu =
			(ctxEl && !ctxEl.hidden) ||
			(rowEl && !rowEl.hidden) ||
			(gRowEl && !gRowEl.hidden) ||
			(smm && !smm.hidden) ||
			!menu.hidden ||
			!presetMenu.hidden;
		if (hasOpenMenu) {
			closeCtx();
			closeRowMenu();
			closeGuideMenuIfOpen();
			menu.hidden = true;
			presetMenu.hidden = true;
			if (smm && !smm.hidden) {
				smm.hidden = true;
				$("#side-more-btn")?.setAttribute("aria-expanded", "false");
			}
			return;
		}

		const lb = $("#lightbox")!;
		if (!lb.hidden) {
			lb.hidden = true;
			return;
		}

		if (exitGuideAddStepsIfActive()) return;

		if ((state.selected != null || state.guide?.selectedStepId != null) && document.activeElement !== search) {
			closeDetail();
			return;
		}

		if (state.search.active) {
			search.value = "";
			leaveSearch();
			return;
		}

		if (state.guide?.panelOpen) {
			closeGuidePanelIfOpen();
		}
	});

	$("#side-toggle")!.onclick = () => document.body.classList.add("side-open");
	// the list's close button: it closes the panel, or while searching/guiding it closes the search or guide
	$("#side-close")!.onclick = () => {
		if (state.search.active) {
			$<HTMLInputElement>("#search")!.value = "";
			leaveSearch();
		} else if (state.guide?.panelOpen) {
			closeGuidePanelIfOpen();
		} else {
			document.body.classList.remove("side-open");
		}
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
		void flushGuideSaves();
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") rememberCamera(true);
	});
}

if (typeof document !== "undefined") {
	wire();
	boot().catch((e) => fatal(e.message));
}