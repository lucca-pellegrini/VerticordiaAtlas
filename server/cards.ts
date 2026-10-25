// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// cards.ts: the social preview cards and the tags that point at them.
// Used by make-cards.ts (the homepage and game cards, built ahead of time) and by server.ts (a card per shared
// marker, rendered on first request and cached).

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { esc, fmtEn as fmt } from "../src/shared/escape.ts";
import {
	deriveLightTheme,
	gameFavicon,
	gameThemeColor,
	glyphInk,
	hexToHsl,
	hslToHex,
} from "../src/shared/theme-math.ts";
import type {
	GameIconsMeta,
	GameManifestEntry,
	GameMarkersMeta,
	GameMeta,
	GameStat,
	MapMeta,
	ThemePalette,
} from "../src/shared/types.ts";

export { esc, hexToHsl, hslToHex, deriveLightTheme, gameThemeColor, gameFavicon };

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, ".."); // the project: site.json, data/, cache/
export const PUBLIC = path.join(REPO, "public"); // the web root: maps/, vendor/, card.jpg
const FONTS = path.join(HERE, "assets", "fonts");
export const exists = (p: string): Promise<boolean> =>
	access(p).then(
		() => true,
		() => false,
	);
const fileUrl = (p: string): string => pathToFileURL(p).href;

const DEFAULT_THEME: ThemePalette = {
	accent: "#d6453b",
	"accent-soft": "#f0877d",
	night: "#0b0e10",
	panel: "#12161a",
	line: "#252d33",
};
const PIN =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z"/><circle cx="12" cy="10" r="2.8" fill="var(--night)"/></svg>';

export interface LoadedGame {
	slug: string;
	dir: string;
	title: string;
	maps: MapMeta[];
	markers: GameMarkersMeta | null;
	icons: GameIconsMeta | null;
	description: string;
	alt: string;
	theme: ThemePalette;
	stats: GameStat[];
	poster: string | null;
}

export type CardIcon =
	| {
			image: string;
			x: number;
			y: number;
			size: number;
			color: string;
			ink: string;
			layers?: undefined;
			inner?: undefined;
	  }
	| {
			font: string;
			layers: { cp: string; tint: string; ml: string }[];
			color: string;
			ink: string;
			image?: undefined;
			inner?: undefined;
	  }
	| { glyph: string; color: string; ink: string; inner: string; image?: undefined; layers?: undefined };

/* ---------- what to draw ---------- */

const cleanTitle = (t: unknown): string =>
	String(t || "")
		.replace(/\s*\(WIP\)\s*$/i, "")
		.trim();

export async function findPoster(dir: string): Promise<string | null> {
	for (const name of ["poster-1200.webp", "poster-600.webp"]) {
		if (await exists(path.join(dir, name))) return path.join(dir, name);
	}
	const f = (await readdir(dir)).find((n) => /^poster\.(jpe?g|png|webp|avif)$/i.test(n));
	return f ? path.join(dir, f) : null;
}

// every game folder under maps/ (with a meta.json), plus the manifest's order for the homepage
export async function loadGames(): Promise<{ games: LoadedGame[]; shown: LoadedGame[] }> {
	const manifest: GameManifestEntry[] =
		JSON.parse(await readFile(path.join(PUBLIC, "maps", "index.json"), "utf8")).games || [];
	const listed = new Map<string, GameManifestEntry>(manifest.map((g) => [g.slug, g]));
	const games: LoadedGame[] = [];
	for (const d of await readdir(path.join(PUBLIC, "maps"), { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		const dir = path.join(PUBLIC, "maps", d.name);
		if (!(await exists(path.join(dir, "meta.json")))) continue;
		const meta: GameMeta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
		const entry: Partial<GameManifestEntry> = listed.get(d.name) || {};
		const title = cleanTitle(entry.title || meta.title || d.name);
		games.push({
			slug: d.name,
			dir,
			title,
			maps: meta.maps || [],
			markers: meta.markers || null,
			icons: meta.icons || null,
			description: entry.description || `Every marker on the ${title} map.`,
			alt: entry.posterAlt || `${title} key art`,
			theme: { ...DEFAULT_THEME, ...(entry.theme || {}) },
			stats: entry.stats || [],
			poster: await findPoster(dir),
		});
	}
	const shown = manifest.map((e) => games.find((g) => g.slug === e.slug)).filter((g): g is LoadedGame => Boolean(g));
	return { games, shown };
}

/* ---------- the card markup: one page per card, drawn in headless Chromium ---------- */

export function page(body: string, theme: ThemePalette, extraCss = ""): string {
	const face = (family: string, file: string, weight: number | string) =>
		`@font-face { font-family: "${family}"; src: url("${fileUrl(path.join(FONTS, file))}") format("woff2"); font-weight: ${weight}; font-style: normal; font-display: block; }`;
	const vars = Object.entries(theme)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `--${k}: ${v};`)
		.join(" ");
	return `<!doctype html><html><head><meta charset="utf-8"><style>
${face("Instrument Sans", "instrument-sans-latin-variable.woff2", "400 700")}
${face("Instrument Serif", "instrument-serif-latin-400-normal.woff2", 400)}
:root { ${vars} --ink: #eef1f3; --ink-dim: #9aa6ad; }
* { box-sizing: border-box; }
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: var(--night); color: var(--ink);
  font-family: "Instrument Sans"; -webkit-font-smoothing: antialiased; }
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
  background: rgb(255 255 255 / .03); font: 600 18px/1 "Instrument Sans"; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-dim); }
.eyebrow::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
.eyebrow span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
h1 { margin: 0; font: 400 104px/0.98 "Instrument Serif"; letter-spacing: -0.01em; text-wrap: balance; }
h1.long { font-size: 84px; }
h1.xlong { font-size: 68px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.lede { margin: 28px 0 0; max-width: 520px; font: 400 25px/1.42 "Instrument Sans"; color: var(--ink-dim);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.stats { list-style: none; margin: 30px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
.stats li { padding: 8px 16px; border: 1px solid var(--line); border-radius: 999px; font: 400 20px/1 "Instrument Sans"; color: var(--ink-dim); }
.stats b { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
footer { position: absolute; left: 72px; bottom: 46px; width: 540px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 600 18px/1 "Instrument Sans"; letter-spacing: .02em; color: var(--ink-dim); }
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

function posterDiv(poster: string | null | undefined): string {
	return poster ? `<div class="poster" style="background-image: url('${fileUrl(poster)}')"></div>` : "";
}

export function gameHtml(g: LoadedGame): string {
	const stats = g.stats.map((s) => `<li><b>${fmt(s.value)}</b> ${esc(s.label)}</li>`).join("");
	return page(
		`${posterDiv(g.poster)}
<header class="brand">${PIN}<span>Verticordia Atlas</span></header>
<main class="copy">
  <h1 class="${g.title.length > 20 ? "long" : ""}">${esc(g.title)}</h1>
  <p class="lede">${esc(g.description)}</p>
  ${stats ? `<ul class="stats">${stats}</ul>` : ""}
</main>
<footer>Works offline · Your progress stays in your browser</footer>`,
		g.theme,
	);
}

// a card for one marker: its category as the eyebrow, its name, a line of its notes, the game underneath
// the Lucide icon's markup, read once (the library is the same file the page fetches)
let lucide: Record<string, [string, string[]]> | null = null;
export async function glyphInner(name: string): Promise<string | null> {
	if (!lucide) lucide = JSON.parse(await readFile(path.join(PUBLIC, "vendor", "lucide", "icons.json"), "utf8"));
	return lucide![name]?.[0] ?? null;
}
// an official category's icon: the game's own icon-font glyph (add-game.ts keeps the glyph map in meta.json), in the ink
// that reads on its group's colour, as the sidebar draws it. Black or white layers take that ink; coloured ones keep theirs.
const HEX = /^#[0-9a-f]{3,8}$/i,
	EM = /^-?\d+(\.\d+)?(em|px)$/,
	CODEPOINT = /^[0-9a-f]{1,6}$/i;
const BLACK_OR_WHITE = new Set(["#000", "#000000", "#fff", "#ffffff"]);
export function officialIcon(
	game: { dir: string; icons?: GameIconsMeta | null },
	iconName: string,
	color?: string | null,
): CardIcon | null {
	const icons = game.icons;
	const raw = icons?.glyphs?.[iconName];
	if (raw === undefined || !color || !HEX.test(color)) return null;
	const ink = glyphInk(color);
	if (icons?.image) {
		const x = typeof raw === "number" ? 0 : Number(raw?.x) || 0;
		const y = typeof raw === "number" ? raw : Number(raw?.y) || 0;
		const size = Number(icons.size) || 18;
		return { image: path.join(game.dir, icons.image), x, y, size, color, ink };
	}
	if (!icons?.font) return null;
	const layers = (Array.isArray(raw) ? raw : [raw])
		.map((l: any) => {
			const layer = typeof l === "string" ? { cp: l } : l || {};
			const cp = String(layer.cp ?? "").toLowerCase();
			if (!CODEPOINT.test(cp)) return null;
			const tint =
				HEX.test(layer.color || "") && !BLACK_OR_WHITE.has(layer.color.toLowerCase()) ? layer.color : ink;
			return { cp, tint, ml: EM.test(layer.ml || "") ? layer.ml : "" };
		})
		.filter((x): x is { cp: string; tint: string; ml: string } => Boolean(x));
	if (!layers.length) return null;
	return { font: path.join(game.dir, icons.font), layers, color, ink };
}

// a category's icon for a card: its colour, the glyph's contrasting ink, and the markup (or null when unknown)
export async function categoryIcon({
	glyph,
	color,
}: {
	glyph?: string | null;
	color?: string | null;
}): Promise<CardIcon | null> {
	if (!glyph || !color) return null;
	const inner = await glyphInner(glyph);
	return inner ? { glyph, color, ink: glyphInk(color), inner } : null;
}

// the icon's graphic inside its disc: the game's icon-font glyph, image sprite, or a library glyph
function iconGraphic(icon: CardIcon): string {
	if (icon.image) {
		const scale = 58 / icon.size;
		const m = `url('${fileUrl(icon.image)}') -${Math.round(icon.x * scale)}px -${Math.round(icon.y * scale)}px / 58px auto no-repeat`;
		return `<span class="gi-img" style="width:58px;height:58px;display:block;background:var(--g);-webkit-mask:${m};mask:${m}"></span>`;
	}
	if (icon.layers) {
		return `<span class="gi">${icon.layers.map((l) => `<span style="color:${l.tint}${l.ml ? `;margin-left:${l.ml}` : ""}">&#x${l.cp};</span>`).join("")}</span>`;
	}
	return `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.inner}</svg>`;
}

export interface MarkerCardInfo {
	title: string;
	category: string;
	description: string;
	gameTitle: string;
	theme: ThemePalette;
	poster?: string | null;
	shot?: string | null;
	icon?: CardIcon | null;
	gameSlug?: string;
	mapSlug?: string;
	id?: number;
}

// a card for one marker. With a category icon, the icon is shown large beside the category's name.
export function markerHtml({
	title,
	category,
	description,
	gameTitle,
	theme,
	poster,
	shot,
	icon,
}: MarkerCardInfo): string {
	// the size steps down early: a title over two lines pushes the copy into the brand row (the copy is anchored below it)
	const size = title.length > 60 ? "xlong" : title.length > 18 ? "long" : "";
	const picture = shot ? `<img class="shot" src="${fileUrl(shot)}" alt="">` : "";
	const head =
		icon && category
			? `<div class="cat-row"><span class="cat-disc" style="--c:${icon.color};--g:${icon.ink}">${iconGraphic(icon)}</span><span class="cat-name">${esc(category)}</span></div>`
			: category
				? `<p class="eyebrow"><span>${esc(category)}</span></p>`
				: "";
	const fontFace = icon?.layers
		? `@font-face { font-family: "CardIcon"; src: url("${fileUrl(icon.font)}") format("woff"); }\n`
		: "";
	const css =
		fontFace +
		(picture
			? `.shot { position: absolute; right: 64px; top: 50%; transform: translateY(-50%); max-width: 500px; max-height: 430px;
    border-radius: 18px; border: 1px solid rgb(255 255 255 / .14); box-shadow: 0 34px 60px -22px #000; object-fit: contain; }`
			: "") +
		`.cat-row { display: flex; align-items: center; gap: 22px; margin: 0 0 30px; }
    .cat-disc { flex: none; width: 104px; height: 104px; border-radius: 50%; display: grid; place-items: center; background: var(--c); color: var(--g);
      box-shadow: 0 0 0 5px rgb(255 255 255 / .12), 0 20px 44px -14px var(--c); }
    .cat-disc { position: relative; overflow: hidden; }
    .cat-disc svg { width: 58px; height: 58px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
    .cat-disc .gi { display: flex; align-items: center; font: 400 58px/1 "CardIcon"; color: var(--g); }
    .copy { top: 124px; transform: none; }
    .copy .lede { ${icon && size ? "-webkit-line-clamp: 2;" : ""} }
    .cat-name { font: 700 30px/1.15 "Instrument Sans"; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; }`;
	return page(
		`${posterDiv(poster)}
${picture}
<header class="brand">${PIN}<span>Verticordia Atlas</span></header>
<main class="copy">
  ${head}
  <h1 class="${size}">${esc(title)}</h1>
  ${description ? `<p class="lede">${esc(description)}</p>` : ""}
</main>
<footer>${esc(gameTitle)}</footer>`,
		theme,
		css,
	);
}

// the homepage card: three posters picked at random from the games that have one, fanned on the right
export function homeHtml(games: LoadedGame[]): string {
	const pool = games.filter((g) => g.poster);
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	const cards = pool
		.slice(0, 3)
		.map((g, i) => {
			const left = 650 + (i % 2) * 130,
				top = 66 + i * 176,
				rot = (i - 1) * -5;
			return `<div class="fan" style="left:${left}px; top:${top}px; transform: rotate(${rot}deg); background-image: url('${fileUrl(g.poster!)}'); --accent: ${g.theme.accent}"></div>`;
		})
		.join("\n");
	const css = `
.fan { position: absolute; width: 340px; height: 170px; border-radius: 18px; overflow: hidden; background-size: cover; background-position: center;
  border: 1px solid rgb(255 255 255 / .12); box-shadow: 0 34px 60px -24px #000, 0 0 0 1px rgb(0 0 0 / .4); }
.fan::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--accent); }
h1 { font-size: 104px; }
.copy { top: 128px; transform: none; }`;
	return page(
		`${cards}
<header class="brand">${PIN}<span>Verticordia Atlas</span></header>
<main class="copy">
  <h1>Every secret, <em style="color: var(--accent-soft); font-style: italic">mapped</em>.</h1>
  <p class="lede">Pick a game, track what you have found across playthroughs, and keep going without a connection.</p>
</main>
<footer>Your progress never leaves your browser</footer>`,
		DEFAULT_THEME,
		css,
	);
}

/* ---------- drawing ---------- */

export async function chromePath(): Promise<string> {
	if (process.env.CHROME) return process.env.CHROME;
	for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]) {
		try {
			await execFileP("which", [bin]);
			return bin;
		} catch {}
	}
	throw new Error("No Chromium found. Install it, or set CHROME=/path/to/chromium.");
}

// draws html as a 1200x630 JPG at `out`
export async function drawCard(chrome: string, html: string, out: string): Promise<void> {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "card-"));
	try {
		const file = path.join(tmp, "card.html"),
			png = path.join(tmp, "card.png");
		await writeFile(file, html);
		await execFileP(
			chrome,
			[
				"--headless=new",
				"--no-sandbox",
				"--disable-gpu",
				"--hide-scrollbars",
				"--allow-file-access-from-files",
				"--window-size=1200,630",
				"--force-device-scale-factor=1",
				"--virtual-time-budget=3000",
				`--screenshot=${png}`,
				fileUrl(file),
			],
			{ timeout: 90000 },
		);
		await mkdir(path.dirname(out), { recursive: true });
		await execFileP("magick", [png, "-strip", "-quality", "88", out]);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

/* ---------- tags ---------- */

export interface SocialTagsInput {
	title: string;
	description: string;
	url: string;
	image: string;
	alt: string;
	type?: string;
}

export function socialTags({ title, description, url, image, alt, type = "website" }: SocialTagsInput): string {
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
		`<meta name="twitter:title" content="${esc(title)}">',`.slice(0, -2),
		`<meta name="twitter:description" content="${esc(description)}">`,
		`<meta name="twitter:image" content="${esc(image)}">`,
		`<meta name="twitter:image:alt" content="${esc(alt)}">`,
	].join("\n");
}

// the page's HTML with its social block replaced (or added before </head>), and optionally its <title>
export function withHead(html: string, block: string, pageTitle?: string | null): string {
	const wrapped = `<!-- social:start (make-cards.mjs) -->\n${block}\n<!-- social:end -->`;
	const re = /<!-- social:start[\s\S]*?<!-- social:end -->/;
	let out = re.test(html) ? html.replace(re, () => wrapped) : html.replace("</head>", () => `${wrapped}\n</head>`);
	if (pageTitle) out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(pageTitle)}</title>`);
	return out;
}

// marker notes (markdown) as one short plain line for a card or a preview
export function plainText(md: unknown, max = 160): string {
	let t = String(md || "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#>]+/g, "")
		.replace(/^\s*[-*]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + "…";
	return t;
}