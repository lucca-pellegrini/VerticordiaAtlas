#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// backup-db.ts: safely snapshots data/atlas.db using SQLite's online VACUUM INTO command and rotates older backups.
//
//   bun scripts/backup-db.ts [--db data/atlas.db] [--out-dir backups] [--keep 14]

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");

export interface BackupOptions {
	dbPath?: string;
	outDir?: string;
	keep?: number;
	now?: Date;
}

export interface BackupResult {
	backupFile: string;
	bytes: number;
	pruned: string[];
}

function formatTimestamp(d: Date): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
		`${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-` +
		`${pad(d.getUTCMilliseconds(), 3)}`
	);
}

export async function backupDatabase(opts: BackupOptions = {}): Promise<BackupResult> {
	const dbPath = path.resolve(opts.dbPath || process.env.ATLAS_DB_PATH || path.join(REPO, "data", "atlas.db"));
	const outDir = path.resolve(opts.outDir || process.env.BACKUP_DIR || path.join(REPO, "backups"));
	const keep = Math.max(1, Number(opts.keep ?? process.env.BACKUP_KEEP ?? 14));
	const timestamp = formatTimestamp(opts.now || new Date());

	if (!existsSync(dbPath)) {
		throw new Error(`Database file not found: ${dbPath}`);
	}

	mkdirSync(outDir, { recursive: true });
	const backupName = `atlas-${timestamp}.db`;
	const backupFile = path.join(outDir, backupName);

	const db = new Database(dbPath, { readonly: false, strict: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000;");
		const escapedTarget = backupFile.replace(/'/g, "''");
		db.exec(`VACUUM INTO '${escapedTarget}';`);
	} finally {
		db.close();
	}

	const st = await stat(backupFile);
	const entries = (await readdir(outDir)).filter((name) => /^atlas-\d{8}-\d{6}(?:-\d{3})?\.db$/.test(name)).sort();

	const pruned: string[] = [];
	while (entries.length > keep) {
		const oldest = entries.shift()!;
		const full = path.join(outDir, oldest);
		await unlink(full).catch(() => {});
		pruned.push(full);
	}

	return {
		backupFile,
		bytes: st.size,
		pruned,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const opt = (name: string): string | undefined => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined;
	};
	const res = await backupDatabase({
		dbPath: opt("db"),
		outDir: opt("out-dir"),
		keep: opt("keep") ? Number(opt("keep")) : undefined,
	});
	console.log(
		`Backup created: ${res.backupFile} (${(res.bytes / 1024).toFixed(1)} KB)` +
			(res.pruned.length ? `, rotated ${res.pruned.length} older backup(s)` : ""),
	);
}