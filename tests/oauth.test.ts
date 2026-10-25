// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SignJWT } from "jose";

import { createApi } from "../server/api.ts";

describe("Google OAuth and session cookie flows", () => {
	let tmpDir: string;
	let api: ReturnType<typeof createApi>;
	let appServer: any;
	let certsServer: any;
	let baseUrl: string;
	let certsUrl: string;

	// Generate RSA key pair for testing Google ID token issuance
	const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid" };

	async function makeIdToken(claims: Record<string, any>, kid = "test-kid"): Promise<string> {
		return await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).sign(privateKey);
	}

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "atlas-oauth-test-"));

		// Mock Google certs endpoint
		certsServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				return Response.json({ keys: [jwk] });
			},
		});
		certsUrl = `http://127.0.0.1:${certsServer.port}/certs`;

		api = createApi({
			root: tmpDir,
			googleClientId: "test-google-client",
			publicUrl: "http://127.0.0.1:8080",
			googleCertsUrl: certsUrl,
		});

		appServer = Bun.serve({
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
		baseUrl = `http://127.0.0.1:${appServer.port}`;
	});

	afterEach(async () => {
		appServer.stop(true);
		certsServer.stop(true);
		api.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("GET /api/auth/google/start redirects to Google OAuth endpoint and stores state in DB", async () => {
		const res = await fetch(`${baseUrl}/api/auth/google/start?next=/maps/elden-ring/`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		const location = res.headers.get("location") || "";
		expect(location).toStartWith("https://accounts.google.com/o/oauth2/v2/auth?");

		const locUrl = new URL(location);
		expect(locUrl.searchParams.get("client_id")).toBe("test-google-client");
		expect(locUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8080/api/auth/google/callback");
		expect(locUrl.searchParams.get("response_type")).toBe("id_token");
		expect(locUrl.searchParams.get("scope")).toBe("openid email profile");

		const state = locUrl.searchParams.get("state");
		const nonce = locUrl.searchParams.get("nonce");
		expect(state).toBeTruthy();
		expect(nonce).toBeTruthy();

		// Verify state is stored in sqlite oauth_states
		const row = api._db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as any;
		expect(row).toBeTruthy();
		expect(row.nonce).toBe(nonce);
		expect(row.next).toBe("/maps/elden-ring/");
	});

	test("POST /api/auth/google/callback validates signed token, sets session cookie, and logs in user", async () => {
		// 1. Start OAuth flow to seed state and nonce
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/account/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		// 2. Craft signed Google ID token matching the nonce
		const idToken = await makeIdToken({
			iss: "https://accounts.google.com",
			aud: "test-google-client",
			sub: "google-sub-42",
			email: "tarnished@example.com",
			name: "Tarnished One",
			email_verified: true,
			nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});

		// 3. Post callback form
		const form = new URLSearchParams({
			state,
			id_token: idToken,
		});

		const cbRes = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			redirect: "manual",
		});

		expect(cbRes.status).toBe(303);
		expect(cbRes.headers.get("location")).toBe("/account/");

		const setCookie = cbRes.headers.get("set-cookie") || "";
		expect(setCookie).toContain("va_session=");
		const cookie = setCookie.split(";")[0];

		// 4. Verify /api/me returns the Google account
		const meRes = await fetch(`${baseUrl}/api/me`, {
			headers: { Cookie: cookie },
		});
		expect(meRes.status).toBe(200);
		const { user } = await meRes.json();
		expect(user).toBeTruthy();
		expect(user.provider).toBe("google");
		expect(user.email).toBe("tarnished@example.com");
		expect(user.name).toBe("Tarnished One");
	});

	test("POST /api/auth/google/callback redirects with error when state is unknown or expired", async () => {
		const form = new URLSearchParams({
			state: "non-existent-state",
			id_token: "dummy-token",
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		const location = res.headers.get("location") || "";
		expect(location).toStartWith("/signin/?error=");
	});

	test("POST /api/auth/google/callback redirects with error when token signature is invalid", async () => {
		// 1. Start flow
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		// 2. Make token signed with a DIFFERENT private key
		const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
		const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-kid" })).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				iss: "https://accounts.google.com",
				aud: "test-google-client",
				sub: "google-sub-42",
				email: "hacker@example.com",
				email_verified: true,
				nonce,
				exp: Math.floor(Date.now() / 1000) + 3600,
			}),
		).toString("base64url");
		const badSig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), otherKey).toString("base64url");
		const badToken = `${header}.${payload}.${badSig}`;

		const form = new URLSearchParams({
			state,
			id_token: badToken,
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback redirects with error when user cancels", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;

		const form = new URLSearchParams({
			state,
			error: "access_denied",
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects token with alg: none", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		const header = Buffer.from(JSON.stringify({ alg: "none", kid: "test-kid" })).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				iss: "https://accounts.google.com",
				aud: "test-google-client",
				sub: "google-sub-none",
				email: "none@example.com",
				email_verified: true,
				nonce,
				exp: Math.floor(Date.now() / 1000) + 3600,
			}),
		).toString("base64url");
		const noneToken = `${header}.${payload}.`;

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: noneToken }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects token with wrong audience", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		const token = await makeIdToken({
			iss: "https://accounts.google.com",
			aud: "wrong-client-id",
			sub: "google-sub-aud",
			email: "aud@example.com",
			email_verified: true,
			nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: token }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects token with wrong issuer", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		const token = await makeIdToken({
			iss: "https://evil.issuer.com",
			aud: "test-google-client",
			sub: "google-sub-iss",
			email: "iss@example.com",
			email_verified: true,
			nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: token }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects expired token", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		const token = await makeIdToken({
			iss: "https://accounts.google.com",
			aud: "test-google-client",
			sub: "google-sub-exp",
			email: "exp@example.com",
			email_verified: true,
			nonce,
			exp: Math.floor(Date.now() / 1000) - 300, // expired 5 minutes ago
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: token }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects token with future nbf", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		const token = await makeIdToken({
			iss: "https://accounts.google.com",
			aud: "test-google-client",
			sub: "google-sub-nbf",
			email: "nbf@example.com",
			email_verified: true,
			nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
			nbf: Math.floor(Date.now() / 1000) + 1800, // not valid for 30 minutes
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: token }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects token with unknown kid not in JWKS", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		const token = await makeIdToken(
			{
				iss: "https://accounts.google.com",
				aud: "test-google-client",
				sub: "google-sub-kid",
				email: "kid@example.com",
				email_verified: true,
				nonce,
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			"unknown-unlisted-kid",
		);

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: token }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects malformed token without 500 error", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: "not-a-valid-token-at-all" }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects garbage token with 3 parts without 500 error", async () => {
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: "garbage.token.here" }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/signin/?error=");
	});

	test("POST /api/auth/google/callback rejects valid token when email is not on allowlist", async () => {
		const allowlistApi = createApi({
			root: tmpDir,
			googleClientId: "test-google-client",
			publicUrl: "http://127.0.0.1:8080",
			googleCertsUrl: certsUrl,
			allowedEmails: ["allowed@example.com"],
		});
		const allowlistServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const url = new URL(req.url);
				const res = await allowlistApi.handle(req, url);
				return res || new Response(null, { status: 404 });
			},
		});

		try {
			const startRes = await fetch(`http://127.0.0.1:${allowlistServer.port}/api/auth/google/start?next=/`, {
				redirect: "manual",
			});
			const locUrl = new URL(startRes.headers.get("location")!);
			const state = locUrl.searchParams.get("state")!;
			const nonce = locUrl.searchParams.get("nonce")!;

			const token = await makeIdToken({
				iss: "https://accounts.google.com",
				aud: "test-google-client",
				sub: "google-sub-unauthorized",
				email: "unauthorized@example.com",
				name: "Unauthorized User",
				email_verified: true,
				nonce,
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

			const res = await fetch(`http://127.0.0.1:${allowlistServer.port}/api/auth/google/callback`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ state, id_token: token }).toString(),
				redirect: "manual",
			});
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toContain("/signin/?error=");
		} finally {
			allowlistServer.stop(true);
			allowlistApi.close();
		}
	});

	test("POST /api/auth/google/callback returns 429 when rate limit is exceeded", async () => {
		let lastStatus = 0;
		for (let i = 0; i < 22; i++) {
			const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.22" },
				body: new URLSearchParams({ state: "dummy-state", id_token: "dummy" }).toString(),
				redirect: "manual",
			});
			lastStatus = res.status;
		}
		expect(lastStatus).toBe(429);
	});

	test("identities table stores (provider, issuer, subject) mapping for Google sign-ins", async () => {
		// Log in with a valid token
		const startRes = await fetch(`${baseUrl}/api/auth/google/start?next=/`, { redirect: "manual" });
		const locUrl = new URL(startRes.headers.get("location")!);
		const state = locUrl.searchParams.get("state")!;
		const nonce = locUrl.searchParams.get("nonce")!;

		const token = await makeIdToken({
			iss: "https://accounts.google.com",
			aud: "test-google-client",
			sub: "google-sub-identity-test",
			email: "identity@example.com",
			name: "Identity Test",
			email_verified: true,
			nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});

		const res = await fetch(`${baseUrl}/api/auth/google/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state, id_token: token }).toString(),
			redirect: "manual",
		});
		expect(res.status).toBe(303);

		const row = api._db
			.prepare("SELECT * FROM identities WHERE provider = 'google' AND subject = ?")
			.get("google-sub-identity-test") as any;
		expect(row).toBeDefined();
		expect(row.issuer).toBe("https://accounts.google.com");
	});
});