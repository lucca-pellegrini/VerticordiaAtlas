#!/usr/bin/env node
// make-cards.mjs: social preview cards for the homepage and every game, and the tags that point at them.
//
//   node make-cards.mjs
//
// Writes card.jpg (1200x630) for the homepage (three random games' posters) and maps/<game>/card.jpg for each
// game folder, then sets the <head> of index.html and maps/<game>/index.html (between social:start / social:end).
// Run again after adding a game or changing a description; add-game.mjs runs it for you.
//
// Needs Chromium (on PATH, or CHROME=/path/to/chromium) and ImageMagick (magick). The domain comes from
// site.json (or SITE_URL): crawlers need absolute URLs. Per-marker share cards are made by server.mjs instead.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadGames, gameHtml, homeHtml, chromePath, drawCard, socialTags, withHead } from './cards.mjs';

const configured = process.env.SITE_URL || JSON.parse(await readFile(path.join(ROOT, 'site.json'), 'utf8')).url || '';
const site = configured.replace(/\/+$/, '');
if (!/^https:\/\/[^/]+/.test(site)) throw new Error('site.json needs an https "url" (or set SITE_URL). Crawlers need absolute URLs.');
if (site.includes('YOUR-DOMAIN')) console.warn('warning: site.json still has the placeholder domain; the tags will point at it until you set the real one.');

const chrome = await chromePath();
const { games, shown } = await loadGames();

// homepage
const homeDesc = 'Interactive game maps that work offline. Track every collectible across playthroughs, right in your browser.';
await drawCard(chrome, homeHtml(shown), path.join(ROOT, 'card.jpg'));
{
  const file = path.join(ROOT, 'index.html');
  const block = socialTags({
    title: 'Verticordia Atlas · Interactive game maps', description: homeDesc,
    url: `${site}/`, image: `${site}/card.jpg`, alt: 'Verticordia Atlas: interactive game maps that work offline',
  });
  await writeFile(file, withHead(await readFile(file, 'utf8'), block));
}
console.log('homepage: card.jpg');

// one card per game folder
for (const g of games) {
  const slug = encodeURI(g.slug);
  await drawCard(chrome, gameHtml(g), path.join(g.dir, 'card.jpg'));
  const file = path.join(g.dir, 'index.html');
  const title = `${g.title} · Verticordia Atlas`;
  const block = socialTags({
    title, description: g.description,
    url: `${site}/maps/${slug}/`, image: `${site}/maps/${slug}/card.jpg`, alt: g.alt,
  });
  await writeFile(file, withHead(await readFile(file, 'utf8'), block, title));
  console.log(`${g.slug}: card.jpg${g.poster ? '' : ' (no poster found, plain card)'}`);
}
