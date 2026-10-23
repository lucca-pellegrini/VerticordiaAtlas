// account.ts: optional sign-in for every page. It shows the account button (on the home page, and at the bottom of a
// map's side panel), the offline indicator (only for signed-in users), and registers the offline cache.
// Signing in never changes what the app does; it only lets progress sync between devices (see sync.ts).

import { esc } from "../shared/escape.ts";
import type { UserAccount } from "../shared/types.ts";

const ROOT = new URL("./", import.meta.url);
const SIGNED_IN_KEY = "va-account";

// the server's API. A failure to reach it is thrown with network: true, so the caller can tell "offline" from "refused"
export async function api(method: string, path: string, body?: unknown): Promise<any> {
	let res: Response;
	const rel = String(path)
		.replace(/^\/+/, "")
		.replace(/^api\//, "");
	try {
		res = await fetch(new URL("api/" + rel, ROOT), {
			method,
			cache: "no-store",
			credentials: "same-origin",
			headers: body !== undefined ? { "Content-Type": "application/json" } : {},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch {
		throw Object.assign(new Error("network"), { network: true });
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
	return data;
}

// where the live-update socket lives: the same server, over ws:// or wss://
export function socketUrl(client: string): string {
	const u = new URL("api/ws", ROOT);
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
	u.search = new URLSearchParams({ c: client }).toString();
	return u.href;
}

let user: UserAccount | null = null;
let toastFn: ((msg: string, ms?: number) => void) | null = null;
let netBox: HTMLDivElement | null = null;
export const currentUser = (): UserAccount | null => user;

const ICON: Record<string, string> = {
	user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
	out: '<path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
	all: '<rect x="3" y="4" width="13" height="10" rx="2"/><path d="M7 20h5M9 14v6M18 9h3v11h-3"/>',
	cloudOff: '<path d="M3 3l18 18M8.5 8.6A6 6 0 0 0 6 19h11a4 4 0 0 0 1.4-7.7A6 6 0 0 0 12 6c-.7 0-1.4.1-2 .3"/>',
};
const svg = (name: string, cls = "i"): string =>
	`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

export const signinUrl = (): string =>
	new URL("signin/", ROOT).href + "?next=" + encodeURIComponent(location.pathname + location.search);

function menuMarkup(u: UserAccount): string {
	return (
		`<div class="acct" data-acct-menu>` +
		`<button type="button" class="acct-btn" aria-haspopup="menu" aria-expanded="false">${svg("user")}<span>My Account</span></button>` +
		`<div class="acct-menu" role="menu" hidden>` +
		`<p class="acct-who">Signed in as:<strong>${esc(u.email || u.name || "your account")}</strong></p>` +
		`<button type="button" role="menuitem" data-act="logout">${svg("out")}<span>Log out</span></button>` +
		`<button type="button" role="menuitem" data-act="logout-all" class="danger">${svg("all")}<span>Log out from all devices</span></button>` +
		`</div></div>`
	);
}

// the slots: [data-account] on the home page, and the side panel's bottom
function renderAccount(): void {
	const signinMarkup = `<a class="acct-btn" href="${esc(signinUrl())}">${svg("user")}<span>Sign in</span></a>`;
	document.querySelectorAll("[data-account]").forEach((slot) => {
		slot.innerHTML = user ? menuMarkup(user) : signinMarkup;
	});
}

// the legal pages, discreet, at the foot of the side panel (and of the home page, as plain links there)
export function legalLinks(): HTMLDivElement {
	const wrap = document.createElement("div");
	wrap.className = "side-footer";
	wrap.innerHTML = `<p class="legal-links"><a href="${new URL("about/", ROOT).pathname}">About</a><span class="sep" aria-hidden="true">·</span><a href="${new URL("terms/", ROOT).pathname}">Terms of service</a><span class="sep" aria-hidden="true">·</span><a href="${new URL("privacy/", ROOT).pathname}">Privacy policy</a></p><p class="foot-motto" lang="la"><em>Nisi Dominus frustra</em></p>`;
	return wrap;
}

// a new slot, for the side panel (the caller places it)
export function accountSlot(variant: "side" | "top" = "side"): HTMLDivElement {
	const el = document.createElement("div");
	el.className = variant === "top" ? "acct-slot top" : "acct-slot";
	el.dataset.account = "";
	return el;
}

export async function loadAccount(): Promise<UserAccount | null> {
	try {
		const { user: u } = await api("GET", "me");
		user = u;
		if (u) localStorage.setItem(SIGNED_IN_KEY, JSON.stringify(u));
		else localStorage.removeItem(SIGNED_IN_KEY);
	} catch {
		try {
			user = JSON.parse(localStorage.getItem(SIGNED_IN_KEY) || "null");
		} catch {
			user = null;
		}
	}
	renderAccount();
	return user;
}

/* ---------- the offline indicator: small, and only for signed-in users ---------- */
function indicator(): HTMLDivElement {
	if (!netBox) {
		netBox = document.createElement("div");
		netBox.id = "net-status";
		netBox.className = "net-status";
		netBox.setAttribute("role", "status");
		netBox.title = "Your progress is saved on this device and will sync when the connection returns";
		netBox.hidden = true;
		netBox.innerHTML = `${svg("cloudOff")}<span>Offline</span>`;
		document.body.appendChild(netBox);
	}
	return netBox;
}
let warnedThisSession = false;
export function setOnlineStatus(online: boolean): void {
	const box = indicator();
	box.hidden = online || !user;
	if (!online && user && !warnedThisSession && !sessionStorage.getItem("va-offline-warned")) {
		warnedThisSession = true;
		sessionStorage.setItem("va-offline-warned", "1");
		notify("You're offline. Your progress is safe on this device and will sync when the connection returns.", 6000);
	}
}
export function notify(msg: string, ms = 2600): void {
	if (toastFn) return toastFn(msg, ms);
	const t = document.getElementById("toast");
	if (!t) return;
	t.textContent = msg;
	t.hidden = false;
	setTimeout(() => {
		t.hidden = true;
	}, ms);
}

/* ---------- the menu ---------- */
let armed: HTMLElement | null = null;
async function logout(all: boolean): Promise<void> {
	try {
		await api("POST", all ? "auth/logout-all" : "auth/logout");
	} catch {
		/* offline: the cookie stays until we can reach the server */
	}
	localStorage.removeItem(SIGNED_IN_KEY);
	location.reload();
}

export function initAccount({
	toast,
}: { toast?: (msg: string, ms?: number) => void } = {}): Promise<UserAccount | null> {
	toastFn = toast || null;
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker.register(new URL("sw.js", ROOT), { scope: ROOT.pathname }).catch(() => {});
	}
	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement | null;
		if (!target) return;
		const btn = target.closest<HTMLElement>(".acct-btn");
		const menu = target.closest<HTMLElement>("[data-acct-menu]");
		if (btn && menu) {
			const mEl = menu.querySelector<HTMLElement>(".acct-menu")!;
			const open = mEl.hidden;
			document.querySelectorAll<HTMLElement>(".acct-menu").forEach((m) => {
				m.hidden = true;
			});
			mEl.hidden = !open;
			btn.setAttribute("aria-expanded", String(open));
			return;
		}
		const act = target.closest<HTMLElement>("[data-act]");
		if (act && act.closest(".acct-menu")) {
			if (act.dataset.act === "logout") return logout(false);
			if (act.dataset.act === "logout-all") {
				if (armed !== act) {
					armed = act;
					act.querySelector("span")!.textContent = "Click again to log out everywhere";
					setTimeout(() => {
						if (armed === act) {
							armed = null;
							act.querySelector("span")!.textContent = "Log out from all devices";
						}
					}, 4000);
					return;
				}
				return logout(true);
			}
		}
		if (!target.closest("[data-acct-menu]"))
			document.querySelectorAll<HTMLElement>(".acct-menu").forEach((m) => {
				m.hidden = true;
			});
	});
	renderAccount();
	return loadAccount();
}