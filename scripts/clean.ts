#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// clean.ts: remove everything `bun run build` and `bun run precompress` regenerate under public/ (client bundles,
// sw.js, and the .br/.gz sidecars). Sidecars are not tracked, so nothing committed is touched.

import { rm } from "node:fs/promises";
import path from "node:path";

import { CLIENT_TARGETS } from "./build.ts";

const REPO = path.resolve(import.meta.dir, "..");
const PUBLIC = path.join(REPO, "public");

const bundles = [...CLIENT_TARGETS.map((target) => path.join(REPO, target.outfile)), path.join(PUBLIC, "sw.js")];
for (const file of bundles) await rm(file, { force: true });

for await (const rel of new Bun.Glob("**/*.{br,gz}").scan({ cwd: PUBLIC }))
	await rm(path.join(PUBLIC, rel), { force: true });