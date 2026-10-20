#!/usr/bin/env bun
// server.mjs: serves the site, and makes the preview cards for shared markers on demand.
//
//   node server/server.mjs [--port 8080] [--host 127.0.0.1] [--debug]
//
// Plain files are served as they are. Two routes are added:
//   /maps/<game>/?loc=<id>&map=<map>        the game page, with that marker's own preview tags. The page itself
//                                           opens the marker (see app.js), so people get the same view.
//   /cards/share/<game>/<map>/<id>.jpg      that marker's card. Rendered the first time it is asked for, then
//                                           cached in cache/share/ and served from there. A changed marker (or
//                                           a changed category or game colour) gets a new card.
//
// The static homepage and game cards still come from make-cards.mjs. Share cards need Chromium and ImageMagick,
// like make-cards.mjs. The address in tags comes from site.json when it is set, otherwise from the request.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { REPO, PUBLIC, exists, loadGames, markerHtml, chromePath, drawCard, socialTags, withHead, plainText, categoryIcon, officialIcon } from './cards.mjs';
import { unpackMarker } from '../public/share-link.mjs';
import { createApi } from './api.mjs';
import { readFileSync } from 'node:fs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const TEXT = /^text\/|javascript|json|css|svg|manifest/;

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const HOST = opt('host', '127.0.0.1'), PORT = Number(opt('port', 8080));

// the configured address, if there is a real one; otherwise the address the request came in on
const configuredSite = async () => {
  const raw = process.env.SITE_URL || JSON.parse(await readFile(path.join(REPO, 'site.json'), 'utf8')).url || '';
  const site = raw.replace(/\/+$/, '');
  return /^https?:\/\/[^/]+$/.test(site) && !site.includes('YOUR-DOMAIN') ? site : null;
};
const siteOrigin = async req => (await configuredSite()) || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;

/* ---------- caches: the game list (short time), map data (by file date), chrome (once), renders (once) ---------- */

let gamesCache = null;
async function games() {
  if (!gamesCache || Date.now() - gamesCache.at > 30000) gamesCache = { at: Date.now(), list: (await loadGames()).games };
  return gamesCache.list;
}

const dataCache = new Map();
async function readData(file) {
  const st = await stat(file);
  const hit = dataCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.json;
  const json = JSON.parse(await readFile(file, 'utf8'));
  dataCache.set(file, { mtime: st.mtimeMs, json });
  return json;
}

// Card renders start headless Chromium, which is expensive. So: a few at a time; a limit per client per window; and when a
// client is over its limit (or the queue is full) it gets the game's plain card, not a render.
const RENDER_CONCURRENCY = 2, RENDER_QUEUE = 20, RENDERS_PER_WINDOW = 25, WINDOW_MS = 10 * 60 * 1000;
const clients = new Map();
const clientIp = req => String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
function allowRender(ip) {
  const now = Date.now();
  if (clients.size > 10000) clients.clear();
  let c = clients.get(ip);
  if (!c || now - c.start > WINDOW_MS) { c = { start: now, count: 0 }; clients.set(ip, c); }
  if (c.count >= RENDERS_PER_WINDOW) return false;
  c.count++;
  return true;
}
let active = 0;
const queued = [];
function takeSlot() {
  return new Promise(res => { if (active < RENDER_CONCURRENCY) { active++; res(); } else queued.push(res); });
}
function freeSlot() {
  const next = queued.shift();
  if (next) next(); else active--;
}

let chromeBin = null;
const chrome = async () => (chromeBin ??= await chromePath());

const inflight = new Map();
const once = (key, fn) => {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
};

/* ---------- a marker, from the game's own data ---------- */

async function markerInfo(gameSlug, mapSlug, id) {
  const g = (await games()).find(x => x.slug === gameSlug);
  if (!g) return null;
  const mapMeta = g.maps.find(m => m.slug === mapSlug);
  if (!mapMeta?.data) return null;
  const data = await readData(path.join(g.dir, mapMeta.data));
  const loc = (data.locations || []).find(l => Number(l.id) === id);
  if (!loc) return null;
  const cat = Object.values(data.categories || {}).find(c => c.id === loc.category_id);
  const shot = await firstScreenshot(g.dir, loc.media);
  // the card shows the category's icon: the game's own icon-font glyph, on its group's colour
  const group = (data.groups || []).find(x => x.id === cat?.group_id);
  const color = /^#?[0-9a-f]{6}$/i.test(group?.color || '') ? '#' + String(group.color).replace('#', '') : null;
  const icon = cat?.icon ? await officialIcon(g, cat.icon, color) : null;
  return {
    title: loc.title || 'Marker', category: cat?.title || '', description: plainText(loc.description, 150),
    gameTitle: g.title, theme: g.theme, poster: g.poster, shot, icon, gameSlug, mapSlug, id,
  };
}

// the first image of a marker that has been downloaded (add-game keeps media in the game's media/ folder)
async function firstScreenshot(gameDir, media) {
  for (const m of media || []) {
    const kind = m.type || (m.mime_type || '').split('/')[0];
    if (kind !== 'image' || !m.url) continue;
    let name;
    try { name = decodeURIComponent(new URL(m.url).pathname.split('/').pop()); } catch { continue; }
    const file = path.join(gameDir, 'media', name);
    if (await exists(file)) return file;
  }
  return null;
}

/* ---------- routes ---------- */

function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(body);
}

async function shareCard(req, res, gameSlug, mapSlug, id) {
  const info = await markerInfo(gameSlug, mapSlug, id);
  if (!info) return send(res, 404, 'no such marker');
  // the card is keyed by everything it shows, so a change to the marker or its colours makes a new one
  const key = crypto.createHash('sha1').update(JSON.stringify({ ...info, v: 2 })).digest('hex').slice(0, 12);
  const dir = path.join(REPO, 'cache', 'share');
  const prefix = `${encodeURIComponent(gameSlug)}__${encodeURIComponent(mapSlug)}__${id}__`;
  const file = path.join(dir, `${prefix}${key}.jpg`);
  const ready = await ensureCard(file, clientIp(req), async () => {
    console.log(`card: ${gameSlug}/${mapSlug}/${id} (${info.title})`);
    return markerHtml(info);
  });
  if (!ready) return sendPlainCard(res, gameSlug);
  if (ready && !(await exists(file))) return sendPlainCard(res, gameSlug);
  // older cards of this marker are dropped once a new one exists
  for (const old of await readdir(dir).catch(() => [])) {
    if (old.startsWith(prefix) && old !== path.basename(file)) await unlink(path.join(dir, old)).catch(() => {});
  }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  createReadStream(file).pipe(res);
}

// a card from the cache, or made now if the client may have one; false when it may not (see RENDERS_PER_WINDOW)
async function ensureCard(file, ip, htmlFor) {
  if (await exists(file)) return true;
  if (!allowRender(ip) || queued.length >= RENDER_QUEUE) return false;
  return once(file, async () => {
    if (await exists(file)) return true;
    await takeSlot();
    try {
      await drawCard(await chrome(), await htmlFor(), file);
      return true;
    } finally {
      freeSlot();
    }
  });
}

// the game's plain card, sent to a client that may not have a render (not cached, so the next request can get one)
async function sendPlainCard(res, gameSlug) {
  const game = path.join(PUBLIC, 'maps', gameSlug, 'card.jpg');
  const file = (await exists(game)) ? game : path.join(PUBLIC, 'card.jpg');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}

// the game page with this marker's tags; false when the marker does not exist (the plain page is served then)
async function sharePage(req, res, gameSlug, mapSlug, id) {
  const info = await markerInfo(gameSlug, mapSlug, id);
  if (!info) return false;
  const origin = await siteOrigin(req);
  const enc = encodeURIComponent;
  const pageUrl = `${origin}/maps/${encodeURI(gameSlug)}/?loc=${id}&map=${enc(mapSlug)}`;
  const shownTitle = `${info.title} · ${info.gameTitle}`;
  const description = [info.category, info.description].filter(Boolean).join(' · ') || `A marker on the ${info.gameTitle} map.`;
  const block = socialTags({
    title: shownTitle, description, url: pageUrl,
    image: `${origin}/cards/share/${enc(gameSlug)}/${enc(mapSlug)}/${id}.jpg`,
    alt: `${info.title} on the ${info.gameTitle} map`,
  });
  const html = withHead(await readFile(path.join(PUBLIC, 'maps', gameSlug, 'index.html'), 'utf8'), block, `${shownTitle} · Verticordia Atlas`);
  send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
  return true;
}

// a marker the user made, shared as a link: the marker is in the link itself, so its preview is made from the link
async function sharedMarkerPage(req, res, gameSlug, packed) {
  const d = await unpackMarker(packed);
  const g = d && (await games()).find(x => x.slug === gameSlug);
  if (!g) return false;
  const origin = await siteOrigin(req);
  const shownTitle = `${d.title} · ${g.title}`;
  const description = [d.category, plainText(d.desc, 150)].filter(Boolean).join(' · ') || `A marker on the ${g.title} map.`;
  const block = socialTags({
    title: shownTitle, description,
    url: `${origin}/maps/${encodeURI(gameSlug)}/?tm=${packed}&map=${encodeURIComponent(d.map)}`,
    image: `${origin}/cards/tm/${encodeURI(gameSlug)}.jpg?tm=${packed}`,
    alt: `${d.title} on the ${g.title} map`,
  });
  const html = withHead(await readFile(path.join(PUBLIC, 'maps', gameSlug, 'index.html'), 'utf8'), block, `${shownTitle} · Verticordia Atlas`);
  send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
  return true;
}

async function sharedMarkerCard(req, res, gameSlug, packed) {
  const d = await unpackMarker(packed);
  const g = d && (await games()).find(x => x.slug === gameSlug);
  if (!g) return send(res, 404, 'no such marker');
  const key = crypto.createHash('sha1').update('tm2').update(packed).digest('hex').slice(0, 16);
  const file = path.join(REPO, 'cache', 'share', `tm-${encodeURIComponent(gameSlug)}-${key}.jpg`);
  const ready = await ensureCard(file, clientIp(req), async () => {
    console.log(`card: shared marker in ${gameSlug} (${d.title})`);
    return markerHtml({
      title: d.title, category: d.category, description: plainText(d.desc, 150), gameTitle: g.title, theme: g.theme, poster: g.poster,
      icon: d.category ? await categoryIcon(d) : null,
    });
  });
  if (!ready || !(await exists(file))) return sendPlainCard(res, gameSlug);
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  createReadStream(file).pipe(res);
}

// plain files from the site folder; a folder asks for its trailing slash, and hidden or cache paths are not served
async function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
  const parts = path.relative(PUBLIC, file).split(path.sep).filter(Boolean);
  if (parts.some(p => p.startsWith('.') || p === 'cache' || p === 'node_modules')) return send(res, 404, 'not found');
  let st;
  try { st = await stat(file); } catch { return send(res, 404, 'not found'); }
  if (st.isDirectory()) {
    if (!rel.endsWith('/')) {
      res.writeHead(301, { Location: rel + '/' + url.search });
      return res.end();
    }
    return serveStatic(req, res, new URL(rel + 'index.html', 'http://localhost'));
  }
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return send(res, 404, 'not found');
  // validators: an ETag from size and modification time, and Last-Modified for clients that only use dates
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const lastModified = st.mtime.toUTCString();
  const headers = { 'Content-Type': type, ETag: etag, 'Last-Modified': lastModified };
  // text (json, js, css, html) is revalidated on every use, which costs a 304 when unchanged; media is cached for an hour
  headers['Cache-Control'] = TEXT.test(type) ? 'no-cache' : 'public, max-age=3600';
  if (notModified(req, etag, st.mtime)) {
    res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': headers['Cache-Control'] });
    return res.end();
  }
  // text is sent gzipped when the client takes it (cached per file date, so the work is done once)
  if (TEXT.test(type) && st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const body = await gzipped(file, st);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = body.length;
    headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const gzip = promisify(zlib.gzip);
const gzCache = new Map();
async function gzipped(file, st) {
  const hit = gzCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.body;
  const body = await gzip(await readFile(file));
  gzCache.set(file, { mtime: st.mtimeMs, body });
  return body;
}
// RFC 9110: If-None-Match wins when present; If-Modified-Since is only checked without it
function notModified(req, etag, mtime) {
  const inm = req.headers['if-none-match'];
  const strip = t => t.trim().replace(/^W\//, '');
  if (inm) return inm.trim() === '*' || inm.split(',').some(t => strip(t) === strip(etag));
  const ims = req.headers['if-modified-since'];
  if (ims) { const since = Date.parse(ims); return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since; }
  return false;
}

// accounts and sync (optional for the user): the Google client ID comes from site.json, the database from data/
const siteFile = JSON.parse(readFileSync(path.join(REPO, 'site.json'), 'utf8'));
const DEBUG = args.includes('--debug'); // logs sign-in steps (no tokens, no e-mail addresses)
const api = createApi({ debug: DEBUG, root: REPO, googleClientId: process.env.GOOGLE_CLIENT_ID || siteFile.googleClientId || null, publicUrl: (process.env.PUBLIC_URL || siteFile.url || '').replace(/\/+$/, '') || null });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const handled = await api.handle(req, res, url);
      if (handled === false) send(res, 404, '{"error":"not found"}', 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const p = decodeURIComponent(url.pathname);

    const card = /^\/cards\/share\/([^/]+)\/([^/]+)\/(\d+)\.jpg$/.exec(p);
    if (card) return await shareCard(req, res, card[1], card[2], Number(card[3]));

    const tmCard = /^\/cards\/tm\/([^/]+)\.jpg$/.exec(p);
    if (tmCard) return await sharedMarkerCard(req, res, tmCard[1], url.searchParams.get('tm') || '');

    const page = /^\/maps\/([^/]+)\/?$/.exec(p);
    const tm = url.searchParams.get('tm');
    if (page && tm && await sharedMarkerPage(req, res, page[1], tm)) return;
    const loc = url.searchParams.get('loc');
    if (page && loc && /^\d+$/.test(loc)) {
      const map = url.searchParams.get('map') || '';
      if (await sharePage(req, res, page[1], map, Number(loc))) return;
    }

    return await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'server error');
    else res.end();
  }
});

// live updates for signed-in devices (see api.mjs): only /api/ws takes an upgrade
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/ws') return api.upgrade(req, socket, head, url);
  } catch (e) { console.error(e); }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`Verticordia Atlas on http://${HOST}:${PORT}/`);
});
