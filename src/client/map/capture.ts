// capture.ts: screenshots of the map. A tap captures the whole visible map; a drag captures a rectangle (with an
// optional fixed shape). The image is rendered at the highest zoom the tiles allow, stepping down one level at a
// time until it fits in MAX_SIDE device pixels. Drawings are composited on top of the map; text notes and the
// selection outline are not part of the picture.

import { ICONS } from '../icons.ts';
import type { DrawingController } from './drawing.ts';

const MAX_SIDE = 4096;
const JPEG_QUALITY = 0.92;
const ASPECTS: Record<string, { name: string; ratio: number | null; icon: string }> = {
  free: { name: 'Free', ratio: null, icon: '<rect x="4.5" y="5.5" width="15" height="13" rx="1.5" stroke-dasharray="3 2.5"/>' },
  square: { name: 'Square (1:1)', ratio: 1, icon: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>' },
  wide: { name: 'Widescreen (16:9)', ratio: 16 / 9, icon: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.5"/>' },
  phone: { name: 'Phone (9:16)', ratio: 9 / 16, icon: '<rect x="7" y="2.5" width="10" height="19" rx="2"/>' },
};
const CAMERA = '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>';
const DOWNLOAD = '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>';
const CLOSE = '<path d="M6 6l12 12M18 6L6 18"/>';
const shot = (inner: string) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

export const CAPTURE_CONTROL_HTML =
  `<button type="button" id="tool-shot" class="notched" aria-label="Screenshot" title="Screenshot. Tap for the whole view, or drag an area. Right-click or hold for the shape">` +
  `<svg viewBox="0 0 24 24" aria-hidden="true">${CAMERA}</svg></button>`;

export interface CaptureController {
  setActive(on: boolean): void;
}

export function setupCapture({
  map,
  mapEl,
  canvasBox,
  drawing,
  requestTool,
  names,
  toast,
  setBusy,
}: {
  map: maplibregl.Map;
  mapEl: HTMLElement;
  canvasBox: HTMLElement;
  drawing: DrawingController;
  requestTool: (tool: string) => void;
  names: () => { file: string; label: string };
  toast: (msg: string, ms?: number) => void;
  setBusy: (busy: boolean) => void;
}): CaptureController {
  const box = map.getContainer();
  const btn = document.getElementById('tool-shot')!;
  let active = false, aspect = 'free', busy = false;
  let drag: { id: number; x0: number; y0: number; moved: boolean; last: { x: number; y: number } } | null = null;
  let current: { url: string; name: string; file: File } | null = null;

  /* ---- the thumbnail ---- */
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
    const b = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
    if (!b || !current) return;
    if (b.dataset.act === 'close') { card.hidden = true; return; }
    if (b.dataset.act === 'download') download();
    if (b.dataset.act === 'share') share();
  };
  function download(): void {
    if (!current) return;
    const a = document.createElement('a');
    a.href = current.url;
    a.download = current.name;
    a.click();
  }
  async function share(): Promise<void> {
    if (!current) return;
    const data = { files: [current.file], title: names().label };
    const possible = typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(data));
    if (!possible) { toast('Sharing is not available in this browser. Use Download instead.', 4000); return; }
    try { await navigator.share(data); }
    catch (e: any) { if (e.name !== 'AbortError') toast('Could not share the image. Use Download instead.', 4000); }
  }

  /* ---- the shape menu ---- */
  const menu = document.createElement('div');
  menu.id = 'shot-menu';
  menu.className = 'menu row-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = Object.entries(ASPECTS).map(([k, a]) =>
    `<button type="button" role="menuitemradio" data-aspect="${k}" aria-checked="false">${shot(a.icon)}<span>${a.name}</span></button>`).join('');
  document.body.appendChild(menu);
  function placeBeside(el: HTMLElement, rect: DOMRect): void {
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight, pad = 8;
    el.style.left = Math.max(pad, Math.min(rect.left - 8 - w, innerWidth - w - pad)) + 'px';
    el.style.top = Math.max(pad, Math.min(rect.top, innerHeight - h - pad)) + 'px';
  }
  function openMenu(): void {
    menu.querySelectorAll<HTMLElement>('[data-aspect]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.aspect === aspect)));
    placeBeside(menu, btn.getBoundingClientRect());
  }
  menu.onclick = e => {
    const b = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-aspect]');
    if (!b || !b.dataset.aspect) return;
    aspect = b.dataset.aspect;
    menu.hidden = true;
    requestTool('capture');
  };
  let holdT: ReturnType<typeof setTimeout> | null = null, held = false;
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    held = false;
    holdT = setTimeout(() => { held = true; openMenu(); }, 500);
  });
  (['pointerup', 'pointerleave', 'pointercancel'] as const).forEach(t => btn.addEventListener(t, () => { if (holdT) clearTimeout(holdT); }));
  btn.addEventListener('click', () => {
    if (held) { held = false; return; }
    if (active) { if (menu.hidden) openMenu(); else menu.hidden = true; return; }
    menu.hidden = true;
    requestTool('capture');
  });
  btn.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(); });
  document.addEventListener('click', e => { if (!(e.target as HTMLElement | null)?.closest('#shot-menu, #tool-shot')) menu.hidden = true; });

  /* ---- drawing the area ---- */
  const rectEl = document.createElement('div');
  rectEl.className = 'shot-rect';
  rectEl.hidden = true;
  mapEl.appendChild(rectEl);
  const local = (e: PointerEvent) => { const r = mapEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function rectFor(d: { x0: number; y0: number }, x: number, y: number) {
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
  function showRect(r: { x: number; y: number; w: number; h: number }): void {
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
    const r = d.moved ? rectFor(d, d.last.x, d.last.y) : null;
    if (r && (r.w < 6 || r.h < 6)) return;
    capture(r);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drag) { drag = null; rectEl.hidden = true; }
  });

  /* ---- rendering ---- */
  function pick(region: { w: number; h: number }) {
    const dpr = window.devicePixelRatio || 1, z0 = map.getZoom();
    const sizeAt = (z: number) => ({ w: region.w * 2 ** (z - z0), h: region.h * 2 ** (z - z0) });
    let z = Math.floor(map.getMaxZoom());
    const min = Math.ceil(map.getMinZoom());
    while (z > min && Math.max(sizeAt(z).w, sizeAt(z).h) * dpr > MAX_SIDE) z -= 1;
    return { zoom: z, size: sizeAt(z) };
  }

  async function renderAt(cssW: number, cssH: number, center: maplibregl.LngLat, zoom: number) {
    const prev = { center: map.getCenter(), zoom: map.getZoom() };
    box.style.width = cssW + 'px';
    box.style.height = cssH + 'px';
    try {
      map.resize();
      const idle = new Promise<void>(res => { map.once('idle', () => res()); setTimeout(res, 30000); });
      map.jumpTo({ center, zoom });
      await idle;
      const src = map.getCanvas();
      const base = document.createElement('canvas');
      base.width = src.width;
      base.height = src.height;
      const copied = new Promise<void>(res => {
        map.once('render', () => { base.getContext('2d')!.drawImage(src, 0, 0); res(); });
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

  async function capture(rect: { x: number; y: number; w: number; h: number } | null): Promise<void> {
    busy = true;
    setBusy(true);
    try {
      const { width: W, height: H } = mapEl.getBoundingClientRect();
      const region = rect || { x: 0, y: 0, w: W, h: H };
      const center = map.unproject([region.x + region.w / 2, region.y + region.h / 2]);
      const { zoom, size } = pick(region);
      const cssW = Math.round(size.w), cssH = Math.round(size.h);
      const { base, svg } = await renderAt(cssW, cssH, center, zoom);

      const out = document.createElement('canvas');
      out.width = base.width;
      out.height = base.height;
      const g = out.getContext('2d')!;
      g.drawImage(base, 0, 0);
      if (svg.includes('<line') || svg.includes('<path') || svg.includes('<polygon') || svg.includes('<rect') || svg.includes('<ellipse') || svg.includes('<polyline')) {
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await img.decode();
        g.drawImage(img, 0, 0, out.width, out.height);
      }
      const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/jpeg', JPEG_QUALITY));
      if (blob) show(blob, out.width, out.height);
    } catch (e) {
      console.error(e);
      toast('Could not take the screenshot.', 4000);
    } finally {
      busy = false;
      setBusy(false);
      requestTool('pan');
    }
  }

  function show(blob: Blob, w: number, h: number): void {
    if (current) URL.revokeObjectURL(current.url);
    const { file: base } = names();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const name = `${base}-${stamp}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    current = { url: URL.createObjectURL(blob), name, file };
    card.querySelector<HTMLImageElement>('img')!.src = current.url;
    card.querySelector<HTMLElement>('.shot-size')!.textContent = `${w} × ${h}`;
    card.querySelector<HTMLElement>('[data-act="share"]')!.hidden = false;
    card.hidden = false;
  }

  function setActive(on: boolean): void {
    active = on;
    if (!on) { drag = null; rectEl.hidden = true; }
    mapEl.classList.toggle('tool-capture', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  return { setActive };
}
