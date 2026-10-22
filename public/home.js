import { readRecentGames, recordGameOpen, storeGameTitles } from './theme.js';
import { initAccount, accountSlot, notify } from './account.js';
import { norm, words, fuzzyScore } from './shared/search.mjs';
// Homepage: renders one card per entry in maps/index.json.
//
// To add a game: put its files in maps/<slug>/ (see add-game.mjs),
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
  return `<li style="--i:${i + 3}"><a class="card" href="${href}" data-slug="${esc(g.slug)}"${accent}>${img}` +
    `<div class="card-body"><h3>${esc(g.title)}</h3>` +
    (g.description ? `<p>${esc(g.description)}</p>` : '') +
    `<div class="card-foot"><ul class="stats">${stats}</ul><span class="cta">Open map ${ARROW}</span></div></div></a></li>`;
}

export function orderGames(games, recentSlugs = []) {
  if (!recentSlugs?.length) return games.slice();
  const map = new Map(games.map(g => [g.slug, g]));
  const ordered = [];
  for (const slug of recentSlugs) {
    const g = map.get(slug);
    if (g) {
      ordered.push(g);
      map.delete(slug);
    }
  }
  for (const g of games) {
    if (map.has(g.slug)) {
      ordered.push(g);
    }
  }
  return ordered;
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
  storeGameTitles(index.games);
  const recent = readRecentGames();
  const games = orderGames(index.games, recent);
  const featured = renderResume(index.games);
  list.innerHTML = games.map(card).join('');
  // the game in the "continue" card is not repeated at the top of the grid; it comes back while searching
  if (featured) {
    const li = list.querySelector(`a.card[data-slug="${CSS.escape(featured)}"]`)?.closest('li');
    if (li) { li.dataset.featured = ''; li.hidden = true; }
  }

  const onOpen = e => {
    const a = e.target.closest('a.card');
    if (!a) return;
    const slug = a.dataset.slug;
    const g = index.games.find(x => x.slug === slug);
    if (g) recordGameOpen(g.slug, g.theme, g.title);
  };
  list.addEventListener('click', onOpen);
  list.addEventListener('auxclick', onOpen);

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
      if (!q) { li.hidden = li.dataset.featured !== undefined && !document.body.classList.contains('searching'); continue; }
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
    if (open) {
      document.getElementById('top-more')?.classList.remove('open');
      document.querySelector('.more-toggle')?.setAttribute('aria-expanded', 'false');
      input.focus({ preventScroll: true });
    }
    else { input.value = ''; filter(); toggle.focus({ preventScroll: true }); syncSearching(); }
  };

  toggle.addEventListener('click', () => setOpen(!form.classList.contains('open')));
  input.addEventListener('input', filter);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
  form.addEventListener('submit', e => e.preventDefault());

  // while the search is in use (focused, or holding a query) the hero folds away, so results sit right under the bar
  const syncSearching = () => {
    const on = document.activeElement === input || !!input.value.trim();
    if (on === document.body.classList.contains('searching')) return;
    document.body.classList.toggle('searching', on);
    filter(); // the featured game rejoins the grid while the hero is folded away
  };
  input.addEventListener('focus', syncSearching);
  input.addEventListener('blur', syncSearching);
  input.addEventListener('input', syncSearching);

  // Ctrl/Cmd+K (or "/" when nothing is being typed) opens and focuses the search
  document.addEventListener('keydown', e => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    const ctrlK = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
    const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
    if (!ctrlK && !slash) return;
    e.preventDefault();
    if (!form.classList.contains('open')) setOpen(true);
    input.focus({ preventScroll: true });
    input.select();
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}

/* ---------- the "continue" card: the last opened game, from the summary app.js keeps in localStorage ---------- */

const HEXCOL = /^#[0-9a-f]{3,8}$/i;
const ICON = {
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4-5 2v14l5-2 6 2 5-2V4l-5 2-6-2Zm0 0v14m6-12v14"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3-8.7 8.7-8.3-8.3Z"/><circle cx="8" cy="8" r="1.4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.2"/></svg>',
  pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5 4 20Z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem('va_last_session') || 'null');
    return s && s.v === 1 && typeof s.slug === 'string' ? s : null;
  } catch { return null; }
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (!Number.isFinite(s) || s < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const mins = s / 60, hours = mins / 60, days = hours / 24;
  if (mins < 60) return rtf.format(-Math.round(mins), 'minute');
  if (hours < 24) return rtf.format(-Math.round(hours), 'hour');
  if (days < 7) return rtf.format(-Math.round(days), 'day');
  if (days < 30) return rtf.format(-Math.round(days / 7), 'week');
  if (days < 365) return rtf.format(-Math.round(days / 30), 'month');
  return rtf.format(-Math.round(days / 365), 'year');
}

function posterSrc(g, size) {
  if (!g.poster) return '';
  return /\.(jpe?g|png|webp|avif)$/i.test(g.poster) ? `maps/${g.poster}` : `maps/${g.poster}-${size}.webp`;
}

const pct = (f, n) => (n ? Math.floor((1000 * f) / n) / 10 : 0);
const colour = c => (HEXCOL.test(c || '') ? c : 'var(--accent)');

function renderResume(gamesList) {
  const s = readSession();
  const g = s && gamesList.find(x => x.slug === s.slug);
  const root = document.getElementById('resume');
  const hero = document.getElementById('hero');
  if (!g || !root || !hero || !(s.total > 0)) return null;

  const href = `maps/${encodeURIComponent(g.slug)}/`;
  const mapHref = slug => `${href}?map=${encodeURIComponent(slug)}`;
  const accent = HEXCOL.test(g.theme?.accent || '') ? g.theme.accent : null;
  const soft = HEXCOL.test(g.theme?.['accent-soft'] || '') ? g.theme['accent-soft'] : null;
  const style = [accent && `--accent:${accent}`, soft && `--g-soft:${soft}`].filter(Boolean).join(';');
  const p = pct(s.found, s.total), left = Math.max(0, s.total - s.found), done = left === 0;
  const maps = Array.isArray(s.maps) ? s.maps : [];
  const mapIdx = maps.findIndex(m => m.slug === s.map);
  const groups = (Array.isArray(s.groups) ? s.groups : []).filter(x => x && x.n > 0);
  const legend = [...groups].sort((a, b) => b.n - a.n).slice(0, 6);
  const more = groups.length - legend.length;
  const R = 52, C = 2 * Math.PI * R;

  const totalProfiles = Array.isArray(s.profiles) ? s.profiles.length : (typeof s.profiles === 'number' ? s.profiles : 1);
  const profileList = Array.isArray(s.profiles) ? s.profiles : [];
  const otherProfiles = profileList
    .filter(p => p && p.id && p.name && p.name !== s.profile && p.id !== s.profileId)
    .slice(0, 6);
  const profileHref = id => `${href}?profile=${encodeURIComponent(id)}`;

  const chips = [
    maps.length > 1 ? `<li title="Map">${ICON.map}<span>${esc(s.mapTitle || s.map)}${mapIdx >= 0 ? `<small>${mapIdx + 1} of ${maps.length}</small>` : ''}</span></li>` : '',
    s.profile ? `<li title="Profile">${ICON.user}<span>${esc(s.profile)}${totalProfiles > 1 ? `<small>${fmt(totalProfiles)} profiles</small>` : ''}</span></li>` : '',
    s.tag ? `<li title="${esc(s.tagLabel || 'Filter')}">${ICON.tag}<span><small>${esc(s.tagLabel || 'Filter')}</small>${esc(s.tag)}</span></li>` : '',
  ].join('');

  const recent = (Array.isArray(s.recent) ? s.recent : []).slice(0, 4).map(r =>
    `<li style="--c:${colour(r.c)}"><span class="dot" aria-hidden="true"></span><span class="what">${esc(r.t)}</span>` +
    (r.cat && r.cat !== r.t ? `<span class="cat">${esc(r.cat)}</span>` : '') + `</li>`).join('');

  const nearScore = r => (r.f / r.n) * (1 - 1 / Math.sqrt(r.n + 1));
  const nearList = (Array.isArray(s.near) ? s.near : [])
    .filter(r => r && r.n > 0 && r.f > 0 && r.f < r.n)
    .sort((a, b) => nearScore(b) - nearScore(a) || (b.f / b.n) - (a.f / a.n) || b.n - a.n);
  const near = nearList.slice(0, 3).map(r =>
    `<li style="--c:${colour(r.c)}"><div class="near-row"><span class="what">${esc(r.t)}</span><span class="num"><b>${fmt(r.f)}</b>/${fmt(r.n)}</span></div>` +
    `<div class="mini" aria-hidden="true"><i data-w="${pct(r.f, r.n)}"></i></div><span class="hint">${fmt(r.n - r.f)} left</span></li>`).join('');

  const extras = [
    s.userMarkers ? `<li>${ICON.pin}<b>${fmt(s.userMarkers)}</b> marker${s.userMarkers === 1 ? '' : 's'} placed</li>` : '',
    s.drawings ? `<li>${ICON.pen}<b>${fmt(s.drawings)}</b> drawing${s.drawings === 1 ? '' : 's'}</li>` : '',
    s.presets ? `<li>${ICON.layers}<b>${fmt(s.presets)}</b> preset${s.presets === 1 ? '' : 's'}</li>` : '',
  ].join('');

  const otherMaps = maps.filter(m => m.slug !== s.map).slice(0, 6);
  const img = posterSrc(g, 1200);

  root.innerHTML =
    `<article class="resume-card${done ? ' done' : ''}" style="${style}">` +
      `<div class="resume-media">` +
        (img ? `<img src="${esc(img)}" alt="${esc(g.posterAlt || '')}" width="1200" height="600" decoding="async" fetchpriority="high">` : '') +
        `<div class="resume-ring" role="img" aria-label="${p}% complete">` +
          `<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="track" cx="60" cy="60" r="${R}"/>` +
          `<circle class="arc" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}" data-off="${(C * (1 - p / 100)).toFixed(2)}"/></svg>` +
          `<span class="ring-num">${done ? ICON.check : `${Math.floor(p)}<small>%</small>`}</span>` +
          `<span class="ring-label">${done ? 'Complete' : 'complete'}</span>` +
        `</div>` +
      `</div>` +
      `<div class="resume-body">` +
        `<header class="resume-head">` +
          `<p class="resume-eyebrow"><span class="live" aria-hidden="true"></span>Continue where you left off<span class="when"><span class="sep" aria-hidden="true">·</span><time datetime="${new Date(s.updated).toISOString()}">${esc(ago(s.updated))}</time></span></p>` +
          `<button type="button" class="resume-dismiss" aria-label="Hide this card" title="Hide this card">${ICON.close}</button>` +
        `</header>` +
        `<h1 id="resume-title" class="resume-title">${esc(g.title)}</h1>` +
        `<ul class="resume-chips">${chips}</ul>` +
        `<div class="resume-progress">` +
          `<p class="resume-count"><b>${fmt(s.found)}</b><span class="of">of ${fmt(s.total)} markers found</span>` +
          `<span class="togo">${done ? 'All found' : `${fmt(left)} to go`}</span></p>` +
          `<div class="bar" role="img" aria-label="Progress by group">` +
            groups.map(x => `<div class="seg" style="flex-grow:${x.n};--c:${colour(x.c)}" title="${esc(x.t)}: ${fmt(x.f)} of ${fmt(x.n)}"><i data-w="${pct(x.f, x.n)}"></i></div>`).join('') +
          `</div>` +
          `<ul class="resume-legend">` +
            legend.map(x => `<li style="--c:${colour(x.c)}"><span class="dot" aria-hidden="true"></span>${esc(x.t)}<span class="num">${fmt(x.f)}/${fmt(x.n)}</span></li>`).join('') +
            (more > 0 ? `<li class="more">+${more} more</li>` : '') +
          `</ul>` +
        `</div>` +
        (recent || near ? `<div class="resume-cols">` +
          (recent ? `<section><h2>Recently found</h2><ul class="resume-recent">${recent}</ul></section>` : '') +
          (near ? `<section><h2>Almost complete</h2><ul class="resume-near">${near}</ul></section>` : '') +
        `</div>` : '') +
        `<footer class="resume-foot">` +
          `<a class="cta resume-cta" href="${esc(mapHref(s.map))}" data-slug="${esc(g.slug)}">Resume${maps.length > 1 ? ` on ${esc(s.mapTitle || s.map)}` : ''} ${ARROW}</a>` +
          (otherMaps.length ? `<nav class="resume-maps" aria-label="Other maps in ${esc(g.title)}"><span>Or jump to</span>` +
            otherMaps.map(m => `<a href="${esc(mapHref(m.slug))}" data-slug="${esc(g.slug)}">${esc(m.title)}</a>`).join('') + `</nav>` : '') +
          (otherProfiles.length ? `<nav class="resume-maps resume-profiles" aria-label="Other profiles in ${esc(g.title)}"><span>Or profile</span>` +
            otherProfiles.map(p => `<a href="${esc(profileHref(p.id))}" data-slug="${esc(g.slug)}">${esc(p.name)}</a>`).join('') + `</nav>` : '') +
          (extras ? `<ul class="resume-extras">${extras}</ul>` : '') +
        `</footer>` +
      `</div>` +
    `</article>`;

  hero.hidden = true;
  root.hidden = false;
  document.getElementById('hero-shell')?.classList.add('has-resume');

  // the ring, the bar and the small bars grow in once the card is on screen
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
    const arc = root.querySelector('.arc');
    if (arc) arc.style.strokeDashoffset = arc.dataset.off;
  }));

  root.addEventListener('click', e => {
    const a = e.target.closest('a[data-slug]');
    if (a) { recordGameOpen(g.slug, g.theme, g.title); return; }
    if (e.target.closest('.resume-dismiss')) {
      try { localStorage.removeItem('va_last_session'); } catch {}
      root.hidden = true;
      hero.hidden = false;
      document.getElementById('hero-shell')?.classList.remove('has-resume');
      const li = document.querySelector('#game-list li[data-featured]');
      if (li) { delete li.dataset.featured; if (!document.getElementById('map-query')?.value.trim()) li.hidden = false; }
    }
  });
  return g.slug;
}

main();

// the account button, to the right of the search (on mobile, inside the three-dots menu with the theme switch)
const topMore = document.getElementById('top-more');
const topMorePanel = document.getElementById('top-more-panel');
const moreToggle = topMore?.querySelector('.more-toggle');
if (topMorePanel) topMorePanel.appendChild(accountSlot('top'));
initAccount({ toast: notify });

if (topMore && moreToggle) {
  const setMoreOpen = open => {
    topMore.classList.toggle('open', open);
    moreToggle.setAttribute('aria-expanded', String(open));
  };
  moreToggle.addEventListener('click', e => {
    e.stopPropagation();
    setMoreOpen(!topMore.classList.contains('open'));
  });
  document.addEventListener('click', e => {
    if (!topMore.contains(e.target)) setMoreOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && topMore.classList.contains('open')) {
      setMoreOpen(false);
      moreToggle.focus({ preventScroll: true });
    }
  });
}

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
