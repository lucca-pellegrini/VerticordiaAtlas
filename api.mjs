// api.mjs: optional accounts and cross-device sync, under /api/. The app works without any of this: an account only
// lets the same progress follow you to another device. Everything is in one SQLite file (data/atlas.db).
//
// Accounts: Google sign-in (the ID token is verified here, and the account is keyed by Google's `sub`), or a random
// secret key (shown once; only its hash is kept). Either way the server issues its own session cookie.
// Sessions last 30 days and slide forward when they are within 7 days of expiring.
//
// Sync: each item (a profile, or a map's presets or view) is stored whole, with a server timestamp. A client sends the
// timestamp it last saw ("base"); if the server has something newer, the client is told so and decides what to keep.

import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { acceptWebSocket } from './ws.mjs';

const DAY = 86400000;
const SESSION_DAYS = 30, REFRESH_WITHIN = 7 * DAY;
const COOKIE = 'va_session';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
// a key names one item: a profile, or a map's presets or view. Only plain slugs and ids are allowed in it.
const SEG = '[A-Za-z0-9._-]{1,80}';
const KEY_PATTERN = new RegExp(`^(profile:${SEG}:${SEG}|meta:(presets|view):${SEG}(:${SEG})?)$`);
const MAX_VALUE = 2_000_000, MAX_ITEMS = 200;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function createApi({ root, googleClientId = null, googleCertsUrl = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs' }) {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'data', 'atlas.db'));
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
    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
  `);

  const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
  const now = () => Date.now();

  /* ---------- rate limit for the sign-in endpoints ---------- */
  const hits = new Map();
  function allowLogin(ip) {
    const t = now();
    if (hits.size > 10000) hits.clear();
    let h = hits.get(ip);
    if (!h || t - h.start > 15 * 60 * 1000) { h = { start: t, count: 0 }; hits.set(ip, h); }
    h.count++;
    return h.count <= 20;
  }

  /* ---------- small helpers ---------- */
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const clientIp = req => String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const secure = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

  async function readJson(req, limit) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'expected JSON');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw httpError(413, 'too large');
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw httpError(400, 'bad JSON'); }
  }
  function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

  const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
  const cookieHeader = (req, value, maxAge) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

  const publicUser = u => ({
    id: u.id, provider: u.provider,
    email: u.email || null,
    name: u.provider === 'google' ? (u.display_name || u.email || 'Google account') : 'Secret key account',
  });

  /* ---------- sessions ---------- */
  function sessionFrom(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.provider, u.email, u.display_name
                            FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    if (!row) return null;
    const t = now();
    if (row.expires_at <= t) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash); return null; }
    return { token, user: publicUser(row), tokenHash: row.token_hash, expiresAt: row.expires_at };
  }
  // sliding expiry: a session close to its end is extended, and the cookie with it
  function touch(req, res, session) {
    const t = now();
    if (session.expiresAt - t < REFRESH_WITHIN) {
      const expires = t + SESSION_DAYS * DAY;
      db.prepare('UPDATE sessions SET expires_at = ?, last_used = ? WHERE token_hash = ?').run(expires, t, session.tokenHash);
      res.setHeader('Set-Cookie', cookieHeader(req, session.token, SESSION_DAYS * 86400));
    }
  }
  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, t, t + SESSION_DAYS * DAY, t);
    res.setHeader('Set-Cookie', cookieHeader(req, token, SESSION_DAYS * 86400));
  }

  /* ---------- Google: verify the ID token ourselves (signature, issuer, audience, expiry) ---------- */
  let certs = null, certsAt = 0;
  async function googleKeys(force = false) {
    if (force || !certs || now() - certsAt > 3600_000) {
      const r = await fetch(googleCertsUrl);
      if (!r.ok) throw httpError(502, 'could not fetch Google keys');
      certs = (await r.json()).keys || [];
      certsAt = now();
    }
    return certs;
  }
  async function verifyGoogleToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw httpError(400, 'not a token');
    const [h, p, s] = parts;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') throw httpError(401, 'unexpected token algorithm');
    let key = (await googleKeys()).find(k => k.kid === header.kid);
    if (!key) key = (await googleKeys(true)).find(k => k.kid === header.kid); // keys rotate
    if (!key) throw httpError(401, 'unknown signing key');
    const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))) throw httpError(401, 'bad signature');
    if (!GOOGLE_ISSUERS.includes(payload.iss)) throw httpError(401, 'wrong issuer');
    if (!googleClientId || payload.aud !== googleClientId) throw httpError(401, 'wrong audience');
    if (!(payload.exp * 1000 > now())) throw httpError(401, 'token expired');
    if (payload.email_verified !== true) throw httpError(401, 'e-mail not verified');
    if (typeof payload.sub !== 'string' || !payload.sub) throw httpError(401, 'no subject');
    return { sub: payload.sub, email: String(payload.email || ''), name: String(payload.name || '') };
  }

  /* ---------- secret keys: 128 random bits, shown once, stored as a hash ---------- */
  function newSecret() {
    const bytes = crypto.randomBytes(16);
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
      value = (value << 8) | b; bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out.match(/.{1,4}/g).join('-');
  }
  // people type these by hand: case, dashes and the look-alikes (O, I, L) do not matter
  const normalizeSecret = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

  /* ---------- sync ---------- */
  function validItem(it) {
    if (!it || typeof it.key !== 'string' || !KEY_PATTERN.test(it.key)) return false;
    if (it.value !== null && JSON.stringify(it.value ?? null).length > MAX_VALUE) return false;
    return true;
  }
  function syncPush(userId, items) {
    const get = db.prepare('SELECT value, updated_at FROM user_data WHERE user_id = ? AND key = ?');
    const put = db.prepare(`INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
                            ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    const results = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const it of items) {
        const cur = get.get(userId, it.key);
        const base = Number.isFinite(it.base) ? it.base : 0;
        if (cur && cur.updated_at > base) {
          results.push({ key: it.key, status: 'conflict', value: cur.value === null ? null : JSON.parse(cur.value), updated_at: cur.updated_at });
          continue;
        }
        // server time orders the writes; it always moves forward for a key
        let t = now();
        if (cur && t <= cur.updated_at) t = cur.updated_at + 1;
        const value = it.value === null ? null : JSON.stringify(it.value);
        put.run(userId, it.key, value, t);
        results.push({ key: it.key, status: 'ok', updated_at: t });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return results;
  }
  const syncPull = userId => db.prepare('SELECT key, value, updated_at FROM user_data WHERE user_id = ?').all(userId)
    .map(r => ({ key: r.key, value: r.value === null ? null : JSON.parse(r.value), updated_at: r.updated_at }));

  /* ---------- the routes ---------- */
  /* ---------- live updates: a WebSocket per signed-in device, told when another device pushed ---------- */
  const MAX_SOCKETS_PER_USER = 8;
  const sockets = new Map(); // user id -> Set of { ws, client, tokenHash }

  function announce(userId, exceptClient) {
    for (const c of sockets.get(userId) || []) if (!exceptClient || c.client !== exceptClient) c.ws.send('{"type":"changed"}');
  }
  function dropSockets(match) { // sign-out: the sockets it belonged to go too
    for (const set of sockets.values()) for (const c of [...set]) if (match(c)) c.ws.close(4401, 'signed out');
  }
  const sessionAlive = tokenHash => {
    const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash);
    return !!row && row.expires_at > now();
  };

  function upgrade(req, socket, head, url) {
    const refuse = (code, text) => { try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } };
    if (url.pathname !== '/api/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse(400, 'Bad Request');
    // a page on another site must not be able to open this socket with the visitor's cookie
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* malformed */ }
      const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')].map(h => String(h || '').trim()).filter(Boolean);
      if (!host || !hosts.includes(host)) return refuse(403, 'Forbidden');
    }
    const session = sessionFrom(req);
    if (!session) return refuse(401, 'Unauthorized');
    const userId = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(session.tokenHash).user_id;
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return refuse(400, 'Bad Request');
    const client = String(url.searchParams.get('c') || '').slice(0, 64);
    const entry = { ws, client, tokenHash: session.tokenHash };
    const set = sockets.get(userId) || new Set();
    sockets.set(userId, set);
    set.add(entry);
    while (set.size > MAX_SOCKETS_PER_USER) set.values().next().value.ws.close(1008, 'too many connections'); // the oldest goes
    ws.onHeartbeat(() => sessionAlive(session.tokenHash));
    ws.onClose(() => { set.delete(entry); if (!set.size) sockets.delete(userId); });
    ws.send('{"type":"hello"}');
  }

  async function handle(req, res, url) {
    try {
      const route = `${req.method} ${url.pathname}`;
      const ip = clientIp(req);

      if (route === 'GET /api/config') return json(res, 200, { googleClientId });

      if (route === 'GET /api/me') {
        const session = sessionFrom(req);
        if (session) touch(req, res, session);
        return json(res, 200, { user: session ? session.user : null });
      }

      if (route === 'POST /api/auth/google') {
        if (!allowLogin(ip)) throw httpError(429, 'too many attempts, try again later');
        const body = await readJson(req, 16_000);
        const g = await verifyGoogleToken(body.credential);
        db.prepare(`INSERT INTO users (id, provider, google_sub, email, display_name, created_at) VALUES (?, 'google', ?, ?, ?, ?)
                    ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`)
          .run(crypto.randomUUID(), g.sub, g.email, g.name, now());
        const user = db.prepare("SELECT * FROM users WHERE provider = 'google' AND google_sub = ?").get(g.sub);
        startSession(req, res, user.id);
        return json(res, 200, { user: publicUser(user) });
      }

      if (route === 'POST /api/auth/secret/new') {
        if (!allowLogin(ip)) throw httpError(429, 'too many attempts, try again later');
        await readJson(req, 1000);
        const secret = newSecret();
        const id = crypto.randomUUID();
        db.exec('BEGIN');
        try {
          db.prepare("INSERT INTO users (id, provider, created_at) VALUES (?, 'secret', ?)").run(id, now());
          db.prepare('INSERT INTO secret_accounts (user_id, secret_hash) VALUES (?, ?)').run(id, sha256(normalizeSecret(secret)));
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        startSession(req, res, id);
        return json(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), secret });
      }

      if (route === 'POST /api/auth/secret/login') {
        if (!allowLogin(ip)) throw httpError(429, 'too many attempts, try again later');
        const body = await readJson(req, 1000);
        const norm = normalizeSecret(body.secret);
        if (norm.length !== 26) throw httpError(401, 'that key does not match an account');
        const row = db.prepare(`SELECT u.* FROM secret_accounts a JOIN users u ON u.id = a.user_id WHERE a.secret_hash = ?`).get(sha256(norm));
        if (!row) throw httpError(401, 'that key does not match an account');
        startSession(req, res, row.id);
        return json(res, 200, { user: publicUser(row) });
      }

      if (route === 'POST /api/auth/logout') {
        const session = sessionFrom(req);
        if (session) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash); dropSockets(c => c.tokenHash === session.tokenHash); }
        res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
        return json(res, 200, { ok: true });
      }

      if (route === 'POST /api/auth/logout-all') {
        const session = sessionFrom(req);
        if (!session) throw httpError(401, 'not signed in');
        const userId = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(session.tokenHash).user_id;
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        for (const c of [...(sockets.get(userId) || [])]) c.ws.close(4401, 'signed out');
        res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
        return json(res, 200, { ok: true });
      }

      if (route === 'GET /api/sync' || route === 'POST /api/sync') {
        const session = sessionFrom(req);
        if (!session) throw httpError(401, 'not signed in');
        touch(req, res, session);
        const userId = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(session.tokenHash).user_id;
        if (req.method === 'GET') return json(res, 200, { items: syncPull(userId) });
        const body = await readJson(req, 8 * 1024 * 1024);
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length > MAX_ITEMS || !items.every(validItem)) throw httpError(400, 'bad sync request');
        const results = syncPush(userId, items);
        if (results.some(r => r.status === 'ok')) announce(userId, String(body.client || '').slice(0, 64)); // the other devices of this account
        return json(res, 200, { results });
      }

      return false;
    } catch (e) {
      if (e.status) return json(res, e.status, { error: e.message });
      console.error('api:', e);
      return json(res, 500, { error: 'server error' });
    }
  }

  return { handle, upgrade, close: () => db.close(), _db: db, newSecret, normalizeSecret };
}
