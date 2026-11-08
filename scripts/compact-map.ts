#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// compact-map.ts: writes data.compact.json and data.details.json beside a map's data.json (the client's slim payload
// and its lazy descriptions/media; see src/shared/compact-map.ts). data.json is only read, never changed.
// usage: bun scripts/compact-map.ts public/maps/<game>/<map> [...]   (a map folder or its data.json)

import { stat } from "node:fs/promises";
import path from "node:path";

import { compactPath, detailsPath, toCompact } from "../src/shared/compact-map.ts";

const exists = (f: string) =>
	stat(f).then(
		() => true,
		() => false,
	);

export async function writeCompact(mapDir: string): Promise<{ data: number; compact: number; details: number }> {
	const dataFile = path.join(mapDir, "data.json");
	const text = await Bun.file(dataFile).text();
	const { compact, details } = toCompact(JSON.parse(text));
	const c = JSON.stringify(compact),
		d = JSON.stringify(details);
	await Bun.write(compactPath(dataFile), c);
	await Bun.write(detailsPath(dataFile), d);
	return { data: Buffer.byteLength(text), compact: Buffer.byteLength(c), details: Buffer.byteLength(d) };
}

// the maps[] entry of the game's meta.json names the compact file, so the client only asks for maps that have one
async function listCompact(mapDir: string): Promise<void> {
	const metaFile = path.join(path.dirname(mapDir), "meta.json");
	const meta = await Bun.file(metaFile).json();
	const rel = `${path.basename(mapDir)}/data.json`;
	const entry = (meta.maps || []).find((m: any) => m.data === rel);
	if (!entry) throw new Error(`${metaFile} has no map with data "${rel}"`);
	entry.compact = compactPath(rel);
	await Bun.write(metaFile, JSON.stringify(meta, null, "\t") + "\n");
}

// for the scrapers' meta.json entries: { compact } when the map has a compact file, so a rebuilt entry keeps it
export async function compactEntry(mapDir: string, dataRel: string): Promise<{ compact?: string }> {
	return (await exists(compactPath(path.join(mapDir, "data.json")))) ? { compact: compactPath(dataRel) } : {};
}

// for the scrapers: a map that already has a compact file gets it made again from its new data.json, so the client
// never reads a stale one. A map without one stays without (the client then reads data.json).
export async function refreshCompact(mapDir: string): Promise<void> {
	if (await exists(compactPath(path.join(mapDir, "data.json")))) await writeCompact(mapDir);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (!args.length) {
		console.error("usage: bun scripts/compact-map.ts <map folder | data.json> [...]");
		process.exit(1);
	}
	for (const a of args) {
		const dir = a.endsWith(".json") ? path.dirname(a) : a;
		const s = await writeCompact(dir);
		await listCompact(dir);
		console.log(
			`${dir}: data.json ${s.data} B -> compact ${s.compact} B + details ${s.details} B; meta.json lists it (run bun fmt on it)`,
		);
	}
}