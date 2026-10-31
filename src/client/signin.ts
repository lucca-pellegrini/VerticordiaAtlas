// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// The sign-in page: Google OIDC, email/username + password (with registration, email verification, and password reset),
// or an anonymous 128-bit secret key.
import { cleanSecretChars, formatSecretKey, validateSecretKey } from "../shared/secret-key.ts";
import "./theme.ts";

export { cleanSecretChars, formatSecretKey, validateSecretKey };

type AuthViewName = "login" | "register" | "verify-pending" | "verify-result" | "forgot" | "reset";

if (typeof document !== "undefined") {
	const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
	const rawNext = params.get("next") || "";
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
			if (!r.ok) {
				const err: any = new Error(data.error || "Something went wrong.");
				err.status = r.status;
				err.code = data.code;
				err.field = data.field;
				throw err;
			}
			return data;
		});

	const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
	const showSecretError = (msg: string) => {
		const e = $("secret-error");
		if (!e) return;
		e.textContent = msg;
		e.hidden = !msg;
	};
	const setMsg = (id: string, msg: string) => {
		const el = $(id);
		if (!el) return;
		el.textContent = msg;
		el.hidden = !msg;
	};
	const done = () => {
		location.href = next;
	};

	const VIEWS: Record<AuthViewName, string> = {
		login: "view-login",
		register: "view-register",
		"verify-pending": "view-verify-pending",
		"verify-result": "view-verify-result",
		forgot: "view-forgot",
		reset: "view-reset",
	};

	function switchView(view: AuthViewName): void {
		for (const [k, id] of Object.entries(VIEWS)) {
			const el = $(id);
			if (el) el.hidden = k !== view;
		}
		const primaryBlock = $("primary-auth-block");
		if (primaryBlock) {
			primaryBlock.hidden = view === "verify-result" || view === "reset" || view === "verify-pending";
		}
		setMsg("login-error", "");
		setMsg("register-error", "");
		setMsg("verify-pending-error", "");
		setMsg("verify-pending-ok", "");
		setMsg("forgot-error", "");
		setMsg("forgot-ok", "");
		setMsg("reset-error", "");
		setMsg("reset-ok", "");
	}

	/* ---------- Google: our own button; the server sends the browser to Google and back (see api.ts) ---------- */
	async function setupGoogle(): Promise<void> {
		const error = params.get("error");
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
	void setupGoogle();

	/* ---------- View Navigation Buttons ---------- */
	let pendingVerifyEmail = "";

	$("btn-goto-register")?.addEventListener("click", () => {
		switchView("register");
		$<HTMLInputElement>("reg-username")?.focus();
	});
	$("btn-goto-forgot")?.addEventListener("click", () => {
		const cur = $<HTMLInputElement>("login-identifier")?.value.trim() || "";
		if (cur.includes("@")) {
			$<HTMLInputElement>("forgot-email").value = cur;
		}
		switchView("forgot");
		$<HTMLInputElement>("forgot-email")?.focus();
	});
	for (const id of ["btn-back-login-1", "btn-back-login-2", "btn-back-login-3", "btn-back-login-4"]) {
		$(id)?.addEventListener("click", () => {
			switchView("login");
			$<HTMLInputElement>("login-identifier")?.focus();
		});
	}

	/* ---------- Email / Username + Password Login ---------- */
	const loginForm = $<HTMLFormElement>("email-login-form");
	if (loginForm) {
		loginForm.onsubmit = async (e) => {
			e.preventDefault();
			setMsg("login-error", "");
			const identifier = $<HTMLInputElement>("login-identifier").value.trim();
			const password = $<HTMLInputElement>("login-password").value;
			if (!identifier || !password) {
				setMsg("login-error", "Please enter your email or username and password.");
				return;
			}
			const btn = $<HTMLButtonElement>("login-submit-btn");
			btn.disabled = true;
			try {
				await api("POST", "auth/login", { identifier, password });
				done();
			} catch (err: any) {
				setMsg("login-error", err.message || "Could not sign in.");
			} finally {
				btn.disabled = false;
			}
		};
	}

	/* ---------- Registration ---------- */
	const registerForm = $<HTMLFormElement>("register-form");
	if (registerForm) {
		registerForm.onsubmit = async (e) => {
			e.preventDefault();
			setMsg("register-error", "");
			const username = $<HTMLInputElement>("reg-username").value.trim();
			const displayName = $<HTMLInputElement>("reg-display-name").value.trim();
			const email = $<HTMLInputElement>("reg-email").value.trim();
			const password = $<HTMLInputElement>("reg-password").value;
			const btn = $<HTMLButtonElement>("register-submit-btn");
			btn.disabled = true;
			try {
				const res = await api("POST", "auth/register", {
					username,
					displayName: displayName || undefined,
					email,
					password,
				});
				pendingVerifyEmail = email;
				const msgEl = $("verify-pending-msg");
				if (msgEl) {
					msgEl.textContent =
						res.message ||
						`We sent a verification link to ${email}. Click the link in that email to activate your account.`;
				}
				switchView("verify-pending");
			} catch (err: any) {
				setMsg("register-error", err.message || "Could not create account.");
			} finally {
				btn.disabled = false;
			}
		};
	}

	$("btn-resend-verify")?.addEventListener("click", async () => {
		if (!pendingVerifyEmail) return;
		setMsg("verify-pending-error", "");
		setMsg("verify-pending-ok", "");
		const btn = $<HTMLButtonElement>("btn-resend-verify");
		btn.disabled = true;
		try {
			const res = await api("POST", "auth/verify-email/resend", { email: pendingVerifyEmail });
			setMsg("verify-pending-ok", res.message || "Verification email sent.");
		} catch (err: any) {
			setMsg("verify-pending-error", err.message || "Could not resend verification email.");
		} finally {
			btn.disabled = false;
		}
	});

	/* ---------- Forgot Password ---------- */
	const forgotForm = $<HTMLFormElement>("forgot-form");
	if (forgotForm) {
		forgotForm.onsubmit = async (e) => {
			e.preventDefault();
			setMsg("forgot-error", "");
			setMsg("forgot-ok", "");
			const email = $<HTMLInputElement>("forgot-email").value.trim();
			const btn = $<HTMLButtonElement>("forgot-submit-btn");
			btn.disabled = true;
			try {
				const res = await api("POST", "auth/password/forgot", { email });
				setMsg(
					"forgot-ok",
					res.message ||
						"If an account is associated with that email address, we have sent instructions to reset your password.",
				);
			} catch (err: any) {
				setMsg("forgot-error", err.message || "Could not request password reset.");
			} finally {
				btn.disabled = false;
			}
		};
	}

	/* ---------- Verify Email Link (?verify=<token>) ---------- */
	const verifyToken = params.get("verify");
	if (verifyToken) {
		switchView("verify-result");
		void (async () => {
			const heading = $("verify-result-heading");
			const msg = $("verify-result-msg");
			const contBtn = $<HTMLButtonElement>("btn-verify-continue");
			try {
				const res = await api("POST", "auth/verify-email", { token: verifyToken });
				heading.textContent = "Email verified";
				msg.textContent =
					res.message || "Your email address has been confirmed. You can now sign in to your account.";
				contBtn.hidden = false;
				contBtn.onclick = () => {
					history.replaceState(
						null,
						"",
						location.pathname + (rawNext ? `?next=${encodeURIComponent(rawNext)}` : ""),
					);
					if (res.purpose === "email_change") {
						location.href = "../account/";
					} else {
						switchView("login");
						$<HTMLInputElement>("login-identifier")?.focus();
					}
				};
			} catch (err: any) {
				heading.textContent = "Verification failed";
				msg.textContent = "";
				setMsg("verify-result-error", err.message || "This verification link is invalid or has expired.");
				contBtn.textContent = "Back to sign in";
				contBtn.hidden = false;
				contBtn.onclick = () => {
					history.replaceState(null, "", location.pathname);
					switchView("login");
				};
			}
		})();
	}

	/* ---------- Password Reset Link (?reset=<token>) ---------- */
	const resetToken = params.get("reset");
	if (resetToken && !verifyToken) {
		switchView("reset");
		const resetForm = $<HTMLFormElement>("reset-form");
		if (resetForm) {
			resetForm.onsubmit = async (e) => {
				e.preventDefault();
				setMsg("reset-error", "");
				setMsg("reset-ok", "");
				const password = $<HTMLInputElement>("reset-password").value;
				const confirm = $<HTMLInputElement>("reset-password-confirm").value;
				if (password !== confirm) {
					setMsg("reset-error", "Passwords do not match.");
					return;
				}
				const btn = $<HTMLButtonElement>("reset-submit-btn");
				btn.disabled = true;
				try {
					const res = await api("POST", "auth/password/reset", { token: resetToken, password });
					setMsg("reset-ok", res.message || "Your password has been reset.");
					setTimeout(() => {
						history.replaceState(null, "", location.pathname);
						switchView("login");
						$<HTMLInputElement>("login-identifier")?.focus();
					}, 1200);
				} catch (err: any) {
					setMsg("reset-error", err.message || "Could not reset password.");
					btn.disabled = false;
				}
			};
		}
	} else if (!verifyToken) {
		const mode = params.get("mode");
		if (mode === "register") switchView("register");
		else if (mode === "forgot") switchView("forgot");
	}

	/* ---------- secret keys ---------- */
	$("toggle-secret").onclick = () => {
		const open = $("secret-panel").hidden;
		$("secret-panel").hidden = !open;
		$("toggle-secret").setAttribute("aria-expanded", String(open));
	};

	let currentSecret = "";
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	$("secret-new").onclick = async () => {
		showSecretError("");
		try {
			const { secret } = await api("POST", "auth/secret/new", {});
			currentSecret = secret;
			$("secret-value").textContent = secret;
			$("secret-shown").hidden = false;
			$("secret-new").hidden = true;
		} catch (e: any) {
			showSecretError(e.message);
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
		showSecretError("");
		try {
			await api("POST", "auth/secret/confirm", { secret: currentSecret });
			done();
		} catch (err: any) {
			btn.disabled = false;
			showSecretError(err.message);
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

			if (e.key === "-" || e.key === "–" || e.key === "—") {
				e.preventDefault();
				return;
			}

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
			showSecretError("");
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
					showSecretError(v.error);
				} else {
					loginBtn?.setAttribute("aria-disabled", "false");
					if (!autoSubmitting) {
						autoSubmitting = true;
						void submitSecretLogin();
					}
				}
			} else {
				autoSubmitting = false;
				loginBtn?.setAttribute("aria-disabled", "true");
			}
		}

		secretInput.addEventListener("input", onSecretInput);
	}

	function trySecretLogin(): void {
		showSecretError("");
		const clean = secretInput ? cleanSecretChars(secretInput.value) : "";
		if (clean.length === 0) {
			showSecretError("Please enter your secret key.");
			secretInput?.focus();
			return;
		}
		if (clean.length < 30) {
			showSecretError(`Please enter a complete 30-character secret key (${clean.length}/30 entered).`);
			secretInput?.focus();
			return;
		}
		const v = validateSecretKey(clean);
		if (!v.valid) {
			showSecretError(v.error);
			secretInput?.focus();
			return;
		}
		void submitSecretLogin();
	}

	async function submitSecretLogin(): Promise<void> {
		if (loginBtn) (loginBtn as HTMLButtonElement).disabled = true;
		showSecretError("");
		try {
			await api("POST", "auth/secret/login", { secret: secretInput.value });
			done();
		} catch (err: any) {
			autoSubmitting = false;
			showSecretError(err.message);
		} finally {
			if (loginBtn) (loginBtn as HTMLButtonElement).disabled = false;
		}
	}

	loginBtn?.addEventListener("click", (e) => {
		if (loginBtn.getAttribute("aria-disabled") === "true") {
			e.preventDefault();
			trySecretLogin();
		}
	});

	$("secret-login").onsubmit = async (e) => {
		e.preventDefault();
		const clean = secretInput ? cleanSecretChars(secretInput.value) : "";
		if (clean.length === 30 && validateSecretKey(clean).valid) {
			await submitSecretLogin();
		} else {
			trySecretLogin();
		}
	};
}