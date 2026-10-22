// theme.js: three-way color theme switch (light · auto · dark).
// Default is "auto" (follows system preference). A local cookie (va_theme) is written only when the user changes it.

const COOKIE = 'va_theme';
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

export function initTheme() {
  const initial = readThemeCookie() || currentThemeMode();
  document.documentElement.dataset.theme = initial;
  syncMetaThemeColor(initial);
  document.querySelectorAll('[data-theme-toggle]').forEach(buildToggle);
  mql?.addEventListener?.('change', () => {
    if (currentThemeMode() === 'auto') {
      syncMetaThemeColor('auto');
      document.querySelectorAll('[data-theme-toggle]').forEach(el => updateToggleUI(el, 'auto'));
      notifyListeners();
    }
  });
}

initTheme();
