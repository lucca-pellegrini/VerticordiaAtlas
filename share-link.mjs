// share-link.mjs: a marker the user made, packed into a link. The marker travels inside the URL (JSON, deflated,
// then base64url), so nothing is stored on a server. Opening such a link adds the marker as a temporary one.
// Used by the page (app.js, usermarkers.js) and by the server (server.mjs, for the link's preview card).

const MAX_TITLE = 120, MAX_CATEGORY = 80, MAX_DESC = 1200, MAX_LENGTH = 4000;
const round = n => Math.round(n * 1e6) / 1e6;

function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

// the link's packed form of a marker
export async function packMarker({ title, category = '', desc = '', lat, lng, map }) {
  const payload = {
    v: 1,
    title: String(title || 'Marker').slice(0, MAX_TITLE),
    category: String(category || '').slice(0, MAX_CATEGORY),
    desc: String(desc || '').slice(0, MAX_DESC),
    lat: round(lat), lng: round(lng),
    map: String(map || ''),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

// the marker in a packed link, or null when the link is not a valid one
export async function unpackMarker(str) {
  try {
    if (typeof str !== 'string' || !str || str.length > MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
    const json = new TextDecoder().decode(await pipe(fromBase64Url(str), new DecompressionStream('deflate-raw')));
    const p = JSON.parse(json);
    if (p.v !== 1 || typeof p.title !== 'string' || !p.title) return null;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
    return {
      title: p.title.slice(0, MAX_TITLE),
      category: String(p.category || '').slice(0, MAX_CATEGORY),
      desc: String(p.desc || '').slice(0, MAX_DESC),
      lat: p.lat, lng: p.lng,
      map: String(p.map || '').slice(0, 80),
    };
  } catch {
    return null;
  }
}
