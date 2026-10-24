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

import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";

import { contentKey, sendKey } from "../src/shared/sync-rules.ts";
import type { SyncItem, SyncPushResult, UserAccount } from "../src/shared/types.ts";
import { acceptWebSocket, type WebSocketConn } from "./ws.ts";

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
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ApiOptions {
	root: string;
	debug?: boolean;
	googleClientId?: string | null;
	publicUrl?: string | null;
	googleCertsUrl?: string;
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

interface SocketEntry {
	ws: WebSocketConn;
	client: string;
	tokenHash: string;
}

export function createApi({
	root,
	debug = false,
	googleClientId = null,
	publicUrl = null,
	googleCertsUrl = process.env.GOOGLE_CERTS_URL || "https://www.googleapis.com/oauth2/v3/certs",
}: ApiOptions) {
	mkdirSync(path.join(root, "data"), { recursive: true });
	const db = new DatabaseSync(path.join(root, "data", "atlas.db"));
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
  `);

	const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
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
	const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
		res.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...headers,
		});
		res.end(JSON.stringify(body));
	};
	const clientIp = (req: IncomingMessage): string =>
		String(req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown")
			.split(",")[0]
			.trim();
	const secure = (req: IncomingMessage): boolean =>
		Boolean((req.socket as { encrypted?: boolean }).encrypted || req.headers["x-forwarded-proto"] === "https");

	async function readJson(req: IncomingMessage, limit: number): Promise<any> {
		if (!String(req.headers["content-type"] || "").startsWith("application/json"))
			throw httpError(415, "expected JSON");
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const c of req) {
			const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
			size += buf.length;
			if (size > limit) throw httpError(413, "too large");
			chunks.push(buf);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		} catch {
			throw httpError(400, "bad JSON");
		}
	}
	async function readForm(req: IncomingMessage, limit: number): Promise<Record<string, string>> {
		if (!String(req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded"))
			throw httpError(415, "expected a form");
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const c of req) {
			const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
			size += buf.length;
			if (size > limit) throw httpError(413, "too large");
			chunks.push(buf);
		}
		return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
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
	const cookies = (req: IncomingMessage): Record<string, string> =>
		Object.fromEntries(
			String(req.headers.cookie || "")
				.split(";")
				.map((c) => c.trim().split("="))
				.filter((p): p is [string, string] => p.length === 2)
				.map(([k, v]) => [k, unescapeCookie(v)]),
		);
	const cookieHeader = (req: IncomingMessage, value: string, maxAge: number): string =>
		`${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`;

	const publicUser = (u: any): UserAccount => ({
		id: String(u.id),
		provider: u.provider as "google" | "secret",
		email: u.email ? String(u.email) : null,
		name: u.provider === "google" ? String(u.display_name || u.email || "Google account") : "Secret key account",
		...(u.created_at ? { createdAt: Number(u.created_at) } : {}),
	});

	/* ---------- sessions ---------- */
	function sessionFrom(req: IncomingMessage): SessionInfo | null {
		const token = cookies(req)[COOKIE];
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
	// sliding expiry: a session close to its end is extended, and the cookie with it
	function touch(req: IncomingMessage, res: ServerResponse, session: SessionInfo) {
		const t = now();
		if (session.expiresAt - t < REFRESH_WITHIN) {
			const expires = t + SESSION_DAYS * DAY;
			db.prepare("UPDATE sessions SET expires_at = ?, last_used = ? WHERE token_hash = ?").run(
				expires,
				t,
				session.tokenHash,
			);
			res.setHeader("Set-Cookie", cookieHeader(req, session.token, SESSION_DAYS * 86400));
		}
	}
	// binds a Google sign-in to the browser that started it. Google posts back cross-site, so the cookie must be
	// SameSite=None, which browsers only accept with Secure: this binding is therefore only on HTTPS (see secure()).
	const OAUTH_COOKIE = "va_oauth",
		OAUTH_PATH = "/api/auth/google";
	const oauthCookie = (_req: IncomingMessage, value: string, maxAge: number): string =>
		`${OAUTH_COOKIE}=${value}; Path=${OAUTH_PATH}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
	function startSession(req: IncomingMessage, res: ServerResponse, userId: string) {
		const token = crypto.randomBytes(32).toString("base64url");
		const t = now();
		db.prepare(
			"INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used) VALUES (?, ?, ?, ?, ?)",
		).run(sha256(token), userId, t, t + SESSION_DAYS * DAY, t);
		res.appendHeader("Set-Cookie", cookieHeader(req, token, SESSION_DAYS * 86400));
	}

	/* ---------- Google: verify the ID token ourselves (signature, issuer, audience, expiry) ---------- */
	let certs: any[] | null = null,
		certsAt = 0;
	async function googleKeys(force = false): Promise<any[]> {
		if (force || !certs || now() - certsAt > 3600_000) {
			const r = await fetch(googleCertsUrl);
			if (!r.ok) throw httpError(502, "could not fetch Google keys");
			certs = ((await r.json()) as any).keys || [];
			certsAt = now();
		}
		return certs!;
	}
	async function verifyGoogleToken(
		token: string,
		nonce: string,
	): Promise<{ sub: string; email: string; name: string }> {
		const parts = String(token || "").split(".");
		if (parts.length !== 3) throw httpError(400, "not a token");
		const [h, p, s] = parts;
		const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
		const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
		if (header.alg !== "RS256") throw httpError(401, "unexpected token algorithm");
		let key = (await googleKeys()).find((k) => k.kid === header.kid);
		if (!key) key = (await googleKeys(true)).find((k) => k.kid === header.kid); // keys rotate
		if (!key) throw httpError(401, "unknown signing key");
		const publicKey = crypto.createPublicKey({ key, format: "jwk" });
		if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")))
			throw httpError(401, "bad signature");
		if (!GOOGLE_ISSUERS.includes(payload.iss)) throw httpError(401, "wrong issuer");
		if (!googleClientId || payload.aud !== googleClientId) throw httpError(401, "wrong audience");
		if (!(payload.exp * 1000 > now())) throw httpError(401, "token expired");
		if (payload.email_verified !== true) throw httpError(401, "e-mail not verified");
		if (!nonce || payload.nonce !== nonce) throw httpError(401, "wrong nonce"); // this sign-in, and no other
		if (typeof payload.sub !== "string" || !payload.sub) throw httpError(401, "no subject");
		return { sub: payload.sub, email: String(payload.email || ""), name: String(payload.name || "") };
	}

	/* ---------- secret keys: 128 random bits, shown once, stored as a hash ---------- */
	function newSecret(): string {
		const bytes = crypto.randomBytes(16);
		let bits = 0,
			value = 0,
			out = "";
		for (const b of bytes) {
			value = (value << 8) | b;
			bits += 8;
			while (bits >= 5) {
				out += B32[(value >>> (bits - 5)) & 31];
				bits -= 5;
			}
		}
		if (bits > 0) out += B32[(value << (5 - bits)) & 31];
		return out.match(/.{1,4}/g)!.join("-");
	}
	// people type these by hand: case, dashes and the look-alikes (O, I, L) do not matter
	const normalizeSecret = (s: unknown): string =>
		String(s || "")
			.toUpperCase()
			.replace(/[^0-9A-Z]/g, "")
			.replace(/O/g, "0")
			.replace(/[IL]/g, "1");

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
	function syncPush(userId: string, items: SyncItem[]): SyncPushResult[] {
		const get = db.prepare("SELECT value, updated_at FROM user_data WHERE user_id = ? AND key = ?");
		const put = db.prepare(`INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
                            ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
		const results: SyncPushResult[] = [];
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const it of items) {
				const cur = get.get(userId, it.key) as { value: string | null; updated_at: number } | undefined;
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
				put.run(userId, it.key, value, t);
				results.push({ key: it.key, status: "ok", updated_at: t });
			}
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
		return results;
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
	const sockets = new Map<string, Set<SocketEntry>>(); // user id -> Set of { ws, client, tokenHash }

	function announce(userId: string, exceptClient: string) {
		for (const c of sockets.get(userId) || [])
			if (!exceptClient || c.client !== exceptClient) c.ws.send('{"type":"changed"}');
	}
	function dropSockets(match: (c: SocketEntry) => boolean) {
		// sign-out: the sockets it belonged to go too
		for (const set of sockets.values()) for (const c of [...set]) if (match(c)) c.ws.close(4401, "signed out");
	}
	const sessionAlive = (tokenHash: string): boolean => {
		const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as
			{ expires_at: number } | undefined;
		return !!row && row.expires_at > now();
	};

	function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
		const refuse = (code: number, text: string) => {
			try {
				socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			} catch {
				/* gone */
			}
		};
		try {
			return upgradeChecked(req, socket, head, url, refuse);
		} catch (e: any) {
			dbg("upgrade: refused after an error: " + e.message);
			refuse(400, "Bad Request");
		}
	}
	function upgradeChecked(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		url: URL,
		refuse: (code: number, text: string) => void,
	) {
		if (url.pathname !== "/api/ws" || String(req.headers.upgrade || "").toLowerCase() !== "websocket")
			return refuse(400, "Bad Request");
		// a page on another site must not be able to open this socket with the visitor's cookie
		const origin = req.headers.origin;
		if (origin) {
			let host: string | null = null;
			try {
				host = new URL(origin).host;
			} catch {
				/* malformed */
			}
			const hosts = [req.headers.host, ...String(req.headers["x-forwarded-host"] || "").split(",")]
				.map((h) => String(h || "").trim())
				.filter(Boolean);
			if (!host || !hosts.includes(host)) return refuse(403, "Forbidden");
		}
		const session = sessionFrom(req);
		if (!session) return refuse(401, "Unauthorized");
		const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(session.tokenHash) as {
			user_id: string;
		};
		const userId = row.user_id;
		const ws = acceptWebSocket(req, socket, head);
		if (!ws) return refuse(400, "Bad Request");
		const client = String(url.searchParams.get("c") || "").slice(0, 64);
		const entry: SocketEntry = { ws, client, tokenHash: session.tokenHash };
		const set = sockets.get(userId) || new Set<SocketEntry>();
		sockets.set(userId, set);
		set.add(entry);
		while (set.size > MAX_SOCKETS_PER_USER) set.values().next().value!.ws.close(1008, "too many connections"); // the oldest goes
		ws.onHeartbeat(() => sessionAlive(session.tokenHash));
		ws.onClose(() => {
			set.delete(entry);
			if (!set.size) sockets.delete(userId);
		});
		ws.send('{"type":"hello"}');
	}

	async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean | void> {
		try {
			const route = `${req.method} ${url.pathname}`;
			const ip = clientIp(req);

			if (route === "GET /api/config") return json(res, 200, { googleClientId });

			if (route === "GET /api/me") {
				const session = sessionFrom(req);
				if (!session) return json(res, 200, { user: null });
				touch(req, res, session);
				const sessionsRow = db
					.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?")
					.get(session.user.id, now()) as { n: number } | undefined;
				const syncedRow = db
					.prepare("SELECT COUNT(*) AS n FROM user_data WHERE user_id = ? AND value IS NOT NULL")
					.get(session.user.id) as { n: number } | undefined;
				return json(res, 200, {
					user: {
						...session.user,
						sessions: Number(sessionsRow?.n || 1),
						syncedItems: Number(syncedRow?.n || 0),
					},
				});
			}

			if (route === "GET /api/auth/google/start") {
				const back = (msg: string) => {
					res.writeHead(303, {
						Location: "/signin/?error=" + encodeURIComponent(msg),
						"Cache-Control": "no-store",
					});
					res.end();
				};
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
				if (secure(req)) res.appendHeader("Set-Cookie", oauthCookie(req, state, 600));
				else dbg("start: not HTTPS, so the sign-in is not bound to this browser (development only)");
				res.writeHead(302, {
					Location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
					"Cache-Control": "no-store",
				});
				return res.end();
			}

			if (route === "POST /api/auth/google/callback") {
				// Google posts the signed ID token back here (response_mode=form_post). Each state is good once, for 10 minutes.
				const back = (msg: string) => {
					res.appendHeader("Set-Cookie", oauthCookie(req, "", 0));
					res.writeHead(303, {
						Location: "/signin/?error=" + encodeURIComponent(msg),
						"Cache-Control": "no-store",
					});
					res.end();
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
						const p = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
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
				db.prepare(
					`INSERT INTO users (id, provider, google_sub, email, display_name, created_at) VALUES (?, 'google', ?, ?, ?, ?)
                    ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`,
				).run(crypto.randomUUID(), g.sub, g.email, g.name, now());
				const user = db
					.prepare("SELECT * FROM users WHERE provider = 'google' AND google_sub = ?")
					.get(g.sub) as { id: string };
				startSession(req, res, user.id);
				res.appendHeader("Set-Cookie", oauthCookie(req, "", 0));
				res.writeHead(303, { Location: row.next, "Cache-Control": "no-store" }); // the session cookie was set above
				return res.end();
			}

			if (route === "POST /api/auth/secret/new") {
				if (!allowLogin(ip)) throw httpError(429, "too many attempts, try again later");
				await readJson(req, 1000);
				const secret = newSecret();
				const id = crypto.randomUUID();
				db.exec("BEGIN");
				try {
					db.prepare("INSERT INTO users (id, provider, created_at) VALUES (?, 'secret', ?)").run(id, now());
					db.prepare("INSERT INTO secret_accounts (user_id, secret_hash) VALUES (?, ?)").run(
						id,
						sha256(normalizeSecret(secret)),
					);
					db.exec("COMMIT");
				} catch (e) {
					db.exec("ROLLBACK");
					throw e;
				}
				startSession(req, res, id);
				return json(res, 200, {
					user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
					secret,
				});
			}

			if (route === "POST /api/auth/secret/login") {
				if (!allowLogin(ip)) throw httpError(429, "too many attempts, try again later");
				const body = await readJson(req, 1000);
				const norm = normalizeSecret(body.secret);
				if (norm.length !== 26) throw httpError(401, "that key does not match an account");
				const row = db
					.prepare(
						`SELECT u.* FROM secret_accounts a JOIN users u ON u.id = a.user_id WHERE a.secret_hash = ?`,
					)
					.get(sha256(norm)) as any;
				if (!row) throw httpError(401, "that key does not match an account");
				startSession(req, res, String(row.id));
				return json(res, 200, { user: publicUser(row) });
			}

			if (route === "POST /api/auth/logout") {
				const session = sessionFrom(req);
				if (session) {
					db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.tokenHash);
					dropSockets((c) => c.tokenHash === session.tokenHash);
				}
				res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
				return json(res, 200, { ok: true });
			}

			if (route === "POST /api/auth/logout-all") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(session.tokenHash) as {
					user_id: string;
				};
				const userId = row.user_id;
				db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
				for (const c of [...(sockets.get(userId) || [])]) c.ws.close(4401, "signed out");
				res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
				return json(res, 200, { ok: true });
			}

			if (route === "POST /api/auth/delete-account" || route === "DELETE /api/me") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				for (const c of [...(sockets.get(userId) || [])]) c.ws.close(4401, "account deleted");
				sockets.delete(userId);
				db.prepare("DELETE FROM users WHERE id = ?").run(userId);
				res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
				return json(res, 200, { ok: true });
			}

			if (route === "GET /api/sync" || route === "POST /api/sync") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				touch(req, res, session);
				const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(session.tokenHash) as {
					user_id: string;
				};
				const userId = row.user_id;
				if (req.method === "GET") return json(res, 200, { items: syncPull(userId) });
				const body = await readJson(req, 8 * 1024 * 1024);
				const items: unknown[] = Array.isArray(body.items) ? body.items : [];
				if (items.length > MAX_ITEMS || !items.every(validItem)) throw httpError(400, "bad sync request");
				const results = syncPush(userId, items);
				if (results.some((r) => r.status === "ok" && !r.same))
					announce(userId, String(body.client || "").slice(0, 64)); // the other devices of this account
				return json(res, 200, { results });
			}

			return false;
		} catch (e: any) {
			if (e.status) return json(res, e.status, { error: e.message });
			console.error("api:", e);
			return json(res, 500, { error: "server error" });
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

	return {
		handle,
		upgrade,
		recordGameRequest,
		gamePopularity,
		close: () => {
			clearInterval(sweepTimer);
			db.close();
		},
		_db: db,
		newSecret,
		normalizeSecret,
	};
}