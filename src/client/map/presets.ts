/* ---------- selection presets (which categories are on/off) ---------- */

import { esc } from '../../shared/escape.ts';
import { $, askDialog, state, toast, uid, UNTAGGED } from './state.ts';
import { getMeta, setMeta } from './db.ts';
import { scheduleViewSave, syncTagStrict, uniqueName } from './profiles.ts';
import { applicable, onViewChanged, updateSidebar } from './sidebar.ts';
import { refreshMap } from './map-view.ts';

// view settings are per map (what is on screen). Presets are per game: categories are the same in every map of a game,
// so a preset works in any of its maps. The first map's view key is the old one; the presets key is the game's.
export const perMap = (prefix: string, map: string): string =>
  prefix + state.entry.id + (map === state.meta.maps[0].slug ? '' : ':' + map);
export const viewKey = (map: string): string => perMap('view:', map);
export const presetsKey = (): string => 'presets:' + state.entry.id;

// presets used to be kept per map. Once per game, the lists of all its maps are merged into the game's list (same ids
// are the same preset, so a second device doing this changes nothing). Names that clash get "- copy", as in an import.
export async function migratePresets(): Promise<void> {
  const flag = 'presets-per-game:' + state.entry.id;
  if (await getMeta(flag)) return;
  const merged = [...((await getMeta(presetsKey())) || [])];
  const names = new Set<string>(merged.map(p => p.name));
  for (const m of state.meta.maps) {
    // the first map's old key is the game's key, so its list is already in `merged`
    if (m.slug === state.meta.maps[0].slug) continue;
    for (const p of (await getMeta(perMap('presets:', m.slug))) || []) {
      if (merged.some(x => x.id === p.id)) continue;
      merged.push({ ...p, name: names.has(p.name) ? uniqueName(p.name, names) : p.name });
      names.add(merged[merged.length - 1].name);
    }
  }
  await setMeta(presetsKey(), merged);
  await setMeta(flag, true);
}

export async function loadMapState(): Promise<void> {
  const map = state.mapInfo.slug;
  // the view lives in the profile (so it follows the profile to other devices); meta is only read for profiles saved before that
  const v = state.profile?.view?.[map] || (await getMeta(viewKey(map))) || {};
  state.view.hidden = new Set(v.hidden || []);
  state.view.hideFound = !!v.hideFound;
  state.view.collapsed = new Set(v.collapsed || []);
  const hideFoundEl = $<HTMLInputElement>('#hide-found');
  if (hideFoundEl) hideFoundEl.checked = state.view.hideFound;
  // the difficulty (tag) and its switch are per map too: tag ids are only unique within one map
  const t = 'tag' in v ? v.tag : (state.profile?.tag ?? null);
  state.tag = (t === UNTAGGED || (state.tags.length && state.tags.some((x: any) => x.id === t))) ? t : null;
  state.tagStrict = state.tag != null && state.tag !== UNTAGGED && !!('tagStrict' in v ? v.tagStrict : state.profile?.tagStrict);
  const tagSelectEl = $<HTMLSelectElement>('#tag-select');
  if (state.tags.length && tagSelectEl) tagSelectEl.value = state.tag == null ? '' : String(state.tag);
  syncTagStrict();
  state.presets = (await getMeta(presetsKey())) || [];
  state.presetId = state.presets.some((p: any) => p.id === v.presetId) ? v.presetId : null;
  state.baseline = state.presetId && Array.isArray(v.baseline) ? v.baseline : null;
  renderPresets();
}

export const savePresets = (): Promise<void> =>
  setMeta(presetsKey(), state.presets).catch(() => toast('Could not save presets in this browser.'));
export const presetById = (id: string | null | undefined): any =>
  state.presets.find((p: any) => p.id === id) || null;
export const currentPreset = (): any => presetById(state.presetId);

// With the tag switch on, a category only counts as selected if some of its markers render under the tag.
// Presets are saved and compared on that basis, so non-rendering categories are stored as unselected.
export const tagSwitchUsable = (): boolean => state.tag != null && state.tag !== UNTAGGED; // the switch only narrows a specific tag
export const tagOnly = (): boolean => tagSwitchUsable() && !!state.tagStrict;

export function renderedCatIds(): Set<number> {
  const ids = new Set<number>();
  for (const l of state.locs) if (applicable(l)) ids.add(l.cat);
  return ids;
}

export function selectedIn(hiddenIds: Iterable<number>): Set<number> {
  const h = new Set(hiddenIds), rendered = tagOnly() ? renderedCatIds() : null;
  return new Set([...state.cats.keys()].filter(id => !h.has(id) && (!rendered || rendered.has(id))));
}

// what a preset stores for the given hidden set
export function presetHidden(hiddenIds: Iterable<number>): number[] {
  if (!tagOnly()) return [...hiddenIds];
  const sel = selectedIn(hiddenIds);
  return [...state.cats.keys()].filter(id => !sel.has(id));
}

export function matchesView(p: { hidden: Iterable<number> }): boolean {
  const a = selectedIn(p.hidden), b = selectedIn(state.view.hidden);
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// The selected preset stays selected while it is edited (shown as modified). It is only replaced when
// the current selection exactly matches a different preset, or when the selected preset no longer exists.
export function syncPresetSelection(): void {
  const cur = currentPreset();
  if (cur && matchesView(cur)) return;
  if (!cur) state.presetId = null;
  const same = state.presets.find(matchesView);
  if (same) state.presetId = same.id;
}

export function applyPreset(p: { id: string; hidden: number[] }): void {
  if (!state.presetId) state.baseline = [...state.view.hidden]; // remember how things were before any preset
  state.presetId = p.id;
  state.view.hidden = new Set(p.hidden);
  onViewChanged();
}

// Leaves the preset and returns to the selection from before it was first picked (or keeps the current
// selection when there was none). Does not auto-match a preset, so "No preset" sticks.
export function exitPreset(): void {
  if (state.baseline) state.view.hidden = new Set(state.baseline);
  state.presetId = null;
  state.baseline = null;
  updateSidebar();
  refreshMap();
  scheduleViewSave();
  renderPresets({ sync: false });
}

export function renderPresets({ sync = true } = {}): void {
  if (!state.entry) return;
  if (sync) syncPresetSelection();
  if (!state.presetId) state.baseline = null;
  const cur = currentPreset();
  const modified = !!cur && !matchesView(cur);

  const sel = $<HTMLSelectElement>('#preset-select');
  if (sel) {
    const first = cur ? 'No preset' : 'Choose a preset…';
    sel.innerHTML = `<option value="">${first}</option>` + state.presets.map((p: any) => {
      const sel1 = p.id === state.presetId;
      const dot = sel1 && modified ? 'modified' : 'clean';
      return `<option value="${esc(p.id)}"${sel1 && modified ? ' class="modified"' : ''}>` +
        `<span class="dot ${dot}"></span>${esc(p.name)}</option>`;
    }).join('');
    sel.value = state.presetId ?? '';
    sel.classList.toggle('modified', modified);
    sel.classList.toggle('has-status', !!cur);
  }

  const status = $('#preset-status');
  if (status) {
    status.hidden = !cur;
    status.className = 'dot preset-status ' + (modified ? 'modified' : 'clean');
  }

  const bar = $('#preset-bar');
  if (bar) bar.hidden = !modified;
  document.querySelectorAll<HTMLButtonElement>('#preset-menu [data-needs-preset]').forEach(b => { b.disabled = !cur; });
}

export async function presetAction(act: string): Promise<void> {
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
    // categories this map does not have keep their state: the preset may have been made on another map of the game
    p.hidden = [...p.hidden.filter((id: number) => !state.cats.has(id)), ...presetHidden(state.view.hidden)];
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
    state.presets = state.presets.filter((x: any) => x.id !== p.id);
    await savePresets();
    exitPreset();
  }
}
