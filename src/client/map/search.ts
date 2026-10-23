/* ---------- search ----------
   From two letters on, the sidebar's list gives way to the results, and the map shows only the matches (on this map;
   "All maps" lists the other maps too). Matching is shared/search.ts: the title before the description; within a
   title, exact, then the phrase, then every word, then with typos. Among equal matches the nearest to the view comes
   first. Hovering a result moves the map to it; leaving the list (or pressing Esc) puts the view back. That move is
   not saved, so it does not count as the user moving the map. */

import { esc } from '../../shared/escape.ts';
import { flat, fuzzyScore, words } from '../../shared/search.ts';
import { $, fmt, isMobile, state, vivid } from './state.ts';
import { renderMd } from './markdown.ts';
import { applicable, iconHtml } from './sidebar.ts';
import { mapData, placeThumb, refreshMap, switchMap } from './map-view.ts';
import { select } from './detail.ts';
import { svgIcon } from '../icons.ts';

const SEARCH_MIN = 2, SEARCH_SHOWN = 300, PREVIEW_MS = 350;
export const HOVER_MS = 50; // the pointer must rest this long on a result or a link before the map follows it

const mapName = (slug: string): string =>
  state.meta?.maps?.find((m: any) => m.slug === slug)?.title || slug;

export interface SearchQuery {
  phrase: string;
  toks: string[];
  long: string[];
}

export function queryOf(text: string): SearchQuery {
  const toks = flat(text).split(' ').filter(Boolean);
  return { phrase: toks.join(' '), toks, long: toks.filter(t => t.length >= 3) };
}

interface CachedLocText {
  title: string;
  titleWords: string[];
  desc: string;
  descWords: string[] | null;
}

// the normalised title and description of a location, cached (descriptions are long)
const textCache = new WeakMap<object, CachedLocText>();
export function textOf(l: { title?: string; desc?: string }): CachedLocText {
  let c = textCache.get(l);
  if (!c) textCache.set(l, c = { title: flat(l.title), titleWords: words(l.title), desc: flat(l.desc), descWords: null });
  return c;
}

// a query word in a text: a word of three letters or more anywhere in it, a shorter one only as a whole word
const hasWord = (text: string, t: string): boolean =>
  (t.length >= 3 ? text.includes(t) : (' ' + text + ' ').includes(' ' + t + ' '));

// [tier, typos] when the location matches, else null. Lower tiers first: 0 exact title, 1 title contains the phrase,
// 2 title contains every word, 3 title with typos, 4 description contains every word, 5 description with typos.
export function matchOf(q: SearchQuery, l: { title?: string; desc?: string }): [number, number] | null {
  const c = textOf(l);
  if (c.title === q.phrase) return [0, 0];
  if (c.title.includes(q.phrase)) return [1, 0];
  if (q.toks.every(t => hasWord(c.title, t))) return [2, 0];
  const t3 = fuzzyScore(q.long, c.titleWords);
  if (t3 !== null) return [3, t3];
  if (q.toks.every(t => hasWord(c.desc, t))) return [4, 0];
  c.descWords ??= words(l.desc);
  const t5 = fuzzyScore(q.long, c.descWords);
  return t5 !== null ? [5, t5] : null;
}

// the locations of this map a search may match: shown now (category on, found ones only when they are shown)
export function localEntries(): any[] {
  const cur = state.mapInfo.slug;
  return state.locs
    .filter((l: any) => applicable(l) && !state.view.hidden.has(l.cat) && !(state.view.hideFound && state.found.has(l.id)))
    .map((l: any) => ({ l, slug: cur, cat: state.cats.get(l.cat), col: state.groupOfCat.get(l.cat)?.col }));
}

// the other maps of the game, from their data (fetched once, as when a map opens). Their categories and found markers
// are as that map's saved view has them; the tag switch of this map does not apply to them.
export async function otherEntries(): Promise<any[]> {
  const others = state.meta.maps.filter((m: any) => m.slug !== state.mapInfo.slug);
  const lists = await Promise.all(others.map(async (info: any) => {
    const data = await mapData(info);
    const cats = new Map<number, any>(Object.values<any>(data.categories).map(c => [c.id, c]));
    const groupCol = new Map<number, string>(data.groups.map((g: any) => [g.id, vivid(g.color)]));
    const view = state.profile?.view?.[info.slug] || {};
    const hidden = new Set<number>(view.hidden || []);
    const out: any[] = [];
    for (const d of data.locations) {
      const lat = parseFloat(d.latitude), lng = parseFloat(d.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || hidden.has(d.category_id)) continue;
      if (view.hideFound && state.found.has(d.id)) continue;
      const cat = cats.get(d.category_id);
      out.push({ l: { id: d.id, title: d.title || '', desc: d.description || '', lat, lng }, slug: info.slug, cat, col: groupCol.get(cat?.group_id) });
    }
    return out;
  }));
  return lists.flat();
}

// matches, best first. Within a tier: this map before the others, then the nearest to the camera. With all maps listed
// the camera means nothing across maps, so there the order inside a tier is by title (this map still first).
export function rankEntries(q: SearchQuery, entries: any[], { byDistance = true } = {}): any[] {
  const cam = state.map ? state.map.getCenter() : { lng: 0, lat: 0 }, cur = state.mapInfo.slug;
  const hits: any[] = [];
  for (const e of entries) {
    const m = matchOf(q, e.l);
    if (!m) continue;
    const here = e.slug === cur;
    const dist = byDistance && here ? Math.hypot(e.l.lng - cam.lng, e.l.lat - cam.lat) : 0;
    hits.push({ e, tier: m[0], typo: m[1], here, dist });
  }
  const cmp = (x: any, y: any) => (x < y ? -1 : x > y ? 1 : 0);
  hits.sort((a, b) => cmp(a.tier, b.tier) || cmp(a.typo, b.typo) || cmp(b.here, a.here) || cmp(a.dist, b.dist)
    || a.e.l.title.localeCompare(b.e.l.title));
  return hits;
}

export async function runSearch(): Promise<void> {
  const s = state.search;
  endPreview({ instant: true }); // a hover move is undone first: the order is by the view the user has
  const text = ($<HTMLInputElement>('#search')?.value || '').trim();
  const wild = text === '*'; // the wildcard: every marker shown here, not a match
  if (!wild && [...text].length < SEARCH_MIN) return leaveSearch();
  const my = ++s.run;
  s.active = true;
  s.wild = wild;
  document.body.classList.add('searching');
  syncSideClose();
  const all = !wild && s.scope === 'all' && state.meta.maps.length > 1;
  let entries = localEntries();
  if (all) {
    s.busy = true; s.rows = []; renderResults();
    const others = await otherEntries().catch(() => []);
    if (my !== s.run) return; // a newer query has taken over
    entries = entries.concat(others);
    s.busy = false;
  }
  const hits = wild
    ? entries.map(e => ({ e, tier: 0, typo: 0, here: true, dist: 0 })).sort((a, b) => a.e.l.title.localeCompare(b.e.l.title))
    : rankEntries(queryOf(text), entries, { byDistance: !all });
  s.rows = hits;
  s.ids = new Set(hits.filter((h: any) => h.here).map((h: any) => h.e.l.id));
  const selIdx = state.selected != null
    ? hits.findIndex((h: any) => h.here && h.e.l.id === state.selected)
    : -1;
  s.idx = selIdx;
  renderResults();
  if (selIdx > 0) {
    const activeEl = $('#results')?.querySelector('li.result.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
  refreshMap();
}

// the list's close button: "Close" (it folds the panel on a phone, and is hidden on a desktop) becomes a red X while
// searching, which closes the search, on a phone and a desktop alike
export function syncSideClose(): void {
  const b = $('#side-close'), on = state.search.active;
  if (!b) return;
  b.classList.toggle('search-close', on);
  b.innerHTML = on ? svgIcon('x') : 'Close';
  b.setAttribute('aria-label', on ? 'Close search' : 'Close panel');
  b.title = on ? 'Close search' : '';
}

export function leaveSearch(): void {
  const s = state.search;
  endPreview({ instant: true });
  s.run++;
  s.active = false; s.ids = null; s.rows = []; s.busy = false; s.wild = false; s.idx = -1;
  document.body.classList.remove('searching');
  syncSideClose();
  const res = $('#results');
  if (res) res.innerHTML = '';
  refreshMap();
}

function resultHtml(h: any, i: number): string {
  const { e, here } = h, l = e.l, found = state.found.has(l.id);
  const icon = e.cat ? iconHtml(e.cat.icon, e.cat.color || e.col) : '';
  const sub = [e.cat?.title, here ? '' : mapName(e.slug)].filter(Boolean).join(' · ');
  return `<li class="result${found ? ' found' : ''}${i === state.search.idx ? ' active' : ''}" data-id="${l.id}" data-map="${esc(e.slug)}">` +
    `<div class="r-head"><span class="ico-wrap">${icon}</span><span class="r-title">${esc(l.title)}</span>${found ? '<span class="r-found">found</span>' : ''}</div>` +
    `<div class="r-sub">${esc(sub)}</div>` + (l.desc ? `<div class="r-desc">${renderMd(l.desc)}</div>` : '') + '</li>';
}

export function renderResults(): void {
  const s = state.search, n = s.rows.length;
  const resEl = $('#results');
  if (resEl) resEl.innerHTML = s.rows.slice(0, SEARCH_SHOWN).map(resultHtml).join('');
  const bar = $('#results-bar');
  if (bar) {
    bar.querySelector('.r-count')!.textContent = s.busy ? 'Searching the other maps…'
      : n === 0 ? 'No matches'
      : `${fmt(n)} result${n === 1 ? '' : 's'}${n > SEARCH_SHOWN ? `, first ${SEARCH_SHOWN} listed` : ''}`;
  }
  // a game with one map has nothing to choose between: the pills are not there at all
  const scope = $('#scope-switch');
  if (scope) {
    scope.hidden = state.meta.maps.length < 2 || s.wild; // the wildcard lists this map only
    scope.querySelectorAll<HTMLElement>('[data-scope]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scope === s.scope)));
    placeThumb(scope, 'data-scope', s.scope);
    scope.classList.add('ready'); // from now on the pill slides
  }
}

// a thin dotted ring on the result under the pointer: the same circle a selected marker gets (style.css .search-ring),
// drawn over the map and kept on its location while the map moves
let ringEl: HTMLDivElement | null = null, ringAt: { lng: number; lat: number } | null = null;
export function showRing(l: { lng: number; lat: number }): void {
  if (!ringEl) {
    ringEl = document.createElement('div');
    ringEl.className = 'search-ring';
    ringEl.hidden = true;
    state.map.getContainer().appendChild(ringEl);
    state.map.on('move', placeRing);
  }
  ringAt = l;
  ringEl.hidden = false;
  placeRing();
}

export function hideRing(): void {
  ringAt = null;
  if (ringEl) ringEl.hidden = true;
}

export function placeRing(): void {
  if (!ringEl || ringEl.hidden || !ringAt) return;
  const p = state.map.project([ringAt.lng, ringAt.lat]);
  // the selected marker's circle sits 17px above its point (see the 'sel' layer), so the ring does too
  ringEl.style.transform = `translate(${p.x - 21}px, ${p.y - 38}px)`;
}

// the map moves to a result on this map (hover, or the arrow keys); the view is kept aside to go back to
export function previewRow(li: HTMLElement | null): void {
  const s = state.search;
  if (!li || !state.mapReady) return;
  const hit = s.rows.find((h: any) => String(h.e.l.id) === li.dataset.id && h.e.slug === li.dataset.map);
  if (!hit || !hit.here) return;
  previewAt(hit.e.l);
}

// the map moves to a location of this map, kept aside to go back to (see endPreview). With the card open, the
// location is centred in the room the card leaves, as select() does.
export function previewAt(l: { lng: number; lat: number } | null | undefined): void {
  if (!l || !state.mapReady) return;
  const s = state.search;
  if (!s.preview) s.preview = { cam: { center: state.map.getCenter(), zoom: state.map.getZoom() } };
  const padding = !document.body.classList.contains('detail-open') ? {}
    : isMobile() ? { bottom: Math.round(innerHeight * 0.4) } : { right: 384 };
  state.map.easeTo({ center: [l.lng, l.lat], zoom: Math.max(state.map.getZoom(), 12), padding, duration: PREVIEW_MS });
  showRing(l);
}

// puts the view back where it was before the preview; a move that is not a preview is never undone
export function endPreview({ instant = false, restore = true } = {}): void {
  const s = state.search, p = s.preview;
  hideRing();
  if (!p) return;
  s.preview = null;
  if (!restore || !state.mapReady) return;
  if (instant) state.map.jumpTo({ center: p.cam.center, zoom: p.cam.zoom, padding: {} });
  else state.map.easeTo({ center: p.cam.center, zoom: p.cam.zoom, padding: {}, duration: PREVIEW_MS });
}

export function syncSearchActive(id: number | null, slug: string | undefined = state.mapInfo?.slug): void {
  if (!state.search.active) return;
  const items = [...($('#results')?.querySelectorAll<HTMLElement>('li.result') || [])];
  const idx = id != null
    ? items.findIndex(el => Number(el.dataset.id) === id && el.dataset.map === slug)
    : -1;
  state.search.idx = idx;
  items.forEach((el, i) => el.classList.toggle('active', i === idx));
  if (idx !== -1) items[idx].scrollIntoView({ block: 'nearest' });
}

export function moveSearch(d: number): void {
  const s = state.search, items = [...($('#results')?.querySelectorAll<HTMLElement>('li.result') || [])];
  if (!items.length) return;
  if (s.idx < 0) {
    s.idx = d > 0 ? 0 : items.length - 1;
  } else {
    s.idx = (s.idx + d + items.length) % items.length;
  }
  items.forEach((el, i) => el.classList.toggle('active', i === s.idx));
  items[s.idx].scrollIntoView({ block: 'nearest' });
  const li = items[s.idx];
  const id = Number(li.dataset.id), slug = li.dataset.map;
  if (slug === state.mapInfo?.slug) {
    select(id, { fly: false, push: false, closeSide: false });
  }
  previewRow(li);
}

// a result is opened: its map is switched to first if it is another one; the card and the camera then go to it
export async function openResult(li: HTMLElement | null): Promise<void> {
  if (!li) return;
  const id = Number(li.dataset.id), slug = li.dataset.map!;
  syncSearchActive(id, slug);
  endPreview({ restore: false }); // select() flies there from where the preview left the map
  if (slug !== state.mapInfo.slug) {
    await switchMap(slug);
    if (state.mapInfo?.slug !== slug) return;
  }
  select(id);
}
