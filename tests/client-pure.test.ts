import { describe, expect, test } from 'bun:test';
import { hsvToHex, hexToHsv, simplify, PALETTE, DRAW_CONTROLS_HTML, INK_CONTROL_HTML } from '../public/drawing.js';
import { glyphInk, PIN } from '../public/icons-lib.mjs';
import { ICONS, svgIcon } from '../public/icons.mjs';
import { deriveLightAccentSoft, normalizePath, describePage } from '../public/theme.js';
import { createSync } from '../public/sync.js';

describe('drawing pure helpers', () => {
  test('hsvToHex and hexToHsv round-trip palette colors', () => {
    expect(PALETTE.length).toBeGreaterThan(5);
    expect(DRAW_CONTROLS_HTML).toContain('id="tool-draw"');
    expect(INK_CONTROL_HTML).toContain('id="tool-ink"');

    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#e5484d']) {
      const [h, s, v] = hexToHsv(hex);
      expect(hsvToHex(h, s, v)).toBe(hex);
    }
  });

  test('simplify (Ramer-Douglas-Peucker) removes collinear points while keeping corners', () => {
    const collinear = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: -0.1 },
      { x: 20, y: 0 },
    ];
    expect(simplify(collinear, 1.0)).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);

    const corner = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(simplify(corner, 1.0)).toEqual(corner);
  });
});

describe('icons and contrast helpers', () => {
  test('glyphInk selects WCAG-contrasting ink color', () => {
    expect(glyphInk('#000000')).toBe('#ffffff');
    expect(glyphInk('#12161a')).toBe('#ffffff');
    expect(glyphInk('#ffffff')).toBe('#14161a');
    expect(glyphInk('#f5c544')).toBe('#14161a');
  });

  test('svgIcon renders 24x24 svg with class', () => {
    expect(PIN).toEqual({ S: 60, R: 2, K: 2.4 });
    expect(svgIcon('pin')).toBe(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS.pin}</svg>`);
    expect(svgIcon('check', 'extra')).toContain('class="i extra"');
  });
});

describe('theme and navigation helpers', () => {
  test('deriveLightAccentSoft produces valid hex color', () => {
    expect(deriveLightAccentSoft('')).toBe('#b03028');
    expect(deriveLightAccentSoft('#d6453b')).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('normalizePath normalizes index.html and trailing slashes', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/index.html')).toBe('/');
    expect(normalizePath('/about')).toBe('/about/');
    expect(normalizePath('/maps/elden-ring/index.html')).toBe('/maps/elden-ring/');
  });

  test('describePage identifies home, legal, signin, and map pages', () => {
    expect(describePage('/').type).toBe('home');
    expect(describePage('/about/').type).toBe('about');
    expect(describePage('/terms/').type).toBe('terms');
    expect(describePage('/privacy/').type).toBe('privacy');
    expect(describePage('/signin/').type).toBe('signin');

    const mapDesc = describePage('/maps/elden-ring/');
    expect(mapDesc.type).toBe('map');
    expect(mapDesc.slug).toBe('elden-ring');
    expect(mapDesc.title).toBe('Elden Ring');
    expect(mapDesc.buttonText).toBe('Return to Elden Ring');
  });
});

describe('sync client engine (createSync)', () => {
  function makeMockEnv() {
    const profiles = new Map<string, any>();
    const meta = new Map<string, any>();
    const serverItems = new Map<string, { value: any; updated_at: number }>();
    let clock = 1000;

    const store = {
      profiles: async () => [...profiles.values()].map(p => structuredClone(p)),
      isEmpty: (p: any) => !p.found?.length && !p.drawings?.length && !p.userMarkers?.length && !p.userCats?.length,
      metaEntries: async () => [...meta.entries()].map(([k, v]) => ({ k, v: structuredClone(v) })),
      putProfile: async (rec: any) => { profiles.set(rec.key, structuredClone(rec)); },
      deleteProfile: async (key: string) => { profiles.delete(key); },
      putMeta: async (k: string, v: any) => { meta.set(k, structuredClone(v)); },
      removeMeta: async (k: string) => { meta.delete(k); },
      getMeta: async (k: string) => structuredClone(meta.get(k) ?? null),
    };

    const events = {
      online: [] as boolean[],
      conflicts: [] as any[],
      remoteChanged: [] as string[][],
      signedOut: 0,
    };

    const ui = {
      status: ({ online }: { online: boolean }) => events.online.push(online),
      conflicts: (list: any[]) => events.conflicts.push(list),
      remoteChanged: async (keys: string[]) => { events.remoteChanged.push(keys); },
      signedOut: () => { events.signedOut++; },
    };

    const api = async (method: string, path: string, body?: any) => {
      if (method === 'GET' && path === 'sync') {
        return {
          items: [...serverItems.entries()].map(([key, v]) => ({
            key,
            value: structuredClone(v.value),
            updated_at: v.updated_at,
          })),
        };
      }
      if (method === 'POST' && path === 'sync') {
        const results = [];
        for (const it of body.items) {
          const cur = serverItems.get(it.key);
          const base = it.base ?? 0;
          if (cur && cur.updated_at > base) {
            results.push({ key: it.key, status: 'conflict', value: structuredClone(cur.value), updated_at: cur.updated_at });
            continue;
          }
          const t = ++clock;
          serverItems.set(it.key, { value: structuredClone(it.value), updated_at: t });
          results.push({ key: it.key, status: 'ok', updated_at: t });
        }
        return { results };
      }
      throw new Error(`Unexpected API call: ${method} ${path}`);
    };

    return { profiles, meta, serverItems, store, ui, api, events, tick: () => ++clock };
  }

  test('adopts remote profile over empty local placeholder and pushes local edits', async () => {
    const env = makeMockEnv();
    // Local device starts with an empty default profile
    env.profiles.set('totk:local-empty', { key: 'totk:local-empty', id: 'local-empty', game: 'totk', name: 'Default', found: [] });
    // Server has an existing profile with progress
    env.serverItems.set('profile:totk:remote-1', {
      value: { name: 'Playthrough 1', found: [10, 20], updated: 500 },
      updated_at: 500,
    });

    // Shim navigator.onLine and addEventListener/document for start()
    (globalThis as any).navigator = { onLine: true };
    (globalThis as any).addEventListener = () => {};
    (globalThis as any).document = { addEventListener: () => {}, visibilityState: 'visible' };

    const sync = createSync({ store: env.store, ui: env.ui, api: env.api });
    sync.start();
    await new Promise(r => setTimeout(r, 30));

    // Empty local placeholder should be replaced by remote-1
    expect(env.profiles.has('totk:local-empty')).toBe(false);
    expect(env.profiles.get('totk:remote-1')?.found).toEqual([10, 20]);
    expect(env.events.remoteChanged).toEqual([['profile:totk:remote-1']]);

    // Now make a local change and push it
    const prof = env.profiles.get('totk:remote-1');
    prof.found.push(30);
    env.profiles.set('totk:remote-1', prof);
    sync.noteLocal();
    await new Promise(r => setTimeout(r, 1600));

    expect(env.serverItems.get('profile:totk:remote-1')?.value.found).toEqual([10, 20, 30]);
  });
});
