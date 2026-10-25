// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// The sign-in page: Google (the server does the redirect and checks the ID token), or a secret key. Either way the server sets the session.
import "./theme.ts";

const rawNext = new URLSearchParams(location.search).get("next") || "";
// only a path on this site: "/x" (not "//host") or nothing
const nextPath = /^\/(?!\/)/.test(rawNext) ? rawNext : "/";
const next = nextPath === "/" ? "../" : nextPath;

const api = (method: string, path: string, body?: unknown): Promise<any> =>
	fetch(new URL("../api/" + path, location.href), {
		method,
		cache: "no-store",
		credentials: "same-origin",
		headers: body !== undefined ? { "Content-Type": "application/json" } : {},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	}).then(async (r) => {
		const data = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(data.error || "Something went wrong.");
		return data;
	});

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const showError = (msg: string) => {
	const e = $("secret-error");
	e.textContent = msg;
	e.hidden = !msg;
};
const done = () => {
	location.href = next;
};

/* ---------- Google: our own button; the server sends the browser to Google and back (see api.ts) ---------- */
async function setupGoogle(): Promise<void> {
	const error = new URLSearchParams(location.search).get("error");
	if (error) {
		$("google-error").textContent = error;
		$("google-error").hidden = false;
	}
	let configured = false;
	try {
		configured = !!(await api("GET", "config")).googleClientId;
	} catch {
		/* offline: no Google */
	}
	if (!configured) {
		$("google-off").hidden = false;
		return;
	}
	const btn = $<HTMLAnchorElement>("google-btn");
	btn.href = `../api/auth/google/start?next=${encodeURIComponent(nextPath)}`;
	btn.hidden = false;
}
setupGoogle();

/* ---------- secret keys ---------- */
$("toggle-secret").onclick = () => {
	const open = $("secret-panel").hidden;
	$("secret-panel").hidden = !open;
	$("toggle-secret").setAttribute("aria-expanded", String(open));
};

let currentSecret = "";
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

$("secret-new").onclick = async () => {
	showError("");
	try {
		const { secret } = await api("POST", "auth/secret/new", {});
		currentSecret = secret;
		$("secret-value").textContent = secret;
		$("secret-shown").hidden = false;
		$("secret-new").hidden = true;
	} catch (e: any) {
		showError(e.message);
	}
};

const copyBtn = $("secret-copy");
if (copyBtn) {
	copyBtn.onclick = async () => {
		const text = $("secret-value").textContent || "";
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			copyBtn.classList.remove("copied");
			void copyBtn.offsetWidth;
			copyBtn.classList.add("copied");
			copyBtn.title = "Key copied";
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copyBtn.classList.remove("copied");
				copyBtn.title = "Copy to clipboard";
			}, 1800);
		} catch {
			const range = document.createRange();
			range.selectNodeContents($("secret-value"));
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
		}
	};
}

$<HTMLInputElement>("secret-saved").onchange = (e) => {
	$<HTMLButtonElement>("secret-continue").disabled = !(e.target as HTMLInputElement).checked;
};

$("secret-continue").onclick = async () => {
	if (!currentSecret) return;
	const btn = $<HTMLButtonElement>("secret-continue");
	btn.disabled = true;
	showError("");
	try {
		await api("POST", "auth/secret/confirm", { secret: currentSecret });
		done();
	} catch (err: any) {
		btn.disabled = false;
		showError(err.message);
	}
};

$("secret-login").onsubmit = async (e) => {
	e.preventDefault();
	showError("");
	try {
		await api("POST", "auth/secret/login", { secret: $<HTMLInputElement>("secret-input").value });
		done();
	} catch (err: any) {
		showError(err.message);
	}
};