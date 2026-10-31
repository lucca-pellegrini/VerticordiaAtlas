#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// make-cards.ts: social preview cards for the homepage and every game, and the tags that point at them.
//
//   bun scripts/make-cards.ts [--only <slug1,slug2>] [--no-tui]
//
// Writes card.jpg (1200x630) for the homepage (three random games' posters) and maps/<game>/card.jpg for each
// game folder, then sets the <head> of index.html (between social:start / social:end). Game map pages are rendered dynamically.
// Run again after adding a game or changing a description; add-game.ts runs it for you.
//
// Needs Chromium (on PATH, or CHROME=/path/to/chromium) and ImageMagick (magick). The domain comes from
// site.json (or SITE_URL): crawlers need absolute URLs. Per-marker share cards are made by the server (server/server.ts) instead.

import path from "node:path";
import { parseArgs } from "node:util";

import {
	chromePath,
	drawCard,
	gameHtml,
	homeHtml,
	loadGames,
	PUBLIC,
	REPO,
	socialTags,
	withHead,
} from "../server/cards.ts";
import { createCardsDashboard } from "./tui/cards-dashboard.ts";

const { values: v } = parseArgs({
	options: {
		only: { type: "string" },
		"no-tui": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (v.help) {
	console.log(`
Usage: bun scripts/make-cards.ts [options]

Options:
  --only <slugs>   Comma-separated list of game slugs to render
  --no-tui         Disable the interactive terminal UI
  --help, -h       Show this help message
`);
	process.exit(0);
}

const configured = process.env.SITE_URL || (await Bun.file(path.join(REPO, "site.json")).json()).url || "";
const site = configured.replace(/\/+$/, "");
if (!/^https:\/\/[^/]+/.test(site))
	throw new Error('site.json needs an https "url" (or set SITE_URL). Crawlers need absolute URLs.');

const onlyList = v.only
	? v.only
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
	: [];
const chrome = await chromePath();
const { games: allGames, shown } = await loadGames();
const games = onlyList.length ? allGames.filter((g) => onlyList.includes(g.slug)) : allGames;

const totalCards = (onlyList.length ? 0 : 1) + games.length;

const dashboard = await createCardsDashboard({
	totalCards,
	chromeBin: chrome,
	siteUrl: site,
	noTui: Boolean(v["no-tui"]),
});

dashboard.onStep(`Validated crawler domain: ${site}`, "CONFIG");
if (site.includes("YOUR-DOMAIN")) {
	dashboard.onStep("Warning: site.json still has the placeholder domain", "WARN");
}
dashboard.onStep(`Located headless Chromium binary: ${chrome}`, "CHROME");
dashboard.onStep(`Loaded manifest: ${games.length} target games (${shown.length} shown on homepage)`, "GAMES");

try {
	// 1. Homepage card (unless filtering by specific game)
	if (!onlyList.length) {
		const homeCardPath = path.join(PUBLIC, "card.jpg");
		const homeDesc =
			"Interactive game maps that work offline. Track every collectible across playthroughs, right in your browser.";

		const t0 = Date.now();
		dashboard.startCard({
			slug: "homepage",
			title: "Atlas Homepage Showcase",
			outPath: homeCardPath,
			poster: true,
		});

		dashboard.onCardStep("Compiling homepage 3-poster composite HTML");
		const html = homeHtml(shown);
		await drawCard(chrome, html, homeCardPath, (s) => dashboard.onCardStep(s));

		dashboard.onCardStep("Writing OpenGraph social meta tags to public/index.html");
		const file = path.join(PUBLIC, "index.html");
		const block = socialTags({
			title: "Verticordia Atlas · Interactive game maps",
			description: homeDesc,
			url: `${site}/`,
			image: `${site}/card.jpg`,
			alt: "Verticordia Atlas: interactive game maps that work offline",
		});
		await Bun.write(file, withHead(await Bun.file(file).text(), block));

		const st = await Bun.file(homeCardPath).stat();
		dashboard.finishCard(
			{ slug: "homepage", title: "Homepage Showcase", outPath: homeCardPath, poster: true },
			st.size,
			Date.now() - t0,
		);
	}

	// 2. Per-game cards
	for (const g of games) {
		const outPath = path.join(g.dir, "card.jpg");
		const t0 = Date.now();
		dashboard.startCard({
			slug: g.slug,
			title: g.title,
			outPath,
			poster: Boolean(g.poster),
			accent: g.theme?.accent,
		});

		dashboard.onCardStep(`Building template for ${g.title} (${g.maps?.length || 1} map(s))`);
		const html = gameHtml(g);
		await drawCard(chrome, html, outPath, (s) => dashboard.onCardStep(s));

		const st = await Bun.file(outPath).stat();
		dashboard.finishCard(
			{ slug: g.slug, title: g.title, outPath, poster: Boolean(g.poster), accent: g.theme?.accent },
			st.size,
			Date.now() - t0,
		);
	}

	await dashboard.finish();
} catch (err: any) {
	dashboard.destroy();
	console.error(`\nERROR: ${err.message || err}`);
	process.exit(1);
}