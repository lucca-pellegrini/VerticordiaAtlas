#!/usr/bin/env node
// make-cards.mjs: social preview cards, and the Open Graph / Twitter tags that point at them.
//
//   node make-cards.mjs
//
// Renders card.jpg (1200x630) for the homepage and for every map folder under maps/, from the same colours,
// posters and text the site uses, then writes the matching <meta> tags into the <head> of each page between
// <!-- social:start --> and <!-- social:end -->. Run it again after adding a game or changing a description.
//
// Needs: Chromium or Chrome (on PATH, or CHROME=/path/to/binary) to draw the cards, and ImageMagick (magick)
// to save them as JPG. The domain comes from site.json: crawlers need absolute URLs, so that is the one
// place to set it. The fonts the cards use are vendored in cards/fonts, so the output does not depend on
// what is installed on the machine.

import { readdir, readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.join(ROOT, 'cards', 'fonts');
const exists = p => access(p).then(() => true, () => false);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => Number(n).toLocaleString('en-US');
const fileUrl = p => pathToFileURL(p).href;

const DEFAULT_THEME = { accent: '#d6453b', 'accent-soft': '#f0877d', night: '#0b0e10', panel: '#12161a', line: '#252d33' };
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z"/><circle cx="12" cy="10" r="2.8" fill="var(--night)"/></svg>';

/* ---------- finding what to draw ---------- */

const cleanTitle = t => String(t || '').replace(/\s*\(WIP\)\s*$/i, '').trim();

async function findPoster(dir) {
  for (const name of ['poster-1200.webp', 'poster-600.webp']) {
    if (await exists(path.join(dir, name))) return path.join(dir, name);
  }
  const f = (await readdir(dir)).find(n => /^poster\.(jpe?g|png|webp|avif)$/i.test(n));
  return f ? path.join(dir, f) : null;
}

async function loadGames() {
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
      slug: d.name, dir, title,
      description: entry.description || `Every marker on the ${title} map.`,
      alt: entry.posterAlt || `${title} key art`,
      theme: { ...DEFAULT_THEME, ...(entry.theme || {}) },
      stats: entry.stats || [],
      poster: await findPoster(dir),
    });
  }
  // the homepage shows the manifest's games, in its order
  const shown = manifest.map(e => games.find(g => g.slug === e.slug)).filter(Boolean);
  return { games, shown };
}

/* ---------- the card markup: one page per card, drawn in headless Chromium ---------- */

function page(body, theme, extraCss = '') {
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
  font-family: Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
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
.brand span { font: 400 34px/1 "Instrument Serif", serif; color: var(--ink); }
.copy { position: absolute; left: 72px; top: 50%; transform: translateY(-50%); width: 540px; }
.eyebrow { display: inline-flex; align-items: center; gap: 12px; margin: 0 0 26px; padding: 8px 16px; border: 1px solid var(--line); border-radius: 999px;
  background: rgb(255 255 255 / .03); font: 600 18px/1 Inter; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-dim); }
.eyebrow::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
h1 { margin: 0; font: 400 104px/0.98 "Instrument Serif", serif; letter-spacing: -0.01em; text-wrap: balance; }
h1.long { font-size: 84px; }
.lede { margin: 28px 0 0; max-width: 520px; font: 400 25px/1.42 Inter; color: var(--ink-dim);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.stats { list-style: none; margin: 30px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
.stats li { padding: 8px 16px; border: 1px solid var(--line); border-radius: 999px; font: 400 20px/1 Inter; color: var(--ink-dim); }
.stats b { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
footer { position: absolute; left: 72px; bottom: 46px; font: 600 18px/1 Inter; letter-spacing: .02em; color: var(--ink-dim); }
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

function gameHtml(g) {
  const stats = g.stats.map(s => `<li><b>${fmt(s.value)}</b> ${esc(s.label)}</li>`).join('');
  const poster = g.poster ? `<div class="poster" style="background-image: url('${fileUrl(g.poster)}')"></div>` : '';
  return page(`${poster}
<header class="brand">${PIN}<span>Verticordia Atlas</span></header>
<main class="copy">
  <p class="eyebrow">Interactive game map</p>
  <h1 class="${g.title.length > 20 ? 'long' : ''}">${esc(g.title)}</h1>
  <p class="lede">${esc(g.description)}</p>
  ${stats ? `<ul class="stats">${stats}</ul>` : ''}
</main>
<footer>Works offline · Your progress stays in your browser</footer>`, g.theme);
}

function homeHtml(shown) {
  // up to three posters, fanned on the right; the first one is the most prominent
  const cards = shown.filter(g => g.poster).slice(0, 3).map((g, i) => {
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
  <p class="eyebrow">Interactive game maps</p>
  <h1>Every secret, <em style="color: var(--accent-soft); font-style: italic">mapped</em>.</h1>
  <p class="lede">Pick a game, track what you have found across playthroughs, and keep going without a connection.</p>
</main>
<footer>Your progress never leaves your browser</footer>`, DEFAULT_THEME, css);
}

/* ---------- drawing ---------- */

async function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    try { await execFileP('which', [bin]); return bin; } catch {}
  }
  throw new Error('No Chromium found. Install it, or set CHROME=/path/to/chromium.');
}

async function drawCard(chrome, html, out) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'card-'));
  try {
    const file = path.join(tmp, 'card.html'), png = path.join(tmp, 'card.png');
    await writeFile(file, html);
    await execFileP(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
      '--window-size=1200,630', '--force-device-scale-factor=1', '--virtual-time-budget=3000',
      `--screenshot=${png}`, fileUrl(file),
    ], { timeout: 90000 });
    await execFileP('magick', [png, '-strip', '-quality', '88', out]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/* ---------- the tags ---------- */

function socialTags({ title, description, url, image, alt, type = 'website' }) {
  return [
    `<meta property="og:type" content="${type}">`,
    '<meta property="og:site_name" content="Verticordia Atlas">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${image}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${esc(alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    `<meta name="twitter:image:alt" content="${esc(alt)}">`,
  ].join('\n');
}

async function setHead(file, block, pageTitle) {
  let html = await readFile(file, 'utf8');
  const wrapped = `<!-- social:start (make-cards.mjs) -->\n${block}\n<!-- social:end -->`;
  const re = /<!-- social:start[\s\S]*?<!-- social:end -->/;
  html = re.test(html) ? html.replace(re, () => wrapped) : html.replace('</head>', () => `${wrapped}\n</head>`);
  if (pageTitle) html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(pageTitle)}</title>`);
  await writeFile(file, html);
}

/* ---------- main ---------- */

const configured = process.env.SITE_URL || JSON.parse(await readFile(path.join(ROOT, 'site.json'), 'utf8')).url || '';
const site = configured.replace(/\/+$/, '');
if (!/^https:\/\/[^/]+/.test(site)) throw new Error('site.json needs an https "url" (or set SITE_URL). Crawlers need absolute URLs.');
if (site.includes('YOUR-DOMAIN')) console.warn('warning: site.json still has the placeholder domain; the tags will point at it until you set the real one.');
const chrome = await chromePath();
const { games, shown } = await loadGames();

// homepage
const homeDesc = 'Interactive game maps that work offline. Track every collectible across playthroughs, right in your browser.';
await drawCard(chrome, homeHtml(shown), path.join(ROOT, 'card.jpg'));
await setHead(path.join(ROOT, 'index.html'), socialTags({
  title: 'Verticordia Atlas · Interactive game maps', description: homeDesc,
  url: `${site}/`, image: `${site}/card.jpg`, alt: 'Verticordia Atlas: interactive game maps that work offline',
}));
console.log('homepage: card.jpg');

// one card per game folder
for (const g of games) {
  const slug = encodeURI(g.slug);
  await drawCard(chrome, gameHtml(g), path.join(g.dir, 'card.jpg'));
  await setHead(path.join(g.dir, 'index.html'), socialTags({
    title: `${g.title} · Verticordia Atlas`, description: g.description,
    url: `${site}/maps/${slug}/`, image: `${site}/maps/${slug}/card.jpg`, alt: g.alt,
  }), `${g.title} · Verticordia Atlas`);
  console.log(`${g.slug}: card.jpg${g.poster ? '' : ' (no poster found, plain card)'}`);
}
