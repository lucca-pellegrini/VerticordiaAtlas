#!/usr/bin/env node
// server.mjs: serves the site, and makes the preview cards for shared markers on demand.
//
//   node server.mjs [--port 8080] [--host 127.0.0.1]
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
import { ROOT, exists, loadGames, markerHtml, chromePath, drawCard, socialTags, withHead, plainText } from './cards.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.woff2': 'font/woff2',
};
const TEXT = /^text\/|javascript|json|css|svg/;

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const HOST = opt('host', '127.0.0.1'), PORT = Number(opt('port', 8080));

// the configured address, if there is a real one; otherwise the address the request came in on
const configuredSite = async () => {
  const raw = process.env.SITE_URL || JSON.parse(await readFile(path.join(ROOT, 'site.json'), 'utf8')).url || '';
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
  return {
    title: loc.title || 'Marker', category: cat?.title || '', description: plainText(loc.description, 150),
    gameTitle: g.title, theme: g.theme, poster: g.poster, shot, gameSlug, mapSlug, id,
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

async function shareCard(res, gameSlug, mapSlug, id) {
  const info = await markerInfo(gameSlug, mapSlug, id);
  if (!info) return send(res, 404, 'no such marker');
  // the card is keyed by everything it shows, so a change to the marker or its colours makes a new one
  const key = crypto.createHash('sha1').update(JSON.stringify({ ...info, v: 1 })).digest('hex').slice(0, 12);
  const dir = path.join(ROOT, 'cache', 'share');
  const prefix = `${encodeURIComponent(gameSlug)}__${encodeURIComponent(mapSlug)}__${id}__`;
  const file = path.join(dir, `${prefix}${key}.jpg`);
  if (!await exists(file)) {
    await once(file, async () => {
      if (await exists(file)) return;
      console.log(`card: ${gameSlug}/${mapSlug}/${id} (${info.title})`);
      await drawCard(await chrome(), markerHtml(info), file);
      for (const old of await readdir(dir).catch(() => [])) {
        if (old.startsWith(prefix) && old !== path.basename(file)) await unlink(path.join(dir, old)).catch(() => {});
      }
    });
  }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
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
  const html = withHead(await readFile(path.join(ROOT, 'maps', gameSlug, 'index.html'), 'utf8'), block, `${shownTitle} · Verticordia Atlas`);
  send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
  return true;
}

// plain files from the site folder; a folder asks for its trailing slash, and hidden or cache paths are not served
async function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden');
  const parts = path.relative(ROOT, file).split(path.sep).filter(Boolean);
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
  const headers = { 'Content-Type': type, 'Content-Length': st.size };
  headers['Cache-Control'] = TEXT.test(type) ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    const card = /^\/cards\/share\/([^/]+)\/([^/]+)\/(\d+)\.jpg$/.exec(p);
    if (card) return await shareCard(res, card[1], card[2], Number(card[3]));

    const page = /^\/maps\/([^/]+)\/?$/.exec(p);
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

server.listen(PORT, HOST, () => {
  console.log(`Verticordia Atlas on http://${HOST}:${PORT}/`);
});
