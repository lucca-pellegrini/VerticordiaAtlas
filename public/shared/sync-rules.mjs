// sync-rules.mjs: the one definition of what counts as a change when profiles are synced. The server (api.mjs) and the
// browser (sync.js) both import it, so they cannot disagree about whether two copies of an item are the same.
//
// Three questions, three keys:
//   stable(v)        the canonical JSON text of a value (keys sorted, undefined dropped)
//   contentKey(k,v)  the content of an item: what a conflict is about. Position (map, camera) and the touch time are left out,
//                    so moving the view never looks like an edit to someone else's progress
//   sendKey(k,v)     whether an item needs sending: everything except the touch time (saving without a change is not a change)
// Nothing here uses anything Node- or browser-specific: it is served to the browser as it is.

export const TOUCH_FIELD = 'updated';                          // when the profile was last saved
export const POSITION_FIELDS = [TOUCH_FIELD, 'map', 'cameras']; // where the view is: last write wins, never a conflict

export function stable(v) {
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// profile records lose the listed fields; other items (meta) are compared whole
function without(key, v, fields) {
  if (!key.startsWith('profile:') || !v || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !fields.includes(k)));
}

export const contentKey = (key, v) => stable(without(key, v, POSITION_FIELDS));
export const sendKey = (key, v) => stable(without(key, v, [TOUCH_FIELD]));

// FNV-1a over a string: enough to tell whether something changed, and small to keep in the sync state
export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
