// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// The sign-in page: Google (the server does the redirect and checks the ID token), or a secret key. Either way the server sets the session.
import { cleanSecretChars, formatSecretKey, validateSecretKey } from "../shared/secret-key.ts";
import "./theme.ts";

export { cleanSecretChars, formatSecretKey, validateSecretKey };

if (typeof document !== "undefined") {
	const rawNext = typeof location !== "undefined" ? new URLSearchParams(location.search).get("next") || "" : "";
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
		if (!e) return;
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

	const secretInput = $<HTMLInputElement>("secret-input");
	const loginBtn = $("secret-login-btn");

	let autoSubmitting = false;

	if (secretInput) {
		secretInput.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (e.key === "Tab" || e.key === "Enter" || e.key === "Escape") return;
			if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") return;

			// If the user types a dash manually, do not insert it
			if (e.key === "-" || e.key === "–" || e.key === "—") {
				e.preventDefault();
				return;
			}

			// Backspace across a dash
			if (e.key === "Backspace" && secretInput.selectionStart === secretInput.selectionEnd) {
				const pos = secretInput.selectionStart || 0;
				if (pos > 0 && secretInput.value[pos - 1] === "-") {
					e.preventDefault();
					const before = secretInput.value.slice(0, pos - 2);
					const after = secretInput.value.slice(pos);
					secretInput.value = before + after;
					onSecretInput();
					return;
				}
			}

			// Single printable character
			if (e.key.length === 1) {
				if (!/[0-9a-zA-Z]/.test(e.key)) {
					e.preventDefault();
					return;
				}
				const clean = cleanSecretChars(secretInput.value);
				const hasSelection = (secretInput.selectionEnd ?? 0) > (secretInput.selectionStart ?? 0);
				if (clean.length >= 30 && !hasSelection) {
					e.preventDefault();
					return;
				}
			}
		});

		function onSecretInput(): void {
			showError("");
			const prevVal = secretInput.value;
			const prevPos = secretInput.selectionStart ?? prevVal.length;

			let cleanBefore = 0;
			for (let i = 0; i < prevPos; i++) {
				if (/[0-9a-zA-Z]/.test(prevVal[i])) cleanBefore++;
			}
			cleanBefore = Math.min(cleanBefore, 30);

			const formatted = formatSecretKey(prevVal);
			secretInput.value = formatted;

			let newPos = 0;
			let seenClean = 0;
			while (newPos < formatted.length && seenClean < cleanBefore) {
				if (formatted[newPos] !== "-") seenClean++;
				newPos++;
			}
			secretInput.setSelectionRange(newPos, newPos);

			const clean = cleanSecretChars(formatted);
			if (clean.length === 30) {
				const v = validateSecretKey(clean);
				if (!v.valid) {
					loginBtn?.setAttribute("aria-disabled", "true");
					showError(v.error);
				} else {
					loginBtn?.setAttribute("aria-disabled", "false");
					if (!autoSubmitting) {
						autoSubmitting = true;
						void submitLogin();
					}
				}
			} else {
				autoSubmitting = false;
				loginBtn?.setAttribute("aria-disabled", "true");
			}
		}

		secretInput.addEventListener("input", onSecretInput);
	}

	function tryLogin(): void {
		showError("");
		const clean = secretInput ? cleanSecretChars(secretInput.value) : "";
		if (clean.length === 0) {
			showError("Please enter your secret key.");
			secretInput?.focus();
			return;
		}
		if (clean.length < 30) {
			showError(`Please enter a complete 30-character secret key (${clean.length}/30 entered).`);
			secretInput?.focus();
			return;
		}
		const v = validateSecretKey(clean);
		if (!v.valid) {
			showError(v.error);
			secretInput?.focus();
			return;
		}
		void submitLogin();
	}

	async function submitLogin(): Promise<void> {
		if (loginBtn) (loginBtn as HTMLButtonElement).disabled = true;
		showError("");
		try {
			await api("POST", "auth/secret/login", { secret: secretInput.value });
			done();
		} catch (err: any) {
			autoSubmitting = false;
			showError(err.message);
		} finally {
			if (loginBtn) (loginBtn as HTMLButtonElement).disabled = false;
		}
	}

	loginBtn?.addEventListener("click", (e) => {
		if (loginBtn.getAttribute("aria-disabled") === "true") {
			e.preventDefault();
			tryLogin();
		}
	});

	$("secret-login").onsubmit = async (e) => {
		e.preventDefault();
		const clean = secretInput ? cleanSecretChars(secretInput.value) : "";
		if (clean.length === 30 && validateSecretKey(clean).valid) {
			await submitLogin();
		} else {
			tryLogin();
		}
	};
}