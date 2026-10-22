// theme.js: three-way color theme switch (light · auto · dark).
// Default is "auto" (follows system preference). A local cookie (va_theme) is written only when the user changes it.

const COOKIE = 'va_theme';
const TINT_COOKIE = 'va_tint';
const RECENT_COOKIE = 'va_recent';
const MODES = ['light', 'auto', 'dark'];
const LABELS = { light: 'Light', auto: 'Auto', dark: 'Dark' };
const TITLES = {
  light: 'Light mode',
  auto: 'Auto (match system)',
  dark: 'Dark mode',
};
const THEME_COLORS = { light: '#f6f4f0', dark: '#0b0e10' };

const ICONS = {
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M4.93 4.93l1.63 1.63M17.44 17.44l1.63 1.63M2.5 12h2.3M19.2 12h2.3M4.93 19.07l1.63-1.63M17.44 6.56l1.63-1.63"/></svg>',
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path class="half" d="M12 4a8 8 0 0 0 0 16Z" fill="currentColor" stroke="none"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 14.6A8.5 8.5 0 0 1 9.4 3.6a8.5 8.5 0 1 0 11 11Z"/></svg>',
};

const mql = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;
const listeners = new Set();

export function readThemeCookie() {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)va_theme=(light|auto|dark)\b/);
  return m ? m[1] : null;
}

function writeThemeCookie(mode) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${mode}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export function currentThemeMode() {
  const attr = document.documentElement.dataset.theme;
  if (MODES.includes(attr)) return attr;
  return readThemeCookie() || 'auto';
}

export function isLightTheme(mode = currentThemeMode()) {
  return mode === 'light' || (mode === 'auto' && !!mql?.matches);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function syncMetaThemeColor(mode) {
  if (document.body?.dataset.game) return; // map pages set their own tinted theme-color in applyTheme
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const effective = isLightTheme(mode) ? 'light' : 'dark';
  meta.setAttribute('content', THEME_COLORS[effective]);
}

function notifyListeners() {
  const light = isLightTheme();
  const mode = currentThemeMode();
  for (const fn of listeners) fn({ mode, light });
}

export function applyThemeMode(mode, { persist = false } = {}) {
  if (!MODES.includes(mode)) mode = 'auto';
  document.documentElement.dataset.theme = mode;
  if (persist) writeThemeCookie(mode);
  syncMetaThemeColor(mode);
  applyStoredTint();
  document.querySelectorAll('[data-theme-toggle]').forEach(el => updateToggleUI(el, mode));
  notifyListeners();
}

function updateToggleUI(root, mode) {
  root.dataset.mode = mode;
  const is2Pos = root.classList.contains('theme-switch-2');
  if (is2Pos) {
    const light = isLightTheme(mode);
    const effective = mode === 'auto' ? (light ? 'light' : 'dark') : mode;
    root.dataset.effective = effective;

    root.querySelectorAll('[data-theme-opt]').forEach(btn => {
      const opt = btn.dataset.themeOpt;
      const isCurrent = mode === opt;
      btn.setAttribute('aria-checked', String(isCurrent));
      const isFocusable = mode === 'auto' ? opt === effective : isCurrent;
      btn.tabIndex = isFocusable ? 0 : -1;
    });

    if (mode === 'auto') {
      root.title = `Theme: Auto (${effective === 'light' ? 'Light' : 'Dark'}). Click to toggle, right-click or hold to reset to auto.`;
    } else {
      root.title = `Theme: ${mode === 'light' ? 'Light' : 'Dark'}. Click to toggle, right-click or hold for auto.`;
    }
  } else {
    root.querySelectorAll('[data-theme-opt]').forEach(btn => {
      const active = btn.dataset.themeOpt === mode;
      btn.setAttribute('aria-checked', String(active));
      btn.tabIndex = active ? 0 : -1;
    });
  }
}

function buildToggle(root) {
  if (root.dataset.themeBuilt) {
    updateToggleUI(root, currentThemeMode());
    return root;
  }
  root.dataset.themeBuilt = '1';

  const isDropdown = root.classList.contains('side-dropdown-theme') ||
                     !!root.closest('.side-dropdown-theme, .side-menu-theme') ||
                     root.dataset.themeVariant === 'dropdown' ||
                     root.dataset.themeToggle === 'dropdown';

  root.classList.add('theme-switch');
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', 'Color theme');

  if (isDropdown) {
    // 3-position toggle for dropdown menus (Light · Auto · Dark)
    // Uses icons for all three positions (Auto uses the half-and-half icon instead of the word)
    root.innerHTML =
      `<span class="theme-thumb" aria-hidden="true"></span>` +
      MODES.map(m =>
        `<button type="button" class="theme-opt" role="radio" data-theme-opt="${m}" aria-checked="false" aria-label="${TITLES[m]}" title="${TITLES[m]}">` +
        `${ICONS[m]}<span class="theme-opt-label">${LABELS[m]}</span>` +
        `</button>`
      ).join('');

    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-theme-opt]');
      if (!btn) return;
      applyThemeMode(btn.dataset.themeOpt, { persist: true });
    });

    root.addEventListener('keydown', e => {
      const cur = currentThemeMode();
      const idx = MODES.indexOf(cur);
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % MODES.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + MODES.length) % MODES.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = MODES.length - 1;
      if (next < 0) return;
      e.preventDefault();
      const mode = MODES[next];
      applyThemeMode(mode, { persist: true });
      root.querySelector(`[data-theme-opt="${mode}"]`)?.focus();
    });
  } else {
    // 2-position switch (Light / Dark) for headers and standalone bars.
    // Right-click or tap-and-hold switches to Auto, displaying the half-and-half Auto icon.
    root.classList.add('theme-switch-2');
    root.innerHTML =
      `<span class="theme-thumb" aria-hidden="true">` +
        `<span class="theme-thumb-auto">${ICONS.auto}</span>` +
      `</span>` +
      `<button type="button" class="theme-opt" role="radio" data-theme-opt="light" aria-checked="false" aria-label="${TITLES.light}">` +
        `${ICONS.light}<span class="theme-opt-label">${LABELS.light}</span>` +
      `</button>` +
      `<button type="button" class="theme-opt" role="radio" data-theme-opt="dark" aria-checked="false" aria-label="${TITLES.dark}">` +
        `${ICONS.dark}<span class="theme-opt-label">${LABELS.dark}</span>` +
      `</button>`;

    let pressTimer = null;
    let longPressed = false;
    let startX = 0;
    let startY = 0;

    const clearPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };

    const triggerAuto = () => {
      applyThemeMode('auto', { persist: true });
      try { navigator.vibrate?.(25); } catch {}
      root.classList.remove('theme-pulse');
      void root.offsetWidth;
      root.classList.add('theme-pulse');
      setTimeout(() => root.classList.remove('theme-pulse'), 400);

      // Flash a little "Auto" chip that briefly shows up and slides away
      root.querySelectorAll('.theme-auto-chip').forEach(el => el.remove());
      const chip = document.createElement('span');
      chip.className = 'theme-auto-chip';
      chip.setAttribute('aria-hidden', 'true');
      chip.textContent = 'Auto';
      root.appendChild(chip);
      chip.addEventListener('animationend', () => chip.remove());
      setTimeout(() => chip.remove(), 1100);
    };

    // Tap and hold
    root.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      longPressed = false;
      startX = e.clientX;
      startY = e.clientY;
      clearPress();
      pressTimer = setTimeout(() => {
        longPressed = true;
        triggerAuto();
      }, 420);
    });

    root.addEventListener('pointermove', e => {
      if (!pressTimer) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) clearPress();
    });

    root.addEventListener('pointerup', clearPress);
    root.addEventListener('pointercancel', clearPress);

    // Right-click
    root.addEventListener('contextmenu', e => {
      e.preventDefault();
      triggerAuto();
    });

    // Click: toggle or select specific side
    root.addEventListener('click', e => {
      if (longPressed) {
        longPressed = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const btn = e.target.closest('[data-theme-opt]');
      const current = currentThemeMode();
      if (btn) {
        const opt = btn.dataset.themeOpt;
        if (current === opt) {
          applyThemeMode(opt === 'light' ? 'dark' : 'light', { persist: true });
        } else {
          applyThemeMode(opt, { persist: true });
        }
      } else {
        const next = isLightTheme() ? 'dark' : 'light';
        applyThemeMode(next, { persist: true });
      }
    });

    // Keyboard navigation
    root.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        applyThemeMode('light', { persist: true });
        root.querySelector('[data-theme-opt="light"]')?.focus();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        applyThemeMode('dark', { persist: true });
        root.querySelector('[data-theme-opt="dark"]')?.focus();
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        triggerAuto();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const next = isLightTheme() ? 'dark' : 'light';
        applyThemeMode(next, { persist: true });
      }
    });
  }

  updateToggleUI(root, currentThemeMode());
  return root;
}

export function themeToggle(extraClass = '') {
  const el = document.createElement('div');
  if (extraClass) el.className = extraClass;
  el.dataset.themeToggle = '';
  return buildToggle(el);
}

function hexToHsl(hex) {
  const m = String(hex || '').replace('#', '').match(/../g);
  if (!m) return [0, 0, 0];
  const [r, g, b] = m.map(x => parseInt(x, 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}

function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return '#' + f(0) + f(8) + f(4);
}

export function deriveLightAccentSoft(accent) {
  if (!accent) return '#b03028';
  const [h, s, al] = hexToHsl(accent);
  return hslToHex(h, Math.min(s, 0.78), Math.max(0.26, Math.min(0.40, al - 0.06)));
}

export function readStoredTint() {
  if (typeof document === 'undefined') return null;
  let raw = null;
  const m = document.cookie.match(/(?:^|;\s*)va_tint=([^;]+)/);
  if (m) {
    try { raw = decodeURIComponent(m[1]); } catch {}
  }
  if (!raw) {
    try { raw = localStorage.getItem('va_tint'); } catch {}
  }
  if (!raw) return null;
  const [accent, accentSoft] = raw.split('|');
  if (/^#[0-9a-fA-F]{3,8}$/.test(accent)) {
    return { accent, accentSoft: accentSoft && /^#[0-9a-fA-F]{3,8}$/.test(accentSoft) ? accentSoft : null };
  }
  return null;
}

export function writeStoredTint(accent, accentSoft = null) {
  if (typeof document === 'undefined') return;
  if (!accent || !/^#[0-9a-fA-F]{3,8}$/.test(accent)) return;
  const val = `${accent}|${accentSoft || ''}`;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${TINT_COOKIE}=${encodeURIComponent(val)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  try { localStorage.setItem('va_tint', val); } catch {}
}

export function updateFavicon(accent) {
  if (typeof document === 'undefined' || !accent) return;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    const fill = encodeURIComponent(accent);
    icon.type = 'image/svg+xml';
    icon.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='${fill}' d='M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z'/%3E%3Ccircle cx='12' cy='10' r='2.8' fill='%230b0e10'/%3E%3C/svg%3E`;
  }
}

export function applyStoredTint(tint = readStoredTint()) {
  if (typeof document === 'undefined') return;
  if (document.body?.dataset.game || document.getElementById('app')) return;
  const root = document.documentElement.style;
  if (tint?.accent) {
    root.setProperty('--accent', tint.accent);
    const light = isLightTheme();
    const soft = light ? deriveLightAccentSoft(tint.accent) : (tint.accentSoft || tint.accent);
    root.setProperty('--accent-soft', soft);
    updateFavicon(tint.accent);
  } else {
    root.removeProperty('--accent');
    root.removeProperty('--accent-soft');
    updateFavicon('#d6453b');
  }
}

export function readRecentGames() {
  if (typeof document === 'undefined') return [];
  let raw = null;
  const m = document.cookie.match(/(?:^|;\s*)va_recent=([^;]+)/);
  if (m) {
    try { raw = decodeURIComponent(m[1]); } catch {}
  }
  if (!raw) {
    try { raw = localStorage.getItem('va_recent_games'); } catch {}
  }
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export function writeRecentGames(slugs) {
  if (typeof document === 'undefined') return;
  const val = (slugs || []).slice(0, 50).join(',');
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${RECENT_COOKIE}=${encodeURIComponent(val)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  try { localStorage.setItem('va_recent_games', val); } catch {}
}

const TRAIL_KEY = 'va_nav_trail';
const TITLES_KEY = 'va_game_titles';
const ROOT_URL = typeof document !== 'undefined' ? new URL('./', import.meta.url) : null;

export function recordGameTitle(slug, title) {
  if (!slug || !title || typeof localStorage === 'undefined') return;
  try {
    const titles = JSON.parse(localStorage.getItem(TITLES_KEY) || '{}');
    if (titles[slug] !== title) {
      titles[slug] = title;
      localStorage.setItem(TITLES_KEY, JSON.stringify(titles));
    }
  } catch {}
}

export function storeGameTitles(games) {
  if (!Array.isArray(games) || typeof localStorage === 'undefined') return;
  try {
    const titles = JSON.parse(localStorage.getItem(TITLES_KEY) || '{}');
    let changed = false;
    for (const g of games) {
      if (g?.slug && g?.title && titles[g.slug] !== g.title) {
        titles[g.slug] = g.title;
        changed = true;
      }
    }
    if (changed) localStorage.setItem(TITLES_KEY, JSON.stringify(titles));
  } catch {}
}

export function getGameTitle(slug) {
  if (!slug) return '';
  if (typeof localStorage !== 'undefined') {
    try {
      const titles = JSON.parse(localStorage.getItem(TITLES_KEY) || '{}');
      if (titles[slug]) return titles[slug];
    } catch {}
    try {
      const last = JSON.parse(localStorage.getItem('va_last_session') || '{}');
      if (last.slug === slug && last.title) return last.title;
    } catch {}
  }
  if (typeof document !== 'undefined') {
    const docTitle = (document.title || '').replace(/\s*·.*$/, '').trim();
    if (docTitle && docTitle !== 'Map' && docTitle !== 'Loading map…' && docTitle !== 'Verticordia Atlas' && !docTitle.startsWith('Loading')) {
      return docTitle;
    }
  }
  return slug
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function normalizePath(pathname) {
  if (!pathname) return '/';
  let p = pathname.replace(/\/index\.html?$/i, '/');
  if (!/\.[a-zA-Z0-9]+$/.test(p) && !p.endsWith('/')) {
    p += '/';
  }
  return p;
}

function resolveAppUrl(pathOrUrl) {
  if (!ROOT_URL || !pathOrUrl) return pathOrUrl || '/';
  try {
    const u = new URL(pathOrUrl, ROOT_URL);
    return u.pathname + u.search + u.hash;
  } catch {
    return pathOrUrl;
  }
}

export function describePage(pathname, fullUrl = null, titleOverride = null) {
  const normPath = normalizePath(pathname);
  const targetUrl = resolveAppUrl(fullUrl || normPath);

  if (normPath === '/' || normPath === '') {
    return {
      type: 'home',
      path: '/',
      fullUrl: targetUrl,
      title: 'the maps',
      buttonText: 'Back to the maps',
    };
  }

  if (normPath.startsWith('/about')) {
    return {
      type: 'about',
      path: '/about/',
      fullUrl: targetUrl,
      title: 'about',
      buttonText: 'Return to about',
    };
  }

  if (normPath.startsWith('/terms')) {
    return {
      type: 'terms',
      path: '/terms/',
      fullUrl: targetUrl,
      title: 'terms',
      buttonText: 'Return to terms',
    };
  }

  if (normPath.startsWith('/privacy')) {
    return {
      type: 'privacy',
      path: '/privacy/',
      fullUrl: targetUrl,
      title: 'privacy policy',
      buttonText: 'Return to privacy policy',
    };
  }

  if (normPath.startsWith('/signin')) {
    return {
      type: 'signin',
      path: '/signin/',
      fullUrl: targetUrl,
      title: 'sign in',
      buttonText: 'Return to sign in',
    };
  }

  const mapMatch = normPath.match(/\/maps\/([^/]+)/);
  if (mapMatch) {
    const slug = decodeURIComponent(mapMatch[1]);
    const title = titleOverride || getGameTitle(slug);
    return {
      type: 'map',
      slug,
      path: `/maps/${slug}/`,
      fullUrl: targetUrl,
      title,
      buttonText: `Return to ${title}`,
    };
  }

  const fallbackTitle = titleOverride || 'the maps';
  return {
    type: 'page',
    path: normPath,
    fullUrl: targetUrl,
    title: fallbackTitle,
    buttonText: `Return to ${fallbackTitle}`,
  };
}

export function readTrail() {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(TRAIL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeTrail(trail) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-30)));
  } catch {}
}

export function popTrailTo(targetPath) {
  let trail = readTrail();
  const idx = trail.findIndex(e => e.path === targetPath);
  if (idx !== -1) {
    trail = trail.slice(0, idx + 1);
  } else if (trail.length > 1) {
    trail.pop();
  }
  writeTrail(trail);
}

export function initNav() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const currentPath = normalizePath(location.pathname);
  const currentFullUrl = location.pathname + location.search + location.hash;
  const currentInfo = describePage(currentPath, currentFullUrl);

  // If user is on the homepage, reset trail so any future navigation starts fresh from home
  if (currentInfo.type === 'home') {
    writeTrail([currentInfo]);
    return;
  }

  let trail = readTrail();

  // If trail is empty, try seeding from document.referrer or sign-in next param
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
    if (!trail.length && currentInfo.type === 'signin') {
      const rawNext = new URLSearchParams(location.search).get('next');
      if (rawNext && /^\/(?!\/)/.test(rawNext)) {
        const nextPath = normalizePath(rawNext);
        if (nextPath !== currentPath) {
          trail = [describePage(nextPath, rawNext)];
        }
      }
    }
  }

  // Record current page into trail
  const existingIdx = trail.findIndex(e => e.path === currentPath);
  if (existingIdx !== -1) {
    // Unwind trail to existing entry to avoid loops
    trail = trail.slice(0, existingIdx);
    trail.push(currentInfo);
  } else {
    trail.push(currentInfo);
  }
  writeTrail(trail);

  // Determine previous page target
  let target = trail.length >= 2 ? trail[trail.length - 2] : null;

  // On sign-in page, if target is home but ?next= points somewhere specific, prefer next
  if (currentInfo.type === 'signin' && (!target || target.type === 'home')) {
    const rawNext = new URLSearchParams(location.search).get('next');
    if (rawNext && /^\/(?!\/)/.test(rawNext)) {
      const nextPath = normalizePath(rawNext);
      if (nextPath !== '/' && nextPath !== currentPath) {
        target = describePage(nextPath, rawNext);
      }
    }
  }

  // Fallback to home if no previous page
  if (!target) {
    target = describePage('/');
  }

  // Re-resolve title in case it was stored/updated
  if (target.type === 'map' && target.slug) {
    const freshTitle = getGameTitle(target.slug);
    if (freshTitle && freshTitle !== target.slug) {
      target.title = freshTitle;
      target.buttonText = `Return to ${freshTitle}`;
    }
  }

  // Update all .back buttons
  const backButtons = document.querySelectorAll('a.back');
  backButtons.forEach(btn => {
    btn.href = target.fullUrl;
    btn.title = target.buttonText;
    btn.setAttribute('aria-label', target.buttonText);
    const span = btn.querySelector('span');
    if (span) span.textContent = target.buttonText;

    btn.onclick = (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      popTrailTo(target.path);

      const refMatches = document.referrer && (() => {
        try {
          const r = new URL(document.referrer);
          return r.origin === location.origin && normalizePath(r.pathname) === target.path;
        } catch { return false; }
      })();

      if (refMatches && window.history.length > 1) {
        e.preventDefault?.();
        window.history.back();
      }
    };
  });

  // On signin page, also wire up the footer skip link: "Not now. Keep using the app."
  if (currentInfo.type === 'signin') {
    const skipLink = document.querySelector('footer.signin-foot .skip a');
    if (skipLink) {
      skipLink.href = target.fullUrl;
      skipLink.onclick = (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        popTrailTo(target.path);
        const refMatches = document.referrer && (() => {
          try {
            const r = new URL(document.referrer);
            return r.origin === location.origin && normalizePath(r.pathname) === target.path;
          } catch { return false; }
        })();
        if (refMatches && window.history.length > 1) {
          e.preventDefault?.();
          window.history.back();
        }
      };
    }
  }
}

export function recordGameOpen(slug, theme = null, title = null) {
  if (!slug) return;
  if (title) recordGameTitle(slug, title);
  const recent = readRecentGames().filter(s => s !== slug);
  recent.unshift(slug);
  writeRecentGames(recent);

  if (theme?.accent) {
    writeStoredTint(theme.accent, theme['accent-soft'] || null);
    applyStoredTint({ accent: theme.accent, accentSoft: theme['accent-soft'] || null });
  }

  // Update current entry in trail if on this map
  try {
    let trail = readTrail();
    if (trail.length && trail[trail.length - 1].path === `/maps/${slug}/`) {
      const gameTitle = title || getGameTitle(slug);
      trail[trail.length - 1].title = gameTitle;
      trail[trail.length - 1].buttonText = `Return to ${gameTitle}`;
      writeTrail(trail);
    }
  } catch {}
}

export function initTheme() {
  const initial = readThemeCookie() || currentThemeMode();
  document.documentElement.dataset.theme = initial;
  syncMetaThemeColor(initial);
  applyStoredTint();
  document.querySelectorAll('[data-theme-toggle]').forEach(buildToggle);
  mql?.addEventListener?.('change', () => {
    if (currentThemeMode() === 'auto') {
      syncMetaThemeColor('auto');
      applyStoredTint();
      document.querySelectorAll('[data-theme-toggle]').forEach(el => updateToggleUI(el, 'auto'));
      notifyListeners();
    }
  });
}

if (typeof document !== 'undefined') {
  initTheme();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initNav(), { once: true });
  } else {
    initNav();
  }
  window.addEventListener('pageshow', () => initNav());
}
