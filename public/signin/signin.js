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
var TRAIL_KEY = "va_nav_trail";
var TITLES_KEY = "va_game_titles";
var ROOT_URL = typeof document !== "undefined" ? new URL(/\/signin\/[^/]*$/.test(import.meta.url) ? "../" : "./", import.meta.url) : null;
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

// src/client/signin.ts
var rawNext = new URLSearchParams(location.search).get("next") || "";
var nextPath = /^\/(?!\/)/.test(rawNext) ? rawNext : "/";
var next = nextPath === "/" ? "../" : nextPath;
var api = (method, path, body) => fetch(new URL("../api/" + path, location.href), {
  method,
  cache: "no-store",
  credentials: "same-origin",
  headers: body !== undefined ? { "Content-Type": "application/json" } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined
}).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(data.error || "Something went wrong.");
  return data;
});
var $ = (id) => document.getElementById(id);
var showError = (msg) => {
  const e = $("secret-error");
  e.textContent = msg;
  e.hidden = !msg;
};
var done = () => {
  location.href = next;
};
async function setupGoogle() {
  const error = new URLSearchParams(location.search).get("error");
  if (error) {
    $("google-error").textContent = error;
    $("google-error").hidden = false;
  }
  let configured = false;
  try {
    configured = !!(await api("GET", "config")).googleClientId;
  } catch {}
  if (!configured) {
    $("google-off").hidden = false;
    return;
  }
  const btn = $("google-btn");
  btn.href = `../api/auth/google/start?next=${encodeURIComponent(nextPath)}`;
  btn.hidden = false;
}
setupGoogle();
$("toggle-secret").onclick = () => {
  const open = $("secret-panel").hidden;
  $("secret-panel").hidden = !open;
  $("toggle-secret").setAttribute("aria-expanded", String(open));
};
$("secret-new").onclick = async () => {
  showError("");
  try {
    const { secret } = await api("POST", "auth/secret/new", {});
    $("secret-value").textContent = secret;
    $("secret-shown").hidden = false;
    $("secret-new").hidden = true;
  } catch (e) {
    showError(e.message);
  }
};
$("secret-saved").onchange = (e) => {
  $("secret-continue").disabled = !e.target.checked;
};
$("secret-continue").onclick = done;
$("secret-login").onsubmit = async (e) => {
  e.preventDefault();
  showError("");
  try {
    await api("POST", "auth/secret/login", { secret: $("secret-input").value });
    done();
  } catch (err) {
    showError(err.message);
  }
};
