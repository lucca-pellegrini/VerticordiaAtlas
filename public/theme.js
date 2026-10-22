// theme.js: three-way color theme switch (light · auto · dark) for non-map pages.
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
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path class="half" d="M12 4a8 8 0 0 0 0 16Z"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 14.6A8.5 8.5 0 0 1 9.4 3.6a8.5 8.5 0 1 0 11 11Z"/></svg>',
};

const mql = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

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

function syncMetaThemeColor(mode) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const effective = mode === 'auto' ? (mql?.matches ? 'light' : 'dark') : mode;
  meta.setAttribute('content', THEME_COLORS[effective] || THEME_COLORS.dark);
}

export function applyThemeMode(mode, { persist = false } = {}) {
  if (!MODES.includes(mode)) mode = 'auto';
  document.documentElement.dataset.theme = mode;
  if (persist) writeThemeCookie(mode);
  syncMetaThemeColor(mode);
  document.querySelectorAll('[data-theme-toggle]').forEach(el => updateToggleUI(el, mode));
}

function updateToggleUI(root, mode) {
  root.dataset.mode = mode;
  root.querySelectorAll('[data-theme-opt]').forEach(btn => {
    const active = btn.dataset.themeOpt === mode;
    btn.setAttribute('aria-checked', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
}

function buildToggle(root) {
  root.classList.add('theme-switch');
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', 'Color theme');
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

  updateToggleUI(root, currentThemeMode());
}

export function initTheme() {
  const initial = readThemeCookie() || currentThemeMode();
  document.documentElement.dataset.theme = initial;
  syncMetaThemeColor(initial);
  document.querySelectorAll('[data-theme-toggle]').forEach(buildToggle);
  mql?.addEventListener?.('change', () => {
    if (currentThemeMode() === 'auto') syncMetaThemeColor('auto');
  });
}

initTheme();
