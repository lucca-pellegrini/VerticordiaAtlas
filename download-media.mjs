import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const data = JSON.parse(await readFile('./map-882-mapdata.json', 'utf8'));
const urls = [...new Set(data.locations.flatMap(l => (l.media ?? []).map(m => m.url)))];
const OUT = './re9/media';
await mkdir(OUT, { recursive: true });

let i = 0, saved = 0, skipped = 0, failed = 0, bytes = 0;
const exists = p => access(p).then(() => true, () => false);

async function worker() {
  while (i < urls.length) {
    const url = urls[i++];
    const file = path.join(OUT, path.basename(new URL(url).pathname));
    if (await exists(file)) { skipped++; continue; }
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        const r = await fetch(url, { headers: { Referer: 'https://mapgenie.io/', 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        await writeFile(file, buf);
        saved++; bytes += buf.length; done = true;
      } catch { await new Promise(r => setTimeout(r, 500 * attempt)); }
    }
    if (!done) { failed++; console.log('failed', url); }
    await new Promise(r => setTimeout(r, 100));
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log(`saved ${saved}, skipped ${skipped}, failed ${failed}, ${(bytes / 1e6).toFixed(1)} MB`);
