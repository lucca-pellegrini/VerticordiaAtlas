// src/shared/escape.ts
var esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var fmt = (n) => Number(n).toLocaleString();

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
var user = null;
var toastFn = null;
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
var ICONS = {
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
    root.innerHTML = `<span class="theme-thumb" aria-hidden="true"></span>` + MODES.map((m) => `<button type="button" class="theme-opt" role="radio" data-theme-opt="${m}" aria-checked="false" aria-label="${TITLES[m]}" title="${TITLES[m]}">` + `${ICONS[m]}<span class="theme-opt-label">${LABELS[m]}</span>` + `</button>`).join("");
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
    root.innerHTML = `<span class="theme-thumb" aria-hidden="true">` + `<span class="theme-thumb-auto">${ICONS.auto}</span>` + `</span>` + `<button type="button" class="theme-opt" role="radio" data-theme-opt="light" aria-checked="false" aria-label="${TITLES.light}">` + `${ICONS.light}<span class="theme-opt-label">${LABELS.light}</span>` + `</button>` + `<button type="button" class="theme-opt" role="radio" data-theme-opt="dark" aria-checked="false" aria-label="${TITLES.dark}">` + `${ICONS.dark}<span class="theme-opt-label">${LABELS.dark}</span>` + `</button>`;
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

// src/client/home.ts
var ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
function card(g, i) {
  const href = `maps/${encodeURIComponent(g.slug)}/`;
  const accent = g.theme?.accent && CSS.supports("color", g.theme.accent) ? ` style="--accent:${esc(g.theme.accent)}"` : "";
  const single = /\.(jpe?g|png|webp|avif)$/i.test(g.poster || "");
  const eager = i === 0 ? ' fetchpriority="high"' : "";
  const img = !g.poster ? "" : single ? `<div class="card-media"><img src="maps/${esc(g.poster)}" width="1200" height="600" alt="${esc(g.posterAlt || "")}" ` + `loading="${i === 0 ? "eager" : "lazy"}" decoding="async"${eager}></div>` : `<div class="card-media"><img src="maps/${esc(g.poster)}-1200.webp" srcset="maps/${esc(g.poster)}-600.webp 600w, maps/${esc(g.poster)}-1200.webp 1200w" ` + `sizes="(min-width: 640px) 560px, calc(100vw - 36px)" width="1200" height="600" alt="${esc(g.posterAlt || "")}" ` + `loading="${i === 0 ? "eager" : "lazy"}" decoding="async"${eager}></div>`;
  const stats = (g.stats || []).map((s) => `<li><b>${fmt(s.value)}</b> ${esc(s.label)}</li>`).join("");
  return `<li style="--i:${i + 3}"><a class="card" href="${href}" data-slug="${esc(g.slug)}"${accent}>${img}` + `<div class="card-body"><h3>${esc(g.title)}</h3>` + (g.description ? `<p>${esc(g.description)}</p>` : "") + `<div class="card-foot"><ul class="stats">${stats}</ul><span class="cta">Open map ${ARROW}</span></div></div></a></li>`;
}
function orderGames(games, recentSlugs = []) {
  if (!recentSlugs?.length)
    return games.slice();
  const map = new Map(games.map((g) => [g.slug, g]));
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
  const list = document.getElementById("game-list");
  const fail = (msg) => list.replaceWith(Object.assign(document.createElement("p"), { className: "notice", textContent: msg }));
  let index;
  try {
    const r = await fetch("maps/index.json");
    if (!r.ok)
      throw new Error("HTTP " + r.status);
    index = await r.json();
  } catch {
    fail('Could not load the list of maps. Serve this folder over HTTP (for example with "npx serve") and reload.');
    return;
  }
  if (!index.games?.length) {
    fail("No maps have been added yet.");
    return;
  }
  storeGameTitles(index.games);
  const recent = readRecentGames();
  const games = orderGames(index.games, recent);
  const featured = renderResume(index.games);
  list.innerHTML = games.map(card).join("");
  if (featured) {
    const li = list.querySelector(`a.card[data-slug="${CSS.escape(featured)}"]`)?.closest("li");
    if (li) {
      li.dataset.featured = "";
      li.hidden = true;
    }
  }
  const onOpen = (e) => {
    const a = e.target?.closest("a.card");
    if (!a)
      return;
    const slug = a.dataset.slug;
    const g = index.games.find((x) => x.slug === slug);
    if (g)
      recordGameOpen(g.slug, g.theme, g.title);
  };
  list.addEventListener("click", onOpen);
  list.addEventListener("auxclick", onOpen);
  setupSearch(list);
}
function setupSearch(list) {
  const toggle = document.querySelector(".search-toggle");
  const form = document.getElementById("map-search");
  const input = document.getElementById("map-query");
  const none = document.getElementById("no-results");
  const label = document.getElementById("games-title");
  const partialSection = document.getElementById("partial");
  const partialList = document.getElementById("partial-list");
  if (!toggle || !form || !input)
    return;
  const labelText = label.textContent;
  const cardText = (li) => `${li.querySelector("h3")?.textContent} ${li.querySelector(".card-body > p")?.textContent || ""}`;
  const filter = () => {
    const q = norm(input.value).trim();
    const queryWords = q.split(/\s+/).filter(Boolean);
    const fuzzy = [];
    let exact = 0;
    for (const child of Array.from(list.children)) {
      const li = child;
      if (!q) {
        li.hidden = li.dataset.featured !== undefined && !document.body.classList.contains("searching");
        continue;
      }
      const text = norm(cardText(li));
      if (text.includes(q)) {
        li.hidden = false;
        exact++;
        continue;
      }
      li.hidden = true;
      if (q.length < 4)
        continue;
      const score = fuzzyScore(queryWords, words(cardText(li)));
      if (score !== null)
        fuzzy.push({ li, score, title: li.querySelector("h3").textContent || "" });
    }
    fuzzy.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
    partialList.replaceChildren(...fuzzy.map(({ li }) => {
      const copy = li.cloneNode(true);
      copy.hidden = false;
      return copy;
    }));
    const noExact = !!q && exact === 0;
    label.textContent = q ? "Results" : labelText;
    label.hidden = noExact;
    list.hidden = noExact;
    partialSection.hidden = !q || fuzzy.length === 0;
    none.hidden = !q || exact + fuzzy.length > 0;
  };
  const syncSearching = () => {
    const on = document.activeElement === input || !!input.value.trim();
    if (on === document.body.classList.contains("searching"))
      return;
    document.body.classList.toggle("searching", on);
    filter();
  };
  const setOpen = (open) => {
    form.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      document.getElementById("top-more")?.classList.remove("open");
      document.querySelector(".more-toggle")?.setAttribute("aria-expanded", "false");
      input.focus({ preventScroll: true });
    } else {
      input.value = "";
      filter();
      toggle.focus({ preventScroll: true });
      syncSearching();
    }
  };
  toggle.addEventListener("click", () => setOpen(!form.classList.contains("open")));
  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      setOpen(false);
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  input.addEventListener("focus", syncSearching);
  input.addEventListener("blur", syncSearching);
  input.addEventListener("input", syncSearching);
  document.addEventListener("keydown", (e) => {
    const typing = e.target?.closest?.('input, textarea, select, [contenteditable="true"]');
    const ctrlK = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k";
    const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
    if (!ctrlK && !slash)
      return;
    e.preventDefault();
    if (!form.classList.contains("open"))
      setOpen(true);
    input.focus({ preventScroll: true });
    input.select();
    window.scrollTo({
      top: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  });
}
var HEXCOL = /^#[0-9a-f]{3,8}$/i;
var ICON2 = {
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4-5 2v14l5-2 6 2 5-2V4l-5 2-6-2Zm0 0v14m6-12v14"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3-8.7 8.7-8.3-8.3Z"/><circle cx="8" cy="8" r="1.4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.2"/></svg>',
  pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5 4 20Z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};
function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem("va_last_session") || "null");
    return s && s.v === 1 && typeof s.slug === "string" ? s : null;
  } catch {
    return null;
  }
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (!Number.isFinite(s) || s < 45)
    return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const mins = s / 60, hours = mins / 60, days = hours / 24;
  if (mins < 60)
    return rtf.format(-Math.round(mins), "minute");
  if (hours < 24)
    return rtf.format(-Math.round(hours), "hour");
  if (days < 7)
    return rtf.format(-Math.round(days), "day");
  if (days < 30)
    return rtf.format(-Math.round(days / 7), "week");
  if (days < 365)
    return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}
function posterSrc(g, size) {
  if (!g.poster)
    return "";
  return /\.(jpe?g|png|webp|avif)$/i.test(g.poster) ? `maps/${g.poster}` : `maps/${g.poster}-${size}.webp`;
}
var pct = (f, n) => n ? Math.floor(1000 * f / n) / 10 : 0;
var colour = (c) => HEXCOL.test(c || "") ? c : "var(--accent)";
function renderResume(gamesList) {
  const s = readSession();
  const g = s && gamesList.find((x) => x.slug === s.slug);
  const root = document.getElementById("resume");
  const hero = document.getElementById("hero");
  if (!s || !g || !root || !hero || !(s.total > 0))
    return null;
  const href = `maps/${encodeURIComponent(g.slug)}/`;
  const mapHref = (slug) => `${href}?map=${encodeURIComponent(slug)}`;
  const accent = HEXCOL.test(g.theme?.accent || "") ? g.theme.accent : null;
  const soft = HEXCOL.test(g.theme?.["accent-soft"] || "") ? g.theme["accent-soft"] : null;
  const style = [accent && `--accent:${accent}`, soft && `--g-soft:${soft}`].filter(Boolean).join(";");
  const p = pct(s.found, s.total), left = Math.max(0, s.total - s.found), done = left === 0;
  const maps = Array.isArray(s.maps) ? s.maps : [];
  const mapIdx = maps.findIndex((m) => m.slug === s.map);
  const groups = (Array.isArray(s.groups) ? s.groups : []).filter((x) => x && x.n > 0);
  const legend = [...groups].sort((a, b) => b.n - a.n).slice(0, 6);
  const more = groups.length - legend.length;
  const R = 52, C = 2 * Math.PI * R;
  const totalProfiles = Array.isArray(s.profiles) ? s.profiles.length : typeof s.profiles === "number" ? s.profiles : 1;
  const profileList = Array.isArray(s.profiles) ? s.profiles : [];
  const otherProfiles = profileList.filter((pr) => pr && pr.id && pr.name && pr.name !== s.profile && pr.id !== s.profileId).slice(0, 6);
  const profileHref = (id) => `${href}?profile=${encodeURIComponent(id)}`;
  const chips = [
    maps.length > 1 ? `<li title="Map">${ICON2.map}<span>${esc(s.mapTitle || s.map)}${mapIdx >= 0 ? `<small>${mapIdx + 1} of ${maps.length}</small>` : ""}</span></li>` : "",
    s.profile ? `<li title="Profile">${ICON2.user}<span>${esc(s.profile)}${totalProfiles > 1 ? `<small>${fmt(totalProfiles)} profiles</small>` : ""}</span></li>` : "",
    s.tag ? `<li title="${esc(s.tagLabel || "Filter")}">${ICON2.tag}<span><small>${esc(s.tagLabel || "Filter")}</small>${esc(s.tag)}</span></li>` : ""
  ].join("");
  const recent = (Array.isArray(s.recent) ? s.recent : []).slice(0, 4).map((r) => `<li style="--c:${colour(r.c)}"><span class="dot" aria-hidden="true"></span><span class="what">${esc(r.t)}</span>` + (r.cat && r.cat !== r.t ? `<span class="cat">${esc(r.cat)}</span>` : "") + `</li>`).join("");
  const nearScore = (r) => r.f / r.n * (1 - 1 / Math.sqrt(r.n + 1));
  const nearList = (Array.isArray(s.near) ? s.near : []).filter((r) => r && r.n > 0 && r.f > 0 && r.f < r.n).sort((a, b) => nearScore(b) - nearScore(a) || b.f / b.n - a.f / a.n || b.n - a.n);
  const near = nearList.slice(0, 3).map((r) => `<li style="--c:${colour(r.c)}"><div class="near-row"><span class="what">${esc(r.t)}</span><span class="num"><b>${fmt(r.f)}</b>/${fmt(r.n)}</span></div>` + `<div class="mini" aria-hidden="true"><i data-w="${pct(r.f, r.n)}"></i></div><span class="hint">${fmt(r.n - r.f)} left</span></li>`).join("");
  const extras = [
    s.userMarkers ? `<li>${ICON2.pin}<b>${fmt(s.userMarkers)}</b> marker${s.userMarkers === 1 ? "" : "s"} placed</li>` : "",
    s.drawings ? `<li>${ICON2.pen}<b>${fmt(s.drawings)}</b> drawing${s.drawings === 1 ? "" : "s"}</li>` : "",
    s.presets ? `<li>${ICON2.layers}<b>${fmt(s.presets)}</b> preset${s.presets === 1 ? "" : "s"}</li>` : ""
  ].join("");
  const otherMaps = maps.filter((m) => m.slug !== s.map).slice(0, 6);
  const img = posterSrc(g, 1200);
  root.innerHTML = `<article class="resume-card${done ? " done" : ""}" style="${style}">` + `<div class="resume-media">` + (img ? `<img src="${esc(img)}" alt="${esc(g.posterAlt || "")}" width="1200" height="600" decoding="async" fetchpriority="high">` : "") + `<div class="resume-ring" role="img" aria-label="${p}% complete">` + `<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="track" cx="60" cy="60" r="${R}"/>` + `<circle class="arc" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}" data-off="${(C * (1 - p / 100)).toFixed(2)}"/></svg>` + `<span class="ring-num">${done ? ICON2.check : `${Math.floor(p)}<small>%</small>`}</span>` + `<span class="ring-label">${done ? "Complete" : "complete"}</span>` + `</div>` + `</div>` + `<div class="resume-body">` + `<header class="resume-head">` + `<p class="resume-eyebrow"><span class="live" aria-hidden="true"></span>Continue where you left off<span class="when"><span class="sep" aria-hidden="true">·</span><time datetime="${new Date(s.updated).toISOString()}">${esc(ago(s.updated))}</time></span></p>` + `<button type="button" class="resume-dismiss" aria-label="Hide this card" title="Hide this card">${ICON2.close}</button>` + `</header>` + `<h1 id="resume-title" class="resume-title">${esc(g.title)}</h1>` + `<ul class="resume-chips">${chips}</ul>` + `<div class="resume-progress">` + `<p class="resume-count"><b>${fmt(s.found)}</b><span class="of">of ${fmt(s.total)} markers found</span>` + `<span class="togo">${done ? "All found" : `${fmt(left)} to go`}</span></p>` + `<div class="bar" role="img" aria-label="Progress by group">` + groups.map((x) => `<div class="seg" style="flex-grow:${x.n};--c:${colour(x.c)}" title="${esc(x.t)}: ${fmt(x.f)} of ${fmt(x.n)}"><i data-w="${pct(x.f, x.n)}"></i></div>`).join("") + `</div>` + `<ul class="resume-legend">` + legend.map((x) => `<li style="--c:${colour(x.c)}"><span class="dot" aria-hidden="true"></span>${esc(x.t)}<span class="num">${fmt(x.f)}/${fmt(x.n)}</span></li>`).join("") + (more > 0 ? `<li class="more">+${more} more</li>` : "") + `</ul>` + `</div>` + (recent || near ? `<div class="resume-cols">` + (recent ? `<section><h2>Recently found</h2><ul class="resume-recent">${recent}</ul></section>` : "") + (near ? `<section><h2>Almost complete</h2><ul class="resume-near">${near}</ul></section>` : "") + `</div>` : "") + `<footer class="resume-foot">` + `<a class="cta resume-cta" href="${esc(mapHref(s.map))}" data-slug="${esc(g.slug)}">Resume${maps.length > 1 ? ` on ${esc(s.mapTitle || s.map)}` : ""} ${ARROW}</a>` + (otherMaps.length ? `<nav class="resume-maps" aria-label="Other maps in ${esc(g.title)}"><span>Or jump to</span>` + otherMaps.map((m) => `<a href="${esc(mapHref(m.slug))}" data-slug="${esc(g.slug)}">${esc(m.title)}</a>`).join("") + `</nav>` : "") + (otherProfiles.length ? `<nav class="resume-maps resume-profiles" aria-label="Other profiles in ${esc(g.title)}"><span>Or profile</span>` + otherProfiles.map((pr) => `<a href="${esc(profileHref(pr.id))}" data-slug="${esc(g.slug)}">${esc(pr.name)}</a>`).join("") + `</nav>` : "") + (extras ? `<ul class="resume-extras">${extras}</ul>` : "") + `</footer>` + `</div>` + `</article>`;
  hero.hidden = true;
  root.hidden = false;
  document.getElementById("hero-shell")?.classList.add("has-resume");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll("[data-w]").forEach((el) => {
      el.style.width = el.dataset.w + "%";
    });
    const arc = root.querySelector(".arc");
    if (arc && arc.dataset.off)
      arc.style.strokeDashoffset = arc.dataset.off;
  }));
  root.addEventListener("click", (e) => {
    const target = e.target;
    if (!target)
      return;
    const a = target.closest("a[data-slug]");
    if (a) {
      recordGameOpen(g.slug, g.theme, g.title);
      return;
    }
    if (target.closest(".resume-dismiss")) {
      try {
        localStorage.removeItem("va_last_session");
      } catch {}
      root.hidden = true;
      hero.hidden = false;
      document.getElementById("hero-shell")?.classList.remove("has-resume");
      const li = document.querySelector("#game-list li[data-featured]");
      const qEl = document.getElementById("map-query");
      if (li) {
        delete li.dataset.featured;
        if (!qEl?.value.trim())
          li.hidden = false;
      }
    }
  });
  return g.slug;
}
if (typeof document !== "undefined") {
  main();
  const topMore = document.getElementById("top-more");
  const topMorePanel = document.getElementById("top-more-panel");
  const moreToggle = topMore?.querySelector(".more-toggle");
  if (topMorePanel)
    topMorePanel.appendChild(accountSlot("top"));
  initAccount({ toast: notify });
  if (topMore && moreToggle) {
    const setMoreOpen = (open) => {
      topMore.classList.toggle("open", open);
      moreToggle.setAttribute("aria-expanded", String(open));
    };
    moreToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setMoreOpen(!topMore.classList.contains("open"));
    });
    document.addEventListener("click", (e) => {
      if (!topMore.contains(e.target))
        setMoreOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && topMore.classList.contains("open")) {
        setMoreOpen(false);
        moreToggle.focus({ preventScroll: true });
      }
    });
  }
  const brand = document.querySelector(".brand");
  let beatTimer;
  brand?.addEventListener("click", (e) => {
    e.preventDefault();
    brand.classList.add("beat");
    if (beatTimer)
      clearTimeout(beatTimer);
    beatTimer = setTimeout(() => brand.classList.remove("beat"), 6000);
  });
}
export {
  orderGames
};
