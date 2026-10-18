#!/usr/bin/env node
// add-game.mjs: add (or refresh) a MapGenie game from just its link.
//
//   node add-game.mjs https://mapgenie.io/<game>/maps/<map> [options]
//
// First run it with --no-tiles --no-media: it only reads the page and prints a report of what
// the game contains (maps, tile sets, marker sprite, media, features the viewer cannot draw yet).
//
// Options
//   --out <dir>          output root (default ./maps); the game lands in <out>/<id>/
//   --id <id>            folder/id for the game (default: the game slug from the URL)
//   --title <text>       display title (default: taken from the page)
//   --poster <file|url>  poster image (default: the one already in the game folder, else the page's og:image).
//                        Makes poster-600/1200.webp for the homepage, and (with --poster) a theme from its colours
//   --tag-label <text>   label for the tag selector (default: guessed, "Difficulty" or "Filter")
//   --default-tag <text> tag selected by default for new profiles
//   --index <file>       homepage manifest to update (default ./maps/index.json)
//   --slug <name>        folder / URL name of the game page (default: --id)
//   --accent <#rrggbb>   theme accent colour (default: the colour of the game's first group)
//   --max-zoom <n>       cap tile zoom (default: the tile set's tiles_max_zoom)
//   --all-tilesets       download every tile set of a map (default: only the first)
//   --videos             also download video media (default: images only)
//   --no-tiles --no-media --no-markers
//   --html <file>        read the map page from a saved file instead of fetching it
//   --mapdata <file>     use a saved window.mapData JSON (the old console snippet) for this one map
//   --tiles-base <url>   tile CDN base (default https://tiles.mapgenie.io/games)
//   --media-base <url>   marker CDN base (default https://media.mapgenie.io/v2/assets/prod/games)
//   --concurrency <n> --delay <ms> --max-tiles <n>

import { mkdir, writeFile, readFile, readdir, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => access(p).then(() => true, () => false);
const mb = n => (n / 1e6).toFixed(1) + ' MB';

/* ---------- extracting window.* values from the page HTML ---------- */

function readExpression(html, start) {
  let i = start, depth = 0, quote = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (depth <= 0 && (c === ';' || c === '\n' || c === '<')) break;
  }
  return html.slice(start, i).trim();
}

export function extractVar(html, name, ok = v => v && typeof v === 'object') {
  const re = new RegExp(`window\\.${name}\\s*=\\s*`, 'g');
  let m;
  while ((m = re.exec(html))) {
    const expr = readExpression(html, m.index + m[0].length);
    const attempts = [
      () => JSON.parse(expr),
      // fallbacks for JS literals or JSON.parse('...') wrappers; empty context, 2 s limit
      () => vm.runInNewContext('(' + expr + ')', { JSON }, { timeout: 2000 }),
    ];
    for (const attempt of attempts) {
      try { const v = JSON.parse(JSON.stringify(attempt())); if (ok(v)) return v; } catch {}
    }
  }
  return null;
}
const isMapData = v => v && Array.isArray(v.locations) && v.mapConfig;

/* ---------- network helpers ---------- */

async function getPage(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return { html: await r.text(), url: r.url };
}

async function getJSON(url, referer) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: referer } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// The page only inlines part of window.mapData (map, mapConfig, groups, categories). The site's own script then
// fetches /api/v1/maps/<id>/data (locations, tags, styles, maps, regions, ...) and merges it in; so do we.
async function loadMapData(html, origin, slug, referer) {
  const inline = extractVar(html, 'mapData', v => v && typeof v === 'object' && v.mapConfig);
  if (!inline) return null;
  if (Array.isArray(inline.locations)) return inline; // older pages / saved console dumps: already complete
  if (!inline.map?.id) throw new Error('mapData has no map id, cannot fetch its locations');
  const api = await getJSON(`${origin}/api/v1/maps/${inline.map.id}/data`, referer);
  return { ...inline, ...api };
}

async function getBin(url, tries = 3) {
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { Referer: 'https://mapgenie.io/', 'User-Agent': UA } });
      if ([403, 404, 410].includes(r.status)) return { status: r.status };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { status: 200, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
    } catch (e) { last = e; await sleep(500 * a); }
  }
  return { status: 0, error: String(last) };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

/* ---------- tile maths ---------- */

const lon2x = (lon, n) => (lon + 180) / 360 * n;
const lat2y = (lat, n) => {
  const r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
};

export function tilesCovering(bounds, z, pad = 0) {
  const n = 2 ** z, [w, s, e, nn] = bounds;
  const x0 = Math.max(0, Math.floor(lon2x(w, n)) - pad);
  const x1 = Math.min(n - 1, Math.max(Math.floor(lon2x(w, n)), Math.ceil(lon2x(e, n)) - 1) + pad);
  const y0 = Math.max(0, Math.floor(lat2y(nn, n)) - pad);
  const y1 = Math.min(n - 1, Math.max(Math.floor(lat2y(nn, n)), Math.ceil(lat2y(s, n)) - 1) + pad);
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}

const fill = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

function boundsFor(md, ts) {
  const b = ts.bounds || md.styles?.mapStyle?.bounds;
  if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) return { bounds: b, guessed: false };
  const lats = md.locations.map(l => parseFloat(l.latitude)).filter(Number.isFinite);
  const lngs = md.locations.map(l => parseFloat(l.longitude)).filter(Number.isFinite);
  const dx = (Math.max(...lngs) - Math.min(...lngs)) || 1, dy = (Math.max(...lats) - Math.min(...lats)) || 1;
  return { bounds: [Math.min(...lngs) - dx, Math.min(...lats) - dy, Math.max(...lngs) + dx, Math.max(...lats) + dy], guessed: true };
}

/* ---------- tiles: crawl the pyramid top-down, 404 prunes ---------- */

async function downloadTiles({ md, ts, baseCandidates, destDir, localTail, opts }) {
  const minZ = ts.min_zoom ?? 0;
  const maxZ = Math.min(ts.tiles_max_zoom ?? ts.max_zoom ?? 15, opts.maxZoom ?? 99);
  const { bounds, guessed } = boundsFor(md, ts);
  if (guessed) console.log('  ! no bounds in the data, guessing from marker positions (check the tile count below)');
  const remote = base => `${base}/${ts.pattern}`;
  const first = tilesCovering(bounds, minZ, 1);

  let base = null;
  for (const b of baseCandidates) {
    for (const [x, y] of first) {
      const r = await getBin(fill(remote(b), minZ, x, y), 1);
      if (r.status === 200 && r.type.startsWith('image/')) { base = b; break; }
    }
    if (base) break;
  }
  if (!base) throw new Error(`No tile found at zoom ${minZ} under: ${baseCandidates.join(', ')}. Try --tiles-base.`);

  const stats = { saved: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 };
  let cands = first;
  for (let z = minZ; z <= maxZ; z++) {
    if (stats.saved + stats.skipped + cands.length > opts.maxTiles) { console.log(`  stopping before zoom ${z}: would pass --max-tiles ${opts.maxTiles}`); break; }
    const found = [];
    await pool(cands, opts.concurrency, async ([x, y]) => {
      const file = path.join(destDir, fill(localTail, z, x, y));
      if (await exists(file)) { stats.skipped++; found.push([x, y]); return; }
      const r = await getBin(fill(remote(base), z, x, y));
      if (r.status === 200 && r.type.startsWith('image/')) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, r.buf);
        stats.saved++; stats.bytes += r.buf.length; found.push([x, y]);
      } else if (r.status === 0) stats.failed++;
      else stats.missing++;
      if (opts.delay) await sleep(opts.delay);
    });
    console.log(`  zoom ${z}: ${found.length} tiles (${cands.length} tried)`);
    if (!found.length) break;
    cands = found.flatMap(([x, y]) => [[2 * x, 2 * y], [2 * x + 1, 2 * y], [2 * x, 2 * y + 1], [2 * x + 1, 2 * y + 1]]);
  }
  console.log(`  tiles: saved ${stats.saved}, already had ${stats.skipped}, missing ${stats.missing}, failed ${stats.failed}, ${mb(stats.bytes)}`);
  return { minzoom: minZ, maxzoom: maxZ, bounds, stats };
}

/* ---------- markers sprite ---------- */

async function downloadMarkers({ html, slug, mediaBase, outDir, cats }) {
  const hit = html.match(/https?:\/\/[^"'\s\\]+?\/markers\/markers\.json([^"'\s\\]*)/);
  const bases = [];
  if (hit) bases.push({ dir: hit[0].replace(/markers\.json.*$/, ''), q: hit[1] });
  bases.push({ dir: `${mediaBase}/${slug}/markers/`, q: hit ? hit[1] : '' }, { dir: `${mediaBase}/${slug}/markers/`, q: '?v=2' });
  for (const { dir, q } of bases) {
    const j = await getBin(dir + 'markers.json' + q, 1);
    if (j.status !== 200) continue;
    let defs; try { defs = JSON.parse(j.buf.toString('utf8')); } catch { continue; }
    const p = await getBin(dir + 'markers.png' + q);
    if (p.status !== 200) continue;
    await writeFile(path.join(outDir, 'markers.json'), j.buf);
    await writeFile(path.join(outDir, 'markers.png'), p.buf);
    const res = { json: 'markers.json', png: 'markers.png', json2x: null, png2x: null };
    const j2 = await getBin(dir + 'markers@2x.json' + q, 1), p2 = j2.status === 200 ? await getBin(dir + 'markers@2x.png' + q) : { status: 0 };
    if (j2.status === 200 && p2.status === 200) {
      await writeFile(path.join(outDir, 'markers@2x.json'), j2.buf);
      await writeFile(path.join(outDir, 'markers@2x.png'), p2.buf);
      res.json2x = 'markers@2x.json'; res.png2x = 'markers@2x.png';
    }
    const used = new Set(cats.map(c => c.icon).filter(Boolean));
    res.missingIcons = [...used].filter(i => !defs[i]);
    res.sprites = Object.keys(defs).length;
    return res;
  }
  return null;
}

/* ---------- media ---------- */

function collectMedia(maps, withVideos) {
  const urls = new Map();   // url -> kind
  const kinds = {};
  for (const md of maps) for (const l of md.locations) for (const m of l.media || []) {
    const kind = (m.type || (m.mime_type || '').split('/')[0] || 'unknown');
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (!m.url) continue;
    if (kind === 'image' || withVideos) urls.set(m.url, kind);
  }
  // images embedded in descriptions: ![alt](url)
  let embedded = 0;
  for (const md of maps) for (const l of md.locations) for (const m of (l.description || '').matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g)) { embedded++; urls.set(m[1], 'image'); }
  return { urls, kinds, embedded };
}

async function downloadMedia(urls, dir, opts) {
  await mkdir(dir, { recursive: true });
  const st = { saved: 0, skipped: 0, failed: 0, bytes: 0 };
  const names = new Map();
  await pool([...urls.keys()], opts.concurrency, async url => {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    if (names.has(name) && names.get(name) !== url) console.log('  ! file name collision:', name);
    names.set(name, url);
    const file = path.join(dir, name);
    if (await exists(file)) { st.skipped++; return; }
    const r = await getBin(url);
    if (r.status === 200) { await writeFile(file, r.buf); st.saved++; st.bytes += r.buf.length; }
    else { st.failed++; console.log('  failed', url, r.status || r.error); }
    if (opts.delay) await sleep(opts.delay);
  });
  console.log(`  media: saved ${st.saved}, already had ${st.skipped}, failed ${st.failed}, ${mb(st.bytes)}`);
  return st;
}

/* ---------- report: what is in this game, and what the viewer will not draw ---------- */

function report(slug, maps, sprite) {
  console.log('\n=== Report ===');
  for (const md of maps) {
    const cats = Object.values(md.categories || {});
    const types = {};
    cats.forEach(c => { types[c.display_type || 'marker'] = (types[c.display_type || 'marker'] || 0) + 1; });
    const lines = [];
    lines.push(`map "${md.map?.slug}" (${md.map?.title}): ${md.locations.length} locations, ${cats.length} categories in ${(md.groups || []).length} groups, display types ${JSON.stringify(types)}`);
    lines.push(`  tags: ${(md.tags || []).map(t => t.title).join(', ') || 'none'}`);
    for (const ts of md.mapConfig.tile_sets || []) lines.push(`  tile set "${ts.name}": zoom ${ts.min_zoom}-${ts.tiles_max_zoom ?? '?'} (view up to ${ts.max_zoom}), ${ts.extension}, pattern ${ts.pattern}`);
    const warn = [];
    const f = md.locations.filter(l => l.features).length;
    if (f) warn.push(`${f} locations carry "features" (lines/polygons)`);
    if ((md.regions || []).length) warn.push(`${md.regions.length} regions`);
    if ((md.roads || []).length) warn.push(`${md.roads.length} roads`);
    if ((md.routes || []).length) warn.push(`${md.routes.length} routes`);
    if ((md.heatmapCategories || []).length) warn.push('heatmaps');
    if (Object.keys(types).some(t => t !== 'marker')) warn.push(`non-marker categories: ${Object.keys(types).filter(t => t !== 'marker').join(', ')}`);
    if (md.mapConfig.overlay) warn.push('map overlay');
    if ((md.mapConfig.tile_sets || []).length > 1) warn.push('several tile sets');
    const prem = cats.filter(c => c.premium).length;
    if (prem) warn.push(`${prem} premium categories`);
    if ((md.proCategoryLocationCounts || []).length) warn.push('proCategoryLocationCounts is not empty: some locations are Pro-only and are NOT in this data');
    console.log(lines.join('\n'));
    console.log(warn.length ? '  not rendered / incomplete: ' + warn.join('; ') : '  nothing unusual');
  }
  if (sprite) console.log(`markers: ${sprite.sprites} icons, @2x ${sprite.json2x ? 'yes' : 'no'}, categories without an icon in the sprite: ${sprite.missingIcons.length ? sprite.missingIcons.join(', ') : 'none'}`);
  else console.log('markers: no sprite found (the viewer needs a generic pin fallback for this game)');
}

/* ---------- theme: every colour of a game page is derived from one accent ---------- */

function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}
function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return '#' + f(0) + f(8) + f(4);
}
// group colours come without "#"; very dark or grey ones make a poor accent
function vividHex(c) {
  if (!/^#?[0-9a-f]{6}$/i.test(c || '')) return null;
  const [h, s, l] = hexToHsl('#' + c.replace('#', ''));
  return hslToHex(h, Math.max(s, 0.45), Math.min(Math.max(l, 0.42), 0.55));
}
export function deriveTheme(accent) {
  const [h, s] = hexToHsl(accent), tint = (sat, l) => hslToHex(h, Math.min(sat, s), l);
  const [, , al] = hexToHsl(accent);
  return {
    accent, 'accent-soft': hslToHex(h, Math.min(s, 0.7), Math.min(0.78, al + 0.22)),
    night: tint(0.3, 0.035), panel: tint(0.3, 0.065), 'panel-2': tint(0.28, 0.095), line: tint(0.25, 0.17),
  };
}

/* ---------- poster: homepage variants, and a theme derived from the picture ---------- */

// ImageMagick does the image work (no npm dependency). Without it the poster is used as is and the theme comes from the game's group colours.
let magickBin;
async function magick(args, opts = {}) {
  if (magickBin === undefined) {
    magickBin = null;
    for (const bin of ['magick', 'convert']) {
      try { await execFileP(bin, ['-version']); magickBin = bin; break; } catch {}
    }
  }
  if (!magickBin) return null;
  try { return (await execFileP(magickBin, args, { encoding: 'buffer', maxBuffer: 64 << 20, ...opts })).stdout; } catch { return null; }
}

// 600x300 and 1200x600 webp, centre-cropped to the card's 2:1 shape (what the homepage srcset expects)
async function posterVariants(file, dir, force) {
  for (const w of [600, 1200]) {
    const out = path.join(dir, `poster-${w}.webp`);
    if (!force && await exists(out)) continue; // keep hand-made ones unless a new --poster was given
    if (!(await magick([file, '-auto-orient', '-resize', `${w}x${w / 2}^`, '-gravity', 'center', '-extent', `${w}x${w / 2}`, '-quality', '82', out]) || await exists(out))) return false;
  }
  return true;
}

// Accent colour of a picture: a hue histogram where each pixel counts by its chroma, so the colour that covers the
// most of the image while still being colourful wins over greys and near-black. Returns '#rrggbb' or null.
export async function accentFromPoster(file) {
  const W = 96, H = 54;
  const raw = await magick([file, '-auto-orient', '-resize', `${W}x${H}!`, '-depth', '8', 'rgb:-']);
  if (!raw || raw.length < W * H * 3) return null;
  const BINS = 24, bins = Array.from({ length: BINS }, () => ({ w: 0, s: 0, l: 0 }));
  for (let i = 0; i < W * H; i++) {
    const hex = '#' + [0, 1, 2].map(k => raw[i * 3 + k].toString(16).padStart(2, '0')).join('');
    const [h, sat, l] = hexToHsl(hex);
    const chroma = sat * (1 - Math.abs(2 * l - 1));
    if (chroma < 0.05) continue;
    const b = bins[Math.floor(h / (360 / BINS)) % BINS];
    b.w += chroma; b.s += sat * chroma; b.l += l * chroma; b.h = (b.h || 0) + h * chroma;
  }
  // smooth over the neighbouring bins, then take the heaviest
  const score = i => bins[i].w + 0.5 * (bins[(i + 1) % BINS].w + bins[(i + BINS - 1) % BINS].w);
  let best = 0;
  for (let i = 1; i < BINS; i++) if (score(i) > score(best)) best = i;
  const b = bins[best];
  if (!b.w) return null;
  const h = b.h / b.w, sat = b.s / b.w, l = b.l / b.w;
  return hslToHex(h, Math.min(0.75, Math.max(0.4, sat)), Math.min(0.5, Math.max(0.38, l)));
}

/* ---------- main ---------- */

const guessTagLabel = tags => (tags.some(t => /casual|easy|normal|standard|hard|insane|insanity|nightmare|veteran|survival|legend/i.test(t.title)) ? 'Difficulty' : 'Filter');

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: './maps' }, id: { type: 'string' }, slug: { type: 'string' }, accent: { type: 'string' }, title: { type: 'string' }, poster: { type: 'string' },
      'tag-label': { type: 'string' }, 'default-tag': { type: 'string' }, index: { type: 'string', default: './maps/index.json' },
      'max-zoom': { type: 'string' }, 'all-tilesets': { type: 'boolean', default: false }, videos: { type: 'boolean', default: false },
      'no-tiles': { type: 'boolean', default: false }, 'no-media': { type: 'boolean', default: false }, 'no-markers': { type: 'boolean', default: false },
      html: { type: 'string' }, mapdata: { type: 'string' },
      'tiles-base': { type: 'string' }, 'media-base': { type: 'string', default: 'https://media.mapgenie.io/v2/assets/prod/games' },
      concurrency: { type: 'string', default: '4' }, delay: { type: 'string', default: '100' }, 'max-tiles': { type: 'string', default: '400000' },
    },
  });
  if (!positionals[0]) { console.error('Usage: node add-game.mjs https://mapgenie.io/<game>/maps/<map> [options]'); process.exit(1); }
  const opts = { concurrency: +v.concurrency, delay: +v.delay, maxTiles: +v['max-tiles'], maxZoom: v['max-zoom'] ? +v['max-zoom'] : undefined };

  const startUrl = new URL(positionals[0]);
  const segs = startUrl.pathname.split('/').filter(Boolean);
  let slug = segs[0], mapSlug = segs[1] === 'maps' ? segs[2] : null;
  const origin = startUrl.origin;

  // 1. first page and its mapData
  let page, md0;
  if (v.mapdata) {
    md0 = JSON.parse(await readFile(v.mapdata, 'utf8'));
    page = { html: v.html ? await readFile(v.html, 'utf8') : '', url: startUrl.href };
  } else {
    page = v.html ? { html: await readFile(v.html, 'utf8'), url: startUrl.href } : await getPage(startUrl.href);
    md0 = await loadMapData(page.html, origin, slug, startUrl.href).catch(e => { throw new Error('Loading map data failed: ' + e.message); });
    if (!isMapData(md0)) throw new Error('Could not find window.mapData (with locations) for this page. Save the page and use --html, or use --mapdata with the console snippet.');
  }
  const html = page.html;
  const finalSegs = new URL(page.url).pathname.split('/').filter(Boolean);
  if (finalSegs[0]) slug = finalSegs[0];
  mapSlug = md0.map?.slug || mapSlug || 'map';

  // 2. every other map of the game
  const maps = [md0];
  if (!v.mapdata) {
    for (const m of md0.maps || []) {
      if (m.slug === mapSlug) continue;
      try {
        const p = await getPage(`${origin}/${slug}/maps/${m.slug}`);
        const md = await loadMapData(p.html, origin, slug, p.url);
        if (isMapData(md)) maps.push(md); else console.log(`  ! no mapData on map "${m.slug}"`);
      } catch (e) { console.log(`  ! could not load map "${m.slug}": ${e.message}`); }
    }
  }

  const game = extractVar(html, 'game') || {};
  const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1];
  const id = v.id || slug;
  const pageSlug = v.slug || id; // folder name under --out, and the page's URL
  const title = v.title || game.title || (ogTitle ? ogTitle.replace(/\s*(Interactive )?Map.*$/i, '').trim() : slug);
  const outDir = path.join(v.out, pageSlug);
  await mkdir(outDir, { recursive: true });
  console.log(`Game "${title}" (${slug}) -> ${outDir}, ${maps.length} map(s)`);

  const cats = maps.flatMap(m => Object.values(m.categories || {}));
  const tags = maps[0].tags || [];

  // 3. markers
  let sprite = null;
  if (!v['no-markers']) { sprite = await downloadMarkers({ html, slug, mediaBase: v['media-base'].replace(/\/$/, ''), outDir, cats }); }
  report(slug, maps, sprite);

  // 4. per map: data + tiles
  const tilesBases = [];
  if (v['tiles-base']) tilesBases.push(v['tiles-base'].replace(/\/$/, ''));
  const cdn = extractVar(html, 'tilesCdnUrl', x => typeof x === 'string');
  if (cdn) tilesBases.push(cdn.replace(/\/$/, '') + '/games', cdn.replace(/\/$/, ''));
  tilesBases.push('https://tiles.mapgenie.io/games');

  const metaMaps = [];
  const tileJobs = [];   // downloaded after the game is registered in meta.json and the manifest
  for (const md of maps) {
    const ms = md.map?.slug || 'map';
    const dir = path.join(outDir, ms);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'data.json'), JSON.stringify(md));
    const sets = [...(md.mapConfig.tile_sets || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const chosen = v['all-tilesets'] ? sets : sets.slice(0, 1);
    const entry = { slug: ms, title: md.map?.title || ms, data: `${ms}/data.json`, tilesets: [] };
    for (const ts of chosen) {
      const key = (ts.path || '').split('/').filter(Boolean).pop() || `ts${ts.id}`;
      const tail = ts.pattern.slice(ts.pattern.indexOf('{'));
      const localTail = `tiles/${key}/${tail}`;
      const info = { name: ts.name, template: `${ms}/${localTail}`, minzoom: ts.min_zoom ?? 0, maxzoom: ts.tiles_max_zoom ?? ts.max_zoom, viewMaxzoom: ts.max_zoom, bounds: boundsFor(md, ts).bounds, tileSize: 256 };
      if (opts.maxZoom != null) info.maxzoom = Math.min(info.maxzoom ?? 99, opts.maxZoom); // --max-zoom applies even when tiles are not fetched now
      entry.tilesets.push(info);
      if (!v['no-tiles']) tileJobs.push({ md, ts, ms, dir, localTail, info });
    }
    metaMaps.push(entry);
  }

  // 5. poster: --poster wins, then one already in the folder (hand-picked, kept), then the page's og:image
  let poster = null;
  const existingPoster = (await readdir(outDir)).find(f => /^poster\.(jpe?g|png|webp|avif)$/i.test(f));
  const posterSrc = v.poster || (existingPoster ? null : (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1]);
  try {
    if (posterSrc && /^https?:/.test(posterSrc)) {
      const r = await getBin(posterSrc);
      if (r.status === 200) { const ext = (r.type.split('/')[1] || 'jpg').split(';')[0].replace('jpeg', 'jpg'); poster = `poster.${ext}`; await writeFile(path.join(outDir, poster), r.buf); }
    } else if (posterSrc) {
      poster = 'poster' + path.extname(posterSrc).toLowerCase();
      if (path.resolve(posterSrc) !== path.resolve(outDir, poster)) await copyFile(posterSrc, path.join(outDir, poster));
    } else if (existingPoster) poster = existingPoster;
  } catch (e) { console.log('  ! poster failed:', e.message); }
  const posterFile = poster ? path.join(outDir, poster) : null;
  const variants = posterFile ? await posterVariants(posterFile, outDir, !!v.poster) : false;
  if (posterFile) console.log(`  poster: ${poster}${variants ? ' + poster-600.webp / poster-1200.webp' : ' (ImageMagick not found: no webp variants, the homepage will use the original file)'}`);

  // 7. meta.json for the game and the homepage manifest
  const meta = {
    id, title, slug, source: positionals[0], poster,
    tagLabel: v['tag-label'] || guessTagLabel(tags), defaultTag: v['default-tag'] || null,
    markers: sprite ? { json: sprite.json, png: sprite.png, json2x: sprite.json2x, png2x: sprite.png2x } : null,
    maps: metaMaps,
  };
  // tile zoom ranges are filled in as tiles arrive, so the file is rewritten after each tile set
  const writeMeta = () => writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  await writeMeta();

  // 8. the page itself: a copy of an existing game's index.html, pointed at this game
  const pageFile = path.join(outDir, 'index.html');
  if (!(await exists(pageFile))) {
    let template = null;
    for (const d of await readdir(v.out, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(v.out, d.name, 'index.html');
      if (d.isDirectory() && d.name !== pageSlug && await exists(f)) { template = f; break; }
    }
    if (template) {
      await writeFile(pageFile, (await readFile(template, 'utf8')).replace(/data-game="[^"]*"/, `data-game="${pageSlug}"`));
      console.log(`  page: ${pageFile} (copied from ${template})`);
    } else console.log(`  ! no existing game page to copy: create ${pageFile} by hand`);
  }

  // 9. homepage manifest. Hand-edited fields (title, description, theme, stats, poster...) are kept on re-runs.
  let index = { games: [] };
  if (await exists(v.index)) index = JSON.parse(await readFile(v.index, 'utf8'));
  const prev = index.games.find(g => g.slug === pageSlug) || {};
  // An explicit --poster or --accent replaces what is in the manifest; otherwise hand edits are kept.
  const posterAccent = posterFile && (v.poster || !prev.theme) && !v.accent ? await accentFromPoster(posterFile) : null;
  const accent = v.accent || posterAccent || vividHex(maps[0].groups?.[0]?.color) || '#d6453b';
  const newTheme = !prev.theme || v.accent || (v.poster && posterAccent);
  if (newTheme) console.log(`  theme: accent ${accent} (${v.accent ? '--accent' : posterAccent ? 'from the poster' : "from the game's first group colour"})`);
  const posterRef = !poster ? undefined : variants ? `${pageSlug}/poster` : `${pageSlug}/${poster}`;
  const entry = {
    id: prev.id || id, slug: pageSlug, title: prev.title || title,
    description: prev.description || `Every marker on the ${title} map.`,
    poster: (v.poster ? posterRef : prev.poster) || posterRef,
    posterAlt: prev.posterAlt, theme: newTheme ? deriveTheme(accent) : prev.theme,
    stats: [{ value: maps.reduce((n, m) => n + m.locations.length, 0), label: 'markers' }, { value: cats.length, label: 'categories' }],
    tagLabel: prev.tagLabel || meta.tagLabel, defaultTag: prev.defaultTag ?? meta.defaultTag,
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  const at = index.games.findIndex(g => g.slug === pageSlug);
  if (at >= 0) index.games[at] = entry; else index.games.push(entry);   // keep the homepage order stable
  await writeFile(v.index, JSON.stringify(index, null, 2) + '\n');
  console.log(`\nWrote ${path.join(outDir, 'meta.json')} and updated ${v.index}; the game is now listed, fetching tiles and media`);

  // 10. tiles, then media
  for (const { md, ts, ms, dir, localTail, info } of tileJobs) {
    console.log(`\nTiles for ${ms} / ${ts.name}`);
    const r = await downloadTiles({ md, ts, baseCandidates: tilesBases, destDir: dir, localTail, opts });
    info.minzoom = r.minzoom; info.maxzoom = r.maxzoom;
    if (opts.maxZoom != null) info.maxzoom = Math.min(info.maxzoom ?? 99, opts.maxZoom);
    await writeMeta();
  }

  const { urls, kinds, embedded } = collectMedia(maps, v.videos);
  console.log(`\nMedia: ${JSON.stringify(kinds)}${embedded ? `, ${embedded} images embedded in descriptions` : ''}; ${urls.size} file(s) to fetch${v.videos ? '' : ' (images only; use --videos for the rest)'}`);
  if (!v['no-media'] && urls.size) await downloadMedia(urls, path.join(outDir, 'media'), opts);
  console.log(`\nDone: ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
}
