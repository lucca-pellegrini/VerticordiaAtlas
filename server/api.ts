// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// api.ts: optional accounts and cross-device sync, under /api/. The app works without any of this: an account only
// lets the same progress follow you to another device. Everything is in one SQLite file (data/atlas.db).
//
// Accounts: Google sign-in (the ID token is verified here, and the account is keyed by Google's `sub`), or a random
// secret key (shown once; only its hash is kept). Either way the server issues its own session cookie.
// Sessions last 30 days and slide forward when they are within 7 days of expiring.
//
// Sync: each item (a profile, or a map's presets or view) is stored whole, with a server timestamp. A client sends the
// timestamp it last saw ("base"); if the server has something newer, the client is told so and decides what to keep.

import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { ServerWebSocket } from "bun";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator";

import { encodeSecret, formatSecret, normalizeSecret, validateSecretKey } from "../src/shared/secret-key.ts";
import { contentKey, sendKey } from "../src/shared/sync-rules.ts";
import type { SyncItem, SyncPushResult, UserAccount } from "../src/shared/types.ts";

export { normalizeSecret, validateSecretKey };

const DAY = 86400000;
const SESSION_DAYS = 30,
	REFRESH_WITHIN = 7 * DAY;
const COOKIE = "va_session";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
// a key names one item: a profile, or a map's presets or view. Only plain slugs and ids are allowed in it.
const SEG = "[A-Za-z0-9._-]{1,80}";
const KEY_PATTERN = new RegExp(`^(profile:${SEG}:${SEG}|meta:(presets|view):${SEG}(:${SEG})?)$`);
const MAX_VALUE = 2_000_000,
	MAX_ITEMS = 200;

export const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// derives a memorable, deterministic username fingerprint for secret key accounts
export function secretName(seed: string): string {
	const isHex = /^[0-9a-f]{64}$/i.test(seed);
	const hash = isHex ? seed : sha256(normalizeSecret(seed) || seed);
	const numSeed = Buffer.from(hash, "hex").readInt32BE(0);
	return uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: " ",
		style: "capital",
		seed: numSeed,
	});
}

export interface ApiOptions {
	root: string;
	debug?: boolean;
	googleClientId?: string | null;
	publicUrl?: string | null;
	googleCertsUrl?: string;
	allowedEmails?: string[] | null;
}

interface HttpError extends Error {
	status?: number;
}

interface SessionInfo {
	token: string;
	user: UserAccount;
	tokenHash: string;
	expiresAt: number;
}

export interface WsData {
	userId: string;
	tokenHash: string;
	client: string;
}

export function createApi({
	root,
	debug = false,
	googleClientId = null,
	publicUrl = null,
	googleCertsUrl = process.env.GOOGLE_CERTS_URL || "https://www.googleapis.com/oauth2/v3/certs",
	allowedEmails = null,
}: ApiOptions) {
	mkdirSync(path.join(root, "data"), { recursive: true });
	const db = new Database(path.join(root, "data", "atlas.db"), { create: true });
	db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'secret')),
      google_sub TEXT UNIQUE,
      email TEXT,
      display_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identities (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      PRIMARY KEY (provider, issuer, subject)
    );
    CREATE INDEX IF NOT EXISTS identities_by_user ON identities(user_id);
    INSERT OR IGNORE INTO identities (user_id, provider, issuer, subject)
      SELECT id, 'google', 'https://accounts.google.com', google_sub
      FROM users WHERE provider = 'google' AND google_sub IS NOT NULL;
    CREATE TABLE IF NOT EXISTS secret_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      next TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS game_popularity (
      game TEXT PRIMARY KEY,
      requests INTEGER NOT NULL,
      last_requested INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      game TEXT NOT NULL,
      original_name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL,
      PRIMARY KEY (game, original_name)
    );
  `);

	// backfill display_name for secret accounts that lack one
	const missingSecretNames = db
		.prepare(
			`SELECT u.id, a.secret_hash
             FROM users u
             JOIN secret_accounts a ON a.user_id = u.id
             WHERE u.provider = 'secret' AND (u.display_name IS NULL OR u.display_name = '')`,
		)
		.all() as { id: string; secret_hash: string }[];
	for (const m of missingSecretNames) {
		db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(secretName(m.secret_hash), m.id);
	}

	const now = (): number => Date.now();

	/* ---------- rate limit for the sign-in endpoints ---------- */
	const hits = new Map<string, { start: number; count: number }>();
	function allowLogin(ip: string): boolean {
		const t = now();
		if (hits.size > 10000) hits.clear();
		let h = hits.get(ip);
		if (!h || t - h.start > 15 * 60 * 1000) {
			h = { start: t, count: 0 };
			hits.set(ip, h);
		}
		h.count++;
		return h.count <= 20;
	}

	/* ---------- small helpers ---------- */
	const dbg = (...parts: unknown[]) => {
		if (debug) console.log("[auth]", new Date().toISOString(), ...parts);
	};
	const json = (status: number, body: unknown, headers: HeadersInit = {}): Response => {
		const h = new Headers(headers);
		if (!h.has("Content-Type")) h.set("Content-Type", "application/json; charset=utf-8");
		if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
		return new Response(JSON.stringify(body), { status, headers: h });
	};
	const clientIp = (req: Request): string =>
		String(req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown");
	const secure = (req: Request): boolean =>
		Boolean(new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https");

	async function readJson(req: Request, limit: number): Promise<any> {
		if (!String(req.headers.get("content-type") || "").startsWith("application/json"))
			throw httpError(415, "expected JSON");
		const text = await req.text();
		if (text.length > limit) throw httpError(413, "too large");
		try {
			return JSON.parse(text || "{}");
		} catch {
			throw httpError(400, "bad JSON");
		}
	}
	async function readForm(req: Request, limit: number): Promise<Record<string, string>> {
		if (!String(req.headers.get("content-type") || "").startsWith("application/x-www-form-urlencoded"))
			throw httpError(415, "expected a form");
		const text = await req.text();
		if (text.length > limit) throw httpError(413, "too large");
		return Object.fromEntries(new URLSearchParams(text));
	}
	function httpError(status: number, message: string): HttpError {
		const e: HttpError = new Error(message);
		e.status = status;
		return e;
	}

	// a malformed cookie (say, a stray "%") must never throw: it is read as it was sent, and cannot match a session anyway
	const unescapeCookie = (v: string): string => {
		try {
			return decodeURIComponent(v);
		} catch {
			return v;
		}
	};
	const parseCookies = (header: string): Record<string, string> =>
		Object.fromEntries(
			String(header || "")
				.split(";")
				.map((c) => c.trim().split("="))
				.filter((p): p is [string, string] => p.length === 2)
				.map(([k, v]) => [k, unescapeCookie(v)]),
		);
	const cookies = (req: Request): Record<string, string> => parseCookies(req.headers.get("cookie") || "");
	const cookieHeader = (req: Request, value: string, maxAge: number): string =>
		`${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`;

	const publicUser = (u: any): UserAccount => ({
		id: String(u.id),
		provider: u.provider as "google" | "secret",
		email: u.email ? String(u.email) : null,
		name:
			u.provider === "google"
				? String(u.display_name || u.email || "Google account")
				: String(u.display_name || (u.secret_hash ? secretName(u.secret_hash) : secretName(u.id))),
		...(u.created_at ? { createdAt: Number(u.created_at) } : {}),
	});

	/* ---------- sessions ---------- */
	function sessionFromToken(token: string): SessionInfo | null {
		if (!token) return null;
		const row = db
			.prepare(
				`SELECT s.token_hash, s.expires_at, u.id, u.provider, u.email, u.display_name, u.created_at
                            FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
			)
			.get(sha256(token)) as any;
		if (!row) return null;
		const t = now();
		if (row.expires_at <= t) {
			db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
			return null;
		}
		return { token, user: publicUser(row), tokenHash: String(row.token_hash), expiresAt: Number(row.expires_at) };
	}
	function sessionFrom(req: Request): SessionInfo | null {
		return sessionFromToken(cookies(req)[COOKIE]);
	}
	// sliding expiry: a session close to its end is extended, and the cookie with it
	function touch(req: Request, session: SessionInfo): string | null {
		const t = now();
		if (session.expiresAt - t < REFRESH_WITHIN) {
			const expires = t + SESSION_DAYS * DAY;
			db.prepare("UPDATE sessions SET expires_at = ?, last_used = ? WHERE token_hash = ?").run(
				expires,
				t,
				session.tokenHash,
			);
			return cookieHeader(req, session.token, SESSION_DAYS * 86400);
		}
		return null;
	}
	// binds a Google sign-in to the browser that started it. Google posts back cross-site, so the cookie must be
	// SameSite=None, which browsers only accept with Secure: this binding is therefore only on HTTPS (see secure()).
	const OAUTH_COOKIE = "va_oauth",
		OAUTH_PATH = "/api/auth/google";
	const oauthCookie = (_req: Request, value: string, maxAge: number): string =>
		`${OAUTH_COOKIE}=${value}; Path=${OAUTH_PATH}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
	function startSession(req: Request, userId: string): string {
		const token = crypto.randomBytes(32).toString("base64url");
		const t = now();
		db.prepare(
			"INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used) VALUES (?, ?, ?, ?, ?)",
		).run(sha256(token), userId, t, t + SESSION_DAYS * DAY, t);
		return cookieHeader(req, token, SESSION_DAYS * 86400);
	}

	/* ---------- Google: verify the ID token via jose ---------- */
	const googleJwks = createRemoteJWKSet(new URL(googleCertsUrl), {
		cacheMaxAge: 60 * 60 * 1000,
		cooldownDuration: 30_000, // at most one forced refetch per 30 s, however many bad tokens arrive
	});

	async function verifyGoogleToken(
		token: string,
		nonce: string,
	): Promise<{ sub: string; email: string; name: string; iss: string }> {
		if (!googleClientId) throw httpError(401, "wrong audience");
		let payload;
		try {
			({ payload } = await jwtVerify(token, googleJwks, {
				issuer: GOOGLE_ISSUERS,
				audience: googleClientId,
				algorithms: ["RS256"],
				clockTolerance: 30,
			}));
		} catch (e: any) {
			dbg("verify: " + (e?.code ?? e?.message));
			throw httpError(401, "Google could not confirm your token");
		}
		if (payload.email_verified !== true) throw httpError(401, "e-mail not verified");
		if (!nonce || payload.nonce !== nonce) throw httpError(401, "wrong nonce");
		if (typeof payload.sub !== "string" || !payload.sub) throw httpError(401, "no subject");
		return {
			iss: String(payload.iss || ""),
			sub: payload.sub,
			email: String(payload.email || ""),
			name: String(payload.name || ""),
		};
	}

	/* ---------- secret keys: 128 random bits with scattered checksum, shown once, stored as a hash ---------- */
	function newSecret(): string {
		return formatSecret(encodeSecret(crypto.randomBytes(16)));
	}

	/* ---------- sync ---------- */
	/* what a change means for sync: contentKey (conflicts) and sendKey (whether to push) are in shared/sync-rules.ts */

	function validItem(it: any): it is SyncItem {
		if (!it || typeof it.key !== "string" || !KEY_PATTERN.test(it.key)) return false;
		// "value" must be present: null (a deletion) or a JSON value. undefined is not JSON and would reach SQLite as undefined
		if (!("value" in it) || it.value === undefined) return false;
		if (it.value !== null) {
			const jsonStr = JSON.stringify(it.value);
			if (typeof jsonStr !== "string" || jsonStr.length > MAX_VALUE) return false;
		}
		return true;
	}
	const getSyncData = db.prepare("SELECT value, updated_at FROM user_data WHERE user_id = ? AND key = ?");
	const putSyncData = db.prepare(`INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
                            ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
	const pushTransaction = db.transaction((userId: string, items: SyncItem[]): SyncPushResult[] => {
		const results: SyncPushResult[] = [];
		for (const it of items) {
			const cur = getSyncData.get(userId, it.key) as
				{ value: string | null; updated_at: number } | null | undefined;
			const base = Number.isFinite(it.base) ? Number(it.base) : 0;
			if (cur) {
				const curValue = cur.value === null ? null : JSON.parse(cur.value);
				if (sendKey(it.key, curValue) === sendKey(it.key, it.value)) {
					// nothing to store: the device is simply up to date
					results.push({ key: it.key, status: "ok", updated_at: cur.updated_at, same: true });
					continue;
				}
			}
			if (cur && cur.updated_at > base) {
				const curValue = cur.value === null ? null : JSON.parse(cur.value);
				// newer on the server, but the same content: only the position differs, so the newer position simply wins
				if (contentKey(it.key, curValue) !== contentKey(it.key, it.value)) {
					results.push({ key: it.key, status: "conflict", value: curValue, updated_at: cur.updated_at });
					continue;
				}
			}
			// server time orders the writes; it always moves forward for a key
			let t = now();
			if (cur && t <= cur.updated_at) t = cur.updated_at + 1;
			const value = it.value === null ? null : JSON.stringify(it.value);
			putSyncData.run(userId, it.key, value, t);
			results.push({ key: it.key, status: "ok", updated_at: t });
		}
		return results;
	});

	function syncPush(userId: string, items: SyncItem[]): SyncPushResult[] {
		return pushTransaction.immediate(userId, items);
	}
	const syncPull = (userId: string): SyncItem[] =>
		(
			db.prepare("SELECT key, value, updated_at FROM user_data WHERE user_id = ?").all(userId) as {
				key: string;
				value: string | null;
				updated_at: number;
			}[]
		).map((r) => ({ key: r.key, value: r.value === null ? null : JSON.parse(r.value), updated_at: r.updated_at }));

	/* ---------- the routes ---------- */
	/* ---------- live updates: a WebSocket per signed-in device, told when another device pushed ---------- */
	const MAX_SOCKETS_PER_USER = 8;
	const sockets = new Map<string, Set<ServerWebSocket<WsData>>>(); // user id -> Set of ServerWebSocket<WsData>

	function announce(userId: string, exceptClient: string) {
		for (const ws of sockets.get(userId) || [])
			if (!exceptClient || ws.data.client !== exceptClient) ws.send('{"type":"changed"}');
	}
	function dropSockets(match: (ws: ServerWebSocket<WsData>) => boolean) {
		// sign-out: the sockets it belonged to go too
		for (const set of sockets.values()) for (const ws of [...set]) if (match(ws)) ws.close(4401, "signed out");
	}
	const sessionAlive = (tokenHash: string): boolean => {
		const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as
			{ expires_at: number } | undefined;
		return !!row && row.expires_at > now();
	};

	const heartbeatTimer = setInterval(() => {
		for (const [userId, set] of sockets) {
			for (const ws of [...set]) {
				if (!sessionAlive(ws.data.tokenHash)) {
					set.delete(ws);
					ws.close(4401, "signed out");
				}
			}
			if (!set.size) sockets.delete(userId);
		}
	}, 25_000);
	heartbeatTimer.unref();

	const websocket = {
		open(ws: ServerWebSocket<WsData>) {
			const { userId } = ws.data;
			const set = sockets.get(userId) || new Set<ServerWebSocket<WsData>>();
			sockets.set(userId, set);
			set.add(ws);
			while (set.size > MAX_SOCKETS_PER_USER) {
				const oldest = set.values().next().value!;
				set.delete(oldest);
				oldest.close(1008, "too many connections"); // the oldest goes
			}
			ws.send('{"type":"hello"}');
		},
		message() {
			// clients have nothing to say beyond proving they are alive
		},
		close(ws: ServerWebSocket<WsData>) {
			const { userId } = ws.data;
			const set = sockets.get(userId);
			if (set) {
				set.delete(ws);
				if (!set.size) sockets.delete(userId);
			}
		},
	};

	function upgrade(
		req: Request,
		server: { upgrade: (req: Request, options?: { data?: WsData }) => boolean },
	): Response | undefined {
		const url = new URL(req.url);
		if (url.pathname !== "/api/ws") return new Response("Bad Request", { status: 400 });
		// a page on another site must not be able to open this socket with the visitor's cookie
		const origin = req.headers.get("origin");
		if (origin) {
			let host: string | null = null;
			try {
				host = new URL(origin).host;
			} catch {
				/* malformed */
			}
			const hosts = [req.headers.get("host"), ...String(req.headers.get("x-forwarded-host") || "").split(",")]
				.map((h) => String(h || "").trim())
				.filter(Boolean);
			if (!host || !hosts.includes(host)) return new Response("Forbidden", { status: 403 });
		}
		const cookieHdr = req.headers.get("cookie") || "";
		const token = parseCookies(cookieHdr)[COOKIE];
		if (!token) return new Response("Unauthorized", { status: 401 });
		const session = sessionFromToken(token);
		if (!session) return new Response("Unauthorized", { status: 401 });
		const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(session.tokenHash) as
			| {
					user_id: string;
			  }
			| undefined;
		if (!row) return new Response("Unauthorized", { status: 401 });
		const userId = row.user_id;
		const client = String(url.searchParams.get("c") || "").slice(0, 64);
		const upgraded = server.upgrade(req, {
			data: { userId, tokenHash: session.tokenHash, client },
		});
		if (!upgraded) return new Response("Bad Request", { status: 400 });
	}

	async function handle(req: Request, url: URL): Promise<Response | null> {
		try {
			const route = `${req.method} ${url.pathname}`;
			const ip = clientIp(req);

			if (route === "GET /api/config") return json(200, { googleClientId });

			if (route === "GET /api/me") {
				const session = sessionFrom(req);
				if (!session) return json(200, { user: null });
				const cookie = touch(req, session);
				const headers = new Headers();
				if (cookie) headers.append("Set-Cookie", cookie);
				const sessionsRow = db
					.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?")
					.get(session.user.id, now()) as { n: number } | undefined;
				const syncedRow = db
					.prepare("SELECT COUNT(*) AS n FROM user_data WHERE user_id = ? AND value IS NOT NULL")
					.get(session.user.id) as { n: number } | undefined;
				return json(
					200,
					{
						user: {
							...session.user,
							sessions: Number(sessionsRow?.n || 1),
							syncedItems: Number(syncedRow?.n || 0),
						},
					},
					headers,
				);
			}

			if (route === "GET /api/auth/google/start") {
				const back = (msg: string) =>
					new Response(null, {
						status: 303,
						headers: {
							Location: "/signin/?error=" + encodeURIComponent(msg),
							"Cache-Control": "no-store",
						},
					});
				if (!googleClientId || !publicUrl)
					return back("We can't seem to reach Google for sign-in. Try again later.");
				if (!allowLogin(ip)) return back("Too many attempts. Please wait a little and try again.");
				const n = url.searchParams.get("next") || "";
				const next = /^\/(?!\/)/.test(n) ? n : "/"; // only a path on this site
				const state = crypto.randomBytes(24).toString("base64url"),
					nonce = crypto.randomBytes(24).toString("base64url");
				dbg("start: next=" + next + " redirect_uri=" + publicUrl + "/api/auth/google/callback");
				db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(now());
				db.prepare("INSERT INTO oauth_states (state, nonce, next, expires_at) VALUES (?, ?, ?, ?)").run(
					state,
					nonce,
					next,
					now() + 10 * 60 * 1000,
				);
				const q = new URLSearchParams({
					client_id: googleClientId,
					redirect_uri: `${publicUrl}/api/auth/google/callback`,
					response_type: "id_token",
					response_mode: "form_post",
					scope: "openid email profile",
					state,
					nonce,
					prompt: "select_account",
				});
				const headers = new Headers({
					Location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
					"Cache-Control": "no-store",
				});
				if (secure(req)) headers.append("Set-Cookie", oauthCookie(req, state, 600));
				else dbg("start: not HTTPS, so the sign-in is not bound to this browser (development only)");
				return new Response(null, { status: 302, headers });
			}

			if (route === "POST /api/auth/google/callback") {
				if (!allowLogin(ip)) throw httpError(429, "too many attempts, try again later");
				// Google posts the signed ID token back here (response_mode=form_post). Each state is good once, for 10 minutes.
				const back = (msg: string) => {
					const headers = new Headers({
						Location: "/signin/?error=" + encodeURIComponent(msg),
						"Cache-Control": "no-store",
					});
					headers.append("Set-Cookie", oauthCookie(req, "", 0));
					return new Response(null, { status: 303, headers });
				};
				const form = await readForm(req, 16_000);
				const state = String(form.state || "");
				// Google names the signed token id_token in this flow (credential is the name the button uses)
				const token = String(form.id_token || form.credential || "");
				const row = db
					.prepare("SELECT nonce, next, expires_at FROM oauth_states WHERE state = ?")
					.get(state) as { nonce: string; next: string; expires_at: number } | undefined;
				db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
				dbg(
					"callback: fields=[" +
						Object.keys(form).join(",") +
						"] error=" +
						(form.error || "-") +
						" state_known=" +
						!!row +
						" expired=" +
						(row ? row.expires_at <= now() : "-") +
						" token_bytes=" +
						token.length,
				);
				if (debug && token) {
					// the claims only, never the signature or the e-mail address
					try {
						const parts = String(token).split(".");
						if (parts.length > 1) {
							const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
							dbg(
								"callback: token iss=" +
									p.iss +
									" aud=" +
									p.aud +
									" azp=" +
									p.azp +
									" exp=" +
									p.exp +
									" email_verified=" +
									p.email_verified +
									" nonce_matches=" +
									(!!row && p.nonce === row.nonce),
							);
						}
					} catch (e: any) {
						dbg("callback: token does not decode: " + e.message);
					}
				}
				if (!row || row.expires_at <= now()) {
					dbg("callback: unknown or expired state");
					return back("That sign-in took too long. Please try again.");
				}
				// the state must belong to this browser: a sign-in started by someone else (or in another browser) is refused
				if (secure(req) && cookies(req)[OAUTH_COOKIE] !== state) {
					dbg("callback: state not bound to this browser");
					return back("This sign-in was started in another browser. Please try again here.");
				}
				if (!token) {
					dbg("callback: no credential, cancelled or refused by Google");
					return back("Sign-in with Google was cancelled.");
				}
				let g;
				try {
					g = await verifyGoogleToken(token, row.nonce);
				} catch (e: any) {
					dbg("callback: verification failed: " + e.message);
					return back("Google could not confirm your account. Please try again.");
				}
				const allowedEmailSet = allowedEmails ? new Set(allowedEmails.map((e) => e.toLowerCase())) : null;
				if (allowedEmailSet && !allowedEmailSet.has(g.email.toLowerCase())) {
					dbg("callback: email not on allowlist: " + g.email);
					return back("Your email address is not authorized.");
				}
				const canonicalIss = "https://accounts.google.com";
				const existingIdentity = db
					.prepare("SELECT user_id FROM identities WHERE provider = 'google' AND issuer = ? AND subject = ?")
					.get(canonicalIss, g.sub) as { user_id: string } | undefined;

				let userId: string;
				if (existingIdentity) {
					userId = existingIdentity.user_id;
					db.prepare("UPDATE users SET email = ?, display_name = ? WHERE id = ?").run(
						g.email,
						g.name,
						userId,
					);
				} else {
					userId = crypto.randomUUID();
					const createGoogleUser = db.transaction(() => {
						db.prepare(
							`INSERT INTO users (id, provider, google_sub, email, display_name, created_at) VALUES (?, 'google', ?, ?, ?, ?)
                            ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`,
						).run(userId, g.sub, g.email, g.name, now());
						db.prepare(
							`INSERT INTO identities (user_id, provider, issuer, subject) VALUES (?, 'google', ?, ?)
                            ON CONFLICT (provider, issuer, subject) DO UPDATE SET user_id = excluded.user_id`,
						).run(userId, canonicalIss, g.sub);
					});
					createGoogleUser();
				}
				const sessionCookie = startSession(req, userId);
				const headers = new Headers({
					Location: row.next,
					"Cache-Control": "no-store",
				});
				headers.append("Set-Cookie", sessionCookie);
				headers.append("Set-Cookie", oauthCookie(req, "", 0));
				return new Response(null, { status: 303, headers });
			}

			if (route === "POST /api/auth/secret/new") {
				if (!allowLogin(ip)) throw httpError(429, "too many attempts, try again later");
				await readJson(req, 1000);
				const secret = newSecret();
				return json(200, { secret });
			}

			if (route === "POST /api/auth/secret/confirm") {
				if (!allowLogin(ip)) throw httpError(429, "too many attempts, try again later");
				const body = await readJson(req, 1000);
				const v = validateSecretKey(body.secret);
				if (!v.valid) throw httpError(400, v.error);
				const norm = v.normalized;
				const secretHash = sha256(norm);
				const existing = db.prepare("SELECT 1 FROM secret_accounts WHERE secret_hash = ?").get(secretHash);
				if (existing) throw httpError(409, "this secret key is already registered");
				const id = crypto.randomUUID();
				const displayName = secretName(secretHash);
				const createSecretAccount = db.transaction((userId: string, name: string, hash: string) => {
					db.prepare(
						"INSERT INTO users (id, provider, display_name, created_at) VALUES (?, 'secret', ?, ?)",
					).run(userId, name, now());
					db.prepare("INSERT INTO secret_accounts (user_id, secret_hash) VALUES (?, ?)").run(userId, hash);
				});
				createSecretAccount(id, displayName, secretHash);
				const sessionCookie = startSession(req, id);
				const headers = new Headers();
				headers.append("Set-Cookie", sessionCookie);
				return json(
					200,
					{
						ok: true,
						user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
					},
					headers,
				);
			}

			if (route === "POST /api/auth/secret/login") {
				if (!allowLogin(ip)) throw httpError(429, "too many attempts, try again later");
				const body = await readJson(req, 1000);
				const v = validateSecretKey(body.secret);
				if (!v.valid) throw httpError(400, v.error);
				const norm = v.normalized;
				const row = db
					.prepare(
						`SELECT u.* FROM secret_accounts a JOIN users u ON u.id = a.user_id WHERE a.secret_hash = ?`,
					)
					.get(sha256(norm)) as any;
				if (!row) throw httpError(401, "that key does not match an account");
				const sessionCookie = startSession(req, String(row.id));
				const headers = new Headers();
				headers.append("Set-Cookie", sessionCookie);
				return json(200, { user: publicUser(row) }, headers);
			}

			if (route === "POST /api/auth/logout") {
				const session = sessionFrom(req);
				if (session) {
					db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.tokenHash);
					dropSockets((ws) => ws.data.tokenHash === session.tokenHash);
				}
				const headers = new Headers();
				headers.append("Set-Cookie", cookieHeader(req, "", 0));
				return json(200, { ok: true }, headers);
			}

			if (route === "POST /api/auth/logout-all") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(session.tokenHash) as {
					user_id: string;
				};
				const userId = row.user_id;
				db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
				for (const ws of [...(sockets.get(userId) || [])]) ws.close(4401, "signed out");
				const headers = new Headers();
				headers.append("Set-Cookie", cookieHeader(req, "", 0));
				return json(200, { ok: true }, headers);
			}

			if (route === "POST /api/auth/delete-account" || route === "DELETE /api/me") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				for (const ws of [...(sockets.get(userId) || [])]) ws.close(4401, "account deleted");
				sockets.delete(userId);
				db.prepare("DELETE FROM users WHERE id = ?").run(userId);
				const headers = new Headers();
				headers.append("Set-Cookie", cookieHeader(req, "", 0));
				return json(200, { ok: true }, headers);
			}

			if (route === "GET /api/sync" || route === "POST /api/sync") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const cookie = touch(req, session);
				const headers = new Headers();
				if (cookie) headers.append("Set-Cookie", cookie);
				const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(session.tokenHash) as {
					user_id: string;
				};
				const userId = row.user_id;
				if (req.method === "GET") return json(200, { items: syncPull(userId) }, headers);
				const body = await readJson(req, 8 * 1024 * 1024);
				const items: unknown[] = Array.isArray(body.items) ? body.items : [];
				if (items.length > MAX_ITEMS || !items.every(validItem)) throw httpError(400, "bad sync request");
				const results = syncPush(userId, items);
				if (results.some((r) => r.status === "ok" && !r.same))
					announce(userId, String(body.client || "").slice(0, 64)); // the other devices of this account
				return json(200, { results }, headers);
			}

			return null;
		} catch (e: any) {
			if (e.status) return json(e.status, { error: e.message });
			console.error("api:", e);
			return json(500, { error: "server error" });
		}
	}

	// expired sessions and sign-in states are removed at startup and hourly, not only when their cookie comes back
	const sweep = () => {
		try {
			const sessions = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now()).changes;
			const states = db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(now()).changes;
			if (sessions || states) dbg(`sweep: removed ${sessions} expired session(s), ${states} sign-in state(s)`);
		} catch (e: any) {
			console.error("api: cleanup failed:", e.message);
		}
	};
	sweep();
	const sweepTimer = setInterval(sweep, 60 * 60 * 1000);
	sweepTimer.unref();

	// How often a game's maps are opened, for the tile cache to decide what to keep. One write per game when one of its maps
	// is newly requested (the caller throttles), never per tile.
	const recordGameRequest = (game: string): void => {
		db.prepare(
			`INSERT INTO game_popularity (game, requests, last_requested) VALUES (?, 1, ?)
             ON CONFLICT (game) DO UPDATE SET requests = requests + 1, last_requested = excluded.last_requested`,
		).run(game, now());
	};
	const gamePopularity = (): Map<string, number> =>
		new Map(
			(
				db.prepare("SELECT game, requests FROM game_popularity").all() as { game: string; requests: number }[]
			).map((r) => [r.game, r.requests]),
		);

	const hasMediaStmt = db.prepare("SELECT 1 FROM media WHERE game = ? AND original_name = ?");
	const getMediaStmt = db.prepare(
		"SELECT game, original_name, sha256, size, uploaded_at FROM media WHERE game = ? AND original_name = ?",
	);
	const putMediaStmt = db.prepare(
		`INSERT INTO media (game, original_name, sha256, size, uploaded_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (game, original_name) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, uploaded_at = excluded.uploaded_at`,
	);
	const hasMedia = (game: string, originalName: string): boolean => Boolean(hasMediaStmt.get(game, originalName));
	const getMedia = (
		game: string,
		originalName: string,
	): { game: string; original_name: string; sha256: string; size: number; uploaded_at: number } | null =>
		(getMediaStmt.get(game, originalName) as any) ?? null;
	const recordMedia = (row: {
		game: string;
		original_name: string;
		sha256: string;
		size: number;
		uploaded_at?: number;
	}): void => {
		putMediaStmt.run(row.game, row.original_name, row.sha256, row.size, row.uploaded_at ?? now());
	};

	return {
		handle,
		upgrade,
		websocket,
		recordGameRequest,
		gamePopularity,
		hasMedia,
		getMedia,
		recordMedia,
		wsCount: (): number => {
			let count = 0;
			for (const set of sockets.values()) count += set.size;
			return count;
		},
		close: () => {
			clearInterval(heartbeatTimer);
			clearInterval(sweepTimer);
			db.close();
		},
		_db: db,
		newSecret,
		normalizeSecret,
		secretName,
	};
}