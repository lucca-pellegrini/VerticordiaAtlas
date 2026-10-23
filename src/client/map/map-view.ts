/* ---------- game loading, theme application, map switcher, and MapLibre view ---------- */

import { esc } from '../../shared/escape.ts';
import { deriveLightTheme } from '../../shared/theme-math.ts';
import { $, askDialog, emptyFC, ICON_STOPS, iconScale, state, toast, UNTAGGED, vivid } from './state.ts';
import { renderMd } from './markdown.ts';
import { loadMapState, migratePresets, renderPresets } from './presets.ts';
import { isSavePending, loadProfiles, saveProfileNow, scheduleSave, syncTagStrict } from './profiles.ts';
import { buildSidebar, endMorph, rebuildUserData, resetShownCounts, shownOnMap, startMorph, updateSidebar, userChanged } from './sidebar.ts';
import { inSelection, setupSelection } from './selection.ts';
import { closeCtx, closeDetail, dismiss, mapMenuAt, renderDetail, select, updateLinkHeads } from './detail.ts';
import { runSearch } from './search.ts';
import { setupDrawing } from './drawing.ts';
import { setupCapture } from './capture.ts';
import { pingImage, setupUserMarkers } from './usermarkers.ts';
import { glyphPinImage, iconsReady } from '../icons-lib.ts';
import { isLightTheme, recordGameOpen } from '../theme.ts';

export async function fetchJSON<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Could not load ' + src));
    i.src = src;
  });
}

export function fatal(msg: string): false {
  document.body.classList.remove('loading-side', 'loading-map');
  const groups = $('#groups');
  if (groups) groups.innerHTML = `<p style="padding:16px;color:var(--blood)">${esc(msg)}</p>`;
  console.error(msg);
  return false;
}

// Each game's colours come from "theme" in maps/index.json and become CSS variables (see style.css :root).
export function applyTheme(theme: Record<string, string> = {}): void {
  const root = document.documentElement.style;
  const active = isLightTheme() ? deriveLightTheme(theme) : theme;
  for (const [name, value] of Object.entries(active)) {
    if (value && CSS.supports(`--${name}`, value)) {
      root.setProperty(`--${name}`, value);
      themeState.set(name, value);
    }
  }
  // backreferences: accent-soft pulled towards the night colour, so they read as the same family but dimmer
  const backlink = mixColor(themeVar('accent-soft'), themeVar('night'), 0.7);
  root.setProperty('--backlink', backlink);
  themeState.set('backlink', backlink);
  // browser chrome follows the theme too: tab colour on mobile and the favicon pin
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', themeVar('night'));
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]');
  if (icon) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='${themeVar('accent-soft')}' d='M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z'/><circle cx='12' cy='10' r='2.8' fill='${themeVar('night')}'/></svg>`;
    icon.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  if (state.map && state.mapReady) {
    const map = state.map;
    if (map.getLayer('bg')) map.setPaintProperty('bg', 'background-color', themeVar('night'));
    if (map.getLayer('sel')) {
      map.setPaintProperty('sel', 'circle-color', themeVar('accent'));
      map.setPaintProperty('sel', 'circle-stroke-color', themeVar('accent-soft'));
    }
    if (map.getLayer('links')) map.setPaintProperty('links', 'line-color', themeVar('accent-soft'));
    if (map.getLayer('backlinks')) map.setPaintProperty('backlinks', 'line-color', themeVar('backlink'));
    const updateArrow = (name: string, fill: string) => {
      if (!map.hasImage(name)) return;
      const ac = document.createElement('canvas');
      ac.width = ac.height = 24;
      const actx = ac.getContext('2d')!;
      actx.beginPath(); actx.moveTo(12, 2); actx.lineTo(21, 21); actx.lineTo(3, 21); actx.closePath();
      actx.fillStyle = fill; actx.strokeStyle = themeVar('night'); actx.lineWidth = 2.5; actx.lineJoin = 'round';
      actx.fill(); actx.stroke();
      map.updateImage(name, actx.getImageData(0, 0, 24, 24));
    };
    updateArrow('link-arrow', themeVar('accent-soft'));
    updateArrow('backlink-arrow', themeVar('backlink'));
  }
}

// the colours applyTheme set, as written (hex or rgb). Read from here rather than from the page: the registered theme
// colours read back as oklab(), which MapLibre cannot parse.
const themeState = new Map<string, string>();
let colorProbe: CanvasRenderingContext2D | null = null;
function getColorProbe(): CanvasRenderingContext2D {
  if (!colorProbe) colorProbe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  return colorProbe;
}

export const themeVar = (name: string): string => {
  if (themeState.has(name)) return themeState.get(name)!;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  const probe = getColorProbe();
  probe.fillStyle = raw;
  return probe.fillStyle as string;
};

// Blend two CSS colours: t of a, the rest of b. Parsed through a canvas, so any CSS colour format works.
export function mixColor(a: string, b: string, t: number): string {
  const probe = getColorProbe();
  const rgb = (c: string) => {
    probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = c;
    probe.fillRect(0, 0, 1, 1);
    return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const pa = rgb(a), pb = rgb(b);
  return 'rgb(' + pa.map((v, i) => Math.round(v * t + pb[i] * (1 - t))).join(',') + ')';
}

// meta.json (written by add-game.ts) says where a game's data, sprite and tiles are.
export async function loadMeta(): Promise<any> {
  const r = await fetch('./meta.json');
  if (!r.ok) throw new Error(`meta.json: HTTP ${r.status}. Run add-game.ts for this game`);
  return r.json();
}

export async function loadGame(entry: any): Promise<boolean> {
  showMapSwitchPlaceholder();
  state.entry = entry;
  state.folder = '.'; // data files sit next to the page
  applyTheme(entry.theme);
  recordGameOpen(entry.slug, entry.theme, entry.title);
  const titleEl = $('#game-title');
  if (titleEl) titleEl.textContent = entry.title;
  document.title = `${entry.title} · Verticordia Atlas`;
  const tagLabelEl = $('#tag-label');
  if (tagLabelEl) tagLabelEl.textContent = entry.tagLabel || 'Filter';

  try {
    state.meta = await loadMeta();
    const mk = state.meta.markers || null; // null: add-game found no marker sprite for this game
    // prefer the @2x sprite when the game has one: markers look sharper on phones
    const spriteFile = !mk ? null : mk.png2x && mk.json2x ? { json: mk.json2x, png: mk.png2x } : { json: mk.json, png: mk.png };
    const [spriteDefs, spriteImg] = await Promise.all([
      spriteFile ? fetchJSON(`${state.folder}/${spriteFile.json}`) : Promise.resolve({}),
      spriteFile ? loadImage(`${state.folder}/${spriteFile.png}`) : Promise.resolve(null),
    ]);
    state.sprite = { defs: spriteDefs, img: spriteImg, png: spriteFile?.png ?? null };
    state.spriteFile = spriteFile;
  } catch (e: any) { return fatal(e.message + ' (check the files next to this page)'); }
  // the sidebar's category logos come from the game's icon font or sprite (add-game.ts); without it the marker sprite is used
  state.glyphs = null;
  if (state.meta.icons?.font && state.meta.icons.glyphs) {
    try {
      const family = `gi-${entry.id}`;
      const face = new FontFace(family, `url("${state.folder}/${state.meta.icons.font}")`);
      await face.load();
      document.fonts.add(face);
      state.glyphs = { family, map: state.meta.icons.glyphs };
    } catch (e: any) { console.warn('icon font not loaded, using the marker sprite:', e.message); }
  } else if (state.meta.icons?.image && state.meta.icons.glyphs) {
    state.glyphs = { image: `${state.folder}/${state.meta.icons.image}`, size: state.meta.icons.size || 18, map: state.meta.icons.glyphs };
  }

  await migratePresets(); // presets are per game (see presetsKey)
  // the profile comes first: it says which map was open, and where
  await loadProfiles();
  // the map to open: a shared link's map, else the one this profile was last on, else the game's first
  const want = new URLSearchParams(location.search).get('map');
  const info = state.meta.maps.find((m: any) => m.slug === want) || state.meta.maps.find((m: any) => m.slug === state.profile?.map) || state.meta.maps[0];
  try { await prepareMap(info); }
  catch (e: any) { return fatal(e.message + ' (check the files next to this page)'); }
  // the numbers count up from zero and the bar grows in, on the same curve as a map switch
  resetShownCounts();
  startMorph();
  buildSidebar();
  void $('#progress-bar')?.offsetWidth; // flush the zero-size segments, so the transition starts from them
  renderMapSwitch();
  updateSidebar();
  endMorph({ later: true });
  $('#groups')?.classList.add('enter'); // the list fades in as the panel comes up
  document.body.classList.remove('loading-side'); // the side panel has its numbers and selectors now
  createMap();
  return true;
}

// everything that belongs to one map of the game: its data, categories, locations, tags, view and presets
export async function prepareMap(info: any): Promise<void> {
  const data = await mapData(info);
  state.mapInfo = info;
  state.data = data;

  // categories and groups
  const spriteFile = state.spriteFile;
  const catById = new Map<number, any>(Object.values<any>(data.categories).map(c => [c.id, c]));
  state.cats = catById;
  state.groups = [...data.groups].sort((a: any, b: any) => a.order - b.order).map((g: any) => {
    const ids = (g.categories || []).map((c: any) => c.id);
    const cats = (ids.length ? ids.map((id: number) => catById.get(id)) : [...catById.values()].filter(c => c.group_id === g.id))
      .filter(Boolean).sort((a: any, b: any) => a.order - b.order);
    return { id: g.id, title: g.title, col: vivid(g.color), cats };
  });
  // without a sprite, each category gets a ping in its group's colour (the same kind as user markers)
  if (!spriteFile) state.groups.forEach((g: any) => g.cats.forEach((c: any) => { c.icon = 'up-' + String(g.col).replace('#', ''); }));
  const groupOfCat = new Map<number, any>();
  state.groups.forEach((g: any) => g.cats.forEach((c: any) => groupOfCat.set(c.id, g)));
  state.groupOfCat = groupOfCat;

  // locations
  state.locs = data.locations.map((l: any) => ({
    id: l.id, cat: l.category_id, title: l.title || '', desc: l.description || '',
    lat: parseFloat(l.latitude), lng: parseFloat(l.longitude),
    tags: l.tags || [], media: l.media || [],
    icon: catById.get(l.category_id)?.icon,
  })).filter((l: any) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  state.officialLocs = state.locs;
  state.byId = new Map(state.locs.map((l: any) => [l.id, l]));
  state.tags = [...(data.tags || [])].sort((a: any, b: any) => a.id - b.id);

  await loadMapState();

  // difficulty / tag selector
  const tagField = $('#tag-field');
  if (tagField) tagField.hidden = state.tags.length === 0;
  syncTagStrict();
  // "Everything" (value "") shows every marker, including ones carrying a tag; it is the default
  const tagSelect = $<HTMLSelectElement>('#tag-select');
  if (tagSelect) {
    tagSelect.innerHTML = '<option value="">Everything</option><option value="' + UNTAGGED + '">Only untagged</option>' +
      state.tags.map((t: any) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
    if (state.tags.length) tagSelect.value = state.tag == null ? '' : String(state.tag);
  }

  rebuildUserData(); // links, the user's markers on this map, and the sidebar when it exists
}

// map data is fetched once per map
const mapCache = new Map<string, Promise<any>>();
export function mapData(info: { slug: string; data: string }): Promise<any> {
  if (!mapCache.has(info.slug)) {
    mapCache.set(info.slug, fetchJSON(`${state.folder}/${info.data}`).catch(e => { mapCache.delete(info.slug); throw e; }));
  }
  return mapCache.get(info.slug)!;
}

// the map switcher in the side panel: one button per map, shown when the game has more than one
export function mapSwitchEl(): HTMLElement {
  let nav = document.getElementById('map-switch');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'map-switch';
    nav.className = 'map-switch';
    nav.setAttribute('aria-label', 'Maps in this game');
    nav.onclick = e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-map]');
      if (b && b.dataset.map) switchMap(b.dataset.map);
    };
    nav.onchange = e => {
      const target = e.target as HTMLSelectElement;
      if (target.matches('select[data-map-select]')) switchMap(target.value);
    };
    document.querySelector('.side-head .progress')?.before(nav);
    // the pills, or a drop-down when they do not fit the sidebar: decided again whenever the sidebar changes width
    if (nav.parentElement) new ResizeObserver(() => layoutMapSwitch()).observe(nav.parentElement);
    // the web font arrives after the first layout, and it makes the names wider: decide again once it is here
    document.fonts?.ready.then(() => layoutMapSwitch());
    document.fonts?.addEventListener('loadingdone', () => layoutMapSwitch());
  }
  return nav;
}

// while the game loads: a throbber where the map buttons will go
export function showMapSwitchPlaceholder(): void {
  const nav = mapSwitchEl();
  nav.hidden = false;
  nav.classList.add('placeholder');
  nav.innerHTML = '<span class="spinner" role="status" aria-label="Loading maps"></span>';
}

// The map buttons are built once per game and then only updated, so the highlight can glide from one to the next.
export function renderMapSwitch(): void {
  const maps: any[] = state.meta?.maps || [];
  const nav = mapSwitchEl();
  nav.classList.remove('placeholder');
  nav.hidden = maps.length < 2;
  if (nav.hidden) return;
  const key = maps.map(m => m.slug).join('|');
  if (nav.dataset.maps !== key || !nav.querySelector('button[data-map]')) {
    nav.dataset.maps = key;
    nav.classList.remove('ready');
    nav.innerHTML = '<span class="map-thumb" aria-hidden="true"></span>' +
      maps.map(m => `<button type="button" data-map="${esc(m.slug)}">${esc(m.title || m.slug)}</button>`).join('') +
      `<select data-map-select aria-label="Map">${maps.map(m => `<option value="${esc(m.slug)}">${esc(m.title || m.slug)}</option>`).join('')}</select>`;
  }
  const cur = state.mapInfo?.slug;
  nav.removeAttribute('data-pending');
  nav.querySelectorAll<HTMLElement>('button[data-map]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.map === cur));
    b.removeAttribute('data-pending');
  });
  nav.querySelector('select')!.value = cur ?? '';
  layoutMapSwitch();
  if (!nav.classList.contains('ready')) requestAnimationFrame(() => nav.classList.add('ready')); // first placement does not glide in from the left
}

// a switch has begun: the pill (or the drop-down) shows where it is going, and the highlight glides there at once
export function markSwitchTarget(slug: string): void {
  const nav = mapSwitchEl();
  nav.setAttribute('data-pending', '');
  nav.querySelectorAll<HTMLElement>('button[data-map]').forEach(b => b.toggleAttribute('data-pending', b.dataset.map === slug));
  const sel = nav.querySelector('select');
  if (sel) sel.value = slug;
  moveThumb(slug);
}

// the sliding pill behind the chosen button of a pill bar (.map-switch: the map pills, and the search's scope)
export function placeThumb(nav: HTMLElement | null, attr: string, value: string | undefined): void {
  const thumb = nav?.querySelector<HTMLElement>('.map-thumb');
  if (!thumb || !nav) return;
  const b = nav.querySelector<HTMLElement>(`button[${attr}="${CSS.escape(value ?? '')}"]`);
  if (!b || nav.classList.contains('as-select')) { thumb.style.width = '0px'; return; }
  thumb.style.width = b.offsetWidth + 'px';
  thumb.style.transform = `translateX(${b.offsetLeft}px)`;
}

function moveThumb(slug: string | undefined): void {
  placeThumb(document.getElementById('map-switch'), 'data-map', slug);
}

// The pills while they fit the sidebar. A little too wide is squeezed (the names are cut short) rather than turning into a
// drop-down; only clearly too wide becomes the drop-down. Measured with the pills in their natural state, before anything is drawn.
const SWITCH_TOLERANCE = 16; // px
export function layoutMapSwitch(): void {
  const nav = document.getElementById('map-switch');
  if (!nav || nav.hidden || !nav.clientWidth || nav.querySelector('.spinner')) return;
  nav.classList.remove('as-select', 'squeeze');
  const over = nav.scrollWidth - nav.clientWidth;
  if (over > SWITCH_TOLERANCE) nav.classList.add('as-select');
  else if (over > 1) nav.classList.add('squeeze');
  moveThumb(state.mapInfo?.slug);
}

// the bounds, zoom limits and tile set of a map
export function mapLimits(info: any, data: any) {
  const ts = info.tilesets[0]; // { template, minzoom, maxzoom (stored tiles), viewMaxzoom, bounds }
  const box = ts.bounds || data.styles?.mapStyle?.bounds || [-180, -85, 180, 85];
  const [w, s, e, n] = box, pad = 0.25;
  // MapLibre's maxBounds wraps longitudes modulo 360: whole-world bounds (or [-180, 180] with padding)
  // collapse the allowed range to 0-11px at the antimeridian, forcing zoom to max and pinning the view at lng 180.
  const isWholeWorld = (e - w) >= 359 || (w <= -179 && e >= 179);
  const maxBounds: [[number, number], [number, number]] | null = isWholeWorld
    ? null
    : [[Math.max(-180, w - pad), Math.max(-85.05, s - pad)], [Math.min(180, e + pad), Math.min(85.05, n + pad)]];
  return { ts, box, minZoom: ts.minzoom ?? 0, maxZoom: ts.viewMaxzoom ?? ts.maxzoom ?? 18, maxBounds };
}

// where a map opens: the saved camera for it, else the game's start position
export function startOf(info: any, data: any, cam?: { lng: number; lat: number; zoom: number } | null): { center: [number, number]; zoom: number } {
  const lim = mapLimits(info, data);
  if (cam && Number.isFinite(cam.lng) && Number.isFinite(cam.lat) && Number.isFinite(cam.zoom)) {
    // disregard saved views outside the allowed zoom levels (e.g. from previous maxBounds bugs)
    if (cam.zoom <= lim.maxZoom && cam.zoom >= lim.minZoom) return { center: [cam.lng, cam.lat], zoom: cam.zoom };
  }
  const cfg = data.mapConfig || {};
  return { center: [cfg.start_lng, cfg.start_lat], zoom: cfg.initial_zoom ?? 11 };
}

// the raster tiles of the current map (replaced when the map changes)
export function setBaseTiles(map: any): void {
  const { ts, box } = mapLimits(state.mapInfo, state.data);
  const [w, s, e, n] = box;
  if (map.getLayer('base')) map.removeLayer('base');
  if (map.getSource('base')) map.removeSource('base');
  map.addSource('base', {
    // resolve only the folder: running the template through new URL() would escape the {z}/{y}/{x} placeholders
    type: 'raster', tiles: [new URL(state.folder + '/', document.baseURI).href + ts.template], tileSize: ts.tileSize || 256,
    minzoom: ts.minzoom ?? 0, maxzoom: ts.maxzoom ?? 18,
    bounds: [w, s + 0.001, e - 0.001, n],
  });
  map.addLayer({ id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 900 } }, map.getLayer('sel') ? 'sel' : undefined);
}

// the camera of the open map goes into the profile (with which map it is), so a visit resumes where it was
export const cameraNow = (): { lng: number; lat: number; zoom: number } => {
  const c = state.map.getCenter();
  return { lng: +c.lng.toFixed(6), lat: +c.lat.toFixed(6), zoom: +state.map.getZoom().toFixed(2) };
};
const cameraKey = (): string => (state.mapReady && state.mapInfo ? state.mapInfo.slug + JSON.stringify(cameraNow()) : '');
// Where the map is, as far as the profile (and so the other devices) are concerned. The map is put there by us (opening
// it, a profile or a map switch, or an update from another device), and the move that follows is not the user's: it must
// not be written back, or two devices would keep handing each other their own rounding of the same view.
export const agreeCamera = (): void => { state.camKey = cameraKey(); };
export const viewUntouched = (): boolean => !state.mapReady || cameraKey() === state.camKey; // the user has not moved the view since it was last agreed
export const sameCamera = (a: { lng: number; lat: number; zoom: number }, b: { lng: number; lat: number; zoom: number }): boolean =>
  Math.abs(a.lng - b.lng) < 1e-5 && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.zoom - b.zoom) < 0.005;

export function rememberCamera(now = false): void {
  if (state.capturing) return; // a screenshot moves the view for a moment; the camera is the one before
  if (state.glide && !state.glide.touched) return; // mid-glide to another device's view: not where we want to be yet
  let changed = false;
  if (state.mapReady && state.profile && state.mapInfo) {
    const p = state.profile, slug = state.mapInfo.slug, key = cameraKey();
    if (key !== state.camKey || p.map !== slug) { // the view really moved (or the map changed)
      p.map = slug;
      p.cameras = { ...(p.cameras || {}), [slug]: cameraNow() };
      state.camKey = key;
      changed = true;
    }
  } else changed = true;
  if (!changed && !isSavePending()) return; // nothing moved and nothing waits to be saved: nothing to write, nothing to send
  if (now) saveProfileNow(); else scheduleSave();
}

const FADE_MS = 1600; // the map fades out and in over this long (see style.css)
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// the map is shown once its tiles are in: not merely when the engine is idle, which can come before the new tiles start
let revealToken = 0; // only the latest reveal may show the map: an older one must not lift the fade of a newer switch
// the map is shown once it reports loaded (its tiles are in). Idle maps do not repaint, so this polls as well as listening
export function revealWhenSettled(map: any, minMs = 1000): void {
  const token = ++revealToken, start = performance.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { clearInterval(timer); map.off('idle', check); };
  const done = () => {
    stop();
    if (token === revealToken && !state.capturing) document.body.classList.remove('loading-map');
  };
  const check = () => { if (performance.now() - start >= minMs && map.loaded()) done(); };
  timer = setInterval(check, 100);
  map.on('idle', check);
  check();
  setTimeout(() => { if (token === revealToken) done(); }, 15000); // in case the tiles never settle
}

// switches the map in place: the tiles, the bounds and the marker data change; the camera follows the profile
export async function switchMap(slug: string, { remember = true } = {}): Promise<void> {
  if (!state.mapReady || slug === state.mapInfo?.slug) return;
  const info = state.meta.maps.find((m: any) => m.slug === slug);
  if (!info) return;
  revealToken++; // a reveal waiting from an earlier switch must not lift this fade
  // the pill being switched to shows a spinner from the click on (the sidebar is locked while the map loads: see wire)
  markSwitchTarget(slug);
  closeDetail(); // the card closes the way a close does, first thing
  state.setTool?.('pan'); // and the hand is back on, whatever tool was up
  document.body.classList.add('loading-map');
  startMorph(); // the sidebar's numbers and bar move from the old map's values to the new one's (see updateSidebar)
  if (remember) rememberCamera(true); // where we were on the map we are leaving
  try { await Promise.all([prepareMap(info), delay(FADE_MS)]); } // the jump happens once the map is black
  catch (e) { endMorph(); document.body.classList.remove('loading-map'); renderMapSwitch(); return toast(`Could not load ${info.title}.`, 4000); }
  dismiss();
  state.sel = null;
  setBaseTiles(state.map);
  const lim = mapLimits(info, state.data);
  state.map.setMinZoom(lim.minZoom);
  state.map.setMaxZoom(lim.maxZoom);
  state.map.setMaxBounds(lim.maxBounds);
  state.map.jumpTo(startOf(info, state.data, state.profile?.cameras?.[slug]));
  revealWhenSettled(state.map);
  if (remember) rememberCamera(true);
  refreshAll();
  endMorph({ later: true }); // the tween runs its full length from the numbers this refresh set
  renderMapSwitch();
  updateSidebar();
}

// a view another device moved: glide there. It is agreed once it has landed; if the user moved the map meanwhile, that
// move is theirs and is kept (see the moveend handler)
export function glideTo(cam: { lng: number; lat: number; zoom: number }): void {
  const target = startOf(state.mapInfo, state.data, cam);
  state.glide = { touched: false };
  state.map.flyTo({ ...target, speed: 1.1, essential: true });
}

// after switching profile: the profile's map and camera
export async function syncMapToProfile(): Promise<void> {
  const want = state.profile?.map;
  if (want && want !== state.mapInfo?.slug && state.meta.maps.some((m: any) => m.slug === want)) {
    await switchMap(want, { remember: false });
    agreeCamera();
    return;
  }
  const cam = state.profile?.cameras?.[state.mapInfo?.slug];
  if (cam && state.mapReady) { state.map.jumpTo(startOf(state.mapInfo, state.data, cam)); agreeCamera(); }
}

export function createMap(): void {
  const start = startOf(state.mapInfo, state.data, state.profile?.cameras?.[state.mapInfo.slug]);
  const lim = mapLimits(state.mapInfo, state.data);
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': themeVar('night') } }] },
    center: start.center,
    zoom: start.zoom,
    minZoom: lim.minZoom,
    maxZoom: lim.maxZoom,
    ...(lim.maxBounds ? { maxBounds: lim.maxBounds } : {}),
    attributionControl: false,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    fadeDuration: 0,
  });
  state.map = map;
  let camTimer: ReturnType<typeof setTimeout> | undefined;
  map.on('movestart', (e: any) => {
    if (state.glide && e.originalEvent) state.glide.touched = true; // a hand on the map, during a glide
    if (e.originalEvent && state.search.preview) state.search.preview = null; // a hand on the map ends a preview, and keeps the view
  });
  map.on('moveend', () => {
    const g = state.glide;
    state.glide = null;
    if (g && !g.touched) agreeCamera(); // it landed where the other device put it: nothing to send back
    if (state.search.preview) return; // a search preview is on screen: the view is not the user's to save yet
    clearTimeout(camTimer); camTimer = setTimeout(() => rememberCamera(false), 400);
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  const tools = setupSelection(map);
  state.setTool = (t: string) => tools.setTool(t); // the switch puts the hand back on (see switchMap)
  state.drawing = setupDrawing({
    map, mapEl: map.getContainer(), canvasBox: map.getCanvasContainer(),
    getProfile: () => state.profile, getMap: () => state.mapInfo?.slug,
    onChange: () => scheduleSave(), requestTool: t => tools.setTool(t), renderMd,
  });
  state.capture = setupCapture({
    map, mapEl: map.getContainer(), canvasBox: map.getCanvasContainer(), drawing: state.drawing,
    requestTool: t => tools.setTool(t), toast,
    names: () => ({ file: `${state.entry.id}-${state.mapInfo.slug}`, label: `${state.entry.title} · ${state.mapInfo.title}` }),
    setBusy: b => { state.capturing = b; document.body.classList.toggle('loading-map', b); },
  });
  state.um = setupUserMarkers({
    map, state, mapEl: map.getContainer(), canvasBox: map.getCanvasContainer(),
    changed: userChanged, select, closeDetail, askDialog, toast, requestTool: t => tools.setTool(t),
  });

  map.on('load', () => {
    // marker icons cropped out of the sprite sheet
    for (const [name, d] of Object.entries<any>(state.sprite.defs)) {
      const c = document.createElement('canvas');
      c.width = d.width; c.height = d.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(state.sprite.img, d.x, d.y, d.width, d.height, 0, 0, d.width, d.height);
      map.addImage(name, ctx.getImageData(0, 0, d.width, d.height), { pixelRatio: d.pixelRatio || 1 });
    }

    setBaseTiles(map);

    map.addSource('sel', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'sel', type: 'circle', source: 'sel',
      paint: { 'circle-radius': 21, 'circle-color': themeVar('accent'), 'circle-opacity': 0.22, 'circle-stroke-color': themeVar('accent-soft'), 'circle-stroke-width': 2.5, 'circle-translate': [0, -17] },
    });

    // arrowhead images: forward links use the accent colour, backreferences the dimmer one
    const arrowImage = (name: string, fill: string) => {
      const ac = document.createElement('canvas');
      ac.width = ac.height = 24;
      const actx = ac.getContext('2d')!;
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
      paint: { 'icon-opacity': ['case', ['==', ['get', 'f'], 1], 0.4, 1], 'icon-opacity-transition': { duration: 0 } }, // the veil animates it per frame
    });

    // a user marker under the pointer is drawn again here, a little larger, above the rest (see setHover)
    map.addSource('hover-loc', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'hover-loc', type: 'symbol', source: 'hover-loc',
      paint: { 'icon-opacity-transition': { duration: 0 } },
      layout: {
        'icon-image': ['get', 'icon'], 'icon-anchor': 'bottom',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        // the zoom stops scaled by 1.22 (zoom may only be the input of interpolate, not inside a product)
        'icon-size': ['interpolate', ['linear'], ['zoom'], ...ICON_STOPS.flat().map((v, i) => (i % 2 ? v * 1.22 : v))],
      },
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
    agreeCamera(); // where it opened is where it is agreed to be
    revealWhenSettled(map);
    updateSidebar();
    refreshMap();
    state.drawing?.render(); // the profile's drawings appear with the map, not on the first move
    // a shared link carries ?loc=<id>; the hash (#loc=<id>) is what the app writes while browsing
    const q = new URLSearchParams(location.search).get('loc');
    const m = /^#loc=(\d+)/.exec(location.hash) || (/^\d+$/.test(q || '') ? [null, q] : null);
    const packed = new URLSearchParams(location.search).get('tm');
    if (packed) { history.replaceState(null, '', location.pathname); state.um.addSharedTemp(packed); }
    if (m && state.byId.has(+m[1]!)) {
      // a shared link starts a stack of its own: the page entry underneath is the bottom of it
      history.replaceState(null, '', location.pathname + location.search);
      select(+m[1]!, { fly: true });
    }
  });

  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'tip', anchor: 'bottom' });
  // a user marker under the pointer grows a little (the copy in 'hover-loc'); official markers do not react
  let hoverId: number | null = null;
  const setHover = (l: any) => {
    const id = l && l.user ? l.id : null;
    if (id === hoverId) return;
    hoverId = id;
    map.getSource('hover-loc').setData(id == null ? emptyFC : {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lng, l.lat] }, properties: { icon: l.icon } }],
    });
  };
  map.on('mousemove', 'locs', (ev: any) => {
    const f = ev.features && ev.features[0];
    const l = f && state.byId.get(Number(f.properties.id));
    setHover(l || null);
    if (state.tool !== 'pan') return;
    if (!f) return;
    if (!l) return;
    map.getCanvas().style.cursor = 'pointer';
    tip.setLngLat([l.lng, l.lat]).setOffset([0, -(44 * iconScale(map.getZoom())) - 6])
      .setText(l.title + (state.found.has(l.id) ? ' (found)' : '')).addTo(map);
  });
  map.on('mouseleave', 'locs', () => { map.getCanvas().style.cursor = ''; tip.remove(); setHover(null); });
  map.on('move', updateLinkHeads);
  map.on('movestart', closeCtx);
  map.on('contextmenu', (ev: any) => {
    const e = ev.originalEvent;
    if (state.tool !== 'pan' && state.tool !== 'marker') return;
    if (inSelection(ev.point)) return; // the selection's own menu
    e.preventDefault();
    mapMenuAt(e.clientX, e.clientY, ev.point, ev.lngLat);
  });
  // press and hold on touch (pan tool only: the marker tool places on press)
  const canvas: HTMLElement = map.getCanvasContainer();
  let pressT: ReturnType<typeof setTimeout> | null = null, pressAt: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (pressT) clearTimeout(pressT);
    if (e.pointerType !== 'touch' || e.button !== 0 || state.tool !== 'pan') return;
    pressAt = { x: e.clientX, y: e.clientY };
    pressT = setTimeout(() => {
      pressT = null;
      if (!pressAt) return;
      const r = canvas.getBoundingClientRect();
      const pt = { x: pressAt.x - r.left, y: pressAt.y - r.top };
      if (!inSelection(pt)) mapMenuAt(pressAt.x, pressAt.y, pt, map.unproject([pt.x, pt.y]));
    }, 500);
  });
  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (pressT && pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) { clearTimeout(pressT); pressT = null; }
  });
  (['pointerup', 'pointercancel'] as const).forEach(t => canvas.addEventListener(t, () => { if (pressT) clearTimeout(pressT); pressT = null; }));

  map.on('click', (ev: any) => {
    if (state.tool !== 'pan') return; // markers cannot be clicked while selecting or drawing
    document.body.classList.remove('side-open');
    const hits = map.queryRenderedFeatures(ev.point, { layers: ['locs'] });
    if (hits.length) select(Number(hits[0].properties.id), { fly: false });
    else closeDetail();
  });
}

// the picture a location shows on the map. Library icons are drawn once (as a pin with the glyph); until then the
// plain pin of the same colour stands in, and the map is drawn again when the pin is ready.
const pendingGlyphs = new Set<string>();
export function mapIcon(name: string | undefined): string | undefined {
  const map = state.map;
  if (!name) return name;
  if (name.startsWith('up-')) {
    if (!map.hasImage(name)) map.addImage(name, pingImage(name), { pixelRatio: 2 });
    return name;
  }
  if (!name.startsWith('ic-')) return name;
  if (map.hasImage(name)) return name;
  const plain = `up-${name.slice(-6)}`;
  if (!map.hasImage(plain)) map.addImage(plain, pingImage(plain), { pixelRatio: 2 });
  if (iconsReady() && !pendingGlyphs.has(name)) {
    pendingGlyphs.add(name);
    glyphPinImage(name).then(img => {
      if (img && !map.hasImage(name)) map.addImage(name, img, { pixelRatio: 2 });
      refreshMap();
    }).catch(() => {}).finally(() => pendingGlyphs.delete(name));
  }
  return plain;
}

// the markers a selected one links to, and the ones that link to it (both directions)
export function relatedOf(id: number): Set<number> {
  const out = new Set<number>([...(state.outLinks.get(id) || []), ...(state.inLinks.get(id) || [])]);
  out.delete(id);
  return out;
}

export function refreshMap(): void {
  if (!state.mapReady) return;
  const sel = state.selected, rel = sel != null ? relatedOf(sel) : new Set<number>();
  const feats: any[] = [];
  for (const l of state.locs) {
    // the card's marker and the markers it links to are always drawn: a filter (hidden category, hide found, a search)
    // must not hide what the card is about
    const pinned = l.id === sel || rel.has(l.id);
    if (!pinned) {
      if (!shownOnMap(l)) continue;
      if (state.search.ids && !state.search.ids.has(l.id)) continue; // while searching: the matches only
    }
    const icon = mapIcon(l.icon);
    const f = state.found.has(l.id) ? 1 : 0;
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lng, l.lat] }, properties: { id: l.id, icon, f, z: f ? 0 : 1 } });
  }
  state.map.getSource('locs').setData({ type: 'FeatureCollection', features: feats });
  syncRelatedRings(rel);
}

// a dotted ring on each related marker (the selected one has its solid circle, the 'sel' layer)
const relRings = new Map<number, HTMLDivElement>(); // location id -> ring element
let relRingsListening = false;
function syncRelatedRings(rel: Set<number>): void {
  for (const [id, el] of relRings) if (!rel.has(id)) { el.remove(); relRings.delete(id); }
  for (const id of rel) {
    if (relRings.has(id)) continue;
    const el = document.createElement('div');
    el.className = 'search-ring rel-ring';
    state.map.getContainer().appendChild(el);
    relRings.set(id, el);
  }
  if (rel.size && !relRingsListening) {
    relRingsListening = true;
    state.map.on('move', placeRelatedRings);
  }
  placeRelatedRings();
}

function placeRelatedRings(): void {
  for (const [id, el] of relRings) {
    const l = state.byId.get(id);
    if (!l) continue;
    const p = state.map.project([l.lng, l.lat]);
    el.style.transform = `translate(${p.x - 21}px, ${p.y - 38}px)`;
  }
}

export function refreshAll(): void {
  updateSidebar();
  renderPresets(); // the tag and its switch change which categories count as selected
  refreshMap();
  state.drawing?.render();
  if (state.search.active) runSearch();
  if (state.selected != null) renderDetail();
}
