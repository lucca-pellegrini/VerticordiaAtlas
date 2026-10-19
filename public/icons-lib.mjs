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

// the pin geometry, shared with the plain pings (usermarkers.js): a head of about 26px, a tail, and a halo
export const PIN = { S: 40, R: 2, cx: 20, cy: 16, head: 13, halo: 16.5, tail: 10, glyph: 15 };

// "ic-<glyph>-<rrggbb>": a pin in that colour with the glyph on its head, as an ImageData for MapLibre
export async function glyphPinImage(name) {
  const m = /^ic-(.+)-([0-9a-f]{6})$/i.exec(name);
  const inner = m && iconInner(m[1]);
  if (!inner) return null;
  const hex = '#' + m[2];
  const { S, R, cx, cy, head, halo, tail, glyph } = PIN;
  const c = document.createElement('canvas');
  c.width = c.height = S * R;
  const g = c.getContext('2d');
  g.scale(R, R);
  g.beginPath(); g.arc(cx, cy, halo, 0, Math.PI * 2); g.fillStyle = hex + '38'; g.fill();
  g.beginPath(); g.moveTo(cx - 6, cy + tail); g.lineTo(cx, S - 1.5); g.lineTo(cx + 6, cy + tail); g.closePath(); g.fillStyle = hex; g.fill();
  g.beginPath(); g.arc(cx, cy, head, 0, Math.PI * 2); g.fillStyle = hex; g.fill();
  g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${glyphInk(hex)}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  g.drawImage(img, cx - glyph / 2, cy - glyph / 2, glyph, glyph);
  return g.getImageData(0, 0, S * R, S * R);
}
