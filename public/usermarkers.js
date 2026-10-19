// User markers: your own markers and categories, saved with the profile, plus temporary markers that only live
// in this tab. They are drawn as a ping in their category colour, can hold notes (markdown), and link to any
// other marker the same way official markers link to each other. Export and import carry the profile's copy.
import { PALETTE } from './drawing.js';
import { unpackMarker } from './share-link.mjs';
import { iconInner, iconsReady, loadIconLibrary, searchIcons, pinImage } from './icons-lib.mjs';
import { ICONS, svgIcon } from './icons.mjs';

export const TEMP_CAT_ID = -1;
export const TEMP_CAT = { id: TEMP_CAT_ID, title: 'Temporary', color: '#ffb547', temp: true };
const NEW_CAT = '__new';

// the tool-stack button: a ping
export const MARKER_CONTROL_HTML =
  '<button type="button" id="tool-marker" class="notched" aria-label="Place marker" title="Place a marker. Tap again, or right-click or hold, for more">' +
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="5.5"/><circle cx="12" cy="11" r="1.8"/><path d="M12 16.5V21"/></svg></button>';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// record ids are negative: they cannot collide with the game's own marker ids (positive)
const newId = () => -(Math.floor(Math.random() * 2e9) + 1);

// The picture of a user marker for the map: the site's pin in its colour (see icons-lib drawPin). Temporary ones are
// translucent with a dashed outline. `name` is "up-<rrggbb>" or "up-<rrggbb>-t".
export function pingImage(name) {
  return pinImage('#' + name.slice(3).replace('-t', ''), name.endsWith('-t'));
}

// the icon picker: a search box over the library, and a grid; the first tile is the plain dot (the default)
function iconField(current) {
  return '<div class="field um-icon"><span>Icon</span>' +
    '<input type="search" class="um-icon-q" placeholder="Search icons, e.g. key, skull, tree" autocomplete="off" aria-label="Search icons">' +
    '<div class="um-icon-grid" role="listbox" aria-label="Icons"></div>' +
    `<input type="hidden" name="glyph" value="${esc(current || '')}"></div>`;
}
function wireIcon(root) {
  const q = root.querySelector('.um-icon-q'), grid = root.querySelector('.um-icon-grid'), hid = root.querySelector('input[name="glyph"]');
  const color = root.querySelector('input[name="color"]');
  const paintColor = () => grid.style.setProperty('--c', color?.value || '#e5484d');
  root.addEventListener('um-color', paintColor); // the colour fields announce their changes
  const draw = () => {
    const tile = (val, label, inner) =>
      `<button type="button" class="ic-tile${hid.value === val ? ' on' : ''}" data-glyph="${val}" aria-label="${label}" title="${label}">${inner}</button>`;
    const names = searchIcons(q.value, 120);
    grid.innerHTML = tile('', 'Plain dot', '<span class="ico-ping-mini"></span>') +
      names.map(n => tile(n, n.replace(/-/g, ' '), `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${iconInner(n)}</svg>`)).join('') +
      (names.length ? '' : '<p class="none">No icon matches.</p>');
  };
  q.addEventListener('input', draw);
  grid.addEventListener('click', e => {
    const b = e.target.closest('[data-glyph]');
    if (!b) return;
    hid.value = b.dataset.glyph;
    draw();
  });
  paintColor();
  if (iconsReady()) draw();
  else {
    grid.innerHTML = '<p class="none">Loading icons…</p>';
    loadIconLibrary().then(draw, () => { grid.innerHTML = '<p class="none">The icons could not be loaded.</p>'; });
  }
}

export function setupUserMarkers({ map, state, mapEl, canvasBox, changed, select, closeDetail, askDialog, toast, requestTool }) {
  const profileCats = () => (state.profile.userCats ||= []);
  const profileMarkers = () => (state.profile.userMarkers ||= []);
  const findMarker = id => profileMarkers().find(m => m.id === id) || state.tempMarkers.find(m => m.id === id) || null;
  const local = e => { const r = canvasBox.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  let active = false, kind = 'perm', moveId = null;

  /* ---- the shared dialog element, filled with a form ---- */
  function dialog(title, body, { ok = 'Save', danger = null, onReady } = {}) {
    return new Promise(resolve => {
      const d = document.getElementById('dlg'), form = document.getElementById('dlg-form');
      form.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="dlg-actions">` +
        (danger ? `<button type="button" class="danger" data-del>${esc(danger)}</button>` : '') +
        `<button type="button" data-cancel>Cancel</button><button class="primary">${esc(ok)}</button></div>`;
      d.classList.add('um');
      const finish = r => { d.classList.remove('um'); if (d.open) d.close(); resolve(r); };
      form.onsubmit = e => { e.preventDefault(); finish({ form }); };
      form.querySelector('[data-cancel]').onclick = () => finish(null);
      form.querySelector('[data-del]')?.addEventListener('click', () => finish({ del: true }));
      d.oncancel = () => finish(null);
      onReady?.(form);
      d.showModal();
    });
  }
  // a colour: palette swatches, a native colour picker (its wheel), and the hex code. Name must be "color".
  function colorField(c) {
    return `<div class="field um-color"><span>Colour</span><div class="um-sw">${PALETTE.map(p =>
      `<button type="button" class="sw" data-color="${p}" style="--c:${p}" aria-label="${p}"></button>`).join('')}</div>` +
      `<div class="um-colorrow"><input type="color" name="color" value="${esc(c)}" aria-label="Colour wheel">` +
      `<input class="um-hex" maxlength="7" value="${esc(c)}" spellcheck="false" aria-label="Hex colour"></div></div>`;
  }
  function wireColor(root) {
    const color = root.querySelector('input[name="color"]'), hex = root.querySelector('.um-hex');
    const set = c => {
      color.value = c;
      hex.value = c;
      root.querySelectorAll('.sw').forEach(b => b.classList.toggle('on', b.dataset.color === c));
      root.dispatchEvent(new Event('um-color'));
    };
    root.querySelectorAll('.sw').forEach(b => b.addEventListener('click', () => set(b.dataset.color)));
    color.addEventListener('input', () => set(color.value));
    hex.addEventListener('input', () => { const v = hex.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) set('#' + v.replace('#', '').toLowerCase()); });
    set(color.value);
  }

  /* ---- records ---- */
  function removeRecords(ids) {
    const gone = new Set(ids);
    state.profile.userMarkers = profileMarkers().filter(m => !gone.has(m.id));
    state.tempMarkers = state.tempMarkers.filter(m => !gone.has(m.id));
    for (const id of ids) state.found.delete(id);
    for (const m of [...state.profile.userMarkers, ...state.tempMarkers]) {
      if (m.links?.length) m.links = m.links.filter(x => !gone.has(x));
    }
  }

  // a category whose last marker is gone goes too, so an empty "User markers" group does not linger
  function pruneEmptyCategories(catIds) {
    const used = new Set(profileMarkers().map(m => m.cat));
    state.profile.userCats = profileCats().filter(c => !catIds.includes(c.id) || used.has(c.id));
  }

  async function deleteMarker(m) {
    const ok = await askDialog({ title: 'Delete marker?', message: `"${m.title}" will be removed.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    const cat = m.cat;
    removeRecords([m.id]);
    pruneEmptyCategories([cat]);
    if (state.selected === m.id) closeDetail();
    changed();
  }

  // several user markers at once (from a selection); categories left empty go too
  async function deleteMany(ids) {
    if (!ids.length) return;
    const n = ids.length;
    const ok = await askDialog({ title: `Delete ${n} user marker${n === 1 ? '' : 's'}?`, message: 'They will be removed from this profile.', okLabel: 'Delete', danger: true });
    if (!ok) return;
    const cats = [...new Set(ids.map(id => findMarker(id)?.cat))];
    removeRecords(ids);
    pruneEmptyCategories(cats);
    if (ids.includes(state.selected)) closeDetail();
    changed();
  }

  async function deleteCategory(cat) {
    const ids = profileMarkers().filter(m => m.cat === cat.id).map(m => m.id);
    const message = ids.length ? `"${cat.title}" and its ${ids.length} marker${ids.length === 1 ? '' : 's'} will be removed.` : `"${cat.title}" will be removed.`;
    const ok = await askDialog({ title: 'Delete category?', message, okLabel: 'Delete', danger: true });
    if (!ok) return;
    removeRecords(ids);
    state.profile.userCats = profileCats().filter(c => c.id !== cat.id);
    if (ids.includes(state.selected)) closeDetail();
    changed();
  }

  /* ---- the marker form: new (at a point) or edit ---- */
  async function markerForm({ marker = null, pos = null, temp = false, promote = false }) {
    const isTemp = promote ? false : marker ? !!marker.temp : temp; // promoting a temporary marker: it becomes a permanent one
    const cats = profileCats();
    const links = [...(marker?.links || [])];
    const sh = marker?.shared || null;
    const sameName = sh ? cats.find(c => c.title.trim().toLowerCase() === sh.name.trim().toLowerCase()) : null;
    const selCat = marker && !marker.temp ? marker.cat : sameName ? sameName.id : sh ? NEW_CAT : (cats[0]?.id ?? NEW_CAT);
    const fresh = sh && !sameName ? sh : null; // the new category starts as the shared one
    const opts = cats.map(c => `<option value="${c.id}"${c.id === selCat ? ' selected' : ''}>${esc(c.title)}</option>`).join('') +
      `<option value="${NEW_CAT}"${selCat === NEW_CAT ? ' selected' : ''}>New category…</option>`;
    const body =
      `<label class="field"><span>Name</span><input name="title" maxlength="80" required value="${esc(marker?.title || '')}" autocomplete="off"></label>` +
      (isTemp
        ? '<p class="d-note">Temporary: this marker is gone when the tab closes.</p>'
        : `<label class="field"><span>Category</span><select name="cat">${opts}</select></label>` +
          `<div class="um-newcat" ${selCat === NEW_CAT ? '' : 'hidden'}><label class="field"><span>New category</span>` +
          `<input name="newcat" maxlength="40" placeholder="e.g. Keys" autocomplete="off" value="${esc(fresh?.name || '')}"></label>${colorField(fresh?.color || PALETTE[0])}${iconField(fresh?.glyph || '')}</div>`) +
      `<label class="field"><span>Notes</span><textarea name="desc" rows="4" placeholder="Markdown works">${esc(marker?.desc || '')}</textarea></label>` +
      '<div class="field"><span>Links</span><div class="um-chips"></div>' +
      '<input type="search" class="um-q" placeholder="Find a marker to link" autocomplete="off"><ul class="um-pick" hidden></ul></div>';

    const onReady = form => {
      const sel = form.elements.cat, block = form.querySelector('.um-newcat');
      if (sel) sel.addEventListener('change', () => { block.hidden = sel.value !== NEW_CAT; });
      if (block) { wireColor(block); wireIcon(block); }
      const chips = form.querySelector('.um-chips'), q = form.querySelector('.um-q'), pick = form.querySelector('.um-pick');
      const drawChips = () => {
        chips.innerHTML = links.map(id => {
          const t = state.byId.get(id);
          return `<span class="um-chip">${esc(t ? t.title : id > 0 ? 'Marker on another map' : 'Missing marker')}<button type="button" data-rm="${id}" aria-label="Remove link">&times;</button></span>`;
        }).join('');
      };
      chips.onclick = e => {
        const b = e.target.closest('[data-rm]');
        if (!b) return;
        const i = links.indexOf(Number(b.dataset.rm));
        if (i >= 0) links.splice(i, 1);
        drawChips();
      };
      const drawPick = () => {
        const s = q.value.trim().toLowerCase();
        if (!s) { pick.hidden = true; pick.innerHTML = ''; return; }
        const hits = state.locs.filter(l => l.id !== marker?.id && !links.includes(l.id) && l.title.toLowerCase().includes(s)).slice(0, 8);
        pick.innerHTML = hits.length
          ? hits.map(l => `<li data-add="${l.id}">${esc(l.title)}<small>${esc(state.cats.get(l.cat)?.title || '')}</small></li>`).join('')
          : '<li class="none">No marker matches</li>';
        pick.hidden = false;
      };
      q.addEventListener('input', drawPick);
      q.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); }); // Enter in the search must not submit the form
      pick.onclick = e => {
        const li = e.target.closest('[data-add]');
        if (!li) return;
        links.push(Number(li.dataset.add));
        q.value = '';
        drawPick();
        drawChips();
      };
      drawChips();
    };

    const heading = promote ? 'Make permanent' : marker ? 'Edit marker' : 'New marker';
    const res = await dialog(heading, body, { ok: marker && !promote ? 'Save' : promote ? 'Make permanent' : 'Place', danger: marker && !promote ? 'Delete' : null, onReady });
    if (!res) return null;
    if (res.del) { await deleteMarker(marker); return null; }

    const f = res.form.elements;
    const title = f.title.value.trim();
    if (!title) { toast('A marker needs a name.'); return null; }
    let cat = TEMP_CAT_ID;
    if (!isTemp) {
      cat = f.cat.value;
      if (cat === NEW_CAT) {
        const name = f.newcat.value.trim();
        if (!name) { toast('Give the new category a name.'); return null; }
        const c = { id: newId(), title: name, color: f.color.value, glyph: f.glyph?.value || null };
        profileCats().push(c);
        cat = c.id;
      } else cat = Number(cat);
    }
    const data = { title, cat, desc: f.desc.value, links: links.filter(id => id !== marker?.id && (id > 0 || state.byId.has(id))) };
    let saved;
    const oldCat = marker?.cat;
    if (promote) {
      // the temporary marker leaves the temporary list and joins the profile's own, keeping its place and id
      state.tempMarkers = state.tempMarkers.filter(x => x.id !== marker.id);
      saved = { id: marker.id, ...data, lat: marker.lat, lng: marker.lng, created: Date.now(), map: marker.map };
      profileMarkers().push(saved);
    } else if (marker) saved = Object.assign(marker, data);
    else if (isTemp) { saved = { id: newId(), ...data, lat: pos.lat, lng: pos.lng, temp: true, map: state.mapInfo.slug }; state.tempMarkers.push(saved); }
    else { saved = { id: newId(), ...data, lat: pos.lat, lng: pos.lng, created: Date.now(), map: state.mapInfo.slug }; profileMarkers().push(saved); }
    if (oldCat !== undefined && oldCat !== saved.cat) pruneEmptyCategories([oldCat]); // moved out of its old category
    changed();
    return saved;
  }

  // a category on its own: create, rename, recolour, delete
  async function categoryForm(cat) {
    const body = `<label class="field"><span>Name</span><input name="title" maxlength="40" required value="${esc(cat?.title || '')}" autocomplete="off"></label>` +
      colorField(cat?.color || PALETTE[2]) + iconField(cat?.glyph || '');
    const res = await dialog(cat ? 'Edit category' : 'New category', body,
      { ok: cat ? 'Save' : 'Create', danger: cat ? 'Delete category' : null, onReady: form => { wireColor(form); wireIcon(form); } });
    if (!res) return;
    if (res.del) return deleteCategory(cat);
    const f = res.form.elements;
    const title = f.title.value.trim();
    if (!title) return;
    const glyph = f.glyph.value || null;
    if (cat) { cat.title = title; cat.color = f.color.value; cat.glyph = glyph; }
    else profileCats().push({ id: newId(), title, color: f.color.value, glyph });
    changed();
  }

  /* ---- placing, moving ---- */
  async function addMarker(pos, temp) {
    const m = await markerForm({ pos, temp });
    if (!m) return;
    select(m.id, { fly: false });
    requestTool('pan'); // one marker at a time: a placed marker puts the hand back on
  }
  function startMove(m) {
    moveId = m.id;
    requestTool('marker');
    toast(`Click the map to move "${m.title}". Esc cancels.`, 4000);
  }

  canvasBox.addEventListener('pointerdown', e => {
    if (!active || e.button !== 0) return;
    const p = local(e);
    const ll = map.unproject([p.x, p.y]);
    const pos = { lat: ll.lat, lng: ll.lng };
    if (moveId != null) {
      const m = findMarker(moveId);
      moveId = null;
      if (m) {
        m.lat = pos.lat;
        m.lng = pos.lng;
        changed();
        select(m.id, { fly: false, push: false }); // the selection ring follows the marker to its new place
        requestTool('pan'); // one move at a time: back to the hand
      }
      return;
    }
    addMarker(pos, kind === 'temp');
  });

  /* ---- the marker button: tap = place; tap again, right-click or hold = permanent or temporary ---- */
  const markerBtn = document.getElementById('tool-marker');
  const pickMenu = document.createElement('div');
  pickMenu.id = 'marker-menu'; pickMenu.className = 'menu row-menu'; pickMenu.hidden = true; pickMenu.setAttribute('role', 'menu');
  pickMenu.innerHTML = '<button type="button" role="menuitemradio" data-kind="perm" aria-checked="false">' + svgIcon('pin') + '<span>Permanent marker</span></button>' +
    '<button type="button" role="menuitemradio" data-kind="temp" aria-checked="false">' + svgIcon('tempPin') + '<span>Temporary marker</span></button>';
  // the tool's icon: a pin, or a pin with a clock when the next marker is temporary
  function syncToolIcon() { markerBtn.querySelector('svg').innerHTML = ICONS[kind === 'temp' ? 'tempPin' : 'pin']; }
  syncToolIcon();
  document.body.appendChild(pickMenu);

  function placeBeside(elm, rect) {
    elm.hidden = false;
    const w = elm.offsetWidth, h = elm.offsetHeight, pad = 8;
    elm.style.left = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad)) + 'px';
    elm.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + 'px';
  }
  function openPick() {
    pickMenu.querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.kind === kind)));
    placeBeside(pickMenu, markerBtn.getBoundingClientRect());
  }
  let holdT = null, held = false;
  markerBtn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    held = false;
    holdT = setTimeout(() => { held = true; openPick(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => markerBtn.addEventListener(t, () => clearTimeout(holdT)));
  markerBtn.addEventListener('click', () => {
    if (held) { held = false; return; }
    if (active) { if (pickMenu.hidden) openPick(); else pickMenu.hidden = true; return; }
    pickMenu.hidden = true;
    requestTool('marker');
  });
  markerBtn.addEventListener('contextmenu', e => { e.preventDefault(); openPick(); });
  pickMenu.onclick = e => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    kind = b.dataset.kind;
    syncToolIcon();
    pickMenu.hidden = true;
    requestTool('marker');
  };
  document.addEventListener('click', e => { if (!e.target.closest('#marker-menu, #tool-marker')) pickMenu.hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    pickMenu.hidden = true;
    if (moveId != null) { moveId = null; toast('Move cancelled'); }
  });

  function setActive(on) {
    active = on;
    if (!on) moveId = null;
    mapEl.classList.toggle('tool-marker', on);
    markerBtn.setAttribute('aria-pressed', String(on));
  }

  // a link to a user marker: it is added as a temporary marker on the current map, and focused
  async function addSharedTemp(packed) {
    const d = await unpackMarker(packed);
    if (!d) return toast('That link does not hold a valid marker.', 5000);
    const shared = d.category ? { name: d.category, color: d.color, glyph: d.glyph } : null;
    const m = { id: newId(), title: d.title, desc: d.desc, cat: TEMP_CAT_ID, lat: d.lat, lng: d.lng, links: d.links, temp: true, map: state.mapInfo.slug, shared };
    state.tempMarkers.push(m);
    changed();
    select(m.id, { fly: true });
    toast('Shared marker added as temporary. Make it permanent from its card.', 5000);
  }

  /* ---- hooks for the sidebar's group and category menus ---- */
  function menuItems(user) {
    if (!user) return [];
    if (user.kind === 'group') return [{ act: 'newcat', label: 'New category', icon: 'plus' }];
    if (user.kind === 'cat' && user.id === TEMP_CAT_ID) return [{ act: 'clear-temp', label: 'Clear temporary markers', icon: 'trash', danger: true }];
    if (user.kind === 'cat') return [{ act: 'editcat', label: 'Edit category', icon: 'pencil' }, { act: 'delcat', label: 'Delete category', icon: 'trash', danger: true }];
    return [];
  }  async function menuAction(act, user) {
    if (act === 'newcat') return categoryForm(null);
    if (act === 'clear-temp') {
      const n = state.tempMarkers.length;
      const ok = await askDialog({ title: 'Clear temporary markers?', message: `${n} temporary marker${n === 1 ? '' : 's'} will be removed.`, okLabel: 'Clear', danger: true });
      if (!ok) return;
      removeRecords(state.tempMarkers.map(m => m.id));
      return changed();
    }
    const cat = profileCats().find(c => c.id === user.id);
    if (!cat) return;
    if (act === 'editcat') return categoryForm(cat);
    if (act === 'delcat') return deleteCategory(cat);
  }

  /* ---- hooks for the detail card of a user marker ---- */
  function detailHtml(l) {
    const links = (l.links || []).map(id => state.byId.get(id)).filter(Boolean);
    const list = links.length
      ? `<div class="d-links"><h3>Links</h3><ul>${links.map(t => `<li><a href="#loc=${t.id}" data-loc="${t.id}">${esc(t.title)}</a></li>`).join('')}</ul></div>`
      : '';
    const btn = (act, label, icon, danger) =>
      `<button type="button" class="ibtn${danger ? ' danger' : ''}" data-um="${act}" data-tip="${label}" aria-label="${label}">${svgIcon(icon)}</button>`;
    return `<div class="um-bar"><span class="um-badge">${l.temp ? 'Temporary' : 'Your marker'}</span>` +
      (l.temp ? btn('promote', 'Make permanent', 'save') : '') +
      btn('edit', 'Edit', 'pencil') + btn('move', 'Move', 'move') + btn('delete', 'Delete', 'trash', true) +
      '</div>' + list;
  }  async function detailAction(act, id) {
    const m = findMarker(id);
    if (!m) return;
    if (act === 'promote') await markerForm({ marker: m, promote: true });
    else if (act === 'edit') await markerForm({ marker: m });
    else if (act === 'move') startMove(m);
    else if (act === 'delete') await deleteMarker(m);
  }

  return { setActive, menuItems, menuAction, detailHtml, detailAction, deleteMany, addSharedTemp, placeAt: addMarker, startMove };
}
