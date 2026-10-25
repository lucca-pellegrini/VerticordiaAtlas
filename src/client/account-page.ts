// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// account-page.ts: the /account/ page. Shows signed-in account details, session controls, account deletion, and
// device-local offline maps.

import { esc, fmt } from "../shared/escape.ts";
import type { UserAccount } from "../shared/types.ts";
import { api, notify, SIGNED_IN_KEY } from "./account.ts";
import {
	clearAllOfflineMaps,
	downloadOfflineMap,
	inspectOfflineManifests,
	type OfflineManifest,
	removeOfflineMap,
} from "./offline.ts";
import "./theme.ts";

export function providerLabel(provider: UserAccount["provider"]): string {
	return provider === "google" ? "Google" : "Secret key";
}

export function formatAccountDate(ts: number | undefined): string {
	if (!ts || !Number.isFinite(ts) || ts <= 0) return "—";
	try {
		return new Date(ts).toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		return "—";
	}
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function renderAccountInfoHtml(u: UserAccount): string {
	const who = u.email || u.name || "Your account";
	const method = providerLabel(u.provider);
	const created = formatAccountDate(u.createdAt);
	const sessions = typeof u.sessions === "number" ? fmt(u.sessions) : "1";
	const synced = typeof u.syncedItems === "number" ? fmt(u.syncedItems) : "0";
	return (
		`<div class="kv-grid">` +
		`<div class="kv-item kv-account"><span class="kv-label">Account</span><span class="kv-val" title="${esc(who)}">${esc(who)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Sign-in method</span><span class="kv-val">${esc(method)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Created</span><span class="kv-val">${esc(created)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Active sessions</span><span class="kv-val">${esc(sessions)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Synced records</span><span class="kv-val">${esc(synced)}</span></div>` +
		`</div>`
	);
}

export function renderOfflineListHtml(
	items: { manifest: OfflineManifest; cachedCount: number; intact: boolean }[],
): string {
	if (!items.length) {
		return `<p class="small muted">No maps are currently kept offline on this device.</p>`;
	}
	return items
		.map(({ manifest: m, cachedCount, intact }) => {
			const href = `../maps/${encodeURIComponent(m.game)}/?map=${encodeURIComponent(m.map)}`;
			const statusText = intact
				? `${fmt(m.expectedCount)} files · ${formatBytes(m.totalBytes)} · Verified ${formatAccountDate(m.lastVerified)}`
				: `${fmt(cachedCount)} of ${fmt(m.expectedCount)} files cached (${formatBytes(m.totalBytes)} expected) · Missing data`;
			const repairBtn = intact
				? ""
				: `<button type="button" class="ghost" data-repair-game="${esc(m.game)}" data-repair-map="${esc(m.map)}">Repair</button>`;
			return (
				`<div class="offline-item" data-offline-row="${esc(m.k)}">` +
				`<div class="offline-item-info">` +
				`<a class="offline-item-title" href="${esc(href)}">${esc(m.gameTitle)} · ${esc(m.mapTitle)}</a>` +
				`<span class="offline-item-meta">${esc(statusText)}</span>` +
				`</div>` +
				`<div class="btn-row">` +
				repairBtn +
				`<button type="button" class="ghost danger-btn" data-remove-game="${esc(m.game)}" data-remove-map="${esc(m.map)}">Remove</button>` +
				`</div>` +
				`</div>`
			);
		})
		.join("");
}

if (typeof document !== "undefined") {
	const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

	const showError = (msg: string) => {
		const el = $("account-error");
		el.textContent = msg;
		el.hidden = !msg;
	};

	const renderUserState = (u: UserAccount | null, offlineFallback = false) => {
		const badge = $("account-badge");
		const body = $("account-body");
		const actions = $("account-actions");
		const signedOutActions = $("account-signedout-actions");
		const dangerSection = $("danger-section");

		if (u) {
			badge.textContent = offlineFallback ? "Signed in (offline)" : "Signed in";
			badge.classList.add("active");
			body.innerHTML = renderAccountInfoHtml(u);
			actions.hidden = false;
			signedOutActions.hidden = true;
			dangerSection.hidden = false;
		} else {
			badge.textContent = "Not signed in";
			badge.classList.remove("active");
			body.innerHTML = `<p class="small">You are not signed in on this browser. Your map progress is stored locally on this device. Sign in if you want to synchronize progress across devices.</p>`;
			actions.hidden = true;
			signedOutActions.hidden = false;
			dangerSection.hidden = true;
			const rawNext = new URLSearchParams(location.search).get("next");
			const signinBtn = $<HTMLAnchorElement>("btn-signin");
			if (rawNext && /^\/(?!\/)/.test(rawNext)) {
				signinBtn.href = `../signin/?next=${encodeURIComponent(rawNext)}`;
			} else {
				signinBtn.href = "../signin/?next=%2Faccount%2F";
			}
		}
	};

	async function loadAccountPage(): Promise<void> {
		try {
			const { user } = await api("GET", "me");
			if (user) localStorage.setItem(SIGNED_IN_KEY, JSON.stringify(user));
			else localStorage.removeItem(SIGNED_IN_KEY);
			renderUserState(user, false);
		} catch {
			let cached: UserAccount | null = null;
			try {
				cached = JSON.parse(localStorage.getItem(SIGNED_IN_KEY) || "null");
			} catch {}
			renderUserState(cached, true);
		}
	}

	let logoutAllArmed = false;

	$("btn-logout").onclick = async () => {
		showError("");
		try {
			await api("POST", "auth/logout");
		} catch {}
		localStorage.removeItem(SIGNED_IN_KEY);
		notify("Logged out on this device.");
		renderUserState(null);
	};

	$("btn-logout-all").onclick = async () => {
		showError("");
		const btn = $<HTMLButtonElement>("btn-logout-all");
		if (!logoutAllArmed) {
			logoutAllArmed = true;
			btn.textContent = "Click again to log out everywhere";
			setTimeout(() => {
				if (logoutAllArmed) {
					logoutAllArmed = false;
					btn.textContent = "Log out from all devices";
				}
			}, 4000);
			return;
		}
		logoutAllArmed = false;
		btn.textContent = "Log out from all devices";
		try {
			await api("POST", "auth/logout-all");
			localStorage.removeItem(SIGNED_IN_KEY);
			notify("Logged out from all devices.");
			renderUserState(null);
		} catch (e: any) {
			showError(e.network ? "Cannot reach the server while offline." : e.message || "Could not log out.");
		}
	};

	$("btn-delete-account").onclick = () => {
		showError("");
		$("delete-initial-row").hidden = true;
		$("delete-confirm-box").hidden = false;
	};

	$("btn-delete-cancel").onclick = () => {
		$("delete-confirm-box").hidden = true;
		$("delete-initial-row").hidden = false;
	};

	$("btn-delete-confirm").onclick = async () => {
		showError("");
		const confirmBtn = $<HTMLButtonElement>("btn-delete-confirm");
		confirmBtn.disabled = true;
		try {
			await api("POST", "auth/delete-account");
			localStorage.removeItem(SIGNED_IN_KEY);
			$("delete-confirm-box").hidden = true;
			$("delete-initial-row").hidden = false;
			renderUserState(null);
			notify("Your account and server-synced data have been deleted.");
		} catch (e: any) {
			showError(
				e.network
					? "Cannot delete your account while offline. Please reconnect and try again."
					: e.message || "Could not delete account.",
			);
		} finally {
			confirmBtn.disabled = false;
		}
	};

	async function refreshOfflineSection(): Promise<void> {
		const badge = $("offline-badge");
		const listEl = $("offline-list");
		const actionsEl = $("offline-actions");
		try {
			const items = await inspectOfflineManifests();
			const totalBytes = items.reduce((sum, x) => sum + (x.intact ? x.manifest.totalBytes : 0), 0);
			if (!items.length) {
				badge.textContent = "0 maps";
				badge.classList.remove("active");
				actionsEl.hidden = true;
			} else {
				badge.textContent = `${fmt(items.length)} map${items.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`;
				badge.classList.add("active");
				actionsEl.hidden = false;
			}
			listEl.innerHTML = renderOfflineListHtml(items);
		} catch {
			badge.textContent = "0 maps";
			listEl.innerHTML = `<p class="small muted">Offline storage is unavailable in this browser mode.</p>`;
			actionsEl.hidden = true;
		}
	}

	$("offline-list").addEventListener("click", async (e) => {
		const target = e.target as HTMLElement | null;
		if (!target) return;
		const rem = target.closest<HTMLButtonElement>("button[data-remove-game]");
		if (rem) {
			const game = rem.dataset.removeGame!;
			const map = rem.dataset.removeMap!;
			rem.disabled = true;
			await removeOfflineMap(game, map);
			notify("Removed offline map data from this device.");
			await refreshOfflineSection();
			return;
		}
		const rep = target.closest<HTMLButtonElement>("button[data-repair-game]");
		if (rep) {
			const game = rep.dataset.repairGame!;
			const map = rep.dataset.repairMap!;
			rep.disabled = true;
			rep.textContent = "Repairing…";
			try {
				await downloadOfflineMap({
					gameSlug: game,
					mapSlug: map,
					onStatus: (st) => {
						rep.textContent =
							st.phase === "preparing"
								? "Preparing…"
								: `Downloading ${st.total ? Math.min(100, Math.round((st.done / st.total) * 100)) : 0}%…`;
					},
				});
				notify("Offline map repaired.");
			} catch (err: any) {
				notify(err.message || "Could not repair offline map.");
			}
			await refreshOfflineSection();
		}
	});

	let clearOfflineArmed = false;
	$("btn-clear-offline").onclick = async () => {
		const btn = $<HTMLButtonElement>("btn-clear-offline");
		if (!clearOfflineArmed) {
			clearOfflineArmed = true;
			btn.textContent = "Click again to clear all offline data";
			setTimeout(() => {
				if (clearOfflineArmed) {
					clearOfflineArmed = false;
					btn.textContent = "Clear all offline data";
				}
			}, 4000);
			return;
		}
		clearOfflineArmed = false;
		btn.textContent = "Clear all offline data";
		btn.disabled = true;
		try {
			await clearAllOfflineMaps();
			notify("Cleared all offline maps on this device.");
			await refreshOfflineSection();
		} finally {
			btn.disabled = false;
		}
	};

	loadAccountPage();
	refreshOfflineSection();
}