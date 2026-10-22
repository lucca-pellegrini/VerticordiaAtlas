import './theme.js';
import { initAccount, accountSlot, notify } from './account.js';
import { norm, words, fuzzyScore } from './shared/search.mjs';
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
  const accent = g.theme?.accent && CSS.supports('color', g.theme.accent) ? ` style="--accent:${esc(g.theme.accent)}"` : '';
  // "poster" is either a base name with -600.webp / -1200.webp variants, or one image file (extension included)
  const single = /\.(jpe?g|png|webp|avif)$/i.test(g.poster || '');
  const eager = i === 0 ? ' fetchpriority="high"' : '';
  const img = !g.poster ? '' : single
    ? `<div class="card-media"><img src="maps/${esc(g.poster)}" width="1200" height="600" alt="${esc(g.posterAlt || '')}" ` +
      `loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async"${eager}></div>`
    : `<div class="card-media"><img src="maps/${esc(g.poster)}-1200.webp" srcset="maps/${esc(g.poster)}-600.webp 600w, maps/${esc(g.poster)}-1200.webp 1200w" ` +
      `sizes="(min-width: 640px) 560px, calc(100vw - 36px)" width="1200" height="600" alt="${esc(g.posterAlt || '')}" ` +
      `loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async"${eager}></div>`;
  const stats = (g.stats || []).map(s => `<li><b>${fmt(s.value)}</b> ${esc(s.label)}</li>`).join('');
  // The whole card is one real link, so clicks on the button or anywhere else go to the same place.
  return `<li style="--i:${i + 3}"><a class="card" href="${href}"${accent}>${img}` +
    `<div class="card-body"><h3>${esc(g.title)}</h3>` +
    (g.description ? `<p>${esc(g.description)}</p>` : '') +
    `<div class="card-foot"><ul class="stats">${stats}</ul><span class="cta">Open map ${ARROW}</span></div></div></a></li>`;
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
  setupSearch(list);
}

// Search: a card matches by its title or description, exactly or with typos (shared/search.mjs).

function setupSearch(list) {
  const toggle = document.querySelector('.search-toggle');
  const form = document.getElementById('map-search');
  const input = document.getElementById('map-query');
  const none = document.getElementById('no-results');
  const label = document.getElementById('games-title');
  const partialSection = document.getElementById('partial');
  const partialList = document.getElementById('partial-list');
  if (!toggle || !form || !input) return;

  const labelText = label.textContent;
  const cardText = li => `${li.querySelector('h3')?.textContent} ${li.querySelector('.card-body > p')?.textContent || ''}`;

  const filter = () => {
    const q = norm(input.value).trim();
    const queryWords = q.split(/\s+/).filter(Boolean);
    const fuzzy = [];
    let exact = 0;

    for (const li of list.children) {
      if (!q) { li.hidden = false; continue; }
      const text = norm(cardText(li));
      if (text.includes(q)) {
        li.hidden = false;
        exact++;
        continue;
      }
      li.hidden = true;
      // fuzzy matching needs a few characters, otherwise short queries match almost everything
      if (q.length < 4) continue;
      const score = fuzzyScore(queryWords, words(cardText(li)));
      if (score !== null) fuzzy.push({ li, score, title: li.querySelector('h3').textContent });
    }

    fuzzy.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
    partialList.replaceChildren(...fuzzy.map(({ li }) => {
      const copy = li.cloneNode(true);
      copy.hidden = false;
      return copy;
    }));

    // no exact matches: drop the Results heading and grid entirely (partial matches, or the notice, take over)
    const noExact = !!q && exact === 0;
    label.textContent = q ? 'Results' : labelText;
    label.hidden = noExact;
    list.hidden = noExact;
    partialSection.hidden = !q || fuzzy.length === 0;
    none.hidden = !q || exact + fuzzy.length > 0;
  };

  const setOpen = open => {
    form.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus({ preventScroll: true });
    else { input.value = ''; filter(); toggle.focus({ preventScroll: true }); }
  };

  toggle.addEventListener('click', () => setOpen(!form.classList.contains('open')));
  input.addEventListener('input', filter);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
  form.addEventListener('submit', e => e.preventDefault());
}

main();

// the account button, to the right of the search (it steps aside while the search is open)
const topTools = document.querySelector('.top-tools');
if (topTools) topTools.appendChild(accountSlot('top'));
initAccount({ toast: notify });

// Logo tap: the logo links to this same page, so tapping it shows the heart instead of reloading,
// then it switches back to the pin after a few seconds.
const brand = document.querySelector('.brand');
let beatTimer;
brand?.addEventListener('click', e => {
  e.preventDefault();
  brand.classList.add('beat');
  clearTimeout(beatTimer);
  beatTimer = setTimeout(() => brand.classList.remove('beat'), 6000);
});
