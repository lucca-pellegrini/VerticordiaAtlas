#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// upload-media.ts: uploads marker screenshots to Cloudflare R2 (or S3-compatible storage), verifies their SHA-256
// over the public free-egress URL, records them in SQLite (data/atlas.db), and removes the local files.
//
//   bun scripts/upload-media.ts                           (upload all games under public/maps/*/media/)
//   bun scripts/upload-media.ts <slug> [<slug2> ...]      (upload all media for the given game slug(s))
//   bun scripts/upload-media.ts <path/to/file.jpg> [...]  (upload specific media file(s))
//
// Options:
//   --game <slug>        explicit game slug when uploading individual files outside public/maps/<slug>/media/
//   --maps-dir <dir>     root maps folder (default ./public/maps)
//   --keep-local         do not delete local files after R2 upload + SHA-256 verification
//   --force              re-upload even if already present in the SQLite media table
//   --concurrency <n>    parallel uploads (default 16)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { S3Client } from "bun";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");
export const CACHE_CONTROL = "public, max-age=31536000, immutable";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (n: number) => (n / 1e6).toFixed(1) + " MB";

export interface R2Config {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	endpoint: string;
	bucket: string;
	mediaUrl: string;
}

export interface MediaRecord {
	game: string;
	original_name: string;
	sha256: string;
	size: number;
	uploaded_at: number;
}

export function mimeForMedia(filename: string): string {
	const ext = path.extname(filename).toLowerCase();
	switch (ext) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".avif":
			return "image/avif";
		case ".svg":
			return "image/svg+xml";
		case ".mp4":
			return "video/mp4";
		case ".webm":
			return "video/webm";
		default:
			return "application/octet-stream";
	}
}

export function sha256Bytes(data: Uint8Array | ArrayBuffer | Buffer): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export function parseDotEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

// Validates that all variables in .env.r2.example are present and have been modified from their placeholder values.
export function validateR2Env({
	env = process.env,
	root = REPO,
	loadDotEnvFile = true,
}: {
	env?: Record<string, string | undefined>;
	root?: string;
	loadDotEnvFile?: boolean;
} = {}): R2Config {
	const examplePath = path.join(root, ".env.r2.example");
	const exampleVars = existsSync(examplePath)
		? parseDotEnv(readFileSync(examplePath, "utf8"))
		: {
				AWS_ACCESS_KEY_ID: "replace-me",
				AWS_SECRET_ACCESS_KEY: "replace-me",
				AWS_DEFAULT_REGION: "replace-me__us-east-1_recommended",
				R2_ENDPOINT: "https://replace-me.r2.cloudflarestorage.com",
				R2_BUCKET: "replace-me",
			};

	const merged: Record<string, string | undefined> = { ...env };
	if (loadDotEnvFile) {
		const r2EnvPath = path.join(root, ".env.r2");
		if (existsSync(r2EnvPath)) {
			const fileVars = parseDotEnv(readFileSync(r2EnvPath, "utf8"));
			for (const [k, v] of Object.entries(fileVars)) {
				if (!merged[k]) merged[k] = v;
			}
		}
	}

	const requiredKeys = Object.keys(exampleVars);
	const invalid: string[] = [];
	for (const key of requiredKeys) {
		const val = (merged[key] || "").trim();
		const placeholder = exampleVars[key];
		if (!val || val === placeholder || val.includes("replace-me")) {
			invalid.push(key);
		}
	}
	if (invalid.length > 0) {
		throw new Error(
			`Missing or unconfigured R2 environment variable(s): ${invalid.join(", ")}. Copy .env.r2.example to .env.r2 and set real values.`,
		);
	}

	const endpoint = merged.R2_ENDPOINT!.trim().replace(/\/+$/, "");
	if (!/^https?:\/\/[^/]+/.test(endpoint)) {
		throw new Error(`Invalid R2_ENDPOINT "${endpoint}": expected an HTTP(S) URL.`);
	}

	let mediaUrl = (merged.MEDIA_URL || "").trim();
	if (!mediaUrl) {
		const sitePath = path.join(root, "site.json");
		if (existsSync(sitePath)) {
			try {
				const site = JSON.parse(readFileSync(sitePath, "utf8"));
				if (typeof site.mediaUrl === "string") mediaUrl = site.mediaUrl.trim();
			} catch {}
		}
	}
	mediaUrl = mediaUrl.replace(/\/+$/, "");
	if (!/^https?:\/\/[^/]+$/.test(mediaUrl)) {
		throw new Error(
			`Missing or invalid "mediaUrl" in site.json (or MEDIA_URL env): expected an HTTP(S) base URL such as "https://atlas-media.verticordia.com".`,
		);
	}

	return {
		accessKeyId: merged.AWS_ACCESS_KEY_ID!.trim(),
		secretAccessKey: merged.AWS_SECRET_ACCESS_KEY!.trim(),
		region: merged.AWS_DEFAULT_REGION!.trim(),
		endpoint,
		bucket: merged.R2_BUCKET!.trim(),
		mediaUrl,
	};
}

export function createR2Client(cfg: R2Config): S3Client {
	return new S3Client({
		accessKeyId: cfg.accessKeyId,
		secretAccessKey: cfg.secretAccessKey,
		region: cfg.region,
		endpoint: cfg.endpoint,
		bucket: cfg.bucket,
	});
}

export function publicMediaUrl(mediaUrl: string, game: string, originalName: string): string {
	return `${mediaUrl.replace(/\/+$/, "")}/v1/${encodeURIComponent(game)}/${encodeURIComponent(originalName)}`;
}

export function openMediaDb(root = REPO) {
	mkdirSync(path.join(root, "data"), { recursive: true });
	const db = new Database(path.join(root, "data", "atlas.db"), { create: true });
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS media (
			game TEXT NOT NULL,
			original_name TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size INTEGER NOT NULL,
			uploaded_at INTEGER NOT NULL,
			PRIMARY KEY (game, original_name)
		);
	`);

	const hasStmt = db.prepare("SELECT 1 FROM media WHERE game = ? AND original_name = ?");
	const getStmt = db.prepare(
		"SELECT game, original_name, sha256, size, uploaded_at FROM media WHERE game = ? AND original_name = ?",
	);
	const listGameStmt = db.prepare("SELECT original_name FROM media WHERE game = ?");
	const putStmt = db.prepare(
		`INSERT INTO media (game, original_name, sha256, size, uploaded_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (game, original_name) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, uploaded_at = excluded.uploaded_at`,
	);

	return {
		db,
		has: (game: string, originalName: string): boolean => Boolean(hasStmt.get(game, originalName)),
		get: (game: string, originalName: string): MediaRecord | null =>
			(getStmt.get(game, originalName) as MediaRecord | undefined) ?? null,
		uploadedSet: (game: string): Set<string> =>
			new Set((listGameStmt.all(game) as { original_name: string }[]).map((r) => r.original_name)),
		record: (row: {
			game: string;
			original_name: string;
			sha256: string;
			size: number;
			uploaded_at?: number;
		}): void => {
			putStmt.run(row.game, row.original_name, row.sha256, row.size, row.uploaded_at ?? Date.now());
		},
		close: (): void => db.close(),
	};
}

export type MediaDatabase = ReturnType<typeof openMediaDb>;

export interface UploadVerifyOptions {
	game: string;
	originalName: string;
	buf: Buffer | Uint8Array;
	s3: Pick<S3Client, "presign">;
	mediaUrl: string;
	maxTries?: number;
	retryDelayMs?: number;
	fetchImpl?: typeof fetch;
}

// Uploads a single media buffer to R2 (v1/{game}/{originalName}) with long max-age Cache-Control, then verifies the
// SHA-256 hash by downloading from the public free-egress URL. Retries up to maxTries (default 3) before throwing.
export async function uploadAndVerifyBuffer({
	game,
	originalName,
	buf,
	s3,
	mediaUrl,
	maxTries = 3,
	retryDelayMs = 500,
	fetchImpl = fetch,
}: UploadVerifyOptions): Promise<MediaRecord> {
	const sha256 = sha256Bytes(buf);
	const size = buf.byteLength;
	const key = `v1/${game}/${originalName}`;
	const pubUrl = publicMediaUrl(mediaUrl, game, originalName);
	const contentType = mimeForMedia(originalName);

	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxTries; attempt++) {
		try {
			const putUrl = s3.presign(key, { method: "PUT", expiresIn: 3600 });
			const putRes = await fetchImpl(putUrl, {
				method: "PUT",
				body: buf,
				headers: {
					"Content-Type": contentType,
					"Cache-Control": CACHE_CONTROL,
				},
			});
			if (!putRes.ok) {
				const errText = await putRes.text().catch(() => "");
				throw new Error(`R2 PUT HTTP ${putRes.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`);
			}

			// Verify via public egress link (free on Cloudflare R2; never use S3 GetObject)
			const getRes = await fetchImpl(pubUrl, {
				headers: { "User-Agent": "VerticordiaAtlas-MediaVerifier/1.0" },
			});
			if (!getRes.ok) {
				throw new Error(`Public verification GET HTTP ${getRes.status} for ${pubUrl}`);
			}
			const remoteBytes = new Uint8Array(await getRes.arrayBuffer());
			const remoteSha256 = sha256Bytes(remoteBytes);
			if (remoteSha256 !== sha256) {
				throw new Error(
					`SHA-256 mismatch for ${pubUrl}: expected ${sha256} (${size}B), got ${remoteSha256} (${remoteBytes.byteLength}B)`,
				);
			}

			return {
				game,
				original_name: originalName,
				sha256,
				size,
				uploaded_at: Date.now(),
			};
		} catch (e) {
			lastErr = e;
			if (attempt < maxTries && retryDelayMs > 0) {
				await sleep(retryDelayMs * attempt);
			}
		}
	}

	throw new Error(
		`Failed to upload and verify ${game}/${originalName} after ${maxTries} attempts: ${
			lastErr instanceof Error ? lastErr.message : String(lastErr)
		}`,
	);
}

export interface UploadJob {
	game: string;
	originalName: string;
	filePath: string;
}

// Infers the game slug from a path like ".../maps/<slug>/media/<filename>"
export function inferGameFromMediaPath(filePath: string): string | null {
	const norm = path.resolve(filePath).split(path.sep);
	for (let i = norm.length - 2; i >= 1; i--) {
		if (norm[i] === "media" && norm[i - 1]) {
			return norm[i - 1];
		}
	}
	return null;
}

export async function collectUploadJobs({
	targets,
	mapsDir,
	explicitGame,
}: {
	targets: string[];
	mapsDir: string;
	explicitGame?: string;
}): Promise<UploadJob[]> {
	const jobs: UploadJob[] = [];
	const seen = new Set<string>();
	const addJob = (game: string, filePath: string) => {
		const originalName = path.basename(filePath);
		if (originalName.startsWith(".")) return;
		const k = `${game}\0${originalName}`;
		if (seen.has(k)) return;
		seen.add(k);
		jobs.push({ game, originalName, filePath });
	};

	const scanGameMediaDir = async (game: string, mediaDir: string) => {
		const entries = await readdir(mediaDir, { withFileTypes: true }).catch(() => []);
		for (const d of entries) {
			if (d.isFile() && !d.name.startsWith(".")) {
				addJob(game, path.join(mediaDir, d.name));
			}
		}
	};

	if (targets.length === 0) {
		const games = await readdir(mapsDir, { withFileTypes: true }).catch(() => []);
		for (const g of games) {
			if (!g.isDirectory() || g.name.startsWith(".")) continue;
			await scanGameMediaDir(g.name, path.join(mapsDir, g.name, "media"));
		}
		return jobs;
	}

	for (const target of targets) {
		const st = await stat(target).catch(() => null);
		if (st?.isFile()) {
			const game = explicitGame || inferGameFromMediaPath(target);
			if (!game) {
				throw new Error(
					`Cannot infer game slug for file "${target}". Place it under maps/<slug>/media/ or pass --game <slug>.`,
				);
			}
			addJob(game, path.resolve(target));
		} else if (st?.isDirectory()) {
			// Either a game directory (containing media/) or a media/ directory directly
			if (path.basename(path.resolve(target)) === "media") {
				const game = explicitGame || path.basename(path.dirname(path.resolve(target)));
				await scanGameMediaDir(game, path.resolve(target));
			} else {
				const mediaSub = path.join(path.resolve(target), "media");
				const subSt = await stat(mediaSub).catch(() => null);
				if (subSt?.isDirectory()) {
					const game = explicitGame || path.basename(path.resolve(target));
					await scanGameMediaDir(game, mediaSub);
				} else {
					const game = explicitGame || inferGameFromMediaPath(path.join(target, "dummy"));
					if (!game) {
						throw new Error(`Cannot infer game slug for directory "${target}". Pass --game <slug>.`);
					}
					await scanGameMediaDir(game, path.resolve(target));
				}
			}
		} else {
			// Treat target as a game slug under mapsDir
			const slug = target.replace(/^\/+|\/+$/g, "");
			const gameDir = path.join(mapsDir, slug);
			const gameSt = await stat(gameDir).catch(() => null);
			if (!gameSt?.isDirectory()) {
				throw new Error(
					`Target "${target}" is neither an existing file/directory nor a game slug in ${mapsDir}.`,
				);
			}
			await scanGameMediaDir(slug, path.join(gameDir, "media"));
		}
	}

	return jobs;
}

export interface BulkUploadOptions {
	jobs: UploadJob[];
	s3: Pick<S3Client, "presign">;
	mediaUrl: string;
	mediaDb: MediaDatabase;
	concurrency?: number;
	keepLocal?: boolean;
	force?: boolean;
	maxTries?: number;
	retryDelayMs?: number;
	fetchImpl?: typeof fetch;
	onProgress?: (stats: {
		uploaded: number;
		skippedCloud: number;
		deletedLocal: number;
		bytes: number;
		total: number;
	}) => void;
}

// Uploads a batch of local media files in parallel, rescheduling any failed files up to maxTries (3) total attempts.
export async function uploadMediaBatch({
	jobs,
	s3,
	mediaUrl,
	mediaDb,
	concurrency = 16,
	keepLocal = false,
	force = false,
	maxTries = 3,
	retryDelayMs = 500,
	fetchImpl = fetch,
	onProgress,
}: BulkUploadOptions): Promise<{
	uploaded: number;
	skippedCloud: number;
	deletedLocal: number;
	bytes: number;
}> {
	let uploaded = 0;
	let skippedCloud = 0;
	let deletedLocal = 0;
	let bytes = 0;
	const mediaDirs = new Set<string>();

	const pending: { job: UploadJob; attempts: number; lastError?: string }[] = [];
	for (const job of jobs) {
		mediaDirs.add(path.dirname(job.filePath));
		if (!force && mediaDb.has(job.game, job.originalName)) {
			skippedCloud++;
			if (!keepLocal) {
				await unlink(job.filePath).catch(() => {});
				deletedLocal++;
			}
			continue;
		}
		pending.push({ job, attempts: 0 });
	}

	// Process queue; failed items are rescheduled onto the next pass up to maxTries total tries.
	let queue = pending;
	while (queue.length > 0) {
		const retryQueue: typeof pending = [];
		let idx = 0;
		const workers = Math.min(Math.max(1, concurrency), queue.length);
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (idx < queue.length) {
					const item = queue[idx++];
					if (!item) break;
					item.attempts++;
					try {
						const buf = Buffer.from(await Bun.file(item.job.filePath).arrayBuffer());
						const rec = await uploadAndVerifyBuffer({
							game: item.job.game,
							originalName: item.job.originalName,
							buf,
							s3,
							mediaUrl,
							maxTries: 1, // batch loop handles rescheduling up to maxTries
							retryDelayMs: 0,
							fetchImpl,
						});
						mediaDb.record(rec);
						uploaded++;
						bytes += rec.size;
						if (!keepLocal) {
							await unlink(item.job.filePath).catch(() => {});
							deletedLocal++;
						}
						onProgress?.({
							uploaded,
							skippedCloud,
							deletedLocal,
							bytes,
							total: jobs.length,
						});
					} catch (e: any) {
						item.lastError = e?.message || String(e);
						if (item.attempts < maxTries) {
							retryQueue.push(item);
						} else {
							throw new Error(
								`Upload failed after ${maxTries} tries for ${item.job.game}/${item.job.originalName}: ${item.lastError}`,
							);
						}
					}
				}
			}),
		);
		if (retryQueue.length > 0 && retryDelayMs > 0) {
			await sleep(retryDelayMs);
		}
		queue = retryQueue;
	}

	if (!keepLocal) {
		for (const dir of mediaDirs) {
			const remaining = await readdir(dir).catch(() => ["keep"]);
			if (remaining.length === 0) {
				await rmdir(dir).catch(() => {});
			}
		}
	}

	return { uploaded, skippedCloud, deletedLocal, bytes };
}

async function main() {
	const { values: v, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			game: { type: "string" },
			"maps-dir": { type: "string", default: path.join(REPO, "public", "maps") },
			"keep-local": { type: "boolean", default: false },
			force: { type: "boolean", default: false },
			concurrency: { type: "string", default: "16" },
		},
	});

	const cfg = validateR2Env();
	const s3 = createR2Client(cfg);
	const mapsDir = path.resolve(v["maps-dir"]!);
	const concurrency = Math.max(1, Number(v.concurrency) || 16);
	const jobs = await collectUploadJobs({
		targets: positionals,
		mapsDir,
		explicitGame: v.game,
	});

	if (jobs.length === 0) {
		console.log("No local media files found to upload.");
		return;
	}

	const mediaDb = openMediaDb(REPO);
	try {
		console.log(
			`Found ${jobs.length} local media file(s) across ${new Set(jobs.map((j) => j.game)).size} game(s). Uploading to s3://${cfg.bucket}/v1/... (concurrency ${concurrency})`,
		);
		let lastLogged = 0;
		const res = await uploadMediaBatch({
			jobs,
			s3,
			mediaUrl: cfg.mediaUrl,
			mediaDb,
			concurrency,
			keepLocal: Boolean(v["keep-local"]),
			force: Boolean(v.force),
			onProgress: (st) => {
				if (st.uploaded - lastLogged >= 50) {
					lastLogged = st.uploaded;
					console.log(
						`  progress: ${st.uploaded} uploaded (${mb(st.bytes)}), ${st.skippedCloud} skipped (already in cloud)`,
					);
				}
			},
		});
		console.log(
			`Done: uploaded ${res.uploaded} (${mb(res.bytes)}), skipped ${res.skippedCloud} (already in cloud)${
				v["keep-local"] ? "" : `, deleted ${res.deletedLocal} local file(s)`
			}.`,
		);
	} finally {
		mediaDb.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error("\nERROR:", e.message);
		process.exit(1);
	});
}