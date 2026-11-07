#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// precompress.ts: creates .br and .gz sidecars for static text assets in public/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(REPO, "public");
const MIN_SIZE = 1024;
const TEXT_EXTS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".xml", ".md"]);

export interface PrecompressStats {
	scanned: number;
	compressed: number;
	skipped: number;
}

export function isStaticText(file: string): boolean {
	const ext = path.extname(file).toLowerCase();
	return TEXT_EXTS.has(ext);
}

export function needsSidecar(srcMtimeMs: number, sidecarPath: string): boolean {
	try {
		const st = fs.statSync(sidecarPath);
		return st.mtimeMs < srcMtimeMs;
	} catch {
		return true;
	}
}

export function precompressFile(file: string): { br: boolean; gz: boolean } {
	const st = fs.statSync(file);
	if (!st.isFile() || st.size < MIN_SIZE || !isStaticText(file)) {
		return { br: false, gz: false };
	}

	const brPath = `${file}.br`;
	const gzPath = `${file}.gz`;
	const needBr = needsSidecar(st.mtimeMs, brPath);
	const needGz = needsSidecar(st.mtimeMs, gzPath);

	if (!needBr && !needGz) {
		return { br: false, gz: false };
	}

	const buf = fs.readFileSync(file);
	let didBr = false;
	let didGz = false;

	if (needBr) {
		// Large JSON (> 256 KB) uses quality 5 to save deploy time; smaller files use max quality 11
		const quality = file.endsWith(".json") && st.size > 256 * 1024 ? 5 : 11;
		const brBuf = zlib.brotliCompressSync(buf, {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: quality,
			},
		});
		fs.writeFileSync(brPath, brBuf);
		didBr = true;
	}

	if (needGz) {
		const gzBuf = zlib.gzipSync(buf, { level: 9 });
		fs.writeFileSync(gzPath, gzBuf);
		didGz = true;
	}

	return { br: didBr, gz: didGz };
}

export function walkDirectory(dir: string, onFile: (filePath: string) => void): void {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				entry.name === "cache" ||
				entry.name === "node_modules" ||
				entry.name.startsWith(".") ||
				entry.name === "tiles" ||
				entry.name === "media"
			) {
				continue;
			}
			walkDirectory(fullPath, onFile);
		} else if (entry.isFile()) {
			if (!entry.name.endsWith(".br") && !entry.name.endsWith(".gz")) {
				onFile(fullPath);
			}
		}
	}
}

export function precompressAll(targetDir = PUBLIC): PrecompressStats {
	const stats: PrecompressStats = { scanned: 0, compressed: 0, skipped: 0 };
	walkDirectory(targetDir, (file) => {
		stats.scanned++;
		const { br, gz } = precompressFile(file);
		if (br || gz) {
			stats.compressed++;
		} else {
			stats.skipped++;
		}
	});
	return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const t0 = performance.now();
	const stats = precompressAll();
	const ms = (performance.now() - t0).toFixed(0);
	console.log(
		`Precompressed ${stats.compressed} file(s) (${stats.skipped} skipped/up-to-date, ${stats.scanned} scanned) in ${ms}ms.`,
	);
}