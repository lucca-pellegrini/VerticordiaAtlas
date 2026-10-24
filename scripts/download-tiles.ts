// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://tiles.mapgenie.io/games/resident-evil-requiem/world/default-v2";
const OUT = "./public/maps/requiem/tiles";
const MIN_Z = 8,
	MAX_Z = Number(process.argv[2] ?? 14);
const CONCURRENCY = 4,
	DELAY_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) =>
	access(p).then(
		() => true,
		() => false,
	);

const jobs: [number, number, number][] = [];
for (let z = MIN_Z; z <= MAX_Z; z++) {
	const n = 2 ** (z - 8),
		start = 127 * n;
	for (let x = start; x < start + n; x++) for (let y = start; y < start + n; y++) jobs.push([z, x, y]);
}

let i = 0,
	processed = 0,
	saved = 0,
	skipped = 0,
	missing = 0,
	failed = 0,
	bytes = 0;

async function getTile([z, x, y]: [number, number, number]) {
	const file = path.join(OUT, String(z), String(x), `${y}.jpg`);
	if (await exists(file)) {
		skipped++;
		return;
	}
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const r = await fetch(`${BASE}/${z}/${x}/${y}.jpg`, {
				headers: { Referer: "https://mapgenie.io/", "User-Agent": "Mozilla/5.0" },
			});
			if (r.status === 404) {
				missing++;
				return;
			}
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const buf = Buffer.from(await r.arrayBuffer());
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, buf);
			saved++;
			bytes += buf.length;
			return;
		} catch {
			await sleep(500 * attempt);
		}
	}
	failed++;
}

async function worker() {
	while (i < jobs.length) {
		await getTile(jobs[i++]);
		processed++;
		if (processed % 200 === 0)
			console.log(
				`${processed}/${jobs.length}  saved ${saved}  skipped ${skipped}  missing ${missing}  failed ${failed}  ${(bytes / 1e6).toFixed(1)} MB`,
			);
		await sleep(DELAY_MS);
	}
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(
	`Done. saved ${saved}, skipped ${skipped}, missing ${missing}, failed ${failed}, ${(bytes / 1e6).toFixed(1)} MB`,
);