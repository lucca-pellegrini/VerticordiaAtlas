// src/shared/escape.ts
var esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// src/client/account.ts
var ROOT = new URL("./", import.meta.url);
var SIGNED_IN_KEY = "va-account";
async function api(method, path, body) {
  let res;
  const rel = String(path).replace(/^\/+/, "").replace(/^api\//, "");
  try {
    res = await fetch(new URL("api/" + rel, ROOT), {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw Object.assign(new Error("network"), { network: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
function socketUrl(client) {
  const u = new URL("api/ws", ROOT);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.search = new URLSearchParams({ c: client }).toString();
  return u.href;
}
var user = null;
var toastFn = null;
var netBox = null;
var currentUser = () => user;
var ICON = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  out: '<path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  all: '<rect x="3" y="4" width="13" height="10" rx="2"/><path d="M7 20h5M9 14v6M18 9h3v11h-3"/>',
  cloudOff: '<path d="M3 3l18 18M8.5 8.6A6 6 0 0 0 6 19h11a4 4 0 0 0 1.4-7.7A6 6 0 0 0 12 6c-.7 0-1.4.1-2 .3"/>'
};
var svg = (name, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
var signinUrl = () => new URL("signin/", ROOT).href + "?next=" + encodeURIComponent(location.pathname + location.search);
function menuMarkup(u) {
  return `<div class="acct" data-acct-menu>` + `<button type="button" class="acct-btn" aria-haspopup="menu" aria-expanded="false">${svg("user")}<span>My Account</span></button>` + `<div class="acct-menu" role="menu" hidden>` + `<p class="acct-who">Signed in as:<strong>${esc(u.email || u.name || "your account")}</strong></p>` + `<button type="button" role="menuitem" data-act="logout">${svg("out")}<span>Log out</span></button>` + `<button type="button" role="menuitem" data-act="logout-all" class="danger">${svg("all")}<span>Log out from all devices</span></button>` + `</div></div>`;
}
function renderAccount() {
  const signinMarkup = `<a class="acct-btn" href="${esc(signinUrl())}">${svg("user")}<span>Sign in</span></a>`;
  document.querySelectorAll("[data-account]").forEach((slot) => {
    slot.innerHTML = user ? menuMarkup(user) : signinMarkup;
  });
}
function legalLinks() {
  const wrap = document.createElement("div");
  wrap.className = "side-footer";
  wrap.innerHTML = `<p class="legal-links"><a href="${new URL("about/", ROOT).pathname}">About</a><span class="sep" aria-hidden="true">·</span><a href="${new URL("terms/", ROOT).pathname}">Terms of service</a><span class="sep" aria-hidden="true">·</span><a href="${new URL("privacy/", ROOT).pathname}">Privacy policy</a></p><p class="foot-motto" lang="la"><em>Nisi Dominus frustra</em></p>`;
  return wrap;
}
function accountSlot(variant = "side") {
  const el = document.createElement("div");
  el.className = variant === "top" ? "acct-slot top" : "acct-slot";
  el.dataset.account = "";
  return el;
}
async function loadAccount() {
  try {
    const { user: u } = await api("GET", "me");
    user = u;
    if (u)
      localStorage.setItem(SIGNED_IN_KEY, JSON.stringify(u));
    else
      localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    try {
      user = JSON.parse(localStorage.getItem(SIGNED_IN_KEY) || "null");
    } catch {
      user = null;
    }
  }
  renderAccount();
  return user;
}
function indicator() {
  if (!netBox) {
    netBox = document.createElement("div");
    netBox.id = "net-status";
    netBox.className = "net-status";
    netBox.setAttribute("role", "status");
    netBox.title = "Your progress is saved on this device and will sync when the connection returns";
    netBox.hidden = true;
    netBox.innerHTML = `${svg("cloudOff")}<span>Offline</span>`;
    document.body.appendChild(netBox);
  }
  return netBox;
}
var warnedThisSession = false;
function setOnlineStatus(online) {
  const box = indicator();
  box.hidden = online || !user;
  if (!online && user && !warnedThisSession && !sessionStorage.getItem("va-offline-warned")) {
    warnedThisSession = true;
    sessionStorage.setItem("va-offline-warned", "1");
    notify("You're offline. Your progress is safe on this device and will sync when the connection returns.", 6000);
  }
}
function notify(msg, ms = 2600) {
  if (toastFn)
    return toastFn(msg, ms);
  const t = document.getElementById("toast");
  if (!t)
    return;
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => {
    t.hidden = true;
  }, ms);
}
var armed = null;
async function logout(all) {
  try {
    await api("POST", all ? "auth/logout-all" : "auth/logout");
  } catch {}
  localStorage.removeItem(SIGNED_IN_KEY);
  location.reload();
}
function initAccount({
  toast
} = {}) {
  toastFn = toast || null;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("sw.js", ROOT), { scope: ROOT.pathname }).catch(() => {});
  }
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target)
      return;
    const btn = target.closest(".acct-btn");
    const menu = target.closest("[data-acct-menu]");
    if (btn && menu) {
      const mEl = menu.querySelector(".acct-menu");
      const open = mEl.hidden;
      document.querySelectorAll(".acct-menu").forEach((m) => {
        m.hidden = true;
      });
      mEl.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      return;
    }
    const act = target.closest("[data-act]");
    if (act && act.closest(".acct-menu")) {
      if (act.dataset.act === "logout")
        return logout(false);
      if (act.dataset.act === "logout-all") {
        if (armed !== act) {
          armed = act;
          act.querySelector("span").textContent = "Click again to log out everywhere";
          setTimeout(() => {
            if (armed === act) {
              armed = null;
              act.querySelector("span").textContent = "Log out from all devices";
            }
          }, 4000);
          return;
        }
        return logout(true);
      }
    }
    if (!target.closest("[data-acct-menu]"))
      document.querySelectorAll(".acct-menu").forEach((m) => {
        m.hidden = true;
      });
  });
  renderAccount();
  return loadAccount();
}

// src/client/map/state.ts
var $ = (s, r = document) => r.querySelector(s);
var fmt = (n) => Number(n).toLocaleString();
var isMobile = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches;
function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID() || Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function vivid(hex) {
  const h = String(hex || "888888").replace("#", "");
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.45) {
    const t = (0.45 - lum) / (1 - lum);
    [r, g, b] = [r, g, b].map((v) => Math.round(v + (255 - v) * t));
  }
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
var UNTAGGED = "untagged";
var emptyFC = { type: "FeatureCollection", features: [] };
var ICON_STOPS = [
  [8, 0.5],
  [11, 0.7],
  [13, 0.9],
  [15, 1]
];
function iconScale(z) {
  if (z <= ICON_STOPS[0][0])
    return ICON_STOPS[0][1];
  for (let i = 1;i < ICON_STOPS.length; i++) {
    const [z1, s1] = ICON_STOPS[i];
    if (z <= z1) {
      const [z0, s0] = ICON_STOPS[i - 1];
      return s0 + (s1 - s0) * (z - z0) / (z1 - z0);
    }
  }
  return 1;
}
var state = {
  entry: null,
  folder: "",
  data: null,
  sprite: null,
  groups: [],
  cats: new Map,
  locs: [],
  byId: new Map,
  tags: [],
  profiles: [],
  profile: null,
  found: new Set,
  tag: null,
  tagStrict: false,
  view: { hidden: new Set, hideFound: false, collapsed: new Set },
  selected: null,
  map: null,
  mapReady: false,
  memoryOnly: false,
  stats: new Map,
  search: {
    active: false,
    scope: "map",
    ids: null,
    rows: [],
    idx: 0,
    preview: null,
    run: 0,
    busy: false,
    wild: false
  },
  presets: [],
  presetId: null,
  baseline: null,
  trail: [],
  session: uid(),
  outLinks: new Map,
  inLinks: new Map,
  capturing: false,
  capture: null,
  meta: null,
  spriteFile: null,
  tempMarkers: [],
  officialLocs: null,
  um: null,
  tool: "pan",
  shape: "box",
  sel: null,
  drag: null
};
var syncNoteFn = null;
function setSyncNote(fn) {
  syncNoteFn = fn;
}
function syncNote() {
  syncNoteFn?.();
}
var toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  if (!t)
    return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}
function askDialog({
  title,
  message = "",
  value = null,
  okLabel = "OK",
  danger = false
}) {
  return new Promise((resolve) => {
    const dlg = $("#dlg");
    const form = $("#dlg-form");
    form.innerHTML = `<h2>${esc(title)}</h2>` + (message ? `<p>${esc(message)}</p>` : "") + (value !== null ? `<input type="text" name="v" value="${esc(value)}" maxlength="60" autocomplete="off">` : "") + `<div class="dlg-actions"><button type="button" data-cancel>Cancel</button>` + `<button class="${danger ? "danger" : "primary"}">${esc(okLabel)}</button></div>`;
    const finish = (r) => {
      if (dlg.open)
        dlg.close();
      resolve(r);
    };
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const vInput = form.elements.namedItem("v");
      finish(value !== null ? vInput?.value.trim() || null : true);
    };
    form.querySelector("[data-cancel]").onclick = () => finish(null);
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
    if (value !== null)
      form.elements.namedItem("v")?.select();
  });
}

// src/client/map/db.ts
var mem = { profiles: new Map, meta: new Map };
var dbPromise = null;
function openDB() {
  if (dbPromise)
    return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window))
      return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open("offline-map-viewer", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("profiles", { keyPath: "key" });
      db.createObjectStore("meta", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
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
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
  });
}
var keyField = (store) => store === "profiles" ? "key" : "k";
async function dbAll(store) {
  if (state.memoryOnly)
    return [...mem[store].values()];
  return await withStore(store, "readonly", (s) => s.getAll()) || [];
}
async function dbGet(store, key) {
  if (state.memoryOnly)
    return mem[store].get(key);
  return withStore(store, "readonly", (s) => s.get(key));
}
async function dbPut(store, value) {
  if (state.memoryOnly) {
    mem[store].set(value[keyField(store)], structuredClone(value));
    return;
  }
  await withStore(store, "readwrite", (s) => s.put(value));
}
async function dbDelete(store, key) {
  if (state.memoryOnly) {
    mem[store].delete(key);
    return;
  }
  await withStore(store, "readwrite", (s) => s.delete(key));
}
var getMeta = async (k) => (await dbGet("meta", k))?.v;
var setMeta = (k, v) => {
  const done = dbPut("meta", { k, v });
  if (/^presets:/.test(k))
    syncNote();
  return done;
};
var emptyProfile = (p) => !p.found?.length && !p.drawings?.length && !p.userMarkers?.length && !p.userCats?.length;
var syncStore = {
  profiles: () => dbAll("profiles"),
  isEmpty: emptyProfile,
  metaEntries: async () => (await dbAll("meta")).map((r) => ({ k: r.k, v: r.v })),
  putProfile: (rec) => dbPut("profiles", rec),
  deleteProfile: (key) => dbDelete("profiles", key),
  putMeta: (k, v) => dbPut("meta", { k, v }),
  removeMeta: (k) => dbDelete("meta", k),
  getMeta: async (k) => (await dbGet("meta", k))?.v ?? null
};

// src/shared/share-link.ts
var MAX_TITLE = 120;
var MAX_CATEGORY = 80;
var MAX_DESC = 1200;
var MAX_LENGTH = 4000;
var MAX_LINKS = 200;
var round = (n) => Math.round(n * 1e6) / 1e6;
function toBase64Url(bytes) {
  let s = "";
  for (const b of bytes)
    s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
var colorOf = (c) => /^#?[0-9a-f]{6}$/i.test(c || "") ? "#" + String(c).replace("#", "").toLowerCase() : null;
var glyphOf = (g) => /^[a-z0-9-]{1,60}$/.test(g || "") ? g : null;
async function packMarker({
  title,
  category = "",
  desc = "",
  lat,
  lng,
  map,
  color = null,
  glyph = null,
  links = []
}) {
  const payload = {
    v: 2,
    title: String(title || "Marker").slice(0, MAX_TITLE),
    category: String(category || "").slice(0, MAX_CATEGORY),
    color: colorOf(color),
    glyph: glyphOf(glyph),
    desc: String(desc || "").slice(0, MAX_DESC),
    lat: round(lat),
    lng: round(lng),
    map: String(map || ""),
    links: (links || []).filter((id) => Number.isInteger(id) && id > 0).slice(0, MAX_LINKS)
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw")));
}
async function unpackMarker(str) {
  try {
    if (typeof str !== "string" || !str || str.length > MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(str))
      return null;
    const json = new TextDecoder().decode(await pipe(fromBase64Url(str), new DecompressionStream("deflate-raw")));
    const p = JSON.parse(json);
    if (!(p.v === 1 || p.v === 2) || typeof p.title !== "string" || !p.title)
      return null;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)
      return null;
    return {
      title: p.title.slice(0, MAX_TITLE),
      category: String(p.category || "").slice(0, MAX_CATEGORY),
      color: colorOf(p.color),
      glyph: glyphOf(p.glyph),
      desc: String(p.desc || "").slice(0, MAX_DESC),
      lat: p.lat,
      lng: p.lng,
      map: String(p.map || "").slice(0, 80),
      links: Array.isArray(p.links) ? p.links.filter((id) => Number.isInteger(id) && id > 0).slice(0, MAX_LINKS) : []
    };
  } catch {
    return null;
  }
}

// src/client/icons.ts
var ICONS = {
  pin: '<path d="M12 21s-6.5-6-6.5-11.5a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/>',
  tempPin: '<path d="M9.5 19.5s-5-4.4-5-8.3a5 5 0 0 1 10 0c0 3.9-5 8.3-5 8.3z"/><circle cx="9.5" cy="11.2" r="1.7"/>' + '<circle class="clock" cx="17.2" cy="6.2" r="3.9"/><path d="M17.2 4.2v2.1l1.4 1.1"/>',
  save: '<path d="M5 4h11l3 3v11a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  open: '<circle cx="12" cy="12" r="8.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.4 10.8l7.2-4.4M8.4 13.2l7.2 4.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  card: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/>',
  box: '<rect x="4" y="6" width="16" height="12" rx="1" stroke-dasharray="2.5 2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6" stroke-dasharray="2.5 2"/>',
  free: '<path d="M5 9c1.5-3 5-4 7-2s4-1.5 6 .5 1 6-2 6.5-3-2-5 0-4 2.5-6 1-4.5-.5-3-3.5z" stroke-dasharray="2.5 2"/>'
};
var svgIcon = (name, extra = "") => `<svg class="i${extra ? " " + extra : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

// src/shared/theme-math.ts
function hexToHsl(hex) {
  const clean = String(hex || "#d6453b").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d)
    return [0, 0, l];
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}
function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, "0");
  return "#" + f(0) + f(8) + f(4);
}
function deriveLightAccentSoft(accent) {
  if (!accent)
    return "#b03028";
  const [h, s, al] = hexToHsl(accent);
  return hslToHex(h, Math.min(s, 0.78), Math.max(0.26, Math.min(0.4, al - 0.06)));
}
function deriveLightTheme(theme = {}) {
  const accent = theme.accent || "#d6453b";
  const [h, s, al] = hexToHsl(accent);
  const tint = (sat, l) => hslToHex(h, Math.min(sat, s), l);
  return {
    accent,
    "accent-soft": hslToHex(h, Math.min(s, 0.78), Math.max(0.26, Math.min(0.4, al - 0.06))),
    night: tint(0.32, 0.945),
    panel: tint(0.28, 0.982),
    "panel-2": tint(0.26, 0.935),
    line: tint(0.24, 0.855)
  };
}
function glyphInk(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
  const white = 1.05 / (L + 0.05), dark = (L + 0.05) / 0.06;
  return white >= dark ? "#ffffff" : "#14161a";
}

// src/client/icons-lib.ts
var URL_ = new URL("./vendor/lucide/icons.json", import.meta.url);
var library = null;
var loading = null;
var iconsReady = () => library !== null;
function loadIconLibrary() {
  if (!loading) {
    loading = fetch(URL_).then((r) => {
      if (!r.ok)
        throw new Error(`icon library: HTTP ${r.status}`);
      return r.json();
    }).then((j) => {
      library = j;
      return j;
    });
  }
  return loading;
}
var iconInner = (name) => library?.[name]?.[0] ?? null;
function searchIcons(query, limit = 120) {
  if (!library)
    return [];
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const names = Object.keys(library);
  if (!words.length)
    return names.slice(0, limit);
  const scored = [];
  for (const name of names) {
    const hay = (name.replace(/-/g, " ") + " " + library[name][1].join(" ")).toLowerCase();
    if (!words.every((w) => hay.includes(w)))
      continue;
    const score = name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2;
    scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return scored.slice(0, limit).map((s) => s.name);
}
var PIN = { S: 60, R: 2, K: 2.4 };
var PIN_OUTLINE = "M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z";
function drawPin(g, hex, { temp = false, glyph = null } = {}) {
  const { S, R, K } = PIN;
  const ox = S / 2 - 12 * K, oy = S - 3 - 22 * K;
  g.setTransform(R * K, 0, 0, R * K, R * ox, R * oy);
  const pin = new Path2D(PIN_OUTLINE);
  pin.moveTo(12 + 2.8, 10);
  pin.arc(12, 10, 2.8, 0, Math.PI * 2);
  if (temp) {
    g.fillStyle = hex + "40";
    g.fill(pin, "evenodd");
    g.strokeStyle = hex;
    g.lineWidth = 1.3;
    g.setLineDash([1.6, 1.3]);
    g.stroke(pin);
    g.setLineDash([]);
  } else {
    const x0 = -ox / K, x1 = (S - ox) / K, y0 = -oy / K, y1 = (S - oy) / K;
    const glow = g.createRadialGradient(12, 10, 0, 12, 10, 13);
    glow.addColorStop(0, hex + "70");
    glow.addColorStop(1, hex + "00");
    g.fillStyle = glow;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.fillStyle = hex;
    g.fill(pin, "evenodd");
    g.strokeStyle = "rgba(255,255,255,.85)";
    g.lineWidth = 0.8;
    g.stroke(pin);
  }
  if (glyph)
    g.drawImage(glyph, 12 - 5.5, 10 - 5.5, 11, 11);
}
function pinImage(hex, temp = false) {
  const { S, R } = PIN;
  const c = document.createElement("canvas");
  c.width = c.height = S * R;
  const g = c.getContext("2d");
  drawPin(g, hex, { temp });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return g.getImageData(0, 0, S * R, S * R);
}
async function glyphPinImage(name) {
  const m = /^ic-(.+)-([0-9a-f]{6})$/i.exec(name);
  const inner = m && iconInner(m[1]);
  if (!m || !inner)
    return null;
  const hex = "#" + m[2];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${glyphInk(hex)}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const img = new Image;
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const { S, R } = PIN;
  const c = document.createElement("canvas");
  c.width = c.height = S * R;
  const g = c.getContext("2d");
  drawPin(g, hex, { glyph: img });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return g.getImageData(0, 0, S * R, S * R);
}

// src/client/theme.ts
var COOKIE = "va_theme";
var TINT_COOKIE = "va_tint";
var RECENT_COOKIE = "va_recent";
var MODES = ["light", "auto", "dark"];
var LABELS = { light: "Light", auto: "Auto", dark: "Dark" };
var TITLES = {
  light: "Light mode",
  auto: "Auto (match system)",
  dark: "Dark mode"
};
var THEME_COLORS = { light: "#f6f4f0", dark: "#0b0e10" };
var ICONS2 = {
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M4.93 4.93l1.63 1.63M17.44 17.44l1.63 1.63M2.5 12h2.3M19.2 12h2.3M4.93 19.07l1.63-1.63M17.44 6.56l1.63-1.63"/></svg>',
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path class="half" d="M12 4a8 8 0 0 0 0 16Z" fill="currentColor" stroke="none"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 14.6A8.5 8.5 0 0 1 9.4 3.6a8.5 8.5 0 1 0 11 11Z"/></svg>'
};
var mql = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
var listeners = new Set;
function readThemeCookie() {
  if (typeof document === "undefined")
    return null;
  const m = document.cookie.match(/(?:^|;\s*)va_theme=(light|auto|dark)\b/);
  return m ? m[1] : null;
}
function writeThemeCookie(mode) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${mode}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
function currentThemeMode() {
  const attr = document.documentElement.dataset.theme;
  if (attr && MODES.includes(attr))
    return attr;
  return readThemeCookie() || "auto";
}
function isLightTheme(mode = currentThemeMode()) {
  return mode === "light" || mode === "auto" && !!mql?.matches;
}
function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function syncMetaThemeColor(mode) {
  if (document.body?.dataset.game)
    return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta)
    return;
  const effective = isLightTheme(mode) ? "light" : "dark";
  meta.setAttribute("content", THEME_COLORS[effective]);
}
function notifyListeners() {
  const light = isLightTheme();
  const mode = currentThemeMode();
  for (const fn of listeners)
    fn({ mode, light });
}
function applyThemeMode(mode, { persist = false } = {}) {
  const validMode = MODES.includes(mode) ? mode : "auto";
  document.documentElement.dataset.theme = validMode;
  if (persist)
    writeThemeCookie(validMode);
  syncMetaThemeColor(validMode);
  applyStoredTint();
  document.querySelectorAll("[data-theme-toggle]").forEach((el) => updateToggleUI(el, validMode));
  notifyListeners();
}
function updateToggleUI(root, mode) {
  root.dataset.mode = mode;
  const is2Pos = root.classList.contains("theme-switch-2");
  if (is2Pos) {
    const light = isLightTheme(mode);
    const effective = mode === "auto" ? light ? "light" : "dark" : mode;
    root.dataset.effective = effective;
    root.querySelectorAll("[data-theme-opt]").forEach((btn) => {
      const opt = btn.dataset.themeOpt;
      const isCurrent = mode === opt;
      btn.setAttribute("aria-checked", String(isCurrent));
      const isFocusable = mode === "auto" ? opt === effective : isCurrent;
      btn.tabIndex = isFocusable ? 0 : -1;
    });
    if (mode === "auto") {
      root.title = `Theme: Auto (${effective === "light" ? "Light" : "Dark"}). Click to toggle, right-click or hold to reset to auto.`;
    } else {
      root.title = `Theme: ${mode === "light" ? "Light" : "Dark"}. Click to toggle, right-click or hold for auto.`;
    }
  } else {
    root.querySelectorAll("[data-theme-opt]").forEach((btn) => {
      const active = btn.dataset.themeOpt === mode;
      btn.setAttribute("aria-checked", String(active));
      btn.tabIndex = active ? 0 : -1;
    });
  }
}
function buildToggle(root) {
  if (root.dataset.themeBuilt) {
    updateToggleUI(root, currentThemeMode());
    return root;
  }
  root.dataset.themeBuilt = "1";
  const isDropdown = root.classList.contains("side-dropdown-theme") || !!root.closest(".side-dropdown-theme, .side-menu-theme") || root.dataset.themeVariant === "dropdown" || root.dataset.themeToggle === "dropdown";
  root.classList.add("theme-switch");
  root.setAttribute("role", "radiogroup");
  root.setAttribute("aria-label", "Color theme");
  if (isDropdown) {
    root.innerHTML = `<span class="theme-thumb" aria-hidden="true"></span>` + MODES.map((m) => `<button type="button" class="theme-opt" role="radio" data-theme-opt="${m}" aria-checked="false" aria-label="${TITLES[m]}" title="${TITLES[m]}">` + `${ICONS2[m]}<span class="theme-opt-label">${LABELS[m]}</span>` + `</button>`).join("");
    root.addEventListener("click", (e) => {
      const btn = e.target?.closest("[data-theme-opt]");
      if (!btn || !btn.dataset.themeOpt)
        return;
      applyThemeMode(btn.dataset.themeOpt, { persist: true });
    });
    root.addEventListener("keydown", (e) => {
      const cur = currentThemeMode();
      const idx = MODES.indexOf(cur);
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown")
        next = (idx + 1) % MODES.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        next = (idx - 1 + MODES.length) % MODES.length;
      else if (e.key === "Home")
        next = 0;
      else if (e.key === "End")
        next = MODES.length - 1;
      if (next < 0)
        return;
      e.preventDefault();
      const mode = MODES[next];
      applyThemeMode(mode, { persist: true });
      root.querySelector(`[data-theme-opt="${mode}"]`)?.focus();
    });
  } else {
    root.classList.add("theme-switch-2");
    root.innerHTML = `<span class="theme-thumb" aria-hidden="true">` + `<span class="theme-thumb-auto">${ICONS2.auto}</span>` + `</span>` + `<button type="button" class="theme-opt" role="radio" data-theme-opt="light" aria-checked="false" aria-label="${TITLES.light}">` + `${ICONS2.light}<span class="theme-opt-label">${LABELS.light}</span>` + `</button>` + `<button type="button" class="theme-opt" role="radio" data-theme-opt="dark" aria-checked="false" aria-label="${TITLES.dark}">` + `${ICONS2.dark}<span class="theme-opt-label">${LABELS.dark}</span>` + `</button>`;
    let pressTimer = null;
    let longPressed = false;
    let startX = 0;
    let startY = 0;
    const clearPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    const triggerAuto = () => {
      applyThemeMode("auto", { persist: true });
      try {
        navigator.vibrate?.(25);
      } catch {}
      root.classList.remove("theme-pulse");
      root.offsetWidth;
      root.classList.add("theme-pulse");
      setTimeout(() => root.classList.remove("theme-pulse"), 400);
      root.querySelectorAll(".theme-auto-chip").forEach((el) => el.remove());
      const chip = document.createElement("span");
      chip.className = "theme-auto-chip";
      chip.setAttribute("aria-hidden", "true");
      chip.textContent = "Auto";
      root.appendChild(chip);
      chip.addEventListener("animationend", () => chip.remove());
      setTimeout(() => chip.remove(), 1100);
    };
    root.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0)
        return;
      longPressed = false;
      startX = e.clientX;
      startY = e.clientY;
      clearPress();
      pressTimer = setTimeout(() => {
        longPressed = true;
        triggerAuto();
      }, 420);
    });
    root.addEventListener("pointermove", (e) => {
      if (!pressTimer)
        return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8)
        clearPress();
    });
    root.addEventListener("pointerup", clearPress);
    root.addEventListener("pointercancel", clearPress);
    root.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      triggerAuto();
    });
    root.addEventListener("click", (e) => {
      if (longPressed) {
        longPressed = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const btn = e.target?.closest("[data-theme-opt]");
      const current = currentThemeMode();
      if (btn && btn.dataset.themeOpt) {
        const opt = btn.dataset.themeOpt;
        if (current === opt) {
          applyThemeMode(opt === "light" ? "dark" : "light", { persist: true });
        } else {
          applyThemeMode(opt, { persist: true });
        }
      } else {
        const next = isLightTheme() ? "dark" : "light";
        applyThemeMode(next, { persist: true });
      }
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        applyThemeMode("light", { persist: true });
        root.querySelector('[data-theme-opt="light"]')?.focus();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        applyThemeMode("dark", { persist: true });
        root.querySelector('[data-theme-opt="dark"]')?.focus();
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        triggerAuto();
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        const next = isLightTheme() ? "dark" : "light";
        applyThemeMode(next, { persist: true });
      }
    });
  }
  updateToggleUI(root, currentThemeMode());
  return root;
}
function themeToggle(extraClass = "") {
  const el = document.createElement("div");
  if (extraClass)
    el.className = extraClass;
  el.dataset.themeToggle = "";
  return buildToggle(el);
}
function readStoredTint() {
  if (typeof document === "undefined")
    return null;
  let raw = null;
  const m = document.cookie.match(/(?:^|;\s*)va_tint=([^;]+)/);
  if (m) {
    try {
      raw = decodeURIComponent(m[1]);
    } catch {}
  }
  if (!raw) {
    try {
      raw = localStorage.getItem("va_tint");
    } catch {}
  }
  if (!raw)
    return null;
  const [accent, accentSoft] = raw.split("|");
  if (/^#[0-9a-fA-F]{3,8}$/.test(accent)) {
    return { accent, accentSoft: accentSoft && /^#[0-9a-fA-F]{3,8}$/.test(accentSoft) ? accentSoft : null };
  }
  return null;
}
function writeStoredTint(accent, accentSoft = null) {
  if (typeof document === "undefined")
    return;
  if (!accent || !/^#[0-9a-fA-F]{3,8}$/.test(accent))
    return;
  const val = `${accent}|${accentSoft || ""}`;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${TINT_COOKIE}=${encodeURIComponent(val)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  try {
    localStorage.setItem("va_tint", val);
  } catch {}
}
function updateFavicon(accent) {
  if (typeof document === "undefined" || !accent)
    return;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    const fill = encodeURIComponent(accent);
    icon.type = "image/svg+xml";
    icon.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='${fill}' d='M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z'/%3E%3Ccircle cx='12' cy='10' r='2.8' fill='%230b0e10'/%3E%3C/svg%3E`;
  }
}
function applyStoredTint(tint = readStoredTint()) {
  if (typeof document === "undefined")
    return;
  if (document.body?.dataset.game || document.getElementById("app"))
    return;
  const root = document.documentElement.style;
  if (tint?.accent) {
    root.setProperty("--accent", tint.accent);
    const light = isLightTheme();
    const soft = light ? deriveLightAccentSoft(tint.accent) : tint.accentSoft || tint.accent;
    root.setProperty("--accent-soft", soft);
    updateFavicon(tint.accent);
  } else {
    root.removeProperty("--accent");
    root.removeProperty("--accent-soft");
    updateFavicon("#d6453b");
  }
}
function readRecentGames() {
  if (typeof document === "undefined")
    return [];
  let raw = null;
  const m = document.cookie.match(/(?:^|;\s*)va_recent=([^;]+)/);
  if (m) {
    try {
      raw = decodeURIComponent(m[1]);
    } catch {}
  }
  if (!raw) {
    try {
      raw = localStorage.getItem("va_recent_games");
    } catch {}
  }
  if (!raw)
    return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function writeRecentGames(slugs) {
  if (typeof document === "undefined")
    return;
  const val = (slugs || []).slice(0, 50).join(",");
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${RECENT_COOKIE}=${encodeURIComponent(val)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  try {
    localStorage.setItem("va_recent_games", val);
  } catch {}
}
var TRAIL_KEY = "va_nav_trail";
var TITLES_KEY = "va_game_titles";
var ROOT_URL = typeof document !== "undefined" ? new URL(/\/signin\/[^/]*$/.test(import.meta.url) ? "../" : "./", import.meta.url) : null;
function recordGameTitle(slug, title) {
  if (!slug || !title || typeof localStorage === "undefined")
    return;
  try {
    const titles = JSON.parse(localStorage.getItem(TITLES_KEY) || "{}");
    if (titles[slug] !== title) {
      titles[slug] = title;
      localStorage.setItem(TITLES_KEY, JSON.stringify(titles));
    }
  } catch {}
}
function storeGameTitles(games) {
  if (!Array.isArray(games) || typeof localStorage === "undefined")
    return;
  try {
    const titles = JSON.parse(localStorage.getItem(TITLES_KEY) || "{}");
    let changed = false;
    for (const g of games) {
      if (g?.slug && g?.title && titles[g.slug] !== g.title) {
        titles[g.slug] = g.title;
        changed = true;
      }
    }
    if (changed)
      localStorage.setItem(TITLES_KEY, JSON.stringify(titles));
  } catch {}
}
function getGameTitle(slug) {
  if (!slug)
    return "";
  if (typeof localStorage !== "undefined") {
    try {
      const titles = JSON.parse(localStorage.getItem(TITLES_KEY) || "{}");
      if (titles[slug])
        return titles[slug];
    } catch {}
    try {
      const last = JSON.parse(localStorage.getItem("va_last_session") || "{}");
      if (last.slug === slug && last.title)
        return last.title;
    } catch {}
  }
  if (typeof document !== "undefined") {
    const docTitle = (document.title || "").replace(/\s*·.*$/, "").trim();
    if (docTitle && docTitle !== "Map" && docTitle !== "Loading map…" && docTitle !== "Verticordia Atlas" && !docTitle.startsWith("Loading")) {
      return docTitle;
    }
  }
  return slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function normalizePath(pathname) {
  if (!pathname)
    return "/";
  let p = pathname.replace(/\/index\.html?$/i, "/");
  if (!/\.[a-zA-Z0-9]+$/.test(p) && !p.endsWith("/")) {
    p += "/";
  }
  return p;
}
function resolveAppUrl(pathOrUrl) {
  if (!ROOT_URL || !pathOrUrl)
    return pathOrUrl || "/";
  try {
    const u = new URL(pathOrUrl, ROOT_URL);
    return u.pathname + u.search + u.hash;
  } catch {
    return pathOrUrl;
  }
}
function describePage(pathname, fullUrl = null, titleOverride = null) {
  const normPath = normalizePath(pathname);
  const targetUrl = resolveAppUrl(fullUrl || normPath);
  if (normPath === "/" || normPath === "") {
    return {
      type: "home",
      path: "/",
      fullUrl: targetUrl,
      title: "the maps",
      buttonText: "Back to the maps"
    };
  }
  if (normPath.startsWith("/about")) {
    return {
      type: "about",
      path: "/about/",
      fullUrl: targetUrl,
      title: "about",
      buttonText: "Return to about"
    };
  }
  if (normPath.startsWith("/terms")) {
    return {
      type: "terms",
      path: "/terms/",
      fullUrl: targetUrl,
      title: "terms",
      buttonText: "Return to terms"
    };
  }
  if (normPath.startsWith("/privacy")) {
    return {
      type: "privacy",
      path: "/privacy/",
      fullUrl: targetUrl,
      title: "privacy policy",
      buttonText: "Return to privacy policy"
    };
  }
  if (normPath.startsWith("/signin")) {
    return {
      type: "signin",
      path: "/signin/",
      fullUrl: targetUrl,
      title: "sign in",
      buttonText: "Return to sign in"
    };
  }
  const mapMatch = normPath.match(/\/maps\/([^/]+)/);
  if (mapMatch) {
    const slug = decodeURIComponent(mapMatch[1]);
    const title = titleOverride || getGameTitle(slug);
    return {
      type: "map",
      slug,
      path: `/maps/${slug}/`,
      fullUrl: targetUrl,
      title,
      buttonText: `Return to ${title}`
    };
  }
  const fallbackTitle = titleOverride || "the maps";
  return {
    type: "page",
    path: normPath,
    fullUrl: targetUrl,
    title: fallbackTitle,
    buttonText: `Return to ${fallbackTitle}`
  };
}
function readTrail() {
  if (typeof sessionStorage === "undefined")
    return [];
  try {
    const raw = sessionStorage.getItem(TRAIL_KEY);
    if (!raw)
      return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeTrail(trail) {
  if (typeof sessionStorage === "undefined")
    return;
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-30)));
  } catch {}
}
function popTrailTo(targetPath) {
  let trail = readTrail();
  const idx = trail.findIndex((e) => e.path === targetPath);
  if (idx !== -1) {
    trail = trail.slice(0, idx + 1);
  } else if (trail.length > 1) {
    trail.pop();
  }
  writeTrail(trail);
}
function initNav() {
  if (typeof window === "undefined" || typeof document === "undefined")
    return;
  const currentPath = normalizePath(location.pathname);
  const currentFullUrl = location.pathname + location.search + location.hash;
  const currentInfo = describePage(currentPath, currentFullUrl);
  if (currentInfo.type === "home") {
    writeTrail([currentInfo]);
    return;
  }
  let trail = readTrail();
  if (!trail.length) {
    if (document.referrer) {
      try {
        const ref = new URL(document.referrer);
        if (ref.origin === location.origin) {
          const refPath = normalizePath(ref.pathname);
          if (refPath !== currentPath) {
            trail = [describePage(refPath, ref.pathname + ref.search + ref.hash)];
          }
        }
      } catch {}
    }
    if (!trail.length && currentInfo.type === "signin") {
      const rawNext = new URLSearchParams(location.search).get("next");
      if (rawNext && /^\/(?!\/)/.test(rawNext)) {
        const nextPath = normalizePath(rawNext);
        if (nextPath !== currentPath) {
          trail = [describePage(nextPath, rawNext)];
        }
      }
    }
  }
  const existingIdx = trail.findIndex((e) => e.path === currentPath);
  if (existingIdx !== -1) {
    trail = trail.slice(0, existingIdx);
    trail.push(currentInfo);
  } else {
    trail.push(currentInfo);
  }
  writeTrail(trail);
  let target = trail.length >= 2 ? trail[trail.length - 2] : null;
  if (currentInfo.type === "signin" && (!target || target.type === "home")) {
    const rawNext = new URLSearchParams(location.search).get("next");
    if (rawNext && /^\/(?!\/)/.test(rawNext)) {
      const nextPath = normalizePath(rawNext);
      if (nextPath !== "/" && nextPath !== currentPath) {
        target = describePage(nextPath, rawNext);
      }
    }
  }
  if (!target) {
    target = describePage("/");
  }
  if (target.type === "map" && target.slug) {
    const freshTitle = getGameTitle(target.slug);
    if (freshTitle && freshTitle !== target.slug) {
      target.title = freshTitle;
      target.buttonText = `Return to ${freshTitle}`;
    }
  }
  const resolvedTarget = target;
  const backButtons = document.querySelectorAll("a.back");
  backButtons.forEach((btn) => {
    btn.href = resolvedTarget.fullUrl;
    btn.title = resolvedTarget.buttonText;
    btn.setAttribute("aria-label", resolvedTarget.buttonText);
    const span = btn.querySelector("span");
    if (span)
      span.textContent = resolvedTarget.buttonText;
    btn.onclick = (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
        return;
      popTrailTo(resolvedTarget.path);
      const refMatches = document.referrer && (() => {
        try {
          const r = new URL(document.referrer);
          return r.origin === location.origin && normalizePath(r.pathname) === resolvedTarget.path;
        } catch {
          return false;
        }
      })();
      if (refMatches && window.history.length > 1) {
        e.preventDefault?.();
        window.history.back();
      }
    };
  });
  if (currentInfo.type === "signin") {
    const skipLink = document.querySelector("footer.signin-foot .skip a");
    if (skipLink) {
      skipLink.href = resolvedTarget.fullUrl;
      skipLink.onclick = (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
          return;
        popTrailTo(resolvedTarget.path);
        const refMatches = document.referrer && (() => {
          try {
            const r = new URL(document.referrer);
            return r.origin === location.origin && normalizePath(r.pathname) === resolvedTarget.path;
          } catch {
            return false;
          }
        })();
        if (refMatches && window.history.length > 1) {
          e.preventDefault?.();
          window.history.back();
        }
      };
    }
  }
}
function recordGameOpen(slug, theme = null, title = null) {
  if (!slug)
    return;
  if (title)
    recordGameTitle(slug, title);
  const recent = readRecentGames().filter((s) => s !== slug);
  recent.unshift(slug);
  writeRecentGames(recent);
  if (theme?.accent) {
    writeStoredTint(theme.accent, theme["accent-soft"] || null);
    applyStoredTint({ accent: theme.accent, accentSoft: theme["accent-soft"] || null });
  }
  try {
    const trail = readTrail();
    if (trail.length && trail[trail.length - 1].path === `/maps/${slug}/`) {
      const gameTitle = title || getGameTitle(slug);
      trail[trail.length - 1].title = gameTitle;
      trail[trail.length - 1].buttonText = `Return to ${gameTitle}`;
      writeTrail(trail);
    }
  } catch {}
}
function initTheme() {
  const initial = readThemeCookie() || currentThemeMode();
  document.documentElement.dataset.theme = initial;
  syncMetaThemeColor(initial);
  applyStoredTint();
  document.querySelectorAll("[data-theme-toggle]").forEach(buildToggle);
  mql?.addEventListener?.("change", () => {
    if (currentThemeMode() === "auto") {
      syncMetaThemeColor("auto");
      applyStoredTint();
      document.querySelectorAll("[data-theme-toggle]").forEach((el) => updateToggleUI(el, "auto"));
      notifyListeners();
    }
  });
}
if (typeof document !== "undefined") {
  initTheme();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initNav(), { once: true });
  } else {
    initNav();
  }
  window.addEventListener("pageshow", () => initNav());
}

// src/client/map/capture.ts
var MAX_SIDE = 4096;
var JPEG_QUALITY = 0.92;
var ASPECTS = {
  free: {
    name: "Free",
    ratio: null,
    icon: '<rect x="4.5" y="5.5" width="15" height="13" rx="1.5" stroke-dasharray="3 2.5"/>'
  },
  square: { name: "Square (1:1)", ratio: 1, icon: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>' },
  wide: { name: "Widescreen (16:9)", ratio: 16 / 9, icon: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.5"/>' },
  phone: { name: "Phone (9:16)", ratio: 9 / 16, icon: '<rect x="7" y="2.5" width="10" height="19" rx="2"/>' }
};
var CAMERA = '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>';
var DOWNLOAD = '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>';
var CLOSE = '<path d="M6 6l12 12M18 6L6 18"/>';
var shot = (inner) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
var CAPTURE_CONTROL_HTML = `<button type="button" id="tool-shot" class="notched" aria-label="Screenshot" title="Screenshot. Tap for the whole view, or drag an area. Right-click or hold for the shape">` + `<svg viewBox="0 0 24 24" aria-hidden="true">${CAMERA}</svg></button>`;
function setupCapture({
  map,
  mapEl,
  canvasBox,
  drawing,
  requestTool,
  names,
  toast,
  setBusy
}) {
  const box = map.getContainer();
  const btn = document.getElementById("tool-shot");
  let active = false, aspect = "free", busy = false;
  let drag = null;
  let current = null;
  const card = document.createElement("div");
  card.id = "shot-card";
  card.hidden = true;
  card.innerHTML = '<img alt="Screenshot of the map">' + '<div class="shot-bar"><span class="shot-size"></span><div class="shot-actions">' + `<button type="button" data-act="download" class="ibtn" aria-label="Download" data-tip="Download">${shot(DOWNLOAD)}</button>` + `<button type="button" data-act="share" class="ibtn" aria-label="Share" data-tip="Share" hidden>${shot(ICONS.share)}</button>` + `<button type="button" data-act="close" class="ibtn" aria-label="Close" data-tip="Close">${shot(CLOSE)}</button>` + "</div></div>";
  mapEl.appendChild(card);
  card.onclick = (e) => {
    const b = e.target?.closest("[data-act]");
    if (!b || !current)
      return;
    if (b.dataset.act === "close") {
      card.hidden = true;
      return;
    }
    if (b.dataset.act === "download")
      download();
    if (b.dataset.act === "share")
      share();
  };
  function download() {
    if (!current)
      return;
    const a = document.createElement("a");
    a.href = current.url;
    a.download = current.name;
    a.click();
  }
  async function share() {
    if (!current)
      return;
    const data = { files: [current.file], title: names().label };
    const possible = typeof navigator.share === "function" && (typeof navigator.canShare !== "function" || navigator.canShare(data));
    if (!possible) {
      toast("Sharing is not available in this browser. Use Download instead.", 4000);
      return;
    }
    try {
      await navigator.share(data);
    } catch (e) {
      if (e.name !== "AbortError")
        toast("Could not share the image. Use Download instead.", 4000);
    }
  }
  const menu = document.createElement("div");
  menu.id = "shot-menu";
  menu.className = "menu row-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.innerHTML = Object.entries(ASPECTS).map(([k, a]) => `<button type="button" role="menuitemradio" data-aspect="${k}" aria-checked="false">${shot(a.icon)}<span>${a.name}</span></button>`).join("");
  document.body.appendChild(menu);
  function placeBeside(el, rect) {
    el.hidden = false;
    const { offsetWidth: w, offsetHeight: h } = el, pad = 8;
    el.style.left = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad)) + "px";
    el.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + "px";
  }
  function openMenu() {
    menu.querySelectorAll("[data-aspect]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.aspect === aspect)));
    placeBeside(menu, btn.getBoundingClientRect());
  }
  menu.onclick = (e) => {
    const b = e.target?.closest("[data-aspect]");
    if (!b || !b.dataset.aspect)
      return;
    aspect = b.dataset.aspect;
    menu.hidden = true;
    requestTool("capture");
  };
  let holdT = null, held = false;
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0)
      return;
    held = false;
    holdT = setTimeout(() => {
      held = true;
      openMenu();
    }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => btn.addEventListener(t, () => {
    if (holdT)
      clearTimeout(holdT);
  }));
  btn.addEventListener("click", () => {
    if (held) {
      held = false;
      return;
    }
    if (active) {
      if (menu.hidden)
        openMenu();
      else
        menu.hidden = true;
      return;
    }
    menu.hidden = true;
    requestTool("capture");
  });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target?.closest("#shot-menu, #tool-shot"))
      menu.hidden = true;
  });
  const rectEl = document.createElement("div");
  rectEl.className = "shot-rect";
  rectEl.hidden = true;
  mapEl.appendChild(rectEl);
  const local = (e) => {
    const r = mapEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function rectFor(d, x, y) {
    let dx = x - d.x0, dy = y - d.y0;
    const ratio = ASPECTS[aspect].ratio;
    if (ratio) {
      let w = Math.abs(dx), h = Math.abs(dy);
      if (w / h > ratio)
        h = w / ratio;
      else
        w = h * ratio;
      dx = (dx < 0 ? -1 : 1) * w;
      dy = (dy < 0 ? -1 : 1) * h;
    }
    return { x: Math.min(d.x0, d.x0 + dx), y: Math.min(d.y0, d.y0 + dy), w: Math.abs(dx), h: Math.abs(dy) };
  }
  function showRect(r) {
    Object.assign(rectEl.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    rectEl.hidden = false;
  }
  canvasBox.addEventListener("pointerdown", (e) => {
    if (!active || e.button !== 0 || busy)
      return;
    const p = local(e);
    drag = { id: e.pointerId, x0: p.x, y0: p.y, moved: false, last: p };
  });
  canvasBox.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId)
      return;
    const p = local(e);
    drag.last = p;
    if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) > 6)
      drag.moved = true;
    if (drag.moved)
      showRect(rectFor(drag, p.x, p.y));
  });
  canvasBox.addEventListener("pointerup", (e) => {
    if (!drag || drag.id !== e.pointerId)
      return;
    const d = drag;
    drag = null;
    rectEl.hidden = true;
    if (!active)
      return;
    const r = d.moved ? rectFor(d, d.last.x, d.last.y) : null;
    if (r && (r.w < 6 || r.h < 6))
      return;
    capture(r);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag) {
      drag = null;
      rectEl.hidden = true;
    }
  });
  function pick(region) {
    const dpr = window.devicePixelRatio || 1, z0 = map.getZoom();
    const sizeAt = (z) => ({ w: region.w * 2 ** (z - z0), h: region.h * 2 ** (z - z0) });
    let z = Math.floor(map.getMaxZoom());
    const min = Math.ceil(map.getMinZoom());
    while (z > min && Math.max(sizeAt(z).w, sizeAt(z).h) * dpr > MAX_SIDE)
      z -= 1;
    return { zoom: z, size: sizeAt(z) };
  }
  async function renderAt(cssW, cssH, center, zoom) {
    const prev = { center: map.getCenter(), zoom: map.getZoom() };
    box.style.width = cssW + "px";
    box.style.height = cssH + "px";
    try {
      map.resize();
      const idle = new Promise((res) => {
        map.once("idle", () => res());
        setTimeout(res, 30000);
      });
      map.jumpTo({ center, zoom });
      await idle;
      const src = map.getCanvas();
      const base = document.createElement("canvas");
      base.width = src.width;
      base.height = src.height;
      const copied = new Promise((res) => {
        map.once("render", () => {
          base.getContext("2d").drawImage(src, 0, 0);
          res();
        });
        map.triggerRepaint();
      });
      await copied;
      return { base, svg: drawing.snapshot(cssW, cssH) };
    } finally {
      box.style.width = "";
      box.style.height = "";
      map.resize();
      map.jumpTo(prev);
    }
  }
  async function capture(rect) {
    busy = true;
    setBusy(true);
    try {
      const { width: W, height: H } = mapEl.getBoundingClientRect();
      const region = rect || { x: 0, y: 0, w: W, h: H };
      const center = map.unproject([region.x + region.w / 2, region.y + region.h / 2]);
      const { zoom, size } = pick(region);
      const cssW = Math.round(size.w), cssH = Math.round(size.h);
      const { base, svg } = await renderAt(cssW, cssH, center, zoom);
      const out = document.createElement("canvas");
      out.width = base.width;
      out.height = base.height;
      const g = out.getContext("2d");
      g.drawImage(base, 0, 0);
      if (svg.includes("<line") || svg.includes("<path") || svg.includes("<polygon") || svg.includes("<rect") || svg.includes("<ellipse") || svg.includes("<polyline")) {
        const img = new Image;
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await img.decode();
        g.drawImage(img, 0, 0, out.width, out.height);
      }
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", JPEG_QUALITY));
      if (blob)
        show(blob, out.width, out.height);
    } catch (e) {
      console.error(e);
      toast("Could not take the screenshot.", 4000);
    } finally {
      busy = false;
      setBusy(false);
      requestTool("pan");
    }
  }
  function show(blob, w, h) {
    if (current)
      URL.revokeObjectURL(current.url);
    const { file: base } = names();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const name = `${base}-${stamp}.jpg`;
    const file = new File([blob], name, { type: "image/jpeg" });
    current = { url: URL.createObjectURL(blob), name, file };
    card.querySelector("img").src = current.url;
    card.querySelector(".shot-size").textContent = `${w} × ${h}`;
    card.querySelector('[data-act="share"]').hidden = false;
    card.hidden = false;
  }
  function setActive(on) {
    active = on;
    if (!on) {
      drag = null;
      rectEl.hidden = true;
    }
    mapEl.classList.toggle("tool-capture", on);
    btn.setAttribute("aria-pressed", String(on));
  }
  return { setActive };
}

// public/vendor/perfect-freehand.mjs
var { PI: e } = Math;
var t = e + 0.0001;
var n = 0.5;
var r = [1, 1];
function i(e, t, n, r = (e) => e) {
  return e * r(0.5 - t * (0.5 - n));
}
var { min: a } = Math;
function o(e, t, n) {
  let r = a(1, t / n);
  return a(1, e + (a(1, 1 - r) - e) * (r * 0.275));
}
function s(e) {
  return [-e[0], -e[1]];
}
function c(e, t) {
  return [e[0] + t[0], e[1] + t[1]];
}
function l(e, t, n) {
  return e[0] = t[0] + n[0], e[1] = t[1] + n[1], e;
}
function u(e, t) {
  return [e[0] - t[0], e[1] - t[1]];
}
function d(e, t, n) {
  return e[0] = t[0] - n[0], e[1] = t[1] - n[1], e;
}
function f(e, t) {
  return [e[0] * t, e[1] * t];
}
function p(e, t, n) {
  return e[0] = t[0] * n, e[1] = t[1] * n, e;
}
function m(e, t) {
  return [e[0] / t, e[1] / t];
}
function h(e) {
  return [e[1], -e[0]];
}
function g(e, t) {
  let n = t[0];
  return e[0] = t[1], e[1] = -n, e;
}
function ee(e, t) {
  return e[0] * t[0] + e[1] * t[1];
}
function _(e, t) {
  return e[0] === t[0] && e[1] === t[1];
}
function v(e) {
  return Math.hypot(e[0], e[1]);
}
function y(e, t) {
  let n = e[0] - t[0], r = e[1] - t[1];
  return n * n + r * r;
}
function b(e) {
  return m(e, v(e));
}
function x(e, t) {
  return Math.hypot(e[1] - t[1], e[0] - t[0]);
}
function S(e, t, n) {
  let r = Math.sin(n), i = Math.cos(n), a = e[0] - t[0], o = e[1] - t[1], s = a * i - o * r, c = a * r + o * i;
  return [s + t[0], c + t[1]];
}
function C(e, t, n, r) {
  let i = Math.sin(r), a = Math.cos(r), o = t[0] - n[0], s = t[1] - n[1], c = o * a - s * i, l = o * i + s * a;
  return e[0] = c + n[0], e[1] = l + n[1], e;
}
function w(e, t, n) {
  return c(e, f(u(t, e), n));
}
function te(e, t, n, r) {
  let i = n[0] - t[0], a = n[1] - t[1];
  return e[0] = t[0] + i * r, e[1] = t[1] + a * r, e;
}
function T(e, t, n) {
  return c(e, f(t, n));
}
var E = [0, 0];
var D = [0, 0];
var O = [0, 0];
function k(e, n) {
  let r = T(e, b(h(u(e, c(e, [1, 1])))), -n), i = [], a = 1 / 13;
  for (let n = a;n <= 1; n += a)
    i.push(S(r, e, t * 2 * n));
  return i;
}
function A(e, n, r) {
  let i = [], a = 1 / r;
  for (let r = a;r <= 1; r += a)
    i.push(S(n, e, t * r));
  return i;
}
function j(e, t, n) {
  let r = u(t, n), i = f(r, 0.5), a = f(r, 0.51);
  return [u(e, i), u(e, a), c(e, a), c(e, i)];
}
function M(e, n, r, i) {
  let a = [], o = T(e, n, r), s = 1 / i;
  for (let n = s;n < 1; n += s)
    a.push(S(o, e, t * 3 * n));
  return a;
}
function ne(e, t, n) {
  return [c(e, f(t, n)), c(e, f(t, n * 0.99)), u(e, f(t, n * 0.99)), u(e, f(t, n))];
}
function N(e, t, n) {
  return e === false || e === undefined ? 0 : e === true ? Math.max(t, n) : e;
}
function re(e, t, n) {
  return e.slice(0, 10).reduce((e, r) => {
    let i = r.pressure;
    return t && (i = o(e, r.distance, n)), (e + i) / 2;
  }, e[0].pressure);
}
function P(e, n = {}) {
  let {
    size: r = 16,
    smoothing: a = 0.5,
    thinning: f = 0.5,
    simulatePressure: m = true,
    easing: _ = (e) => e,
    start: v = {},
    end: b = {},
    last: x = false
  } = n, { cap: S = true, easing: w = (e) => e * (2 - e) } = v, { cap: T = true, easing: P = (e) => --e * e * e + 1 } = b;
  if (e.length === 0 || r <= 0)
    return [];
  let F = e[e.length - 1].runningLength, I = N(v.taper, r, F), L = N(b.taper, r, F), R = (r * a) ** 2, z = [], B = [], V = re(e, m, r), H = i(r, f, e[e.length - 1].pressure, _), U, W = e[0].vector, G = e[0].point, K = G, q = G, J = K, Y = false;
  for (let n = 0;n < e.length; n++) {
    let { pressure: a } = e[n], { point: s, vector: h, distance: v, runningLength: b } = e[n], x = n === e.length - 1;
    if (!x && F - b < 3)
      continue;
    f ? (m && (a = o(V, v, r)), H = i(r, f, a, _)) : H = r / 2, U === undefined && (U = H);
    let S = b < I ? w(b / I) : 1, T = F - b < L ? P((F - b) / L) : 1;
    H = Math.max(0.01, H * Math.min(S, T));
    let k = (x ? e[n] : e[n + 1]).vector, A = x ? 1 : ee(h, k), j = ee(h, W) < 0 && !Y, M = A !== null && A < 0;
    if (j || M) {
      g(E, W), p(E, E, H);
      for (let e = 0;e <= 1; e += 0.07692307692307693)
        d(D, s, E), C(D, D, s, t * e), q = [D[0], D[1]], z.push(q), l(O, s, E), C(O, O, s, t * -e), J = [O[0], O[1]], B.push(J);
      G = q, K = J, M && (Y = true);
      continue;
    }
    if (Y = false, x) {
      g(E, h), p(E, E, H), z.push(u(s, E)), B.push(c(s, E));
      continue;
    }
    te(E, k, h, A), g(E, E), p(E, E, H), d(D, s, E), q = [D[0], D[1]], (n <= 1 || y(G, q) > R) && (z.push(q), G = q), l(O, s, E), J = [O[0], O[1]], (n <= 1 || y(K, J) > R) && (B.push(J), K = J), V = a, W = h;
  }
  let X = [e[0].point[0], e[0].point[1]], Z = e.length > 1 ? [e[e.length - 1].point[0], e[e.length - 1].point[1]] : c(e[0].point, [1, 1]), Q = [], $ = [];
  if (e.length === 1) {
    if (!(I || L) || x)
      return k(X, U || H);
  } else {
    I || L && e.length === 1 || (S ? Q.push(...A(X, B[0], 13)) : Q.push(...j(X, z[0], B[0])));
    let t = h(s(e[e.length - 1].vector));
    L || I && e.length === 1 ? $.push(Z) : T ? $.push(...M(Z, t, H, 29)) : $.push(...ne(Z, t, H));
  }
  return z.concat($, B.reverse(), Q);
}
var F = [0, 0];
function I(e) {
  return e != null && e >= 0;
}
function L(e, t = {}) {
  let { streamline: i = 0.5, size: a = 16, last: o = false } = t;
  if (e.length === 0)
    return [];
  let s = 0.15 + (1 - i) * 0.85, l = Array.isArray(e[0]) ? e : e.map(({ x: e, y: t, pressure: r = n }) => [e, t, r]);
  if (l.length === 2) {
    let e = l[1];
    l = l.slice(0, -1);
    for (let t = 1;t < 5; t++)
      l.push(w(l[0], e, t / 4));
  }
  l.length === 1 && (l = [...l, [...c(l[0], r), ...l[0].slice(2)]]);
  let u = [
    {
      point: [l[0][0], l[0][1]],
      pressure: I(l[0][2]) ? l[0][2] : 0.25,
      vector: [...r],
      distance: 0,
      runningLength: 0
    }
  ], f = false, p = 0, m = u[0], h = l.length - 1;
  for (let e = 1;e < l.length; e++) {
    let t = o && e === h ? [l[e][0], l[e][1]] : w(m.point, l[e], s);
    if (_(m.point, t))
      continue;
    let r = x(t, m.point);
    if (p += r, e < h && !f) {
      if (p < a)
        continue;
      f = true;
    }
    d(F, m.point, t), m = { point: t, pressure: I(l[e][2]) ? l[e][2] : n, vector: b(F), distance: r, runningLength: p }, u.push(m);
  }
  return u[0].vector = u[1]?.vector || [0, 0], u;
}
function R(e, t = {}) {
  return P(L(e, t), t);
}

// src/client/map/drawing.ts
var PALETTE = [
  "#f2f2f2",
  "#1b1d21",
  "#e5484d",
  "#f76b15",
  "#f5c544",
  "#46a758",
  "#12a594",
  "#3e63dd",
  "#8e4ec6",
  "#e93d82"
];
var SIZES = { s: 2.5, m: 4.5, l: 7.5 };
var SIZE_NAMES = { s: "Thin", m: "Medium", l: "Thick" };
var TOOLS = {
  pen: { name: "Pencil", icon: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>' },
  highlighter: { name: "Highlighter", icon: '<path d="M15 4l5 5-9 9H6v-5z"/><path d="M4 20h16"/>' },
  line: { name: "Line", icon: '<path d="M5 19L19 5"/>' },
  arrow: { name: "Arrow", icon: '<path d="M5 19L18 6M10 6h8v8"/>' },
  path: {
    name: "Path",
    icon: '<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 17l4-5 4 2 2-4"/>'
  },
  rect: { name: "Rectangle", icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  ellipse: { name: "Ellipse", icon: '<ellipse cx="12" cy="12" rx="8" ry="6"/>' },
  text: { name: "Text", icon: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>' },
  eraser: {
    name: "Eraser",
    icon: '<path d="M7 19h10M5.5 14.5l8-8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 18H7.5z"/>'
  }
};
var DRAW_ORDER = ["pen", "highlighter", "line", "arrow", "path", "rect", "ellipse", "text"];
var ICON_CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
var ICON_CROSS = '<path d="M6 6l12 12M18 6L6 18"/>';
var ICON_UNDO = '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>';
var ICON_REDO = '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>';
var DRAW_CONTROLS_HTML = '<button type="button" id="tool-draw" class="notched" aria-label="Drawing tools" title="Draw. Tap again, or right-click or hold, for more tools">' + '<svg viewBox="0 0 24 24" aria-hidden="true"></svg></button>' + `<button type="button" id="tool-eraser" aria-label="Eraser" title="Eraser"><svg viewBox="0 0 24 24" aria-hidden="true">${TOOLS.eraser.icon}</svg></button>`;
var INK_CONTROL_HTML = '<button type="button" id="tool-ink" aria-label="Colour and size" title="Colour and size"><span class="ink-dot"></span></button>';
function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return "#" + f(5) + f(3) + f(1);
}
function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d)
    h = mx === r ? (g - b) / d % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function simplify(pts, eps) {
  if (pts.length < 3)
    return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let max = 0, at = -1;
    for (let k = i + 1;k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > max) {
        max = d;
        at = k;
      }
    }
    if (max > eps) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}
var boxOf = (pts) => ({
  x: Math.min(pts[0].x, pts[1].x),
  y: Math.min(pts[0].y, pts[1].y),
  w: Math.abs(pts[1].x - pts[0].x),
  h: Math.abs(pts[1].y - pts[0].y)
});
var ellipseOf = (pts, circle) => {
  const [a, b] = pts;
  if (circle) {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    return { cx: a.x, cy: a.y, rx: r, ry: r };
  }
  return { cx: a.x, cy: a.y, rx: Math.abs(b.x - a.x), ry: Math.abs(b.y - a.y) };
};
function setupDrawing({
  map,
  mapEl,
  canvasBox,
  getProfile,
  getMap,
  onChange,
  requestTool,
  renderMd
}) {
  const NS = "http://www.w3.org/2000/svg";
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const zoom = () => map.getZoom();
  const sp = (q) => map.project([q.lng, q.lat]);
  const local = (e) => {
    const r = canvasBox.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toGeo = (q) => {
    const ll = map.unproject([q.x, q.y]);
    return { lng: ll.lng, lat: ll.lat };
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const scaleOf = (it) => 2 ** (zoom() - (it.z ?? zoom()));
  let drawTool = "pen";
  let penCat = "pen";
  const ink = { color: PALETTE[2], size: "m" };
  let active = false;
  let draft = null;
  let gesture = null;
  let editor = null;
  let holdTimer = null;
  let holdAt = null;
  const pointers = new Map;
  const history2 = [];
  const redoStack = [];
  const items = () => {
    const p = getProfile();
    return p ? p.drawings ||= [] : [];
  };
  const here = () => items().filter((it) => it.map === getMap());
  const layer = document.createElementNS(NS, "svg");
  layer.setAttribute("class", "draw-layer");
  const texts = document.createElement("div");
  texts.className = "text-layer";
  const hint = document.createElement("div");
  hint.className = "path-hint";
  hint.hidden = true;
  hint.textContent = "Tap to add points. Hold or double-tap to finish, Esc to cancel";
  const before = mapEl.querySelector(".sel-overlay");
  mapEl.insertBefore(layer, before);
  mapEl.insertBefore(texts, before);
  mapEl.appendChild(hint);
  function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs))
      e.setAttribute(k, String(v));
    return e;
  }
  function strokeOutline(pts, it, k) {
    const hl = it.kind === "highlighter";
    const size = SIZES[it.size] * k * (hl ? 4 : 1);
    const input = pts.map((p) => [p.x, p.y]);
    return R(input, hl ? { size, thinning: 0, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last: true } : { size, thinning: 0.5, smoothing: 0.55, streamline: 0.45, simulatePressure: true, last: true });
  }
  function smoothPath(o) {
    if (o.length < 2)
      return "";
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const m0 = mid(o[o.length - 1], o[0]);
    let d = `M${m0[0]},${m0[1]}`;
    for (let i = 0;i < o.length; i++) {
      const a = o[i], m = mid(a, o[(i + 1) % o.length]);
      d += `Q${a[0]},${a[1]} ${m[0]},${m[1]}`;
    }
    return d + "Z";
  }
  function arrowHead(a, b, len) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x), spread = Math.PI / 7;
    const p = (t) => `${b.x - len * Math.cos(ang + t)},${b.y - len * Math.sin(ang + t)}`;
    return `${b.x},${b.y} ${p(spread)} ${p(-spread)}`;
  }
  function svgFor(it, to, k) {
    const w = SIZES[it.size] * k, c = it.color, pts = it.pts.map(to);
    const line = () => el("line", {
      x1: pts[0].x,
      y1: pts[0].y,
      x2: pts[1].x,
      y2: pts[1].y,
      stroke: c,
      "stroke-width": w,
      "stroke-linecap": "round"
    });
    switch (it.kind) {
      case "pen":
      case "highlighter":
        return [
          el("path", {
            d: smoothPath(strokeOutline(pts, it, k)),
            fill: c,
            opacity: it.kind === "highlighter" ? 0.4 : 1
          })
        ];
      case "line":
        return [line()];
      case "arrow":
        return [
          line(),
          el("polygon", { points: arrowHead(pts[0], pts[1], (9 + SIZES[it.size] * 2.2) * k), fill: c })
        ];
      case "path":
        return [
          el("polyline", {
            points: pts.map((p) => `${p.x},${p.y}`).join(" "),
            fill: "none",
            stroke: c,
            "stroke-width": w,
            "stroke-linecap": "round",
            "stroke-linejoin": "round"
          })
        ];
      case "rect": {
        const r = boxOf(pts);
        return [
          el("rect", {
            x: r.x,
            y: r.y,
            width: r.w,
            height: r.h,
            stroke: c,
            "stroke-width": w,
            fill: c,
            "fill-opacity": 0.12
          })
        ];
      }
      case "ellipse": {
        const g = ellipseOf(pts, it.circle);
        return [
          el("ellipse", {
            cx: g.cx,
            cy: g.cy,
            rx: g.rx,
            ry: g.ry,
            stroke: c,
            "stroke-width": w,
            fill: c,
            "fill-opacity": 0.12
          })
        ];
      }
      default:
        return [];
    }
  }
  const worldAt = (q, z) => {
    const size = 512 * 2 ** z, sin = Math.sin(q.lat * Math.PI / 180);
    return { x: (q.lng + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
  };
  const strokes = new WeakMap;
  function strokeNode(it) {
    let e = strokes.get(it);
    if (!e) {
      const z0 = it.z ?? zoom();
      const anchor = worldAt(it.pts[0], z0);
      const rel = it.pts.map((q) => {
        const w = worldAt(q, z0);
        return { x: w.x - anchor.x, y: w.y - anchor.y };
      });
      const path = el("path", {
        d: smoothPath(strokeOutline(rel, it, 1)),
        fill: it.color,
        opacity: it.kind === "highlighter" ? 0.4 : 1
      });
      e = { z0, path };
      strokes.set(it, e);
    }
    const at = sp(it.pts[0]), k = 2 ** (zoom() - e.z0);
    const g = el("g", { transform: `translate(${at.x} ${at.y}) scale(${k})` });
    g.appendChild(e.path);
    return g;
  }
  const textNodes = new WeakMap;
  function textNode(it) {
    let node = textNodes.get(it);
    if (!node) {
      node = document.createElement("div");
      node.className = "ann";
      node.dataset.id = it.id;
      node.style.color = it.color;
      node.innerHTML = renderMd(it.text);
      textNodes.set(it, node);
    }
    const at = sp(it.pts[0]);
    node.style.transform = `translate(${at.x}px, ${at.y}px) scale(${scaleOf(it)})`;
    return node;
  }
  const FADE_MS = 1100;
  let animate = false;
  let shown = null;
  const fades = new Map;
  let fadeFrame = 0;
  const easeInOut = (k) => k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const alphaOf = (f, now) => {
    const e = easeInOut(Math.min(1, (now - f.t0) / FADE_MS));
    return f.kind === "in" ? e : 1 - e;
  };
  const setAlpha = (node, a) => {
    if (node instanceof SVGElement)
      node.setAttribute("opacity", a.toFixed(3));
    else
      node.style.opacity = a.toFixed(3);
  };
  function render() {
    const mapNow = getMap(), fade = animate && shown && shown.map === mapNow;
    animate = false;
    if (shown && shown.map !== mapNow)
      fades.clear();
    const prev = fade && shown ? shown.nodes : new Map;
    const nodes = new Map;
    const now = performance.now();
    layer.textContent = "";
    texts.textContent = "";
    for (const it of here()) {
      let node;
      if (it.kind === "text") {
        node = textNode(it);
        texts.appendChild(node);
      } else if (it.kind === "pen" || it.kind === "highlighter") {
        node = strokeNode(it);
        layer.appendChild(node);
      } else {
        node = el("g", {});
        for (const e of svgFor(it, sp, scaleOf(it)))
          node.appendChild(e);
        layer.appendChild(node);
      }
      if (fade && !prev.has(it.id))
        fades.set(it.id, { kind: "in", t0: now });
      nodes.set(it.id, node);
    }
    if (fade) {
      for (const [id, old] of prev)
        if (!nodes.has(id) && !fades.has(id))
          fades.set(id, { kind: "out", t0: now, node: old });
    }
    for (const [id, f] of fades) {
      const over = now - f.t0 >= FADE_MS;
      if (f.kind === "in") {
        if (over || !nodes.has(id)) {
          fades.delete(id);
          continue;
        }
        setAlpha(nodes.get(id), alphaOf(f, now));
      } else {
        if (over || nodes.has(id) || !f.node) {
          fades.delete(id);
          continue;
        }
        setAlpha(f.node, alphaOf(f, now));
        (f.node instanceof SVGElement ? layer : texts).appendChild(f.node);
      }
    }
    shown = { map: mapNow, nodes };
    if (fades.size && !fadeFrame)
      fadeFrame = requestAnimationFrame(() => {
        fadeFrame = 0;
        render();
      });
    if (draft) {
      const d = draft.kind === "path" && draft.hover ? { ...draft, pts: [...draft.pts, draft.hover] } : draft;
      for (const e of svgFor(d, (p) => p, 1))
        layer.appendChild(e);
    }
    hint.hidden = !(draft && draft.kind === "path");
    syncButtons();
  }
  function hits(it, p) {
    if (it.kind === "text") {
      const node = texts.querySelector(`[data-id="${it.id}"]`);
      if (!node)
        return false;
      const r = node.getBoundingClientRect(), b = mapEl.getBoundingClientRect();
      return p.x >= r.left - b.left - 4 && p.x <= r.right - b.left + 4 && p.y >= r.top - b.top - 4 && p.y <= r.bottom - b.top + 4;
    }
    const pts = it.pts.map(sp);
    const tol = SIZES[it.size] * scaleOf(it) * (it.kind === "highlighter" ? 4 : 1) / 2 + 6;
    if (it.kind === "ellipse") {
      const g = ellipseOf(pts, it.circle);
      if (!g.rx || !g.ry)
        return false;
      const f = Math.hypot((p.x - g.cx) / g.rx, (p.y - g.cy) / g.ry);
      return Math.abs(f - 1) * Math.min(g.rx, g.ry) <= tol;
    }
    let segs = [];
    if (it.kind === "rect") {
      const r = boxOf(pts), c = [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h }
      ];
      segs = c.map((q, i) => [q, c[(i + 1) % 4]]);
    } else {
      for (let i = 0;i + 1 < pts.length; i++)
        segs.push([pts[i], pts[i + 1]]);
      if (pts.length === 1)
        segs.push([pts[0], pts[0]]);
    }
    return segs.some(([a, b]) => segDist(p, a, b) <= tol);
  }
  function hitTest(p) {
    const list = here();
    for (let i = list.length - 1;i >= 0; i--)
      if (hits(list[i], p))
        return list[i];
    return null;
  }
  const snapshot = (p) => JSON.stringify(p.drawings || []);
  const centroid = (pts) => ({
    lng: pts.reduce((s, q) => s + q.lng, 0) / pts.length,
    lat: pts.reduce((s, q) => s + q.lat, 0) / pts.length
  });
  function pushHistory(at) {
    const p = getProfile();
    if (!p)
      return;
    history2.push({ pid: p.id, json: snapshot(p), at, z: zoom() });
    if (history2.length > 80)
      history2.shift();
    redoStack.length = 0;
  }
  function step(src, dst) {
    const p = getProfile();
    if (!p)
      return;
    const at = src.map((h) => h.pid).lastIndexOf(p.id);
    if (at < 0)
      return;
    const [h] = src.splice(at, 1);
    dst.push({ pid: p.id, json: snapshot(p), at: h.at, z: h.z });
    p.drawings = JSON.parse(h.json);
    draft = null;
    gesture = null;
    onChange();
    render();
    showEdit(h);
  }
  function showEdit(h) {
    if (!h.at || map.getBounds().contains([h.at.lng, h.at.lat]))
      return;
    map.easeTo({ center: [h.at.lng, h.at.lat], zoom: h.z, duration: 450 });
  }
  const undo = () => step(history2, redoStack);
  const redo = () => step(redoStack, history2);
  function commit(item) {
    pushHistory(centroid(item.pts));
    items().push({ id: uid(), z: Math.round(zoom() * 1000) / 1000, map: getMap(), ...item });
    draft = null;
    onChange();
    render();
  }
  const toItem = (d) => ({
    kind: d.kind,
    color: d.color,
    size: d.size,
    pts: d.pts.map(toGeo),
    circle: !!d.circle
  });
  function eraseAt(p) {
    const hit = hitTest(p);
    if (!hit || !gesture)
      return;
    if (!gesture.snapped) {
      pushHistory(centroid(hit.pts));
      gesture.snapped = true;
    }
    const list = items();
    list.splice(list.indexOf(hit), 1);
    onChange();
    render();
  }
  function closeEditor() {
    const ed = editor;
    editor = null;
    if (ed)
      ed.el.remove();
  }
  function commitEditor() {
    if (!editor)
      return;
    const ed = editor;
    closeEditor();
    const text = ed.ta.value.trim();
    if (ed.id) {
      const list = items(), it = list.find((x) => x.id === ed.id);
      if (!it || text === it.text) {
        render();
        return;
      }
      pushHistory(it.pts[0]);
      textNodes.delete(it);
      if (text)
        it.text = text;
      else
        list.splice(list.indexOf(it), 1);
      onChange();
      render();
      return;
    }
    if (text)
      commit({ kind: "text", color: ed.color, size: ink.size, pts: [toGeo(ed.at)], text });
    else
      render();
  }
  function openEditor(p, item) {
    commitEditor();
    const at = item ? sp(item.pts[0]) : p;
    const color = item ? item.color : ink.color;
    const wrap = document.createElement("div");
    wrap.className = "ann-editor";
    wrap.style.transform = `translate(${at.x}px, ${at.y}px)`;
    wrap.innerHTML = '<textarea rows="2" spellcheck="false" placeholder="Write something. Markdown works"></textarea>' + '<div class="ann-bar"><span class="ann-hint">Enter to place, Shift+Enter for a new line</span>' + `<button type="button" class="ann-cancel" aria-label="Cancel"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_CROSS}</svg></button>` + `<button type="button" class="ann-ok" aria-label="Place text"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_CHECK}</svg></button></div>`;
    const ta = wrap.querySelector("textarea");
    ta.value = item ? item.text || "" : "";
    ta.style.color = color;
    mapEl.appendChild(wrap);
    editor = { el: wrap, ta, id: item ? item.id : null, color, at };
    wrap.querySelector(".ann-ok").addEventListener("click", commitEditor);
    wrap.querySelector(".ann-cancel").addEventListener("click", closeEditor);
    setTimeout(() => ta.focus(), 0);
  }
  function cancelDraft() {
    draft = null;
    gesture = null;
    if (holdTimer)
      clearTimeout(holdTimer);
    render();
  }
  function finishPath() {
    if (holdTimer)
      clearTimeout(holdTimer);
    const d = draft;
    draft = null;
    if (d && d.pts.length >= 2)
      commit(toItem(d));
    else
      render();
  }
  canvasBox.addEventListener("pointerdown", (e) => {
    if (!active || e.button !== 0)
      return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size > 1) {
      cancelDraft();
      return;
    }
    if (editor)
      commitEditor();
    if (drawTool === "eraser") {
      gesture = { id: e.pointerId, erase: true, snapped: false };
      eraseAt(p);
      return;
    }
    if (drawTool === "text") {
      const hit = hitTest(p);
      openEditor(p, hit && hit.kind === "text" ? hit : null);
      return;
    }
    if (drawTool === "path") {
      if (!draft)
        draft = { kind: "path", color: ink.color, size: ink.size, pts: [p], hover: null };
      else if (dist(draft.pts[draft.pts.length - 1], p) > 4)
        draft.pts.push(p);
      if (e.detail >= 2) {
        finishPath();
        return;
      }
      holdAt = p;
      if (holdTimer)
        clearTimeout(holdTimer);
      holdTimer = setTimeout(finishPath, 500);
      render();
      return;
    }
    gesture = { id: e.pointerId };
    try {
      canvasBox.setPointerCapture(e.pointerId);
    } catch {}
    draft = { kind: drawTool, color: ink.color, size: ink.size, pts: [p, p] };
    if (drawTool === "pen" || drawTool === "highlighter")
      draft.pts = [p];
    render();
  });
  canvasBox.addEventListener("pointermove", (e) => {
    if (!active)
      return;
    const p = local(e);
    if (pointers.has(e.pointerId))
      pointers.set(e.pointerId, p);
    if (gesture && gesture.erase && gesture.id === e.pointerId) {
      eraseAt(p);
      return;
    }
    if (draft && draft.kind === "path") {
      if (holdAt && dist(holdAt, p) > 8 && holdTimer)
        clearTimeout(holdTimer);
      draft.hover = p;
      render();
      return;
    }
    if (!draft || !gesture || gesture.id !== e.pointerId || pointers.size > 1)
      return;
    if (draft.kind === "pen" || draft.kind === "highlighter") {
      if (dist(draft.pts[draft.pts.length - 1], p) >= 1.5)
        draft.pts.push(p);
    } else {
      const a = draft.pts[0];
      let dx = p.x - a.x, dy = p.y - a.y;
      if (e.shiftKey && (draft.kind === "line" || draft.kind === "arrow")) {
        const stepAngle = Math.PI / 12, ang = Math.round(Math.atan2(dy, dx) / stepAngle) * stepAngle, len = Math.hypot(dx, dy);
        dx = Math.cos(ang) * len;
        dy = Math.sin(ang) * len;
      }
      if (e.shiftKey && draft.kind === "rect") {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = (Math.sign(dx) || 1) * s;
        dy = (Math.sign(dy) || 1) * s;
      }
      draft.circle = draft.kind === "ellipse" && e.shiftKey;
      draft.pts[1] = { x: a.x + dx, y: a.y + dy };
    }
    render();
  });
  function endPointer(e, cancelled) {
    pointers.delete(e.pointerId);
    if (drawTool === "path" && holdTimer)
      clearTimeout(holdTimer);
    if (!gesture || gesture.id !== e.pointerId)
      return;
    const g = gesture;
    gesture = null;
    if (g.erase)
      return;
    if (!draft || cancelled) {
      draft = null;
      render();
      return;
    }
    const d = draft;
    draft = null;
    if (d.kind === "pen" || d.kind === "highlighter") {
      d.pts = simplify(d.pts, 1.1);
    } else if (dist(d.pts[0], d.pts[1]) < 3) {
      render();
      return;
    }
    commit(toItem(d));
  }
  canvasBox.addEventListener("pointerup", (e) => endPointer(e, false));
  canvasBox.addEventListener("pointercancel", (e) => endPointer(e, true));
  canvasBox.addEventListener("contextmenu", (e) => {
    if (active)
      e.preventDefault();
  });
  const typing = (e) => {
    const t = e.target;
    return !!t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable);
  };
  function keydown(e) {
    if (e.isComposing)
      return false;
    if (editor) {
      if (e.key === "Escape") {
        closeEditor();
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        commitEditor();
        return true;
      }
      return false;
    }
    if (typing(e))
      return false;
    if (e.key === "Escape" && (draft || gesture)) {
      cancelDraft();
      return true;
    }
    if (e.key === "Enter" && draft && draft.kind === "path") {
      finishPath();
      return true;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && history2.length) {
      undo();
      return true;
    }
    if (mod && (e.key.toLowerCase() === "z" && e.shiftKey || e.key.toLowerCase() === "y") && redoStack.length) {
      redo();
      return true;
    }
    return false;
  }
  map.addControl({
    onAdd() {
      const c = document.createElement("div");
      c.className = "maplibregl-ctrl maplibregl-ctrl-group history-ctrl";
      c.innerHTML = `<button type="button" id="undo-btn" aria-label="Undo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_UNDO}</svg></button>` + `<button type="button" id="redo-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_REDO}</svg></button>`;
      return c;
    },
    onRemove() {}
  }, "bottom-right");
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  const drawBtn = document.getElementById("tool-draw");
  const eraserBtn = document.getElementById("tool-eraser");
  const inkBtn = document.getElementById("tool-ink");
  const drawMenu = document.createElement("div");
  drawMenu.id = "draw-menu";
  drawMenu.className = "menu row-menu";
  drawMenu.hidden = true;
  drawMenu.setAttribute("role", "menu");
  drawMenu.innerHTML = DRAW_ORDER.map((k) => `<button type="button" role="menuitemradio" data-tool="${k}" aria-checked="false">` + `<svg viewBox="0 0 24 24" aria-hidden="true">${TOOLS[k].icon}</svg>${TOOLS[k].name}</button>`).join("");
  document.body.appendChild(drawMenu);
  function placeBeside(elm, rect) {
    elm.hidden = false;
    const { offsetWidth: w, offsetHeight: h } = elm, pad = 8;
    const x = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad));
    elm.style.left = x + "px";
    elm.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + "px";
  }
  function syncButtons() {
    if (drawBtn.dataset.kind !== penCat) {
      drawBtn.dataset.kind = penCat;
      drawBtn.querySelector("svg").innerHTML = TOOLS[penCat].icon;
      drawBtn.setAttribute("aria-label", `Drawing tool: ${TOOLS[penCat].name}`);
    }
    drawBtn.setAttribute("aria-pressed", String(active && drawTool !== "eraser"));
    eraserBtn.setAttribute("aria-pressed", String(active && drawTool === "eraser"));
    drawMenu.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tool === penCat)));
    const pid = getProfile()?.id;
    const canUndo = !!pid && history2.some((h) => h.pid === pid);
    const canRedo = !!pid && redoStack.some((h) => h.pid === pid);
    undoBtn.hidden = !canUndo;
    redoBtn.hidden = !canRedo;
    undoBtn.parentElement.hidden = !canUndo && !canRedo;
  }
  function pickDrawing(kind) {
    penCat = kind;
    drawTool = kind;
    drawMenu.hidden = true;
    requestTool("draw");
  }
  function openDrawMenu() {
    closeInk();
    syncButtons();
    placeBeside(drawMenu, drawBtn.getBoundingClientRect());
  }
  drawMenu.onclick = (e) => {
    const b = e.target?.closest("[data-tool]");
    if (b && b.dataset.tool)
      pickDrawing(b.dataset.tool);
  };
  let drawTimer = null, drawHeld = false;
  drawBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0)
      return;
    drawHeld = false;
    drawTimer = setTimeout(() => {
      drawHeld = true;
      openDrawMenu();
    }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => drawBtn.addEventListener(t, () => {
    if (drawTimer)
      clearTimeout(drawTimer);
  }));
  drawBtn.addEventListener("click", () => {
    if (drawHeld) {
      drawHeld = false;
      return;
    }
    if (active && drawTool !== "eraser") {
      if (drawMenu.hidden)
        openDrawMenu();
      else
        drawMenu.hidden = true;
      return;
    }
    drawMenu.hidden = true;
    pickDrawing(penCat);
  });
  drawBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openDrawMenu();
  });
  eraserBtn.addEventListener("click", () => {
    drawMenu.hidden = true;
    closeInk();
    if (active && drawTool === "eraser")
      return;
    drawTool = "eraser";
    requestTool("draw");
  });
  const inkPop = document.createElement("div");
  inkPop.id = "ink-pop";
  inkPop.className = "menu row-menu ink-pop";
  inkPop.hidden = true;
  inkPop.innerHTML = `<div class="ink-swatches">${PALETTE.map((c) => `<button type="button" class="sw" data-color="${c}" style="--c:${c}" aria-label="${c}"></button>`).join("")}</div>` + '<div class="ink-wheel"><div class="ring" id="ink-ring"><i class="ring-knob"></i></div>' + '<div class="sv" id="ink-sv"><i class="sv-knob"></i></div></div>' + '<div class="ink-row"><span class="ink-prev"></span><input class="ink-hex" id="ink-hex" maxlength="7" spellcheck="false" aria-label="Hex colour"></div>' + `<div class="ink-sizes">${Object.keys(SIZES).map((k) => `<button type="button" data-size="${k}" title="${SIZE_NAMES[k]}" aria-label="${SIZE_NAMES[k]}"><i style="--w:${SIZES[k] * 2 + 2}px"></i></button>`).join("")}</div>`;
  document.body.appendChild(inkPop);
  const ring = inkPop.querySelector("#ink-ring");
  const sv = inkPop.querySelector("#ink-sv");
  const hex = inkPop.querySelector("#ink-hex");
  let hsv = hexToHsv(ink.color);
  const RING_R = 67.5, SV = 92;
  function renderInk() {
    const [h, s, v] = hsv;
    const rad = h * Math.PI / 180;
    const ringKnob = ring.querySelector(".ring-knob");
    ringKnob.style.left = 75 + RING_R * Math.sin(rad) + "px";
    ringKnob.style.top = 75 - RING_R * Math.cos(rad) + "px";
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h} 100% 50%))`;
    const svKnob = sv.querySelector(".sv-knob");
    svKnob.style.left = s * SV + "px";
    svKnob.style.top = (1 - v) * SV + "px";
    if (document.activeElement !== hex)
      hex.value = ink.color;
    inkPop.querySelector(".ink-prev").style.background = ink.color;
    inkPop.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === ink.color));
    inkPop.querySelectorAll("[data-size]").forEach((b) => b.classList.toggle("on", b.dataset.size === ink.size));
    inkBtn.querySelector(".ink-dot").style.background = ink.color;
  }
  function setColor(c) {
    ink.color = c;
    hsv = hexToHsv(c);
    renderInk();
  }
  function setFromHsv() {
    ink.color = hsvToHex(...hsv);
    renderInk();
  }
  const drag = (node, fn) => node.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    fn(e);
    const move = (ev) => fn(ev);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", () => node.removeEventListener("pointermove", move), { once: true });
  });
  drag(ring, (e) => {
    const r = ring.getBoundingClientRect();
    const deg = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI;
    hsv[0] = (deg + 360) % 360;
    setFromHsv();
  });
  drag(sv, (e) => {
    const r = sv.getBoundingClientRect();
    hsv[1] = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    hsv[2] = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    setFromHsv();
  });
  inkPop.querySelectorAll(".sw").forEach((b) => b.addEventListener("click", () => setColor(b.dataset.color)));
  inkPop.querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => {
    ink.size = b.dataset.size;
    renderInk();
  }));
  hex.addEventListener("input", () => {
    const v = hex.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v))
      setColor("#" + v.replace("#", "").toLowerCase());
  });
  hex.addEventListener("change", () => renderInk());
  function closeInk() {
    inkPop.hidden = true;
  }
  inkBtn.addEventListener("click", () => {
    if (!inkPop.hidden)
      return closeInk();
    drawMenu.hidden = true;
    hsv = hexToHsv(ink.color);
    renderInk();
    placeBeside(inkPop, inkBtn.getBoundingClientRect());
  });
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target?.closest("#draw-menu, #tool-draw"))
      drawMenu.hidden = true;
    if (!target?.closest("#ink-pop, #tool-ink"))
      closeInk();
  });
  renderInk();
  syncButtons();
  function setActive(on) {
    if (!on && editor)
      commitEditor();
    if (!on)
      cancelDraft();
    active = on;
    mapEl.classList.toggle("tool-draw", on);
    render();
  }
  map.on("move", render);
  map.on("resize", render);
  return {
    setActive,
    render,
    snapshot(cssW, cssH) {
      const c = layer.cloneNode(true);
      c.setAttribute("width", String(cssW));
      c.setAttribute("height", String(cssH));
      c.setAttribute("viewBox", `0 0 ${cssW} ${cssH}`);
      return new XMLSerializer().serializeToString(c);
    },
    reset() {
      history2.length = 0;
      redoStack.length = 0;
      draft = null;
      gesture = null;
      if (holdTimer)
        clearTimeout(holdTimer);
      closeEditor();
      render();
    },
    animateNext() {
      animate = true;
    },
    keydown
  };
}

// src/client/map/markdown.ts
function mapgenieLocId(href) {
  let u;
  try {
    u = new URL(href, "https://mapgenie.io/");
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol))
    return null;
  const m = /^(\d+)/.exec(u.searchParams.get("locationIds") || "");
  return m ? Number(m[1]) : null;
}
function forEachLink(tokens, fn) {
  for (const t of tokens || []) {
    if (t.type === "link")
      fn(t);
    forEachLink(t.tokens, fn);
    if (t.items)
      forEachLink(t.items, fn);
  }
}
function internalRefs(src, selfId) {
  const out = [];
  if (typeof marked === "undefined")
    return out;
  forEachLink(marked.lexer(String(src || "")), (t) => {
    const id = mapgenieLocId(t.href);
    if (id != null && id !== selfId && state.byId.has(id) && !out.includes(id))
      out.push(id);
  });
  return out;
}
if (typeof marked !== "undefined") {
  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      html(t) {
        return esc(t.text);
      },
      link(t) {
        const text = this.parser.parseInline(t.tokens);
        const id = mapgenieLocId(t.href);
        if (id != null)
          return state.byId.has(id) ? `<a href="#loc=${id}" data-loc="${id}">${text}</a>` : text;
        if (/^https?:/i.test(t.href))
          return `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        return text;
      },
      image(t) {
        const text = esc(t.text || t.href);
        return /^https?:/i.test(t.href) ? `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
      }
    }
  });
}
function renderMd(src) {
  return typeof marked !== "undefined" ? marked.parse(String(src || "")) : esc(src || "");
}

// src/shared/search.ts
var norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
var flat = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
var words = (s) => flat(s).split(" ").filter((w) => w.length >= 3);
function levenshtein(a, b) {
  if (a === b)
    return 0;
  if (!a.length)
    return b.length;
  if (!b.length)
    return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1;i <= a.length; i++) {
    const cur = [i];
    for (let j = 1;j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function fuzzyScore(queryWords, textWords) {
  let total = 0, counted = 0;
  for (const qw of queryWords) {
    if (qw.length < 3)
      continue;
    const allowed = qw.length <= 4 ? 1 : 2;
    let best = Infinity;
    for (const tw of textWords)
      best = Math.min(best, levenshtein(qw, tw));
    if (best > allowed)
      return null;
    total += best;
    counted++;
  }
  return counted ? total : null;
}

// src/client/map/search.ts
var SEARCH_MIN = 2;
var SEARCH_SHOWN = 300;
var PREVIEW_MS = 350;
var HOVER_MS = 50;
var mapName = (slug) => state.meta?.maps?.find((m) => m.slug === slug)?.title || slug;
function queryOf(text) {
  const toks = flat(text).split(" ").filter(Boolean);
  return { phrase: toks.join(" "), toks, long: toks.filter((t) => t.length >= 3) };
}
var textCache = new WeakMap;
function textOf(l) {
  let c = textCache.get(l);
  if (!c)
    textCache.set(l, c = { title: flat(l.title), titleWords: words(l.title), desc: flat(l.desc), descWords: null });
  return c;
}
var hasWord = (text, t) => t.length >= 3 ? text.includes(t) : (" " + text + " ").includes(" " + t + " ");
function matchOf(q, l) {
  const c = textOf(l);
  if (c.title === q.phrase)
    return [0, 0];
  if (c.title.includes(q.phrase))
    return [1, 0];
  if (q.toks.every((t) => hasWord(c.title, t)))
    return [2, 0];
  const t3 = fuzzyScore(q.long, c.titleWords);
  if (t3 !== null)
    return [3, t3];
  if (q.toks.every((t) => hasWord(c.desc, t)))
    return [4, 0];
  c.descWords ??= words(l.desc);
  const t5 = fuzzyScore(q.long, c.descWords);
  return t5 !== null ? [5, t5] : null;
}
function localEntries() {
  const cur = state.mapInfo.slug;
  return state.locs.filter((l) => applicable(l) && !state.view.hidden.has(l.cat) && !(state.view.hideFound && state.found.has(l.id))).map((l) => ({ l, slug: cur, cat: state.cats.get(l.cat), col: state.groupOfCat.get(l.cat)?.col }));
}
async function otherEntries() {
  const others = state.meta.maps.filter((m) => m.slug !== state.mapInfo.slug);
  const lists = await Promise.all(others.map(async (info) => {
    const data = await mapData(info);
    const cats = new Map(Object.values(data.categories).map((c) => [c.id, c]));
    const groupCol = new Map(data.groups.map((g) => [g.id, vivid(g.color)]));
    const view = state.profile?.view?.[info.slug] || {};
    const hidden = new Set(view.hidden || []);
    const out = [];
    for (const d of data.locations) {
      const lat = parseFloat(d.latitude), lng = parseFloat(d.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || hidden.has(d.category_id))
        continue;
      if (view.hideFound && state.found.has(d.id))
        continue;
      const cat = cats.get(d.category_id);
      out.push({
        l: { id: d.id, title: d.title || "", desc: d.description || "", lat, lng },
        slug: info.slug,
        cat,
        col: groupCol.get(cat?.group_id)
      });
    }
    return out;
  }));
  return lists.flat();
}
function rankEntries(q, entries, { byDistance = true } = {}) {
  const cam = state.map ? state.map.getCenter() : { lng: 0, lat: 0 }, cur = state.mapInfo.slug;
  const hits = [];
  for (const e of entries) {
    const m = matchOf(q, e.l);
    if (!m)
      continue;
    const here = e.slug === cur;
    const dist = byDistance && here ? Math.hypot(e.l.lng - cam.lng, e.l.lat - cam.lat) : 0;
    hits.push({ e, tier: m[0], typo: m[1], here, dist });
  }
  const cmp = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  hits.sort((a, b) => cmp(a.tier, b.tier) || cmp(a.typo, b.typo) || cmp(b.here, a.here) || cmp(a.dist, b.dist) || a.e.l.title.localeCompare(b.e.l.title));
  return hits;
}
async function runSearch() {
  const s = state.search;
  endPreview({ instant: true });
  const text = ($("#search")?.value || "").trim();
  const wild = text === "*";
  if (!wild && [...text].length < SEARCH_MIN)
    return leaveSearch();
  const my = ++s.run;
  s.active = true;
  s.wild = wild;
  document.body.classList.add("searching");
  syncSideClose();
  const all = !wild && s.scope === "all" && state.meta.maps.length > 1;
  let entries = localEntries();
  if (all) {
    s.busy = true;
    s.rows = [];
    renderResults();
    const others = await otherEntries().catch(() => []);
    if (my !== s.run)
      return;
    entries = entries.concat(others);
    s.busy = false;
  }
  const hits = wild ? entries.map((e) => ({ e, tier: 0, typo: 0, here: true, dist: 0 })).sort((a, b) => a.e.l.title.localeCompare(b.e.l.title)) : rankEntries(queryOf(text), entries, { byDistance: !all });
  s.rows = hits;
  s.ids = new Set(hits.filter((h) => h.here).map((h) => h.e.l.id));
  const selIdx = state.selected != null ? hits.findIndex((h) => h.here && h.e.l.id === state.selected) : -1;
  s.idx = selIdx;
  renderResults();
  if (selIdx > 0) {
    const activeEl = $("#results")?.querySelector("li.result.active");
    if (activeEl)
      activeEl.scrollIntoView({ block: "nearest" });
  }
  refreshMap();
}
function syncSideClose() {
  const b = $("#side-close"), on = state.search.active;
  if (!b)
    return;
  b.classList.toggle("search-close", on);
  b.innerHTML = on ? svgIcon("x") : "Close";
  b.setAttribute("aria-label", on ? "Close search" : "Close panel");
  b.title = on ? "Close search" : "";
}
function leaveSearch() {
  const s = state.search;
  endPreview({ instant: true });
  s.run++;
  s.active = false;
  s.ids = null;
  s.rows = [];
  s.busy = false;
  s.wild = false;
  s.idx = -1;
  document.body.classList.remove("searching");
  syncSideClose();
  const res = $("#results");
  if (res)
    res.innerHTML = "";
  refreshMap();
}
function resultHtml(h, i) {
  const { e, here } = h, l = e.l, found = state.found.has(l.id);
  const icon = e.cat ? iconHtml(e.cat.icon, e.cat.color || e.col) : "";
  const sub = [e.cat?.title, here ? "" : mapName(e.slug)].filter(Boolean).join(" · ");
  return `<li class="result${found ? " found" : ""}${i === state.search.idx ? " active" : ""}" data-id="${l.id}" data-map="${esc(e.slug)}">` + `<div class="r-head"><span class="ico-wrap">${icon}</span><span class="r-title">${esc(l.title)}</span>${found ? '<span class="r-found">found</span>' : ""}</div>` + `<div class="r-sub">${esc(sub)}</div>` + (l.desc ? `<div class="r-desc">${renderMd(l.desc)}</div>` : "") + "</li>";
}
function renderResults() {
  const s = state.search, n = s.rows.length;
  const resEl = $("#results");
  if (resEl)
    resEl.innerHTML = s.rows.slice(0, SEARCH_SHOWN).map(resultHtml).join("");
  const bar = $("#results-bar");
  if (bar) {
    bar.querySelector(".r-count").textContent = s.busy ? "Searching the other maps…" : n === 0 ? "No matches" : `${fmt(n)} result${n === 1 ? "" : "s"}${n > SEARCH_SHOWN ? `, first ${SEARCH_SHOWN} listed` : ""}`;
  }
  const scope = $("#scope-switch");
  if (scope) {
    scope.hidden = state.meta.maps.length < 2 || s.wild;
    scope.querySelectorAll("[data-scope]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scope === s.scope)));
    placeThumb(scope, "data-scope", s.scope);
    scope.classList.add("ready");
  }
}
var ringEl = null;
var ringAt = null;
function showRing(l) {
  if (!ringEl) {
    ringEl = document.createElement("div");
    ringEl.className = "search-ring";
    ringEl.hidden = true;
    state.map.getContainer().appendChild(ringEl);
    state.map.on("move", placeRing);
  }
  ringAt = l;
  ringEl.hidden = false;
  placeRing();
}
function hideRing() {
  ringAt = null;
  if (ringEl)
    ringEl.hidden = true;
}
function placeRing() {
  if (!ringEl || ringEl.hidden || !ringAt)
    return;
  const p = state.map.project([ringAt.lng, ringAt.lat]);
  ringEl.style.transform = `translate(${p.x - 21}px, ${p.y - 38}px)`;
}
function previewRow(li) {
  const s = state.search;
  if (!li || !state.mapReady)
    return;
  const hit = s.rows.find((h) => String(h.e.l.id) === li.dataset.id && h.e.slug === li.dataset.map);
  if (!hit || !hit.here)
    return;
  previewAt(hit.e.l);
}
function previewAt(l) {
  if (!l || !state.mapReady)
    return;
  const s = state.search;
  if (!s.preview)
    s.preview = { cam: { center: state.map.getCenter(), zoom: state.map.getZoom() } };
  const padding = !document.body.classList.contains("detail-open") ? {} : isMobile() ? { bottom: Math.round(innerHeight * 0.4) } : { right: 384 };
  state.map.easeTo({
    center: [l.lng, l.lat],
    zoom: Math.max(state.map.getZoom(), 12),
    padding,
    duration: PREVIEW_MS
  });
  showRing(l);
}
function endPreview({ instant = false, restore = true } = {}) {
  const s = state.search, p = s.preview;
  hideRing();
  if (!p)
    return;
  s.preview = null;
  if (!restore || !state.mapReady)
    return;
  if (instant)
    state.map.jumpTo({ center: p.cam.center, zoom: p.cam.zoom, padding: {} });
  else
    state.map.easeTo({ center: p.cam.center, zoom: p.cam.zoom, padding: {}, duration: PREVIEW_MS });
}
function syncSearchActive(id, slug = state.mapInfo?.slug) {
  if (!state.search.active)
    return;
  const items = [...$("#results")?.querySelectorAll("li.result") || []];
  const idx = id != null ? items.findIndex((el) => Number(el.dataset.id) === id && el.dataset.map === slug) : -1;
  state.search.idx = idx;
  items.forEach((el, i) => el.classList.toggle("active", i === idx));
  if (idx !== -1)
    items[idx].scrollIntoView({ block: "nearest" });
}
function moveSearch(d) {
  const s = state.search, items = [...$("#results")?.querySelectorAll("li.result") || []];
  if (!items.length)
    return;
  if (s.idx < 0) {
    s.idx = d > 0 ? 0 : items.length - 1;
  } else {
    s.idx = (s.idx + d + items.length) % items.length;
  }
  items.forEach((el, i) => el.classList.toggle("active", i === s.idx));
  items[s.idx].scrollIntoView({ block: "nearest" });
  const li = items[s.idx];
  const id = Number(li.dataset.id), slug = li.dataset.map;
  if (slug === state.mapInfo?.slug) {
    select(id, { fly: false, push: false, closeSide: false });
  }
  previewRow(li);
}
async function openResult(li) {
  if (!li)
    return;
  const id = Number(li.dataset.id), slug = li.dataset.map;
  syncSearchActive(id, slug);
  endPreview({ restore: false });
  if (slug !== state.mapInfo.slug) {
    await switchMap(slug);
    if (state.mapInfo?.slug !== slug)
      return;
  }
  select(id);
}

// src/client/map/usermarkers.ts
var TEMP_CAT_ID = -1;
var TEMP_CAT = { id: TEMP_CAT_ID, title: "Temporary", color: "#ffb547", temp: true };
var NEW_CAT = "__new";
var MARKER_CONTROL_HTML = '<button type="button" id="tool-marker" class="notched" aria-label="Place marker" title="Place a marker. Tap again, or right-click or hold, for more">' + '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="5.5"/><circle cx="12" cy="11" r="1.8"/><path d="M12 16.5V21"/></svg></button>';
var newId = () => -(Math.floor(Math.random() * 2000000000) + 1);
function pingImage(name) {
  return pinImage("#" + name.slice(3).replace("-t", ""), name.endsWith("-t"));
}
function iconField(current) {
  return '<div class="field um-icon"><span>Icon</span>' + '<input type="search" class="um-icon-q" placeholder="Search icons, e.g. key, skull, tree" autocomplete="off" aria-label="Search icons">' + '<div class="um-icon-grid" role="listbox" aria-label="Icons"></div>' + `<input type="hidden" name="glyph" value="${esc(current || "")}"></div>`;
}
function wireIcon(root) {
  const q = root.querySelector(".um-icon-q");
  const grid = root.querySelector(".um-icon-grid");
  const hid = root.querySelector('input[name="glyph"]');
  const color = root.querySelector('input[name="color"]');
  const paintColor = () => grid.style.setProperty("--c", color?.value || "#e5484d");
  root.addEventListener("um-color", paintColor);
  const draw = () => {
    const tile = (val, label, inner) => `<button type="button" class="ic-tile${hid.value === val ? " on" : ""}" data-glyph="${val}" aria-label="${label}" title="${label}">${inner}</button>`;
    const names = searchIcons(q.value, 120);
    grid.innerHTML = tile("", "Plain dot", '<span class="ico-ping-mini"></span>') + names.map((n) => tile(n, n.replace(/-/g, " "), `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${iconInner(n)}</svg>`)).join("") + (names.length ? "" : '<p class="none">No icon matches.</p>');
  };
  q.addEventListener("input", draw);
  grid.addEventListener("click", (e) => {
    const b = e.target?.closest("[data-glyph]");
    if (!b)
      return;
    hid.value = b.dataset.glyph || "";
    draw();
  });
  paintColor();
  if (iconsReady())
    draw();
  else {
    grid.innerHTML = '<p class="none">Loading icons…</p>';
    loadIconLibrary().then(draw, () => {
      grid.innerHTML = '<p class="none">The icons could not be loaded.</p>';
    });
  }
}
function setupUserMarkers({
  map,
  state,
  mapEl,
  canvasBox,
  changed,
  select,
  closeDetail,
  askDialog,
  toast,
  requestTool
}) {
  const profileCats = () => state.profile.userCats ||= [];
  const profileMarkers = () => state.profile.userMarkers ||= [];
  const findMarker = (id) => profileMarkers().find((m) => m.id === id) || state.tempMarkers.find((m) => m.id === id) || null;
  const local = (e) => {
    const r = canvasBox.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  let active = false, kind = "perm", moveId = null;
  function dialog(title, body, {
    ok = "Save",
    danger = null,
    onReady
  } = {}) {
    return new Promise((resolve) => {
      const d = document.getElementById("dlg");
      const form = document.getElementById("dlg-form");
      form.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="dlg-actions">` + (danger ? `<button type="button" class="danger" data-del>${esc(danger)}</button>` : "") + `<button type="button" data-cancel>Cancel</button><button class="primary">${esc(ok)}</button></div>`;
      d.classList.add("um");
      const finish = (r) => {
        d.classList.remove("um");
        if (d.open)
          d.close();
        resolve(r);
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        finish({ form });
      };
      form.querySelector("[data-cancel]").onclick = () => finish(null);
      form.querySelector("[data-del]")?.addEventListener("click", () => finish({ del: true }));
      d.oncancel = () => finish(null);
      onReady?.(form);
      d.showModal();
    });
  }
  function colorField(c) {
    return `<div class="field um-color"><span>Colour</span><div class="um-sw">${PALETTE.map((p) => `<button type="button" class="sw" data-color="${p}" style="--c:${p}" aria-label="${p}"></button>`).join("")}</div>` + `<div class="um-colorrow"><input type="color" name="color" value="${esc(c)}" aria-label="Colour wheel">` + `<input class="um-hex" maxlength="7" value="${esc(c)}" spellcheck="false" aria-label="Hex colour"></div></div>`;
  }
  function wireColor(root) {
    const color = root.querySelector('input[name="color"]');
    const hex = root.querySelector(".um-hex");
    const set = (c) => {
      color.value = c;
      hex.value = c;
      root.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
      root.dispatchEvent(new Event("um-color"));
    };
    root.querySelectorAll(".sw").forEach((b) => b.addEventListener("click", () => set(b.dataset.color)));
    color.addEventListener("input", () => set(color.value));
    hex.addEventListener("input", () => {
      const v = hex.value.trim();
      if (/^#?[0-9a-f]{6}$/i.test(v))
        set("#" + v.replace("#", "").toLowerCase());
    });
    set(color.value);
  }
  function removeRecords(ids) {
    const gone = new Set(ids);
    state.profile.userMarkers = profileMarkers().filter((m) => !gone.has(m.id));
    state.tempMarkers = state.tempMarkers.filter((m) => !gone.has(m.id));
    for (const id of ids)
      state.found.delete(id);
    for (const m of [...state.profile.userMarkers, ...state.tempMarkers]) {
      if (m.links?.length)
        m.links = m.links.filter((x) => !gone.has(x));
    }
  }
  function pruneEmptyCategories(catIds) {
    const used = new Set(profileMarkers().map((m) => m.cat));
    state.profile.userCats = profileCats().filter((c) => !catIds.includes(c.id) || used.has(c.id));
  }
  async function deleteMarker(m) {
    const ok = await askDialog({
      title: "Delete marker?",
      message: `"${m.title}" will be removed.`,
      okLabel: "Delete",
      danger: true
    });
    if (!ok)
      return;
    const cat = m.cat;
    removeRecords([m.id]);
    pruneEmptyCategories([cat]);
    if (state.selected === m.id)
      closeDetail();
    changed();
  }
  async function deleteMany(ids) {
    if (!ids.length)
      return;
    const n = ids.length;
    const ok = await askDialog({
      title: `Delete ${n} user marker${n === 1 ? "" : "s"}?`,
      message: "They will be removed from this profile.",
      okLabel: "Delete",
      danger: true
    });
    if (!ok)
      return;
    const cats = [...new Set(ids.map((id) => findMarker(id)?.cat))];
    removeRecords(ids);
    pruneEmptyCategories(cats);
    if (ids.includes(state.selected))
      closeDetail();
    changed();
  }
  async function deleteCategory(cat) {
    const ids = profileMarkers().filter((m) => m.cat === cat.id).map((m) => m.id);
    const message = ids.length ? `"${cat.title}" and its ${ids.length} marker${ids.length === 1 ? "" : "s"} will be removed.` : `"${cat.title}" will be removed.`;
    const ok = await askDialog({ title: "Delete category?", message, okLabel: "Delete", danger: true });
    if (!ok)
      return;
    removeRecords(ids);
    state.profile.userCats = profileCats().filter((c) => c.id !== cat.id);
    if (ids.includes(state.selected))
      closeDetail();
    changed();
  }
  async function markerForm({
    marker = null,
    pos = null,
    temp = false,
    promote = false
  }) {
    const isTemp = promote ? false : marker ? !!marker.temp : temp;
    const cats = profileCats();
    const links = [...marker?.links || []];
    const sh = marker?.shared || null;
    const sameName = sh ? cats.find((c) => c.title.trim().toLowerCase() === sh.name.trim().toLowerCase()) : null;
    const selCat = marker && !marker.temp ? marker.cat : sameName ? sameName.id : sh ? NEW_CAT : cats[0]?.id ?? NEW_CAT;
    const fresh = sh && !sameName ? sh : null;
    const opts = cats.map((c) => `<option value="${c.id}"${c.id === selCat ? " selected" : ""}>${esc(c.title)}</option>`).join("") + `<option value="${NEW_CAT}"${selCat === NEW_CAT ? " selected" : ""}>New category…</option>`;
    const body = `<label class="field"><span>Name</span><input name="title" maxlength="80" required value="${esc(marker?.title || "")}" autocomplete="off"></label>` + (isTemp ? '<p class="d-note">Temporary: this marker is gone when the tab closes.</p>' : `<label class="field"><span>Category</span><select name="cat">${opts}</select></label>` + `<div class="um-newcat" ${selCat === NEW_CAT ? "" : "hidden"}><label class="field"><span>New category</span>` + `<input name="newcat" maxlength="40" placeholder="e.g. Keys" autocomplete="off" value="${esc(fresh?.name || "")}"></label>${colorField(fresh?.color || PALETTE[0])}${iconField(fresh?.glyph || "")}</div>`) + `<label class="field"><span>Notes</span><textarea name="desc" rows="4" placeholder="Markdown works">${esc(marker?.desc || "")}</textarea></label>` + '<div class="field"><span>Links</span><div class="um-chips"></div>' + '<input type="search" class="um-q" placeholder="Find a marker to link" autocomplete="off"><ul class="um-pick" hidden></ul></div>';
    const onReady = (form) => {
      const sel = form.elements.namedItem("cat");
      const block = form.querySelector(".um-newcat");
      if (sel && block)
        sel.addEventListener("change", () => {
          block.hidden = sel.value !== NEW_CAT;
        });
      if (block) {
        wireColor(block);
        wireIcon(block);
      }
      const chips = form.querySelector(".um-chips");
      const q = form.querySelector(".um-q");
      const pick = form.querySelector(".um-pick");
      const drawChips = () => {
        chips.innerHTML = links.map((id) => {
          const t = state.byId.get(id);
          return `<span class="um-chip">${esc(t ? t.title : id > 0 ? "Marker on another map" : "Missing marker")}<button type="button" data-rm="${id}" aria-label="Remove link">&times;</button></span>`;
        }).join("");
      };
      chips.onclick = (e) => {
        const b = e.target?.closest("[data-rm]");
        if (!b)
          return;
        const i = links.indexOf(Number(b.dataset.rm));
        if (i >= 0)
          links.splice(i, 1);
        drawChips();
      };
      const drawPick = () => {
        const s = q.value.trim().toLowerCase();
        if (!s) {
          pick.hidden = true;
          pick.innerHTML = "";
          return;
        }
        const hits = state.locs.filter((l) => l.id !== marker?.id && !links.includes(l.id) && l.title.toLowerCase().includes(s)).slice(0, 8);
        pick.innerHTML = hits.length ? hits.map((l) => `<li data-add="${l.id}">${esc(l.title)}<small>${esc(state.cats.get(l.cat)?.title || "")}</small></li>`).join("") : '<li class="none">No marker matches</li>';
        pick.hidden = false;
      };
      q.addEventListener("input", drawPick);
      q.addEventListener("keydown", (e) => {
        if (e.key === "Enter")
          e.preventDefault();
      });
      pick.onclick = (e) => {
        const li = e.target?.closest("[data-add]");
        if (!li)
          return;
        links.push(Number(li.dataset.add));
        q.value = "";
        drawPick();
        drawChips();
      };
      drawChips();
    };
    const heading = promote ? "Make permanent" : marker ? "Edit marker" : "New marker";
    const res = await dialog(heading, body, {
      ok: marker && !promote ? "Save" : promote ? "Make permanent" : "Place",
      danger: marker && !promote ? "Delete" : null,
      onReady
    });
    if (!res)
      return null;
    if (res.del && marker) {
      await deleteMarker(marker);
      return null;
    }
    const f = res.form.elements;
    const title = f.title.value.trim();
    if (!title) {
      toast("A marker needs a name.");
      return null;
    }
    let cat = TEMP_CAT_ID;
    if (!isTemp) {
      cat = f.cat.value;
      if (cat === NEW_CAT) {
        const name = f.newcat.value.trim();
        if (!name) {
          toast("Give the new category a name.");
          return null;
        }
        const c = {
          id: newId(),
          title: name,
          color: f.color.value,
          glyph: f.glyph?.value || null
        };
        profileCats().push(c);
        cat = c.id;
      } else
        cat = Number(cat);
    }
    const data = {
      title,
      cat: Number(cat),
      desc: f.desc.value,
      links: links.filter((id) => id !== marker?.id && (id > 0 || state.byId.has(id)))
    };
    let saved;
    const oldCat = marker?.cat;
    if (promote && marker) {
      state.tempMarkers = state.tempMarkers.filter((x) => x.id !== marker.id);
      saved = { id: marker.id, ...data, lat: marker.lat, lng: marker.lng, created: Date.now(), map: marker.map };
      profileMarkers().push(saved);
    } else if (marker)
      saved = Object.assign(marker, data);
    else if (isTemp && pos) {
      saved = { id: newId(), ...data, lat: pos.lat, lng: pos.lng, temp: true, map: state.mapInfo.slug };
      state.tempMarkers.push(saved);
    } else {
      saved = {
        id: newId(),
        ...data,
        lat: pos.lat,
        lng: pos.lng,
        created: Date.now(),
        map: state.mapInfo.slug
      };
      profileMarkers().push(saved);
    }
    if (oldCat !== undefined && oldCat !== saved.cat)
      pruneEmptyCategories([oldCat]);
    changed();
    return saved;
  }
  async function categoryForm(cat) {
    const body = `<label class="field"><span>Name</span><input name="title" maxlength="40" required value="${esc(cat?.title || "")}" autocomplete="off"></label>` + colorField(cat?.color || PALETTE[2]) + iconField(cat?.glyph || "");
    const res = await dialog(cat ? "Edit category" : "New category", body, {
      ok: cat ? "Save" : "Create",
      danger: cat ? "Delete category" : null,
      onReady: (form) => {
        wireColor(form);
        wireIcon(form);
      }
    });
    if (!res)
      return;
    if (res.del && cat)
      return deleteCategory(cat);
    const f = res.form.elements;
    const title = f.title.value.trim();
    if (!title)
      return;
    const glyph = f.glyph.value || null;
    if (cat) {
      cat.title = title;
      cat.color = f.color.value;
      cat.glyph = glyph;
    } else
      profileCats().push({ id: newId(), title, color: f.color.value, glyph });
    changed();
  }
  async function addMarker(pos, temp) {
    const m = await markerForm({ pos, temp });
    if (!m)
      return;
    select(m.id, { fly: false });
    requestTool("pan");
  }
  function startMove(m) {
    moveId = m.id;
    requestTool("marker");
    toast(`Click the map to move "${m.title}". Esc cancels.`, 4000);
  }
  canvasBox.addEventListener("pointerdown", (e) => {
    if (!active || e.button !== 0)
      return;
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
        select(m.id, { fly: false, push: false });
        requestTool("pan");
      }
      return;
    }
    addMarker(pos, kind === "temp");
  });
  const markerBtn = document.getElementById("tool-marker");
  const pickMenu = document.createElement("div");
  pickMenu.id = "marker-menu";
  pickMenu.className = "menu row-menu";
  pickMenu.hidden = true;
  pickMenu.setAttribute("role", "menu");
  pickMenu.innerHTML = '<button type="button" role="menuitemradio" data-kind="perm" aria-checked="false">' + svgIcon("pin") + "<span>Permanent marker</span></button>" + '<button type="button" role="menuitemradio" data-kind="temp" aria-checked="false">' + svgIcon("tempPin") + "<span>Temporary marker</span></button>";
  function syncToolIcon() {
    markerBtn.querySelector("svg").innerHTML = ICONS[kind === "temp" ? "tempPin" : "pin"];
  }
  syncToolIcon();
  document.body.appendChild(pickMenu);
  function placeBeside(elm, rect) {
    elm.hidden = false;
    const { offsetWidth: w, offsetHeight: h } = elm, pad = 8;
    elm.style.left = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad)) + "px";
    elm.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + "px";
  }
  function openPick() {
    pickMenu.querySelectorAll("[data-kind]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.kind === kind)));
    placeBeside(pickMenu, markerBtn.getBoundingClientRect());
  }
  let holdT = null, held = false;
  markerBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0)
      return;
    held = false;
    holdT = setTimeout(() => {
      held = true;
      openPick();
    }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => markerBtn.addEventListener(t, () => {
    if (holdT)
      clearTimeout(holdT);
  }));
  markerBtn.addEventListener("click", () => {
    if (held) {
      held = false;
      return;
    }
    if (active) {
      if (pickMenu.hidden)
        openPick();
      else
        pickMenu.hidden = true;
      return;
    }
    pickMenu.hidden = true;
    requestTool("marker");
  });
  markerBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openPick();
  });
  pickMenu.onclick = (e) => {
    const b = e.target?.closest("[data-kind]");
    if (!b || !b.dataset.kind)
      return;
    kind = b.dataset.kind;
    syncToolIcon();
    pickMenu.hidden = true;
    requestTool("marker");
  };
  document.addEventListener("click", (e) => {
    if (!e.target?.closest("#marker-menu, #tool-marker"))
      pickMenu.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape")
      return;
    pickMenu.hidden = true;
    if (moveId != null) {
      moveId = null;
      toast("Move cancelled");
    }
  });
  function setActive(on) {
    active = on;
    if (!on)
      moveId = null;
    mapEl.classList.toggle("tool-marker", on);
    markerBtn.setAttribute("aria-pressed", String(on));
  }
  async function addSharedTemp(packed) {
    const d = await unpackMarker(packed);
    if (!d) {
      toast("That link does not hold a valid marker.", 5000);
      return;
    }
    const shared = d.category ? { name: d.category, color: d.color, glyph: d.glyph } : null;
    const m = {
      id: newId(),
      title: d.title,
      desc: d.desc,
      cat: TEMP_CAT_ID,
      lat: d.lat,
      lng: d.lng,
      links: d.links,
      temp: true,
      map: state.mapInfo.slug,
      shared
    };
    state.tempMarkers.push(m);
    changed();
    select(m.id, { fly: true });
    toast("Shared marker added as temporary. Make it permanent from its card.", 5000);
  }
  function menuItems(user) {
    if (!user)
      return [];
    if (user.kind === "group")
      return [{ act: "newcat", label: "New category", icon: "plus" }];
    if (user.kind === "cat" && user.id === TEMP_CAT_ID)
      return [{ act: "clear-temp", label: "Clear temporary markers", icon: "trash", danger: true }];
    if (user.kind === "cat")
      return [
        { act: "editcat", label: "Edit category", icon: "pencil" },
        { act: "delcat", label: "Delete category", icon: "trash", danger: true }
      ];
    return [];
  }
  async function menuAction(act, user) {
    if (act === "newcat")
      return categoryForm(null);
    if (act === "clear-temp") {
      const n = state.tempMarkers.length;
      const ok = await askDialog({
        title: "Clear temporary markers?",
        message: `${n} temporary marker${n === 1 ? "" : "s"} will be removed.`,
        okLabel: "Clear",
        danger: true
      });
      if (!ok)
        return;
      removeRecords(state.tempMarkers.map((m) => m.id));
      changed();
      return;
    }
    const cat = profileCats().find((c) => c.id === user.id);
    if (!cat)
      return;
    if (act === "editcat")
      return categoryForm(cat);
    if (act === "delcat")
      return deleteCategory(cat);
  }
  function detailHtml(l) {
    const links = (l.links || []).map((id) => state.byId.get(id)).filter(Boolean);
    const list = links.length ? `<div class="d-links"><h3>Links</h3><ul>${links.map((t) => `<li><a href="#loc=${t.id}" data-loc="${t.id}">${esc(t.title)}</a></li>`).join("")}</ul></div>` : "";
    const btn = (act, label, icon, danger) => `<button type="button" class="ibtn${danger ? " danger" : ""}" data-um="${act}" data-tip="${label}" aria-label="${label}">${svgIcon(icon)}</button>`;
    return `<div class="um-bar"><span class="um-badge">${l.temp ? "Temporary" : "Your marker"}</span>` + (l.temp ? btn("promote", "Make permanent", "save") : "") + btn("edit", "Edit", "pencil") + btn("move", "Move", "move") + btn("delete", "Delete", "trash", true) + "</div>" + list;
  }
  async function detailAction(act, id) {
    const m = findMarker(id);
    if (!m)
      return;
    if (act === "promote")
      await markerForm({ marker: m, promote: true });
    else if (act === "edit")
      await markerForm({ marker: m });
    else if (act === "move")
      startMove(m);
    else if (act === "delete")
      await deleteMarker(m);
  }
  return {
    setActive,
    menuItems,
    menuAction,
    detailHtml,
    detailAction,
    deleteMany,
    addSharedTemp,
    placeAt: addMarker,
    startMove
  };
}

// src/client/map/sidebar.ts
var applicable = (l) => {
  if (state.tag == null)
    return true;
  if (state.tag === UNTAGGED)
    return l.tags.length === 0;
  return l.tags.includes(state.tag) || !state.tagStrict && l.tags.length === 0;
};
var shownOnMap = (l) => applicable(l) && !state.view.hidden.has(l.cat) && !(state.view.hideFound && state.found.has(l.id));
function computeStats() {
  const st = new Map;
  for (const l of state.locs) {
    if (!applicable(l))
      continue;
    let s = st.get(l.cat);
    if (!s)
      st.set(l.cat, s = { total: 0, found: 0 });
    s.total++;
    if (state.found.has(l.id))
      s.found++;
  }
  state.stats = st;
}
var BLACK_OR_WHITE = new Set(["#000", "#000000", "#fff", "#ffffff"]);
function iconHtml(name, color) {
  const glyph = name && state.glyphs?.map[name];
  if (glyph !== undefined) {
    const tint = HEX.test(color || "") ? color : "var(--ink)";
    if (state.glyphs.image) {
      const x = typeof glyph === "number" ? 0 : glyph.x || 0;
      const y = typeof glyph === "number" ? glyph : glyph.y || 0;
      const sz = state.glyphs.size;
      const m = `url('${state.glyphs.image}') -${x}px -${y}px / ${sz}px auto no-repeat`;
      return `<span class="ico-img" style="width:${sz}px;height:${sz}px;background:${tint};-webkit-mask:${m};mask:${m}"></span>`;
    }
    const layers = (Array.isArray(glyph) ? glyph : [{ cp: glyph }]).map((l) => `<span style="color:${l.color && !BLACK_OR_WHITE.has(l.color) ? l.color : tint}${l.ml ? `;margin-left:${l.ml}` : ""}">&#x${l.cp};</span>`).join("");
    return `<span class="ico-font" style="font-family:'${state.glyphs.family}'">${layers}</span>`;
  }
  if (name && name.startsWith("ic-")) {
    const m = /^ic-(.+)-([0-9a-f]{6})$/i.exec(name), inner = m && iconInner(m[1]);
    if (inner && m)
      return `<span class="ico-glyph" style="--c:#${m[2]};--g:${glyphInk("#" + m[2])}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg></span>`;
    return `<span class="ico-ping" style="--c:#${m ? m[2] : "e5484d"}"></span>`;
  }
  if (name && name.startsWith("up-")) {
    const hex = name.slice(3).replace("-t", "");
    return `<span class="ico-ping${name.endsWith("-t") ? " temp" : ""}" style="--c:${HEX.test("#" + hex) ? "#" + hex : "#e5484d"}"></span>`;
  }
  const d = name ? state.sprite?.defs?.[name] : null;
  if (!d)
    return "";
  const s = 28 / d.height;
  return `<span class="ico" style="width:${d.width}px;height:${d.height}px;background-image:url('${state.folder}/${state.sprite.png}');` + `background-position:-${d.x}px -${d.y}px;transform:scale(${s})"></span>`;
}
function setSideCollapsed(collapsed) {
  document.body.classList.toggle("side-collapsed", collapsed);
  const b = $("#side-collapse");
  if (!b)
    return;
  b.innerHTML = collapsed ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l6 6-6 6M13 6l6 6-6 6"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6l-6 6 6 6M11 6l-6 6 6 6"/></svg>';
  const label = collapsed ? "Show panel" : "Hide panel";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-expanded", String(!collapsed));
}
var MORPH_MS = 1500;
var barSegs = new Map;
var easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
var morphing = false;
var shownCounts = null;
var countRaf = 0;
function resetShownCounts() {
  shownCounts = { found: 0, total: 0 };
}
function startMorph() {
  morphing = true;
  $("#progress-bar")?.classList.add("morph");
}
function endMorph({ later = false } = {}) {
  const done = () => {
    morphing = false;
    $("#progress-bar")?.classList.remove("morph");
  };
  if (later)
    setTimeout(done, MORPH_MS);
  else
    done();
}
function showCounts(found, total) {
  const fEl = $("#found-count"), tEl = $("#total-count");
  if (!fEl || !tEl)
    return;
  cancelAnimationFrame(countRaf);
  if (!morphing || !shownCounts) {
    shownCounts = { found, total };
    fEl.textContent = fmt(found);
    tEl.textContent = fmt(total);
    return;
  }
  const from = shownCounts, start = performance.now();
  const step = (now) => {
    const k = easeInOutCubic(Math.min(1, Math.max(0, (now - start) / MORPH_MS)));
    shownCounts = k < 1 ? {
      found: Math.round(from.found + (found - from.found) * k),
      total: Math.round(from.total + (total - from.total) * k)
    } : { found, total };
    fEl.textContent = fmt(shownCounts.found);
    tEl.textContent = fmt(shownCounts.total);
    if (k < 1)
      countRaf = requestAnimationFrame(step);
  };
  countRaf = requestAnimationFrame(step);
}
function buildSidebar() {
  const root = $("#groups");
  const bar = $("#progress-bar");
  if (!root || !bar)
    return;
  root.textContent = "";
  state.ui = { groups: new Map, cats: new Map, segs: new Map };
  for (const g of state.groups) {
    let seg = barSegs.get(g.id);
    if (!seg) {
      seg = document.createElement("div");
      seg.className = "seg";
      seg.style.flexGrow = "0.0001";
      seg.innerHTML = "<i></i>";
      barSegs.set(g.id, seg);
    }
    seg.style.setProperty("--c", g.col);
    seg.title = g.title;
    bar.appendChild(seg);
    state.ui.segs.set(g.id, seg);
    const el = document.createElement("section");
    el.className = "group" + (state.view.collapsed.has(g.id) ? " collapsed" : "");
    el.style.setProperty("--c", g.col);
    el.innerHTML = `<div class="group-head">${menuBtnHtml(g.title)}<button class="name" type="button">${esc(g.title)}</button>` + `<span class="tally"></span><input type="checkbox" class="g-toggle" aria-label="Show all in ${esc(g.title)}"></div>` + `<div class="cats"></div>`;
    const catsEl = el.querySelector(".cats");
    const gToggle = el.querySelector(".g-toggle");
    el.querySelector(".name").onclick = () => {
      el.classList.toggle("collapsed");
      el.classList.contains("collapsed") ? state.view.collapsed.add(g.id) : state.view.collapsed.delete(g.id);
      scheduleViewSave();
    };
    gToggle.onchange = () => {
      for (const c of g.cats)
        gToggle.checked ? state.view.hidden.delete(c.id) : state.view.hidden.add(c.id);
      onViewChanged();
    };
    el.querySelector(".group-head").oncontextmenu = (e) => {
      e.preventDefault();
      showOnly(g.cats.map((c) => c.id));
    };
    el.querySelector(".row-menu-btn").onclick = (e) => openRowMenu(e, { title: g.title, color: g.col, cats: g.cats, user: g.user ? { kind: "group" } : null });
    const rows = [];
    for (const c of g.cats) {
      const row = document.createElement("label");
      row.className = "cat-row";
      if (c.info)
        row.title = c.info;
      row.innerHTML = `${menuBtnHtml(c.title)}<span class="ico-wrap">${iconHtml(c.icon, c.color || g.col)}</span><span class="label">${esc(c.title)}</span><span class="tally"></span><input type="checkbox">`;
      const cb = row.querySelector("input");
      cb.id = `cat-${c.id}`;
      row.htmlFor = cb.id;
      cb.onchange = () => {
        cb.checked ? state.view.hidden.delete(c.id) : state.view.hidden.add(c.id);
        onViewChanged();
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showOnly([c.id]);
      };
      row.querySelector(".row-menu-btn").onclick = (e) => openRowMenu(e, {
        title: c.title,
        icon: c.icon,
        cats: [c],
        user: c.user ? { kind: "cat", id: c.id } : null
      });
      catsEl.appendChild(row);
      rows.push({ c, row, cb, tally: row.querySelector(".tally") });
      state.ui.cats.set(c.id, rows[rows.length - 1]);
    }
    state.ui.groups.set(g.id, { g, el, gToggle, tally: el.querySelector(".group-head .tally"), rows });
    root.appendChild(el);
  }
  for (const [id, seg] of barSegs) {
    if (state.ui.segs.has(id))
      continue;
    barSegs.delete(id);
    seg.style.flexGrow = "0.0001";
    seg.firstChild.style.width = "0";
    setTimeout(() => seg.remove(), MORPH_MS);
  }
}
var menuBtnHtml = (name) => `<button type="button" class="row-menu-btn" aria-haspopup="menu" aria-label="Actions for ${esc(name)}" title="Actions">` + '<svg viewBox="0 0 4 16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg></button>';
var rowMenuBtn = null;
function rowMenuEl() {
  let el = document.getElementById("row-menu");
  if (el)
    return el;
  el = document.createElement("div");
  el.id = "row-menu";
  el.className = "menu row-menu";
  el.hidden = true;
  el.setAttribute("role", "menu");
  el.innerHTML = '<div class="rm-head"></div><hr>' + `<button type="button" role="menuitem" data-act="found">${svgIcon("check")}<span>Mark all as found</span></button>` + `<button type="button" role="menuitem" data-act="unfound">${svgIcon("open")}<span>Mark all as not found</span></button>` + `<button type="button" role="menuitem" data-act="list">${svgIcon("list")}<span>List these markers</span></button>`;
  el.onclick = (e) => {
    const target = e.target;
    const um = target.closest("[data-um]");
    if (um) {
      const user = el._user;
      closeRowMenu();
      state.um?.menuAction(um.dataset.um, user);
      return;
    }
    const b = target.closest("button[data-act]");
    if (!b || b.disabled || !el._cats)
      return;
    if (b.dataset.act === "list") {
      const cats = el._cats;
      closeRowMenu();
      listCats(cats);
      return;
    }
    const locs = rowLocs(el._cats);
    for (const l of locs)
      b.dataset.act === "found" ? state.found.add(l.id) : state.found.delete(l.id);
    closeRowMenu();
    saveProfileNow();
    refreshAll();
  };
  document.body.appendChild(el);
  return el;
}
function rowLocs(cats) {
  const ids = new Set(cats.map((c) => c.id));
  return state.locs.filter((l) => ids.has(l.cat) && applicable(l));
}
function openRowMenu(e, {
  title,
  icon,
  color,
  cats,
  user = null
}) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget;
  const el = rowMenuEl();
  if (rowMenuBtn === btn && !el.hidden)
    return closeRowMenu();
  const locs = rowLocs(cats);
  const found = locs.filter((l) => state.found.has(l.id)).length;
  const head = icon ? `<span class="ico-wrap">${iconHtml(icon, color)}</span>` : `<span class="rm-dot" style="--c:${esc(color || "#888")}"></span>`;
  const kind = icon ? "Category" : "Group";
  el.querySelector(".rm-head").innerHTML = `${head}<div class="rm-text"><div class="rm-title">${esc(title)}</div>` + `<div class="rm-sub">${kind} · ${locs.length ? `${found}/${locs.length} found` : "No markers shown"}</div></div>`;
  el._cats = cats;
  el._user = user;
  el.querySelectorAll("button[data-act]").forEach((b) => {
    b.disabled = locs.length === 0;
  });
  el.querySelectorAll("[data-um]").forEach((b) => b.remove());
  for (const it of state.um?.menuItems(user) || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.dataset.um = it.act;
    b.innerHTML = svgIcon(it.icon) + `<span>${esc(it.label)}</span>`;
    if (it.danger)
      b.className = "danger";
    el.appendChild(b);
  }
  rowMenuBtn = btn;
  btn.setAttribute("aria-expanded", "true");
  el.hidden = false;
  const r = btn.getBoundingClientRect(), pad = 8;
  const { offsetWidth: w, offsetHeight: h } = el;
  let left = r.right + 8;
  if (left + w > innerWidth - pad)
    left = Math.max(pad, r.left - w - 8);
  el.style.left = left + "px";
  el.style.top = Math.max(pad, Math.min(r.top, innerHeight - h - pad)) + "px";
}
function closeRowMenu() {
  const el = document.getElementById("row-menu");
  if (el) {
    el.hidden = true;
    el._cats = null;
  }
  if (rowMenuBtn)
    rowMenuBtn.setAttribute("aria-expanded", "false");
  rowMenuBtn = null;
}
function showOnly(ids) {
  const keep = new Set(ids);
  for (const id of state.cats.keys())
    keep.has(id) ? state.view.hidden.delete(id) : state.view.hidden.add(id);
  onViewChanged();
}
function listCats(cats) {
  showOnly(cats.map((c) => c.id));
  const search = $("#search");
  if (search)
    search.value = "*";
  runSearch();
}
function updateSidebar() {
  if (!state.ui)
    return;
  computeStats();
  let total = 0, found = 0;
  for (const { g, gToggle, tally, rows } of state.ui.groups.values()) {
    let gt = 0, gf = 0, shown = 0, visibleRows = 0;
    for (const { c, row, cb, tally: t } of rows) {
      const s = state.stats.get(c.id) || { total: 0, found: 0 };
      row.hidden = s.total === 0;
      cb.checked = !state.view.hidden.has(c.id);
      row.classList.toggle("off", !cb.checked);
      t.textContent = `${s.found}/${s.total}`;
      t.classList.toggle("done", s.total > 0 && s.found === s.total);
      if (s.total) {
        visibleRows++;
        if (cb.checked)
          shown++;
      }
      gt += s.total;
      gf += s.found;
    }
    tally.textContent = `${gf}/${gt}`;
    gToggle.checked = visibleRows > 0 && shown === visibleRows;
    gToggle.indeterminate = shown > 0 && shown < visibleRows;
    gToggle.hidden = visibleRows === 0;
    const seg = state.ui.segs.get(g.id);
    seg.style.flexGrow = String(Math.max(gt, 0.0001));
    seg.firstChild.style.width = gt ? 100 * gf / gt + "%" : "0";
    total += gt;
    found += gf;
  }
  showCounts(found, total);
  saveSessionSoon();
}
var sessionTimer;
function saveSessionSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 400);
}
function saveSession() {
  clearTimeout(sessionTimer);
  if (!state.entry || !state.mapInfo || !state.ui)
    return;
  try {
    const groups = [];
    for (const { g, rows } of state.ui.groups.values()) {
      let n = 0, f = 0;
      for (const { c } of rows) {
        const s = state.stats.get(c.id);
        if (s) {
          n += s.total;
          f += s.found;
        }
      }
      if (n)
        groups.push({ t: g.title, c: g.col, f, n });
    }
    const near = [];
    for (const [id, s] of state.stats) {
      if (s.total < 2 || s.found >= s.total || !s.found)
        continue;
      const c = state.cats.get(id);
      if (!c)
        continue;
      near.push({ t: c.title, c: state.groupOfCat?.get(id)?.col || null, f: s.found, n: s.total });
    }
    const score = (item) => item.f / item.n * (1 - 1 / Math.sqrt(item.n + 1));
    near.sort((a, b) => score(b) - score(a) || b.f / b.n - a.f / a.n || b.n - a.n);
    const recent = [];
    for (const id of [...state.found].reverse()) {
      const l = state.byId.get(id);
      if (!l)
        continue;
      const c = state.cats.get(l.cat);
      recent.push({
        t: l.title || c?.title || "Marker",
        cat: c?.title || "",
        c: state.groupOfCat?.get(l.cat)?.col || null
      });
      if (recent.length >= 4)
        break;
    }
    const map = state.mapInfo.slug;
    const tag = state.tag === UNTAGGED ? "Only untagged" : state.tags.find((t) => t.id === state.tag)?.title || null;
    const visited = new Set(Object.keys(state.profile?.cameras || {}));
    const allMaps = (state.meta?.maps || []).map((m) => ({ slug: m.slug, title: m.title || m.slug }));
    allMaps.sort((a, b) => (visited.has(b.slug) ? 1 : 0) - (visited.has(a.slug) ? 1 : 0));
    const snap = {
      v: 1,
      slug: state.entry.slug,
      updated: Date.now(),
      map,
      mapTitle: state.mapInfo.title || map,
      maps: allMaps,
      profile: state.profile?.name || null,
      profileId: state.profile?.id || null,
      profiles: (state.profiles || []).map((p) => ({ id: p.id, name: p.name })),
      tagLabel: state.entry.tagLabel || null,
      tag,
      found: groups.reduce((a, g) => a + g.f, 0),
      total: groups.reduce((a, g) => a + g.n, 0),
      groups,
      near: near.slice(0, 5),
      recent,
      userMarkers: (state.profile?.userMarkers || []).filter((m) => m.map === map).length,
      drawings: (state.profile?.drawings || []).filter((d) => d.map === map).length,
      presets: state.presets.length
    };
    localStorage.setItem("va_last_session", JSON.stringify(snap));
  } catch {}
}
function onViewChanged() {
  scheduleViewSave();
  updateSidebar();
  refreshMap();
  renderPresets();
  if (state.search.active)
    runSearch();
}
var USER_GROUP = "user-markers";
var iconFor = (c) => c.glyph ? `ic-${c.glyph}-${String(c.color).replace("#", "")}` : iconName(c.color, c.temp);
var iconName = (color, temp) => `up-${color.replace("#", "")}${temp ? "-t" : ""}`;
function rebuildUserData() {
  if (!state.officialLocs)
    return;
  const p = state.profile, here = state.mapInfo?.slug, temps = state.tempMarkers.filter((m) => m.map === here);
  const cats = [...p?.userCats || []];
  if (temps.length)
    cats.push(TEMP_CAT);
  for (const id of [...state.cats.keys()])
    if (id < 0)
      state.cats.delete(id);
  if (cats.some((c) => c.glyph) && !iconsReady())
    loadIconLibrary().then(() => {
      rebuildUserData();
      refreshAll();
    }).catch(() => {});
  state.groups = state.groups.filter((g) => g.id !== USER_GROUP);
  if (cats.length) {
    const made = cats.map((c, i) => {
      const cat = {
        id: c.id,
        title: c.title,
        group_id: USER_GROUP,
        order: 1000 + i,
        icon: iconFor(c),
        user: true
      };
      state.cats.set(c.id, cat);
      return cat;
    });
    state.groups.push({ id: USER_GROUP, title: "User markers", col: "var(--accent-soft)", user: true, cats: made });
  }
  state.groupOfCat = new Map;
  for (const g of state.groups)
    for (const c of g.cats)
      state.groupOfCat.set(c.id, g);
  const userLocs = [...(p?.userMarkers || []).filter((m) => m.map === here), ...temps].map((m) => {
    const cat = state.cats.get(m.cat);
    return {
      id: m.id,
      cat: m.cat,
      title: m.title || "",
      desc: m.desc || "",
      lat: m.lat,
      lng: m.lng,
      tags: [],
      media: [],
      icon: cat?.icon || iconName("#e5484d"),
      user: true,
      temp: !!m.temp,
      links: m.links || []
    };
  });
  state.locs = [...state.officialLocs, ...userLocs];
  state.byId = new Map(state.locs.map((l) => [l.id, l]));
  state.outLinks = new Map;
  state.inLinks = new Map;
  buildLinkIndex();
  if (state.ui)
    buildSidebar();
}
function userChanged() {
  rebuildUserData();
  scheduleSave();
  refreshAll();
}
function arrangeSidebar() {
  const head = document.querySelector("#side .side-head");
  if (!head || head.nextElementSibling?.classList.contains("side-scroll"))
    return;
  const scroll = document.createElement("div");
  scroll.className = "side-scroll";
  for (const el of [...head.children])
    if (!el.matches(".title-row, .progress"))
      scroll.appendChild(el);
  for (const sel of [".list-tools", "#results-bar", "#results", "#groups"]) {
    const el = document.querySelector("#side " + sel);
    if (el)
      scroll.appendChild(el);
  }
  head.after(scroll);
}
function setupTitleRow() {
  const row = document.querySelector("#side .title-row");
  if (!row || row.querySelector(".side-top-tools"))
    return;
  row.querySelector(".home-link")?.remove();
  const tools = document.createElement("div");
  tools.className = "side-top-tools";
  tools.innerHTML = `<div class="side-more" id="side-more">` + `<button id="side-more-btn" class="icon-btn side-more-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Menu" aria-label="Menu">` + `<svg class="dots" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>` + `</button>` + `<div id="side-more-menu" class="menu side-more-menu" hidden>` + `<a class="side-menu-link" href="../../">` + `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10.5 9-7.5 9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-4.5h-2v4.5A1.5 1.5 0 0 1 7.5 21h-5A1.5 1.5 0 0 1 1 19.5v-9z"/></svg>` + `<span>All maps</span>` + `</a>` + `<hr>` + `<div class="side-menu-theme">` + `<span class="side-menu-label">Theme</span>` + `</div>` + `</div>` + `</div>` + `<button id="side-drawer-close" class="side-drawer-close" type="button" title="Close panel" aria-label="Close panel">` + `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>` + `</button>`;
  tools.querySelector(".side-menu-theme")?.appendChild(themeToggle("side-dropdown-theme"));
  row.appendChild(tools);
  const moreBtn = tools.querySelector("#side-more-btn");
  const moreMenu = tools.querySelector("#side-more-menu");
  const closeBtn = tools.querySelector("#side-drawer-close");
  moreBtn.onclick = (e) => {
    e.stopPropagation();
    const open = !moreMenu.hidden;
    moreMenu.hidden = open;
    moreBtn.setAttribute("aria-expanded", String(!open));
  };
  closeBtn.onclick = () => document.body.classList.remove("side-open");
}

// src/client/map/profiles.ts
var HEX = /^#[0-9a-f]{6}$/i;
var GLYPH = /^[a-z0-9-]{1,60}$/;
var DRAW_KINDS = ["pen", "highlighter", "line", "arrow", "path", "rect", "ellipse", "text"];
var finite = (v) => Number.isFinite(v) ? v : undefined;
var clip = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
function syncTagStrict() {
  const btn = $("#tag-strict");
  const row = $("#tag-row");
  if (row)
    row.hidden = !state.tags.length;
  if (!btn)
    return;
  btn.setAttribute("aria-pressed", String(tagOnly()));
  btn.setAttribute("aria-disabled", String(!tagSwitchUsable()));
}
function wireTagStrict() {
  let pressTimer;
  let tipTimer;
  let held = false;
  const showTip = (btn) => {
    btn.classList.add("tip");
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => btn.classList.remove("tip"), 1800);
  };
  const btn = $("#tag-strict");
  if (!btn)
    return;
  btn.addEventListener("pointerdown", (e) => {
    held = false;
    if (e.pointerType === "mouse")
      return;
    pressTimer = setTimeout(() => {
      held = true;
      showTip(btn);
    }, 450);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => btn.addEventListener(t, () => clearTimeout(pressTimer)));
  btn.addEventListener("click", () => {
    if (held) {
      held = false;
      return;
    }
    if (!tagSwitchUsable()) {
      showTip(btn);
      return;
    }
    state.tagStrict = !state.tagStrict;
    syncTagStrict();
    scheduleViewSave();
    refreshAll();
  });
}
function makeProfile(name, tag) {
  const id = uid();
  return {
    key: `${state.entry.id}:${id}`,
    id,
    game: state.entry.id,
    name,
    tag,
    found: [],
    created: Date.now(),
    updated: Date.now()
  };
}
async function loadProfiles() {
  state.profiles = (await dbAll("profiles")).filter((p) => p.game === state.entry.id).sort((a, b) => a.created - b.created);
  if (!state.profiles.length) {
    const p = makeProfile("Default", null);
    await dbPut("profiles", p);
    state.profiles = [p];
  }
  const wantProfile = new URLSearchParams(location.search).get("profile");
  const last = wantProfile || await getMeta("last-profile:" + state.entry.id);
  applyProfile(state.profiles.find((p) => p.id === last || p.name === last) || state.profiles[0]);
  if (wantProfile && state.profile)
    setMeta("last-profile:" + state.entry.id, state.profile.id);
}
function cleanUserData(p) {
  const firstMap = state.meta?.maps?.[0]?.slug || "";
  const list = (v) => Array.isArray(v) ? v : [];
  p.userCats = list(p.userCats).filter((c) => c && finite(c.id) !== undefined).map((c) => ({
    id: c.id,
    title: clip(c.title, 40) || "Category",
    color: HEX.test(c.color) ? c.color : "#e5484d",
    glyph: GLYPH.test(c.glyph || "") ? c.glyph : null
  }));
  p.userMarkers = list(p.userMarkers).filter((m) => m && finite(m.id) !== undefined && finite(m.lat) !== undefined && finite(m.lng) !== undefined).map((m) => ({
    id: m.id,
    cat: finite(m.cat) ?? null,
    title: clip(m.title, 80) || "Marker",
    desc: clip(m.desc, 5000),
    lat: m.lat,
    lng: m.lng,
    links: list(m.links).filter((id) => finite(id) !== undefined).slice(0, 200),
    map: clip(m.map, 80) || firstMap,
    created: finite(m.created) ?? Date.now()
  }));
  p.drawings = list(p.drawings).filter((d) => d && DRAW_KINDS.includes(d.kind) && Array.isArray(d.pts) && d.pts.length && d.pts.every((q) => q && finite(q.lng) !== undefined && finite(q.lat) !== undefined)).slice(0, 5000).map((d) => ({
    id: clip(d.id, 40) || uid(),
    kind: d.kind,
    color: HEX.test(d.color) ? d.color : "#e5484d",
    size: ["s", "m", "l"].includes(d.size) ? d.size : "m",
    pts: d.pts.slice(0, 5000).map((q) => ({ lng: q.lng, lat: q.lat })),
    circle: !!d.circle,
    text: clip(d.text, 2000),
    z: finite(d.z),
    map: clip(d.map, 80) || firstMap
  }));
  const cams = {};
  if (p.cameras && typeof p.cameras === "object") {
    for (const [k, c] of Object.entries(p.cameras)) {
      if (c && finite(c.lng) !== undefined && finite(c.lat) !== undefined && finite(c.zoom) !== undefined) {
        cams[clip(k, 80)] = { lng: c.lng, lat: c.lat, zoom: c.zoom };
      }
    }
  }
  p.cameras = cams;
  p.map = clip(p.map, 80) || null;
  p.found = list(p.found).filter((id) => finite(id) !== undefined);
  return p;
}
function applyProfile(p) {
  cleanUserData(p);
  state.profile = p;
  const first = state.meta?.maps?.[0]?.slug;
  if (first) {
    for (const d of p.drawings || [])
      d.map ??= first;
    for (const m of p.userMarkers || [])
      m.map ??= first;
  }
  rebuildUserData();
  state.drawing?.reset();
  state.found = new Set(p.found || []);
  renderProfileSelect();
  syncTagStrict();
}
function renderProfileSelect() {
  const sel = $("#profile-select");
  if (!sel || !state.profile)
    return;
  sel.innerHTML = state.profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  sel.value = state.profile.id;
}
var saveTimer;
var savePending = false;
var isSavePending = () => savePending;
function scheduleSave() {
  clearTimeout(saveTimer);
  savePending = true;
  saveTimer = setTimeout(saveProfileNow, 200);
}
async function saveProfileNow() {
  clearTimeout(saveTimer);
  savePending = false;
  const p = state.profile;
  if (!p)
    return;
  p.found = [...state.found];
  p.updated = Date.now();
  try {
    await dbPut("profiles", p);
    syncNote();
  } catch (e) {
    console.error(e);
    toast("Could not save progress in this browser.");
  }
}
var viewTimer;
function scheduleViewSave() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    const p = state.profile, slug = state.mapInfo?.slug;
    if (!p || !slug)
      return;
    p.view = {
      ...p.view || {},
      [slug]: {
        hidden: [...state.view.hidden],
        hideFound: state.view.hideFound,
        collapsed: [...state.view.collapsed],
        presetId: state.presetId,
        baseline: state.baseline,
        tag: state.tag,
        tagStrict: state.tagStrict
      }
    };
    scheduleSave();
  }, 250);
}
var VEIL_OUT_MS = 350;
var VEIL_IN_MS = 1500;
var veil = 1;
var veilRaf = 0;
var veilDone = null;
function setVeil(v) {
  veil = v;
  const clear = v >= 1;
  if (state.mapReady && state.map.getLayer("locs")) {
    state.map.setPaintProperty("locs", "icon-opacity", clear ? ["case", ["==", ["get", "f"], 1], 0.4, 1] : ["*", ["case", ["==", ["get", "f"], 1], 0.4, 1], v]);
    if (state.map.getLayer("hover-loc"))
      state.map.setPaintProperty("hover-loc", "icon-opacity", v);
  }
  for (const el of document.querySelectorAll("#map .draw-layer, #map .text-layer")) {
    el.style.transition = clear ? "" : "none";
    el.style.opacity = clear ? "" : String(v);
  }
}
function tweenVeil(to, ms) {
  return new Promise((resolve) => {
    cancelAnimationFrame(veilRaf);
    veilDone?.();
    veilDone = resolve;
    const from = veil, start = performance.now();
    const step = (now) => {
      const k = easeInOutCubic(Math.min(1, Math.max(0, (now - start) / ms)));
      setVeil(from + (to - from) * k);
      if (k < 1)
        veilRaf = requestAnimationFrame(step);
      else {
        veilDone = null;
        resolve();
      }
    };
    veilRaf = requestAnimationFrame(step);
  });
}
async function switchProfile(id) {
  rememberCamera(false);
  await saveProfileNow();
  const p = state.profiles.find((x) => x.id === id);
  if (!p)
    return;
  closeDetail();
  document.body.classList.add("profile-switch");
  startMorph();
  await tweenVeil(0, VEIL_OUT_MS);
  applyProfile(p);
  await loadMapState();
  await syncMapToProfile();
  await setMeta("last-profile:" + state.entry.id, p.id).catch(() => {});
  refreshAll();
  endMorph({ later: true });
  document.body.classList.remove("profile-switch");
  await tweenVeil(1, VEIL_IN_MS);
}
async function profileAction(act) {
  const p = state.profile;
  if (act === "new") {
    const name = await askDialog({
      title: "New profile",
      message: "One profile per save file keeps found markers separate.",
      value: `Playthrough ${state.profiles.length + 1}`,
      okLabel: "Create"
    });
    if (!name)
      return;
    await saveProfileNow();
    const np = makeProfile(name, state.tag);
    await dbPut("profiles", np);
    state.profiles.push(np);
    await switchProfile(np.id);
  } else if (act === "rename") {
    const name = await askDialog({ title: "Rename profile", value: p.name, okLabel: "Rename" });
    if (!name)
      return;
    p.name = name;
    await saveProfileNow();
    renderProfileSelect();
  } else if (act === "reset") {
    const ok = await askDialog({
      title: "Clear found markers?",
      message: `Every marker in "${p.name}" will be unmarked.`,
      okLabel: "Clear",
      danger: true
    });
    if (!ok)
      return;
    state.found.clear();
    await saveProfileNow();
    refreshAll();
  } else if (act === "delete") {
    const ok = await askDialog({
      title: "Delete profile?",
      message: `"${p.name}" and its found markers will be removed from this browser.`,
      okLabel: "Delete",
      danger: true
    });
    if (!ok)
      return;
    await dbDelete("profiles", p.key);
    state.profiles = state.profiles.filter((x) => x.id !== p.id);
    if (!state.profiles.length) {
      const np = makeProfile("Default", null);
      await dbPut("profiles", np);
      state.profiles.push(np);
    }
    state.profile = null;
    applyProfile(state.profiles[0]);
    await loadMapState();
    await setMeta("last-profile:" + state.entry.id, state.profile.id).catch(() => {});
    refreshAll();
  } else if (act === "export") {
    await saveProfileNow();
    const presets = state.presets.map((q) => ({ id: q.id, name: q.name, hidden: q.hidden }));
    const payload = {
      app: "offline-map-viewer",
      version: 1,
      game: state.entry.id,
      exported: new Date().toISOString(),
      profiles: state.profiles.map(({ id, name, tag, found, created, updated, map, cameras, drawings, userCats, userMarkers }) => ({
        id,
        name,
        tag,
        found,
        created,
        updated,
        map: map ?? null,
        cameras: cameras || {},
        drawings: drawings || [],
        userCats: userCats || [],
        userMarkers: userMarkers || []
      })),
      presets
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
    a.download = `${state.entry.id}-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } else if (act === "import") {
    $("#import-file")?.click();
  }
}
async function importFile(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== "offline-map-viewer" || !Array.isArray(payload.profiles))
      throw new Error("not a progress file");
    if (payload.game !== state.entry.id)
      throw new Error(`this file is for "${payload.game}", not "${state.entry.id}"`);
    const profs = payload.profiles.filter((q) => q && q.id && Array.isArray(q.found));
    const pres = (Array.isArray(payload.presets) ? payload.presets : []).filter((p) => p && p.id && Array.isArray(p.hidden));
    const conflicts = [];
    for (const q of profs) {
      if (state.profiles.some((p) => p.id === q.id || p.name === String(q.name || ""))) {
        conflicts.push({ key: "p:" + q.id, label: `Profile "${q.name || "Imported"}"` });
      }
    }
    for (const p of pres) {
      if (state.presets.some((x) => x.id === String(p.id) || x.name === String(p.name || ""))) {
        conflicts.push({ key: `s:${p.id}`, label: `Preset "${p.name || "Imported"}"` });
      }
    }
    let decisions = new Map;
    if (conflicts.length) {
      decisions = await chooseConflicts(conflicts);
      if (!decisions)
        return;
    } else {
      const ok = await askDialog({
        title: "Import progress?",
        message: `${profs.length} profile(s) and ${pres.length} preset(s) will be added.`,
        okLabel: "Import"
      });
      if (!ok)
        return;
    }
    await saveProfileNow();
    const takenNames = new Set(state.profiles.map((p) => p.name));
    for (const q of profs) {
      let id = q.id, name = String(q.name || "Imported");
      const d = decisions.get("p:" + q.id);
      if (d === "rename") {
        id = uid();
        name = uniqueName(name, takenNames);
      }
      if (d === "overwrite") {
        const gone = state.profiles.filter((p) => p.id === q.id || p.name === name);
        for (const old of gone)
          await dbDelete("profiles", old.key);
        state.profiles = state.profiles.filter((p) => !gone.includes(p));
      }
      takenNames.add(name);
      const rec = cleanUserData({
        key: `${state.entry.id}:${id}`,
        id,
        game: state.entry.id,
        name: clip(name, 60) || "Imported",
        tag: typeof q.tag === "string" ? q.tag : null,
        found: q.found,
        drawings: q.drawings,
        userCats: q.userCats,
        userMarkers: q.userMarkers,
        map: q.map,
        cameras: q.cameras,
        created: finite(q.created) ?? Date.now(),
        updated: Date.now()
      });
      await dbPut("profiles", rec);
      const at = state.profiles.findIndex((x) => x.id === rec.id);
      if (at >= 0)
        state.profiles[at] = rec;
      else
        state.profiles.push(rec);
    }
    const list = [...state.presets];
    for (const p of pres) {
      let id = String(p.id), name = String(p.name || "Imported");
      const d = decisions.get(`s:${p.id}`);
      if (d === "overwrite") {
        const at = list.findIndex((x) => x.id === id || x.name === name);
        if (at >= 0)
          list.splice(at, 1);
      } else if (d === "rename") {
        id = uid();
        name = uniqueName(name, new Set(list.map((x) => x.name)));
      }
      list.push({ id, name, hidden: p.hidden.filter(Number.isFinite) });
    }
    state.presets = list;
    await savePresets();
    const cur = state.profiles.find((x) => x.id === state.profile.id) || state.profiles[0];
    applyProfile(cur);
    await loadMapState();
    await syncMapToProfile();
    refreshAll();
    renderPresets();
    toast("Progress imported.");
  } catch (e) {
    toast("Import failed: " + e.message, 5000);
  }
}
function uniqueName(base, taken) {
  let name = `${base} - copy`, n = 2;
  while (taken.has(name))
    name = `${base} - copy ${n++}`;
  taken.add(name);
  return name;
}
function chooseConflicts(items) {
  return new Promise((resolve) => {
    const d = $("#dlg");
    const form = $("#dlg-form");
    const rows = items.map((it, i) => `<fieldset class="conflict"><legend>${esc(it.label)}</legend>` + `<label><input type="radio" name="c${i}" value="rename" checked> Keep both</label>` + `<label><input type="radio" name="c${i}" value="overwrite"> Overwrite the existing one</label></fieldset>`).join("");
    form.innerHTML = `<h2>Some items already exist</h2>` + `<p>Keeping both imports a copy under a new name ("- copy" is added).</p>` + `<div class="bulk"><button type="button" data-all="rename">Keep all</button><button type="button" data-all="overwrite">Overwrite all</button></div>` + `<div class="conflicts um">${rows}</div>` + `<div class="dlg-actions"><button type="button" data-cancel>Cancel</button><button class="primary">Import</button></div>`;
    d.classList.add("um");
    const finish = (r) => {
      d.classList.remove("um");
      if (d.open)
        d.close();
      resolve(r);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = new Map;
      items.forEach((it, i) => out.set(it.key, form.elements.namedItem(`c${i}`).value));
      finish(out);
    };
    form.querySelectorAll("[data-all]").forEach((b) => b.onclick = () => {
      items.forEach((_, i) => {
        const input = form.querySelector(`input[name="c${i}"][value="${b.dataset.all}"]`);
        if (input)
          input.checked = true;
      });
    });
    form.querySelector("[data-cancel]").onclick = () => finish(null);
    d.oncancel = () => finish(null);
    d.showModal();
  });
}

// src/client/map/presets.ts
var perMap = (prefix, map) => prefix + state.entry.id + (map === state.meta.maps[0].slug ? "" : ":" + map);
var viewKey = (map) => perMap("view:", map);
var presetsKey = () => "presets:" + state.entry.id;
async function migratePresets() {
  const flag = "presets-per-game:" + state.entry.id;
  if (await getMeta(flag))
    return;
  const merged = [...await getMeta(presetsKey()) || []];
  const names = new Set(merged.map((p) => p.name));
  for (const m of state.meta.maps) {
    if (m.slug === state.meta.maps[0].slug)
      continue;
    for (const p of await getMeta(perMap("presets:", m.slug)) || []) {
      if (merged.some((x) => x.id === p.id))
        continue;
      merged.push({ ...p, name: names.has(p.name) ? uniqueName(p.name, names) : p.name });
      names.add(merged[merged.length - 1].name);
    }
  }
  await setMeta(presetsKey(), merged);
  await setMeta(flag, true);
}
async function loadMapState() {
  const map = state.mapInfo.slug;
  const v = state.profile?.view?.[map] || await getMeta(viewKey(map)) || {};
  state.view.hidden = new Set(v.hidden || []);
  state.view.hideFound = !!v.hideFound;
  state.view.collapsed = new Set(v.collapsed || []);
  const hideFoundEl = $("#hide-found");
  if (hideFoundEl)
    hideFoundEl.checked = state.view.hideFound;
  const t = "tag" in v ? v.tag : state.profile?.tag ?? null;
  state.tag = t === UNTAGGED || state.tags.length && state.tags.some((x) => x.id === t) ? t : null;
  state.tagStrict = state.tag != null && state.tag !== UNTAGGED && !!("tagStrict" in v ? v.tagStrict : state.profile?.tagStrict);
  const tagSelectEl = $("#tag-select");
  if (state.tags.length && tagSelectEl)
    tagSelectEl.value = state.tag == null ? "" : String(state.tag);
  syncTagStrict();
  state.presets = await getMeta(presetsKey()) || [];
  state.presetId = state.presets.some((p) => p.id === v.presetId) ? v.presetId : null;
  state.baseline = state.presetId && Array.isArray(v.baseline) ? v.baseline : null;
  renderPresets();
}
var savePresets = () => setMeta(presetsKey(), state.presets).catch(() => toast("Could not save presets in this browser."));
var presetById = (id) => state.presets.find((p) => p.id === id) || null;
var currentPreset = () => presetById(state.presetId);
var tagSwitchUsable = () => state.tag != null && state.tag !== UNTAGGED;
var tagOnly = () => tagSwitchUsable() && !!state.tagStrict;
function renderedCatIds() {
  const ids = new Set;
  for (const l of state.locs)
    if (applicable(l))
      ids.add(l.cat);
  return ids;
}
function selectedIn(hiddenIds) {
  const h = new Set(hiddenIds), rendered = tagOnly() ? renderedCatIds() : null;
  return new Set([...state.cats.keys()].filter((id) => !h.has(id) && (!rendered || rendered.has(id))));
}
function presetHidden(hiddenIds) {
  if (!tagOnly())
    return [...hiddenIds];
  const sel = selectedIn(hiddenIds);
  return [...state.cats.keys()].filter((id) => !sel.has(id));
}
function matchesView(p) {
  const a = selectedIn(p.hidden), b = selectedIn(state.view.hidden);
  if (a.size !== b.size)
    return false;
  for (const id of a)
    if (!b.has(id))
      return false;
  return true;
}
function syncPresetSelection() {
  const cur = currentPreset();
  if (cur && matchesView(cur))
    return;
  if (!cur)
    state.presetId = null;
  const same = state.presets.find(matchesView);
  if (same)
    state.presetId = same.id;
}
function applyPreset(p) {
  if (!state.presetId)
    state.baseline = [...state.view.hidden];
  state.presetId = p.id;
  state.view.hidden = new Set(p.hidden);
  onViewChanged();
}
function exitPreset() {
  if (state.baseline)
    state.view.hidden = new Set(state.baseline);
  state.presetId = null;
  state.baseline = null;
  updateSidebar();
  refreshMap();
  scheduleViewSave();
  renderPresets({ sync: false });
}
function renderPresets({ sync = true } = {}) {
  if (!state.entry)
    return;
  if (sync)
    syncPresetSelection();
  if (!state.presetId)
    state.baseline = null;
  const cur = currentPreset();
  const modified = !!cur && !matchesView(cur);
  const sel = $("#preset-select");
  if (sel) {
    const first = cur ? "No preset" : "Choose a preset…";
    sel.innerHTML = `<option value="">${first}</option>` + state.presets.map((p) => {
      const sel1 = p.id === state.presetId;
      const dot = sel1 && modified ? "modified" : "clean";
      return `<option value="${esc(p.id)}"${sel1 && modified ? ' class="modified"' : ""}>` + `<span class="dot ${dot}"></span>${esc(p.name)}</option>`;
    }).join("");
    sel.value = state.presetId ?? "";
    sel.classList.toggle("modified", modified);
    sel.classList.toggle("has-status", !!cur);
  }
  const status = $("#preset-status");
  if (status) {
    status.hidden = !cur;
    status.className = "dot preset-status " + (modified ? "modified" : "clean");
  }
  const bar = $("#preset-bar");
  if (bar)
    bar.hidden = !modified;
  document.querySelectorAll("#preset-menu [data-needs-preset]").forEach((b) => {
    b.disabled = !cur;
  });
}
async function presetAction(act) {
  if (act === "save") {
    const name = await askDialog({
      title: "Save selection",
      message: "Stores which categories are on and off.",
      value: `Selection ${state.presets.length + 1}`,
      okLabel: "Save"
    });
    if (!name)
      return;
    const np = { id: uid(), name, hidden: presetHidden(state.view.hidden) };
    state.presets.push(np);
    state.presetId = np.id;
    await savePresets();
    renderPresets();
    toast("Preset saved.");
    return;
  }
  const p = currentPreset();
  if (!p)
    return;
  if (act === "overwrite") {
    p.hidden = [...p.hidden.filter((id) => !state.cats.has(id)), ...presetHidden(state.view.hidden)];
    await savePresets();
    renderPresets();
    toast("Preset overwritten.");
  } else if (act === "revert") {
    applyPreset(p);
  } else if (act === "rename") {
    const name = await askDialog({ title: "Rename preset", value: p.name, okLabel: "Rename" });
    if (!name)
      return;
    p.name = name;
    await savePresets();
    renderPresets();
  } else if (act === "delete") {
    const ok = await askDialog({
      title: "Delete preset?",
      message: `"${p.name}" will be removed from this browser.`,
      okLabel: "Delete",
      danger: true
    });
    if (!ok)
      return;
    state.presets = state.presets.filter((x) => x.id !== p.id);
    await savePresets();
    exitPreset();
  }
}

// src/client/map/selection.ts
var SHAPE_NAMES = { box: "Box select", ellipse: "Ellipse select", free: "Free select" };
var SHAPE_ICONS = {
  box: '<rect x="4" y="6" width="16" height="12" rx="1" stroke-dasharray="2.5 2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6" stroke-dasharray="2.5 2"/>',
  free: '<path d="M5 9c1.5-3 5-4 7-2s4-1.5 6 .5 1 6-2 6.5-3-2-5 0-4 2.5-6 1-4.5-.5-3-3.5z" stroke-dasharray="2.5 2"/>'
};
var HAND_ICON = '<path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/>' + '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>';
function geomOf(s, to) {
  if (s.shape === "free")
    return { shape: "free", pts: s.pts.map(to) };
  const [a, b] = s.pts.map(to);
  if (s.shape === "box")
    return {
      shape: "box",
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y)
    };
  if (s.circle) {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    return { shape: "ellipse", cx: a.x, cy: a.y, rx: r, ry: r };
  }
  return { shape: "ellipse", cx: a.x, cy: a.y, rx: Math.abs(b.x - a.x), ry: Math.abs(b.y - a.y) };
}
function insideGeom(g, x, y) {
  if (g.shape === "box")
    return x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
  if (g.shape === "ellipse")
    return g.rx > 0 && g.ry > 0 && ((x - g.cx) / g.rx) ** 2 + ((y - g.cy) / g.ry) ** 2 <= 1;
  let inside = false;
  const p = g.pts;
  for (let i = 0, j = p.length - 1;i < p.length; j = i++) {
    if (p[i].y > y !== p[j].y > y && x < (p[j].x - p[i].x) * (y - p[i].y) / (p[j].y - p[i].y) + p[i].x)
      inside = !inside;
  }
  return inside;
}
function inSelection(pt) {
  if (!state.sel)
    return false;
  const g = geomOf(state.sel, (p) => state.map.project([p.lng, p.lat]));
  return insideGeom(g, pt.x, pt.y);
}
function setupSelection(map) {
  const canvasBox = map.getCanvasContainer();
  const mapEl = map.getContainer();
  const proj = (q) => map.project([q.lng, q.lat]);
  const localPos = (e) => {
    const r = canvasBox.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  map.addControl({
    onAdd() {
      const c = document.createElement("div");
      c.className = "maplibregl-ctrl maplibregl-ctrl-group tool-ctrl";
      c.innerHTML = `<button type="button" id="tool-pan" title="Move the map" aria-label="Move the map">` + `<svg viewBox="0 0 24 24" aria-hidden="true">${HAND_ICON}</svg></button>` + `<button type="button" id="tool-select" class="notched" title="Select markers. Right-click or hold for shapes" aria-label="Selection tool">` + `<svg viewBox="0 0 24 24" aria-hidden="true"></svg></button>` + DRAW_CONTROLS_HTML + INK_CONTROL_HTML;
      return c;
    },
    onRemove() {}
  }, "top-right");
  map.addControl({
    onAdd() {
      const c = document.createElement("div");
      c.className = "maplibregl-ctrl maplibregl-ctrl-group tool-ctrl";
      c.innerHTML = MARKER_CONTROL_HTML;
      return c;
    },
    onRemove() {}
  }, "top-right");
  map.addControl({
    onAdd() {
      const c = document.createElement("div");
      c.className = "maplibregl-ctrl maplibregl-ctrl-group tool-ctrl";
      c.innerHTML = CAPTURE_CONTROL_HTML;
      return c;
    },
    onRemove() {}
  }, "top-right");
  const panBtn = document.getElementById("tool-pan");
  const selBtn = document.getElementById("tool-select");
  const shapeMenu = document.createElement("div");
  shapeMenu.id = "shape-menu";
  shapeMenu.className = "menu row-menu";
  shapeMenu.hidden = true;
  shapeMenu.setAttribute("role", "menu");
  shapeMenu.innerHTML = Object.entries(SHAPE_NAMES).map(([k, v]) => `<button type="button" role="menuitemradio" data-shape="${k}" aria-checked="false">${svgIcon(k)}<span>${v}</span></button>`).join("");
  document.body.appendChild(shapeMenu);
  const selMenu = document.createElement("div");
  selMenu.id = "sel-menu";
  selMenu.className = "menu row-menu";
  selMenu.hidden = true;
  selMenu.setAttribute("role", "menu");
  selMenu.innerHTML = '<div class="rm-head"><div class="rm-text"><div class="rm-title">Selection</div><div class="rm-sub"></div></div></div><hr>' + `<button type="button" role="menuitem" data-act="found">${svgIcon("check")}<span>Mark all as found</span></button>` + `<button type="button" role="menuitem" data-act="unfound">${svgIcon("open")}<span>Mark all as not found</span></button>` + `<button type="button" role="menuitem" data-act="delete-user" class="danger" hidden>${svgIcon("trash")}<span>Delete user markers</span></button>`;
  document.body.appendChild(selMenu);
  const NS = "http://www.w3.org/2000/svg";
  const overlay = document.createElementNS(NS, "svg");
  overlay.setAttribute("class", "sel-overlay");
  mapEl.appendChild(overlay);
  function setTool(t) {
    state.tool = t;
    t === "pan" ? map.dragPan.enable() : map.dragPan.disable();
    t === "pan" ? map.doubleClickZoom.enable() : map.doubleClickZoom.disable();
    t === "pan" ? map.boxZoom.enable() : map.boxZoom.disable();
    mapEl.classList.toggle("tool-select", t === "select");
    panBtn.setAttribute("aria-pressed", String(t === "pan"));
    selBtn.setAttribute("aria-pressed", String(t === "select"));
    selBtn.querySelector("svg").innerHTML = SHAPE_ICONS[state.shape];
    if (state.drawing)
      state.drawing.setActive(t === "draw");
    state.um?.setActive(t === "marker");
    state.capture?.setActive(t === "capture");
    selBtn.setAttribute("aria-label", `Selection tool: ${SHAPE_NAMES[state.shape]}`);
  }
  state.tool = "pan";
  setTool("pan");
  function closeToolMenus() {
    shapeMenu.hidden = true;
    selMenu.hidden = true;
  }
  function placeMenu(el, x, y, left = false) {
    el.hidden = false;
    const { offsetWidth: w, offsetHeight: h } = el, pad = 8;
    let lx = left ? x - w : x + 4;
    if (!left && lx + w > innerWidth - pad)
      lx = x - w - 4;
    lx = Math.max(pad, Math.min(lx, innerWidth - w - pad));
    const ty = Math.max(pad, Math.min(y, innerHeight - h - pad));
    el.style.left = lx + "px";
    el.style.top = ty + "px";
  }
  function openShapeMenu(btn) {
    closeRowMenu();
    shapeMenu.querySelectorAll("[data-shape]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.shape === state.shape)));
    const r = btn.getBoundingClientRect();
    placeMenu(shapeMenu, r.left - 8, r.top, true);
  }
  shapeMenu.onclick = (e) => {
    const b = e.target.closest("[data-shape]");
    if (!b)
      return;
    state.shape = b.dataset.shape;
    closeToolMenus();
    setTool("select");
  };
  function markersInSelection() {
    if (!state.sel)
      return [];
    const g = geomOf(state.sel, proj);
    return state.locs.filter((l) => {
      if (!shownOnMap(l))
        return false;
      const q = map.project([l.lng, l.lat]);
      return insideGeom(g, q.x, q.y);
    });
  }
  function userInSelection() {
    if (!state.sel)
      return [];
    const g = geomOf(state.sel, proj);
    return state.locs.filter((l) => {
      if (!l.user)
        return false;
      const q = map.project([l.lng, l.lat]);
      return insideGeom(g, q.x, q.y);
    });
  }
  function openSelMenu(x, y) {
    closeRowMenu();
    const n = markersInSelection().length;
    selMenu.querySelector(".rm-sub").textContent = n ? `${n} visible marker${n === 1 ? "" : "s"}` : "No visible markers inside";
    selMenu.querySelectorAll('button[data-act="found"], button[data-act="unfound"]').forEach((b) => {
      b.disabled = n === 0;
    });
    const users = userInSelection().length;
    const del = selMenu.querySelector('[data-act="delete-user"]');
    del.hidden = users === 0;
    del.querySelector("span").textContent = `Delete ${users} user marker${users === 1 ? "" : "s"}`;
    placeMenu(selMenu, x, y);
  }
  selMenu.onclick = (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled)
      return;
    if (b.dataset.act === "delete-user") {
      const ids = userInSelection().map((l) => l.id);
      closeToolMenus();
      state.um.deleteMany(ids);
      return;
    }
    const found = b.dataset.act === "found";
    for (const l of markersInSelection())
      found ? state.found.add(l.id) : state.found.delete(l.id);
    closeToolMenus();
    saveProfileNow();
    refreshAll();
  };
  function collapseTools() {
    closeToolMenus();
    state.sel = null;
    cancelDrag();
    mapEl.classList.add("tools-collapsed");
  }
  function expandTools() {
    mapEl.classList.remove("tools-collapsed");
  }
  const reopen = document.createElement("button");
  reopen.id = "tools-open";
  reopen.type = "button";
  reopen.title = "Show tools";
  reopen.setAttribute("aria-label", "Show tools");
  reopen.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/></svg>';
  reopen.onclick = expandTools;
  mapEl.appendChild(reopen);
  mapEl.classList.add("tools-collapsed");
  let btnTimer = null, btnHeld = false;
  selBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0)
      return;
    btnHeld = false;
    btnTimer = setTimeout(() => {
      btnHeld = true;
      openShapeMenu(selBtn);
    }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => selBtn.addEventListener(t, () => {
    if (btnTimer)
      clearTimeout(btnTimer);
  }));
  selBtn.addEventListener("click", () => {
    if (btnHeld) {
      btnHeld = false;
      return;
    }
    if (state.tool === "select") {
      if (shapeMenu.hidden)
        openShapeMenu(selBtn);
      else
        closeToolMenus();
      return;
    }
    closeToolMenus();
    setTool("select");
  });
  selBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openShapeMenu(selBtn);
  });
  panBtn.addEventListener("click", () => {
    if (state.tool === "pan")
      return collapseTools();
    closeToolMenus();
    setTool("pan");
  });
  const pointers = new Map;
  let press = null;
  const selInside = (p) => !!state.sel && insideGeom(geomOf(state.sel, proj), p.x, p.y);
  function cancelDrag() {
    state.drag = null;
    if (press) {
      if (press.timer)
        clearTimeout(press.timer);
      press = null;
    }
    renderSelection();
  }
  canvasBox.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || state.tool === "draw" || state.tool === "marker" || state.tool === "capture")
      return;
    pointers.set(e.pointerId, localPos(e));
    if (pointers.size > 1) {
      cancelDrag();
      return;
    }
    const p = localPos(e);
    press = { id: e.pointerId, x: p.x, y: p.y, inside: selInside(p), timer: null, held: false, drawing: false };
    if (press.inside) {
      press.timer = setTimeout(() => {
        if (press)
          press.held = true;
        openSelMenu(e.clientX, e.clientY);
      }, 500);
    }
  });
  canvasBox.addEventListener("pointermove", (e) => {
    if (state.tool === "draw" || state.tool === "marker" || state.tool === "capture")
      return;
    if (pointers.has(e.pointerId))
      pointers.set(e.pointerId, localPos(e));
    if (!press || press.id !== e.pointerId || press.held || pointers.size > 1)
      return;
    const p = localPos(e);
    if (!press.drawing) {
      if (Math.hypot(p.x - press.x, p.y - press.y) < 4)
        return;
      if (press.timer)
        clearTimeout(press.timer);
      if (state.tool !== "select")
        return;
      press.drawing = true;
      try {
        canvasBox.setPointerCapture(e.pointerId);
      } catch {}
      const shape = state.shape;
      state.drag = { shape, pts: [{ x: press.x, y: press.y }, p], circle: false };
      if (shape === "free")
        state.drag.pts = [{ x: press.x, y: press.y }];
    }
    const d = state.drag;
    if (!d)
      return;
    if (d.shape === "free") {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 3)
        d.pts.push(p);
    } else {
      const a = d.pts[0];
      let dx = p.x - a.x, dy = p.y - a.y;
      if (d.shape === "box" && e.shiftKey) {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = (dx < 0 ? -1 : 1) * s;
        dy = (dy < 0 ? -1 : 1) * s;
      }
      d.circle = d.shape === "ellipse" && e.shiftKey;
      d.pts[1] = { x: a.x + dx, y: a.y + dy };
    }
    renderSelection();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (!press || press.id !== e.pointerId)
      return;
    const p = press;
    press = null;
    if (p.timer)
      clearTimeout(p.timer);
    if (p.held)
      return;
    if (p.drawing) {
      if (state.drag)
        commitDrag();
      return;
    }
    if (e.type === "pointerup" && state.tool === "select" && state.sel && !p.inside) {
      state.sel = null;
      renderSelection();
    }
  };
  canvasBox.addEventListener("pointerup", endPointer);
  canvasBox.addEventListener("pointercancel", (e) => {
    pointers.delete(e.pointerId);
    if (press && press.id === e.pointerId) {
      if (press.timer)
        clearTimeout(press.timer);
      press = null;
    }
    state.drag = null;
    renderSelection();
  });
  function commitDrag() {
    const d = state.drag;
    state.drag = null;
    const toGeo = (q) => {
      const ll = map.unproject([q.x, q.y]);
      return { lng: ll.lng, lat: ll.lat };
    };
    if (d.shape === "free") {
      let area = 0;
      for (let i = 0, j = d.pts.length - 1;i < d.pts.length; j = i++)
        area += (d.pts[j].x + d.pts[i].x) * (d.pts[j].y - d.pts[i].y);
      if (d.pts.length >= 3 && Math.abs(area) / 2 > 9)
        state.sel = { shape: "free", pts: d.pts.map(toGeo) };
    } else {
      const [a, b] = d.pts;
      if (Math.abs(b.x - a.x) >= 3 || Math.abs(b.y - a.y) >= 3)
        state.sel = { shape: d.shape, pts: [toGeo(a), toGeo(b)], circle: d.circle };
    }
    renderSelection();
  }
  canvasBox.addEventListener("contextmenu", (e) => {
    if (state.tool !== "pan")
      e.preventDefault();
    if (selInside(localPos(e))) {
      e.preventDefault();
      openSelMenu(e.clientX, e.clientY);
    }
  });
  function renderSelection() {
    const g = state.drag ? geomOf(state.drag, (p) => p) : state.sel ? geomOf(state.sel, proj) : null;
    overlay.textContent = "";
    if (!g)
      return;
    let el;
    if (g.shape === "box") {
      el = document.createElementNS(NS, "rect");
      el.setAttribute("x", String(g.x));
      el.setAttribute("y", String(g.y));
      el.setAttribute("width", String(g.w));
      el.setAttribute("height", String(g.h));
    } else if (g.shape === "ellipse") {
      el = document.createElementNS(NS, "ellipse");
      el.setAttribute("cx", String(g.cx));
      el.setAttribute("cy", String(g.cy));
      el.setAttribute("rx", String(g.rx));
      el.setAttribute("ry", String(g.ry));
    } else {
      el = document.createElementNS(NS, "polygon");
      el.setAttribute("points", g.pts.map((p) => `${p.x},${p.y}`).join(" "));
    }
    el.setAttribute("class", "sel-shape");
    overlay.appendChild(el);
  }
  map.on("move", renderSelection);
  map.on("resize", renderSelection);
  document.addEventListener("keydown", (e) => {
    if (state.drawing?.keydown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Escape")
      return;
    const hadSomething = !shapeMenu.hidden || !selMenu.hidden || !!state.sel || !!state.drag;
    closeToolMenus();
    if (state.sel || state.drag) {
      state.sel = null;
      cancelDrag();
    } else if (!hadSomething && state.tool !== "pan")
      setTool("pan");
    else if (!hadSomething)
      collapseTools();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#shape-menu, #sel-menu, #tool-select"))
      closeToolMenus();
  });
  return { setTool };
}

// src/client/map/map-view.ts
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok)
    throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image;
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Could not load " + src));
    i.src = src;
  });
}
function fatal(msg) {
  document.body.classList.remove("loading-side", "loading-map");
  const groups = $("#groups");
  if (groups)
    groups.innerHTML = `<p style="padding:16px;color:var(--blood)">${esc(msg)}</p>`;
  console.error(msg);
  return false;
}
function applyTheme(theme = {}) {
  const root = document.documentElement.style;
  const active = isLightTheme() ? deriveLightTheme(theme) : theme;
  for (const [name, value] of Object.entries(active)) {
    if (value && CSS.supports(`--${name}`, value)) {
      root.setProperty(`--${name}`, value);
      themeState.set(name, value);
    }
  }
  const backlink = mixColor(themeVar("accent-soft"), themeVar("night"), 0.7);
  root.setProperty("--backlink", backlink);
  themeState.set("backlink", backlink);
  document.querySelector("meta[name=theme-color]")?.setAttribute("content", themeVar("night"));
  const icon = document.querySelector("link[rel=icon]");
  if (icon) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='${themeVar("accent-soft")}' d='M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z'/><circle cx='12' cy='10' r='2.8' fill='${themeVar("night")}'/></svg>`;
    icon.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }
  if (state.map && state.mapReady) {
    const map = state.map;
    if (map.getLayer("bg"))
      map.setPaintProperty("bg", "background-color", themeVar("night"));
    if (map.getLayer("sel")) {
      map.setPaintProperty("sel", "circle-color", themeVar("accent"));
      map.setPaintProperty("sel", "circle-stroke-color", themeVar("accent-soft"));
    }
    if (map.getLayer("links"))
      map.setPaintProperty("links", "line-color", themeVar("accent-soft"));
    if (map.getLayer("backlinks"))
      map.setPaintProperty("backlinks", "line-color", themeVar("backlink"));
    const updateArrow = (name, fill) => {
      if (!map.hasImage(name))
        return;
      const ac = document.createElement("canvas");
      ac.width = ac.height = 24;
      const actx = ac.getContext("2d");
      actx.beginPath();
      actx.moveTo(12, 2);
      actx.lineTo(21, 21);
      actx.lineTo(3, 21);
      actx.closePath();
      actx.fillStyle = fill;
      actx.strokeStyle = themeVar("night");
      actx.lineWidth = 2.5;
      actx.lineJoin = "round";
      actx.fill();
      actx.stroke();
      map.updateImage(name, actx.getImageData(0, 0, 24, 24));
    };
    updateArrow("link-arrow", themeVar("accent-soft"));
    updateArrow("backlink-arrow", themeVar("backlink"));
  }
}
var themeState = new Map;
var colorProbe = null;
function getColorProbe() {
  if (!colorProbe)
    colorProbe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  return colorProbe;
}
var themeVar = (name) => {
  if (themeState.has(name))
    return themeState.get(name);
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  const probe = getColorProbe();
  probe.fillStyle = raw;
  return probe.fillStyle;
};
function mixColor(a, b, t) {
  const probe = getColorProbe();
  const rgb = (c) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = c;
    probe.fillRect(0, 0, 1, 1);
    return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const pa = rgb(a), pb = rgb(b);
  return "rgb(" + pa.map((v, i) => Math.round(v * t + pb[i] * (1 - t))).join(",") + ")";
}
async function loadMeta() {
  const r = await fetch("./meta.json");
  if (!r.ok)
    throw new Error(`meta.json: HTTP ${r.status}. Run add-game.ts for this game`);
  return r.json();
}
async function loadGame(entry) {
  showMapSwitchPlaceholder();
  state.entry = entry;
  state.folder = ".";
  applyTheme(entry.theme);
  recordGameOpen(entry.slug, entry.theme, entry.title);
  const titleEl = $("#game-title");
  if (titleEl)
    titleEl.textContent = entry.title;
  document.title = `${entry.title} · Verticordia Atlas`;
  const tagLabelEl = $("#tag-label");
  if (tagLabelEl)
    tagLabelEl.textContent = entry.tagLabel || "Filter";
  try {
    state.meta = await loadMeta();
    const mk = state.meta.markers || null;
    const spriteFile = !mk ? null : mk.png2x && mk.json2x ? { json: mk.json2x, png: mk.png2x } : { json: mk.json, png: mk.png };
    const [spriteDefs, spriteImg] = await Promise.all([
      spriteFile ? fetchJSON(`${state.folder}/${spriteFile.json}`) : Promise.resolve({}),
      spriteFile ? loadImage(`${state.folder}/${spriteFile.png}`) : Promise.resolve(null)
    ]);
    state.sprite = { defs: spriteDefs, img: spriteImg, png: spriteFile?.png ?? null };
    state.spriteFile = spriteFile;
  } catch (e) {
    return fatal(e.message + " (check the files next to this page)");
  }
  state.glyphs = null;
  if (state.meta.icons?.font && state.meta.icons.glyphs) {
    try {
      const family = `gi-${entry.id}`;
      const face = new FontFace(family, `url("${state.folder}/${state.meta.icons.font}")`);
      await face.load();
      document.fonts.add(face);
      state.glyphs = { family, map: state.meta.icons.glyphs };
    } catch (e) {
      console.warn("icon font not loaded, using the marker sprite:", e.message);
    }
  } else if (state.meta.icons?.image && state.meta.icons.glyphs) {
    state.glyphs = {
      image: `${state.folder}/${state.meta.icons.image}`,
      size: state.meta.icons.size || 18,
      map: state.meta.icons.glyphs
    };
  }
  await migratePresets();
  await loadProfiles();
  const want = new URLSearchParams(location.search).get("map");
  const info = state.meta.maps.find((m) => m.slug === want) || state.meta.maps.find((m) => m.slug === state.profile?.map) || state.meta.maps[0];
  try {
    await prepareMap(info);
  } catch (e) {
    return fatal(e.message + " (check the files next to this page)");
  }
  resetShownCounts();
  startMorph();
  buildSidebar();
  $("#progress-bar")?.offsetWidth;
  renderMapSwitch();
  updateSidebar();
  endMorph({ later: true });
  $("#groups")?.classList.add("enter");
  document.body.classList.remove("loading-side");
  createMap();
  return true;
}
async function prepareMap(info) {
  const data = await mapData(info);
  state.mapInfo = info;
  state.data = data;
  const spriteFile = state.spriteFile;
  const catById = new Map(Object.values(data.categories).map((c) => [c.id, c]));
  state.cats = catById;
  state.groups = [...data.groups].sort((a, b) => a.order - b.order).map((g) => {
    const ids = (g.categories || []).map((c) => c.id);
    const cats = (ids.length ? ids.map((id) => catById.get(id)) : [...catById.values()].filter((c) => c.group_id === g.id)).filter(Boolean).sort((a, b) => a.order - b.order);
    return { id: g.id, title: g.title, col: vivid(g.color), cats };
  });
  if (!spriteFile)
    state.groups.forEach((g) => g.cats.forEach((c) => {
      c.icon = "up-" + String(g.col).replace("#", "");
    }));
  const groupOfCat = new Map;
  state.groups.forEach((g) => g.cats.forEach((c) => groupOfCat.set(c.id, g)));
  state.groupOfCat = groupOfCat;
  state.locs = data.locations.map((l) => ({
    id: l.id,
    cat: l.category_id,
    title: l.title || "",
    desc: l.description || "",
    lat: parseFloat(l.latitude),
    lng: parseFloat(l.longitude),
    tags: l.tags || [],
    media: l.media || [],
    icon: catById.get(l.category_id)?.icon
  })).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  state.officialLocs = state.locs;
  state.byId = new Map(state.locs.map((l) => [l.id, l]));
  state.tags = [...data.tags || []].sort((a, b) => a.id - b.id);
  await loadMapState();
  const tagField = $("#tag-field");
  if (tagField)
    tagField.hidden = state.tags.length === 0;
  syncTagStrict();
  const tagSelect = $("#tag-select");
  if (tagSelect) {
    tagSelect.innerHTML = '<option value="">Everything</option><option value="' + UNTAGGED + '">Only untagged</option>' + state.tags.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
    if (state.tags.length)
      tagSelect.value = state.tag == null ? "" : String(state.tag);
  }
  rebuildUserData();
}
var mapCache = new Map;
function mapData(info) {
  if (!mapCache.has(info.slug)) {
    mapCache.set(info.slug, fetchJSON(`${state.folder}/${info.data}`).catch((e) => {
      mapCache.delete(info.slug);
      throw e;
    }));
  }
  return mapCache.get(info.slug);
}
function mapSwitchEl() {
  let nav = document.getElementById("map-switch");
  if (!nav) {
    nav = document.createElement("nav");
    nav.id = "map-switch";
    nav.className = "map-switch";
    nav.setAttribute("aria-label", "Maps in this game");
    nav.onclick = (e) => {
      const b = e.target.closest("button[data-map]");
      if (b && b.dataset.map)
        switchMap(b.dataset.map);
    };
    nav.onchange = (e) => {
      const target = e.target;
      if (target.matches("select[data-map-select]"))
        switchMap(target.value);
    };
    document.querySelector(".side-head .progress")?.before(nav);
    if (nav.parentElement)
      new ResizeObserver(() => layoutMapSwitch()).observe(nav.parentElement);
    document.fonts?.ready.then(() => layoutMapSwitch());
    document.fonts?.addEventListener("loadingdone", () => layoutMapSwitch());
  }
  return nav;
}
function showMapSwitchPlaceholder() {
  const nav = mapSwitchEl();
  nav.hidden = false;
  nav.classList.add("placeholder");
  nav.innerHTML = '<span class="spinner" role="status" aria-label="Loading maps"></span>';
}
function renderMapSwitch() {
  const maps = state.meta?.maps || [];
  const nav = mapSwitchEl();
  nav.classList.remove("placeholder");
  nav.hidden = maps.length < 2;
  if (nav.hidden)
    return;
  const key = maps.map((m) => m.slug).join("|");
  if (nav.dataset.maps !== key || !nav.querySelector("button[data-map]")) {
    nav.dataset.maps = key;
    nav.classList.remove("ready");
    nav.innerHTML = '<span class="map-thumb" aria-hidden="true"></span>' + maps.map((m) => `<button type="button" data-map="${esc(m.slug)}">${esc(m.title || m.slug)}</button>`).join("") + `<select data-map-select aria-label="Map">${maps.map((m) => `<option value="${esc(m.slug)}">${esc(m.title || m.slug)}</option>`).join("")}</select>`;
  }
  const cur = state.mapInfo?.slug;
  nav.removeAttribute("data-pending");
  nav.querySelectorAll("button[data-map]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.map === cur));
    b.removeAttribute("data-pending");
  });
  nav.querySelector("select").value = cur ?? "";
  layoutMapSwitch();
  if (!nav.classList.contains("ready"))
    requestAnimationFrame(() => nav.classList.add("ready"));
}
function markSwitchTarget(slug) {
  const nav = mapSwitchEl();
  nav.setAttribute("data-pending", "");
  nav.querySelectorAll("button[data-map]").forEach((b) => b.toggleAttribute("data-pending", b.dataset.map === slug));
  const sel = nav.querySelector("select");
  if (sel)
    sel.value = slug;
  moveThumb(slug);
}
function placeThumb(nav, attr, value) {
  const thumb = nav?.querySelector(".map-thumb");
  if (!thumb || !nav)
    return;
  const b = nav.querySelector(`button[${attr}="${CSS.escape(value ?? "")}"]`);
  if (!b || nav.classList.contains("as-select")) {
    thumb.style.width = "0px";
    return;
  }
  thumb.style.width = b.offsetWidth + "px";
  thumb.style.transform = `translateX(${b.offsetLeft}px)`;
}
function moveThumb(slug) {
  placeThumb(document.getElementById("map-switch"), "data-map", slug);
}
var SWITCH_TOLERANCE = 16;
function layoutMapSwitch() {
  const nav = document.getElementById("map-switch");
  if (!nav || nav.hidden || !nav.clientWidth || nav.querySelector(".spinner"))
    return;
  nav.classList.remove("as-select", "squeeze");
  const over = nav.scrollWidth - nav.clientWidth;
  if (over > SWITCH_TOLERANCE)
    nav.classList.add("as-select");
  else if (over > 1)
    nav.classList.add("squeeze");
  moveThumb(state.mapInfo?.slug);
}
function mapLimits(info, data) {
  const ts = info.tilesets[0];
  const box = ts.bounds || data.styles?.mapStyle?.bounds || [-180, -85, 180, 85];
  const [w, s, e, n] = box, pad = 0.25;
  const isWholeWorld = e - w >= 359 || w <= -179 && e >= 179;
  const maxBounds = isWholeWorld ? null : [
    [Math.max(-180, w - pad), Math.max(-85.05, s - pad)],
    [Math.min(180, e + pad), Math.min(85.05, n + pad)]
  ];
  return { ts, box, minZoom: ts.minzoom ?? 0, maxZoom: ts.viewMaxzoom ?? ts.maxzoom ?? 18, maxBounds };
}
function startOf(info, data, cam) {
  const lim = mapLimits(info, data);
  if (cam && Number.isFinite(cam.lng) && Number.isFinite(cam.lat) && Number.isFinite(cam.zoom)) {
    if (cam.zoom <= lim.maxZoom && cam.zoom >= lim.minZoom)
      return { center: [cam.lng, cam.lat], zoom: cam.zoom };
  }
  const cfg = data.mapConfig || {};
  return { center: [cfg.start_lng, cfg.start_lat], zoom: cfg.initial_zoom ?? 11 };
}
function setBaseTiles(map) {
  const { ts, box } = mapLimits(state.mapInfo, state.data);
  const [w, s, e, n] = box;
  if (map.getLayer("base"))
    map.removeLayer("base");
  if (map.getSource("base"))
    map.removeSource("base");
  map.addSource("base", {
    type: "raster",
    tiles: [new URL(state.folder + "/", document.baseURI).href + ts.template],
    tileSize: ts.tileSize || 256,
    minzoom: ts.minzoom ?? 0,
    maxzoom: ts.maxzoom ?? 18,
    bounds: [w, s + 0.001, e - 0.001, n]
  });
  map.addLayer({ id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 900 } }, map.getLayer("sel") ? "sel" : undefined);
}
var cameraNow = () => {
  const c = state.map.getCenter();
  return { lng: +c.lng.toFixed(6), lat: +c.lat.toFixed(6), zoom: +state.map.getZoom().toFixed(2) };
};
var cameraKey = () => state.mapReady && state.mapInfo ? state.mapInfo.slug + JSON.stringify(cameraNow()) : "";
var agreeCamera = () => {
  state.camKey = cameraKey();
};
var viewUntouched = () => !state.mapReady || cameraKey() === state.camKey;
var sameCamera = (a, b) => Math.abs(a.lng - b.lng) < 0.00001 && Math.abs(a.lat - b.lat) < 0.00001 && Math.abs(a.zoom - b.zoom) < 0.005;
function rememberCamera(now = false) {
  if (state.capturing)
    return;
  if (state.glide && !state.glide.touched)
    return;
  let changed = false;
  if (state.mapReady && state.profile && state.mapInfo) {
    const p = state.profile, slug = state.mapInfo.slug, key = cameraKey();
    if (key !== state.camKey || p.map !== slug) {
      p.map = slug;
      p.cameras = { ...p.cameras || {}, [slug]: cameraNow() };
      state.camKey = key;
      changed = true;
    }
  } else
    changed = true;
  if (!changed && !isSavePending())
    return;
  if (now)
    saveProfileNow();
  else
    scheduleSave();
}
var FADE_MS = 1600;
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
var revealToken = 0;
function revealWhenSettled(map, minMs = 1000) {
  const token = ++revealToken, start = performance.now();
  let timer;
  const stop = () => {
    clearInterval(timer);
    map.off("idle", check);
  };
  const done = () => {
    stop();
    if (token === revealToken && !state.capturing)
      document.body.classList.remove("loading-map");
  };
  const check = () => {
    if (performance.now() - start >= minMs && map.loaded())
      done();
  };
  timer = setInterval(check, 100);
  map.on("idle", check);
  check();
  setTimeout(() => {
    if (token === revealToken)
      done();
  }, 15000);
}
async function switchMap(slug, { remember = true } = {}) {
  if (!state.mapReady || slug === state.mapInfo?.slug)
    return;
  const info = state.meta.maps.find((m) => m.slug === slug);
  if (!info)
    return;
  revealToken++;
  markSwitchTarget(slug);
  closeDetail();
  state.setTool?.("pan");
  document.body.classList.add("loading-map");
  startMorph();
  if (remember)
    rememberCamera(true);
  try {
    await Promise.all([prepareMap(info), delay(FADE_MS)]);
  } catch (e) {
    endMorph();
    document.body.classList.remove("loading-map");
    renderMapSwitch();
    return toast(`Could not load ${info.title}.`, 4000);
  }
  dismiss();
  state.sel = null;
  setBaseTiles(state.map);
  const lim = mapLimits(info, state.data);
  state.map.setMinZoom(lim.minZoom);
  state.map.setMaxZoom(lim.maxZoom);
  state.map.setMaxBounds(lim.maxBounds);
  state.map.jumpTo(startOf(info, state.data, state.profile?.cameras?.[slug]));
  revealWhenSettled(state.map);
  if (remember)
    rememberCamera(true);
  refreshAll();
  endMorph({ later: true });
  renderMapSwitch();
  updateSidebar();
}
function glideTo(cam) {
  const target = startOf(state.mapInfo, state.data, cam);
  state.glide = { touched: false };
  state.map.flyTo({ ...target, speed: 1.1, essential: true });
}
async function syncMapToProfile() {
  const want = state.profile?.map;
  if (want && want !== state.mapInfo?.slug && state.meta.maps.some((m) => m.slug === want)) {
    await switchMap(want, { remember: false });
    agreeCamera();
    return;
  }
  const cam = state.profile?.cameras?.[state.mapInfo?.slug];
  if (cam && state.mapReady) {
    state.map.jumpTo(startOf(state.mapInfo, state.data, cam));
    agreeCamera();
  }
}
function createMap() {
  const start = startOf(state.mapInfo, state.data, state.profile?.cameras?.[state.mapInfo.slug]);
  const lim = mapLimits(state.mapInfo, state.data);
  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "bg", type: "background", paint: { "background-color": themeVar("night") } }]
    },
    center: start.center,
    zoom: start.zoom,
    minZoom: lim.minZoom,
    maxZoom: lim.maxZoom,
    ...lim.maxBounds ? { maxBounds: lim.maxBounds } : {},
    attributionControl: false,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    fadeDuration: 0
  });
  state.map = map;
  let camTimer;
  map.on("movestart", (e) => {
    if (state.glide && e.originalEvent)
      state.glide.touched = true;
    if (e.originalEvent && state.search.preview)
      state.search.preview = null;
  });
  map.on("moveend", () => {
    const g = state.glide;
    state.glide = null;
    if (g && !g.touched)
      agreeCamera();
    if (state.search.preview)
      return;
    clearTimeout(camTimer);
    camTimer = setTimeout(() => rememberCamera(false), 400);
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
  const tools = setupSelection(map);
  state.setTool = (t) => tools.setTool(t);
  state.drawing = setupDrawing({
    map,
    mapEl: map.getContainer(),
    canvasBox: map.getCanvasContainer(),
    getProfile: () => state.profile,
    getMap: () => state.mapInfo?.slug,
    onChange: () => scheduleSave(),
    requestTool: (t) => tools.setTool(t),
    renderMd
  });
  state.capture = setupCapture({
    map,
    mapEl: map.getContainer(),
    canvasBox: map.getCanvasContainer(),
    drawing: state.drawing,
    requestTool: (t) => tools.setTool(t),
    toast,
    names: () => ({
      file: `${state.entry.id}-${state.mapInfo.slug}`,
      label: `${state.entry.title} · ${state.mapInfo.title}`
    }),
    setBusy: (b) => {
      state.capturing = b;
      document.body.classList.toggle("loading-map", b);
    }
  });
  state.um = setupUserMarkers({
    map,
    state,
    mapEl: map.getContainer(),
    canvasBox: map.getCanvasContainer(),
    changed: userChanged,
    select,
    closeDetail,
    askDialog,
    toast,
    requestTool: (t) => tools.setTool(t)
  });
  map.on("load", () => {
    for (const [name, d] of Object.entries(state.sprite.defs)) {
      const c = document.createElement("canvas");
      c.width = d.width;
      c.height = d.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(state.sprite.img, d.x, d.y, d.width, d.height, 0, 0, d.width, d.height);
      map.addImage(name, ctx.getImageData(0, 0, d.width, d.height), { pixelRatio: d.pixelRatio || 1 });
    }
    setBaseTiles(map);
    map.addSource("sel", { type: "geojson", data: emptyFC });
    map.addLayer({
      id: "sel",
      type: "circle",
      source: "sel",
      paint: {
        "circle-radius": 21,
        "circle-color": themeVar("accent"),
        "circle-opacity": 0.22,
        "circle-stroke-color": themeVar("accent-soft"),
        "circle-stroke-width": 2.5,
        "circle-translate": [0, -17]
      }
    });
    const arrowImage = (name, fill) => {
      const ac = document.createElement("canvas");
      ac.width = ac.height = 24;
      const actx = ac.getContext("2d");
      actx.beginPath();
      actx.moveTo(12, 2);
      actx.lineTo(21, 21);
      actx.lineTo(3, 21);
      actx.closePath();
      actx.fillStyle = fill;
      actx.strokeStyle = themeVar("night");
      actx.lineWidth = 2.5;
      actx.lineJoin = "round";
      actx.fill();
      actx.stroke();
      map.addImage(name, actx.getImageData(0, 0, 24, 24), { pixelRatio: 2 });
    };
    arrowImage("link-arrow", themeVar("accent-soft"));
    arrowImage("backlink-arrow", themeVar("backlink"));
    map.addSource("links", { type: "geojson", data: emptyFC });
    map.addLayer({
      id: "links",
      type: "line",
      source: "links",
      layout: { "line-cap": "round" },
      paint: {
        "line-color": themeVar("accent-soft"),
        "line-width": 2,
        "line-opacity": 0.8,
        "line-dasharray": [2, 1.5]
      }
    });
    map.addSource("backlinks", { type: "geojson", data: emptyFC });
    map.addLayer({
      id: "backlinks",
      type: "line",
      source: "backlinks",
      layout: { "line-cap": "round" },
      paint: {
        "line-color": themeVar("backlink"),
        "line-width": 2,
        "line-opacity": 0.9,
        "line-dasharray": [2, 1.5]
      }
    });
    map.addSource("locs", { type: "geojson", data: emptyFC });
    map.addLayer({
      id: "locs",
      type: "symbol",
      source: "locs",
      layout: {
        "icon-image": ["get", "icon"],
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], ...ICON_STOPS.flat()],
        "symbol-sort-key": ["get", "z"]
      },
      paint: {
        "icon-opacity": ["case", ["==", ["get", "f"], 1], 0.4, 1],
        "icon-opacity-transition": { duration: 0 }
      }
    });
    map.addSource("hover-loc", { type: "geojson", data: emptyFC });
    map.addLayer({
      id: "hover-loc",
      type: "symbol",
      source: "hover-loc",
      paint: { "icon-opacity-transition": { duration: 0 } },
      layout: {
        "icon-image": ["get", "icon"],
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          ...ICON_STOPS.flat().map((v, i) => i % 2 ? v * 1.22 : v)
        ]
      }
    });
    map.addSource("link-heads", { type: "geojson", data: emptyFC });
    map.addLayer({
      id: "link-heads",
      type: "symbol",
      source: "link-heads",
      layout: {
        "icon-image": "link-arrow",
        "icon-size": 0.6,
        "icon-rotate": ["get", "rot"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    });
    map.addSource("backlink-heads", { type: "geojson", data: emptyFC });
    map.addLayer({
      id: "backlink-heads",
      type: "symbol",
      source: "backlink-heads",
      layout: {
        "icon-image": "backlink-arrow",
        "icon-size": 0.6,
        "icon-rotate": ["get", "rot"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    });
    state.mapReady = true;
    agreeCamera();
    revealWhenSettled(map);
    updateSidebar();
    refreshMap();
    state.drawing?.render();
    const q = new URLSearchParams(location.search).get("loc");
    const m = /^#loc=(\d+)/.exec(location.hash) || (/^\d+$/.test(q || "") ? [null, q] : null);
    const packed = new URLSearchParams(location.search).get("tm");
    if (packed) {
      history.replaceState(null, "", location.pathname);
      state.um.addSharedTemp(packed);
    }
    if (m && state.byId.has(+m[1])) {
      history.replaceState(null, "", location.pathname + location.search);
      select(+m[1], { fly: true });
    }
  });
  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip", anchor: "bottom" });
  let hoverId = null;
  const setHover = (l) => {
    const id = l && l.user ? l.id : null;
    if (id === hoverId)
      return;
    hoverId = id;
    map.getSource("hover-loc").setData(id == null ? emptyFC : {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [l.lng, l.lat] },
          properties: { icon: l.icon }
        }
      ]
    });
  };
  map.on("mousemove", "locs", (ev) => {
    const f = ev.features && ev.features[0];
    const l = f && state.byId.get(Number(f.properties.id));
    setHover(l || null);
    if (state.tool !== "pan")
      return;
    if (!f)
      return;
    if (!l)
      return;
    map.getCanvas().style.cursor = "pointer";
    tip.setLngLat([l.lng, l.lat]).setOffset([0, -(44 * iconScale(map.getZoom())) - 6]).setText(l.title + (state.found.has(l.id) ? " (found)" : "")).addTo(map);
  });
  map.on("mouseleave", "locs", () => {
    map.getCanvas().style.cursor = "";
    tip.remove();
    setHover(null);
  });
  map.on("move", updateLinkHeads);
  map.on("movestart", closeCtx);
  map.on("contextmenu", (ev) => {
    const e = ev.originalEvent;
    if (state.tool !== "pan" && state.tool !== "marker")
      return;
    if (inSelection(ev.point))
      return;
    e.preventDefault();
    mapMenuAt(e.clientX, e.clientY, ev.point, ev.lngLat);
  });
  const canvas = map.getCanvasContainer();
  let pressT = null, pressAt = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (pressT)
      clearTimeout(pressT);
    if (e.pointerType !== "touch" || e.button !== 0 || state.tool !== "pan")
      return;
    pressAt = { x: e.clientX, y: e.clientY };
    pressT = setTimeout(() => {
      pressT = null;
      if (!pressAt)
        return;
      const r = canvas.getBoundingClientRect();
      const pt = { x: pressAt.x - r.left, y: pressAt.y - r.top };
      if (!inSelection(pt))
        mapMenuAt(pressAt.x, pressAt.y, pt, map.unproject([pt.x, pt.y]));
    }, 500);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pressT && pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) {
      clearTimeout(pressT);
      pressT = null;
    }
  });
  ["pointerup", "pointercancel"].forEach((t) => canvas.addEventListener(t, () => {
    if (pressT)
      clearTimeout(pressT);
    pressT = null;
  }));
  map.on("click", (ev) => {
    if (state.tool !== "pan")
      return;
    document.body.classList.remove("side-open");
    const hits = map.queryRenderedFeatures(ev.point, { layers: ["locs"] });
    if (hits.length)
      select(Number(hits[0].properties.id), { fly: false });
    else
      closeDetail();
  });
}
var pendingGlyphs = new Set;
function mapIcon(name) {
  const map = state.map;
  if (!name)
    return name;
  if (name.startsWith("up-")) {
    if (!map.hasImage(name))
      map.addImage(name, pingImage(name), { pixelRatio: 2 });
    return name;
  }
  if (!name.startsWith("ic-"))
    return name;
  if (map.hasImage(name))
    return name;
  const plain = `up-${name.slice(-6)}`;
  if (!map.hasImage(plain))
    map.addImage(plain, pingImage(plain), { pixelRatio: 2 });
  if (iconsReady() && !pendingGlyphs.has(name)) {
    pendingGlyphs.add(name);
    glyphPinImage(name).then((img) => {
      if (img && !map.hasImage(name))
        map.addImage(name, img, { pixelRatio: 2 });
      refreshMap();
    }).catch(() => {}).finally(() => pendingGlyphs.delete(name));
  }
  return plain;
}
function relatedOf(id) {
  const out = new Set([...state.outLinks.get(id) || [], ...state.inLinks.get(id) || []]);
  out.delete(id);
  return out;
}
function refreshMap() {
  if (!state.mapReady)
    return;
  const sel = state.selected, rel = sel != null ? relatedOf(sel) : new Set;
  const feats = [];
  for (const l of state.locs) {
    const pinned = l.id === sel || rel.has(l.id);
    if (!pinned) {
      if (!shownOnMap(l))
        continue;
      if (state.search.ids && !state.search.ids.has(l.id))
        continue;
    }
    const icon = mapIcon(l.icon);
    const f = state.found.has(l.id) ? 1 : 0;
    feats.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [l.lng, l.lat] },
      properties: { id: l.id, icon, f, z: f ? 0 : 1 }
    });
  }
  state.map.getSource("locs").setData({ type: "FeatureCollection", features: feats });
  syncRelatedRings(rel);
}
var relRings = new Map;
var relRingsListening = false;
function syncRelatedRings(rel) {
  for (const [id, el] of relRings)
    if (!rel.has(id)) {
      el.remove();
      relRings.delete(id);
    }
  for (const id of rel) {
    if (relRings.has(id))
      continue;
    const el = document.createElement("div");
    el.className = "search-ring rel-ring";
    state.map.getContainer().appendChild(el);
    relRings.set(id, el);
  }
  if (rel.size && !relRingsListening) {
    relRingsListening = true;
    state.map.on("move", placeRelatedRings);
  }
  placeRelatedRings();
}
function placeRelatedRings() {
  for (const [id, el] of relRings) {
    const l = state.byId.get(id);
    if (!l)
      continue;
    const p = state.map.project([l.lng, l.lat]);
    el.style.transform = `translate(${p.x - 21}px, ${p.y - 38}px)`;
  }
}
function refreshAll() {
  updateSidebar();
  renderPresets();
  refreshMap();
  state.drawing?.render();
  if (state.search.active)
    runSearch();
  if (state.selected != null)
    renderDetail();
}

// src/client/map/detail.ts
function stackPush(id) {
  if (state.trail[state.trail.length - 1] === id)
    return;
  state.trail.push(id);
  history.pushState({ session: state.session, depth: state.trail.length, loc: id }, "", "#loc=" + id);
}
function goBack() {
  if (state.trail.length > 1)
    history.back();
}
function onPopState(ev) {
  const s = ev.state;
  if (!s || !s.session)
    return dismiss();
  if (s.session !== state.session) {
    if (s.depth > 0)
      history.go(-s.depth);
    return;
  }
  state.trail.length = Math.min(state.trail.length, s.depth - 1);
  state.trail.splice(s.depth - 1, 1, s.loc);
  select(s.loc, { fly: true, push: false });
}
function buildLinkIndex() {
  for (const l of state.locs) {
    const out = internalRefs(l.desc, l.id);
    for (const t of l.links || [])
      if (t !== l.id && state.byId.has(t) && !out.includes(t))
        out.push(t);
    state.outLinks.set(l.id, out);
    for (const t of out) {
      if (!state.inLinks.has(t))
        state.inLinks.set(t, []);
      state.inLinks.get(t).push(l.id);
    }
  }
}
function linkedLocations(l) {
  return (state.outLinks.get(l.id) || []).map((id) => state.byId.get(id)).filter(Boolean);
}
function referrersOneWay(l) {
  const out = new Set(state.outLinks.get(l.id));
  return (state.inLinks.get(l.id) || []).filter((id) => !out.has(id)).map((id) => state.byId.get(id)).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
}
function select(id, { fly = true, push = true, closeSide = true } = {}) {
  const l = state.byId.get(id);
  if (!l)
    return;
  if (push)
    stackPush(id);
  state.selected = id;
  refreshMap();
  if (applicable(l) && state.view.hidden.has(l.cat)) {
    state.view.hidden.delete(l.cat);
    onViewChanged();
  }
  if (state.mapReady) {
    state.map.getSource("sel").setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [l.lng, l.lat] }, properties: {} }]
    });
    if (fly) {
      const padding = isMobile() ? { bottom: Math.round(innerHeight * 0.4) } : { right: 384 };
      state.map.flyTo({
        center: [l.lng, l.lat],
        zoom: Math.max(state.map.getZoom(), 13.5),
        padding,
        speed: 1.5,
        essential: true
      });
    }
  }
  if (closeSide)
    document.body.classList.remove("side-open");
  renderDetail();
  syncSearchActive(id, state.mapInfo?.slug);
}
function updateLinks() {
  if (!state.mapReady)
    return;
  const from = state.selected != null ? state.byId.get(state.selected) : null;
  const targets = from ? linkedLocations(from) : [];
  const refs = from ? referrersOneWay(from) : [];
  state.links = { from, targets, refs };
  const line = (a, b) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [a.lng, a.lat],
        [b.lng, b.lat]
      ]
    },
    properties: {}
  });
  state.map.getSource("links").setData({ type: "FeatureCollection", features: from ? targets.map((t) => line(from, t)) : [] });
  state.map.getSource("backlinks").setData({ type: "FeatureCollection", features: from ? refs.map((r) => line(r, from)) : [] });
  updateLinkHeads();
}
function arrowHeads(pairs) {
  const feats = [];
  for (const [from, to] of pairs) {
    const a = state.map.project([from.lng, from.lat]);
    const b = state.map.project([to.lng, to.lat]);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1)
      continue;
    const back = Math.min(28, len * 0.5);
    const p = state.map.unproject([b.x - dx / len * back, b.y - dy / len * back]);
    feats.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { rot: Math.atan2(dx, -dy) * 180 / Math.PI }
    });
  }
  return { type: "FeatureCollection", features: feats };
}
function updateLinkHeads() {
  if (!state.mapReady || !state.links)
    return;
  const { from, targets, refs } = state.links;
  state.map.getSource("link-heads").setData(arrowHeads(from ? targets.map((t) => [from, t]) : []));
  state.map.getSource("backlink-heads").setData(arrowHeads(from ? refs.map((r) => [r, from]) : []));
}
var DETAIL_OUT_MS = 200;
function hideDetail() {
  const d = $("#detail");
  if (!d)
    return;
  clearTimeout(d.outTimer);
  if (d.hidden)
    return;
  if (d.classList.contains("leaving"))
    return;
  endPreview();
  d.querySelectorAll("iframe").forEach((f) => {
    f.src = "about:blank";
  });
  d.classList.add("leaving");
  d.outTimer = setTimeout(() => {
    d.hidden = true;
    d.classList.remove("leaving");
  }, DETAIL_OUT_MS);
}
function dismiss() {
  state.trail = [];
  state.session = uid();
  state.selected = null;
  refreshMap();
  hideDetail();
  document.body.classList.remove("detail-open");
  if (state.mapReady)
    state.map.getSource("sel").setData(emptyFC);
  updateLinks();
  syncSearchActive(null);
}
function closeDetail() {
  dismiss();
  if (location.hash)
    history.replaceState(null, "", location.pathname + location.search);
}
var lastPointer = null;
function setLastPointer(pt) {
  lastPointer = pt;
}
function armCardLinks() {
  const body = $("#detail-body");
  if (!body)
    return;
  body.hoverLink = null;
  const under = lastPointer ? document.elementFromPoint(lastPointer.x, lastPointer.y) : null;
  body.pendingLink = under?.closest?.("a[data-loc]") && body.contains(under) ? under.closest("a[data-loc]") : null;
}
function renderDetail() {
  const l = state.byId.get(state.selected);
  if (!l)
    return closeDetail();
  const cat = state.cats.get(l.cat), g = state.groupOfCat.get(l.cat);
  const ok = applicable(l), isFound = state.found.has(l.id);
  const refs = referrersOneWay(l);
  let only = "";
  if (l.tags.length && l.tags.length < state.tags.length) {
    const names = l.tags.map((id) => state.tags.find((t) => t.id === id)?.title).filter(Boolean);
    only = `<p class="d-note">Only on ${esc(names.join(", "))}.</p>`;
  }
  const notHere = !ok ? `<p class="d-note">This marker is not shown on ${esc(state.tag === UNTAGGED ? "Only untagged" : state.tags.find((t) => t.id === state.tag)?.title || "this setting")}.</p>` : "";
  const shots = l.media.map((m) => mediaHtml(m, l)).join("");
  const backrefs = refs.length ? `<div class="d-backrefs"><h3>Referenced by</h3><ul>${refs.map((r) => `<li><a href="#loc=${r.id}" data-loc="${r.id}">${esc(r.title)}</a></li>`).join("")}</ul></div>` : "";
  const body = $("#detail-body");
  body.innerHTML = `<div class="d-cat" style="--c:${l.user && cat?.icon ? "#" + cat.icon.slice(3).replace("-t", "") : g ? g.col : "#888"}"><i></i>${esc(cat?.title || "")}</div>` + `<h2 class="d-title">${esc(l.title)}</h2>` + (l.user ? state.um.detailHtml(l) : "") + `<div class="d-actions">${ok ? `<button class="found-btn${isFound ? " on" : ""}" type="button" aria-pressed="${isFound}">${isFound ? "Found. Tap to undo" : "Mark as found"}</button>` : ""}` + '<button class="share-btn" type="button" aria-label="Share this marker" title="Share"><svg viewBox="0 0 24 24" aria-hidden="true"><g class="glyph"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.4 10.8l7.2-4.4M8.4 13.2l7.2 4.4"/></g><path class="tick" d="M5 12.5l4.5 4.5L19 7.5"/></svg></button></div>' + `<div class="d-desc">${renderMd(l.desc)}</div>` + only + notHere + (shots ? `<div class="shots">${shots}</div>` : "") + backrefs;
  const backBtn = $("#detail-back");
  if (backBtn)
    backBtn.hidden = state.trail.length < 2;
  const detail = $("#detail");
  clearTimeout(detail.outTimer);
  detail.classList.remove("leaving");
  detail.hidden = false;
  detail.classList.toggle("user-loc", !!l.user);
  if (l.user && cat?.icon)
    detail.style.setProperty("--c", "#" + cat.icon.slice(3).replace("-t", ""));
  else
    detail.style.removeProperty("--c");
  document.body.classList.add("detail-open");
  body.querySelectorAll(".shots img").forEach((img) => img.addEventListener("error", () => {
    img.replaceWith(Object.assign(document.createElement("p"), {
      className: "d-note",
      textContent: "Screenshot not downloaded."
    }));
  }));
  armCardLinks();
  updateLinks();
}
var YOUTUBE = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/;
function mediaHtml(m, l) {
  const alt = esc(m.title || l.title);
  const yt = YOUTUBE.exec(m.url || "") || (m.type === "youtube" && /^[\w-]{11}$/.test(m.file_name || "") ? [null, m.file_name] : null);
  if (yt) {
    return `<div class="shot-video"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="${alt}" loading="lazy" ` + `allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`;
  }
  if (!m.url)
    return "";
  const isImage = m.type === "image" || (m.mime_type || "").startsWith("image/");
  if (!isImage)
    return `<p class="d-note"><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.title || "Video")}</a></p>`;
  const file = decodeURIComponent(new URL(m.url).pathname.split("/").pop());
  return `<img loading="lazy" src="${esc(state.folder + "/media/" + file)}" alt="${alt}">`;
}
var ctxMenu = null;
var ctxItems = [];
var ctxOpenedAt = 0;
function ctxEl() {
  if (!ctxMenu) {
    ctxMenu = document.createElement("div");
    ctxMenu.id = "ctx-menu";
    ctxMenu.className = "menu row-menu ctx";
    ctxMenu.hidden = true;
    ctxMenu.setAttribute("role", "menu");
    ctxMenu.onclick = (e) => {
      const b = e.target.closest("[data-i]");
      if (!b)
        return;
      const it = ctxItems[+b.dataset.i];
      closeCtx();
      it?.fn?.();
    };
    document.body.appendChild(ctxMenu);
  }
  return ctxMenu;
}
function closeCtx() {
  if (ctxMenu)
    ctxMenu.hidden = true;
  ctxItems = [];
}
function closeCtxIfOutside(e) {
  if (!e.target.closest("#ctx-menu") && Date.now() - ctxOpenedAt > 350)
    closeCtx();
}
function openCtx(x, y, { title = "", items }) {
  const el = ctxEl();
  ctxItems = items;
  el.innerHTML = (title ? `<div class="rm-head"><div class="rm-text"><div class="rm-title">${esc(title)}</div></div></div><hr>` : "") + items.map((it, i) => it.sep ? "<hr>" : `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ""}>${svgIcon(it.icon)}<span>${esc(it.label)}</span></button>`).join("");
  el.hidden = false;
  const { offsetWidth: w, offsetHeight: h } = el, pad = 8;
  let lx = x + 4;
  if (lx + w > innerWidth - pad)
    lx = x - w - 4;
  el.style.left = Math.max(pad, Math.min(lx, innerWidth - w - pad)) + "px";
  el.style.top = Math.max(pad, Math.min(y, innerHeight - h - pad)) + "px";
  ctxOpenedAt = Date.now();
}
function setFound(id, on) {
  if (on)
    state.found.add(id);
  else
    state.found.delete(id);
  scheduleSave();
  updateSidebar();
  refreshMap();
  if (state.selected === id)
    renderDetail();
}
async function shareLocation(pos) {
  const packed = await packMarker({ title: "Shared location", lat: pos.lat, lng: pos.lng, map: state.mapInfo.slug });
  const url = new URL(location.href);
  url.hash = "";
  url.search = new URLSearchParams({ tm: packed, map: state.mapInfo.slug }).toString();
  await deliverLink(url.href, null);
}
function spotMenu(ll, x, y) {
  const pos = { lat: ll.lat, lng: ll.lng };
  openCtx(x, y, {
    items: [
      { icon: "pin", label: "Add marker here", fn: () => state.um.placeAt(pos, false) },
      { icon: "tempPin", label: "Add temporary marker here", fn: () => state.um.placeAt(pos, true) },
      { sep: true },
      { icon: "share", label: "Share this location", fn: () => shareLocation(pos) }
    ]
  });
}
function markerMenu(l, x, y) {
  const found = state.found.has(l.id);
  const items = [
    {
      icon: found ? "open" : "check",
      label: found ? "Mark as not found" : "Mark as found",
      fn: () => setFound(l.id, !found)
    },
    { icon: "share", label: "Share", fn: () => shareMarker(l.id, null) },
    { icon: "card", label: "Open card", fn: () => select(l.id, { fly: false }) }
  ];
  if (l.user) {
    items.push({ sep: true });
    if (l.temp)
      items.push({ icon: "save", label: "Make permanent", fn: () => state.um.detailAction("promote", l.id) });
    items.push({ icon: "pencil", label: "Edit", fn: () => state.um.detailAction("edit", l.id) });
    items.push({ icon: "move", label: "Move", fn: () => state.um.detailAction("move", l.id) });
    items.push({ icon: "trash", label: "Delete", danger: true, fn: () => state.um.detailAction("delete", l.id) });
  }
  openCtx(x, y, { title: l.title, items });
}
function markerAt(pt) {
  const k = iconScale(state.map.getZoom());
  let best = null, bestD = Infinity;
  for (const f of state.map.queryRenderedFeatures(pt, { layers: ["locs"] })) {
    const l = state.byId.get(Number(f.properties.id));
    if (!l)
      continue;
    const p = state.map.project([l.lng, l.lat]);
    const d = Math.hypot(pt.x - p.x, pt.y - (p.y - 22 * k));
    if (d <= 26 * k && d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}
function mapMenuAt(x, y, pt, ll) {
  const l = markerAt(pt);
  if (l)
    markerMenu(l, x, y);
  else
    spotMenu(ll, x, y);
}
async function shareMarker(id, btn) {
  const l = state.byId.get(id);
  if (!l)
    return;
  const url = new URL(location.href);
  url.hash = "";
  if (l.user) {
    const own = l.temp ? null : (state.profile?.userCats || []).find((c) => c.id === l.cat) || null;
    const packed = await packMarker({
      title: l.title,
      category: own?.title || "",
      color: own?.color || null,
      glyph: own?.glyph || null,
      desc: l.desc,
      lat: l.lat,
      lng: l.lng,
      map: state.mapInfo.slug,
      links: (l.links || []).filter((lid) => lid > 0)
    });
    url.search = new URLSearchParams({ tm: packed, map: state.mapInfo.slug }).toString();
  } else {
    url.search = new URLSearchParams({ loc: String(id), map: state.mapInfo.slug }).toString();
  }
  await deliverLink(url.href, btn);
}
async function deliverLink(url, btn) {
  const mouse = matchMedia("(pointer: fine)").matches;
  if (!mouse && navigator.share) {
    try {
      return await navigator.share({ title: state.entry.title, url });
    } catch (e) {
      if (e.name === "AbortError")
        return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    if (btn)
      flashCopied(btn);
    else
      toast("Link copied");
  } catch {
    if (btn)
      showLinkFallback(url);
    else
      await askDialog({ title: "Copy this link", value: url, okLabel: "Done" });
  }
}
var copiedTimer = null;
function flashCopied(btn) {
  if (!btn)
    return;
  btn.classList.remove("copied");
  btn.offsetWidth;
  btn.classList.add("copied");
  btn.title = "Link copied";
  if (copiedTimer)
    clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    btn.classList.remove("copied");
    btn.title = "Share";
  }, 1800);
}
function showLinkFallback(url) {
  const body = $("#detail-body");
  if (!body)
    return;
  body.querySelector(".share-fallback")?.remove();
  const p = document.createElement("p");
  p.className = "share-fallback";
  p.innerHTML = `Copy this link: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  (body.querySelector(".d-actions") || body.firstElementChild)?.after(p);
}
function toggleFound(id) {
  state.found.has(id) ? state.found.delete(id) : state.found.add(id);
  scheduleSave();
  updateSidebar();
  refreshMap();
  renderDetail();
}

// src/shared/sync-rules.ts
var TOUCH_FIELD = "updated";
var POSITION_FIELDS = [TOUCH_FIELD, "map", "cameras"];
function stable(v) {
  if (v && typeof v === "object") {
    if (Array.isArray(v))
      return `[${v.map(stable).join(",")}]`;
    const obj = v;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stable(obj[k])).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
function without(key, v, fields) {
  if (!key.startsWith("profile:") || !v || typeof v !== "object" || Array.isArray(v))
    return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !fields.includes(k)));
}
var contentKey = (key, v) => stable(without(key, v, POSITION_FIELDS));
var sendKey = (key, v) => stable(without(key, v, [TOUCH_FIELD]));
function fnv(s) {
  let h = 2166136261;
  for (let i = 0;i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// src/client/sync.ts
var CHANNEL = "va-sync";
var LOCK = "va-sync-leader";
var BATCH = 100;
function createSync({
  store,
  ui,
  api,
  socketUrl = null
}) {
  const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  let leader = false, running = false, online = typeof navigator !== "undefined" ? navigator.onLine : true;
  let st = { sent: {}, content: {}, seen: {}, conflicts: {} };
  let pushTimer = null;
  let interval = null;
  let stopped = false, again = false;
  const clientId = crypto.randomUUID();
  let sock = null;
  let sockTimer = null;
  let sockFails = 0, live = false;
  const sendHash = (key, v) => v === null || v === undefined ? null : fnv(sendKey(key, v));
  const contentHash = (key, v) => v === null || v === undefined ? null : fnv(contentKey(key, v));
  async function snapshot() {
    const map = new Map;
    for (const p of await store.profiles()) {
      const { key: _key, ...v } = p;
      map.set(`profile:${p.game}:${p.id}`, v);
    }
    for (const e of await store.metaEntries()) {
      if (/^presets:/.test(e.k))
        map.set(`meta:${e.k}`, e.v);
    }
    return map;
  }
  const isDirty = (key, snap) => {
    if (!(key in st.content) && key in st.sent) {
      return (snap.has(key) ? sendHash(key, snap.get(key)) : null) !== st.sent[key];
    }
    const cur = snap.has(key) ? contentHash(key, snap.get(key)) : null;
    return cur !== (st.content[key] ?? null);
  };
  async function applyRemote(item) {
    if (item.key.startsWith("profile:")) {
      const [, game, id] = item.key.split(":");
      if (item.value === null)
        await store.deleteProfile(`${game}:${id}`);
      else
        await store.putProfile({ ...item.value, key: `${game}:${id}`, game, id });
    } else {
      const k = item.key.slice(5);
      if (item.value === null)
        await store.removeMeta(k);
      else
        await store.putMeta(k, item.value);
    }
  }
  async function loadState() {
    const saved = await store.getMeta("sync:state");
    if (saved)
      st = {
        sent: saved.sent || {},
        content: saved.content || {},
        seen: saved.seen || {},
        conflicts: saved.conflicts || {}
      };
  }
  const saveState = () => store.putMeta("sync:state", st);
  async function adoptOverPlaceholders(key) {
    const game = key.split(":")[1];
    for (const p of await store.profiles()) {
      const k = `profile:${p.game}:${p.id}`;
      if (p.game === game && k !== key && !(k in st.sent) && store.isEmpty(p))
        await store.deleteProfile(`${p.game}:${p.id}`);
    }
  }
  async function pull() {
    const { items } = await api("GET", "sync");
    const snap = await snapshot();
    const changed = [];
    for (const item of items) {
      if ((st.seen[item.key] ?? 0) >= item.updated_at)
        continue;
      if (isDirty(item.key, snap)) {
        st.conflicts[item.key] = { server: item.value, updated_at: item.updated_at };
        continue;
      }
      if (item.key.startsWith("profile:") && item.value !== null)
        await adoptOverPlaceholders(item.key);
      await applyRemote(item);
      st.sent[item.key] = sendHash(item.key, item.value);
      st.content[item.key] = contentHash(item.key, item.value);
      st.seen[item.key] = item.updated_at;
      changed.push(item.key);
    }
    if (changed.length) {
      bc?.postMessage({ type: "remote", keys: changed });
      await ui.remoteChanged(changed);
    }
    if (Object.keys(st.conflicts).length)
      ui.conflicts(conflictList());
  }
  async function push() {
    const snap = await snapshot();
    const items = [];
    for (const [key, value] of snap) {
      if (st.sent[key] !== sendHash(key, value))
        items.push({ key, value, base: st.seen[key] ?? 0 });
    }
    for (const key of Object.keys(st.sent)) {
      if (!snap.has(key) && st.sent[key] !== null)
        items.push({ key, value: null, base: st.seen[key] ?? 0 });
    }
    for (let i = 0;i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const { results } = await api("POST", "sync", { items: batch, client: clientId });
      const sent = new Map(batch.map((it) => [it.key, it]));
      for (const r of results) {
        const it = sent.get(r.key);
        if (r.status === "ok") {
          st.sent[r.key] = sendHash(r.key, it.value);
          st.content[r.key] = contentHash(r.key, it.value);
          st.seen[r.key] = r.updated_at;
          delete st.conflicts[r.key];
        } else {
          st.conflicts[r.key] = { server: r.value, updated_at: r.updated_at };
        }
      }
    }
    if (Object.keys(st.conflicts).length)
      ui.conflicts(conflictList());
  }
  const conflictList = () => Object.keys(st.conflicts).map((key) => ({ key, label: labelFor(key) }));
  const labelFor = (key) => {
    if (key.startsWith("profile:"))
      return `Progress for "${key.split(":")[2]}"`;
    return "Selection presets";
  };
  async function cycle() {
    if (!leader || stopped)
      return;
    if (running) {
      again = true;
      return;
    }
    if (!online)
      return;
    running = true;
    try {
      await loadState();
      await pull();
      await push();
      await saveState();
      setOnline(true);
    } catch (e) {
      if (e.status === 401) {
        stopped = true;
        sock?.close();
        ui.signedOut();
      } else if (e.network)
        setOnline(false);
      else
        console.error("sync:", e);
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        schedulePush(0);
      }
    }
  }
  const POLL_FAST = 60000, POLL_SLOW = 5 * 60000;
  function setPolling(ms) {
    if (interval)
      clearInterval(interval);
    interval = setInterval(cycle, ms);
    interval.unref?.();
  }
  function openSocket() {
    if (!socketUrl || !leader || stopped || !online || sock || typeof WebSocket === "undefined")
      return;
    let ws;
    try {
      ws = new WebSocket(socketUrl(clientId));
    } catch {
      return scheduleSocket();
    }
    sock = ws;
    ws.onopen = () => {
      sockFails = 0;
    };
    ws.onmessage = (ev) => {
      let m = null;
      try {
        m = JSON.parse(String(ev.data));
      } catch {}
      if (m?.type === "hello") {
        live = true;
        setPolling(POLL_SLOW);
        cycle();
      } else if (m?.type === "changed")
        cycle();
    };
    ws.onclose = (ev) => {
      if (sock === ws)
        sock = null;
      if (live) {
        live = false;
        setPolling(POLL_FAST);
      }
      if (ev.code === 4401)
        return;
      sockFails++;
      scheduleSocket();
    };
    ws.onerror = () => {};
  }
  function scheduleSocket() {
    if (sockTimer)
      clearTimeout(sockTimer);
    if (!socketUrl || !leader || stopped)
      return;
    const wait = Math.min(5 * 60000, 1000 * 2 ** Math.min(sockFails, 9)) * (0.75 + Math.random() * 0.5);
    sockTimer = setTimeout(openSocket, wait);
    sockTimer.unref?.();
  }
  function setOnline(v) {
    if (online === v)
      return;
    online = v;
    bc?.postMessage({ type: "status", online: v });
    ui.status({ online: v });
  }
  async function resolveConflicts(choice) {
    await loadState();
    const taken = [];
    for (const key of Object.keys(st.conflicts)) {
      const c = st.conflicts[key];
      if (choice === "server") {
        await applyRemote({ key, value: c.server, updated_at: c.updated_at });
        st.sent[key] = sendHash(key, c.server);
        st.content[key] = contentHash(key, c.server);
        taken.push(key);
      }
      st.seen[key] = c.updated_at;
      delete st.conflicts[key];
    }
    await saveState();
    if (taken.length) {
      bc?.postMessage({ type: "remote", keys: taken });
      await ui.remoteChanged(taken);
    }
    schedulePush(0);
  }
  function schedulePush(ms = 1500) {
    if (pushTimer)
      clearTimeout(pushTimer);
    pushTimer = setTimeout(cycle, ms);
    pushTimer.unref?.();
  }
  bc?.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "local" && leader)
      schedulePush();
    if (m.type === "remote" && !leader)
      ui.remoteChanged(m.keys || []);
    if (m.type === "status" && !leader)
      ui.status({ online: m.online });
  });
  bc?.unref?.();
  function start() {
    const hold = () => new Promise(() => {});
    const becomeLeader = () => {
      leader = true;
      cycle();
      setPolling(POLL_FAST);
      openSocket();
      return hold();
    };
    if (navigator.locks)
      navigator.locks.request(LOCK, becomeLeader);
    else
      becomeLeader();
    addEventListener("online", () => {
      setOnline(true);
      cycle();
      sockFails = 0;
      if (sockTimer)
        clearTimeout(sockTimer);
      openSocket();
    });
    addEventListener("offline", () => {
      setOnline(false);
      sock?.close();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible")
        cycle();
    });
  }
  function stop() {
    stopped = true;
    if (pushTimer)
      clearTimeout(pushTimer);
    if (interval)
      clearInterval(interval);
    if (sockTimer)
      clearTimeout(sockTimer);
    sock?.close();
    bc?.close();
  }
  return {
    start,
    stop,
    noteLocal() {
      bc?.postMessage({ type: "local" });
      if (leader)
        schedulePush();
    },
    resolveConflicts,
    isLeader: () => leader
  };
}

// src/client/app.ts
var syncer = null;
setSyncNote(() => syncer?.noteLocal());
var accountReady = Promise.resolve(null);
async function startAccountSync() {
  await accountReady;
  if (!currentUser())
    return;
  syncer = createSync({
    store: syncStore,
    api,
    socketUrl,
    ui: {
      status: ({ online }) => setOnlineStatus(online),
      conflicts: (list) => showConflicts(list),
      remoteChanged: async (keys) => {
        await refreshFromStore(keys);
        if (keys.length)
          toast("Updated from your other device.");
      },
      signedOut: () => location.reload()
    }
  });
  syncer.start();
}
async function refreshFromStore(keys) {
  const gid = state.entry?.id;
  if (!gid || !state.profile)
    return;
  if (keys.some((k) => k.startsWith(`profile:${gid}:`))) {
    state.profiles = (await dbAll("profiles")).filter((p) => p.game === gid).sort((a, b) => a.created - b.created);
    let cur = state.profiles.find((p) => p.id === state.profile.id) || state.profiles[0];
    if (cur && emptyProfile(cur)) {
      const withProgress = state.profiles.filter((p) => !emptyProfile(p)).sort((x, y) => (y.updated || 0) - (x.updated || 0))[0];
      if (withProgress)
        cur = withProgress;
    }
    if (cur) {
      state.drawing?.animateNext();
      applyProfile(cur);
      renderProfileSelect();
      if (state.mapInfo)
        await loadMapState();
      if (viewUntouched()) {
        if (cur.map && cur.map !== state.mapInfo?.slug && state.meta.maps.some((m) => m.slug === cur.map)) {
          await switchMap(cur.map, { remember: false });
          agreeCamera();
        } else {
          const cam = cur.cameras?.[state.mapInfo?.slug];
          if (cam && state.mapReady && !sameCamera(cam, cameraNow()))
            glideTo(cam);
        }
      }
    }
  }
  if (keys.some((k) => k === `meta:${presetsKey()}`))
    await loadMapState();
  refreshAll();
}
function showConflicts(list) {
  const d = $("#dlg");
  const form = $("#dlg-form");
  if (!list.length || d.open)
    return;
  form.innerHTML = "<h2>Your changes and the server's disagree</h2>" + "<p>You have unsynced changes on this device, and the server has newer data for: " + list.map((i) => esc(i.label)).join(", ") + ".</p>" + `<div class="dlg-actions"><button type="button" data-keep="local">Overwrite with this device's data</button>` + `<button type="button" class="primary" data-keep="server">Use the server's data</button></div>`;
  form.onsubmit = (e) => e.preventDefault();
  const pick = async (which) => {
    d.close();
    try {
      await syncer?.resolveConflicts(which);
    } catch (e) {
      console.error(e);
    }
    if (which === "server")
      location.reload();
  };
  form.querySelector('[data-keep="server"]').onclick = () => pick("server");
  form.querySelector('[data-keep="local"]').onclick = () => pick("local");
  d.showModal();
}
async function boot() {
  try {
    await openDB();
  } catch {
    state.memoryOnly = true;
    toast("Storage is unavailable here, so progress will not be kept after this tab closes.", 6000);
  }
  let index;
  try {
    index = await fetchJSON("../index.json");
  } catch {
    fatal('Could not load maps/index.json. Serve this folder over HTTP (for example with "npx serve").');
    return;
  }
  const pathMatch = location.pathname.match(/\/maps\/([^/]+)/);
  const slug = document.body.dataset.game || (pathMatch ? decodeURIComponent(pathMatch[1]) : "");
  const entry = index.games.find((g) => g.slug === slug);
  if (!entry) {
    fatal(`maps/index.json has no game with slug "${slug}".`);
    return;
  }
  if (index.games)
    storeGameTitles(index.games);
  document.body.dataset.game = entry.slug;
  if (!document.title || document.title === "Verticordia Atlas" || document.title === "Map · Verticordia Atlas") {
    document.title = `${entry.title} · Verticordia Atlas`;
  }
  const ok = await loadGame(entry);
  if (ok)
    startAccountSync();
}
function wire() {
  setupTitleRow();
  arrangeSidebar();
  wireTagStrict();
  const scroll = document.querySelector("#side .side-scroll"), groups = document.getElementById("groups");
  if (scroll && groups && !scroll.querySelector(".groups-throbber")) {
    const t = document.createElement("div");
    t.className = "groups-throbber";
    t.setAttribute("aria-hidden", "true");
    scroll.insertBefore(t, groups);
  }
  new MutationObserver(() => {
    const side = document.getElementById("side");
    if (side)
      side.inert = document.body.classList.contains("loading-map") || document.body.classList.contains("profile-switch");
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  onThemeChange(() => {
    if (state.entry)
      applyTheme(state.entry.theme);
  });
  document.querySelector(".side-scroll")?.appendChild(accountSlot());
  document.querySelector(".side-scroll")?.appendChild(legalLinks());
  accountReady = initAccount({ toast });
  $("#profile-select").onchange = (e) => switchProfile(e.target.value);
  const menu = $("#profile-menu"), menuBtn = $("#profile-menu-btn");
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
  };
  menu.onclick = (e) => {
    const b = e.target.closest("button[data-act]");
    if (b && b.dataset.act) {
      menu.hidden = true;
      profileAction(b.dataset.act);
    }
  };
  $("#import-file").onchange = (e) => {
    const input = e.target;
    const f = input.files?.[0];
    input.value = "";
    if (f)
      importFile(f);
  };
  const presetMenu = $("#preset-menu"), presetMenuBtn = $("#preset-menu-btn");
  $("#preset-select").onchange = (e) => {
    const p = presetById(e.target.value);
    if (p)
      applyPreset(p);
    else
      exitPreset();
  };
  $("#preset-bar").onclick = (e) => {
    const b = e.target.closest("button[data-act]");
    if (b && b.dataset.act)
      presetAction(b.dataset.act);
  };
  presetMenuBtn.onclick = (e) => {
    e.stopPropagation();
    presetMenu.hidden = !presetMenu.hidden;
    presetMenuBtn.setAttribute("aria-expanded", String(!presetMenu.hidden));
  };
  presetMenu.onclick = (e) => {
    const b = e.target.closest("button[data-act]");
    if (b && !b.disabled && b.dataset.act) {
      presetMenu.hidden = true;
      presetAction(b.dataset.act);
    }
  };
  $("#tag-select").onchange = (e) => {
    const val = e.target.value;
    state.tag = val === "" ? null : val === UNTAGGED ? UNTAGGED : Number(val);
    syncTagStrict();
    scheduleViewSave();
    refreshAll();
  };
  $("#hide-found").onchange = (e) => {
    state.view.hideFound = e.target.checked;
    onViewChanged();
  };
  $("#show-all").onclick = () => {
    state.view.hidden.clear();
    onViewChanged();
  };
  $("#hide-all").onclick = () => {
    state.cats.forEach((c) => state.view.hidden.add(c.id));
    onViewChanged();
  };
  const search = $("#search");
  const results = $("#results");
  const resultsBar = $("#results-bar");
  search.oninput = () => runSearch();
  search.onfocus = () => {
    if (search.value.trim())
      runSearch();
  };
  search.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveSearch(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const all = results.querySelectorAll("li.result");
      const target = state.search.idx >= 0 ? all[state.search.idx] : all[0];
      if (target)
        openResult(target);
    }
  };
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !["f", "k"].includes(e.key.toLowerCase()) || $("#dlg").open)
      return;
    e.preventDefault();
    search.focus();
    search.select();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.search.active || $("#dlg").open)
      return;
    search.value = "";
    leaveSearch();
  });
  results.onclick = (e) => {
    const target = e.target;
    const a = target.closest("a");
    if (a) {
      if (a.dataset.loc) {
        e.preventDefault();
        select(Number(a.dataset.loc));
      }
      return;
    }
    const li = target.closest("li.result");
    if (li)
      openResult(li);
  };
  results.onpointerover = (e) => {
    if (e.pointerType !== "mouse")
      return;
    const li = e.target.closest("li.result");
    if (!li || li === results.hoverRow)
      return;
    results.hoverRow = li;
    clearTimeout(results.hoverTimer);
    results.hoverTimer = setTimeout(() => previewRow(li), HOVER_MS);
  };
  results.onpointerout = (e) => {
    const row = results.hoverRow;
    if (row && e.target.closest("li.result") === row && !row.contains(e.relatedTarget)) {
      clearTimeout(results.hoverTimer);
      results.hoverRow = null;
    }
  };
  results.onpointerleave = () => {
    clearTimeout(results.hoverTimer);
    results.hoverRow = null;
    endPreview();
  };
  resultsBar.onclick = (e) => {
    const b = e.target.closest("button[data-scope]");
    if (b) {
      state.search.scope = b.dataset.scope;
      runSearch();
    }
  };
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target.closest("#row-menu, .row-menu-btn"))
      closeRowMenu();
    if (!target.closest(".profile-row"))
      menu.hidden = true;
    if (!target.closest(".preset-row"))
      presetMenu.hidden = true;
    if (!target.closest("#side-more")) {
      const smm = $("#side-more-menu");
      if (smm && !smm.hidden) {
        smm.hidden = true;
        $("#side-more-btn")?.setAttribute("aria-expanded", "false");
      }
    }
    closeCtxIfOutside(e);
  });
  $("#detail-close").onclick = closeDetail;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCtx();
      closeRowMenu();
      const smm = $("#side-more-menu");
      if (smm && !smm.hidden) {
        smm.hidden = true;
        $("#side-more-btn")?.setAttribute("aria-expanded", "false");
      }
    }
  });
  addEventListener("resize", closeRowMenu);
  document.addEventListener("scroll", (e) => {
    if (!e.target.closest?.("#row-menu"))
      closeRowMenu();
  }, true);
  $("#detail-back").onclick = goBack;
  addEventListener("popstate", onPopState);
  const detailBody = $("#detail-body");
  detailBody.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse")
      return;
    const a = e.target.closest("a[data-loc]");
    if (!a || a === detailBody.hoverLink || a === detailBody.pendingLink)
      return;
    detailBody.hoverLink = a;
    clearTimeout(detailBody.hoverTimer);
    detailBody.hoverTimer = setTimeout(() => {
      if (detailBody.hoverLink === a)
        previewAt(state.byId.get(Number(a.dataset.loc)));
    }, HOVER_MS);
  });
  detailBody.addEventListener("pointerout", (e) => {
    const a = e.target.closest("a[data-loc]");
    if (a && !a.contains(e.relatedTarget)) {
      if (a === detailBody.pendingLink)
        detailBody.pendingLink = null;
      if (a === detailBody.hoverLink) {
        clearTimeout(detailBody.hoverTimer);
        detailBody.hoverLink = null;
      }
    }
  });
  detailBody.addEventListener("pointerleave", () => {
    clearTimeout(detailBody.hoverTimer);
    detailBody.hoverLink = null;
    endPreview();
  });
  document.addEventListener("pointermove", (e) => {
    setLastPointer({ x: e.clientX, y: e.clientY });
  }, { passive: true });
  detailBody.addEventListener("click", (e) => {
    const target = e.target;
    if (target.closest(".found-btn"))
      return toggleFound(state.selected);
    if (target.closest(".share-btn")) {
      shareMarker(state.selected, target.closest(".share-btn"));
      return;
    }
    const um = target.closest("[data-um]");
    if (um)
      return state.um.detailAction(um.dataset.um, state.selected);
    const a = target.closest("a[data-loc]");
    if (a) {
      e.preventDefault();
      endPreview({ restore: false });
      return select(Number(a.dataset.loc));
    }
    const img = target.closest(".shots img");
    if (img) {
      const lb = $("#lightbox");
      lb.querySelector("img").src = img.src;
      lb.hidden = false;
    }
  });
  $("#lightbox").onclick = () => {
    $("#lightbox").hidden = true;
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape")
      return;
    const lb = $("#lightbox");
    if (!lb.hidden)
      lb.hidden = true;
    else if (!$("#dlg").open && state.selected != null && document.activeElement !== search)
      closeDetail();
  });
  $("#side-toggle").onclick = () => document.body.classList.add("side-open");
  $("#side-close").onclick = () => {
    if (state.search.active) {
      $("#search").value = "";
      leaveSearch();
    } else
      document.body.classList.remove("side-open");
  };
  $("#side-collapse").onclick = () => setSideCollapsed(!document.body.classList.contains("side-collapsed"));
  addEventListener("pagehide", () => {
    saveSession();
    rememberCamera(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden")
      rememberCamera(true);
  });
}
if (typeof document !== "undefined") {
  wire();
  boot().catch((e) => fatal(e.message));
}
export {
  startAccountSync
};
