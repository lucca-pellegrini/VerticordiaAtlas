// Offline map viewer. No network needed once maps/<slug>/ is filled in.
// Data per game (next to its index.html): data.json (window.mapData saved from the site),
// markers.json + markers.png, tiles/{z}/{y}/{x}.jpg and media/<file>.jpg.

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => Number(n).toLocaleString();
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

/* ---------- description renderer (links, bold, lists, line breaks) ---------- */

function inlineMd(s) {
  let h = esc(s);
  h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const loc = /[?&]locationIds=(\d+)/.exec(url);
    if (loc) return state.byId.has(+loc[1]) ? `<a href="#loc=${loc[1]}" data-loc="${loc[1]}">${text}</a>` : text;
    if (/^https?:/.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    return text;
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return h;
}

function renderMd(src) {
  const out = [];
  let para = [], list = null;
  const flushP = () => { if (para.length) { out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push('<ul>' + list.map(i => '<li>' + inlineMd(i) + '</li>').join('') + '</ul>'); list = null; } };
  for (const line of String(src || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) { flushP(); (list ||= []).push(m[1]); }
    else if (!line.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(line); }
  }
  flushP(); flushL();
  return out.join('');
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

async function loadGame(entry) {
  state.entry = entry;
  state.folder = '.'; // data files sit next to the page
  applyTheme(entry.theme);
  $('#game-title').textContent = entry.title;
  document.title = `${entry.title} · Verticordia Atlas`;
  $('#tag-label').textContent = entry.tagLabel || 'Filter';

  let data, spriteDefs, spriteImg;
  try {
    [data, spriteDefs] = await Promise.all([
      fetchJSON(`${state.folder}/data.json`),
      fetchJSON(`${state.folder}/markers.json`),
    ]);
    spriteImg = await loadImage(`${state.folder}/markers.png`);
  } catch (e) { return fatal(e.message + ' (check the files next to this page)'); }

  state.data = data;
  state.sprite = { defs: spriteDefs, img: spriteImg };

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
  $('#tag-select').innerHTML = state.tags.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');

  await loadProfiles();
  buildSidebar();
  createMap();
}

/* ---------- profiles ---------- */

function defaultTagId() {
  if (!state.tags.length) return null;
  const want = (state.entry.defaultTag || '').toLowerCase();
  return (state.tags.find(t => t.title.toLowerCase() === want) || state.tags[0]).id;
}

function makeProfile(name, tag) {
  const id = uid();
  return { key: `${state.entry.id}:${id}`, id, game: state.entry.id, name, tag, found: [], created: Date.now(), updated: Date.now() };
}

async function loadProfiles() {
  state.profiles = (await dbAll('profiles')).filter(p => p.game === state.entry.id)
    .sort((a, b) => a.created - b.created);
  if (!state.profiles.length) {
    const p = makeProfile('Default', defaultTagId());
    await dbPut('profiles', p);
    state.profiles = [p];
  }
  const last = await getMeta('last-profile:' + state.entry.id);
  applyProfile(state.profiles.find(p => p.id === last) || state.profiles[0]);
}

function applyProfile(p) {
  state.profile = p;
  state.found = new Set(p.found || []);
  state.tag = state.tags.length ? (p.tag ?? defaultTagId()) : null;
  renderProfileSelect();
  if (state.tags.length) $('#tag-select').value = String(state.tag);
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
    const np = makeProfile(name, state.tag ?? defaultTagId());
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
      const np = makeProfile('Default', defaultTagId());
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
      profiles: state.profiles.map(({ id, name, tag, found, created, updated }) => ({ id, name, tag, found, created, updated })),
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
        found: q.found.filter(Number.isFinite), created: q.created || Date.now(), updated: Date.now() };
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

const applicable = l => !state.tag || l.tags.length === 0 || l.tags.includes(state.tag);
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
  return `<span class="ico" style="width:${d.width}px;height:${d.height}px;background-image:url('${state.folder}/markers.png');` +
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
      `<div class="group-head"><button class="name" type="button">${esc(g.title)}</button>` +
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

    const rows = [];
    for (const c of g.cats) {
      const row = document.createElement('label');
      row.className = 'cat-row';
      if (c.info) row.title = c.info;
      row.innerHTML = `<span class="ico-wrap">${iconHtml(c.icon)}</span><span class="label">${esc(c.title)}</span><span class="tally"></span><input type="checkbox">`;
      const cb = row.querySelector('input');
      cb.onchange = () => { cb.checked ? state.view.hidden.delete(c.id) : state.view.hidden.add(c.id); onViewChanged(); };
      row.oncontextmenu = e => { e.preventDefault(); showOnly([c.id]); };
      catsEl.appendChild(row);
      rows.push({ c, row, cb, tally: row.querySelector('.tally') });
      state.ui.cats.set(c.id, rows[rows.length - 1]);
    }
    state.ui.groups.set(g.id, { g, el, gToggle, tally: el.querySelector('.group-head .tally'), rows });
    root.appendChild(el);
  }
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

function matchesView(p) {
  const h = new Set(p.hidden);
  for (const id of state.cats.keys()) if (h.has(id) !== state.view.hidden.has(id)) return false;
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
    const np = { id: uid(), name, hidden: [...state.view.hidden] };
    state.presets.push(np);
    state.presetId = np.id;
    await savePresets(); renderPresets();
    toast('Preset saved.');
    return;
  }
  const p = currentPreset();
  if (!p) return;
  if (act === 'overwrite') {
    p.hidden = [...state.view.hidden];
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
  refreshMap();
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
  const data = state.data, cfg = data.mapConfig, ts = cfg.tile_sets[0];
  const [w, s, e, n] = data.styles?.mapStyle?.bounds || [-180, -85, 180, 85];
  const pad = 0.25;

  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': themeVar('night') } }] },
    center: [cfg.start_lng, cfg.start_lat],
    zoom: cfg.initial_zoom ?? 11,
    minZoom: ts.min_zoom ?? 0,
    maxZoom: ts.max_zoom ?? 18,
    maxBounds: [[w - pad, s - pad], [e + pad, n + pad]],
    attributionControl: false,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    fadeDuration: 0,
  });
  state.map = map;
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    // marker icons cropped out of the sprite sheet
    for (const [name, d] of Object.entries(state.sprite.defs)) {
      const c = document.createElement('canvas');
      c.width = d.width; c.height = d.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(state.sprite.img, d.x, d.y, d.width, d.height, 0, 0, d.width, d.height);
      map.addImage(name, ctx.getImageData(0, 0, d.width, d.height), { pixelRatio: d.pixelRatio || 1 });
    }

    // tiles are stored as {z}/{y}/{x}.jpg, the same order the original site uses
    const rel = ts.pattern.startsWith(ts.path + '/') ? ts.pattern.slice(ts.path.length + 1) : '{z}/{y}/{x}.' + (ts.extension || 'jpg');
    const tileBase = new URL(state.folder + '/tiles/', document.baseURI).href;
    map.addSource('base', {
      type: 'raster', tiles: [tileBase + rel], tileSize: 256,
      minzoom: ts.min_zoom ?? 0, maxzoom: ts.tiles_max_zoom ?? ts.max_zoom ?? 18,
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

// Markers that the description links to (self and unknown IDs skipped), and the markers that link to this one.
function buildLinkIndex() {
  for (const l of state.locs) {
    const out = [];
    for (const m of l.desc.matchAll(/locationIds=([\d,]+)/g))
      for (const x of m[1].split(',')) {
        const id = Number(x);
        if (id !== l.id && state.byId.has(id) && !out.includes(id)) out.push(id);
      }
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
  const notHere = !ok ? `<p class="d-note">This marker is not shown on ${esc(state.tags.find(t => t.id === state.tag)?.title || 'this setting')}.</p>` : '';
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

  $('#tag-select').onchange = e => { state.tag = Number(e.target.value); saveProfileNow(); refreshAll(); };
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
    if (!e.target.closest('.search')) results.hidden = true;
    if (!e.target.closest('.profile-row')) menu.hidden = true;
    if (!e.target.closest('.preset-row')) presetMenu.hidden = true;
  });

  $('#detail-close').onclick = closeDetail;
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
