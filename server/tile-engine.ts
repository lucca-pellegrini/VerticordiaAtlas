// tile-engine.ts: the image side of the tile strategy. Only the highest zoom of a map is scraped; the lowest zoom (the
// overview) is generated once, and the zooms in between are made on demand by stitching four tiles of the next zoom
// and shrinking the result by half. Tiles that are a single colour (the black or grey outside a map) are stored once
// per tile set and hard-linked everywhere else, so they take no disk space.
//
// sharp is loaded on first use, so the server and the tests still start when it is not installed.

import { link, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const TILE = 256;
const BYTES = TILE * TILE * 4;

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | null = null;
export const loadSharp = (): Promise<Sharp> => (sharpModule ??= import("sharp").then((m) => m.default));

/* ---------- the tile path of a tile set: "{z}/{y}/{x}.jpg" or "{z}/{x}/{y}.png" ---------- */

export interface TileTail {
	order: ("z" | "x" | "y")[];
	ext: string;
}

export function parseTail(tail: string): TileTail | null {
	const m = /^\{([zxy])\}\/\{([zxy])\}\/\{([zxy])\}\.([a-z0-9]+)$/i.exec(tail);
	if (!m || new Set([m[1], m[2], m[3]]).size !== 3) return null;
	return { order: [m[1], m[2], m[3]] as TileTail["order"], ext: m[4].toLowerCase() };
}

// a template as stored in meta.json ("world/tiles/default-v2/{z}/{y}/{x}.jpg") split into its folder and its tail
export function splitTemplate(template: string): { base: string; tail: TileTail } | null {
	const at = template.indexOf("{");
	if (at < 0) return null;
	const tail = parseTail(template.slice(at));
	return tail ? { base: template.slice(0, at), tail } : null;
}

export const tilePath = (tail: TileTail, z: number, x: number, y: number): string => {
	const v = { z, x, y };
	return `${v[tail.order[0]]}/${v[tail.order[1]]}/${v[tail.order[2]]}.${tail.ext}`;
};

export function parseTilePath(tail: TileTail, rel: string): { z: number; x: number; y: number } | null {
	const m = /^(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.([a-z0-9]+)$/i.exec(rel);
	if (!m || m[4].toLowerCase() !== tail.ext) return null;
	const v: Record<string, number> = {};
	tail.order.forEach((k, i) => (v[k] = Number(m[i + 1])));
	const n = 2 ** v.z;
	return v.x < n && v.y < n ? { z: v.z, x: v.x, y: v.y } : null;
}

export const contentType = (ext: string): string =>
	({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[ext] ||
	"application/octet-stream";

// Is the tile inside the lon/lat box of a tile set (with a tile to spare, as the box is only roughly the map's shape)?
export function tileInBounds(bounds: number[] | undefined, z: number, x: number, y: number): boolean {
	if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite)) return true;
	const n = 2 ** z,
		[w, s, e, nn] = bounds;
	const lat = (v: number) => {
		const r = (Math.max(-85.05, Math.min(85.05, v)) * Math.PI) / 180;
		return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
	};
	const x0 = ((w + 180) / 360) * n - 1,
		x1 = ((e + 180) / 360) * n + 1,
		y0 = lat(nn) - 1,
		y1 = lat(s) + 1;
	return x + 1 > x0 && x < x1 && y + 1 > y0 && y < y1;
}

/* ---------- pixels: decoded tiles are 256 x 256 RGBA buffers ---------- */

export type Raw = Buffer;

export async function decodeTile(buf: Buffer): Promise<Raw> {
	const sharp = await loadSharp();
	let img = sharp(buf).ensureAlpha();
	const meta = await sharp(buf).metadata();
	if (meta.width !== TILE || meta.height !== TILE) img = img.resize(TILE, TILE, { fit: "fill" });
	return img.raw().toBuffer();
}

export async function encodeTile(raw: Raw, ext: string, quality = 85): Promise<Buffer> {
	const sharp = await loadSharp();
	const img = sharp(raw, { raw: { width: TILE, height: TILE, channels: 4 } });
	if (ext === "jpg" || ext === "jpeg") return img.removeAlpha().jpeg({ quality }).toBuffer();
	if (ext === "webp") return img.webp({ quality }).toBuffer();
	return img.png({ compressionLevel: 6 }).toBuffer();
}

// "rrggbbaa" when every pixel of the tile is the same colour, otherwise null
export function solidKey(raw: Raw): string | null {
	if (raw.length !== BYTES) return null;
	const a = raw[0],
		b = raw[1],
		c = raw[2],
		d = raw[3];
	for (let i = 4; i < raw.length; i += 4) {
		if (raw[i] !== a || raw[i + 1] !== b || raw[i + 2] !== c || raw[i + 3] !== d) return null;
	}
	return Buffer.from([a, b, c, d]).toString("hex");
}

export const rgbaOfKey = (key: string): [number, number, number, number] => [
	parseInt(key.slice(0, 2), 16),
	parseInt(key.slice(2, 4), 16),
	parseInt(key.slice(4, 6), 16),
	parseInt(key.slice(6, 8), 16),
];

// "#rrggbb" (what meta.json stores) -> an opaque colour; anything else -> null
export function parseBackground(hex: unknown): [number, number, number, number] | null {
	const m = typeof hex === "string" ? /^#([0-9a-f]{6})$/i.exec(hex) : null;
	return m ? rgbaOfKey(m[1] + "ff") : null;
}

/* ---------- making a tile from the four of the next zoom ---------- */

export interface DeriveOptions {
	maxZoom: number; // the zoom that is stored: nothing below it is looked for
	read: (z: number, x: number, y: number) => Promise<Buffer | null>; // an existing tile (the stored or a cached one)
	background?: [number, number, number, number] | null; // the colour of a missing quarter; transparent when absent
	store?: (z: number, x: number, y: number, raw: Raw) => Promise<void>; // told of every tile made on the way
}

function fill(buf: Buffer, rgba: [number, number, number, number]): void {
	buf.set(rgba, 0);
	for (let n = 4; n < buf.length; n *= 2) buf.copyWithin(n, 0, Math.min(n, buf.length - n));
}

// one tile at a time, depth first: memory stays at a few tiles however many tiles lie below
export async function deriveRaw(z: number, x: number, y: number, o: DeriveOptions, top = true): Promise<Raw | null> {
	if (!top) {
		const have = await o.read(z, x, y);
		if (have) return decodeTile(have);
	}
	if (z >= o.maxZoom) return null;
	const kids: (Raw | null)[] = [];
	for (const [dx, dy] of [
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
	])
		kids.push(await deriveRaw(z + 1, 2 * x + dx, 2 * y + dy, o, false));
	if (kids.every((k) => !k)) return null;
	const big = Buffer.alloc(BYTES * 4);
	if (kids.some((k) => !k) && o.background) fill(big, o.background);
	kids.forEach((k, i) => {
		if (!k) return;
		const left = (i % 2) * TILE,
			top2 = (i >> 1) * TILE;
		for (let r = 0; r < TILE; r++)
			k.copy(big, ((top2 + r) * TILE * 2 + left) * 4, r * TILE * 4, (r + 1) * TILE * 4);
	});
	const sharp = await loadSharp();
	const raw = await sharp(big, { raw: { width: TILE * 2, height: TILE * 2, channels: 4 } })
		.resize(TILE, TILE, { kernel: "lanczos3" })
		.raw()
		.toBuffer();
	if (!top && o.store) await o.store(z, x, y, raw);
	return raw;
}

/* ---------- writing tiles: a single-colour tile is a hard link to the one copy of that colour ---------- */

const tmpName = (file: string): string => `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

// the one stored copy of a colour, in the folder of the tile set
export const solidFile = (dir: string, key: string, ext: string): string => path.join(dir, `solid-${key}.${ext}`);

async function writeAtomic(file: string, buf: Buffer): Promise<void> {
	const tmp = tmpName(file);
	await writeFile(tmp, buf);
	await rename(tmp, file);
}

export async function placeTile(
	file: string,
	buf: Buffer,
	solid: { key: string; dir: string; ext: string } | null,
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	if (solid) {
		const canon = solidFile(solid.dir, solid.key, solid.ext);
		const tmp = tmpName(file);
		try {
			try {
				await link(canon, tmp);
			} catch {
				await writeAtomic(canon, buf);
				await link(canon, tmp);
			}
			await rename(tmp, file);
			return;
		} catch {
			/* a file system without hard links: store the tile as it is */
		}
	}
	await writeAtomic(file, buf);
}

// Turn an existing tile file into a link to the stored copy of its colour. Returns the bytes that were freed, or null
// when the tile is not a single colour. Tiles above `maxBytes` are not even decoded: a flat colour is always small.
export async function dedupeSolid(
	file: string,
	dir: string,
	ext: string,
	maxBytes = 8192,
): Promise<{ key: string; freed: number } | null> {
	const st = await stat(file);
	if (st.size > maxBytes) return null;
	const buf = await readFile(file);
	const key = solidKey(await decodeTile(buf));
	if (!key) return null;
	const canon = solidFile(dir, key, ext);
	let cs: Awaited<ReturnType<typeof stat>> | null = null;
	try {
		cs = await stat(canon);
	} catch {
		try {
			await link(file, canon); // the first tile of this colour becomes the stored copy
			return { key, freed: 0 };
		} catch {
			cs = await stat(canon); // another tile of this colour got there first
		}
	}
	if (cs.ino === st.ino && cs.dev === st.dev) return { key, freed: 0 };
	const tmp = tmpName(file);
	await link(canon, tmp);
	await rename(tmp, file);
	return { key, freed: st.nlink > 1 ? 0 : st.size };
}