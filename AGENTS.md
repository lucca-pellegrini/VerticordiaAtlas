# AGENTS.md

This file provides architectural context, conventions, and workflows for AI coding agents working in **Verticordia Atlas**.

## Project Overview

Verticordia Atlas is a local-first, offline-capable interactive game map viewer and completion tracker (`https://atlas.verticordia.com`).

- **Local-First & Offline-First**: All user progress (found markers, custom markers, custom categories, freehand/shape map drawings, selection presets, per-map camera positions, and filter views) is stored locally in the browser's IndexedDB (`offline-map-viewer`, with an in-memory fallback when storage is blocked). The Service Worker (`src/client/sw.ts`) caches the application shell, game metadata, and map tiles so the app works offline after a game's map is opened.
- **Optional Zero-Wait Sync**: Users can optionally sign in with Google (OIDC `id_token`) or an anonymous 160-bit Base32 secret key (`XXXX-XXXX-...`) to synchronize progress across devices. Sync (`src/client/sync.ts` + `server/api.ts`) runs asynchronously in the background using Web Locks (`navigator.locks`) for tab leader election, `BroadcastChannel` for cross-tab updates, and WebSockets (`/api/ws`) for instant cross-device push notifications.
- **Vanilla TypeScript & Zero Runtime Dependencies**: Both client and server are written in strict TypeScript executed and bundled by **Bun**. Do not introduce UI frameworks (React, Vue, Svelte, etc.) or runtime npm packages. The one exception is `sharp` (server and scripts only, never the client), used for tile stitching and downsampling in `server/tile-engine.ts`; it is loaded lazily so the server starts without it. Client third-party libraries (`maplibre-gl`, `marked`, `perfect-freehand`, and `lucide/icons.json`) are vendored in `public/vendor/`, and fonts (`Inter` and `Instrument Serif`) are self-hosted in `public/fonts/`.

---

## Toolchain & Commands

Bun is managed via `mise` (`.config/mise/config.toml`). If `bun` is not on the default `PATH`, invoke it via `mise` or `~/.local/share/mise/installs/bun/1.4.4/bin/bun`.

- **Run tests**: `bun test`
- **Build client bundles**: `bun run build` (runs `scripts/build.ts`)
- **Start server**: `bun run start` (runs `server/server.ts`, which automatically executes `buildClient()` on startup)
- **Format code**: `bun fmt`

---

## Repository Structure

```text
src/
	shared/                 # Isomorphic TypeScript shared by client, server, and CLI scripts
		types.ts            # Canonical domain interfaces (Profile, UserMarker, DrawingStroke, GameMeta, etc.)
		sync-rules.ts       # Deterministic JSON canonicalization (contentKey, sendKey) and FNV-1a hashing
		search.ts           # Diacritic-insensitive normalization and Levenshtein fuzzy matching
		share-link.ts       # URL-safe deflate-raw marker packing/unpacking (?tm=...)
		theme-math.ts       # HSL color conversions and light-theme palette derivation
		escape.ts           # HTML escaping (esc) and number formatting (fmt, fmtEn)
	client/                 # Browser TypeScript sources (bundled into public/ by scripts/build.ts)
		app.ts              # Map viewer entrypoint: boot sequence, sync wiring, and top-level DOM events
		home.ts             # Homepage entrypoint: game grid, fuzzy search, and "Continue" resume card
		theme.ts            # Theme mode (light/auto/dark), game accent tinting, and navigation trail
		account.ts          # Account pill UI, session checks, and API client wrapper
		sync.ts             # Background sync engine, conflict resolution, Web Locks, and WebSocket client
		signin.ts           # Sign-in page entrypoint (/signin/)
		legal.ts            # Legal pages entrypoint (/about/, /terms/, /privacy/)
		sw.ts               # Service Worker source (compiled to public/sw.js with injected version hash)
		icons.ts            # Inline UI SVG icons
		icons-lib.ts        # Lazy-loaded Lucide icon library and canvas pin renderer
		vendor.d.ts         # Ambient types for global vendor libraries (maplibregl, marked)
		map/                # Modularized map viewer subsystems
			state.ts        # Shared viewer state singleton and core UI/dialog helpers
			db.ts           # IndexedDB wrapper (profiles and meta stores) and syncStore adapter
			map-view.ts     # MapLibre GL setup, raster tile layers, map switcher, and camera persistence
			sidebar.ts      # Category/group tree, morphing progress bar, row menus, and session summary
			profiles.ts     # Profile CRUD, veil transitions, JSON export/import, and data sanitization
			presets.ts      # Category visibility presets, dirty state detection, and per-game migration
			detail.ts       # Marker detail card, bidirectional link graph, arrowheads, and history stack
			search.ts       # Tiered location search (current map & all maps) and hover ring preview
			selection.ts    # Box, ellipse, and freehand polygon marker selection tool
			drawing.ts      # Freehand pen, highlighter, line, arrow, shape, and text annotations
			usermarkers.ts  # Custom user markers, temporary markers, and category editor
			capture.ts      # High-DPI offscreen map + annotation screenshot capture
			markdown.ts     # Markdown renderer (marked) with MapGenie internal link rewriting
server/
	server.ts               # HTTP static & dynamic server (ETags, gzip, dynamic map.html & OG tags)
	api.ts                  # SQLite WAL backend (data/atlas.db), Google OIDC, secret keys, and /api/sync
	ws.ts                   # Zero-dependency RFC 6455 WebSocket server for live sync notifications
	cards.ts                # Headless Chromium + ImageMagick social preview card renderer (1200x630 JPG)
	tile-engine.ts          # sharp-based tile maths: stitch + downsample four tiles into one, single-colour detection and hard links
	tile-cache.ts           # Disk cache cache/tiles/ for made tiles: in-memory recency, popularity-weighted eviction (2GB -> 1GB)
	tile-service.ts         # Tile requests: stored tile -> cache -> make from the next zoom, cache and serve
	assets/fonts/           # Font files used by headless Chromium during social card generation
scripts/
	build.ts                # Bundles src/client/*.ts into public/ and verifies/hashes SW precache files
	add-game.ts             # Scrapes a MapGenie game/map into public/maps/<slug>/ (only the highest zoom of tiles; --force-get-tiles <map> takes every zoom)
	prune-tiles.ts          # Links single-colour tiles, makes missing overviews, deletes intermediate zooms the server can remake (--dry-run)
	download-tiles.ts       # Downloads map raster tiles into public/maps/<slug>/<map>/tiles/
	download-media.ts       # Downloads marker screenshot media into public/maps/<slug>/media/
	make-cards.ts           # Pre-renders OpenGraph card.jpg images for games
	make-screenshots.ts     # Generates promotional screenshots in public/screenshots/
public/                     # Static web root served by server/server.ts
	index.html              # Homepage
	map.html                # Shared HTML shell served for every /maps/<slug>/ route
	base.css                # Shared design tokens, @font-face rules, light/dark themes, and common UI
	home.css                # Homepage styles
	style.css               # Map viewer styles
	fonts/                  # Self-hosted Inter and Instrument Serif .woff2 files
	vendor/                 # Vendored browser dependencies (maplibre-gl, marked, perfect-freehand, lucide)
	maps/                   # Game manifest (maps/index.json) and per-game directories (meta.json, data.json, sprites)
tests/
	shared.test.ts          # Unit tests for src/shared/*
	client-pure.test.ts     # Unit tests for client pure functions, map helpers, and sync engine
	server-and-scripts.test.ts # Integration tests for server/api.ts, server/ws.ts, cards.ts, and scripts/build.ts
	tiles.test.ts           # Tile engine, cache eviction, tile service, scripts/prune-tiles.ts, and add-game's tile download
```

---

## Key Architectural Invariants

1. **Client Bundles Are Build Artifacts**:
    - All `.js` files outside `public/vendor/*.js` are gitignored (`.gitignore`).
    - Edit TypeScript sources in `src/client/` and `src/shared/`, never the generated `.js` bundles in `public/`.
    - `scripts/build.ts` compiles six entrypoints (`public/app.js`, `public/home.js`, `public/theme.js`, `public/signin/signin.js`, `public/legal/legal.js`, and `public/sw.js`) in ~35ms.
    - `scripts/build.ts` also verifies that every path in `PRECACHE` (`src/client/sw.ts`) exists on disk in `public/` and injects a content-addressed SHA-256 version string (`__SW_VERSION__`) into `public/sw.js`. When adding or renaming static shell assets in `public/`, update `PRECACHE` in `src/client/sw.ts` and run `bun test`.

2. **Sync Hashing & Conflict Rules (`src/shared/sync-rules.ts`)**:
    - Both client (`src/client/sync.ts`) and server (`server/api.ts`) must use `contentKey` and `sendKey` from `src/shared/sync-rules.ts`.
    - `contentKey` strips `updated`, `map`, and `cameras` from profile records so camera movements and timestamps alone never trigger a conflict dialog between devices.
    - `sendKey` strips only `updated` so camera changes are still replicated to other devices when no content conflict exists.

3. **Untrusted Data Sanitization & Escaping**:
    - Profile imports and synced records can contain arbitrary JSON; always pass profile data through `cleanUserData()` (`src/client/map/profiles.ts`).
    - Because UI rendering uses template strings and `innerHTML`, always escape dynamic text with `esc()` (`src/shared/escape.ts`).
    - Markdown descriptions rendered through `renderMd()` (`src/client/map/markdown.ts`) escape raw HTML tokens and restrict links to `http:`/`https:` or internal `#loc=<id>` references.

4. **Testability of Client Modules**:
    - Guard top-level browser DOM side effects (`document`, `window`, `marked`, `matchMedia`) in client modules when they export pure functions or state helpers, so `bun test` can import and test them directly in a non-DOM environment.

---

## Code Style & Git Conventions

- **Formatting (`.editorconfig` & `bunfig.toml`)**:
    - Use **tabs** (`tab_width = 4`) for indentation.
    - Maximum line length is **120 characters**.
    - Use semicolons (`semi = true`) and omit trailing final newlines (`insertFinalNewline = false`).
    - Run `bun fmt` after editing files to ensure formatting and import sorting match repository standards.
- **Commits**:
    - Follow **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `perf:`, `test:`, `chore:`, `style:`).
    - When a commit message includes an explanatory body, write **concise prose paragraphs**—never use bullet lists in commit messages.
- **Verification**:
    - Always run `bun test` (and `bun run build`) to verify changes before committing. All unit and integration tests must pass.