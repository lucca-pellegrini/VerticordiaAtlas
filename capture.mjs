// capture.mjs: screenshots of the map. A tap captures the whole visible map; a drag captures a rectangle (with an
// optional fixed shape). The image is rendered at the highest zoom the tiles allow, stepping down one level at a
// time until it fits in MAX_SIDE device pixels. Drawings are composited on top of the map; text notes and the
// selection outline are not part of the picture.

import { ICONS, svgIcon } from './icons.mjs';

const MAX_SIDE = 4096;          // the longest side, in device pixels ("4k-ish")
const JPEG_QUALITY = 0.92;
const ASPECTS = {
  free: { name: 'Free', ratio: null, icon: '<rect x="4.5" y="5.5" width="15" height="13" rx="1.5" stroke-dasharray="3 2.5"/>' },
  square: { name: 'Square (1:1)', ratio: 1, icon: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>' },
  wide: { name: 'Widescreen (16:9)', ratio: 16 / 9, icon: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.5"/>' },
  phone: { name: 'Phone (9:16)', ratio: 9 / 16, icon: '<rect x="7" y="2.5" width="10" height="19" rx="2"/>' },
};
const CAMERA = '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>';
const DOWNLOAD = '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>';
const CLOSE = '<path d="M6 6l12 12M18 6L6 18"/>';
const shot = inner => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

// the tool-stack button (its own group, under the marker tool)
export const CAPTURE_CONTROL_HTML =
  `<button type="button" id="tool-shot" class="notched" aria-label="Screenshot" title="Screenshot. Tap for the whole view, or drag an area. Right-click or hold for the shape">` +
  `<svg viewBox="0 0 24 24" aria-hidden="true">${CAMERA}</svg></button>`;

export function setupCapture({ map, mapEl, canvasBox, drawing, requestTool, names, toast, setBusy }) {
  const box = map.getContainer();
  const btn = document.getElementById('tool-shot');
  let active = false, aspect = 'free', drag = null, busy = false, current = null;

  /* ---- the thumbnail: download, share (where the browser can share files), close ---- */
  const card = document.createElement('div');
  card.id = 'shot-card';
  card.hidden = true;
  card.innerHTML = '<img alt="Screenshot of the map">' +
    '<div class="shot-bar"><span class="shot-size"></span><div class="shot-actions">' +
    `<button type="button" data-act="download" class="ibtn" aria-label="Download" data-tip="Download">${shot(DOWNLOAD)}</button>` +
    `<button type="button" data-act="share" class="ibtn" aria-label="Share" data-tip="Share" hidden>${shot(ICONS.share)}</button>` +
    `<button type="button" data-act="close" class="ibtn" aria-label="Close" data-tip="Close">${shot(CLOSE)}</button>` +
    '</div></div>';
  mapEl.appendChild(card);
  card.onclick = e => {
    const b = e.target.closest('[data-act]');
    if (!b || !current) return;
    if (b.dataset.act === 'close') { card.hidden = true; return; }
    if (b.dataset.act === 'download') download();
    if (b.dataset.act === 'share') share();
  };
  function download() {
    const a = document.createElement('a');
    a.href = current.url;
    a.download = current.name;
    a.click();
  }
  // browsers differ: some share files (Chrome on Android), some have share but no canShare (Firefox on Android),
  // and desktops mostly have neither. So the button is always there; it tries, and says so when it cannot.
  async function share() {
    const data = { files: [current.file], title: names().label };
    const possible = typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(data));
    if (!possible) return toast("Sharing is not available in this browser. Use Download instead.", 4000);
    try { await navigator.share(data); }
    catch (e) { if (e.name !== 'AbortError') toast("Could not share the image. Use Download instead.", 4000); }
  }

  /* ---- the shape menu, from the button's right-click or hold (like the marker tool's) ---- */
  const menu = document.createElement('div');
  menu.id = 'shot-menu';
  menu.className = 'menu row-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = Object.entries(ASPECTS).map(([k, a]) =>
    `<button type="button" role="menuitemradio" data-aspect="${k}" aria-checked="false">${shot(a.icon)}<span>${a.name}</span></button>`).join('');
  document.body.appendChild(menu);
  function placeBeside(el, rect) {
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight, pad = 8;
    el.style.left = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad)) + 'px';
    el.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + 'px';
  }
  function openMenu() {
    menu.querySelectorAll('[data-aspect]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.aspect === aspect)));
    placeBeside(menu, btn.getBoundingClientRect());
  }
  menu.onclick = e => {
    const b = e.target.closest('[data-aspect]');
    if (!b) return;
    aspect = b.dataset.aspect;
    menu.hidden = true;
    requestTool('capture');
  };
  let holdT = null, held = false;
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    held = false;
    holdT = setTimeout(() => { held = true; openMenu(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => btn.addEventListener(t, () => clearTimeout(holdT)));
  btn.addEventListener('click', () => {
    if (held) { held = false; return; }
    if (active) { if (menu.hidden) openMenu(); else menu.hidden = true; return; }
    menu.hidden = true;
    requestTool('capture');
  });
  btn.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(); });
  document.addEventListener('click', e => { if (!e.target.closest('#shot-menu, #tool-shot')) menu.hidden = true; });

  /* ---- drawing the area: a rectangle with the dim outside it ---- */
  const rectEl = document.createElement('div');
  rectEl.className = 'shot-rect';
  rectEl.hidden = true;
  mapEl.appendChild(rectEl);
  // the map container, not the canvas: the canvas container can report no height of its own
  const local = e => { const r = mapEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // the rectangle from the drag's start to the pointer; a fixed shape keeps its ratio (the longer way wins)
  function rectFor(d, x, y) {
    let dx = x - d.x0, dy = y - d.y0;
    const ratio = ASPECTS[aspect].ratio;
    if (ratio) {
      let w = Math.abs(dx), h = Math.abs(dy);
      if (w / h > ratio) h = w / ratio; else w = h * ratio;
      dx = (dx < 0 ? -1 : 1) * w;
      dy = (dy < 0 ? -1 : 1) * h;
    }
    return { x: Math.min(d.x0, d.x0 + dx), y: Math.min(d.y0, d.y0 + dy), w: Math.abs(dx), h: Math.abs(dy) };
  }
  function showRect(r) {
    Object.assign(rectEl.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    rectEl.hidden = false;
  }

  canvasBox.addEventListener('pointerdown', e => {
    if (!active || e.button !== 0 || busy) return;
    const p = local(e);
    drag = { id: e.pointerId, x0: p.x, y0: p.y, moved: false, last: p };
  });
  canvasBox.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const p = local(e);
    drag.last = p;
    if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) > 6) drag.moved = true;
    if (drag.moved) showRect(rectFor(drag, p.x, p.y));
  });
  canvasBox.addEventListener('pointerup', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    rectEl.hidden = true;
    if (!active) return;
    const r = d.moved ? rectFor(d, d.last.x, d.last.y) : null; // no drag: the whole visible map
    if (r && (r.w < 6 || r.h < 6)) return;
    capture(r);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drag) { drag = null; rectEl.hidden = true; }
  });

  /* ---- rendering: the highest zoom that fits, drawn at the capture size ---- */
  // the device-pixel size of the region when the map is at zoom z (the region is in CSS pixels at the current zoom)
  function pick(region) {
    const dpr = window.devicePixelRatio || 1, z0 = map.getZoom();
    const sizeAt = z => ({ w: region.w * 2 ** (z - z0), h: region.h * 2 ** (z - z0) });
    let z = Math.floor(map.getMaxZoom());
    const min = Math.ceil(map.getMinZoom());
    while (z > min && Math.max(sizeAt(z).w, sizeAt(z).h) * dpr > MAX_SIDE) z -= 1;
    return { zoom: z, size: sizeAt(z) };
  }

  // draws the map at `zoom` centred on `center`, in a canvas of cssW x cssH CSS pixels; then puts the view back
  async function renderAt(cssW, cssH, center, zoom) {
    const prev = { center: map.getCenter(), zoom: map.getZoom() };
    box.style.width = cssW + 'px';
    box.style.height = cssH + 'px';
    try {
      map.resize();
      const idle = new Promise(res => { map.once('idle', res); setTimeout(res, 30000); });
      map.jumpTo({ center, zoom });
      await idle;
      const src = map.getCanvas();
      const base = document.createElement('canvas');
      base.width = src.width;
      base.height = src.height;
      const copied = new Promise(res => {
        map.once('render', () => { base.getContext('2d').drawImage(src, 0, 0); res(); });
        map.triggerRepaint();
      });
      await copied;
      return { base, svg: drawing.snapshot(cssW, cssH) };
    } finally {
      box.style.width = '';
      box.style.height = '';
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

      // the drawings go on top
      const out = document.createElement('canvas');
      out.width = base.width;
      out.height = base.height;
      const g = out.getContext('2d');
      g.drawImage(base, 0, 0);
      if (svg.includes('<line') || svg.includes('<path') || svg.includes('<polygon') || svg.includes('<rect') || svg.includes('<ellipse') || svg.includes('<polyline')) {
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await img.decode();
        g.drawImage(img, 0, 0, out.width, out.height);
      }
      const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', JPEG_QUALITY));
      show(blob, out.width, out.height);
    } catch (e) {
      console.error(e);
      toast('Could not take the screenshot.', 4000);
    } finally {
      busy = false;
      setBusy(false);
      requestTool('pan'); // one picture at a time: back to the hand
    }
  }

  function show(blob, w, h) {
    if (current) URL.revokeObjectURL(current.url);
    const { file: base, label } = names();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const name = `${base}-${stamp}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    current = { url: URL.createObjectURL(blob), name, file };
    card.querySelector('img').src = current.url;
    card.querySelector('.shot-size').textContent = `${w} × ${h}`;
    card.querySelector('[data-act="share"]').hidden = false; // always offered; share() explains when the browser cannot
    card.hidden = false;
  }

  /* ---- the mode, from the tool stack ---- */
  function setActive(on) {
    active = on;
    if (!on) { drag = null; rectEl.hidden = true; }
    mapEl.classList.toggle('tool-capture', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  return { setActive };
}
