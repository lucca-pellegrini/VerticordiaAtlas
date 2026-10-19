// sync.js: keeps this device's progress in step with the server, for signed-in users only. The app never needs it:
// everything is written to IndexedDB first, and this only moves that data around in the background.
//
// Tabs: exactly one tab is the leader (it holds the Web Lock 'va-sync-leader'); it alone talks to the server. Other
// tabs hear about what the leader changed over a BroadcastChannel, and reload from IndexedDB.
// Conflicts: an item is sent with the server timestamp this device last saw ("base"). If the server has something newer
// while this device also has unsent changes to the same item, the user is asked which to keep. Otherwise the newer wins.

import { contentKey, sendKey, fnv } from './shared/sync-rules.mjs'; // the same rules as the server (see that file)

const CHANNEL = 'va-sync';
const LOCK = 'va-sync-leader';
const BATCH = 100;

// the store the app gives us: IndexedDB, through the app's helpers
// ui: { status({online}), conflicts([{key,label}]), remoteChanged(keys), signedOut() }

export function createSync({ store, ui, api, socketUrl = null }) {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  let leader = false, running = false, online = navigator.onLine;
  let st = { sent: {}, content: {}, seen: {}, conflicts: {} }; // sent: key -> hash of what we last agreed on; content: the same, for the content only; seen: key -> server time
  let pushTimer = null, interval = null, stopped = false, again = false;
  const clientId = crypto.randomUUID(); // names this tab to the server, so it is not told about its own pushes
  let sock = null, sockTimer = null, sockFails = 0, live = false;

  /* ---------- what this device holds, as sync items ---------- */
  // hashes of what a device holds: sendHash decides whether an item needs sending, contentHash whether it is a conflict
  const sendHash = (key, v) => (v === null || v === undefined ? null : fnv(sendKey(key, v)));
  const contentHash = (key, v) => (v === null || v === undefined ? null : fnv(contentKey(key, v)));
  async function snapshot() {
    const map = new Map();
    for (const p of await store.profiles()) {
      const { key, ...v } = p;
      map.set(`profile:${p.game}:${p.id}`, v);
    }
    for (const e of await store.metaEntries()) {
      if (/^presets:/.test(e.k)) map.set(`meta:${e.k}`, e.v); // the view is part of the profile now
    }
    return map;
  }
  const isDirty = (key, snap) => {
    if (!(key in st.content) && key in st.sent) { // state from before content hashes: the whole item decides, as it did
      return (snap.has(key) ? sendHash(key, snap.get(key)) : null) !== st.sent[key];
    }
    const cur = snap.has(key) ? contentHash(key, snap.get(key)) : null;
    return cur !== (st.content[key] ?? null);
  };

  /* ---------- applying server data to this device ---------- */
  async function applyRemote(item) {
    if (item.key.startsWith('profile:')) {
      const [, game, id] = item.key.split(':');
      if (item.value === null) await store.deleteProfile(`${game}:${id}`);
      else await store.putProfile({ ...item.value, key: `${game}:${id}`, game, id });
    } else {
      const k = item.key.slice(5); // "meta:" prefix
      if (item.value === null) await store.removeMeta(k);
      else await store.putMeta(k, item.value);
    }
  }

  async function loadState() {
    const saved = await store.getMeta('sync:state');
    if (saved) st = { sent: saved.sent || {}, content: saved.content || {}, seen: saved.seen || {}, conflicts: saved.conflicts || {} };
  }
  const saveState = () => store.putMeta('sync:state', st);

  /* A new device starts with an empty profile of its own. When the account's profile for that game arrives, the
     placeholder (empty, and never synced from here) gives way to it, so the two do not sit side by side. */
  async function adoptOverPlaceholders(key) {
    const game = key.split(':')[1];
    for (const p of await store.profiles()) {
      const k = `profile:${p.game}:${p.id}`;
      if (p.game === game && k !== key && !(k in st.sent) && store.isEmpty(p)) await store.deleteProfile(`${p.game}:${p.id}`);
    }
  }

  /* ---------- pull: the server's newer items ---------- */
  async function pull() {
    const { items } = await api('GET', 'sync');
    const snap = await snapshot();
    const changed = [];
    for (const item of items) {
      if ((st.seen[item.key] ?? 0) >= item.updated_at) continue;
      if (isDirty(item.key, snap)) {
        // we have unsent changes here, and the server has moved on: the user decides
        st.conflicts[item.key] = { server: item.value, updated_at: item.updated_at };
        continue;
      }
      if (item.key.startsWith('profile:') && item.value !== null) await adoptOverPlaceholders(item.key);
      await applyRemote(item);
      st.sent[item.key] = sendHash(item.key, item.value);
      st.content[item.key] = contentHash(item.key, item.value);
      st.seen[item.key] = item.updated_at;
      changed.push(item.key);
    }
    if (changed.length) {
      bc?.postMessage({ type: 'remote', keys: changed });
      await ui.remoteChanged(changed);
    }
    if (Object.keys(st.conflicts).length) ui.conflicts(conflictList());
  }

  /* ---------- push: this device's changes ---------- */
  async function push() {
    const snap = await snapshot();
    const items = [];
    for (const [key, value] of snap) {
      if (st.sent[key] !== sendHash(key, value)) items.push({ key, value, base: st.seen[key] ?? 0 });
    }
    for (const key of Object.keys(st.sent)) {
      if (!snap.has(key) && st.sent[key] !== null) items.push({ key, value: null, base: st.seen[key] ?? 0 }); // deleted here
    }
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const { results } = await api('POST', 'sync', { items: batch, client: clientId });
      const sent = new Map(batch.map(it => [it.key, it]));
      for (const r of results) {
        const it = sent.get(r.key);
        if (r.status === 'ok') {
          st.sent[r.key] = sendHash(r.key, it.value);
          st.content[r.key] = contentHash(r.key, it.value);
          st.seen[r.key] = r.updated_at;
          delete st.conflicts[r.key];
        } else {
          st.conflicts[r.key] = { server: r.value, updated_at: r.updated_at };
        }
      }
    }
    if (Object.keys(st.conflicts).length) ui.conflicts(conflictList());
  }

  const conflictList = () => Object.keys(st.conflicts).map(key => ({ key, label: labelFor(key) }));
  const labelFor = key => {
    if (key.startsWith('profile:')) return `Progress for "${key.split(':')[2]}"`;
    return 'Selection presets';
  };

  /* ---------- the cycle (leader only) ---------- */
  async function cycle() {
    if (!leader || stopped) return;
    if (running) { again = true; return; } // something changed mid-cycle: go round once more afterwards, so it is not left for the timer
    if (!online) return;
    running = true;
    try {
      await loadState();
      await pull();
      await push();
      await saveState();
      setOnline(true);
    } catch (e) {
      if (e.status === 401) { stopped = true; sock?.close(); ui.signedOut(); }
      else if (e.network) setOnline(false);
      else console.error('sync:', e);
    } finally {
      running = false;
      if (again && !stopped) { again = false; schedulePush(0); }
    }
  }

  /* ---------- live updates ----------
     While the socket is open the server says when another device pushed, so the timer is only a safety net. Without
     it (a proxy that does not pass WebSockets, or no connection) the timer polls every minute, as it always did. */
  const POLL_FAST = 60_000, POLL_SLOW = 5 * 60_000;
  function setPolling(ms) { clearInterval(interval); interval = setInterval(cycle, ms); }

  function openSocket() {
    if (!socketUrl || !leader || stopped || !online || sock || typeof WebSocket === 'undefined') return;
    let ws;
    try { ws = new WebSocket(socketUrl(clientId)); } catch { return scheduleSocket(); }
    sock = ws;
    ws.onopen = () => { sockFails = 0; };
    ws.onmessage = ev => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch { /* not ours */ }
      if (m?.type === 'hello') { live = true; setPolling(POLL_SLOW); cycle(); } // catch up on whatever happened while it was down
      else if (m?.type === 'changed') cycle();
    };
    ws.onclose = ev => {
      if (sock === ws) sock = null;
      if (live) { live = false; setPolling(POLL_FAST); }
      if (ev.code === 4401) return; // signed out: the next cycle finds out and takes the page there
      sockFails++;
      scheduleSocket();
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  function scheduleSocket() {
    clearTimeout(sockTimer);
    if (!socketUrl || !leader || stopped) return;
    const wait = Math.min(5 * 60_000, 1000 * 2 ** Math.min(sockFails, 9)) * (0.75 + Math.random() * 0.5);
    sockTimer = setTimeout(openSocket, wait);
  }

  function setOnline(v) {
    if (online === v) return;
    online = v;
    bc?.postMessage({ type: 'status', online: v });
    ui.status({ online: v });
  }

  /* the user's answer to a conflict: keep the server's copy, or send this device's copy over it */
  async function resolveConflicts(choice) {
    await loadState();
      const taken = [];
    for (const key of Object.keys(st.conflicts)) {
      const c = st.conflicts[key];
      if (choice === 'server') {
        await applyRemote({ key, value: c.server, updated_at: c.updated_at });
        st.sent[key] = sendHash(key, c.server);
        st.content[key] = contentHash(key, c.server);
        taken.push(key);
      }
      // 'local': this device's copy stays as it is; based on the server's newer time, it goes up on the next push
      st.seen[key] = c.updated_at;
      delete st.conflicts[key];
    }
    await saveState();
    if (taken.length) {
      bc?.postMessage({ type: 'remote', keys: taken });
      await ui.remoteChanged(taken);
    }
    schedulePush(0);
  }

  function schedulePush(ms = 1500) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(cycle, ms);
  }

  /* ---------- tabs ---------- */
  bc?.addEventListener('message', ev => {
    const m = ev.data || {};
    if (m.type === 'local' && leader) schedulePush();
    if (m.type === 'remote' && !leader) ui.remoteChanged(m.keys || []);
    if (m.type === 'status' && !leader) ui.status({ online: m.online });
  });

  function start() {
    const hold = () => new Promise(() => {}); // held for as long as this tab lives
    const becomeLeader = () => {
      leader = true;
      cycle();
      setPolling(POLL_FAST);
      openSocket();
      return hold();
    };
    if (navigator.locks) navigator.locks.request(LOCK, becomeLeader);
    else becomeLeader();
    addEventListener('online', () => { setOnline(true); cycle(); sockFails = 0; clearTimeout(sockTimer); openSocket(); });
    addEventListener('offline', () => { setOnline(false); sock?.close(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') cycle(); });
  }

  return {
    start,
    noteLocal() { bc?.postMessage({ type: 'local' }); if (leader) schedulePush(); },
    resolveConflicts,
    isLeader: () => leader,
  };
}
