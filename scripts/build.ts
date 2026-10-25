#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// build.ts: bundles client TypeScript entrypoints in src/client/ into public/, verifies all Service Worker precache paths, and injects a content-addressed version into public/sw.js.

import crypto from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PRECACHE } from "../src/client/sw.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(REPO, "public");
const exists = (p: string) =>
	access(p).then(
		() => true,
		() => false,
	);

export interface BuildTarget {
	entry: string;
	outfile: string;
	format?: "esm" | "iife";
	define?: Record<string, string>;
}

export const CLIENT_TARGETS: BuildTarget[] = [
	{ entry: "src/client/app.ts", outfile: "public/app.js", format: "esm" },
	{ entry: "src/client/home.ts", outfile: "public/home.js", format: "esm" },
	{ entry: "src/client/theme.ts", outfile: "public/theme.js", format: "esm" },
	{ entry: "src/client/signin.ts", outfile: "public/signin/signin.js", format: "esm" },
	{ entry: "src/client/account-page.ts", outfile: "public/account/account.js", format: "esm" },
	{ entry: "src/client/legal.ts", outfile: "public/legal/legal.js", format: "iife" },
];

export function resolvePrecacheFile(relPath: string): string {
	if (relPath === "") return path.join(PUBLIC, "index.html");
	if (relPath.endsWith("/")) return path.join(PUBLIC, relPath, "index.html");
	return path.join(PUBLIC, relPath);
}

export async function verifyAndHashPrecache(): Promise<string> {
	const hash = crypto.createHash("sha256");
	for (const item of PRECACHE) {
		const diskPath = resolvePrecacheFile(item);
		if (!(await exists(diskPath))) {
			throw new Error(`Service worker PRECACHE entry "${item}" does not exist on disk at ${diskPath}`);
		}
		hash.update(item);
		hash.update("\0");
		hash.update(await readFile(diskPath));
		hash.update("\0");
	}
	return `v40-${hash.digest("hex").slice(0, 8)}`;
}

async function runBundle(target: BuildTarget): Promise<boolean> {
	const entryPath = path.join(REPO, target.entry);
	if (!(await exists(entryPath))) return false;
	const outPath = path.join(REPO, target.outfile);
	const result = await Bun.build({
		entrypoints: [entryPath],
		outdir: path.dirname(outPath),
		naming: path.basename(outPath),
		target: "browser",
		format: target.format ?? "esm",
		minify: false,
		sourcemap: "none",
		...(target.define ? { define: target.define } : {}),
	});
	if (!result.success) {
		const msg = result.logs.map((l) => l.message || String(l)).join("\n");
		throw new Error(`Bun.build failed for ${target.entry}:\n${msg}`);
	}
	return true;
}

export async function buildClient(opts: { quiet?: boolean } = {}): Promise<void> {
	const t0 = performance.now();
	let builtCount = 0;

	for (const target of CLIENT_TARGETS) {
		if (await runBundle(target)) builtCount++;
	}

	const swVersion = await verifyAndHashPrecache();
	if (
		await runBundle({
			entry: "src/client/sw.ts",
			outfile: "public/sw.js",
			format: "iife",
			define: { __SW_VERSION__: JSON.stringify(swVersion) },
		})
	) {
		builtCount++;
	}

	if (!opts.quiet && builtCount > 0) {
		const ms = (performance.now() - t0).toFixed(0);
		console.log(`Built ${builtCount} client bundle(s) in ${ms}ms (SW ${swVersion}).`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await buildClient();
}