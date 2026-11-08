// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApi, sha256 } from "../server/api.ts";
import {
	renderChangeEmailTemplate,
	renderResetPasswordTemplate,
	renderSecurityNotificationTemplate,
	renderVerifyEmailTemplate,
	wrapPlainText72,
} from "../server/email-templates.ts";
import { createSesEmailSender, type EmailMessage } from "../server/email.ts";
import { resolveClientIp } from "../server/rate-limit.ts";
import {
	confusableSkeleton,
	foldUnicode,
	validateDisplayName,
	validateEmail,
	validatePassword,
	validateUsername,
} from "../server/usernames.ts";
import { canPerformRemoval, wouldLeaveOnlySecretKey } from "../src/client/account-page.ts";
import type { UserAccount } from "../src/shared/types.ts";

describe("Unicode username, confusables, and display name validation (server/usernames.ts)", () => {
	test("normalizes NFC so precomposed U+00E9 and decomposed U+0065 U+0301 are identical", () => {
		const precomposed = validateUsername("Ren\u00e9");
		const decomposed = validateUsername("Rene\u0301");
		expect(precomposed.valid).toBe(true);
		expect(decomposed.valid).toBe(true);
		if (precomposed.valid && decomposed.valid) {
			expect(precomposed.username).toBe("Ren\u00e9");
			expect(decomposed.username).toBe("Ren\u00e9");
			expect(precomposed.folded).toBe(decomposed.folded);
			expect(precomposed.skeleton).toBe(decomposed.skeleton);
		}
	});

	test("accepts international scripts (Latin, Greek, Cyrillic, Japanese, Korean, Arabic) and valid separators", () => {
		for (const validName of [
			"Tarnished_One",
			"Aegis-7.2",
			"Αθήνα",
			"Москва",
			"さくら",
			"한글이름",
			"سلام",
			"René_Dubois",
		]) {
			const res = validateUsername(validName);
			expect(res.valid).toBe(true);
		}
	});

	test("performs full Unicode case-folding and UTS #39 confusable skeleton collision detection", () => {
		expect(foldUnicode("Stra\u1e9ee")).toBe("strasse"); // German capital sharp S -> ss
		// Cyrillic 'а' (U+0430) and 'е' (U+0435) vs Latin 'a' and 'e'
		expect(confusableSkeleton("аdmin")).toBe(confusableSkeleton("admin"));
		expect(confusableSkeleton("adm1n")).toBe(confusableSkeleton("admln"));
		expect(confusableSkeleton("r00t")).toBe(confusableSkeleton("root"));
		expect(confusableSkeleton("Rеné")).toBe(confusableSkeleton("Rene"));
	});

	test("rejects whitespace, emoji, symbols, zero-width/control chars, and invalid separators in usernames", () => {
		expect(validateUsername("has space").valid).toBe(false);
		expect(validateUsername("tab\there").valid).toBe(false);
		expect(validateUsername("zero\u200bwidth").valid).toBe(false);
		expect(validateUsername("bidi\u202eoverride").valid).toBe(false);
		expect(validateUsername("cool😎user").valid).toBe(false);
		expect(validateUsername("dollar$sign").valid).toBe(false);
		expect(validateUsername("\u0301leadingmark").valid).toBe(false);
		expect(validateUsername("bad_\u0301mark").valid).toBe(false);
		expect(validateUsername("double..dot").valid).toBe(false);
		expect(validateUsername("trailing_").valid).toBe(false);
		expect(validateUsername("_leading").valid).toBe(false);
		expect(validateUsername("a").valid).toBe(false);
		expect(validateUsername("a".repeat(21)).valid).toBe(false);
	});

	test("allows spaces and punctuation in display names while rejecting control and bidi characters", () => {
		const d1 = validateDisplayName("  Lady   Maria of the Astral Clocktower!  ");
		expect(d1).toEqual({ valid: true, displayName: "Lady Maria of the Astral Clocktower!" });
		expect(validateDisplayName("Bad\u202eName").valid).toBe(false);
		expect(validateDisplayName("Bad\u0007Bell").valid).toBe(false);
		expect(validateDisplayName("").valid).toBe(false);
	});

	test("validates email and password constraints", () => {
		expect(validateEmail("Alice@Example.COM")).toEqual({
			valid: true,
			email: "Alice@Example.COM",
			normalized: "alice@example.com",
		});
		expect(validateEmail("not-an-email").valid).toBe(false);
		expect(validatePassword("short").valid).toBe(false);
		expect(validatePassword("correct-horse-battery").valid).toBe(true);
	});
});

describe("Email templates and 72-column plaintext wrapping (server/email-templates.ts)", () => {
	test("wrapPlainText72 wraps text at <= 72 columns while preserving long URLs unbroken", () => {
		const longUrl =
			"https://atlas.verticordia.com/signin/?verify=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		const raw = [
			"Welcome to Verticordia Atlas. Please confirm your email address to activate your account and synchronize your progress across all of your devices.",
			"",
			longUrl,
		].join("\n");
		const wrapped = wrapPlainText72(raw, 72);
		for (const line of wrapped.split("\n")) {
			if (line.startsWith("https://")) {
				expect(line).toBe(longUrl);
			} else {
				expect(line.length).toBeLessThanOrEqual(72);
			}
		}
	});

	test("renders branded HTML and plaintext for verify, reset, change-email, and security-notification", () => {
		const v = renderVerifyEmailTemplate({
			displayName: 'Alice <"Wonder">',
			username: "Alice_W",
			verifyUrl: "https://atlas.verticordia.com/signin/?verify=tok123",
		});
		expect(v.subject).toContain("Verify your email");
		expect(v.html).toContain("Verticordia Atlas");
		expect(v.html).toContain("Alice &lt;&quot;Wonder&quot;&gt;");
		expect(v.text).toContain("https://atlas.verticordia.com/signin/?verify=tok123");

		const r = renderResetPasswordTemplate({
			displayName: "Alice",
			resetUrl: "https://atlas.verticordia.com/signin/?reset=rst456",
		});
		expect(r.subject).toContain("Reset your password");
		expect(r.text).toContain("20 minutes");

		const c = renderChangeEmailTemplate({
			displayName: "Alice",
			newEmail: "new@example.com",
			verifyUrl: "https://atlas.verticordia.com/signin/?verify=chg789",
		});
		expect(c.html).toContain("new@example.com");

		const s = renderSecurityNotificationTemplate({
			displayName: "Alice",
			eventTitle: "Password changed",
			eventDescription: "Your password was updated.",
			accountUrl: "https://atlas.verticordia.com/account/",
		});
		expect(s.subject).toContain("Password changed");
		expect(s.html).toContain("Manage account security");
	});
});

describe("Account removal & secret-key-only pure helpers (src/client/account-page.ts)", () => {
	test("wouldLeaveOnlySecretKey and canPerformRemoval accurately detect when secret key becomes sole method", () => {
		const userWithSecretAndEmailPw: UserAccount = {
			id: "u1",
			provider: "password",
			email: "alice@example.com",
			name: "Alice",
			emails: [{ id: "e1", email: "alice@example.com", verified: true, isPrimary: true, createdAt: 100 }],
			methods: { google: false, password: true, secretKey: true },
		};
		expect(wouldLeaveOnlySecretKey(userWithSecretAndEmailPw, { type: "remove-email", emailId: "e1" })).toBe(true);
		expect(wouldLeaveOnlySecretKey(userWithSecretAndEmailPw, { type: "revoke-credential", cred: "password" })).toBe(
			true,
		);
		expect(
			wouldLeaveOnlySecretKey(userWithSecretAndEmailPw, { type: "revoke-credential", cred: "secret_key" }),
		).toBe(false);

		const userWithOnlyPassword: UserAccount = {
			id: "u2",
			provider: "password",
			email: "bob@example.com",
			name: "Bob",
			emails: [{ id: "e2", email: "bob@example.com", verified: true, isPrimary: true, createdAt: 100 }],
			methods: { google: false, password: true, secretKey: false },
		};
		expect(canPerformRemoval(userWithOnlyPassword, { type: "remove-email", emailId: "e2" })).toBe(false);
		expect(canPerformRemoval(userWithOnlyPassword, { type: "revoke-credential", cred: "password" })).toBe(false);
	});
});

describe("End-to-end authentication, verification, reset, and account credential management", () => {
	let tmpDir: string;
	let sentEmails: EmailMessage[];
	let failEmailSend: boolean;
	let api: ReturnType<typeof createApi>;
	let server: any;
	let baseUrl: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "atlas-auth-test-"));
		sentEmails = [];
		failEmailSend = false;
		api = createApi({
			root: tmpDir,
			publicUrl: "http://127.0.0.1",
			argon2: { memoryCostKiB: 4096, timeCost: 1 },
			emailSender: {
				async send(msg) {
					if (failEmailSend) throw new Error("SES simulated delivery failure");
					sentEmails.push(msg);
					return { messageId: "test-msg-id" };
				},
			},
		});
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req, s) {
				const url = new URL(req.url);
				if (url.pathname === "/api/ws") {
					const rejected = api.upgrade(req, s);
					if (rejected) return rejected;
					return;
				}
				const res = await api.handle(req, url);
				return res || new Response(null, { status: 404 });
			},
			websocket: api.websocket,
		});
		baseUrl = `http://127.0.0.1:${server.port}`;
	});

	afterEach(async () => {
		server.stop(true);
		api.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	function extractTokenFromEmail(msg: EmailMessage, param: "verify" | "reset"): string {
		const re = new RegExp(`[?&]${param}=([^&\\s"]+)`);
		const m = re.exec(msg.text);
		if (!m) throw new Error(`Could not find ?${param}= token in email text:\n${msg.text}`);
		return decodeURIComponent(m[1]);
	}

	test("rejects reserved usernames (and confusable variants) with explicit error message", async () => {
		for (const reserved of ["admin", "ADMIN", "аdmin", "support", "verticordia"]) {
			const res = await fetch(`${baseUrl}/api/auth/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: reserved,
					email: "user@example.com",
					password: "correct-horse-battery",
				}),
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.code).toBe("USERNAME_RESERVED");
			expect(data.error).toContain("reserved");
		}
	});

	test("rolls back registration if SES email delivery fails so user is never stuck unverified", async () => {
		failEmailSend = true;
		const origError = console.error;
		console.error = () => {};
		try {
			const res = await fetch(`${baseUrl}/api/auth/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: "Melina",
					email: "melina@landsbetween.org",
					password: "correct-horse-battery",
				}),
			});
			expect(res.status).toBe(503);
		} finally {
			console.error = origError;
		}

		// Subsequent attempt when SES recovers succeeds with the same username
		failEmailSend = false;
		const res2 = await fetch(`${baseUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: "Melina",
				email: "melina@landsbetween.org",
				password: "correct-horse-battery",
			}),
		});
		expect(res2.status).toBe(200);
		expect(sentEmails.length).toBe(1);
	});

	test("full registration, verification, confusable collision rejection, login, and password reset flow", async () => {
		// 1. Register account
		const regRes = await fetch(`${baseUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: "René",
				displayName: "René Descartes",
				email: "rene@example.com",
				password: "initial-password-123",
			}),
		});
		expect(regRes.status).toBe(200);
		expect(sentEmails.length).toBe(1);
		const verifyToken = extractTokenFromEmail(sentEmails[0], "verify");

		// 2. Unverified account cannot sign in yet
		const earlyLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier: "rene@example.com", password: "initial-password-123" }),
		});
		expect(earlyLogin.status).toBe(401);

		// 3. Confusable username registration ("Rene" or Cyrillic "Rеné") is rejected with 409
		const confusableReg = await fetch(`${baseUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: "Rеné", // Cyrillic 'е'
				email: "other@example.com",
				password: "initial-password-123",
			}),
		});
		expect(confusableReg.status).toBe(409);
		expect((await confusableReg.json()).code).toBe("USERNAME_TAKEN");

		// 4. Verify email token (single-use)
		const verRes = await fetch(`${baseUrl}/api/auth/verify-email`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: verifyToken }),
		});
		expect(verRes.status).toBe(200);

		// Reusing the same verification token fails
		const verReuse = await fetch(`${baseUrl}/api/auth/verify-email`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: verifyToken }),
		});
		expect(verReuse.status).toBe(400);

		// 5. Sign in with case-different username ("rené")
		const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier: "rené", password: "initial-password-123" }),
		});
		expect(loginRes.status).toBe(200);
		const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
		expect(cookie).toStartWith("va_session=");
		const loginData = await loginRes.json();
		expect(loginData.user.username).toBe("René");
		expect(loginData.user.displayName).toBe("René Descartes");
		expect(loginData.user.methods).toEqual({ google: false, password: true, secretKey: false });

		// 6. Request password reset (generic response for both unknown and known emails)
		sentEmails.length = 0;
		const forgotUnknown = await fetch(`${baseUrl}/api/auth/password/forgot`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "nobody@example.com" }),
		});
		expect(forgotUnknown.status).toBe(200);
		expect(sentEmails.length).toBe(0);

		const forgotKnown = await fetch(`${baseUrl}/api/auth/password/forgot`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "RENE@example.com" }),
		});
		expect(forgotKnown.status).toBe(200);
		expect(sentEmails.length).toBe(1);
		const resetToken = extractTokenFromEmail(sentEmails[0], "reset");

		// 7. Reset password -> consumes token, revokes existing session, and allows login with new password
		const resetRes = await fetch(`${baseUrl}/api/auth/password/reset`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: resetToken, password: "new-password-456" }),
		});
		expect(resetRes.status).toBe(200);

		// Old session is invalidated
		const meOld = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
		expect((await meOld.json()).user).toBeNull();

		// Login with new password works
		const loginNew = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier: "rene@example.com", password: "new-password-456" }),
		});
		expect(loginNew.status).toBe(200);
	});

	test("anonymous secret-key account can add email & password, and removing email/password requires secret key confirmation", async () => {
		// 1. Create a secret-key account
		const { secret } = await (
			await fetch(`${baseUrl}/api/auth/secret/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			})
		).json();
		const confirmRes = await fetch(`${baseUrl}/api/auth/secret/confirm`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
		expect(confirmRes.status).toBe(200);
		const cookie = (confirmRes.headers.get("set-cookie") || "").split(";")[0];

		// 2. Add an email address to the secret-key account
		sentEmails.length = 0;
		const addEmailRes = await fetch(`${baseUrl}/api/account/email/add`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ email: "upgraded@example.com" }),
		});
		expect(addEmailRes.status).toBe(200);
		expect(sentEmails.length).toBe(1);
		const verifyToken = extractTokenFromEmail(sentEmails[0], "verify");

		// Verify the added email
		const verRes = await fetch(`${baseUrl}/api/auth/verify-email`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: verifyToken }),
		});
		expect(verRes.status).toBe(200);

		// 3. Set a password and username on the account
		const setPwRes = await fetch(`${baseUrl}/api/account/password`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ username: "Upgraded_Explorer", newPassword: "upgraded-password-99" }),
		});
		expect(setPwRes.status).toBe(200);
		const { user: updatedUser } = await setPwRes.json();
		expect(updatedUser.username).toBe("Upgraded_Explorer");
		expect(updatedUser.methods).toEqual({ google: false, password: true, secretKey: true });

		// 4. Attempting to revoke password without confirming the secret key fails with requireSecretKeyConfirmation: true
		const revokeNoKey = await fetch(`${baseUrl}/api/account/credentials/revoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ type: "password" }),
		});
		expect(revokeNoKey.status).toBe(400);
		const revokeNoKeyData = await revokeNoKey.json();
		expect(revokeNoKeyData.requireSecretKeyConfirmation).toBe(true);

		// Attempting with a wrong secret key fails with 401
		const otherSecret = api.newSecret();
		const revokeWrongKey = await fetch(`${baseUrl}/api/account/credentials/revoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ type: "password", confirmSecretKey: otherSecret }),
		});
		expect(revokeWrongKey.status).toBe(401);

		// Providing the account's actual secret key succeeds!
		const revokeOk = await fetch(`${baseUrl}/api/account/credentials/revoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ type: "password", confirmSecretKey: secret }),
		});
		expect(revokeOk.status).toBe(200);
		const afterRevoke = (await revokeOk.json()).user;
		expect(afterRevoke.methods).toEqual({ google: false, password: false, secretKey: true });

		// 5. Cannot revoke the last remaining login method (secret_key)
		const revokeLast = await fetch(`${baseUrl}/api/account/credentials/revoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ type: "secret_key" }),
		});
		expect(revokeLast.status).toBe(400);
	});

	test("step-up re-authentication (POST /api/account/reauth) is enforced when session reauth_at is older than 10 minutes", async () => {
		const { secret } = await (
			await fetch(`${baseUrl}/api/auth/secret/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			})
		).json();
		const confirmRes = await fetch(`${baseUrl}/api/auth/secret/confirm`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
		expect(confirmRes.status).toBe(200);
		const cookie = (confirmRes.headers.get("set-cookie") || "").split(";")[0];

		// Add an unverified email while session is fresh
		const addEmailRes = await fetch(`${baseUrl}/api/account/email/add`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ email: "reauth-test@example.com" }),
		});
		expect(addEmailRes.status).toBe(200);
		const { user: userWithEmail } = await addEmailRes.json();
		const emailId = userWithEmail.emails[0].id;

		// Age the session's reauth_at past 10 minutes
		api._db
			.prepare("UPDATE sessions SET reauth_at = ? WHERE user_id = ?")
			.run(Date.now() - 15 * 60_000, userWithEmail.id);

		// Sensitive routes now reject with 403 { requireReauth: true }
		const delStale = await fetch(`${baseUrl}/api/auth/delete-account`, {
			method: "POST",
			headers: { Cookie: cookie },
		});
		expect(delStale.status).toBe(403);
		expect((await delStale.json()).requireReauth).toBe(true);

		const removeEmailStale = await fetch(`${baseUrl}/api/account/email/remove`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ emailId }),
		});
		expect(removeEmailStale.status).toBe(403);
		expect((await removeEmailStale.json()).requireReauth).toBe(true);

		// Wrong credential on /api/account/reauth returns 401
		const badReauth = await fetch(`${baseUrl}/api/account/reauth`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ secret: api.newSecret() }),
		});
		expect(badReauth.status).toBe(401);

		// Valid secret key on /api/account/reauth refreshes reauth_at
		const goodReauth = await fetch(`${baseUrl}/api/account/reauth`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ secret }),
		});
		expect(goodReauth.status).toBe(200);
		expect((await goodReauth.json()).ok).toBe(true);

		// Subsequent email removal and account deletion now succeed
		const removeEmailOk = await fetch(`${baseUrl}/api/account/email/remove`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ emailId }),
		});
		expect(removeEmailOk.status).toBe(200);

		const delOk = await fetch(`${baseUrl}/api/auth/delete-account`, {
			method: "POST",
			headers: { Cookie: cookie },
		});
		expect(delOk.status).toBe(200);
	});

	describe("session user cache", () => {
		const post = (p: string, cookie: string, body: unknown = {}) =>
			fetch(`${baseUrl}${p}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify(body),
			});
		const me = async (cookie: string) =>
			(await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).json()).user;
		const signUp = async () => {
			const { secret } = await (await post("/api/auth/secret/new", "")).json();
			const res = await post("/api/auth/secret/confirm", "", { secret });
			return (res.headers.get("set-cookie") || "").split(";")[0];
		};
		// Counts session/user lookups (any statement get/all) made by Database instances created inside `body`.
		const withQueryCounter = async (
			body: (a: ReturnType<typeof createApi>, count: () => number) => Promise<void>,
		) => {
			const proto = Database.prototype as any;
			const orig = proto.prepare;
			let n = 0;
			proto.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
				const stmt = orig.call(this, sql, ...rest);
				if (
					!/COUNT\(/.test(sql) &&
					/FROM (users|sessions|auth_identities|email_addresses|password_credentials) WHERE/.test(sql)
				)
					for (const m of ["get", "all"]) {
						const f = stmt[m].bind(stmt);
						stmt[m] = (...args: unknown[]) => (n++, f(...args));
					}
				return stmt;
			};
			const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-cache-test-"));
			let counted: ReturnType<typeof createApi> | undefined;
			try {
				counted = createApi({
					root: dir,
					publicUrl: "http://127.0.0.1",
					argon2: { memoryCostKiB: 4096, timeCost: 1 },
				});
				await body(counted, () => n);
			} finally {
				proto.prepare = orig;
				counted?.close();
				await rm(dir, { recursive: true, force: true });
			}
		};
		const meDirect = async (a: ReturnType<typeof createApi>, cookie: string) =>
			(
				await (await a.handle(
					new Request("http://127.0.0.1/api/me", { headers: { cookie } }),
					new URL("http://127.0.0.1/api/me"),
				))!.json()
			).user;
		const signUpDirect = async (a: ReturnType<typeof createApi>) => {
			const u = new URL("http://127.0.0.1/api/auth/secret/confirm");
			const secret = a.newSecret();
			const res = await a.handle(
				new Request(u, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ secret }),
				}),
				u,
			);
			return (res!.headers.get("set-cookie") || "").split(";")[0];
		};

		test("a repeated /api/me skips the user queries but still reads the session row", async () => {
			await withQueryCounter(async (a, count) => {
				const cookie = await signUpDirect(a);
				const before = count();
				await meDirect(a, cookie);
				const cold = count() - before;
				const mid = count();
				await meDirect(a, cookie);
				expect(cold).toBe(1 + 4); // session row + users, identities, emails, password
				expect(count() - mid).toBe(1); // session row only
			});
		});

		test("expiry and logout are honoured immediately even while the user is cached", async () => {
			const cookie = await signUp();
			const user = await me(cookie);
			expect(user.id).toBeTruthy();
			api._db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1, user.id);
			expect(await me(cookie)).toBeNull();

			const cookie2 = await signUp();
			expect((await me(cookie2)).id).toBeTruthy();
			await post("/api/auth/logout", cookie2);
			expect(await me(cookie2)).toBeNull();
		});

		test("logout-all revokes other cached sessions; profile changes show up immediately", async () => {
			const a = await signUp();
			const user = await me(a);
			// second session for the same account via a fresh token row
			api._db
				.prepare(
					"INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used) VALUES (?, ?, ?, ?, ?)",
				)
				.run(sha256("other-token"), user.id, Date.now(), Date.now() + 60_000, Date.now());
			expect((await me("va_session=other-token")).id).toBe(user.id);
			await post("/api/auth/logout-all", a);
			expect(await me("va_session=other-token")).toBeNull();

			const b = await signUp();
			await me(b);
			const prof = await post("/api/account/profile", b, { displayName: "Renamed Person" });
			expect(prof.status).toBe(200);
			expect((await me(b)).displayName).toBe("Renamed Person");
		});

		test("the cache is bounded: the oldest user is evicted past 500 entries", async () => {
			await withQueryCounter(async (a, count) => {
				const first = await signUpDirect(a);
				await meDirect(a, first);
				for (let i = 0; i < 500; i++) await meDirect(a, await signUpDirect(a));
				const before = count();
				await meDirect(a, first);
				expect(count() - before).toBe(5);
			});
		});
	});

	test("resolveClientIp ignores spoofed X-Forwarded-For unless trustProxy is enabled", () => {
		const req = new Request("http://localhost/api/auth/login", {
			headers: {
				"X-Forwarded-For": "203.0.113.9, 10.0.0.1",
				"X-Real-IP": "198.51.100.7",
			},
		});
		expect(resolveClientIp(req, false, "127.0.0.1")).toBe("127.0.0.1");
		expect(resolveClientIp(req, false, null)).toBe("127.0.0.1");
		expect(resolveClientIp(req, true, "127.0.0.1")).toBe("203.0.113.9");

		const reqRealIpOnly = new Request("http://localhost/api/auth/login", {
			headers: { "X-Real-IP": "198.51.100.7" },
		});
		expect(resolveClientIp(reqRealIpOnly, true, "127.0.0.1")).toBe("198.51.100.7");
	});

	test("createSesEmailSender uses local dev fallback when SES is unconfigured and devFallback is enabled", async () => {
		const logs: string[] = [];
		const devSender = createSesEmailSender({
			devFallback: true,
			onDevLog: (line) => logs.push(line),
		});
		const res = await devSender.send({
			to: "dev@example.com",
			subject: "Verify your email",
			text: "Click https://atlas.example.com/signin/?verify=abc123 to verify.",
			html: "<p>Verify</p>",
		});
		expect(res.messageId).toStartWith("dev-");
		expect(logs.join("\n")).toContain("https://atlas.example.com/signin/?verify=abc123");

		const strictSender = createSesEmailSender({ devFallback: false });
		await expect(
			strictSender.send({
				to: "prod@example.com",
				subject: "Test",
				text: "Body",
				html: "<p>Body</p>",
			}),
		).rejects.toThrow("Amazon SES is not configured");
	});
});