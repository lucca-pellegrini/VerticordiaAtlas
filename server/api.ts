// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// api.ts: optional accounts and cross-device sync, under /api/. The app works without any of this: an account only
// lets the same progress follow you to another device. Everything is in one SQLite file (data/atlas.db).
//
// Accounts: `users` is the identity hub. Attached authentication mechanisms are interchangeable:
//   - Email / Username + Argon2id password (`email_addresses` + `password_credentials`)
//   - Google OIDC (`auth_identities` with provider = 'google')
//   - 128-bit secret key (`auth_identities` with provider = 'secret_key')
// Sessions last 30 days and slide forward when they are within 7 days of expiring.

import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerWebSocket } from "bun";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator";

import { encodeSecret, formatSecret, normalizeSecret, validateSecretKey } from "../src/shared/secret-key.ts";
import { contentKey, sendKey } from "../src/shared/sync-rules.ts";
import type { SyncItem, SyncPushResult, UserAccount, UserAuthMethods, UserEmailEntry } from "../src/shared/types.ts";
import {
	renderChangeEmailTemplate,
	renderResetPasswordTemplate,
	renderSecurityNotificationTemplate,
	renderVerifyEmailTemplate,
} from "./email-templates.ts";
import { createSesEmailSender, type EmailSender } from "./email.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { foldUnicode, validateDisplayName, validateEmail, validatePassword, validateUsername } from "./usernames.ts";

export { normalizeSecret, validateSecretKey };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESERVED_SQL_PATH = path.join(HERE, "reserved-usernames.sql");

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const SESSION_DAYS = 30;
const REFRESH_WITHIN = 7 * DAY;
const VERIFY_TOKEN_TTL = 6 * HOUR;
const RESET_TOKEN_TTL = 20 * MINUTE;
const COOKIE = "va_session";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
// a key names one item: a profile, or a map's presets or view. Only plain slugs and ids are allowed in it.
const SEG = "[A-Za-z0-9._-]{1,80}";
const KEY_PATTERN = new RegExp(`^(profile:${SEG}:${SEG}|meta:(presets|view):${SEG}(:${SEG})?)$`);
const MAX_VALUE = 2_000_000;
const MAX_ITEMS = 200;

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

export interface Argon2Options {
	memoryCostKiB?: number;
	timeCost?: number;
}

export interface ApiOptions {
	root: string;
	debug?: boolean;
	googleClientId?: string | null;
	publicUrl?: string | null;
	googleCertsUrl?: string;
	allowedEmails?: string[] | null;
	argon2?: Argon2Options;
	emailSender?: EmailSender;
	onEvent?: (action: string, detail: string) => void;
}

interface HttpError extends Error {
	status?: number;
	code?: string;
	extra?: Record<string, unknown>;
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
	argon2,
	emailSender = createSesEmailSender(),
	onEvent,
}: ApiOptions) {
	mkdirSync(path.join(root, "data"), { recursive: true });
	const db = new Database(path.join(root, "data", "atlas.db"), { create: true, strict: true });
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;

		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT,
			username_folded TEXT UNIQUE,
			username_skeleton TEXT UNIQUE,
			display_name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) STRICT;

		CREATE TABLE IF NOT EXISTS auth_identities (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			provider TEXT NOT NULL,
			provider_subject TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			UNIQUE (provider, provider_subject)
		) STRICT;
		CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

		CREATE TABLE IF NOT EXISTS email_addresses (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			email TEXT NOT NULL,
			email_normalized TEXT NOT NULL,
			verified_at INTEGER,
			is_primary INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		) STRICT;
		CREATE INDEX IF NOT EXISTS idx_email_user ON email_addresses(user_id);
		CREATE INDEX IF NOT EXISTS idx_email_norm ON email_addresses(email_normalized);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verified_unique
			ON email_addresses(email_normalized) WHERE verified_at IS NOT NULL;
		CREATE UNIQUE INDEX IF NOT EXISTS idx_email_primary_per_user
			ON email_addresses(user_id) WHERE is_primary = 1;

		CREATE TABLE IF NOT EXISTS password_credentials (
			user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			password_hash TEXT NOT NULL,
			password_changed_at INTEGER NOT NULL
		) STRICT;

		CREATE TABLE IF NOT EXISTS account_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			token_hash TEXT NOT NULL UNIQUE,
			purpose TEXT NOT NULL,
			target_email TEXT,
			expires_at INTEGER NOT NULL,
			consumed_at INTEGER,
			created_at INTEGER NOT NULL
		) STRICT;
		CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id, purpose);

		CREATE TABLE IF NOT EXISTS reserved_usernames (
			username TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (username)
		) STRICT;

		CREATE TABLE IF NOT EXISTS sessions (
			token_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			last_used INTEGER NOT NULL
		) STRICT;
		CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);

		CREATE TABLE IF NOT EXISTS oauth_states (
			state TEXT PRIMARY KEY,
			nonce TEXT NOT NULL,
			next TEXT NOT NULL,
			link_user_id TEXT,
			expires_at INTEGER NOT NULL
		) STRICT;

		CREATE TABLE IF NOT EXISTS user_data (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			key TEXT NOT NULL,
			value TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (user_id, key)
		) STRICT;

		CREATE TABLE IF NOT EXISTS game_popularity (
			game TEXT PRIMARY KEY,
			requests INTEGER NOT NULL,
			last_requested INTEGER NOT NULL
		) STRICT;

		CREATE TABLE IF NOT EXISTS media (
			game TEXT NOT NULL,
			original_name TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size INTEGER NOT NULL,
			uploaded_at INTEGER NOT NULL,
			PRIMARY KEY (game, original_name)
		) STRICT;
	`);

	// Seed reserved_usernames from vendored server/reserved-usernames.sql when empty
	const reservedCount = (db.prepare("SELECT COUNT(*) AS n FROM reserved_usernames").get() as { n: number }).n;
	if (reservedCount === 0 && existsSync(RESERVED_SQL_PATH)) {
		db.exec(readFileSync(RESERVED_SQL_PATH, "utf8"));
	}

	const argonMemoryCost = Math.max(4096, Number(argon2?.memoryCostKiB) || 12288);
	const argonTimeCost = Math.max(1, Number(argon2?.timeCost) || 2);

	async function hashPassword(password: string): Promise<string> {
		return Bun.password.hash(password, {
			algorithm: "argon2id",
			memoryCost: argonMemoryCost,
			timeCost: argonTimeCost,
		});
	}

	// Precompute a dummy Argon2id hash with the configured parameters so failed lookups take the same time as real ones
	let dummyHashPromise: Promise<string> | null = null;
	function getDummyHash(): Promise<string> {
		if (!dummyHashPromise) {
			dummyHashPromise = hashPassword("verticordia-atlas-dummy-timing-shield-password");
		}
		return dummyHashPromise;
	}

	const now = (): number => Date.now();
	const rateLimiter = createRateLimiter(now);

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
	const resolveOrigin = (req: Request): string => {
		if (publicUrl) return publicUrl.replace(/\/+$/, "");
		const proto = secure(req) ? "https:" : new URL(req.url).protocol;
		const host =
			req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || "localhost";
		return `${proto}//${host}`;
	};

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
	function httpError(status: number, message: string, extra?: Record<string, unknown>): HttpError {
		const e: HttpError = new Error(message);
		e.status = status;
		if (extra) e.extra = extra;
		return e;
	}

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

	/* ---------- user & credential queries ---------- */
	const getUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
	const getIdentitiesByUserStmt = db.prepare(
		"SELECT id, provider, provider_subject, created_at FROM auth_identities WHERE user_id = ?",
	);
	const getEmailsByUserStmt = db.prepare(
		"SELECT id, email, email_normalized, verified_at, is_primary, created_at FROM email_addresses WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC",
	);
	const hasPasswordStmt = db.prepare("SELECT 1 FROM password_credentials WHERE user_id = ?");
	const isReservedUsernameStmt = db.prepare("SELECT 1 FROM reserved_usernames WHERE username = ? OR username = ?");

	function isUsernameReserved(folded: string, skeleton: string): boolean {
		return Boolean(isReservedUsernameStmt.get(folded, skeleton));
	}

	function buildPublicUser(userId: string): UserAccount | null {
		const u = getUserByIdStmt.get(userId) as any;
		if (!u) return null;
		const idents = getIdentitiesByUserStmt.all(userId) as {
			id: string;
			provider: string;
			provider_subject: string;
			created_at: number;
		}[];
		const emailRows = getEmailsByUserStmt.all(userId) as {
			id: string;
			email: string;
			email_normalized: string;
			verified_at: number | null;
			is_primary: number;
			created_at: number;
		}[];
		const hasPassword = Boolean(hasPasswordStmt.get(userId));
		const hasGoogle = idents.some((i) => i.provider === "google");
		const hasSecretKey = idents.some((i) => i.provider === "secret_key");

		const emails: UserEmailEntry[] = emailRows.map((e) => ({
			id: String(e.id),
			email: String(e.email),
			verified: e.verified_at !== null && e.verified_at !== undefined,
			isPrimary: e.is_primary === 1,
			createdAt: Number(e.created_at),
		}));
		const primaryEmailObj = emails.find((e) => e.isPrimary) || emails.find((e) => e.verified) || emails[0] || null;
		const primaryEmail = primaryEmailObj ? primaryEmailObj.email : null;

		const methods: UserAuthMethods = {
			google: hasGoogle,
			password: hasPassword,
			secretKey: hasSecretKey,
		};

		let provider: "google" | "secret" | "password" = "secret";
		if (hasGoogle) provider = "google";
		else if (hasPassword) provider = "password";

		const secretIdent = idents.find((i) => i.provider === "secret_key");
		const fallbackName = secretIdent ? secretName(secretIdent.provider_subject) : secretName(String(u.id));
		const displayName = String(u.display_name || u.username || primaryEmail || fallbackName);

		return {
			id: String(u.id),
			provider,
			email: primaryEmail,
			name: displayName,
			username: u.username ? String(u.username) : null,
			displayName,
			emails,
			methods,
			...(u.created_at ? { createdAt: Number(u.created_at) } : {}),
		};
	}

	/**
	 * Checks whether `userId` has no verified login methods at all (only unverified email + password),
	 * allowing stale unverified registrations to be replaced cleanly.
	 */
	function isUnverifiedOrphanUser(userId: string): boolean {
		const identCount = (
			db.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE user_id = ?").get(userId) as { n: number }
		).n;
		if (identCount > 0) return false;
		const verifiedEmailCount = (
			db
				.prepare("SELECT COUNT(*) AS n FROM email_addresses WHERE user_id = ? AND verified_at IS NOT NULL")
				.get(userId) as { n: number }
		).n;
		return verifiedEmailCount === 0;
	}

	function purgeUnverifiedOrphansByEmail(emailNormalized: string, exceptUserId?: string): void {
		const rows = db
			.prepare("SELECT user_id FROM email_addresses WHERE email_normalized = ? AND verified_at IS NULL")
			.all(emailNormalized) as { user_id: string }[];
		for (const r of rows) {
			if (exceptUserId && r.user_id === exceptUserId) continue;
			if (isUnverifiedOrphanUser(r.user_id)) {
				db.prepare("DELETE FROM users WHERE id = ?").run(r.user_id);
			} else {
				db.prepare(
					"DELETE FROM email_addresses WHERE user_id = ? AND email_normalized = ? AND verified_at IS NULL",
				).run(r.user_id, emailNormalized);
			}
		}
	}

	function verifyUserSecretKey(userId: string, rawSecret: unknown): boolean {
		const v = validateSecretKey(rawSecret);
		if (!v.valid) return false;
		const hash = sha256(v.normalized);
		const row = db
			.prepare(
				"SELECT 1 FROM auth_identities WHERE user_id = ? AND provider = 'secret_key' AND provider_subject = ?",
			)
			.get(userId, hash);
		return Boolean(row);
	}

	function sendSecurityEmailBestEffort(userId: string, eventTitle: string, eventDescription: string, req: Request) {
		const u = buildPublicUser(userId);
		if (!u) return;
		const verifiedPrimary = u.emails?.find((e) => e.isPrimary && e.verified) || u.emails?.find((e) => e.verified);
		if (!verifiedPrimary) return;
		const accountUrl = `${resolveOrigin(req)}/account/`;
		const tpl = renderSecurityNotificationTemplate({
			displayName: u.displayName || u.name,
			eventTitle,
			eventDescription,
			accountUrl,
			timestampIso: new Date(now()).toISOString(),
		});
		void emailSender.send({ to: verifiedPrimary.email, ...tpl }).catch((err) => {
			dbg("security email failed:", err?.message || err);
		});
	}

	/* ---------- sessions ---------- */
	function sessionFromToken(token: string): SessionInfo | null {
		if (!token) return null;
		const row = db
			.prepare("SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?")
			.get(sha256(token)) as { token_hash: string; user_id: string; expires_at: number } | undefined;
		if (!row) return null;
		const t = now();
		if (row.expires_at <= t) {
			db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
			return null;
		}
		const user = buildPublicUser(row.user_id);
		if (!user) return null;
		return { token, user, tokenHash: String(row.token_hash), expiresAt: Number(row.expires_at) };
	}
	function sessionFrom(req: Request): SessionInfo | null {
		return sessionFromToken(cookies(req)[COOKIE]);
	}
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

	const OAUTH_COOKIE = "va_oauth";
	const OAUTH_PATH = "/api/auth/google";
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
		cooldownDuration: 30_000,
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
	function validItem(it: any): it is SyncItem {
		if (!it || typeof it.key !== "string" || !KEY_PATTERN.test(it.key)) return false;
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
					results.push({ key: it.key, status: "ok", updated_at: cur.updated_at, same: true });
					continue;
				}
			}
			if (cur && cur.updated_at > base) {
				const curValue = cur.value === null ? null : JSON.parse(cur.value);
				if (contentKey(it.key, curValue) !== contentKey(it.key, it.value)) {
					results.push({ key: it.key, status: "conflict", value: curValue, updated_at: cur.updated_at });
					continue;
				}
			}
			let t = now();
			if (cur && t <= cur.updated_at) t = cur.updated_at + 1;
			const value = it.value === null ? null : JSON.stringify(it.value);
			putSyncData.run(userId, it.key, value, t);
			results.push({ key: it.key, status: "ok", updated_at: t });
		}
		return results;
	});

	function syncPush(userId: string, items: SyncItem[]): SyncPushResult[] {
		const res = pushTransaction.immediate(userId, items);
		onEvent?.("sync:push", `user ${userId.slice(0, 8)}... (${items.length} items)`);
		return res;
	}
	const syncPull = (userId: string): SyncItem[] =>
		(
			db.prepare("SELECT key, value, updated_at FROM user_data WHERE user_id = ?").all(userId) as {
				key: string;
				value: string | null;
				updated_at: number;
			}[]
		).map((r) => ({ key: r.key, value: r.value === null ? null : JSON.parse(r.value), updated_at: r.updated_at }));

	/* ---------- live updates: a WebSocket per signed-in device, told when another device pushed ---------- */
	const MAX_SOCKETS_PER_USER = 8;
	const sockets = new Map<string, Set<ServerWebSocket<WsData>>>();

	function announce(userId: string, exceptClient: string) {
		let count = 0;
		for (const ws of sockets.get(userId) || []) {
			if (!exceptClient || ws.data.client !== exceptClient) {
				ws.send('{"type":"changed"}');
				count++;
			}
		}
		if (count > 0) {
			onEvent?.("ws:broadcast", `user ${userId.slice(0, 8)}... (${count} tabs)`);
		}
	}
	function dropSockets(match: (ws: ServerWebSocket<WsData>) => boolean) {
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
				oldest.close(1008, "too many connections");
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
			{ user_id: string } | undefined;
		if (!row) return new Response("Unauthorized", { status: 401 });
		const userId = row.user_id;
		const client = String(url.searchParams.get("c") || "").slice(0, 64);
		const upgraded = server.upgrade(req, {
			data: { userId, tokenHash: session.tokenHash, client },
		});
		if (!upgraded) return new Response("Bad Request", { status: 400 });
	}

	/* ---------- HTTP route handler ---------- */
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

			/* ---------- Email + Username + Password Registration ---------- */
			if (route === "POST /api/auth/register") {
				if (!rateLimiter.allow("register:ip", ip, 10, 15 * MINUTE)) {
					throw httpError(429, "Too many attempts. Please wait a little and try again.");
				}
				const body = await readJson(req, 4000);
				const vUser = validateUsername(body.username);
				if (!vUser.valid) throw httpError(400, vUser.error, { field: "username" });
				if (isUsernameReserved(vUser.folded, vUser.skeleton)) {
					throw httpError(400, "This username is reserved and cannot be registered.", {
						field: "username",
						code: "USERNAME_RESERVED",
					});
				}
				const vEmail = validateEmail(body.email);
				if (!vEmail.valid) throw httpError(400, vEmail.error, { field: "email" });
				const vPass = validatePassword(body.password);
				if (!vPass.valid) throw httpError(400, vPass.error, { field: "password" });

				let displayName = vUser.username;
				if (body.displayName !== undefined && String(body.displayName).trim() !== "") {
					const vDisp = validateDisplayName(body.displayName);
					if (!vDisp.valid) throw httpError(400, vDisp.error, { field: "displayName" });
					displayName = vDisp.displayName;
				}

				if (!rateLimiter.allow("register:email", vEmail.normalized, 5, 15 * MINUTE)) {
					throw httpError(429, "Too many attempts. Please wait a little and try again.");
				}

				// If an unverified orphan account holds this email, purge it first so re-registration works cleanly
				purgeUnverifiedOrphansByEmail(vEmail.normalized);

				const existingUsername = db
					.prepare("SELECT id FROM users WHERE username_folded = ? OR username_skeleton = ?")
					.get(vUser.folded, vUser.skeleton) as { id: string } | undefined;
				if (existingUsername) {
					throw httpError(409, "This username is already taken or too similar to an existing username.", {
						field: "username",
						code: "USERNAME_TAKEN",
					});
				}

				// Always compute the Argon2id hash so timing never leaks whether the email is already registered
				const passwordHash = await hashPassword(vPass.password);

				const existingVerifiedEmail = db
					.prepare(
						`SELECT u.id, u.display_name, e.email
						 FROM email_addresses e
						 JOIN users u ON u.id = e.user_id
						 WHERE e.email_normalized = ? AND e.verified_at IS NOT NULL`,
					)
					.get(vEmail.normalized) as { id: string; display_name: string; email: string } | undefined;

				const genericMsg =
					"Please check your email for a verification link to activate your account. The link is valid for 6 hours.";

				if (existingVerifiedEmail) {
					// Do not reveal that the email already belongs to an active account; send a notice to the owner
					const origin = resolveOrigin(req);
					const notice = renderSecurityNotificationTemplate({
						displayName: existingVerifiedEmail.display_name,
						eventTitle: "Sign-up attempt with your email address",
						eventDescription:
							"Someone attempted to create a new Verticordia Atlas account using your email address. Because your email is already registered, no new account was created. If this was you, you can sign in or reset your password on the sign-in page.",
						accountUrl: `${origin}/signin/`,
					});
					try {
						await emailSender.send({ to: existingVerifiedEmail.email, ...notice });
					} catch (err: any) {
						dbg("register existing-email notice failed:", err?.message || err);
						throw httpError(
							503,
							"We could not send the verification email right now. Please try again shortly.",
						);
					}
					return json(200, { ok: true, pendingVerification: true, message: genericMsg });
				}

				const userId = crypto.randomUUID();
				const emailId = crypto.randomUUID();
				const tokenId = crypto.randomUUID();
				const rawToken = crypto.randomBytes(32).toString("base64url");
				const tokenHash = sha256(rawToken);
				const t = now();

				const registerTx = db.transaction(() => {
					purgeUnverifiedOrphansByEmail(vEmail.normalized);
					db.prepare(
						`INSERT INTO users (id, username, username_folded, username_skeleton, display_name, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					).run(userId, vUser.username, vUser.folded, vUser.skeleton, displayName, t, t);
					db.prepare(
						`INSERT INTO email_addresses (id, user_id, email, email_normalized, verified_at, is_primary, created_at)
						 VALUES (?, ?, ?, ?, NULL, 1, ?)`,
					).run(emailId, userId, vEmail.email, vEmail.normalized, t);
					db.prepare(
						`INSERT INTO password_credentials (user_id, password_hash, password_changed_at)
						 VALUES (?, ?, ?)`,
					).run(userId, passwordHash, t);
					db.prepare(
						`INSERT INTO account_tokens (id, user_id, token_hash, purpose, target_email, expires_at, consumed_at, created_at)
						 VALUES (?, ?, ?, 'email_verification', ?, ?, NULL, ?)`,
					).run(tokenId, userId, tokenHash, vEmail.normalized, t + VERIFY_TOKEN_TTL, t);
				});
				registerTx();

				const verifyUrl = `${resolveOrigin(req)}/signin/?verify=${encodeURIComponent(rawToken)}`;
				const tpl = renderVerifyEmailTemplate({
					displayName,
					username: vUser.username,
					verifyUrl,
					expiresHours: 6,
				});

				try {
					await emailSender.send({ to: vEmail.email, ...tpl });
				} catch (err: any) {
					console.error("[auth] Register email delivery failed:", err?.message || err);
					onEvent?.("auth:error", `Register email delivery failed: ${err?.message || err}`);
					db.prepare("DELETE FROM users WHERE id = ?").run(userId);
					throw httpError(
						503,
						"We could not send the verification email right now. Please try again in a moment.",
					);
				}

				return json(200, { ok: true, pendingVerification: true, message: genericMsg });
			}

			/* ---------- Verify Email Token ---------- */
			if (route === "POST /api/auth/verify-email") {
				if (!rateLimiter.allow("verify:ip", ip, 20, 15 * MINUTE)) {
					throw httpError(429, "Too many attempts. Please wait a little and try again.");
				}
				const body = await readJson(req, 2000);
				const rawToken = String(body.token || "").trim();
				if (!rawToken) throw httpError(400, "Verification token is required.");
				const tokenHash = sha256(rawToken);
				const t = now();

				const tok = db
					.prepare(
						`SELECT id, user_id, purpose, target_email, expires_at, consumed_at
						 FROM account_tokens
						 WHERE token_hash = ? AND purpose IN ('email_verification', 'email_change')`,
					)
					.get(tokenHash) as
					| {
							id: string;
							user_id: string;
							purpose: string;
							target_email: string | null;
							expires_at: number;
							consumed_at: number | null;
					  }
					| undefined;

				if (!tok || tok.consumed_at !== null || tok.expires_at <= t || !tok.target_email) {
					throw httpError(400, "This verification link is invalid or has expired.");
				}

				const verifyTx = db.transaction(() => {
					const fresh = db
						.prepare("SELECT consumed_at, expires_at FROM account_tokens WHERE id = ?")
						.get(tok.id) as { consumed_at: number | null; expires_at: number } | undefined;
					if (!fresh || fresh.consumed_at !== null || fresh.expires_at <= t) {
						throw httpError(400, "This verification link is invalid or has expired.");
					}
					const otherOwner = db
						.prepare(
							"SELECT user_id FROM email_addresses WHERE email_normalized = ? AND verified_at IS NOT NULL AND user_id != ?",
						)
						.get(tok.target_email!, tok.user_id) as { user_id: string } | undefined;
					if (otherOwner) {
						throw httpError(409, "This email address is already verified on another account.");
					}

					// Purge any other unverified-only accounts holding this email
					purgeUnverifiedOrphansByEmail(tok.target_email!, tok.user_id);

					const emailRow = db
						.prepare(
							"SELECT id, is_primary FROM email_addresses WHERE user_id = ? AND email_normalized = ?",
						)
						.get(tok.user_id, tok.target_email!) as { id: string; is_primary: number } | undefined;
					if (!emailRow) {
						throw httpError(400, "The email address for this verification link was not found.");
					}

					db.prepare("UPDATE account_tokens SET consumed_at = ? WHERE id = ?").run(t, tok.id);
					db.prepare(
						`UPDATE account_tokens SET consumed_at = ?
						 WHERE user_id = ? AND target_email = ? AND purpose IN ('email_verification', 'email_change') AND consumed_at IS NULL`,
					).run(t, tok.user_id, tok.target_email!);

					const hasPrimary = db
						.prepare("SELECT 1 FROM email_addresses WHERE user_id = ? AND is_primary = 1 AND id != ?")
						.get(tok.user_id, emailRow.id);
					const makePrimary = !hasPrimary || emailRow.is_primary === 1;
					if (makePrimary) {
						db.prepare("UPDATE email_addresses SET is_primary = 0 WHERE user_id = ?").run(tok.user_id);
					}
					db.prepare("UPDATE email_addresses SET verified_at = ?, is_primary = ? WHERE id = ?").run(
						t,
						makePrimary ? 1 : 0,
						emailRow.id,
					);
					db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, tok.user_id);
				});
				verifyTx();

				return json(200, {
					ok: true,
					purpose: tok.purpose,
					message: "Your email address has been verified.",
				});
			}

			/* ---------- Resend Verification Email ---------- */
			if (route === "POST /api/auth/verify-email/resend") {
				if (!rateLimiter.allow("resend:ip", ip, 6, 15 * MINUTE)) {
					throw httpError(429, "Too many attempts. Please wait a little and try again.");
				}
				const body = await readJson(req, 2000);
				const session = sessionFrom(req);
				let targetRow:
					| {
							user_id: string;
							display_name: string;
							username: string | null;
							email: string;
							email_normalized: string;
					  }
					| undefined;

				if (session && body.emailId) {
					targetRow = db
						.prepare(
							`SELECT u.id AS user_id, u.display_name, u.username, e.email, e.email_normalized
							 FROM email_addresses e
							 JOIN users u ON u.id = e.user_id
							 WHERE e.id = ? AND e.user_id = ? AND e.verified_at IS NULL`,
						)
						.get(String(body.emailId), session.user.id) as any;
				} else {
					const vEmail = validateEmail(body.email);
					if (!vEmail.valid) throw httpError(400, vEmail.error);
					if (!rateLimiter.allow("resend:email", vEmail.normalized, 3, 15 * MINUTE)) {
						throw httpError(429, "Too many attempts. Please wait a little and try again.");
					}
					targetRow = db
						.prepare(
							`SELECT u.id AS user_id, u.display_name, u.username, e.email, e.email_normalized
							 FROM email_addresses e
							 JOIN users u ON u.id = e.user_id
							 WHERE e.email_normalized = ? AND e.verified_at IS NULL`,
						)
						.get(vEmail.normalized) as any;
				}

				const genericMsg =
					"If that email address is awaiting verification, a new confirmation link has been sent.";
				if (!targetRow) {
					return json(200, { ok: true, message: genericMsg });
				}

				if (!rateLimiter.allow("resend:target", targetRow.email_normalized, 3, 15 * MINUTE)) {
					throw httpError(429, "Please wait a few minutes before requesting another verification email.");
				}

				const rawToken = crypto.randomBytes(32).toString("base64url");
				const tokenHash = sha256(rawToken);
				const tokenId = crypto.randomUUID();
				const t = now();
				const purpose = session ? "email_change" : "email_verification";

				db.prepare(
					`INSERT INTO account_tokens (id, user_id, token_hash, purpose, target_email, expires_at, consumed_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
				).run(
					tokenId,
					targetRow.user_id,
					tokenHash,
					purpose,
					targetRow.email_normalized,
					t + VERIFY_TOKEN_TTL,
					t,
				);

				const verifyUrl = `${resolveOrigin(req)}/signin/?verify=${encodeURIComponent(rawToken)}`;
				const tpl =
					purpose === "email_change"
						? renderChangeEmailTemplate({
								displayName: targetRow.display_name,
								newEmail: targetRow.email,
								verifyUrl,
								expiresHours: 6,
							})
						: renderVerifyEmailTemplate({
								displayName: targetRow.display_name,
								username: targetRow.username,
								verifyUrl,
								expiresHours: 6,
							});

				try {
					await emailSender.send({ to: targetRow.email, ...tpl });
				} catch (err: any) {
					dbg("resend verification failed:", err?.message || err);
					db.prepare("DELETE FROM account_tokens WHERE id = ?").run(tokenId);
					throw httpError(
						503,
						"We could not send the verification email right now. Please try again shortly.",
					);
				}

				return json(200, { ok: true, message: genericMsg });
			}

			/* ---------- Password Login (Email or Username) ---------- */
			if (route === "POST /api/auth/login") {
				if (!rateLimiter.allow("login:ip", ip, 20, 15 * MINUTE)) {
					throw httpError(429, "Too many sign-in attempts. Please wait a little and try again.");
				}
				const body = await readJson(req, 2000);
				const rawIdentifier = String(body.identifier ?? body.email ?? body.username ?? "").trim();
				const rawPassword = typeof body.password === "string" ? body.password : "";
				if (!rawIdentifier || !rawPassword) {
					throw httpError(400, "Please enter your email or username and password.");
				}
				const foldedId = foldUnicode(rawIdentifier);
				if (!rateLimiter.checkOnly("login:acct", foldedId, 8, 15 * MINUTE)) {
					throw httpError(429, "Too many failed sign-in attempts for this account. Please try again later.");
				}

				let candidate: { user_id: string; password_hash: string; email_verified: number } | undefined;

				if (rawIdentifier.includes("@")) {
					candidate = db
						.prepare(
							`SELECT u.id AS user_id, p.password_hash,
							        CASE WHEN e.verified_at IS NOT NULL THEN 1 ELSE 0 END AS email_verified
							 FROM email_addresses e
							 JOIN users u ON u.id = e.user_id
							 JOIN password_credentials p ON p.user_id = u.id
							 WHERE e.email_normalized = ?
							 ORDER BY e.verified_at DESC NULLS LAST
							 LIMIT 1`,
						)
						.get(foldedId) as any;
				} else {
					candidate = db
						.prepare(
							`SELECT u.id AS user_id, p.password_hash,
							        CASE WHEN EXISTS (
							            SELECT 1 FROM email_addresses e WHERE e.user_id = u.id AND e.verified_at IS NOT NULL
							        ) THEN 1 ELSE 0 END AS email_verified
							 FROM users u
							 JOIN password_credentials p ON p.user_id = u.id
							 WHERE u.username_folded = ?`,
						)
						.get(foldedId) as any;
				}

				const genericAuthErr =
					"Invalid email/username or password, or your email address has not been verified yet.";

				if (!candidate || candidate.email_verified !== 1) {
					const dummy = await getDummyHash();
					await Bun.password.verify(rawPassword, dummy);
					rateLimiter.record("login:acct", foldedId, 15 * MINUTE);
					throw httpError(401, genericAuthErr);
				}

				const validPass = await Bun.password.verify(rawPassword, candidate.password_hash);
				if (!validPass) {
					rateLimiter.record("login:acct", foldedId, 15 * MINUTE);
					throw httpError(401, genericAuthErr);
				}

				rateLimiter.reset("login:acct", foldedId);
				const sessionCookie = startSession(req, candidate.user_id);
				const headers = new Headers();
				headers.append("Set-Cookie", sessionCookie);
				return json(200, { ok: true, user: buildPublicUser(candidate.user_id) }, headers);
			}

			/* ---------- Password Reset Request ---------- */
			if (route === "POST /api/auth/password/forgot") {
				if (!rateLimiter.allow("forgot:ip", ip, 5, 15 * MINUTE)) {
					throw httpError(429, "Too many requests. Please wait a little and try again.");
				}
				const body = await readJson(req, 2000);
				const vEmail = validateEmail(body.email);
				if (!vEmail.valid) throw httpError(400, vEmail.error);
				if (!rateLimiter.allow("forgot:email", vEmail.normalized, 3, 15 * MINUTE)) {
					throw httpError(429, "Too many requests. Please wait a little and try again.");
				}

				const genericMsg =
					"If an account is associated with that email address, we have sent instructions to reset your password.";

				const match = db
					.prepare(
						`SELECT u.id AS user_id, u.display_name, e.email, e.email_normalized
						 FROM email_addresses e
						 JOIN users u ON u.id = e.user_id
						 WHERE e.email_normalized = ? AND e.verified_at IS NOT NULL`,
					)
					.get(vEmail.normalized) as
					{ user_id: string; display_name: string; email: string; email_normalized: string } | undefined;

				if (!match) {
					return json(200, { ok: true, message: genericMsg });
				}

				const rawToken = crypto.randomBytes(32).toString("base64url");
				const tokenHash = sha256(rawToken);
				const tokenId = crypto.randomUUID();
				const t = now();

				db.prepare(
					`INSERT INTO account_tokens (id, user_id, token_hash, purpose, target_email, expires_at, consumed_at, created_at)
					 VALUES (?, ?, ?, 'password_reset', ?, ?, NULL, ?)`,
				).run(tokenId, match.user_id, tokenHash, match.email_normalized, t + RESET_TOKEN_TTL, t);

				const resetUrl = `${resolveOrigin(req)}/signin/?reset=${encodeURIComponent(rawToken)}`;
				const tpl = renderResetPasswordTemplate({
					displayName: match.display_name,
					resetUrl,
					expiresMinutes: 20,
				});

				try {
					await emailSender.send({ to: match.email, ...tpl });
				} catch (err: any) {
					dbg("password reset email failed:", err?.message || err);
					db.prepare("DELETE FROM account_tokens WHERE id = ?").run(tokenId);
					throw httpError(
						503,
						"We could not send the password reset email right now. Please try again in a moment.",
					);
				}

				return json(200, { ok: true, message: genericMsg });
			}

			/* ---------- Complete Password Reset ---------- */
			if (route === "POST /api/auth/password/reset") {
				if (!rateLimiter.allow("reset:ip", ip, 10, 15 * MINUTE)) {
					throw httpError(429, "Too many attempts. Please wait a little and try again.");
				}
				const body = await readJson(req, 2000);
				const rawToken = String(body.token || "").trim();
				if (!rawToken) throw httpError(400, "Reset token is required.");
				const vPass = validatePassword(body.password);
				if (!vPass.valid) throw httpError(400, vPass.error);

				const tokenHash = sha256(rawToken);
				const t = now();
				const tok = db
					.prepare(
						`SELECT id, user_id, expires_at, consumed_at
						 FROM account_tokens
						 WHERE token_hash = ? AND purpose = 'password_reset'`,
					)
					.get(tokenHash) as
					{ id: string; user_id: string; expires_at: number; consumed_at: number | null } | undefined;

				if (!tok || tok.consumed_at !== null || tok.expires_at <= t) {
					throw httpError(400, "This password reset link is invalid or has expired.");
				}

				const newPasswordHash = await hashPassword(vPass.password);

				const resetTx = db.transaction(() => {
					const fresh = db
						.prepare("SELECT consumed_at, expires_at FROM account_tokens WHERE id = ?")
						.get(tok.id) as { consumed_at: number | null; expires_at: number } | undefined;
					if (!fresh || fresh.consumed_at !== null || fresh.expires_at <= t) {
						throw httpError(400, "This password reset link is invalid or has expired.");
					}
					db.prepare("UPDATE account_tokens SET consumed_at = ? WHERE id = ?").run(t, tok.id);
					db.prepare(
						"UPDATE account_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = 'password_reset' AND consumed_at IS NULL",
					).run(t, tok.user_id);
					db.prepare(
						`INSERT INTO password_credentials (user_id, password_hash, password_changed_at)
						 VALUES (?, ?, ?)
						 ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, password_changed_at = excluded.password_changed_at`,
					).run(tok.user_id, newPasswordHash, t);
					db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, tok.user_id);
					db.prepare("DELETE FROM sessions WHERE user_id = ?").run(tok.user_id);
				});
				resetTx();

				for (const ws of [...(sockets.get(tok.user_id) || [])]) ws.close(4401, "password reset");
				sockets.delete(tok.user_id);

				sendSecurityEmailBestEffort(
					tok.user_id,
					"Your password was reset",
					"The password for your Verticordia Atlas account was reset using a password reset link, and all active sessions were signed out.",
					req,
				);

				return json(200, {
					ok: true,
					message: "Your password has been reset. You can now sign in with your new password.",
				});
			}

			/* ---------- Google OIDC ---------- */
			if (route === "GET /api/auth/google/start") {
				const isLinking = url.searchParams.get("link") === "1";
				const session = isLinking ? sessionFrom(req) : null;
				const fallbackBackPath = isLinking ? "/account/" : "/signin/";
				const back = (msg: string) =>
					new Response(null, {
						status: 303,
						headers: {
							Location: `${fallbackBackPath}?error=` + encodeURIComponent(msg),
							"Cache-Control": "no-store",
						},
					});
				if (isLinking && !session) {
					return back("Please sign in first to link a Google account.");
				}
				if (!googleClientId || !publicUrl)
					return back("We can't seem to reach Google for sign-in. Try again later.");
				if (!rateLimiter.allow("login:ip", ip, 20, 15 * MINUTE))
					return back("Too many attempts. Please wait a little and try again.");
				const n = url.searchParams.get("next") || "";
				const next = /^\/(?!\/)/.test(n) ? n : isLinking ? "/account/" : "/";
				const state = crypto.randomBytes(24).toString("base64url");
				const nonce = crypto.randomBytes(24).toString("base64url");
				dbg("start: next=" + next + " redirect_uri=" + publicUrl + "/api/auth/google/callback");
				db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(now());
				db.prepare(
					"INSERT INTO oauth_states (state, nonce, next, link_user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
				).run(state, nonce, next, session ? session.user.id : null, now() + 10 * MINUTE);
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
				if (!rateLimiter.allow("login:ip", ip, 20, 15 * MINUTE))
					throw httpError(429, "too many attempts, try again later");
				const form = await readForm(req, 16_000);
				const state = String(form.state || "");
				const token = String(form.id_token || form.credential || "");
				const row = db
					.prepare("SELECT nonce, next, link_user_id, expires_at FROM oauth_states WHERE state = ?")
					.get(state) as
					{ nonce: string; next: string; link_user_id: string | null; expires_at: number } | undefined;
				db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);

				const errorRedirectBase = row?.link_user_id ? "/account/" : "/signin/";
				const back = (msg: string) => {
					const headers = new Headers({
						Location: `${errorRedirectBase}?error=` + encodeURIComponent(msg),
						"Cache-Control": "no-store",
					});
					headers.append("Set-Cookie", oauthCookie(req, "", 0));
					return new Response(null, { status: 303, headers });
				};

				if (!row || row.expires_at <= now()) {
					return back("That sign-in took too long. Please try again.");
				}
				if (secure(req) && cookies(req)[OAUTH_COOKIE] !== state) {
					return back("This sign-in was started in another browser. Please try again here.");
				}
				if (!token) {
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
					return back("Your email address is not authorized.");
				}

				const gEmailNorm = foldUnicode(g.email);
				const t = now();
				const existingIdentity = db
					.prepare("SELECT user_id FROM auth_identities WHERE provider = 'google' AND provider_subject = ?")
					.get(g.sub) as { user_id: string } | undefined;

				// Mode 1: Linking Google to an existing signed-in account
				if (row.link_user_id) {
					const activeSession = sessionFrom(req);
					if (!activeSession || activeSession.user.id !== row.link_user_id) {
						return back("Your session expired before linking completed. Please sign in and try again.");
					}
					if (existingIdentity && existingIdentity.user_id !== row.link_user_id) {
						return back("That Google account is already linked to another Verticordia Atlas account.");
					}
					const otherEmailOwner = db
						.prepare(
							"SELECT user_id FROM email_addresses WHERE email_normalized = ? AND verified_at IS NOT NULL AND user_id != ?",
						)
						.get(gEmailNorm, row.link_user_id) as { user_id: string } | undefined;
					if (otherEmailOwner) {
						return back("The email address on that Google account is already verified on another account.");
					}

					const linkTx = db.transaction(() => {
						purgeUnverifiedOrphansByEmail(gEmailNorm, row.link_user_id!);
						db.prepare(
							`INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at)
							 VALUES (?, ?, 'google', ?, ?)
							 ON CONFLICT (provider, provider_subject) DO NOTHING`,
						).run(crypto.randomUUID(), row.link_user_id!, g.sub, t);

						const existingEmail = db
							.prepare(
								"SELECT id, verified_at FROM email_addresses WHERE user_id = ? AND email_normalized = ?",
							)
							.get(row.link_user_id!, gEmailNorm) as
							{ id: string; verified_at: number | null } | undefined;
						const hasPrimary = db
							.prepare("SELECT 1 FROM email_addresses WHERE user_id = ? AND is_primary = 1")
							.get(row.link_user_id!);
						if (existingEmail) {
							if (!existingEmail.verified_at) {
								db.prepare("UPDATE email_addresses SET verified_at = ? WHERE id = ?").run(
									t,
									existingEmail.id,
								);
							}
						} else {
							db.prepare(
								`INSERT INTO email_addresses (id, user_id, email, email_normalized, verified_at, is_primary, created_at)
								 VALUES (?, ?, ?, ?, ?, ?, ?)`,
							).run(
								crypto.randomUUID(),
								row.link_user_id!,
								g.email,
								gEmailNorm,
								t,
								hasPrimary ? 0 : 1,
								t,
							);
						}
						db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, row.link_user_id!);
					});
					linkTx();

					sendSecurityEmailBestEffort(
						row.link_user_id,
						"Google account linked",
						`Google sign-in (${g.email}) was linked to your Verticordia Atlas account.`,
						req,
					);

					const headers = new Headers({
						Location: row.next,
						"Cache-Control": "no-store",
					});
					headers.append("Set-Cookie", oauthCookie(req, "", 0));
					return new Response(null, { status: 303, headers });
				}

				// Mode 2: Standard Sign-in / Sign-up with Google
				let userId: string;
				if (existingIdentity) {
					userId = existingIdentity.user_id;
					db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, userId);
				} else {
					const verifiedEmailOwner = db
						.prepare(
							"SELECT user_id FROM email_addresses WHERE email_normalized = ? AND verified_at IS NOT NULL",
						)
						.get(gEmailNorm) as { user_id: string } | undefined;

					if (verifiedEmailOwner) {
						userId = verifiedEmailOwner.user_id;
						db.prepare(
							`INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at)
							 VALUES (?, ?, 'google', ?, ?)
							 ON CONFLICT (provider, provider_subject) DO NOTHING`,
						).run(crypto.randomUUID(), userId, g.sub, t);
						db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, userId);
					} else {
						userId = crypto.randomUUID();
						const displayName = g.name || g.email.split("@")[0] || "Google Explorer";
						const createGoogleUser = db.transaction(() => {
							purgeUnverifiedOrphansByEmail(gEmailNorm);
							db.prepare(
								`INSERT INTO users (id, username, username_folded, username_skeleton, display_name, created_at, updated_at)
								 VALUES (?, NULL, NULL, NULL, ?, ?, ?)`,
							).run(userId, displayName, t, t);
							db.prepare(
								`INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at)
								 VALUES (?, ?, 'google', ?, ?)`,
							).run(crypto.randomUUID(), userId, g.sub, t);
							db.prepare(
								`INSERT INTO email_addresses (id, user_id, email, email_normalized, verified_at, is_primary, created_at)
								 VALUES (?, ?, ?, ?, ?, 1, ?)`,
							).run(crypto.randomUUID(), userId, g.email, gEmailNorm, t, t);
						});
						createGoogleUser();
					}
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

			/* ---------- Secret Key Auth ---------- */
			if (route === "POST /api/auth/secret/new") {
				if (!rateLimiter.allow("login:ip", ip, 20, 15 * MINUTE))
					throw httpError(429, "too many attempts, try again later");
				await readJson(req, 1000);
				const secret = newSecret();
				return json(200, { secret });
			}

			if (route === "POST /api/auth/secret/confirm") {
				if (!rateLimiter.allow("login:ip", ip, 20, 15 * MINUTE))
					throw httpError(429, "too many attempts, try again later");
				const body = await readJson(req, 1000);
				const v = validateSecretKey(body.secret);
				if (!v.valid) throw httpError(400, v.error);
				const norm = v.normalized;
				const secretHash = sha256(norm);
				const existing = db
					.prepare("SELECT 1 FROM auth_identities WHERE provider = 'secret_key' AND provider_subject = ?")
					.get(secretHash);
				if (existing) throw httpError(409, "this secret key is already registered");
				const id = crypto.randomUUID();
				const displayName = secretName(secretHash);
				const t = now();
				const createSecretAccount = db.transaction((userId: string, name: string, hash: string) => {
					db.prepare(
						`INSERT INTO users (id, username, username_folded, username_skeleton, display_name, created_at, updated_at)
						 VALUES (?, NULL, NULL, NULL, ?, ?, ?)`,
					).run(userId, name, t, t);
					db.prepare(
						`INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at)
						 VALUES (?, ?, 'secret_key', ?, ?)`,
					).run(crypto.randomUUID(), userId, hash, t);
				});
				createSecretAccount(id, displayName, secretHash);
				const sessionCookie = startSession(req, id);
				const headers = new Headers();
				headers.append("Set-Cookie", sessionCookie);
				return json(200, { ok: true, user: buildPublicUser(id) }, headers);
			}

			if (route === "POST /api/auth/secret/login") {
				if (!rateLimiter.allow("login:ip", ip, 20, 15 * MINUTE))
					throw httpError(429, "too many attempts, try again later");
				const body = await readJson(req, 1000);
				const v = validateSecretKey(body.secret);
				if (!v.valid) throw httpError(400, v.error);
				const norm = v.normalized;
				const secretHash = sha256(norm);
				if (!rateLimiter.checkOnly("login:secret", secretHash, 10, 15 * MINUTE)) {
					throw httpError(429, "too many attempts, try again later");
				}
				const row = db
					.prepare(
						"SELECT user_id FROM auth_identities WHERE provider = 'secret_key' AND provider_subject = ?",
					)
					.get(secretHash) as { user_id: string } | undefined;
				if (!row) {
					rateLimiter.record("login:secret", secretHash, 15 * MINUTE);
					throw httpError(401, "that key does not match an account");
				}
				rateLimiter.reset("login:secret", secretHash);
				const sessionCookie = startSession(req, String(row.user_id));
				const headers = new Headers();
				headers.append("Set-Cookie", sessionCookie);
				return json(200, { user: buildPublicUser(row.user_id) }, headers);
			}

			/* ---------- Account Management Routes (require active session) ---------- */
			if (route === "POST /api/account/profile") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				const body = await readJson(req, 2000);
				const t = now();

				const updateProfileTx = db.transaction(() => {
					if (body.displayName !== undefined) {
						const vDisp = validateDisplayName(body.displayName);
						if (!vDisp.valid) throw httpError(400, vDisp.error, { field: "displayName" });
						db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(
							vDisp.displayName,
							t,
							userId,
						);
					}
					if (body.username !== undefined && body.username !== null && String(body.username).trim() !== "") {
						const vUser = validateUsername(body.username);
						if (!vUser.valid) throw httpError(400, vUser.error, { field: "username" });
						if (isUsernameReserved(vUser.folded, vUser.skeleton)) {
							throw httpError(400, "This username is reserved and cannot be used.", {
								field: "username",
								code: "USERNAME_RESERVED",
							});
						}
						const clash = db
							.prepare(
								"SELECT id FROM users WHERE (username_folded = ? OR username_skeleton = ?) AND id != ?",
							)
							.get(vUser.folded, vUser.skeleton, userId) as { id: string } | undefined;
						if (clash) {
							throw httpError(
								409,
								"This username is already taken or too similar to an existing username.",
								{
									field: "username",
									code: "USERNAME_TAKEN",
								},
							);
						}
						db.prepare(
							"UPDATE users SET username = ?, username_folded = ?, username_skeleton = ?, updated_at = ? WHERE id = ?",
						).run(vUser.username, vUser.folded, vUser.skeleton, t, userId);
					}
				});
				updateProfileTx();
				return json(200, { ok: true, user: buildPublicUser(userId) });
			}

			if (route === "POST /api/account/password") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				if (!rateLimiter.allow("acct:pw", userId, 10, 15 * MINUTE)) {
					throw httpError(429, "Too many attempts. Please wait a little and try again.");
				}
				const body = await readJson(req, 2000);
				const vNew = validatePassword(body.newPassword);
				if (!vNew.valid) throw httpError(400, vNew.error, { field: "newPassword" });

				const existingCred = db
					.prepare("SELECT password_hash FROM password_credentials WHERE user_id = ?")
					.get(userId) as { password_hash: string } | undefined;

				if (existingCred) {
					const curPass = typeof body.currentPassword === "string" ? body.currentPassword : "";
					if (!curPass) throw httpError(400, "Please enter your current password.");
					const ok = await Bun.password.verify(curPass, existingCred.password_hash);
					if (!ok) throw httpError(401, "Your current password is incorrect.");
				} else {
					const hasVerifiedEmail = db
						.prepare("SELECT 1 FROM email_addresses WHERE user_id = ? AND verified_at IS NOT NULL")
						.get(userId);
					if (!hasVerifiedEmail) {
						throw httpError(
							400,
							"Please add and verify an email address on your account before setting a password.",
						);
					}
				}

				const currentUserRow = db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as {
					username: string | null;
				};
				let validatedNewUsername: { username: string; folded: string; skeleton: string } | null = null;
				if (!currentUserRow.username) {
					if (body.username !== undefined && String(body.username).trim() !== "") {
						const vUser = validateUsername(body.username);
						if (!vUser.valid) throw httpError(400, vUser.error, { field: "username" });
						if (isUsernameReserved(vUser.folded, vUser.skeleton)) {
							throw httpError(400, "This username is reserved and cannot be used.", {
								field: "username",
								code: "USERNAME_RESERVED",
							});
						}
						const clash = db
							.prepare(
								"SELECT id FROM users WHERE (username_folded = ? OR username_skeleton = ?) AND id != ?",
							)
							.get(vUser.folded, vUser.skeleton, userId);
						if (clash) {
							throw httpError(
								409,
								"This username is already taken or too similar to an existing username.",
								{
									field: "username",
									code: "USERNAME_TAKEN",
								},
							);
						}
						validatedNewUsername = vUser;
					} else {
						throw httpError(400, "Please choose a unique username when setting a password.", {
							field: "username",
						});
					}
				}

				const newHash = await hashPassword(vNew.password);
				const t = now();
				const updatePwTx = db.transaction(() => {
					if (validatedNewUsername) {
						db.prepare(
							"UPDATE users SET username = ?, username_folded = ?, username_skeleton = ?, updated_at = ? WHERE id = ?",
						).run(
							validatedNewUsername.username,
							validatedNewUsername.folded,
							validatedNewUsername.skeleton,
							t,
							userId,
						);
					} else {
						db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, userId);
					}
					db.prepare(
						`INSERT INTO password_credentials (user_id, password_hash, password_changed_at)
						 VALUES (?, ?, ?)
						 ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, password_changed_at = excluded.password_changed_at`,
					).run(userId, newHash, t);
					// Revoke all other sessions
					db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(
						userId,
						session.tokenHash,
					);
				});
				updatePwTx();

				dropSockets((ws) => ws.data.userId === userId && ws.data.tokenHash !== session.tokenHash);

				sendSecurityEmailBestEffort(
					userId,
					existingCred ? "Your password was changed" : "Password sign-in enabled",
					existingCred
						? "The password for your Verticordia Atlas account was changed, and any other signed-in devices were signed out."
						: "A password was added to your Verticordia Atlas account.",
					req,
				);

				return json(200, { ok: true, user: buildPublicUser(userId) });
			}

			if (route === "POST /api/account/secret/add") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				const body = await readJson(req, 1000);
				const v = validateSecretKey(body.secret);
				if (!v.valid) throw httpError(400, v.error);
				const secretHash = sha256(v.normalized);
				const existingUserSecret = db
					.prepare("SELECT 1 FROM auth_identities WHERE user_id = ? AND provider = 'secret_key'")
					.get(userId);
				if (existingUserSecret) {
					throw httpError(409, "A secret key is already attached to this account.");
				}
				const globalClash = db
					.prepare("SELECT 1 FROM auth_identities WHERE provider = 'secret_key' AND provider_subject = ?")
					.get(secretHash);
				if (globalClash) {
					throw httpError(409, "This secret key is already registered.");
				}
				const t = now();
				db.prepare(
					"INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, 'secret_key', ?, ?)",
				).run(crypto.randomUUID(), userId, secretHash, t);
				db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, userId);

				sendSecurityEmailBestEffort(
					userId,
					"Secret key added to your account",
					"A recovery/sign-in secret key was attached to your Verticordia Atlas account.",
					req,
				);

				return json(200, { ok: true, user: buildPublicUser(userId) });
			}

			if (route === "POST /api/account/email/add") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				if (
					!rateLimiter.allow("acct:email:ip", ip, 5, 15 * MINUTE) ||
					!rateLimiter.allow("acct:email:user", userId, 5, 15 * MINUTE)
				) {
					throw httpError(429, "Too many attempts. Please wait a little and try again.");
				}
				const body = await readJson(req, 2000);
				const vEmail = validateEmail(body.email);
				if (!vEmail.valid) throw httpError(400, vEmail.error);

				const alreadyOnUser = db
					.prepare("SELECT id, verified_at FROM email_addresses WHERE user_id = ? AND email_normalized = ?")
					.get(userId, vEmail.normalized) as { id: string; verified_at: number | null } | undefined;
				if (alreadyOnUser) {
					throw httpError(409, "That email address is already listed on your account.");
				}

				purgeUnverifiedOrphansByEmail(vEmail.normalized, userId);

				const verifiedElsewhere = db
					.prepare(
						"SELECT u.display_name, e.email FROM email_addresses e JOIN users u ON u.id = e.user_id WHERE e.email_normalized = ? AND e.verified_at IS NOT NULL",
					)
					.get(vEmail.normalized) as { display_name: string; email: string } | undefined;

				if (verifiedElsewhere) {
					throw httpError(409, "Unable to add that email address because it is already in use.");
				}

				const emailId = crypto.randomUUID();
				const tokenId = crypto.randomUUID();
				const rawToken = crypto.randomBytes(32).toString("base64url");
				const tokenHash = sha256(rawToken);
				const t = now();

				const hasAnyEmail = db.prepare("SELECT 1 FROM email_addresses WHERE user_id = ?").get(userId);
				const addEmailTx = db.transaction(() => {
					db.prepare(
						`INSERT INTO email_addresses (id, user_id, email, email_normalized, verified_at, is_primary, created_at)
						 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
					).run(emailId, userId, vEmail.email, vEmail.normalized, hasAnyEmail ? 0 : 1, t);
					db.prepare(
						`INSERT INTO account_tokens (id, user_id, token_hash, purpose, target_email, expires_at, consumed_at, created_at)
						 VALUES (?, ?, ?, 'email_change', ?, ?, NULL, ?)`,
					).run(tokenId, userId, tokenHash, vEmail.normalized, t + VERIFY_TOKEN_TTL, t);
				});
				addEmailTx();

				const verifyUrl = `${resolveOrigin(req)}/signin/?verify=${encodeURIComponent(rawToken)}`;
				const tpl = renderChangeEmailTemplate({
					displayName: session.user.displayName || session.user.name,
					newEmail: vEmail.email,
					verifyUrl,
					expiresHours: 6,
				});

				try {
					await emailSender.send({ to: vEmail.email, ...tpl });
				} catch (err: any) {
					dbg("add email delivery failed:", err?.message || err);
					db.prepare("DELETE FROM email_addresses WHERE id = ?").run(emailId);
					db.prepare("DELETE FROM account_tokens WHERE id = ?").run(tokenId);
					throw httpError(
						503,
						"We could not send the confirmation email right now. Please try again in a moment.",
					);
				}

				return json(200, {
					ok: true,
					message: "Confirmation email sent. Please click the link in your email to verify it.",
					user: buildPublicUser(userId),
				});
			}

			if (route === "POST /api/account/email/primary") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				const body = await readJson(req, 1000);
				const emailId = String(body.emailId || "").trim();
				const row = db
					.prepare("SELECT id, email, verified_at FROM email_addresses WHERE id = ? AND user_id = ?")
					.get(emailId, userId) as { id: string; email: string; verified_at: number | null } | undefined;
				if (!row) throw httpError(404, "Email address not found.");
				if (row.verified_at === null) {
					throw httpError(400, "Please verify this email address before making it your primary address.");
				}
				const t = now();
				const setPrimaryTx = db.transaction(() => {
					db.prepare("UPDATE email_addresses SET is_primary = 0 WHERE user_id = ?").run(userId);
					db.prepare("UPDATE email_addresses SET is_primary = 1 WHERE id = ? AND user_id = ?").run(
						emailId,
						userId,
					);
					db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, userId);
				});
				setPrimaryTx();

				sendSecurityEmailBestEffort(
					userId,
					"Primary email address changed",
					`${row.email} is now the primary email address for your Verticordia Atlas account.`,
					req,
				);

				return json(200, { ok: true, user: buildPublicUser(userId) });
			}

			if (route === "POST /api/account/email/remove") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				const body = await readJson(req, 2000);
				const emailId = String(body.emailId || "").trim();

				const allEmails = getEmailsByUserStmt.all(userId) as {
					id: string;
					email: string;
					email_normalized: string;
					verified_at: number | null;
					is_primary: number;
				}[];
				const target = allEmails.find((e) => e.id === emailId);
				if (!target) throw httpError(404, "Email address not found.");

				const idents = getIdentitiesByUserStmt.all(userId) as { provider: string }[];
				const hasGoogle = idents.some((i) => i.provider === "google");
				const hasSecretKey = idents.some((i) => i.provider === "secret_key");
				const hasPassword = Boolean(hasPasswordStmt.get(userId));

				const remainingVerified = allEmails.filter((e) => e.id !== emailId && e.verified_at !== null);
				const remEmailPassword = hasPassword && remainingVerified.length > 0;
				const remMethodsCount = (hasGoogle ? 1 : 0) + (hasSecretKey ? 1 : 0) + (remEmailPassword ? 1 : 0);

				if (remMethodsCount === 0) {
					throw httpError(
						400,
						"You cannot remove this email address because it would leave your account without any way to sign in.",
					);
				}

				// If removing this verified email leaves secret_key as the ONLY remaining way to log in, require secret key confirmation
				if (target.verified_at !== null && remainingVerified.length === 0 && !hasGoogle && hasSecretKey) {
					if (!body.confirmSecretKey) {
						throw httpError(
							400,
							"Removing this email address will leave your secret key as the only way to sign in. Please confirm by entering your secret key.",
							{ requireSecretKeyConfirmation: true },
						);
					}
					if (!verifyUserSecretKey(userId, body.confirmSecretKey)) {
						throw httpError(401, "The secret key you entered does not match this account.", {
							requireSecretKeyConfirmation: true,
						});
					}
				}

				const t = now();
				const removeEmailTx = db.transaction(() => {
					db.prepare("DELETE FROM email_addresses WHERE id = ? AND user_id = ?").run(emailId, userId);
					db.prepare(
						"DELETE FROM account_tokens WHERE user_id = ? AND target_email = ? AND consumed_at IS NULL",
					).run(userId, target.email_normalized);

					if (target.is_primary === 1) {
						const nextPrimary = remainingVerified[0] || allEmails.find((e) => e.id !== emailId) || null;
						if (nextPrimary) {
							db.prepare("UPDATE email_addresses SET is_primary = 1 WHERE id = ?").run(nextPrimary.id);
						}
					}
					if (remainingVerified.length === 0 && hasPassword) {
						// Without any verified email, password credentials cannot be used or recovered
						db.prepare("DELETE FROM password_credentials WHERE user_id = ?").run(userId);
					}
					db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, userId);
				});
				removeEmailTx();

				return json(200, { ok: true, user: buildPublicUser(userId) });
			}

			if (route === "POST /api/account/credentials/revoke") {
				const session = sessionFrom(req);
				if (!session) throw httpError(401, "not signed in");
				const userId = session.user.id;
				const body = await readJson(req, 2000);
				const type = String(body.type || "") as "google" | "password" | "secret_key";
				if (type !== "google" && type !== "password" && type !== "secret_key") {
					throw httpError(400, "Invalid credential type.");
				}

				const idents = getIdentitiesByUserStmt.all(userId) as { provider: string }[];
				const hasGoogle = idents.some((i) => i.provider === "google");
				const hasSecretKey = idents.some((i) => i.provider === "secret_key");
				const hasPassword = Boolean(hasPasswordStmt.get(userId));
				const verifiedEmails = (getEmailsByUserStmt.all(userId) as { verified_at: number | null }[]).filter(
					(e) => e.verified_at !== null,
				);
				const hasEmailPassword = hasPassword && verifiedEmails.length > 0;

				if (type === "google" && !hasGoogle) throw httpError(400, "Google is not linked to this account.");
				if (type === "secret_key" && !hasSecretKey)
					throw httpError(400, "No secret key is attached to this account.");
				if (type === "password" && !hasPassword) throw httpError(400, "No password is set on this account.");

				const remGoogle = type === "google" ? false : hasGoogle;
				const remSecret = type === "secret_key" ? false : hasSecretKey;
				const remEmailPassword = type === "password" ? false : hasEmailPassword;
				const remCount = (remGoogle ? 1 : 0) + (remSecret ? 1 : 0) + (remEmailPassword ? 1 : 0);

				if (remCount === 0) {
					throw httpError(400, "You cannot remove your only remaining sign-in method.");
				}

				// If revoking this credential leaves secret_key as the ONLY remaining way to log in, require secret key confirmation
				if (remSecret && !remGoogle && !remEmailPassword) {
					if (!body.confirmSecretKey) {
						throw httpError(
							400,
							"Removing this sign-in method will leave your secret key as the only way to access your account. Please confirm by entering your secret key.",
							{ requireSecretKeyConfirmation: true },
						);
					}
					if (!verifyUserSecretKey(userId, body.confirmSecretKey)) {
						throw httpError(401, "The secret key you entered does not match this account.", {
							requireSecretKeyConfirmation: true,
						});
					}
				}

				const t = now();
				const revokeTx = db.transaction(() => {
					if (type === "google") {
						db.prepare("DELETE FROM auth_identities WHERE user_id = ? AND provider = 'google'").run(userId);
					} else if (type === "secret_key") {
						db.prepare("DELETE FROM auth_identities WHERE user_id = ? AND provider = 'secret_key'").run(
							userId,
						);
					} else if (type === "password") {
						db.prepare("DELETE FROM password_credentials WHERE user_id = ?").run(userId);
					}
					db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, userId);
				});
				revokeTx();

				const label =
					type === "google" ? "Google sign-in" : type === "password" ? "Password sign-in" : "Secret key";
				sendSecurityEmailBestEffort(
					userId,
					`${label} removed`,
					`${label} was removed from your Verticordia Atlas account.`,
					req,
				);

				return json(200, { ok: true, user: buildPublicUser(userId) });
			}

			/* ---------- Session Logout & Account Deletion ---------- */
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

			/* ---------- Sync ---------- */
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
					announce(userId, String(body.client || "").slice(0, 64));
				return json(200, { results }, headers);
			}

			return null;
		} catch (e: any) {
			if (e.status) return json(e.status, { error: e.message, ...(e.extra || {}) });
			console.error("api:", e);
			return json(500, { error: "server error" });
		}
	}

	// expired sessions, sign-in states, and account tokens are removed at startup and hourly
	const sweep = () => {
		try {
			const t = now();
			const sessions = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t).changes;
			const states = db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(t).changes;
			const tokens = db.prepare("DELETE FROM account_tokens WHERE expires_at < ?").run(t).changes;
			if (sessions || states || tokens) {
				dbg(`sweep: removed ${sessions} expired session(s), ${states} sign-in state(s), ${tokens} token(s)`);
			}
		} catch (e: any) {
			console.error("api: cleanup failed:", e.message);
		}
	};
	sweep();
	const sweepTimer = setInterval(sweep, 60 * 60 * 1000);
	sweepTimer.unref();

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

	/* ---------- media redirect registry (Cloudflare R2 / CDN) ---------- */
	const hasMediaStmt = db.prepare("SELECT 1 FROM media WHERE game = ? AND original_name = ?");
	const getMediaStmt = db.prepare(
		"SELECT game, original_name, sha256, size, uploaded_at FROM media WHERE game = ? AND original_name = ?",
	);
	const putMediaStmt = db.prepare(
		`INSERT INTO media (game, original_name, sha256, size, uploaded_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (game, original_name) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, uploaded_at = excluded.uploaded_at`,
	);

	const hasMedia = (game: string, originalName: string): boolean => Boolean(hasMediaStmt.get(game, originalName));
	const getMedia = (game: string, originalName: string) =>
		(getMediaStmt.get(game, originalName) as
			{ game: string; original_name: string; sha256: string; size: number; uploaded_at: number } | undefined) ??
		null;
	const recordMedia = (entry: { game: string; original_name: string; sha256: string; size: number }): void => {
		putMediaStmt.run(entry.game, entry.original_name, entry.sha256, entry.size, now());
	};

	const close = () => {
		clearInterval(heartbeatTimer);
		clearInterval(sweepTimer);
		for (const set of sockets.values()) for (const ws of set) ws.close();
		sockets.clear();
		db.close();
	};

	const wsCount = (): number => {
		let total = 0;
		for (const set of sockets.values()) total += set.size;
		return total;
	};

	return {
		handle,
		upgrade,
		websocket,
		close,
		wsCount,
		newSecret,
		recordGameRequest,
		gamePopularity,
		hasMedia,
		getMedia,
		recordMedia,
		_db: db,
	};
}