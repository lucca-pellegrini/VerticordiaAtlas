// Homepage: renders one card per entry in maps/index.json.
//
// To add a game: put its files in maps/<slug>/ (with an index.html like maps/requiem/index.html),
// add an entry to maps/index.json, and drop the poster in as
//   maps/<slug>/poster-600.webp   (600x300)
//   maps/<slug>/poster-1200.webp  (1200x600)
// The entry's "poster" is that path without the "-600.webp" / "-1200.webp" suffix, relative to maps/.

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => Number(n).toLocaleString();

const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

function card(g, i) {
  const href = `maps/${encodeURIComponent(g.slug)}/`;
  const accent = g.accent && CSS.supports('color', g.accent) ? ` style="--accent:${esc(g.accent)}"` : '';
  const img = g.poster
    ? `<div class="card-media"><img src="maps/${esc(g.poster)}-1200.webp" srcset="maps/${esc(g.poster)}-600.webp 600w, maps/${esc(g.poster)}-1200.webp 1200w" ` +
      `sizes="(min-width: 640px) 560px, calc(100vw - 36px)" width="1200" height="600" alt="${esc(g.posterAlt || '')}" ` +
      `loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async"${i === 0 ? ' fetchpriority="high"' : ''}></div>`
    : '';
  const stats = (g.stats || []).map(s => `<li><b>${fmt(s.value)}</b> ${esc(s.label)}</li>`).join('');
  return `<li style="--i:${i + 3}"><article class="card"${accent}>${img}` +
    `<div class="card-body"><h3><a href="${href}">${esc(g.title)}</a></h3>` +
    (g.description ? `<p>${esc(g.description)}</p>` : '') +
    `<div class="card-foot"><ul class="stats">${stats}</ul><span class="cta" aria-hidden="true">Open map ${ARROW}</span></div></div></article></li>`;
}

async function main() {
  const list = document.getElementById('game-list');
  const fail = msg => list.replaceWith(Object.assign(document.createElement('p'), { className: 'notice', textContent: msg }));
  let index;
  try {
    const r = await fetch('maps/index.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    index = await r.json();
  } catch (e) {
    return fail('Could not load the list of maps. Serve this folder over HTTP (for example with "npx serve") and reload.');
  }
  if (!index.games?.length) return fail('No maps have been added yet.');
  list.innerHTML = index.games.map(card).join('');
}

main();
