# AGENTS.md

This file provides architectural context, conventions, and workflows for AI coding agents working in **Verticordia Atlas**.

## Project Overview

Verticordia Atlas is a local-first, offline-capable interactive game map viewer and completion tracker (`https://atlas.verticordia.com`).

- **Local-First & Offline-First**: All user progress (found markers, custom markers, custom categories, freehand/shape map drawings, selection presets, per-map camera positions, and filter views) is stored locally in the browser's IndexedDB (`offline-map-viewer`, with an in-memory fallback when storage is blocked). The Service Worker (`src/client/sw.ts`) caches the application shell, game metadata, and map tiles so the app works offline after a game's map is opened. Full map pyramids can be downloaded via "Keep offline" as a single streamed `.vaop` pack into IndexedDB blob storage (`src/client/pack-store.ts`), served directly by the Service Worker even when completely disconnected.
- **Optional Zero-Wait Sync & Interchangeable Auth**: Users can optionally sign in with Email/Username + Argon2id password (`email_addresses` + `password_credentials`), Google (OIDC `id_token`), or an anonymous 128-bit Base32 secret key with checksum (`XXXX-XXXX-...`) to synchronize progress across devices. Multiple sign-in methods can be linked to the same account, and sensitive account mutations require recent re-authentication (`POST /api/account/reauth`, 10-minute step-up window). Sync (`src/client/sync.ts` + `server/api.ts`) runs asynchronously in the background using Web Locks (`navigator.locks`) for tab leader election, `BroadcastChannel` for cross-tab updates, and WebSockets (`/api/ws`) for instant cross-device push notifications.
- **Vanilla TypeScript & Dependencies**: Both client and server are written in strict TypeScript executed and bundled by **Bun**. Do not introduce browser UI frameworks (React, Vue, Svelte, etc.) or client-side runtime npm packages. The browser client has zero npm dependencies; client third-party libraries (`maplibre-gl`, `marked`, `perfect-freehand`, and `lucide/icons.json`) are vendored in `public/vendor/`, and fonts (`Instrument Sans`, `Instrument Serif`, and `Red Hat Mono`) are self-hosted in `public/fonts/`. Server and CLI dependencies in `package.json` are `jose` (Google OIDC ID token verification), `@aws-sdk/client-sesv2` / `@aws-sdk/client-ses` (transactional emails via Amazon SES with an automatic local dev console/file fallback in `server/email.ts`), `confusables` and `unicode-case-folding` (Unicode NFC, case folding, and UTS #39 confusable skeleton checks in `server/usernames.ts`), `unique-names-generator` (memorable secret key account pseudonyms), `sharp` (server and scripts only, loaded lazily in `server/tile-engine.ts` for tile stitching and downsampling so the server starts without it), and `@opentui/core` (terminal UI dashboards in `scripts/tui/`).

---

## Toolchain & Commands

Bun is managed via `mise` (`.config/mise/config.toml`). If `bun` is not on the default `PATH`, invoke it via `mise` or `~/.local/share/mise/installs/bun/1.4.4/bin/bun`.

- **Run tests**: `bun test` (runs test files sequentially); `bun test --parallel` runs test files in parallel across worker processes; `bun test --parallel --concurrent` runs tests concurrently. Tests use generous timeouts (30s default, 60s–240s for long or e2e runs) to avoid contention timeouts. Tests with shared process or server state (auth describe server lifecycle, global `dataCache`, `deriveLimiter`, monkey-patched `ops.link`, and browser CDP CPU throttling) are marked `test.serial`, while isolated tests use ephemeral ports or temporary directories and run with `test.concurrent`.
- **Performance debug (off by default)**: open any page with `?perf=1` (or `localStorage.perf = "1"`) to time `prepareMap`, `runSearch`, `refreshMap`, `updateSidebar`, `saveProfileNow` and long tasks (`src/client/perf.ts`); run `perfReport()` in the console for the table
- **Typecheck**: `bun run typecheck` (`tsc --noEmit`)
- **Build client bundles**: `bun run build` (runs `scripts/build.ts`)
- **Precompress static assets**: `bun run precompress` (runs `scripts/precompress.ts`; run once at deploy, after build)
- **Check bundle and payload budgets**: `bun run check:budgets` (`scripts/check-budgets.ts`; thresholds and their measured baselines in `scripts/budgets.json`; hard budgets fail, soft ones warn)
- **Clean build outputs**: `bun run clean` removes the client bundles, `public/sw.js` and the `.br`/`.gz` sidecars
- **Start server**: `bun run start` (runs `server/server.ts`, which automatically executes `buildClient()` on startup; pass `--no-tui` to disable the OpenTUI dashboard)
- **Backup SQLite database**: `bun run backup` (runs `scripts/backup-db.ts` using online `VACUUM INTO` and rotates older snapshots in `backups/`)
- **Format code**: `bun fmt`

---

## Repository Structure

```text
src/
	shared/                 # Isomorphic TypeScript shared by client, server, and CLI scripts
		types.ts            # Canonical domain interfaces (Profile, UserMarker, DrawingItem, GameMeta, etc.)
		geometry.ts         # GeoJSON polygon ring closure, vertex deduplication, and bounds calculation
		sync-rules.ts       # Deterministic JSON canonicalization (contentKey, sendKey) and FNV-1a hashing
		secret-key.ts       # 128-bit Base32 secret key encoding, scattered checksum validation, and formatting
		search.ts           # Diacritic-insensitive normalization and Levenshtein fuzzy matching
		share-link.ts       # URL-safe deflate-raw marker packing/unpacking (?tm=...) with bounded decompression
		theme-math.ts       # HSL color conversions and light-theme palette derivation
		compact-map.ts      # Versioned compact client map payload (data.compact.json + lazy data.details.json) <-> data.json conversion
		escape.ts           # HTML escaping (esc) and number/byte formatting (fmt, fmtEn, formatBytes)
	client/                 # Browser TypeScript sources (bundled into public/ by scripts/build.ts)
		map.ts              # Map viewer entrypoint: boot sequence, sync wiring, and top-level DOM events
		home.ts             # Homepage entrypoint: game grid, fuzzy search, and "Continue" resume card
		theme.ts            # Theme mode (light/auto/dark), game accent tinting, and navigation trail
		features.ts         # Homepage progressive enhancement and device capability detection
		perf.ts             # Opt-in client performance instrumentation (?perf=1, perfReport())
		account.ts          # Account pill UI, session checks, and API client wrapper
		account-page.ts     # Account page entrypoint (/account/): profile, emails, credentials, step-up reauth, offline maps, and account deletion
		offline.ts          # Device-local "Keep offline" coordinator, streaming .vaop pack unpacker, and repair/removal
		pack-store.ts       # Chunked IndexedDB blob storage for offline map packs, with in-memory fallback
		sync.ts             # Background sync engine, conflict resolution, Web Locks, and WebSocket client
		signin.ts           # Sign-in page entrypoint (/signin/): password login, registration, email verification, password reset, Google, and secret key
		legal.ts            # Legal pages entrypoint (/about/, /terms/, /privacy/, /license/)
		sw.ts               # Service Worker source (compiled to public/sw.js with injected version hash)
		icons.ts            # Inline UI SVG icons
		icons-lib.ts        # Lazy-loaded Lucide icon library and canvas pin renderer
		vendor.d.ts         # Ambient types for global vendor libraries (maplibregl, marked, ServiceWorker)
		map/                # Modularized map viewer subsystems
			state.ts        # Shared viewer state singleton and core UI/dialog helpers
			db.ts           # IndexedDB wrapper (profiles and meta stores) and syncStore adapter
			map-view.ts     # MapLibre GL setup, raster tile layers, map switcher, and camera persistence
			marker-filter.ts # Dynamic MapLibre setFilter marker visibility toggles without rebuilding layers
			sidebar.ts      # Category/group tree, morphing progress bar, row menus, and session summary
			stats.ts        # Completion statistics aggregation, breakdown, CSV export, and stale marker cleanup
			profiles.ts     # Profile CRUD, veil transitions, JSON export/import, and data sanitization
			presets.ts      # Category visibility presets, dirty state detection, and per-game migration
			detail.ts       # Marker detail card, bidirectional link graph, arrowheads, and history stack
			search.ts       # Tiered location search (current map & all maps) and hover ring preview
			search-index.ts # Lazy background search index for cross-map and all-game location queries
			selection.ts    # Box, ellipse, and freehand polygon marker selection tool
			drawing.ts      # Freehand pen, highlighter, line, arrow, shape, and text annotations
			usermarkers.ts  # Custom user markers, temporary markers, and category editor
			capture.ts      # High-DPI offscreen map + annotation screenshot capture
			markdown.ts     # Markdown renderer (marked) with MapGenie internal link rewriting
server/
	server.ts               # HTTP static & dynamic server (CSP & security headers, ETags, gzip, dynamic map.html & OG tags, graceful shutdown)
	api.ts                  # SQLite WAL backend (data/atlas.db), password/Google/secret-key auth, step-up reauth, Bun WebSockets, and /api/sync
	usernames.ts            # Unicode NFC normalization, case-folding, UTS #39 confusable skeleton detection, and email/password validation
	reserved-usernames.sql  # Seed list of reserved usernames
	email.ts                # Amazon SESv2 email sender with automatic local development console/file fallback
	email-templates.ts      # Transactional HTML & plain-text email templates (verification, password reset, email change, security alerts)
	rate-limit.ts           # Sliding-window rate limiter and proxy-aware client IP resolver (resolveClientIp)
	cards.ts                # Headless Chromium + ImageMagick social preview card renderer (1200x630 JPG) and safe media path resolution
	tile-engine.ts          # sharp-based tile maths: stitch + downsample four tiles into one, single-colour detection and hard links
	tile-cache.ts           # Disk cache cache/tiles/ for made tiles: in-memory recency, popularity-weighted eviction (2GB -> 1GB)
	tile-service.ts         # Tile requests: stored tile -> cache -> make from the next zoom, cache and serve
	offline-pack.ts         # Streams a map's metadata and tile pyramid as a binary .vaop pack with path containment, rate limits, and concurrency caps
	assets/fonts/           # Font files used by headless Chromium during social card generation
scripts/
	build.ts                # Bundles src/client/*.ts into public/ and verifies/hashes SW precache files
	precompress.ts          # Precompresses static assets into .br and .gz sidecars for zero-overhead static serving
	backup-db.ts            # Online SQLite backup script (VACUUM INTO backups/atlas-*.db with rotation)
	clean.ts                # Removes client bundles, public/sw.js and .br/.gz sidecars
	add-game.ts             # Scrapes a MapGenie game/map into public/maps/<slug>/ (only the highest zoom of tiles; --force-get-tiles <map> takes every zoom)
	update-games.ts         # Incrementally updates existing MapGenie games (markers, media, and optionally tiles)
	lootatlas.ts            # Scrapes LootAtlas games/maps into public/maps/<slug>/
	compact-map.ts          # Writes data.compact.json/data.details.json beside a map's data.json (add-game and lootatlas always write them for the games they add or update; clean-markers refreshes existing ones; the client falls back to data.json without them)
	clean-markers.ts        # Rewrites intra-map MapGenie locationIds URLs in data.json to "#loc=<id>" fragments
	prune-tiles.ts          # Links single-colour tiles, generates overview zooms (minzoom to maxzoom-3, kept by default), deletes only the top zooms the server can remake (--dry-run; --aggressive-prune restores the old deletion)
	check-budgets.ts        # Measures client bundles and the largest map payload against scripts/budgets.json (run by CI)
	download-tiles.ts       # Downloads map raster tiles into public/maps/<slug>/<map>/tiles/
	download-media.ts       # Downloads marker screenshot media into public/maps/<slug>/media/
	upload-media.ts         # Uploads marker media to Cloudflare R2 / S3, verifies SHA-256 via public URL, and records in SQLite media table
	make-cards.ts           # Pre-renders OpenGraph card.jpg images for games
	make-screenshots.ts     # Generates promotional screenshots in public/screenshots/
	adaptive-rate.ts        # AIMD adaptive concurrency and delay controller for scrapers
	tile-downloader-tui.ts  # OpenTUI dashboard for standalone tile downloader monitoring
	tui/                    # OpenTUI terminal dashboards for server monitoring, game catalog, scraping, tile pruning, media, and cards
public/                     # Static web root served by server/server.ts
	index.html              # Homepage
	map.html                # Shared HTML shell served for every /maps/<slug>/ route
	base.css                # Shared design tokens, @font-face rules, light/dark themes, and common UI
	home.css                # Homepage styles
	style.css               # Map viewer styles
	fonts/                  # Self-hosted Instrument Sans, Instrument Serif, and Red Hat Mono .woff2 files
	vendor/                 # Vendored browser dependencies (maplibre-gl, marked, perfect-freehand, lucide)
	maps/                   # Game manifest (maps/index.json) and per-game directories (meta.json, data.json, sprites)
tests/
	shared.test.ts          # Unit tests for src/shared/*
	client-pure.test.ts     # Unit tests for client pure functions, map helpers, and sync engine
	auth.test.ts            # Unit and integration tests for usernames, secret keys, registration, login, password reset, and step-up reauth
	oauth.test.ts           # End-to-end Google OIDC sign-in and account linking tests
	server-and-scripts.test.ts # Integration tests for server/api.ts, server/server.ts, cards.ts, offline-pack.ts, backup-db.ts, and scripts/build.ts
	ws-e2e.test.ts          # End-to-end WebSocket tests for authentication, origin security, limits, and sync notifications
	tiles.test.ts           # Tile engine, cache eviction, tile service, parallel derivation limiter, scripts/prune-tiles.ts, and add-game's tile download
	tile-downloader.test.ts # Unit tests for tile downloader queue, deduplication, and retry logic
	update-games.test.ts    # Tests for incremental MapGenie game and marker sync
	compact-map.test.ts     # Compact map round trip, CLI output, refreshCompact, and client loading with lazy details
	perf.test.ts            # Opt-in performance instrumentation: flag parsing and wrapper behaviour
	budgets.test.ts         # Budget evaluation (pass, warn, fail, skip) and message text
	tui.test.ts             # Unit and integration tests for adaptive rate controller and OpenTUI dashboards
	lootatlas.test.ts       # Unit tests for LootAtlas scraper transforms and coordinate conversion
	browser-e2e.test.ts     # Puppeteer end-to-end browser verification of search, filters, cards, and perf baselines
	e2e-offline.test.ts     # End-to-end Puppeteer test verifying offline map pack downloads and disconnected navigation
	spawn-server.ts         # Ephemeral port server test fixture with SQLite in-memory/temp database
	tile-fixtures.ts        # Minimal 1x1 / 2x2 PNG and JPEG tile fixtures for image downsampling tests
```

---

## Key Architectural Invariants

1. **Client Bundles Are Build Artifacts**:
    - All `.js` files outside `public/vendor/*.js` are gitignored (`.gitignore`).
    - Edit TypeScript sources in `src/client/` and `src/shared/`, never the generated `.js` bundles in `public/`.
    - `scripts/build.ts` compiles seven entrypoints (`public/app.js`, `public/home.js`, `public/theme.js`, `public/signin/signin.js`, `public/account/account.js`, `public/legal/legal.js`, and `public/sw.js`) in ~50ms.
    - `scripts/build.ts` also verifies that every path in `PRECACHE` (`src/client/sw.ts`) exists on disk in `public/` and injects a content-addressed SHA-256 version string (`__SW_VERSION__`) into `public/sw.js`. When adding or renaming static shell assets in `public/`, update `PRECACHE` in `src/client/sw.ts` and run `bun test`.

2. **Sync Hashing & Conflict Rules (`src/shared/sync-rules.ts`)**:
    - Both client (`src/client/sync.ts`) and server (`server/api.ts`) must use `contentKey` and `sendKey` from `src/shared/sync-rules.ts`.
    - `contentKey` strips `updated`, `map`, and `cameras` from profile records so camera movements and timestamps alone never trigger a conflict dialog between devices.
    - `sendKey` strips only `updated` so camera changes are still replicated to other devices when no content conflict exists.

3. **Security & Untrusted Data Sanitization**:
    - Profile imports and synced records can contain arbitrary JSON; always pass profile data through `cleanUserData()` (`src/client/map/profiles.ts`).
    - Because UI rendering uses template strings and `innerHTML`, always escape dynamic text with `esc()` (`src/shared/escape.ts`).
    - Markdown descriptions rendered through `renderMd()` (`src/client/map/markdown.ts`) escape raw HTML tokens and restrict links to `http:`/`https:` or internal `#loc=<id>` references.
    - `server/server.ts` emits a strict `Content-Security-Policy` header on HTML responses using SHA-256 hashes for the inline theme bootstrap scripts in `<head>`. Do not add new inline `<script>` blocks or inline event handlers (`onclick=`, etc.) without updating `collectInlineScriptHashes()` in `server/server.ts`.
    - Proxy headers (`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`, `X-Forwarded-Host`) are only trusted when `trustProxy: true` in `site.json` (or `TRUST_PROXY=1`). Always resolve client IPs through `resolveClientIp()` (`server/rate-limit.ts`).

4. **Testability of Client Modules**:
    - Guard top-level browser DOM side effects (`document`, `window`, `marked`, `matchMedia`) in client modules when they export pure functions or state helpers, so `bun test` can import and test them directly in a non-DOM environment.

5. **Static Precompression & Lazy Vendor Assets**:
    - `scripts/precompress.ts` generates Brotli (`.br`) and gzip (`.gz`) sidecars beside static bundles and assets; `server/server.ts` serves precompressed sidecars directly when supported by the client.
    - Vendor Markdown parsing (`public/vendor/marked.umd.js`) is lazy-loaded on demand via `ensureMarked()` in `src/client/map/markdown.ts` to keep initial map boot lightweight and out of the critical rendering path.

6. **Test Concurrency & Isolation**:
    - Tests intended to run under `bun test --parallel --concurrent` must isolate filesystem paths (`withTempDir` or `mkdtemp`) and HTTP servers (ephemeral port 0 via `spawnTestServer`).
    - Use `test.serial` strictly for tests that mutate process-global singletons (`dataCache`, `deriveLimiter`), monkey-patch global APIs or module exports, or throttle hardware (browser CDP CPU throttle). Isolated or pure tests should run with `test.concurrent`.

---

## Code Style & Git Conventions

- **Formatting (`.editorconfig` & `bunfig.toml`)**:
    - Use **tabs** (`tab_width = 4`) for indentation.
    - Maximum line length is **120 characters**.
    - Use semicolons (`semi = true`) and omit trailing final newlines (`insertFinalNewline = false`).
    - Run `bun fmt` after editing files to ensure formatting and import sorting match repository standards.
    - Before committing, stage the files first, then run `bun fmt --staged` so only the staged set is formatted.
- **Generated map data**:
    - Never modify `public/maps/` directly unless the user explicitly asks; it is maintained by the scripts in `scripts/`. Other processes may also rewrite these files, and `bun fmt` may reformat them, so do not stage them by accident.
- **Commits**:
    - Follow **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `perf:`, `test:`, `chore:`, `style:`).
    - Wrap all commit messages (summary and body) strictly to **72 columns**.
    - When a commit message includes an explanatory body, write **concise prose paragraphs**—never use bullet lists in commit messages.
- **Verification**:
    - Always run `bun run typecheck`, `bun test`, and `bun run build` to verify changes before committing. All unit and integration tests must pass.