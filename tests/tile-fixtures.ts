// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { readdirSync } from "node:fs";
import path from "node:path";

function hasFileUnder(dir: string): boolean {
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = path.join(dir, entry.name);
			if (entry.isFile()) return true;
			if (entry.isDirectory() && hasFileUnder(child)) return true;
		}
	} catch {
		// Missing, unreadable, or not a directory: treat as no fixture.
	}
	return false;
}

export function hasTileFixtures(game: string, maps: string[], root = process.cwd()): boolean {
	return maps.every(
		(map) =>
			hasFileUnder(path.join(root, "public", "maps", game, map, "tiles")) ||
			hasFileUnder(path.join(root, "cache", "tiles", game, map)),
	);
}