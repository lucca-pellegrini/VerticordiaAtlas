// Offline map viewer. No network needed once maps/<slug>/ is filled in.
// Data per game (next to its index.html): data.json (window.mapData saved from the site),
// markers.json + markers.png, tiles/{z}/{y}/{x}.jpg and media/<file>.jpg.

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => Number(n).toLocaleString();
import { DRAW_CONTROLS_HTML, setupDrawing } from './drawing.js';

const isMobile = () => matchMedia('(max-width: 760px)').matches;

const state = {
  entry: null, folder: '', data: null, sprite: null,
  groups: [], cats: new Map(), locs: [], byId: new Map(), tags: [],
  profiles: [], profile: null, found: new Set(), tag: null,
  view: { hidden: new Set(), hideFound: false, collapsed: new Set() },
  selected: null, map: null, mapReady: false, memoryOnly: false,
  stats: new Map(), searchHits: [], searchIdx: -1,
  presets: [], presetId: null, baseline: null, // baseline: the view before the first preset was picked
  trail: [], session: uid(), // navigation stack of opened markers (last = current); session ties history entries to it
  outLinks: new Map(), inLinks: new Map(), // location id -> ids its description links to / ids linking to it
  tool: 'pan', shape: 'box', sel: null, drag: null, // map tool; selection shape kind; the selection (map coordinates) and the one being drawn
};

/* ---------- storage: IndexedDB with an in-memory fallback ---------- */

const mem = { profiles: new Map(), meta: new Map() };
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open('offline-map-viewer', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('profiles', { keyPath: 'key' });
      db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

async function withStore(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}
const keyField = store => (store === 'profiles' ? 'key' : 'k');

async function dbAll(store) {
  if (state.memoryOnly) return [...mem[store].values()];
  return withStore(store, 'readonly', s => s.getAll());
}
async function dbGet(store, key) {
  if (state.memoryOnly) return mem[store].get(key);
  return withStore(store, 'readonly', s => s.get(key));
}
async function dbPut(store, value) {
  if (state.memoryOnly) { mem[store].set(value[keyField(store)], structuredClone(value)); return; }
  await withStore(store, 'readwrite', s => s.put(value));
}
async function dbDelete(store, key) {
  if (state.memoryOnly) { mem[store].delete(key); return; }
  await withStore(store, 'readwrite', s => s.delete(key));
}
const getMeta = async k => (await dbGet('meta', k))?.v;
const setMeta = (k, v) => dbPut('meta', { k, v });

/* ---------- small helpers ---------- */

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
}

function vivid(hex) {
  // Lighten very dark group colours so they stay readable on the dark panel.
  const h = String(hex || '888888').replace('#', '');
  let [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.45) {
    const t = (0.45 - lum) / (1 - lum);
    [r, g, b] = [r, g, b].map(v => Math.round(v + (255 - v) * t));
  }
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function askDialog({ title, message = '', value = null, okLabel = 'OK', danger = false }) {
  return new Promise(resolve => {
    const dlg = $('#dlg'), form = $('#dlg-form');
    form.innerHTML =
      `<h2>${esc(title)}</h2>` +
      (message ? `<p>${esc(message)}</p>` : '') +
      (value !== null ? `<input type="text" name="v" value="${esc(value)}" maxlength="60" autocomplete="off">` : '') +
      `<div class="dlg-actions"><button type="button" data-cancel>Cancel</button>` +
      `<button class="${danger ? 'danger' : 'primary'}">${esc(okLabel)}</button></div>`;
    const finish = r => { if (dlg.open) dlg.close(); resolve(r); };
    form.onsubmit = ev => {
      ev.preventDefault();
      finish(value !== null ? (form.elements.v.value.trim() || null) : true);
    };
    form.querySelector('[data-cancel]').onclick = () => finish(null);
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
    if (value !== null) form.elements.v.select();
  });
}

/* ---------- descriptions: markdown (vendor/marked.umd.js). MapGenie location links become local #loc links ---------- */

// "https://mapgenie.io/<game>/maps/<map>?locationIds=N" (also relative, or a #L suffix) -> N; anything else -> null
function mapgenieLocId(href) {
  let u;
  try { u = new URL(href, "https://mapgenie.io/"); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)mapgenie\.io$/i.test(u.hostname)) return null;
  const m = /^(\d+)/.exec(u.searchParams.get("locationIds") || "");
  return m ? Number(m[1]) : null;
}

// every link token in a parsed markdown token tree
function forEachLink(tokens, fn) {
  for (const t of tokens || []) {
    if (t.type === "link") fn(t);
    forEachLink(t.tokens, fn);
    if (t.items) forEachLink(t.items, fn);
  }
}

// location ids of this map that a description links to, in order of appearance (self and unknown ids skipped)
function internalRefs(src, selfId) {
  const out = [];
  forEachLink(marked.lexer(String(src || "")), t => {
    const id = mapgenieLocId(t.href);
    if (id != null && id !== selfId && state.byId.has(id) && !out.includes(id)) out.push(id);
  });
  return out;
}

marked.use({
  gfm: true,
  breaks: true, // single line breaks stay line breaks, as the descriptions were written
  renderer: {
    // raw HTML in a description is shown as text, never as markup
    html(t) { return esc(t.text); },
    link(t) {
      const text = this.parser.parseInline(t.tokens);
      const id = mapgenieLocId(t.href);
      if (id != null) return state.byId.has(id) ? `<a href="#loc=${id}" data-loc="${id}">${text}</a>` : text;
      if (/^https?:/i.test(t.href)) return `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return text; // mailto:, javascript: and other schemes are not made into links
    },
    image(t) { // embedded pictures are not shown inline yet: keep the alt text, linked when it is a web address
      const text = esc(t.text || t.href);
      return /^https?:/i.test(t.href) ? `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
  },
});

function renderMd(src) {
  return marked.parse(String(src || ""));
}

/* ---------- game loading ---------- */

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Could not load ' + src));
    i.src = src;
  });
}

function fatal(msg) {
  $('#groups').innerHTML = `<p style="padding:16px;color:var(--blood)">${esc(msg)}</p>`;
  console.error(msg);
}

async function boot() {
  try { await openDB(); }
  catch (e) {
    state.memoryOnly = true;
    toast('Storage is unavailable here, so progress will not be kept after this tab closes.', 6000);
  }

  // Each map page lives in maps/<slug>/ next to its data and says which game it is via <body data-game>.
  let index;
  try { index = await fetchJSON('../index.json'); }
  catch (e) { return fatal('Could not load maps/index.json. Serve this folder over HTTP (for example with "npx serve").'); }

  const slug = document.body.dataset.game;
  const entry = index.games.find(g => g.slug === slug);
  if (!entry) return fatal(`maps/index.json has no game with slug "${slug}".`);
  await loadGame(entry);
}

// Each game's colours come from "theme" in maps/index.json and become CSS variables (see style.css :root).
function applyTheme(theme = {}) {
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(theme)) {
    if (CSS.supports(`--${name}`, value)) root.setProperty(`--${name}`, value);
  }
  // backreferences: accent-soft pulled towards the night colour, so they read as the same family but dimmer
  root.setProperty('--backlink', mixColor(themeVar('accent-soft'), themeVar('night'), 0.7));
  // browser chrome follows the theme too: tab colour on mobile and the favicon pin
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', themeVar('night'));
  const icon = document.querySelector('link[rel=icon]');
  if (icon) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='${themeVar('accent-soft')}' d='M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z'/><circle cx='12' cy='10' r='2.8' fill='${themeVar('night')}'/></svg>`;
    icon.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
}
const themeVar = name => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

// Blend two CSS colours: t of a, the rest of b. Parsed through a canvas, so any CSS colour format works.
const colorProbe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
function mixColor(a, b, t) {
  const rgb = c => {
    colorProbe.clearRect(0, 0, 1, 1); colorProbe.fillStyle = '#000'; colorProbe.fillStyle = c;
    colorProbe.fillRect(0, 0, 1, 1);
    return [...colorProbe.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const pa = rgb(a), pb = rgb(b);
  return 'rgb(' + pa.map((v, i) => Math.round(v * t + pb[i] * (1 - t))).join(',') + ')';
}

// meta.json (written by add-game.mjs) says where a game's data, sprite and tiles are.
async function loadMeta() {
  const r = await fetch('./meta.json');
  if (!r.ok) throw new Error(`meta.json: HTTP ${r.status}. Run add-game.mjs for this game`);
  return r.json();
}

async function loadGame(entry) {
  state.entry = entry;
  state.folder = '.'; // data files sit next to the page
  applyTheme(entry.theme);
  $('#game-title').textContent = entry.title;
  document.title = `${entry.title} · Verticordia Atlas`;
  $('#tag-label').textContent = entry.tagLabel || 'Filter';

  let meta, data, spriteDefs, spriteImg, spriteFile;
  try {
    meta = await loadMeta();
    const m = meta.maps[0]; // TODO: a map switcher for games with several maps
    state.mapInfo = m;
    const mk = meta.markers;
    // prefer the @2x sprite when the game has one: markers look sharper on phones
    spriteFile = mk.png2x && mk.json2x ? { json: mk.json2x, png: mk.png2x } : { json: mk.json, png: mk.png };
    [data, spriteDefs] = await Promise.all([
      fetchJSON(`${state.folder}/${m.data}`),
      fetchJSON(`${state.folder}/${spriteFile.json}`),
    ]);
    spriteImg = await loadImage(`${state.folder}/${spriteFile.png}`);
  } catch (e) { return fatal(e.message + ' (check the files next to this page)'); }

  state.data = data;
  state.sprite = { defs: spriteDefs, img: spriteImg, png: spriteFile.png };

  // categories and groups
  const catById = new Map(Object.values(data.categories).map(c => [c.id, c]));
  state.cats = catById;
  state.groups = [...data.groups].sort((a, b) => a.order - b.order).map(g => {
    const ids = (g.categories || []).map(c => c.id);
    const cats = (ids.length ? ids.map(id => catById.get(id)) : [...catById.values()].filter(c => c.group_id === g.id))
      .filter(Boolean).sort((a, b) => a.order - b.order);
    return { id: g.id, title: g.title, col: vivid(g.color), cats };
  });
  const groupOfCat = new Map();
  state.groups.forEach(g => g.cats.forEach(c => groupOfCat.set(c.id, g)));
  state.groupOfCat = groupOfCat;

  // locations
  state.locs = data.locations.map(l => ({
    id: l.id, cat: l.category_id, title: l.title || '', desc: l.description || '',
    lat: parseFloat(l.latitude), lng: parseFloat(l.longitude),
    tags: l.tags || [], media: l.media || [],
    icon: catById.get(l.category_id)?.icon,
  })).filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  state.byId = new Map(state.locs.map(l => [l.id, l]));
  buildLinkIndex();
  state.tags = [...(data.tags || [])].sort((a, b) => a.id - b.id);

  // view settings
  const v = (await getMeta('view:' + entry.id)) || {};
  state.view.hidden = new Set(v.hidden || []);
  state.view.hideFound = !!v.hideFound;
  state.view.collapsed = new Set(v.collapsed || []);
  $('#hide-found').checked = state.view.hideFound;
  state.presets = (await getMeta('presets:' + entry.id)) || [];
  state.presetId = state.presets.some(p => p.id === v.presetId) ? v.presetId : null;
  state.baseline = state.presetId && Array.isArray(v.baseline) ? v.baseline : null;
  renderPresets();

  // difficulty / tag selector
  const tagField = $('#tag-field');
  tagField.hidden = state.tags.length === 0;
  syncTagStrict();
  // "Everything" (value "") shows every marker, including ones carrying a tag; it is the default
  $('#tag-select').innerHTML = '<option value="">Everything</option><option value="' + UNTAGGED + '">Only untagged</option>' + state.tags.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');

  await loadProfiles();
  buildSidebar();
  createMap();
}

/* ---------- profiles ---------- */

// tag filter value for "only markers with no tag" (tag ids are numbers, so this cannot clash)
const UNTAGGED = 'untagged';

// the "only this tag" switch means nothing under "Everything", so it is dimmed then (and only shows a hint)
function syncTagStrict() {
  const btn = $('#tag-strict');
  $('#tag-row').hidden = !state.tags.length;
  btn.setAttribute('aria-pressed', String(tagOnly()));
  btn.setAttribute('aria-disabled', String(!tagSwitchUsable()));
}

// a tap toggles the switch; holding it down shows the description instead (the hover bubble is CSS)
{
  let pressTimer, tipTimer, held = false;
  const showTip = btn => {
    btn.classList.add('tip');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => btn.classList.remove('tip'), 1800);
  };
  const btn = $('#tag-strict');
  btn.addEventListener('pointerdown', e => {
    held = false;
    if (e.pointerType === 'mouse') return; // mouse users get the hover bubble
    pressTimer = setTimeout(() => { held = true; showTip(btn); }, 450);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => btn.addEventListener(t, () => clearTimeout(pressTimer)));
  btn.addEventListener('click', () => {
    if (held) { held = false; return; }
    if (!tagSwitchUsable()) { showTip(btn); return; }
    state.tagStrict = !state.tagStrict;
    syncTagStrict();
    saveProfileNow();
    refreshAll();
  });
}

function makeProfile(name, tag) {
  const id = uid();
  return { key: `${state.entry.id}:${id}`, id, game: state.entry.id, name, tag, found: [], created: Date.now(), updated: Date.now() };
}

async function loadProfiles() {
  state.profiles = (await dbAll('profiles')).filter(p => p.game === state.entry.id)
    .sort((a, b) => a.created - b.created);
  if (!state.profiles.length) {
    const p = makeProfile('Default', null);
    await dbPut('profiles', p);
    state.profiles = [p];
  }
  const last = await getMeta('last-profile:' + state.entry.id);
  applyProfile(state.profiles.find(p => p.id === last) || state.profiles[0]);
}

function applyProfile(p) {
  state.profile = p;
  state.drawing?.reset(); // drawings belong to the profile: each one has its own undo history
  state.found = new Set(p.found || []);
  state.tag = state.tags.length ? (p.tag ?? null) : null;
  state.tagStrict = !!p.tagStrict;
  renderProfileSelect();
  if (state.tags.length) $('#tag-select').value = state.tag == null ? '' : String(state.tag);
  syncTagStrict();
}

function renderProfileSelect() {
  const sel = $('#profile-select');
  sel.innerHTML = state.profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = state.profile.id;
}

let saveTimer;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveProfileNow, 200); }
async function saveProfileNow() {
  clearTimeout(saveTimer);
  const p = state.profile;
  if (!p) return;
  p.found = [...state.found];
  p.tag = state.tag;
  p.tagStrict = state.tagStrict;
  p.updated = Date.now();
  try { await dbPut('profiles', p); }
  catch (e) { console.error(e); toast('Could not save progress in this browser.'); }
}
let viewTimer;
function scheduleViewSave() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => setMeta('view:' + state.entry.id, {
    hidden: [...state.view.hidden], hideFound: state.view.hideFound, collapsed: [...state.view.collapsed],
    presetId: state.presetId, baseline: state.baseline,
  }).catch(() => {}), 250);
}

async function switchProfile(id) {
  await saveProfileNow();
  const p = state.profiles.find(x => x.id === id);
  if (!p) return;
  applyProfile(p);
  await setMeta('last-profile:' + state.entry.id, p.id).catch(() => {});
  refreshAll();
}

async function profileAction(act) {
  const p = state.profile;
  if (act === 'new') {
    const name = await askDialog({ title: 'New profile', message: 'One profile per save file keeps found markers separate.', value: `Playthrough ${state.profiles.length + 1}`, okLabel: 'Create' });
    if (!name) return;
    await saveProfileNow();
    const np = makeProfile(name, state.tag);
    await dbPut('profiles', np);
    state.profiles.push(np);
    await switchProfile(np.id);
  } else if (act === 'rename') {
    const name = await askDialog({ title: 'Rename profile', value: p.name, okLabel: 'Rename' });
    if (!name) return;
    p.name = name; await saveProfileNow(); renderProfileSelect();
  } else if (act === 'reset') {
    const ok = await askDialog({ title: 'Clear found markers?', message: `Every marker in "${p.name}" will be unmarked.`, okLabel: 'Clear', danger: true });
    if (!ok) return;
    state.found.clear(); await saveProfileNow(); refreshAll();
  } else if (act === 'delete') {
    const ok = await askDialog({ title: 'Delete profile?', message: `"${p.name}" and its found markers will be removed from this browser.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    await dbDelete('profiles', p.key);
    state.profiles = state.profiles.filter(x => x.id !== p.id);
    if (!state.profiles.length) {
      const np = makeProfile('Default', null);
      await dbPut('profiles', np); state.profiles.push(np);
    }
    state.profile = null;
    applyProfile(state.profiles[0]);
    await setMeta('last-profile:' + state.entry.id, state.profile.id).catch(() => {});
    refreshAll();
  } else if (act === 'export') {
    await saveProfileNow();
    const payload = {
      app: 'offline-map-viewer', version: 1, game: state.entry.id, exported: new Date().toISOString(),
      profiles: state.profiles.map(({ id, name, tag, found, created, updated, drawings }) => ({ id, name, tag, found, created, updated, drawings: drawings || [] })),
      presets: state.presets.map(({ id, name, hidden }) => ({ id, name, hidden })),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    a.download = `${state.entry.id}-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } else if (act === 'import') {
    $('#import-file').click();
  }
}

async function importFile(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'offline-map-viewer' || !Array.isArray(payload.profiles)) throw new Error('not a progress file');
    if (payload.game !== state.entry.id) throw new Error(`this file is for "${payload.game}", not "${state.entry.id}"`);
    const presets = Array.isArray(payload.presets) ? payload.presets.filter(p => p && p.id && Array.isArray(p.hidden)) : [];
    const ok = await askDialog({ title: 'Import progress?', message: `${payload.profiles.length} profile(s) and ${presets.length} preset(s) will be added. Items with the same id are replaced.`, okLabel: 'Import' });
    if (!ok) return;
    await saveProfileNow();
    for (const q of payload.profiles) {
      if (!q.id || !Array.isArray(q.found)) continue;
      const rec = { key: `${state.entry.id}:${q.id}`, id: q.id, game: state.entry.id, name: String(q.name || 'Imported'), tag: q.tag ?? null,
        found: q.found.filter(Number.isFinite), drawings: Array.isArray(q.drawings) ? q.drawings : [], created: q.created || Date.now(), updated: Date.now() };
      await dbPut('profiles', rec);
      const at = state.profiles.findIndex(x => x.id === rec.id);
      if (at >= 0) state.profiles[at] = rec; else state.profiles.push(rec);
    }
    for (const q of presets) {
      const rec = { id: String(q.id), name: String(q.name || 'Imported'), hidden: q.hidden.filter(Number.isFinite) };
      const at = state.presets.findIndex(x => x.id === rec.id);
      if (at >= 0) state.presets[at] = rec; else state.presets.push(rec);
    }
    if (presets.length) await savePresets();
    const cur = state.profiles.find(x => x.id === state.profile.id) || state.profiles[0];
    applyProfile(cur);
    refreshAll();
    renderPresets();
    toast('Progress imported.');
  } catch (e) { toast('Import failed: ' + e.message, 5000); }
}

/* ---------- filtering and stats ---------- */

// with a tag selected, untagged markers are shown unless "only markers with this tag" is on
const applicable = l => {
  if (state.tag == null) return true;
  if (state.tag === UNTAGGED) return l.tags.length === 0;
  return l.tags.includes(state.tag) || (!state.tagStrict && l.tags.length === 0);
};
const shownOnMap = l => applicable(l) && !state.view.hidden.has(l.cat) && !(state.view.hideFound && state.found.has(l.id));

function computeStats() {
  const st = new Map();
  for (const l of state.locs) {
    if (!applicable(l)) continue;
    let s = st.get(l.cat);
    if (!s) st.set(l.cat, s = { total: 0, found: 0 });
    s.total++;
    if (state.found.has(l.id)) s.found++;
  }
  state.stats = st;
}

/* ---------- sidebar ---------- */

function iconHtml(name) {
  const d = state.sprite.defs[name];
  if (!d) return '';
  const s = 28 / d.height;
  return `<span class="ico" style="width:${d.width}px;height:${d.height}px;background-image:url('${state.folder}/${state.sprite.png}');` +
    `background-position:-${d.x}px -${d.y}px;transform:scale(${s})"></span>`;
}

// Desktop only: hides the left panel so the map takes the full width.
function setSideCollapsed(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  const b = $('#side-collapse');
  b.textContent = collapsed ? '\u00bb' : '\u00ab';
  const label = collapsed ? 'Show panel' : 'Hide panel';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-expanded', String(!collapsed));
}

function buildSidebar() {
  const root = $('#groups');
  root.textContent = '';
  state.ui = { groups: new Map(), cats: new Map(), segs: new Map() };
  const bar = $('#progress-bar');
  bar.textContent = '';

  for (const g of state.groups) {
    const seg = document.createElement('div');
    seg.className = 'seg'; seg.style.setProperty('--c', g.col); seg.title = g.title;
    seg.innerHTML = '<i></i>';
    bar.appendChild(seg);
    state.ui.segs.set(g.id, seg);

    const el = document.createElement('section');
    el.className = 'group' + (state.view.collapsed.has(g.id) ? ' collapsed' : '');
    el.style.setProperty('--c', g.col);
    el.innerHTML =
      `<div class="group-head">${menuBtnHtml(g.title)}<button class="name" type="button">${esc(g.title)}</button>` +
      `<span class="tally"></span><input type="checkbox" class="g-toggle" aria-label="Show all in ${esc(g.title)}"></div>` +
      `<div class="cats"></div>`;
    const catsEl = el.querySelector('.cats');
    const gToggle = el.querySelector('.g-toggle');
    el.querySelector('.name').onclick = () => {
      el.classList.toggle('collapsed');
      el.classList.contains('collapsed') ? state.view.collapsed.add(g.id) : state.view.collapsed.delete(g.id);
      scheduleViewSave();
    };
    gToggle.onchange = () => {
      for (const c of g.cats) gToggle.checked ? state.view.hidden.delete(c.id) : state.view.hidden.add(c.id);
      onViewChanged();
    };
    el.querySelector('.group-head').oncontextmenu = e => { e.preventDefault(); showOnly(g.cats.map(c => c.id)); };
    el.querySelector('.row-menu-btn').onclick = e => openRowMenu(e, { title: g.title, color: g.col, cats: g.cats });

    const rows = [];
    for (const c of g.cats) {
      const row = document.createElement('label');
      row.className = 'cat-row';
      if (c.info) row.title = c.info;
      row.innerHTML = `${menuBtnHtml(c.title)}<span class="ico-wrap">${iconHtml(c.icon)}</span><span class="label">${esc(c.title)}</span><span class="tally"></span><input type="checkbox">`;
      const cb = row.querySelector('input');
      cb.onchange = () => { cb.checked ? state.view.hidden.delete(c.id) : state.view.hidden.add(c.id); onViewChanged(); };
      row.oncontextmenu = e => { e.preventDefault(); showOnly([c.id]); };
      row.querySelector('.row-menu-btn').onclick = e => openRowMenu(e, { title: c.title, icon: c.icon, cats: [c] });
      catsEl.appendChild(row);
      rows.push({ c, row, cb, tally: row.querySelector('.tally') });
      state.ui.cats.set(c.id, rows[rows.length - 1]);
    }
    state.ui.groups.set(g.id, { g, el, gToggle, tally: el.querySelector('.group-head .tally'), rows });
    root.appendChild(el);
  }
}

const menuBtnHtml = name => `<button type="button" class="row-menu-btn" aria-haspopup="menu" aria-label="Actions for ${esc(name)}" title="Actions">` +
  '<svg viewBox="0 0 4 16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg></button>';

// Pop-up for a whole category or group: mark every rendering marker in it found or not found.
let rowMenuBtn = null;
function rowMenuEl() {
  let el = document.getElementById('row-menu');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'row-menu'; el.className = 'menu row-menu'; el.hidden = true; el.setAttribute('role', 'menu');
  el.innerHTML = '<div class="rm-head"></div><hr><button type="button" role="menuitem" data-act="found">Mark all as found</button>' +
    '<button type="button" role="menuitem" data-act="unfound">Mark all as not found</button>';
  el.onclick = e => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled || !el._cats) return;
    const locs = rowLocs(el._cats);
    for (const l of locs) b.dataset.act === 'found' ? state.found.add(l.id) : state.found.delete(l.id);
    closeRowMenu();
    saveProfileNow();
    refreshAll();
  };
  document.body.appendChild(el);
  return el;
}

// the markers a row covers right now: all its categories, filtered by the tag selection
function rowLocs(cats) {
  const ids = new Set(cats.map(c => c.id));
  return state.locs.filter(l => ids.has(l.cat) && applicable(l));
}

function openRowMenu(e, { title, icon, color, cats }) {
  e.preventDefault(); e.stopPropagation();
  const btn = e.currentTarget;
  const el = rowMenuEl();
  if (rowMenuBtn === btn && !el.hidden) return closeRowMenu();
  const locs = rowLocs(cats);
  const found = locs.filter(l => state.found.has(l.id)).length;
  const head = icon
    ? `<span class="ico-wrap">${iconHtml(icon)}</span>`
    : `<span class="rm-dot" style="--c:${esc(color || '#888')}"></span>`;
  const kind = icon ? 'Category' : 'Group';
  el.querySelector('.rm-head').innerHTML = `${head}<div class="rm-text"><div class="rm-title">${esc(title)}</div>` +
    `<div class="rm-sub">${kind} · ${locs.length ? `${found}/${locs.length} found` : 'No markers shown'}</div></div>`;
  el._cats = cats;
  el.querySelectorAll('button[data-act]').forEach(b => { b.disabled = locs.length === 0; });
  rowMenuBtn = btn;
  btn.setAttribute('aria-expanded', 'true');
  el.hidden = false;
  const r = btn.getBoundingClientRect(), pad = 8;
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.right + 8;
  if (left + w > innerWidth - pad) left = Math.max(pad, r.left - w - 8);
  el.style.left = left + 'px';
  el.style.top = Math.max(pad, Math.min(r.top, innerHeight - h - pad)) + 'px';
}

function closeRowMenu() {
  const el = document.getElementById('row-menu');
  if (el) { el.hidden = true; el._cats = null; }
  if (rowMenuBtn) rowMenuBtn.setAttribute('aria-expanded', 'false');
  rowMenuBtn = null;
}

// Right-click on a category or group: show only those categories, hide everything else.
function showOnly(ids) {
  const keep = new Set(ids);
  for (const id of state.cats.keys()) keep.has(id) ? state.view.hidden.delete(id) : state.view.hidden.add(id);
  onViewChanged();
}

function updateSidebar() {
  computeStats();
  let total = 0, found = 0;
  for (const { g, gToggle, tally, rows } of state.ui.groups.values()) {
    let gt = 0, gf = 0, shown = 0, visibleRows = 0;
    for (const { c, row, cb, tally: t } of rows) {
      const s = state.stats.get(c.id) || { total: 0, found: 0 };
      row.hidden = s.total === 0;
      cb.checked = !state.view.hidden.has(c.id);
      row.classList.toggle('off', !cb.checked);
      t.textContent = `${s.found}/${s.total}`;
      t.classList.toggle('done', s.total > 0 && s.found === s.total);
      if (s.total) { visibleRows++; if (cb.checked) shown++; }
      gt += s.total; gf += s.found;
    }
    tally.textContent = `${gf}/${gt}`;
    gToggle.checked = visibleRows > 0 && shown === visibleRows;
    gToggle.indeterminate = shown > 0 && shown < visibleRows;
    gToggle.hidden = visibleRows === 0;
    const seg = state.ui.segs.get(g.id);
    seg.style.flexGrow = String(Math.max(gt, 0.0001));
    seg.firstChild.style.width = gt ? (100 * gf / gt) + '%' : '0';
    total += gt; found += gf;
  }
  $('#found-count').textContent = fmt(found);
  $('#total-count').textContent = fmt(total);
}

function onViewChanged() {
  scheduleViewSave();
  updateSidebar();
  refreshMap();
  renderPresets();
}

/* ---------- selection presets (which categories are on/off) ---------- */

const presetsKey = () => 'presets:' + state.entry.id;
const savePresets = () => setMeta(presetsKey(), state.presets).catch(() => toast('Could not save presets in this browser.'));
const presetById = id => state.presets.find(p => p.id === id) || null;
const currentPreset = () => presetById(state.presetId);

// With the tag switch on, a category only counts as selected if some of its markers render under the tag.
// Presets are saved and compared on that basis, so non-rendering categories are stored as unselected.
const tagSwitchUsable = () => state.tag != null && state.tag !== UNTAGGED; // the switch only narrows a specific tag
const tagOnly = () => tagSwitchUsable() && !!state.tagStrict;
function renderedCatIds() {
  const ids = new Set();
  for (const l of state.locs) if (applicable(l)) ids.add(l.cat);
  return ids;
}
function selectedIn(hiddenIds) {
  const h = new Set(hiddenIds), rendered = tagOnly() ? renderedCatIds() : null;
  return new Set([...state.cats.keys()].filter(id => !h.has(id) && (!rendered || rendered.has(id))));
}
// what a preset stores for the given hidden set
function presetHidden(hiddenIds) {
  if (!tagOnly()) return [...hiddenIds];
  const sel = selectedIn(hiddenIds);
  return [...state.cats.keys()].filter(id => !sel.has(id));
}

function matchesView(p) {
  const a = selectedIn(p.hidden), b = selectedIn(state.view.hidden);
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// The selected preset stays selected while it is edited (shown as modified). It is only replaced when
// the current selection exactly matches a different preset, or when the selected preset no longer exists.
function syncPresetSelection() {
  const cur = currentPreset();
  if (cur && matchesView(cur)) return;
  if (!cur) state.presetId = null;
  const same = state.presets.find(matchesView);
  if (same) state.presetId = same.id;
}

function applyPreset(p) {
  if (!state.presetId) state.baseline = [...state.view.hidden]; // remember how things were before any preset
  state.presetId = p.id;
  state.view.hidden = new Set(p.hidden);
  onViewChanged();
}

// Leaves the preset and returns to the selection from before it was first picked (or keeps the current
// selection when there was none). Does not auto-match a preset, so "No preset" sticks.
function exitPreset() {
  if (state.baseline) state.view.hidden = new Set(state.baseline);
  state.presetId = null;
  state.baseline = null;
  updateSidebar();
  refreshMap();
  scheduleViewSave();
  renderPresets({ sync: false });
}

function renderPresets({ sync = true } = {}) {
  if (!state.entry) return;
  if (sync) syncPresetSelection();
  if (!state.presetId) state.baseline = null;
  const cur = currentPreset();
  const modified = !!cur && !matchesView(cur);

  const sel = $('#preset-select');
  const first = cur ? 'No preset' : 'Choose a preset…';
  sel.innerHTML = `<option value="">${first}</option>` + state.presets.map(p => {
    const sel1 = p.id === state.presetId;
    const dot = sel1 && modified ? 'modified' : 'clean';
    return `<option value="${esc(p.id)}"${sel1 && modified ? ' class="modified"' : ''}>` +
      `<span class="dot ${dot}"></span>${esc(p.name)}</option>`;
  }).join('');
  sel.value = state.presetId ?? '';
  sel.classList.toggle('modified', modified);
  sel.classList.toggle('has-status', !!cur);

  const status = $('#preset-status');
  status.hidden = !cur;
  status.className = 'dot preset-status ' + (modified ? 'modified' : 'clean');

  $('#preset-bar').hidden = !modified;
  document.querySelectorAll('#preset-menu [data-needs-preset]').forEach(b => { b.disabled = !cur; });
}

async function presetAction(act) {
  if (act === 'save') {
    const name = await askDialog({ title: 'Save selection', message: 'Stores which categories are on and off.', value: `Selection ${state.presets.length + 1}`, okLabel: 'Save' });
    if (!name) return;
    const np = { id: uid(), name, hidden: presetHidden(state.view.hidden) };
    state.presets.push(np);
    state.presetId = np.id;
    await savePresets(); renderPresets();
    toast('Preset saved.');
    return;
  }
  const p = currentPreset();
  if (!p) return;
  if (act === 'overwrite') {
    p.hidden = presetHidden(state.view.hidden);
    await savePresets(); renderPresets();
    toast('Preset overwritten.');
  } else if (act === 'revert') {
    applyPreset(p);
  } else if (act === 'rename') {
    const name = await askDialog({ title: 'Rename preset', value: p.name, okLabel: 'Rename' });
    if (!name) return;
    p.name = name;
    await savePresets(); renderPresets();
  } else if (act === 'delete') {
    const ok = await askDialog({ title: 'Delete preset?', message: `"${p.name}" will be removed from this browser.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    state.presets = state.presets.filter(x => x.id !== p.id);
    await savePresets();
    exitPreset();
  }
}

function refreshAll() {
  updateSidebar();
  renderPresets(); // the tag and its switch change which categories count as selected
  refreshMap();
  state.drawing?.render();
  if (!$('#results').hidden) runSearch();
  if (state.selected != null) renderDetail();
}

/* ---------- map ---------- */

const ICON_STOPS = [[8, 0.5], [11, 0.7], [13, 0.9], [15, 1]];
function iconScale(z) {
  if (z <= ICON_STOPS[0][0]) return ICON_STOPS[0][1];
  for (let i = 1; i < ICON_STOPS.length; i++) {
    const [z1, s1] = ICON_STOPS[i];
    if (z <= z1) { const [z0, s0] = ICON_STOPS[i - 1]; return s0 + (s1 - s0) * (z - z0) / (z1 - z0); }
  }
  return 1;
}

const emptyFC = { type: 'FeatureCollection', features: [] };

function createMap() {
  const data = state.data, cfg = data.mapConfig;
  const ts = state.mapInfo.tilesets[0]; // { template, minzoom, maxzoom (stored tiles), viewMaxzoom, bounds }
  const [w, s, e, n] = ts.bounds || data.styles?.mapStyle?.bounds || [-180, -85, 180, 85];
  const pad = 0.25;

  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': themeVar('night') } }] },
    center: [cfg.start_lng, cfg.start_lat],
    zoom: cfg.initial_zoom ?? 11,
    minZoom: ts.minzoom ?? 0,
    maxZoom: ts.viewMaxzoom ?? ts.maxzoom ?? 18,
    maxBounds: [[w - pad, s - pad], [e + pad, n + pad]],
    attributionControl: false,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    fadeDuration: 0,
  });
  state.map = map;
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  const tools = setupSelection(map);
  state.drawing = setupDrawing({ map, mapEl: map.getContainer(), canvasBox: map.getCanvasContainer(), getProfile: () => state.profile, onChange: () => scheduleSave(), requestTool: t => tools.setTool(t), renderMd });

  map.on('load', () => {
    // marker icons cropped out of the sprite sheet
    for (const [name, d] of Object.entries(state.sprite.defs)) {
      const c = document.createElement('canvas');
      c.width = d.width; c.height = d.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(state.sprite.img, d.x, d.y, d.width, d.height, 0, 0, d.width, d.height);
      map.addImage(name, ctx.getImageData(0, 0, d.width, d.height), { pixelRatio: d.pixelRatio || 1 });
    }

    // tiles sit where meta.json says (the original site's {z}/{y}/{x} order); zooming past the stored ones just enlarges them
    map.addSource('base', {
      // resolve only the folder: running the template through new URL() would escape the {z}/{y}/{x} placeholders
      type: 'raster', tiles: [new URL(state.folder + '/', document.baseURI).href + ts.template], tileSize: ts.tileSize || 256,
      minzoom: ts.minzoom ?? 0, maxzoom: ts.maxzoom ?? 18,
      bounds: [w, s + 0.001, e - 0.001, n],
    });
    map.addLayer({ id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 0 } });

    map.addSource('sel', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'sel', type: 'circle', source: 'sel',
      paint: { 'circle-radius': 21, 'circle-color': themeVar('accent'), 'circle-opacity': 0.22, 'circle-stroke-color': themeVar('accent-soft'), 'circle-stroke-width': 2.5, 'circle-translate': [0, -17] },
    });

    // arrowhead images: forward links use the accent colour, backreferences the dimmer one
    const arrowImage = (name, fill) => {
      const ac = document.createElement('canvas');
      ac.width = ac.height = 24;
      const actx = ac.getContext('2d');
      actx.beginPath(); actx.moveTo(12, 2); actx.lineTo(21, 21); actx.lineTo(3, 21); actx.closePath();
      actx.fillStyle = fill; actx.strokeStyle = themeVar('night'); actx.lineWidth = 2.5; actx.lineJoin = 'round';
      actx.fill(); actx.stroke();
      map.addImage(name, actx.getImageData(0, 0, 24, 24), { pixelRatio: 2 });
    };
    arrowImage('link-arrow', themeVar('accent-soft'));
    arrowImage('backlink-arrow', themeVar('backlink'));

    // arrows from the selected location to the locations its description links to
    map.addSource('links', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'links', type: 'line', source: 'links',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': themeVar('accent-soft'), 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [2, 1.5] },
    });

    // the reverse: locations whose description links to the selected one (only where the link is not two-way)
    map.addSource('backlinks', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'backlinks', type: 'line', source: 'backlinks',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': themeVar('backlink'), 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [2, 1.5] },
    });

    map.addSource('locs', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'locs', type: 'symbol', source: 'locs',
      layout: {
        'icon-image': ['get', 'icon'], 'icon-anchor': 'bottom',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], ...ICON_STOPS.flat()],
        'symbol-sort-key': ['get', 'z'],
      },
      paint: { 'icon-opacity': ['case', ['==', ['get', 'f'], 1], 0.4, 1] },
    });

    map.addSource('link-heads', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'link-heads', type: 'symbol', source: 'link-heads',
      layout: {
        'icon-image': 'link-arrow', 'icon-size': 0.6, 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    map.addSource('backlink-heads', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'backlink-heads', type: 'symbol', source: 'backlink-heads',
      layout: {
        'icon-image': 'backlink-arrow', 'icon-size': 0.6, 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });

    state.mapReady = true;
    updateSidebar();
    refreshMap();
    const m = /^#loc=(\d+)/.exec(location.hash);
    if (m && state.byId.has(+m[1])) {
      // a shared link starts a stack of its own: the page entry underneath is the bottom of it
      history.replaceState(null, '', location.pathname + location.search);
      select(+m[1], { fly: true });
    }
  });

  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'tip', anchor: 'bottom' });
  map.on('mousemove', 'locs', ev => {
    if (state.tool !== 'pan') return;
    const f = ev.features && ev.features[0];
    if (!f) return;
    const l = state.byId.get(Number(f.properties.id));
    if (!l) return;
    map.getCanvas().style.cursor = 'pointer';
    tip.setLngLat([l.lng, l.lat]).setOffset([0, -(44 * iconScale(map.getZoom())) - 6])
      .setText(l.title + (state.found.has(l.id) ? ' (found)' : '')).addTo(map);
  });
  map.on('mouseleave', 'locs', () => { map.getCanvas().style.cursor = ''; tip.remove(); });
  map.on('move', updateLinkHeads);

  map.on('click', ev => {
    if (state.tool !== 'pan') return; // markers cannot be clicked while selecting or drawing
    document.body.classList.remove('side-open');
    const hits = map.queryRenderedFeatures(ev.point, { layers: ['locs'] });
    if (hits.length) select(Number(hits[0].properties.id), { fly: false });
    else closeDetail();
  });
}

function refreshMap() {
  if (!state.mapReady) return;
  const feats = [];
  for (const l of state.locs) {
    if (!shownOnMap(l)) continue;
    const f = state.found.has(l.id) ? 1 : 0;
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lng, l.lat] }, properties: { id: l.id, icon: l.icon, f, z: f ? 0 : 1 } });
  }
  state.map.getSource('locs').setData({ type: 'FeatureCollection', features: feats });
}

/* ---------- map tools: hand (move the map) and selection (box, ellipse, free) ----------
   A selection lives in map coordinates (so it moves and zooms with the map) and is not saved: it is
   forgotten on reload. Counting and marking use the markers that are currently rendered inside it. */

const SHAPE_NAMES = { box: 'Box select', ellipse: 'Ellipse select', free: 'Free select' };
const SHAPE_ICONS = {
  box: '<rect x="4" y="6" width="16" height="12" rx="1" stroke-dasharray="2.5 2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6" stroke-dasharray="2.5 2"/>',
  free: '<path d="M5 9c1.5-3 5-4 7-2s4-1.5 6 .5 1 6-2 6.5-3-2-5 0-4 2.5-6 1-4.5-.5-3-3.5z" stroke-dasharray="2.5 2"/>',
};
const HAND_ICON = '<path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/>' +
  '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>';

// Shape geometry in screen pixels. `to` converts one stored point to a screen point.
function geomOf(s, to) {
  if (s.shape === 'free') return { shape: 'free', pts: s.pts.map(to) };
  const [a, b] = s.pts.map(to);
  if (s.shape === 'box') return { shape: 'box', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  if (s.circle) { const r = Math.hypot(b.x - a.x, b.y - a.y); return { shape: 'ellipse', cx: a.x, cy: a.y, rx: r, ry: r }; }
  return { shape: 'ellipse', cx: a.x, cy: a.y, rx: Math.abs(b.x - a.x), ry: Math.abs(b.y - a.y) };
}

function insideGeom(g, x, y) {
  if (g.shape === 'box') return x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
  if (g.shape === 'ellipse') return g.rx > 0 && g.ry > 0 && ((x - g.cx) / g.rx) ** 2 + ((y - g.cy) / g.ry) ** 2 <= 1;
  // free: even-odd ray casting; the outline closes itself back to the first point
  let inside = false;
  const p = g.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i].y > y) !== (p[j].y > y) && x < (p[j].x - p[i].x) * (y - p[i].y) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
  }
  return inside;
}

function setupSelection(map) {
  const canvasBox = map.getCanvasContainer();
  const mapEl = map.getContainer();
  const proj = q => map.project([q.lng, q.lat]);
  const localPos = e => { const r = canvasBox.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // --- controls under the zoom buttons: hand above selection; the selection button's notch shows it has a flyout
  map.addControl({
    onAdd() {
      const c = document.createElement('div');
      c.className = 'maplibregl-ctrl maplibregl-ctrl-group tool-ctrl';
      c.innerHTML = `<button type="button" id="tool-pan" title="Move the map" aria-label="Move the map">` +
        `<svg viewBox="0 0 24 24" aria-hidden="true">${HAND_ICON}</svg></button>` +
        `<button type="button" id="tool-select" class="notched" title="Select markers. Right-click or hold for shapes" aria-label="Selection tool">` +
        `<svg viewBox="0 0 24 24" aria-hidden="true"></svg></button>` + DRAW_CONTROLS_HTML;
      return c;
    },
    onRemove() {},
  }, 'top-right');
  const panBtn = document.getElementById('tool-pan');
  const selBtn = document.getElementById('tool-select');

  const shapeMenu = document.createElement('div');
  shapeMenu.id = 'shape-menu'; shapeMenu.className = 'menu row-menu'; shapeMenu.hidden = true; shapeMenu.setAttribute('role', 'menu');
  shapeMenu.innerHTML = Object.entries(SHAPE_NAMES).map(([k, v]) =>
    `<button type="button" role="menuitemradio" data-shape="${k}" aria-checked="false">${v}</button>`).join('');
  document.body.appendChild(shapeMenu);

  const selMenu = document.createElement('div');
  selMenu.id = 'sel-menu'; selMenu.className = 'menu row-menu'; selMenu.hidden = true; selMenu.setAttribute('role', 'menu');
  selMenu.innerHTML = '<div class="rm-head"><div class="rm-text"><div class="rm-title">Selection</div><div class="rm-sub"></div></div></div><hr>' +
    '<button type="button" role="menuitem" data-act="found">Mark all as found</button>' +
    '<button type="button" role="menuitem" data-act="unfound">Mark all as not found</button>';
  document.body.appendChild(selMenu);

  // the drawn shapes, above the map canvas
  const NS = 'http://www.w3.org/2000/svg';
  const overlay = document.createElementNS(NS, 'svg');
  overlay.setAttribute('class', 'sel-overlay');
  mapEl.appendChild(overlay);

  // --- tool state
  function setTool(t) {
    state.tool = t;
    t === 'pan' ? map.dragPan.enable() : map.dragPan.disable();
    t === 'pan' ? map.doubleClickZoom.enable() : map.doubleClickZoom.disable();
    t === 'pan' ? map.boxZoom.enable() : map.boxZoom.disable();
    mapEl.classList.toggle('tool-select', t === 'select');
    panBtn.setAttribute('aria-pressed', String(t === 'pan'));
    selBtn.setAttribute('aria-pressed', String(t === 'select'));
    selBtn.querySelector('svg').innerHTML = SHAPE_ICONS[state.shape];
    if (state.drawing) state.drawing.setActive(t === 'draw');
    selBtn.setAttribute('aria-label', `Selection tool: ${SHAPE_NAMES[state.shape]}`);
  }
  state.tool = 'pan';
  setTool('pan');

  // --- menus
  function closeToolMenus() { shapeMenu.hidden = true; selMenu.hidden = true; }
  // places a menu at (x, y): to the lower right of it, or to the left when `left` is set; flips to stay on screen
  function placeMenu(el, x, y, left = false) {
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight, pad = 8;
    let lx = left ? x - w : x + 4;
    if (!left && lx + w > innerWidth - pad) lx = x - w - 4;
    lx = Math.max(pad, Math.min(lx, innerWidth - w - pad));
    const ty = Math.max(pad, Math.min(y, innerHeight - h - pad));
    el.style.left = lx + 'px';
    el.style.top = ty + 'px';
  }

  function openShapeMenu(btn) {
    closeRowMenu();
    shapeMenu.querySelectorAll('[data-shape]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.shape === state.shape)));
    const r = btn.getBoundingClientRect();
    placeMenu(shapeMenu, r.left - 8, r.top, true);
  }
  shapeMenu.onclick = e => {
    const b = e.target.closest('[data-shape]');
    if (!b) return;
    state.shape = b.dataset.shape;
    closeToolMenus();
    setTool('select');
  };

  function markersInSelection() {
    if (!state.sel) return [];
    const g = geomOf(state.sel, proj);
    return state.locs.filter(l => { if (!shownOnMap(l)) return false; const q = map.project([l.lng, l.lat]); return insideGeom(g, q.x, q.y); });
  }
  function openSelMenu(x, y) {
    closeRowMenu();
    const n = markersInSelection().length;
    selMenu.querySelector('.rm-sub').textContent = n ? `${n} visible marker${n === 1 ? '' : 's'}` : 'No visible markers inside';
    selMenu.querySelectorAll('button[data-act]').forEach(b => { b.disabled = n === 0; });
    placeMenu(selMenu, x, y);
  }
  selMenu.onclick = e => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const found = b.dataset.act === 'found';
    for (const l of markersInSelection()) found ? state.found.add(l.id) : state.found.delete(l.id);
    closeToolMenus();
    saveProfileNow();
    refreshAll();
  };

  // --- the selection button: tap = selection tool; right-click or hold = shape menu
  let btnTimer = null, btnHeld = false;
  selBtn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    btnHeld = false;
    btnTimer = setTimeout(() => { btnHeld = true; openShapeMenu(selBtn); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => selBtn.addEventListener(t, () => clearTimeout(btnTimer)));
  selBtn.addEventListener('click', () => {
    if (btnHeld) { btnHeld = false; return; }
    if (state.tool === 'select') { // already on it: tap again to open its shapes
      if (shapeMenu.hidden) openShapeMenu(selBtn); else closeToolMenus();
      return;
    }
    closeToolMenus();
    setTool('select');
  });
  selBtn.addEventListener('contextmenu', e => { e.preventDefault(); openShapeMenu(selBtn); });
  panBtn.addEventListener('click', () => { closeToolMenus(); setTool('pan'); });

  // --- drawing on the map (select tool), and press-and-hold on the selection (both tools)
  const pointers = new Map();   // pointer id -> screen position, for detecting pinch gestures
  let press = null;             // { id, x, y, inside, timer, held, drawing }
  const selInside = p => !!state.sel && insideGeom(geomOf(state.sel, proj), p.x, p.y);

  function cancelDrag() { state.drag = null; if (press) { clearTimeout(press.timer); press = null; } renderSelection(); }

  canvasBox.addEventListener('pointerdown', e => {
    if (e.button !== 0 || state.tool === 'draw') return;
    pointers.set(e.pointerId, localPos(e));
    if (pointers.size > 1) { cancelDrag(); return; } // a second finger means pinch-zoom, not a selection
    const p = localPos(e);
    press = { id: e.pointerId, x: p.x, y: p.y, inside: selInside(p), timer: null, held: false, drawing: false };
    if (press.inside) {
      press.timer = setTimeout(() => { press.held = true; openSelMenu(e.clientX, e.clientY); }, 500);
    }
  });

  canvasBox.addEventListener('pointermove', e => {
    if (state.tool === 'draw') return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, localPos(e));
    if (!press || press.id !== e.pointerId || press.held || pointers.size > 1) return;
    const p = localPos(e);
    if (!press.drawing) {
      if (Math.hypot(p.x - press.x, p.y - press.y) < 4) return;
      clearTimeout(press.timer);
      if (state.tool !== 'select') return; // hand: the map is being dragged
      press.drawing = true;
      try { canvasBox.setPointerCapture(e.pointerId); } catch {}
      const shape = state.shape;
      state.drag = { shape, pts: [{ x: press.x, y: press.y }, p], circle: false };
      if (shape === 'free') state.drag.pts = [{ x: press.x, y: press.y }];
    }
    const d = state.drag;
    if (!d) return;
    if (d.shape === 'free') {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 3) d.pts.push(p);
    } else {
      const a = d.pts[0];
      let dx = p.x - a.x, dy = p.y - a.y;
      if (d.shape === 'box' && e.shiftKey) { // square: the longer side sets both
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = (dx < 0 ? -1 : 1) * s; dy = (dy < 0 ? -1 : 1) * s;
      }
      d.circle = d.shape === 'ellipse' && e.shiftKey;
      d.pts[1] = { x: a.x + dx, y: a.y + dy }; // for ellipses this is the rim point; the shift flag makes it a circle
    }
    renderSelection();
  });

  const endPointer = e => {
    pointers.delete(e.pointerId);
    if (!press || press.id !== e.pointerId) return;
    const p = press;
    press = null;
    clearTimeout(p.timer);
    if (p.held) return;
    if (p.drawing) { if (state.drag) commitDrag(); return; }
    // a tap: outside the selection it clears it (select tool only)
    if (e.type === 'pointerup' && state.tool === 'select' && state.sel && !p.inside) { state.sel = null; renderSelection(); }
  };
  canvasBox.addEventListener('pointerup', endPointer);
  canvasBox.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); if (press && press.id === e.pointerId) { clearTimeout(press.timer); press = null; } state.drag = null; renderSelection(); });

  function commitDrag() {
    const d = state.drag;
    state.drag = null;
    const toGeo = q => { const ll = map.unproject([q.x, q.y]); return { lng: ll.lng, lat: ll.lat }; };
    if (d.shape === 'free') {
      // any outline counts once it encloses some area; it closes itself back to the start
      let area = 0;
      for (let i = 0, j = d.pts.length - 1; i < d.pts.length; j = i++) area += (d.pts[j].x + d.pts[i].x) * (d.pts[j].y - d.pts[i].y);
      if (d.pts.length >= 3 && Math.abs(area) / 2 > 9) state.sel = { shape: 'free', pts: d.pts.map(toGeo) };
    } else {
      const [a, b] = d.pts;
      if (Math.abs(b.x - a.x) >= 3 || Math.abs(b.y - a.y) >= 3) state.sel = { shape: d.shape, pts: [toGeo(a), toGeo(b)], circle: d.circle };
    }
    renderSelection();
  }

  // right-click or long press on the selection: its menu
  canvasBox.addEventListener('contextmenu', e => {
    if (state.tool !== 'pan') e.preventDefault(); // no browser menu over the map while selecting or drawing
    if (selInside(localPos(e))) { e.preventDefault(); openSelMenu(e.clientX, e.clientY); }
  });

  // --- drawing the overlay
  function renderSelection() {
    const g = state.drag ? geomOf(state.drag, p => p) : state.sel ? geomOf(state.sel, proj) : null;
    overlay.textContent = '';
    if (!g) return;
    let el;
    if (g.shape === 'box') { el = document.createElementNS(NS, 'rect'); el.setAttribute('x', g.x); el.setAttribute('y', g.y); el.setAttribute('width', g.w); el.setAttribute('height', g.h); }
    else if (g.shape === 'ellipse') { el = document.createElementNS(NS, 'ellipse'); el.setAttribute('cx', g.cx); el.setAttribute('cy', g.cy); el.setAttribute('rx', g.rx); el.setAttribute('ry', g.ry); }
    else { el = document.createElementNS(NS, 'polygon'); el.setAttribute('points', g.pts.map(p => `${p.x},${p.y}`).join(' ')); }
    el.setAttribute('class', 'sel-shape');
    overlay.appendChild(el);
  }
  map.on('move', renderSelection);
  map.on('resize', renderSelection);

  // --- Escape clears the selection and closes its menus; clicks elsewhere close the menus
  document.addEventListener('keydown', e => {
    if (state.drawing?.keydown(e)) { e.preventDefault(); return; } // drawing first: it may own Esc, Enter or Ctrl+Z
    if (e.key !== 'Escape') return;
    const hadSomething = !shapeMenu.hidden || !selMenu.hidden || !!state.sel || !!state.drag;
    closeToolMenus();
    if (state.sel || state.drag) { state.sel = null; cancelDrag(); }
    // with nothing left to clear, Esc goes back to the hand
    else if (!hadSomething && state.tool !== 'pan') setTool('pan');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#shape-menu, #sel-menu, #tool-select')) closeToolMenus();
  });
  return { setTool };
}

/* ---------- detail panel ---------- */

/* ---------- navigation stack ----------
   The trail is the markers opened so far, the last one being the current one. Each push also adds a history
   entry ({ session, depth, loc }), so the device back button walks the trail. Closing the card starts a new
   session: old entries are then skipped over, so they can no longer walk back into the closed trail. */

function stackPush(id) {
  if (state.trail[state.trail.length - 1] === id) return;
  state.trail.push(id);
  history.pushState({ session: state.session, depth: state.trail.length, loc: id }, '', '#loc=' + id);
}

function goBack() {
  if (state.trail.length > 1) history.back(); // the popstate handler does the actual step
}

function onPopState(ev) {
  const s = ev.state;
  if (!s || !s.session) return dismiss(); // the page entry below the stack
  if (s.session !== state.session) {
    // an entry from a stack that was closed: jump to the page entry under that stack
    if (s.depth > 0) history.go(-s.depth);
    return;
  }
  state.trail.length = Math.min(state.trail.length, s.depth - 1);
  state.trail.splice(s.depth - 1, 1, s.loc);
  select(s.loc, { fly: true, push: false });
}

// Markers that the description links to, and the markers that link to this one.
function buildLinkIndex() {
  for (const l of state.locs) {
    const out = internalRefs(l.desc, l.id);
    state.outLinks.set(l.id, out);
    for (const t of out) {
      if (!state.inLinks.has(t)) state.inLinks.set(t, []);
      state.inLinks.get(t).push(l.id);
    }
  }
}

function linkedLocations(l) {
  return (state.outLinks.get(l.id) || []).map(id => state.byId.get(id));
}

// Locations that link to this one but are not linked back: a two-way link is already shown as a forward link.
function referrersOneWay(l) {
  const out = new Set(state.outLinks.get(l.id));
  return (state.inLinks.get(l.id) || []).filter(id => !out.has(id))
    .map(id => state.byId.get(id))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function select(id, { fly = true, push = true } = {}) {
  const l = state.byId.get(id);
  if (!l) return;
  if (push) stackPush(id);
  state.selected = id;
  if (applicable(l) && state.view.hidden.has(l.cat)) {
    state.view.hidden.delete(l.cat);
    scheduleViewSave(); updateSidebar(); refreshMap();
  }
  if (state.mapReady) {
    state.map.getSource('sel').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lng, l.lat] }, properties: {} }] });
    if (fly) {
      const padding = isMobile() ? { bottom: Math.round(innerHeight * 0.4) } : { right: 384 };
      state.map.flyTo({ center: [l.lng, l.lat], zoom: Math.max(state.map.getZoom(), 13.5), padding, speed: 1.5, essential: true });
    }
  }
  document.body.classList.remove('side-open');
  renderDetail();
}

function updateLinks() {
  if (!state.mapReady) return;
  const from = state.selected != null ? state.byId.get(state.selected) : null;
  const targets = from ? linkedLocations(from) : [];
  const refs = from ? referrersOneWay(from) : [];
  state.links = { from, targets, refs };
  const line = (a, b) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] }, properties: {} });
  state.map.getSource('links').setData({ type: 'FeatureCollection', features: from ? targets.map(t => line(from, t)) : [] });
  state.map.getSource('backlinks').setData({ type: 'FeatureCollection', features: from ? refs.map(r => line(r, from)) : [] });
  updateLinkHeads();
}

// Arrowheads are placed in screen space so they stay right after panning and zooming.
// Each pair is [from, to]; the head sits just before "to", pointing at it.
function arrowHeads(pairs) {
  const feats = [];
  for (const [from, to] of pairs) {
    const a = state.map.project([from.lng, from.lat]);
    const b = state.map.project([to.lng, to.lat]);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const back = Math.min(28, len * 0.5);
    const p = state.map.unproject([b.x - dx / len * back, b.y - dy / len * back]);
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { rot: Math.atan2(dx, -dy) * 180 / Math.PI } });
  }
  return { type: 'FeatureCollection', features: feats };
}

function updateLinkHeads() {
  if (!state.mapReady || !state.links) return;
  const { from, targets, refs } = state.links;
  state.map.getSource('link-heads').setData(arrowHeads(from ? targets.map(t => [from, t]) : []));
  state.map.getSource('backlink-heads').setData(arrowHeads(from ? refs.map(r => [r, from]) : []));
}

// Closes the card and clears the navigation stack. History entries are left alone here (see closeDetail).
function dismiss() {
  state.trail = [];
  state.session = uid();
  state.selected = null;
  $('#detail').hidden = true;
  document.body.classList.remove('detail-open');
  if (state.mapReady) state.map.getSource('sel').setData(emptyFC);
  updateLinks();
}

function closeDetail() {
  dismiss();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function renderDetail() {
  const l = state.byId.get(state.selected);
  if (!l) return closeDetail();
  const cat = state.cats.get(l.cat), g = state.groupOfCat.get(l.cat);
  const ok = applicable(l), isFound = state.found.has(l.id);
  const refs = referrersOneWay(l);

  let only = '';
  if (l.tags.length && l.tags.length < state.tags.length) {
    const names = l.tags.map(id => state.tags.find(t => t.id === id)?.title).filter(Boolean);
    only = `<p class="d-note">Only on ${esc(names.join(', '))}.</p>`;
  }
  const notHere = !ok ? `<p class="d-note">This marker is not shown on ${esc(state.tag === UNTAGGED ? 'Only untagged' : state.tags.find(t => t.id === state.tag)?.title || 'this setting')}.</p>` : '';
  const shots = l.media.map(m => {
    const file = decodeURIComponent(new URL(m.url).pathname.split('/').pop());
    return `<img loading="lazy" src="${esc(state.folder + '/media/' + file)}" alt="${esc(m.title || l.title)}">`;
  }).join('');

  const backrefs = refs.length
    ? `<div class="d-backrefs"><h3>Referenced by</h3><ul>${refs.map(r => `<li><a href="#loc=${r.id}" data-loc="${r.id}">${esc(r.title)}</a></li>`).join('')}</ul></div>`
    : '';

  $('#detail-body').innerHTML =
    `<div class="d-cat" style="--c:${g ? g.col : '#888'}"><i></i>${esc(cat?.title || '')}</div>` +
    `<h2 class="d-title">${esc(l.title)}</h2>` +
    (ok ? `<button class="found-btn${isFound ? ' on' : ''}" type="button" aria-pressed="${isFound}">${isFound ? 'Found. Tap to undo' : 'Mark as found'}</button>` : '') +
    `<div class="d-desc">${renderMd(l.desc)}</div>` + only + notHere +
    (shots ? `<div class="shots">${shots}</div>` : '') + backrefs;

  $('#detail-back').hidden = state.trail.length < 2;
  $('#detail').hidden = false;
  document.body.classList.add('detail-open');
  $('#detail-body').querySelectorAll('.shots img').forEach(img => img.addEventListener('error', () => {
    img.replaceWith(Object.assign(document.createElement('p'), { className: 'd-note', textContent: 'Screenshot not downloaded.' }));
  }));
  updateLinks();
}

function toggleFound(id) {
  state.found.has(id) ? state.found.delete(id) : state.found.add(id);
  scheduleSave();
  updateSidebar();
  refreshMap();
  renderDetail();
}

/* ---------- search ---------- */

function runSearch() {
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#results');
  if (!q) { box.hidden = true; state.searchHits = []; return; }
  const toks = q.split(/\s+/);
  const hits = [];
  for (const l of state.locs) {
    if (!applicable(l)) continue;
    const hay = (l.title + ' ' + (state.cats.get(l.cat)?.title || '')).toLowerCase();
    if (toks.every(t => hay.includes(t))) hits.push({ l, rank: l.title.toLowerCase().startsWith(toks[0]) ? 0 : 1 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.l.title.localeCompare(b.l.title));
  state.searchHits = hits.slice(0, 40).map(h => h.l);
  state.searchIdx = state.searchHits.length ? 0 : -1;
  box.innerHTML = state.searchHits.length
    ? state.searchHits.map((l, i) => `<li data-id="${l.id}" class="${i === 0 ? 'active' : ''}"><span>${esc(l.title)}</span><span class="cat${state.found.has(l.id) ? ' found' : ''}">${state.found.has(l.id) ? 'found' : esc(state.cats.get(l.cat)?.title || '')}</span></li>`).join('')
    : '<li>No matches</li>';
  box.hidden = false;
}

function moveSearch(d) {
  const items = [...$('#results').querySelectorAll('li[data-id]')];
  if (!items.length) return;
  state.searchIdx = (state.searchIdx + d + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === state.searchIdx));
  items[state.searchIdx].scrollIntoView({ block: 'nearest' });
}

/* ---------- events ---------- */

function wire() {
  $('#profile-select').onchange = e => switchProfile(e.target.value);
  const menu = $('#profile-menu'), menuBtn = $('#profile-menu-btn');
  menuBtn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; menuBtn.setAttribute('aria-expanded', String(!menu.hidden)); };
  menu.onclick = e => { const b = e.target.closest('button[data-act]'); if (b) { menu.hidden = true; profileAction(b.dataset.act); } };
  $('#import-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };

  const presetMenu = $('#preset-menu'), presetMenuBtn = $('#preset-menu-btn');
  $('#preset-select').onchange = e => {
    const p = presetById(e.target.value);
    if (p) applyPreset(p);
    else exitPreset();
  };
  $('#preset-bar').onclick = e => { const b = e.target.closest('button[data-act]'); if (b) presetAction(b.dataset.act); };
  presetMenuBtn.onclick = e => { e.stopPropagation(); presetMenu.hidden = !presetMenu.hidden; presetMenuBtn.setAttribute('aria-expanded', String(!presetMenu.hidden)); };
  presetMenu.onclick = e => { const b = e.target.closest('button[data-act]'); if (b && !b.disabled) { presetMenu.hidden = true; presetAction(b.dataset.act); } };

  $('#tag-select').onchange = e => { state.tag = e.target.value === '' ? null : e.target.value === UNTAGGED ? UNTAGGED : Number(e.target.value); syncTagStrict(); saveProfileNow(); refreshAll(); };
  $('#hide-found').onchange = e => { state.view.hideFound = e.target.checked; onViewChanged(); };
  $('#show-all').onclick = () => { state.view.hidden.clear(); onViewChanged(); };
  $('#hide-all').onclick = () => { state.cats.forEach(c => state.view.hidden.add(c.id)); onViewChanged(); };

  const search = $('#search'), results = $('#results');
  search.oninput = runSearch;
  search.onfocus = () => { if (search.value.trim()) runSearch(); };
  search.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSearch(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearch(-1); }
    else if (e.key === 'Enter') { const l = state.searchHits[state.searchIdx]; if (l) { results.hidden = true; select(l.id); } }
    else if (e.key === 'Escape') { results.hidden = true; }
  };
  results.onclick = e => { const li = e.target.closest('li[data-id]'); if (li) { results.hidden = true; select(Number(li.dataset.id)); } };
  document.addEventListener('click', e => {
    if (!e.target.closest('#row-menu, .row-menu-btn')) closeRowMenu();
    if (!e.target.closest('.search')) results.hidden = true;
    if (!e.target.closest('.profile-row')) menu.hidden = true;
    if (!e.target.closest('.preset-row')) presetMenu.hidden = true;
  });

  $('#detail-close').onclick = closeDetail;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRowMenu(); });
  addEventListener('resize', closeRowMenu);
  document.addEventListener('scroll', e => { if (!e.target.closest?.('#row-menu')) closeRowMenu(); }, true);
  $('#detail-back').onclick = goBack;
  addEventListener('popstate', onPopState);
  $('#detail-body').addEventListener('click', e => {
    if (e.target.closest('.found-btn')) return toggleFound(state.selected);
    const a = e.target.closest('a[data-loc]');
    if (a) { e.preventDefault(); return select(Number(a.dataset.loc)); }
    const img = e.target.closest('.shots img');
    if (img) { const lb = $('#lightbox'); lb.querySelector('img').src = img.src; lb.hidden = false; }
  });
  $('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) $('#lightbox').hidden = true;
    else if (!$('#dlg').open && state.selected != null && document.activeElement !== search) closeDetail();
  });

  $('#side-toggle').onclick = () => document.body.classList.add('side-open');
  $('#side-close').onclick = () => document.body.classList.remove('side-open');
  $('#side-collapse').onclick = () => setSideCollapsed(!document.body.classList.contains('side-collapsed'));

  addEventListener('pagehide', saveProfileNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveProfileNow(); });
}

wire();
boot().catch(e => fatal(e.message));
