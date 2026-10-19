// icons-lib.mjs: the icon library for marker categories (Lucide, ISC licence: vendor/lucide/). It is fetched the
// first time a category uses an icon, then searched by name and by tags, and drawn on the map as a pin.

const URL_ = new URL('./vendor/lucide/icons.json', import.meta.url);
let library = null, loading = null;

export const iconsReady = () => library !== null;

// the library, once: { name: [inner svg markup, tags] }
export function loadIconLibrary() {
  if (!loading) {
    loading = fetch(URL_).then(r => {
      if (!r.ok) throw new Error(`icon library: HTTP ${r.status}`);
      return r.json();
    }).then(j => { library = j; return j; });
  }
  return loading;
}

export const iconInner = name => library?.[name]?.[0] ?? null;

// names that match every word of the query, in the name or its tags; names starting with the query first
export function searchIcons(query, limit = 120) {
  if (!library) return [];
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const names = Object.keys(library);
  if (!words.length) return names.slice(0, limit);
  const scored = [];
  for (const name of names) {
    const hay = (name.replace(/-/g, ' ') + ' ' + library[name][1].join(' ')).toLowerCase();
    if (!words.every(w => hay.includes(w))) continue;
    const score = name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2;
    scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return scored.slice(0, limit).map(s => s.name);
}

// the glyph's colour for a category colour: whichever of white or near-black reads better on it (WCAG contrast)
export function glyphInk(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const white = 1.05 / (L + 0.05), dark = (L + 0.05) / 0.06;
  return white >= dark ? '#ffffff' : '#14161a';
}

// The user markers' pin: the site's own favicon pin (the same outline), with a faint glow. Sizes are in the pin's own
// 24-unit grid, drawn K times larger, on a canvas of S units at R times the device pixels.
export const PIN = { S: 60, R: 2, K: 2.4 }; // K: the pin is slightly taller than the official markers
const PIN_OUTLINE = 'M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z';

// draws a user marker's pin on a canvas context: solid with a glow (a permanent marker), or a translucent fill with a
// dashed outline (a temporary one). `glyph` is an already-decoded icon drawn in the head.
export function drawPin(g, hex, { temp = false, glyph = null } = {}) {
  const { S, R, K } = PIN;
  // centred horizontally, the tip just above the bottom edge (room for the glow)
  const ox = S / 2 - 12 * K, oy = S - 3 - 22 * K;
  g.setTransform(R * K, 0, 0, R * K, R * ox, R * oy);
  const pin = new Path2D(PIN_OUTLINE);
  pin.moveTo(12 + 2.8, 10); pin.arc(12, 10, 2.8, 0, Math.PI * 2); // the hole in the head (the favicon's)
  if (temp) {
    g.fillStyle = hex + '40';
    g.fill(pin, 'evenodd');
    g.strokeStyle = hex; g.lineWidth = 1.3; g.setLineDash([1.6, 1.3]);
    g.stroke(pin);
    g.setLineDash([]);
  } else {
    // the glow: a soft radial falloff round the head, drawn inside the canvas (a blurred shadow would be cut off at the
    // bottom edge, where the tip sits close to the canvas edge)
    const x0 = -ox / K, x1 = (S - ox) / K, y0 = -oy / K, y1 = (S - oy) / K;
    const glow = g.createRadialGradient(12, 10, 0, 12, 10, 13);
    glow.addColorStop(0, hex + '70'); glow.addColorStop(1, hex + '00');
    g.fillStyle = glow;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.fillStyle = hex;
    g.fill(pin, 'evenodd');
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 0.8;
    g.stroke(pin);
  }
  if (glyph) g.drawImage(glyph, 12 - 5.5, 10 - 5.5, 11, 11); // the category's icon, in the head
}

// a plain pin in a colour, as an ImageData for MapLibre
export function pinImage(hex, temp = false) {
  const { S, R } = PIN;
  const c = document.createElement('canvas');
  c.width = c.height = S * R;
  const g = c.getContext('2d');
  drawPin(g, hex, { temp });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return g.getImageData(0, 0, S * R, S * R);
}

// "ic-<glyph>-<rrggbb>": the pin in that colour with the glyph on its head, as an ImageData for MapLibre
export async function glyphPinImage(name) {
  const m = /^ic-(.+)-([0-9a-f]{6})$/i.exec(name);
  const inner = m && iconInner(m[1]);
  if (!inner) return null;
  const hex = '#' + m[2];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${glyphInk(hex)}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const { S, R } = PIN;
  const c = document.createElement('canvas');
  c.width = c.height = S * R;
  const g = c.getContext('2d');
  drawPin(g, hex, { glyph: img });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return g.getImageData(0, 0, S * R, S * R);
}
