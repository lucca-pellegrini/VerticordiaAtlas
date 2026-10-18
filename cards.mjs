// cards.mjs: the social preview cards and the tags that point at them.
// Used by make-cards.mjs (the homepage and game cards, built ahead of time) and by server.mjs (a card per shared
// marker, rendered on first request and cached).

import { readdir, readFile, writeFile, access, mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glyphInk } from './icons-lib.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.join(ROOT, 'cards', 'fonts');
export const exists = p => access(p).then(() => true, () => false);
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => Number(n).toLocaleString('en-US');
const fileUrl = p => pathToFileURL(p).href;

const DEFAULT_THEME = { accent: '#d6453b', 'accent-soft': '#f0877d', night: '#0b0e10', panel: '#12161a', line: '#252d33' };
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z"/><circle cx="12" cy="10" r="2.8" fill="var(--night)"/></svg>';

/* ---------- what to draw ---------- */

const cleanTitle = t => String(t || '').replace(/\s*\(WIP\)\s*$/i, '').trim();

export async function findPoster(dir) {
  for (const name of ['poster-1200.webp', 'poster-600.webp']) {
    if (await exists(path.join(dir, name))) return path.join(dir, name);
  }
  const f = (await readdir(dir)).find(n => /^poster\.(jpe?g|png|webp|avif)$/i.test(n));
  return f ? path.join(dir, f) : null;
}

// every game folder under maps/ (with a meta.json), plus the manifest's order for the homepage
export async function loadGames() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'maps', 'index.json'), 'utf8')).games || [];
  const listed = new Map(manifest.map(g => [g.slug, g]));
  const games = [];
  for (const d of await readdir(path.join(ROOT, 'maps'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ROOT, 'maps', d.name);
    if (!await exists(path.join(dir, 'meta.json'))) continue;
    const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
    const entry = listed.get(d.name) || {};
    const title = cleanTitle(entry.title || meta.title || d.name);
    games.push({
      slug: d.name, dir, title, maps: meta.maps || [], markers: meta.markers || null,
      description: entry.description || `Every marker on the ${title} map.`,
      alt: entry.posterAlt || `${title} key art`,
      theme: { ...DEFAULT_THEME, ...(entry.theme || {}) },
      stats: entry.stats || [],
      poster: await findPoster(dir),
    });
  }
  const shown = manifest.map(e => games.find(g => g.slug === e.slug)).filter(Boolean);
  return { games, shown };
}

/* ---------- the card markup: one page per card, drawn in headless Chromium ---------- */

export function page(body, theme, extraCss = '') {
  const face = (family, file, weight) => `@font-face { font-family: "${family}"; src: url("${fileUrl(path.join(FONTS, file))}") format("woff2"); font-weight: ${weight}; font-style: normal; font-display: block; }`;
  const vars = Object.entries(theme).map(([k, v]) => `--${k}: ${v};`).join(' ');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${face('Inter', 'inter-latin-400-normal.woff2', 400)}
${face('Inter', 'inter-latin-600-normal.woff2', 600)}
${face('Inter', 'inter-latin-700-normal.woff2', 700)}
${face('Inter', 'inter-latin-800-normal.woff2', 800)}
${face('Instrument Serif', 'instrument-serif-latin-400-normal.woff2', 400)}
:root { ${vars} --ink: #eef1f3; --ink-dim: #9aa6ad; }
* { box-sizing: border-box; }
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: var(--night); color: var(--ink);
  font-family: Inter; -webkit-font-smoothing: antialiased; }
.bg { position: absolute; inset: 0;
  background:
    radial-gradient(900px 560px at 14% -12%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 70%),
    radial-gradient(760px 520px at 100% 108%, color-mix(in srgb, var(--accent-soft) 14%, transparent), transparent 70%),
    var(--night); }
.bg::after { content: ""; position: absolute; inset: 0; opacity: .4;
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 56px 56px; -webkit-mask-image: radial-gradient(ellipse 80% 75% at 30% 0%, #000, transparent 78%); mask-image: radial-gradient(ellipse 80% 75% at 30% 0%, #000, transparent 78%); }
.accent { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
.brand { position: absolute; left: 72px; top: 58px; display: flex; align-items: center; gap: 14px; color: var(--accent); }
.brand svg { width: 40px; height: 40px; }
.brand span { font: 400 34px/1 "Instrument Serif"; color: var(--ink); }
.copy { position: absolute; left: 72px; top: 50%; transform: translateY(-50%); width: 540px; }
.eyebrow { display: flex; width: fit-content; max-width: 100%; align-items: center; gap: 12px; margin: 0 0 26px; padding: 8px 16px; border: 1px solid var(--line); border-radius: 999px;
  background: rgb(255 255 255 / .03); font: 600 18px/1 Inter; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-dim); }
.eyebrow::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
.eyebrow span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
h1 { margin: 0; font: 400 104px/0.98 "Instrument Serif"; letter-spacing: -0.01em; text-wrap: balance; }
h1.long { font-size: 84px; }
h1.xlong { font-size: 68px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.lede { margin: 28px 0 0; max-width: 520px; font: 400 25px/1.42 Inter; color: var(--ink-dim);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.stats { list-style: none; margin: 30px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
.stats li { padding: 8px 16px; border: 1px solid var(--line); border-radius: 999px; font: 400 20px/1 Inter; color: var(--ink-dim); }
.stats b { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
footer { position: absolute; left: 72px; bottom: 46px; width: 540px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 600 18px/1 Inter; letter-spacing: .02em; color: var(--ink-dim); }
.poster { position: absolute; top: 0; right: 0; bottom: 0; width: 660px; background-size: cover; background-position: 80% center;
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 62%); mask-image: linear-gradient(to right, transparent 0, #000 62%); }
.poster::before { content: ""; position: absolute; inset: 0; background: linear-gradient(to right, var(--night) 0%, transparent 55%); }
.poster::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, var(--night) 0%, transparent 40%); }
${extraCss}
</style></head><body>
<div class="bg"></div>
${body}
<div class="accent"></div>
</body></html>`;
}

function posterDiv(poster) {
  return poster ? `<div class="poster" style="background-image: url('${fileUrl(poster)}')"></div>` : '';
}

export function gameHtml(g) {
  const stats = g.stats.map(s => `<li><b>${fmt(s.value)}</b> ${esc(s.label)}</li>`).join('');
  return page(`${posterDiv(g.poster)}
<header class="brand">${PIN}<span>Verticordia Atlas</span></header>
<main class="copy">
  <h1 class="${g.title.length > 20 ? 'long' : ''}">${esc(g.title)}</h1>
  <p class="lede">${esc(g.description)}</p>
  ${stats ? `<ul class="stats">${stats}</ul>` : ''}
</main>
<footer>Works offline · Your progress stays in your browser</footer>`, g.theme);
}

// a card for one marker: its category as the eyebrow, its name, a line of its notes, the game underneath
// the Lucide icon's markup, read once (the library is the same file the page fetches)
let lucide = null;
export async function glyphInner(name) {
  if (!lucide) lucide = JSON.parse(await readFile(path.join(ROOT, 'vendor', 'lucide', 'icons.json'), 'utf8'));
  return lucide[name]?.[0] ?? null;
}
// the game's own marker sprite (the same file the map uses): its definitions and sheet, read once
const sheetCache = new Map();
export async function spriteSheet(gameDir, markers) {
  if (!markers) return null;
  const pick = markers.json2x && markers.png2x ? { json: markers.json2x, png: markers.png2x } : { json: markers.json, png: markers.png };
  const jsonPath = path.join(gameDir, pick.json);
  if (!sheetCache.has(jsonPath)) {
    sheetCache.set(jsonPath, readFile(jsonPath, 'utf8').then(t => ({ defs: JSON.parse(t), png: path.join(gameDir, pick.png) })));
  }
  return sheetCache.get(jsonPath);
}
// an official category's icon: its sprite cut-out, on a disc of its group's colour
export async function officialIcon(game, iconName, color) {
  const sheet = await spriteSheet(game.dir, game.markers);
  const d = sheet?.defs?.[iconName];
  if (!d || !color) return null;
  return { sprite: { file: sheet.png, x: d.x, y: d.y, w: d.width, h: d.height }, color, ink: '#ffffff' };
}

// a category's icon for a card: its colour, the glyph's contrasting ink, and the markup (or null when unknown)
export async function categoryIcon({ glyph, color }) {
  if (!glyph || !color) return null;
  const inner = await glyphInner(glyph);
  return inner ? { glyph, color, ink: glyphInk(color), inner } : null;
}

// the icon's graphic inside its disc: a library glyph, or a cut-out of the game's sprite sheet scaled up
function iconGraphic(icon) {
  if (icon.sprite) {
    const n = v => (Number.isFinite(+v) ? +v : 0); // numbers only: these go into a style attribute
    const file = icon.sprite.file, x = n(icon.sprite.x), y = n(icon.sprite.y), w = n(icon.sprite.w), h = n(icon.sprite.h);
    const s = 100 / Math.max(h, w, 1); // the sprite cut-outs have padding: scale past the disc so the glyph reads
    return `<span class="spr" style="width:${w}px;height:${h}px;background-image:url('${fileUrl(file)}');background-position:-${x}px -${y}px;transform:translate(-50%,-50%) scale(${s})"></span>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.inner}</svg>`;
}

// a card for one marker. With a category icon, the icon is shown large beside the category's name.
export function markerHtml({ title, category, description, gameTitle, theme, poster, shot, icon }) {
  const size = title.length > 60 ? 'xlong' : title.length > 26 ? 'long' : '';
  const picture = shot ? `<img class="shot" src="${fileUrl(shot)}" alt="">` : '';
  const head = icon && category
    ? `<div class="cat-row"><span class="cat-disc" style="--c:${icon.color};--g:${icon.ink}">${iconGraphic(icon)}</span><span class="cat-name">${esc(category)}</span></div>`
    : (category ? `<p class="eyebrow"><span>${esc(category)}</span></p>` : '');
  const css = (picture ? `.shot { position: absolute; right: 64px; top: 50%; transform: translateY(-50%); max-width: 500px; max-height: 430px;
    border-radius: 18px; border: 1px solid rgb(255 255 255 / .14); box-shadow: 0 34px 60px -22px #000; object-fit: contain; }` : '') +
    `.cat-row { display: flex; align-items: center; gap: 22px; margin: 0 0 30px; }
    .cat-disc { flex: none; width: 104px; height: 104px; border-radius: 50%; display: grid; place-items: center; background: var(--c); color: var(--g);
      box-shadow: 0 0 0 5px rgb(255 255 255 / .12), 0 20px 44px -14px var(--c); }
    .cat-disc { position: relative; overflow: hidden; }
    .cat-disc svg { width: 58px; height: 58px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
    .cat-disc .spr { position: absolute; left: 50%; top: 50%; image-rendering: auto; }
    .cat-name { font: 700 30px/1.15 Inter; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; }`;
  return page(`${posterDiv(poster)}
${picture}
<header class="brand">${PIN}<span>Verticordia Atlas</span></header>
<main class="copy">
  ${head}
  <h1 class="${size}">${esc(title)}</h1>
  ${description ? `<p class="lede">${esc(description)}</p>` : ''}
</main>
<footer>${esc(gameTitle)}</footer>`, theme, css);
}

// the homepage card: three posters picked at random from the games that have one, fanned on the right
export function homeHtml(games) {
  const pool = games.filter(g => g.poster);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const cards = pool.slice(0, 3).map((g, i) => {
    const left = 650 + (i % 2) * 130, top = 66 + i * 176, rot = (i - 1) * -5;
    return `<div class="fan" style="left:${left}px; top:${top}px; transform: rotate(${rot}deg); background-image: url('${fileUrl(g.poster)}'); --accent: ${g.theme.accent}"></div>`;
  }).join('\n');
  const css = `
.fan { position: absolute; width: 340px; height: 170px; border-radius: 18px; overflow: hidden; background-size: cover; background-position: center;
  border: 1px solid rgb(255 255 255 / .12); box-shadow: 0 34px 60px -24px #000, 0 0 0 1px rgb(0 0 0 / .4); }
.fan::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--accent); }
h1 { font-size: 104px; }
.copy { top: 128px; transform: none; }`;
  return page(`${cards}
<header class="brand">${PIN}<span>Verticordia Atlas</span></header>
<main class="copy">
  <h1>Every secret, <em style="color: var(--accent-soft); font-style: italic">mapped</em>.</h1>
  <p class="lede">Pick a game, track what you have found across playthroughs, and keep going without a connection.</p>
</main>
<footer>Your progress never leaves your browser</footer>`, DEFAULT_THEME, css);
}

/* ---------- drawing ---------- */

export async function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    try { await execFileP('which', [bin]); return bin; } catch {}
  }
  throw new Error('No Chromium found. Install it, or set CHROME=/path/to/chromium.');
}

// draws html as a 1200x630 JPG at `out`
export async function drawCard(chrome, html, out) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'card-'));
  try {
    const file = path.join(tmp, 'card.html'), png = path.join(tmp, 'card.png');
    await writeFile(file, html);
    await execFileP(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
      '--window-size=1200,630', '--force-device-scale-factor=1', '--virtual-time-budget=3000',
      `--screenshot=${png}`, fileUrl(file),
    ], { timeout: 90000 });
    await mkdir(path.dirname(out), { recursive: true });
    await execFileP('magick', [png, '-strip', '-quality', '88', out]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/* ---------- tags ---------- */

export function socialTags({ title, description, url, image, alt, type = 'website' }) {
  return [
    `<meta property="og:type" content="${type}">`,
    '<meta property="og:site_name" content="Verticordia Atlas">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${esc(alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<meta name="twitter:image:alt" content="${esc(alt)}">`,
  ].join('\n');
}

// the page's HTML with its social block replaced (or added before </head>), and optionally its <title>
export function withHead(html, block, pageTitle) {
  const wrapped = `<!-- social:start (make-cards.mjs) -->\n${block}\n<!-- social:end -->`;
  const re = /<!-- social:start[\s\S]*?<!-- social:end -->/;
  let out = re.test(html) ? html.replace(re, () => wrapped) : html.replace('</head>', () => `${wrapped}\n</head>`);
  if (pageTitle) out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(pageTitle)}</title>`);
  return out;
}

// marker notes (markdown) as one short plain line for a card or a preview
export function plainText(md, max = 160) {
  let t = String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t;
}
