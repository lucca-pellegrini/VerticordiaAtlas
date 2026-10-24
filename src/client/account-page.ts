// account-page.ts: the /account/ page. Shows signed-in account details, session controls, account deletion, and
// device-local offline maps.

import { esc, fmt } from "../shared/escape.ts";
import type { UserAccount } from "../shared/types.ts";
import { api, notify, SIGNED_IN_KEY } from "./account.ts";
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
		`<div class="kv-item"><span class="kv-label">Account</span><span class="kv-val">${esc(who)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Sign-in method</span><span class="kv-val">${esc(method)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Created</span><span class="kv-val">${esc(created)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Active sessions</span><span class="kv-val">${esc(sessions)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Synced records</span><span class="kv-val">${esc(synced)}</span></div>` +
		`</div>`
	);
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

	loadAccountPage();
}