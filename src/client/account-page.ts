// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// account-page.ts: the /account/ page. Shows signed-in account details, profile & username management,
// email addresses, interchangeable sign-in credentials (Google, Password, Secret Key), session controls,
// account deletion, and device-local offline maps.

import { esc, fmt, formatBytes } from "../shared/escape.ts";
import { cleanSecretChars, formatSecretKey } from "../shared/secret-key.ts";
import type { UserAccount } from "../shared/types.ts";
import { api, notify, SIGNED_IN_KEY } from "./account.ts";
import {
	clearAllOfflineMaps,
	downloadOfflineMap,
	inspectOfflineManifests,
	type OfflineManifest,
	removeOfflineMap,
	verifyOfflineMap,
} from "./offline.ts";
import "./theme.ts";

export function providerLabel(provider: UserAccount["provider"]): string {
	if (provider === "google") return "Google";
	if (provider === "password") return "Email & password";
	return "Secret key";
}

export function formatMethodsSummary(u: UserAccount): string {
	if (!u.methods) return providerLabel(u.provider);
	const list: string[] = [];
	if (u.methods.google) list.push("Google");
	if (u.methods.password) list.push("Password");
	if (u.methods.secretKey) list.push("Secret key");
	return list.length ? list.join(" · ") : providerLabel(u.provider);
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

export { formatBytes };

export function renderAccountInfoHtml(u: UserAccount): string {
	const who = u.email || u.name || "Your account";
	const method = formatMethodsSummary(u);
	const created = formatAccountDate(u.createdAt);
	const sessions = typeof u.sessions === "number" ? fmt(u.sessions) : "1";
	const synced = typeof u.syncedItems === "number" ? fmt(u.syncedItems) : "0";
	const usernameItem = u.username
		? `<div class="kv-item"><span class="kv-label">Username</span><span class="kv-val">@${esc(u.username)}</span></div>`
		: "";
	return (
		`<div class="kv-grid">` +
		`<div class="kv-item kv-account"><span class="kv-label">Account</span><span class="kv-val" title="${esc(who)}">${esc(who)}</span></div>` +
		usernameItem +
		`<div class="kv-item"><span class="kv-label">Sign-in method</span><span class="kv-val">${esc(method)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Created</span><span class="kv-val">${esc(created)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Active sessions</span><span class="kv-val">${esc(sessions)}</span></div>` +
		`<div class="kv-item"><span class="kv-label">Synced records</span><span class="kv-val">${esc(synced)}</span></div>` +
		`</div>`
	);
}

/**
 * Determines whether performing `action` on `u` would leave a secret key as the user's ONLY remaining sign-in method.
 */
export function wouldLeaveOnlySecretKey(
	u: UserAccount,
	action:
		| { type: "remove-email"; emailId: string }
		| { type: "revoke-credential"; cred: "google" | "password" | "secret_key" },
): boolean {
	const hasGoogle = Boolean(u.methods?.google);
	const hasSecret = Boolean(u.methods?.secretKey);
	const hasPassword = Boolean(u.methods?.password);
	const verifiedEmails = (u.emails || []).filter((e) => e.verified);

	if (action.type === "remove-email") {
		const target = (u.emails || []).find((e) => e.id === action.emailId);
		if (!target || !target.verified) return false;
		const remVerified = verifiedEmails.filter((e) => e.id !== action.emailId);
		return remVerified.length === 0 && !hasGoogle && hasSecret;
	}

	const remGoogle = action.cred === "google" ? false : hasGoogle;
	const remSecret = action.cred === "secret_key" ? false : hasSecret;
	const remEmailPw = action.cred === "password" ? false : hasPassword && verifiedEmails.length > 0;
	return remSecret && !remGoogle && !remEmailPw;
}

export function canPerformRemoval(
	u: UserAccount,
	action:
		| { type: "remove-email"; emailId: string }
		| { type: "revoke-credential"; cred: "google" | "password" | "secret_key" },
): boolean {
	const hasGoogle = Boolean(u.methods?.google);
	const hasSecret = Boolean(u.methods?.secretKey);
	const hasPassword = Boolean(u.methods?.password);
	const verifiedEmails = (u.emails || []).filter((e) => e.verified);

	if (action.type === "remove-email") {
		const remVerified = verifiedEmails.filter((e) => e.id !== action.emailId);
		const remEmailPw = hasPassword && remVerified.length > 0;
		return (hasGoogle ? 1 : 0) + (hasSecret ? 1 : 0) + (remEmailPw ? 1 : 0) > 0;
	}

	const remGoogle = action.cred === "google" ? false : hasGoogle;
	const remSecret = action.cred === "secret_key" ? false : hasSecret;
	const remEmailPw = action.cred === "password" ? false : hasPassword && verifiedEmails.length > 0;
	return (remGoogle ? 1 : 0) + (remSecret ? 1 : 0) + (remEmailPw ? 1 : 0) > 0;
}

export function renderEmailsListHtml(u: UserAccount): string {
	const emails = u.emails || [];
	if (!emails.length) {
		return `<p class="small muted">No email address is attached to this account yet. Add one below to enable password sign-in and account recovery.</p>`;
	}
	return emails
		.map((e) => {
			const badges: string[] = [];
			if (e.isPrimary) badges.push(`<span class="pill warn">Primary</span>`);
			if (e.verified) badges.push(`<span class="pill ok">Verified</span>`);
			else badges.push(`<span class="pill">Unverified</span>`);

			const btns: string[] = [];
			if (!e.verified) {
				btns.push(
					`<button type="button" class="ghost" data-resend-email-id="${esc(e.id)}">Resend verification</button>`,
				);
			} else if (!e.isPrimary) {
				btns.push(
					`<button type="button" class="ghost" data-primary-email-id="${esc(e.id)}">Make primary</button>`,
				);
			}
			const removable = canPerformRemoval(u, { type: "remove-email", emailId: e.id });
			if (removable) {
				btns.push(
					`<button type="button" class="ghost danger-btn" data-remove-email-id="${esc(e.id)}">Remove</button>`,
				);
			}

			return (
				`<div class="list-row" data-email-row="${esc(e.id)}">` +
				`<div class="list-row-info">` +
				`<span class="list-row-title">${esc(e.email)}</span>` +
				badges.join("") +
				`</div>` +
				`<div class="btn-row">${btns.join("")}</div>` +
				`</div>`
			);
		})
		.join("");
}

export function renderCredentialsListHtml(u: UserAccount): string {
	const hasGoogle = Boolean(u.methods?.google);
	const hasPassword = Boolean(u.methods?.password);
	const hasSecret = Boolean(u.methods?.secretKey);
	const hasVerifiedEmail = (u.emails || []).some((e) => e.verified);

	const rows: string[] = [];

	// 1. Password row
	const pwStatus = hasPassword ? `<span class="pill ok">Configured</span>` : `<span class="pill">Not set</span>`;
	const pwBtns: string[] = [];
	if (hasPassword) {
		pwBtns.push(`<button type="button" class="ghost" data-cred-act="edit-password">Change password</button>`);
		if (canPerformRemoval(u, { type: "revoke-credential", cred: "password" })) {
			pwBtns.push(
				`<button type="button" class="ghost danger-btn" data-cred-revoke="password">Remove password</button>`,
			);
		}
	} else if (hasVerifiedEmail) {
		pwBtns.push(`<button type="button" class="ghost" data-cred-act="edit-password">Set password</button>`);
	} else {
		pwBtns.push(`<span class="list-row-sub">Add &amp; verify an email first</span>`);
	}
	rows.push(
		`<div class="list-row">` +
			`<div class="list-row-info"><span class="list-row-title">Password</span>${pwStatus}</div>` +
			`<div class="btn-row">${pwBtns.join("")}</div>` +
			`</div>`,
	);

	// 2. Google row
	const gStatus = hasGoogle ? `<span class="pill ok">Linked</span>` : `<span class="pill">Not linked</span>`;
	const gBtns: string[] = [];
	if (hasGoogle) {
		if (canPerformRemoval(u, { type: "revoke-credential", cred: "google" })) {
			gBtns.push(
				`<button type="button" class="ghost danger-btn" data-cred-revoke="google">Unlink Google</button>`,
			);
		} else {
			gBtns.push(`<span class="list-row-sub">Only active sign-in method</span>`);
		}
	} else {
		gBtns.push(
			`<a class="ghost" href="../api/auth/google/start?link=1&amp;next=%2Faccount%2F">Link Google account</a>`,
		);
	}
	rows.push(
		`<div class="list-row">` +
			`<div class="list-row-info"><span class="list-row-title">Google</span>${gStatus}</div>` +
			`<div class="btn-row">${gBtns.join("")}</div>` +
			`</div>`,
	);

	// 3. Secret key row
	const sStatus = hasSecret ? `<span class="pill ok">Active</span>` : `<span class="pill">Not attached</span>`;
	const sBtns: string[] = [];
	if (hasSecret) {
		if (canPerformRemoval(u, { type: "revoke-credential", cred: "secret_key" })) {
			sBtns.push(
				`<button type="button" class="ghost danger-btn" data-cred-revoke="secret_key">Revoke secret key</button>`,
			);
		} else {
			sBtns.push(`<span class="list-row-sub">Only active sign-in method</span>`);
		}
	} else {
		sBtns.push(`<button type="button" class="ghost" data-cred-act="new-secret">Add secret key</button>`);
	}
	rows.push(
		`<div class="list-row">` +
			`<div class="list-row-info"><span class="list-row-title">Secret key</span>${sStatus}</div>` +
			`<div class="btn-row">${sBtns.join("")}</div>` +
			`</div>`,
	);

	return rows.join("");
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
			const statusHtml = intact
				? `${esc(fmt(m.expectedCount))} files · ${esc(formatBytes(m.totalBytes))}<br />Verified ${esc(formatAccountDate(m.lastVerified))}`
				: esc(
						`${fmt(cachedCount)} of ${fmt(m.expectedCount)} files cached (${formatBytes(m.totalBytes)} expected) · Missing data`,
					);
			const actionBtn = intact
				? `<button type="button" class="ghost" data-verify-game="${esc(m.game)}" data-verify-map="${esc(m.map)}">Verify</button>`
				: `<button type="button" class="ghost" data-repair-game="${esc(m.game)}" data-repair-map="${esc(m.map)}">Repair</button>`;
			return (
				`<div class="offline-item" data-offline-row="${esc(m.k)}">` +
				`<div class="offline-item-info">` +
				`<a class="offline-item-title" href="${esc(href)}">${esc(m.gameTitle)} · ${esc(m.mapTitle)}</a>` +
				`<span class="offline-item-meta">${statusHtml}</span>` +
				`</div>` +
				`<div class="btn-row">` +
				actionBtn +
				`<button type="button" class="ghost danger-btn" data-remove-game="${esc(m.game)}" data-remove-map="${esc(m.map)}">Remove</button>` +
				`</div>` +
				`</div>`
			);
		})
		.join("");
}

if (typeof document !== "undefined") {
	const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

	let activeUser: UserAccount | null = null;
	let pendingSecretKeyAction: ((confirmKey: string) => Promise<void>) | null = null;
	let generatedSecretKey = "";

	const setError = (id: string, msg: string) => {
		const el = $(id);
		if (!el) return;
		el.textContent = msg;
		el.hidden = !msg;
	};
	const showError = (msg: string) => setError("account-error", msg);

	const renderUserState = (u: UserAccount | null, offlineFallback = false) => {
		activeUser = u;
		const badge = $("account-badge");
		const body = $("account-body");
		const actions = $("account-actions");
		const signedOutActions = $("account-signedout-actions");
		const profileSection = $("profile-section");
		const emailsSection = $("emails-section");
		const securitySection = $("security-section");
		const dangerSection = $("danger-section");

		if (u) {
			badge.textContent = offlineFallback ? "Signed in (offline)" : "Signed in";
			badge.classList.add("active");
			body.innerHTML = renderAccountInfoHtml(u);
			actions.hidden = false;
			signedOutActions.hidden = true;
			profileSection.hidden = offlineFallback;
			emailsSection.hidden = offlineFallback;
			securitySection.hidden = offlineFallback;
			dangerSection.hidden = false;

			if (!offlineFallback) {
				$<HTMLInputElement>("profile-display-name").value = u.displayName || u.name || "";
				$<HTMLInputElement>("profile-username").value = u.username || "";
				$("emails-list").innerHTML = renderEmailsListHtml(u);
				$("credentials-list").innerHTML = renderCredentialsListHtml(u);
			}
		} else {
			badge.textContent = "Not signed in";
			badge.classList.remove("active");
			body.innerHTML = `<p class="small">You are not signed in on this browser. Your map progress is stored locally on this device. Sign in if you want to synchronize progress across devices.</p>`;
			actions.hidden = true;
			signedOutActions.hidden = false;
			profileSection.hidden = true;
			emailsSection.hidden = true;
			securitySection.hidden = true;
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

	async function refreshUserFromServer(): Promise<void> {
		const { user } = await api("GET", "me");
		if (user) localStorage.setItem(SIGNED_IN_KEY, JSON.stringify(user));
		else localStorage.removeItem(SIGNED_IN_KEY);
		renderUserState(user, false);
	}

	async function loadAccountPage(): Promise<void> {
		const urlParams = new URLSearchParams(location.search);
		const urlErr = urlParams.get("error");
		if (urlErr) {
			showError(urlErr);
			history.replaceState(null, "", location.pathname);
		}
		try {
			await refreshUserFromServer();
		} catch {
			let cached: UserAccount | null = null;
			try {
				cached = JSON.parse(localStorage.getItem(SIGNED_IN_KEY) || "null");
			} catch {}
			renderUserState(cached, true);
		}
	}

	/* ---------- Profile Form ---------- */
	const profileForm = $<HTMLFormElement>("profile-form");
	if (profileForm) {
		profileForm.onsubmit = async (e) => {
			e.preventDefault();
			setError("profile-error", "");
			const displayName = $<HTMLInputElement>("profile-display-name").value.trim();
			const username = $<HTMLInputElement>("profile-username").value.trim();
			const btn = $<HTMLButtonElement>("btn-save-profile");
			btn.disabled = true;
			try {
				await api("POST", "account/profile", {
					displayName,
					username: username || undefined,
				});
				await refreshUserFromServer();
				notify("Profile saved.");
			} catch (err: any) {
				setError("profile-error", err.message || "Could not update profile.");
			} finally {
				btn.disabled = false;
			}
		};
	}

	/* ---------- Secret-Key-Only Confirmation Modal ---------- */
	const confirmSecretModal = $("secret-confirm-modal");
	const confirmSecretInput = $<HTMLInputElement>("confirm-secret-input");

	function openSecretKeyConfirmModal(onConfirm: (key: string) => Promise<void>): void {
		pendingSecretKeyAction = onConfirm;
		setError("confirm-secret-error", "");
		if (confirmSecretInput) confirmSecretInput.value = "";
		if (confirmSecretModal) confirmSecretModal.hidden = false;
		confirmSecretInput?.focus();
	}

	function closeSecretKeyConfirmModal(): void {
		pendingSecretKeyAction = null;
		setError("confirm-secret-error", "");
		if (confirmSecretModal) confirmSecretModal.hidden = true;
	}

	if (confirmSecretInput) {
		confirmSecretInput.addEventListener("input", () => {
			setError("confirm-secret-error", "");
			confirmSecretInput.value = formatSecretKey(confirmSecretInput.value);
		});
	}

	$("btn-modal-secret-cancel")?.addEventListener("click", closeSecretKeyConfirmModal);

	const secretConfirmForm = $<HTMLFormElement>("secret-confirm-form");
	if (secretConfirmForm) {
		secretConfirmForm.onsubmit = async (e) => {
			e.preventDefault();
			if (!pendingSecretKeyAction) return;
			const key = confirmSecretInput.value.trim();
			if (cleanSecretChars(key).length < 30) {
				setError("confirm-secret-error", "Please enter your complete 30-character secret key.");
				return;
			}
			const btn = $<HTMLButtonElement>("btn-modal-secret-confirm");
			btn.disabled = true;
			try {
				await pendingSecretKeyAction(key);
				closeSecretKeyConfirmModal();
			} catch (err: any) {
				setError("confirm-secret-error", err.message || "Secret key verification failed.");
			} finally {
				btn.disabled = false;
			}
		};
	}

	/* ---------- Email Management ---------- */
	const addEmailForm = $<HTMLFormElement>("add-email-form");
	if (addEmailForm) {
		addEmailForm.onsubmit = async (e) => {
			e.preventDefault();
			setError("emails-error", "");
			const input = $<HTMLInputElement>("add-email-input");
			const email = input.value.trim();
			if (!email) return;
			const btn = $<HTMLButtonElement>("btn-add-email");
			btn.disabled = true;
			try {
				const res = await api("POST", "account/email/add", { email });
				input.value = "";
				await refreshUserFromServer();
				notify(res.message || "Confirmation email sent.");
			} catch (err: any) {
				setError("emails-error", err.message || "Could not add email address.");
			} finally {
				btn.disabled = false;
			}
		};
	}

	$("emails-list")?.addEventListener("click", async (e) => {
		const target = e.target as HTMLElement | null;
		if (!target || !activeUser) return;
		setError("emails-error", "");

		const resendBtn = target.closest<HTMLButtonElement>("button[data-resend-email-id]");
		if (resendBtn) {
			const emailId = resendBtn.dataset.resendEmailId!;
			resendBtn.disabled = true;
			try {
				const res = await api("POST", "auth/verify-email/resend", { emailId });
				notify(res.message || "Verification email sent.");
			} catch (err: any) {
				setError("emails-error", err.message || "Could not resend verification email.");
			} finally {
				resendBtn.disabled = false;
			}
			return;
		}

		const primaryBtn = target.closest<HTMLButtonElement>("button[data-primary-email-id]");
		if (primaryBtn) {
			const emailId = primaryBtn.dataset.primaryEmailId!;
			primaryBtn.disabled = true;
			try {
				await api("POST", "account/email/primary", { emailId });
				await refreshUserFromServer();
				notify("Primary email address updated.");
			} catch (err: any) {
				setError("emails-error", err.message || "Could not change primary email.");
			} finally {
				primaryBtn.disabled = false;
			}
			return;
		}

		const removeBtn = target.closest<HTMLButtonElement>("button[data-remove-email-id]");
		if (removeBtn) {
			const emailId = removeBtn.dataset.removeEmailId!;
			const doRemove = async (confirmSecretKey?: string) => {
				await api("POST", "account/email/remove", { emailId, confirmSecretKey });
				await refreshUserFromServer();
				notify("Email address removed.");
			};

			if (wouldLeaveOnlySecretKey(activeUser, { type: "remove-email", emailId })) {
				openSecretKeyConfirmModal((key) => doRemove(key));
				return;
			}

			removeBtn.disabled = true;
			try {
				await doRemove();
			} catch (err: any) {
				if (err.requireSecretKeyConfirmation) {
					openSecretKeyConfirmModal((key) => doRemove(key));
				} else {
					setError("emails-error", err.message || "Could not remove email address.");
				}
			} finally {
				removeBtn.disabled = false;
			}
		}
	});

	/* ---------- Sign-in Methods & Credentials ---------- */
	$("credentials-list")?.addEventListener("click", async (e) => {
		const target = e.target as HTMLElement | null;
		if (!target || !activeUser) return;
		setError("security-error", "");

		const actBtn = target.closest<HTMLButtonElement>("button[data-cred-act]");
		if (actBtn) {
			const act = actBtn.dataset.credAct;
			if (act === "edit-password") {
				const pwForm = $<HTMLFormElement>("password-form");
				const hasPw = Boolean(activeUser.methods?.password);
				$("password-form-title").textContent = hasPw ? "Change password" : "Set password";
				$("pw-current-wrap").hidden = !hasPw;
				$("pw-username-wrap").hidden = Boolean(activeUser.username);
				$<HTMLInputElement>("pw-current").value = "";
				$<HTMLInputElement>("pw-new").value = "";
				$<HTMLInputElement>("pw-confirm").value = "";
				setError("password-error", "");
				pwForm.hidden = false;
				return;
			}
			if (act === "new-secret") {
				actBtn.disabled = true;
				try {
					const { secret } = await api("POST", "auth/secret/new", {});
					generatedSecretKey = secret;
					$("acct-secret-value").textContent = secret;
					$<HTMLInputElement>("acct-secret-saved").checked = false;
					$<HTMLButtonElement>("btn-confirm-add-secret").disabled = true;
					$("new-secret-box").hidden = false;
				} catch (err: any) {
					setError("security-error", err.message || "Could not generate secret key.");
				} finally {
					actBtn.disabled = false;
				}
				return;
			}
		}

		const revBtn = target.closest<HTMLButtonElement>("button[data-cred-revoke]");
		if (revBtn) {
			const cred = revBtn.dataset.credRevoke as "google" | "password" | "secret_key";
			const doRevoke = async (confirmSecretKey?: string) => {
				await api("POST", "account/credentials/revoke", { type: cred, confirmSecretKey });
				await refreshUserFromServer();
				notify("Sign-in method removed.");
			};

			if (wouldLeaveOnlySecretKey(activeUser, { type: "revoke-credential", cred })) {
				openSecretKeyConfirmModal((key) => doRevoke(key));
				return;
			}

			revBtn.disabled = true;
			try {
				await doRevoke();
			} catch (err: any) {
				if (err.requireSecretKeyConfirmation) {
					openSecretKeyConfirmModal((key) => doRevoke(key));
				} else {
					setError("security-error", err.message || "Could not remove sign-in method.");
				}
			} finally {
				revBtn.disabled = false;
			}
		}
	});

	$("btn-cancel-password")?.addEventListener("click", () => {
		$("password-form").hidden = true;
		setError("password-error", "");
	});

	const pwForm = $<HTMLFormElement>("password-form");
	if (pwForm) {
		pwForm.onsubmit = async (e) => {
			e.preventDefault();
			setError("password-error", "");
			const currentPassword = $<HTMLInputElement>("pw-current").value;
			const username = $<HTMLInputElement>("pw-username").value.trim();
			const newPassword = $<HTMLInputElement>("pw-new").value;
			const confirm = $<HTMLInputElement>("pw-confirm").value;
			if (newPassword !== confirm) {
				setError("password-error", "New passwords do not match.");
				return;
			}
			const btn = $<HTMLButtonElement>("btn-save-password");
			btn.disabled = true;
			try {
				await api("POST", "account/password", {
					currentPassword: currentPassword || undefined,
					username: username || undefined,
					newPassword,
				});
				pwForm.hidden = true;
				await refreshUserFromServer();
				notify("Password updated.");
			} catch (err: any) {
				setError("password-error", err.message || "Could not update password.");
			} finally {
				btn.disabled = false;
			}
		};
	}

	$<HTMLInputElement>("acct-secret-saved")?.addEventListener("change", (e) => {
		$<HTMLButtonElement>("btn-confirm-add-secret").disabled = !(e.target as HTMLInputElement).checked;
	});

	$("btn-cancel-add-secret")?.addEventListener("click", () => {
		generatedSecretKey = "";
		$("new-secret-box").hidden = true;
	});

	$("btn-confirm-add-secret")?.addEventListener("click", async () => {
		if (!generatedSecretKey) return;
		const btn = $<HTMLButtonElement>("btn-confirm-add-secret");
		btn.disabled = true;
		setError("security-error", "");
		try {
			await api("POST", "account/secret/add", { secret: generatedSecretKey });
			generatedSecretKey = "";
			$("new-secret-box").hidden = true;
			await refreshUserFromServer();
			notify("Secret key attached to your account.");
		} catch (err: any) {
			btn.disabled = false;
			setError("security-error", err.message || "Could not attach secret key.");
		}
	});

	/* ---------- Session Logout & Account Deletion ---------- */
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

	/* ---------- Offline Maps Section ---------- */
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
		const ver = target.closest<HTMLButtonElement>("button[data-verify-game]");
		if (ver) {
			const game = ver.dataset.verifyGame!;
			const map = ver.dataset.verifyMap!;
			ver.disabled = true;
			ver.textContent = "Verifying…";
			try {
				const res = await verifyOfflineMap({ gameSlug: game, mapSlug: map });
				if (res.status === "intact") {
					notify("Offline map data verified.");
				} else if (res.status === "damaged") {
					notify("Offline map data damaged. Please repair.");
				}
			} catch (err: any) {
				notify(err.message || "Could not verify offline map.");
			}
			await refreshOfflineSection();
			return;
		}
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

	void loadAccountPage();
	void refreshOfflineSection();
}