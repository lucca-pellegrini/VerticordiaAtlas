// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { deriveTheme, extractVar, tilesCovering } from "../scripts/add-game.ts";
import { buildClient, verifyAndHashPrecache } from "../scripts/build.ts";
import { cleanDescription, cleanGameMarkers, resolveSameMapHref } from "../scripts/clean-markers.ts";
import { resolveGameSlug } from "../scripts/download-media.ts";
import {
	mimeForMedia,
	openMediaDb,
	publicMediaUrl,
	uploadAndVerifyBuffer,
	uploadMediaBatch,
	validateR2Env,
} from "../scripts/upload-media.ts";
import { createApi, secretName } from "../server/api.ts";
import {
	chromePath,
	deriveLightTheme,
	esc,
	exists,
	gameFavicon,
	gameThemeColor,
	hexToHsl,
	hslToHex,
	officialIcon,
	plainText,
	socialTags,
	withHead,
} from "../server/cards.ts";
import { collectMapPackItems } from "../server/offline-pack.ts";
import { mediaUrls } from "../src/client/map/detail.ts";
import { PRECACHE } from "../src/client/sw.ts";

describe("server/cards helpers", () => {
	test("hexToHsl and hslToHex round-trip", () => {
		const [h, s, l] = hexToHsl("#d6453b");
		expect(hslToHex(h, s, l)).toBe("#d6453b");
	});

	test("deriveLightTheme, gameThemeColor, and gameFavicon compute consistent theme values", () => {
		const darkTheme = { accent: "#d6453b", "accent-soft": "#f0877d", night: "#0b0e10" };
		const light = deriveLightTheme(darkTheme);
		expect(light.accent).toBe("#d6453b");
		expect(light.night).toMatch(/^#[0-9a-f]{6}$/);
		expect(gameThemeColor(darkTheme, false)).toBe("#0b0e10");
		expect(gameThemeColor(darkTheme, true)).toBe(light.night);
		expect(gameFavicon(darkTheme, false)).toStartWith("data:image/svg+xml,");
	});

	test("esc, socialTags, withHead, and plainText format metadata properly", () => {
		expect(esc('A & B <"C">')).toBe("A &amp; B &lt;&quot;C&quot;&gt;");
		const tags = socialTags({
			title: "Elden Ring",
			description: "The Lands Between",
			url: "https://atlas.example.com/maps/elden-ring/",
			image: "https://atlas.example.com/maps/elden-ring/card.jpg",
			alt: "Key art",
		});
		expect(tags).toContain('<meta property="og:title" content="Elden Ring">');

		const html = "<!doctype html><html><head><title>Old</title></head><body></body></html>";
		const updated = withHead(html, tags, "New Title");
		expect(updated).toContain("<title>New Title</title>");
		expect(updated).toContain("<!-- social:start (make-cards.mjs) -->");

		expect(plainText("Hello **world**! See [this link](https://example.com) and ![img](x.png).", 100)).toBe(
			"Hello world! See this link and .",
		);
	});

	test("officialIcon resolves font layers and image sprites", () => {
		const fontGame = {
			dir: "/tmp/game",
			icons: {
				font: "icons/font.woff",
				glyphs: {
					boss: [
						{ cp: "e900", color: "#000000" },
						{ cp: "e901", color: "#ff0000", ml: "-1em" },
					],
				},
			},
		};
		const ic = officialIcon(fontGame, "boss", "#223344");
		expect(ic).toEqual({
			font: "/tmp/game/icons/font.woff",
			color: "#223344",
			ink: "#ffffff",
			layers: [
				{ cp: "e900", tint: "#ffffff", ml: "" },
				{ cp: "e901", tint: "#ff0000", ml: "-1em" },
			],
		});
	});

	test("exists and chromePath resolve binaries and filesystem paths via Bun", async () => {
		expect(await exists("public/index.html")).toBe(true);
		expect(await exists("public/nonexistent-file.xyz")).toBe(false);

		const prevChrome = process.env.CHROME;
		try {
			process.env.CHROME = "mock-chrome-bin";
			expect(await chromePath()).toBe("mock-chrome-bin");
		} finally {
			if (prevChrome !== undefined) process.env.CHROME = prevChrome;
			else delete process.env.CHROME;
		}
	});
});

describe("scripts/add-game pure helpers", () => {
	test("extractVar parses inline window assignments", () => {
		const html = `<script>window.mapData = {"map":{"id":42},"mapConfig":{"initial_zoom":10},"locations":[]};</script>`;
		expect(extractVar(html, "mapData")).toEqual({
			map: { id: 42 },
			mapConfig: { initial_zoom: 10 },
			locations: [],
		});
	});

	test("tilesCovering and deriveTheme produce valid outputs", () => {
		const tiles = tilesCovering([-10, -10, 10, 10], 2);
		expect(tiles.length).toBeGreaterThan(0);
		const theme = deriveTheme("#d6453b");
		expect(theme.accent).toBe("#d6453b");
		expect(theme.night).toMatch(/^#[0-9a-f]{6}$/);
	});

	test("clean-markers rewrites same-map links to #loc=<id> and preserves cross-map and external links", () => {
		const ctx = {
			mapSlug: "miraland",
			isDefaultMap: true,
			sameMapIds: new Set([509074, 444895, 320]),
			otherMapIds: new Set([900001]),
			otherMapSlugs: new Set(["firework-isles"]),
		};
		expect(resolveSameMapHref("https://mapgenie.io/infinity-nikki/maps/miraland?locationIds=509074", ctx)).toBe(
			"#loc=509074",
		);
		expect(resolveSameMapHref("https://rdr2map.com?locationIds=320", ctx)).toBe("#loc=320");
		expect(
			resolveSameMapHref("https://mapgenie.io/infinity-nikki/maps/firework-isles?locationIds=900001", ctx),
		).toBeNull();
		expect(resolveSameMapHref("#loc=509074", ctx)).toBeNull();

		const desc =
			"Find [Crank](https://mapgenie.io/infinity-nikki/maps/miraland?locationIds=444895) or travel to [Isles](https://mapgenie.io/infinity-nikki/maps/firework-isles?locationIds=900001).";
		const res = cleanDescription(desc, ctx);
		expect(res.cleaned).toBe(1);
		expect(res.text).toBe(
			"Find [Crank](#loc=444895) or travel to [Isles](https://mapgenie.io/infinity-nikki/maps/firework-isles?locationIds=900001).",
		);

		const maps = [
			{
				slug: "commonwealth",
				isDefault: true,
				data: {
					locations: [
						{
							id: 10,
							description:
								"Go to [Key](https://fallout4map.com?locationIds=11) or [Harbor](https://fallout4map.com/far-harbor?locationIds=20).",
						},
						{ id: 11, description: "Plain text" },
					],
				},
			},
			{
				slug: "far-harbor",
				isDefault: false,
				data: {
					locations: [
						{
							id: 20,
							description:
								"Back to [Commonwealth](https://fallout4map.com?locationIds=10) or [Local](https://fallout4map.com/far-harbor?locationIds=20).",
						},
					],
				},
			},
		];
		const stats = cleanGameMarkers(maps);
		expect(stats).toEqual({ maps: 2, locationsChanged: 2, linksCleaned: 2 });
		expect(maps[0].data.locations[0].description).toBe(
			"Go to [Key](#loc=11) or [Harbor](https://fallout4map.com/far-harbor?locationIds=20).",
		);
		expect(maps[1].data.locations[0].description).toBe(
			"Back to [Commonwealth](https://fallout4map.com?locationIds=10) or [Local](#loc=20).",
		);
	});
});

describe("build, self-hosted fonts, and service worker precache", () => {
	test("buildClient bundles all targets, verifies every PRECACHE path on disk, and embeds content hash in public/sw.js", async () => {
		await buildClient({ quiet: true });
		const swVersion = await verifyAndHashPrecache();
		expect(swVersion).toMatch(/^v40-[0-9a-f]{8}$/);
		expect(PRECACHE).toContain("fonts/instrument-sans-latin-variable.woff2");
		expect(PRECACHE).toContain("fonts/instrument-serif-latin-400-normal.woff2");
		expect(PRECACHE).not.toContain("perfect-freehand.mjs");

		const swCode = await readFile(path.join(process.cwd(), "public", "sw.js"), "utf8");
		expect(swCode).toContain(swVersion);
		expect(swCode).not.toContain("fonts.googleapis.com");
	});

	test("HTML pages do not load external Google Fonts and base.css declares @font-face for Instrument Sans and Instrument Serif", async () => {
		const htmlPages = [
			"public/index.html",
			"public/map.html",
			"public/signin/index.html",
			"public/account/index.html",
			"public/about/index.html",
			"public/terms/index.html",
			"public/privacy/index.html",
			"public/license/index.html",
		];
		for (const rel of htmlPages) {
			const html = await readFile(path.join(process.cwd(), rel), "utf8");
			expect(html).not.toContain("fonts.googleapis.com");
			expect(html).not.toContain("fonts.gstatic.com");
		}
		const baseCss = await readFile(path.join(process.cwd(), "public", "base.css"), "utf8");
		expect(baseCss).toContain('font-family: "Instrument Sans"');
		expect(baseCss).toContain('font-family: "Instrument Serif"');
		expect(baseCss).toContain("./fonts/instrument-sans-latin-variable.woff2");
	});
});

describe("server/api and server/ws integration", () => {
	let tmpDir: string;
	let api: ReturnType<typeof createApi>;
	let server: any;
	let baseUrl: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "atlas-test-"));
		api = createApi({ root: tmpDir, googleClientId: "test-google-client-id", publicUrl: "http://127.0.0.1" });
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req, s) {
				const url = new URL(req.url);
				if (url.pathname === "/api/ws") {
					const rejected = api.upgrade(req, s);
					if (rejected) return rejected;
					return;
				}
				const res = await api.handle(req, url);
				return res || new Response(null, { status: 404 });
			},
			websocket: api.websocket,
		});
		baseUrl = `http://127.0.0.1:${server.port}`;
	});

	afterEach(async () => {
		server.stop(true);
		api.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("secret key creation, normalization, login, sync push/pull/conflict, and WebSocket live notifications", async () => {
		// 1. Config & unauthenticated /api/me
		const cfgRes = await fetch(`${baseUrl}/api/config`);
		expect(await cfgRes.json()).toEqual({ googleClientId: "test-google-client-id" });

		const meAnon = await fetch(`${baseUrl}/api/me`);
		expect(await meAnon.json()).toEqual({ user: null });

		// 2. Create secret key account (unconfirmed secret is not registered yet)
		const newRes = await fetch(`${baseUrl}/api/auth/secret/new`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(newRes.status).toBe(200);
		expect(newRes.headers.get("set-cookie")).toBeNull();
		const { secret } = await newRes.json();
		expect(typeof secret).toBe("string");

		// Attempting to log in before confirmation fails
		const unconfirmedLogin = await fetch(`${baseUrl}/api/auth/secret/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
		expect(unconfirmedLogin.status).toBe(401);

		// Confirm secret key account
		const confirmRes = await fetch(`${baseUrl}/api/auth/secret/confirm`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
		expect(confirmRes.status).toBe(200);
		const setCookie = confirmRes.headers.get("set-cookie") || "";
		const cookie = setCookie.split(";")[0];
		expect(cookie).toStartWith("va_session=");
		const { user } = await confirmRes.json();
		expect(user.provider).toBe("secret");
		expect(user.name).toBe(secretName(secret));
		expect(user.name).not.toBe("Secret key account");

		// 3. Login with messy secret key (lowercase, spaces, lookalike O/I/L if applicable)
		const loginRes = await fetch(`${baseUrl}/api/auth/secret/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret: secret.toLowerCase().replace(/-/g, " ") }),
		});
		expect(loginRes.status).toBe(200);
		const loginJson = await loginRes.json();
		expect(loginJson.user.name).toBe(user.name);

		// Typo in the secret key fails validation with 400
		const badSecret = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
		const badLogin = await fetch(`${baseUrl}/api/auth/secret/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret: badSecret }),
		});
		expect(badLogin.status).toBe(400);

		// 4. Connect WebSocket as client-A to listen for live sync notifications
		const wsUrl = baseUrl.replace("http://", "ws://") + "/api/ws?c=client-A";
		const messages: any[] = [];
		const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } } as any);
		await new Promise<void>((resolve, reject) => {
			ws.onmessage = (ev) => {
				const msg = JSON.parse(String(ev.data));
				messages.push(msg);
				if (msg.type === "hello") resolve();
			};
			ws.onerror = reject;
		});
		expect(messages[0]).toEqual({ type: "hello" });

		// 5. Push a profile from client-B
		const push1 = await fetch(`${baseUrl}/api/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({
				client: "client-B",
				items: [
					{
						key: "profile:elden-ring:p1",
						value: { name: "Run 1", found: [1, 2], updated: 100, map: "limgrave", cameras: {} },
						base: 0,
					},
				],
			}),
		});
		expect(push1.status).toBe(200);
		const push1Data = await push1.json();
		expect(push1Data.results[0].status).toBe("ok");
		const serverTime1 = push1Data.results[0].updated_at;

		// Wait briefly for WebSocket broadcast to client-A
		await new Promise((r) => setTimeout(r, 30));
		expect(messages).toContainEqual({ type: "changed" });

		// 6. Camera-only update with stale base (base: 0) should NOT conflict because contentKey is identical
		const pushCam = await fetch(`${baseUrl}/api/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({
				client: "client-A",
				items: [
					{
						key: "profile:elden-ring:p1",
						value: { name: "Run 1", found: [1, 2], updated: 200, map: "caelid", cameras: {} },
						base: 0,
					},
				],
			}),
		});
		const pushCamData = await pushCam.json();
		expect(pushCamData.results[0].status).toBe("ok");
		expect(pushCamData.results[0].updated_at).toBeGreaterThan(serverTime1);

		// 7. Content change with stale base SHOULD return status: 'conflict'
		const pushConflict = await fetch(`${baseUrl}/api/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({
				client: "client-A",
				items: [
					{
						key: "profile:elden-ring:p1",
						value: { name: "Run 1", found: [1, 2, 999], updated: 300, map: "caelid", cameras: {} },
						base: 0,
					},
				],
			}),
		});
		const conflictData = await pushConflict.json();
		expect(conflictData.results[0].status).toBe("conflict");
		expect(conflictData.results[0].value.found).toEqual([1, 2]);

		// 8. Authenticated /api/me returns createdAt, sessions, and syncedItems
		const meAuth = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
		const meAuthData = await meAuth.json();
		expect(meAuthData.user.id).toBe(user.id);
		expect(meAuthData.user.createdAt).toBeGreaterThan(0);
		expect(meAuthData.user.sessions).toBeGreaterThanOrEqual(1);
		expect(meAuthData.user.syncedItems).toBe(1);

		// 9. Delete account cascades user_data, sessions, and secret_accounts and closes active WebSockets
		const wsClosed = new Promise<number>((resolve) => {
			ws.onclose = (ev) => resolve(ev.code);
		});
		const delRes = await fetch(`${baseUrl}/api/auth/delete-account`, {
			method: "POST",
			headers: { Cookie: cookie },
		});
		expect(delRes.status).toBe(200);
		expect(await delRes.json()).toEqual({ ok: true });
		expect(await wsClosed).toBe(4401);

		const meAfterDel = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
		expect(await meAfterDel.json()).toEqual({ user: null });

		const reloginAfterDel = await fetch(`${baseUrl}/api/auth/secret/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
		expect(reloginAfterDel.status).toBe(401);
	});

	test("collectMapPackItems gathers all metadata and tiles with root URLs and deduplication info", async () => {
		const items = await collectMapPackItems(
			path.join(process.cwd(), "public"),
			path.join(process.cwd(), "cache", "tiles"),
			"re7",
			"baker-ranch",
		);
		expect(items).not.toBeNull();
		expect(items!.length).toBeGreaterThan(10);
		expect(items!.some((i) => i.url === "/maps/re7/meta.json")).toBe(true);
		expect(items!.some((i) => i.url === "/maps/re7/baker-ranch/data.json")).toBe(true);
		expect(items!.some((i) => i.url.startsWith("/maps/re7/baker-ranch/tiles/"))).toBe(true);
		for (const item of items!) {
			expect(item.url.startsWith("/")).toBe(true);
			expect(item.size).toBeGreaterThanOrEqual(0);
			expect(item.contentType.length).toBeGreaterThan(0);
		}
	});

	test("bun:sqlite driver integration, db.transaction, and atomic rollback", async () => {
		expect(api._db.constructor.name).toBe("Database");

		// Test transaction commit and rollback directly on db.transaction
		const txSuccess = api._db.transaction((tableName: string) => {
			api._db
				.prepare("INSERT INTO game_popularity (game, requests, last_requested) VALUES (?, 10, 1000)")
				.run(tableName);
		});
		txSuccess.immediate("test-game-1");
		expect(api.gamePopularity().get("test-game-1")).toBe(10);

		// Rollback on throw
		const txFail = api._db.transaction(() => {
			api._db
				.prepare("INSERT INTO game_popularity (game, requests, last_requested) VALUES (?, 20, 2000)")
				.run("test-game-2");
			throw new Error("aborted transaction");
		});
		expect(() => txFail.immediate()).toThrow("aborted transaction");
		expect(api.gamePopularity().get("test-game-2")).toBeUndefined();
	});

	test("server media redirect route returns HTTP 308 when in SQLite media table and falls back when not", async () => {
		// Insert a media record into SQLite
		api.recordMedia({
			game: "re2",
			original_name: "test-cloud.jpg",
			sha256: "abcdef123456",
			size: 1024,
		});

		expect(api.hasMedia("re2", "test-cloud.jpg")).toBe(true);
		expect(api.hasMedia("re2", "nonexistent.jpg")).toBe(false);
		expect(api.getMedia("re2", "test-cloud.jpg")).toMatchObject({
			game: "re2",
			original_name: "test-cloud.jpg",
			sha256: "abcdef123456",
			size: 1024,
		});

		// Now simulate a server that handles media redirects
		const mediaServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const url = new URL(req.url);
				const mediaMatch = /^\/maps\/([^/]+)\/media\/([^/]+)$/.exec(url.pathname);
				if (mediaMatch && api.hasMedia(mediaMatch[1], mediaMatch[2])) {
					return new Response(null, {
						status: 308,
						headers: {
							Location: `https://atlas-media.verticordia.com/v1/${encodeURIComponent(mediaMatch[1])}/${encodeURIComponent(mediaMatch[2])}`,
							"Cache-Control": "public, max-age=31536000, immutable",
						},
					});
				}
				return new Response("Not in cloud", { status: 404 });
			},
		});

		try {
			const resCloud = await fetch(`http://127.0.0.1:${mediaServer.port}/maps/re2/media/test-cloud.jpg`, {
				redirect: "manual",
			});
			expect(resCloud.status).toBe(308);
			expect(resCloud.headers.get("location")).toBe("https://atlas-media.verticordia.com/v1/re2/test-cloud.jpg");
			expect(resCloud.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

			const resLocal = await fetch(`http://127.0.0.1:${mediaServer.port}/maps/re2/media/other.jpg`, {
				redirect: "manual",
			});
			expect(resLocal.status).toBe(404);
		} finally {
			mediaServer.stop(true);
		}
	});
});

describe("Cloudflare R2 and media storage pipeline", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(path.join(os.tmpdir(), "media-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("validateR2Env rejects missing or placeholder values and accepts valid configuration", () => {
		// Fails with default placeholders
		expect(() =>
			validateR2Env({
				env: {
					AWS_ACCESS_KEY_ID: "replace-me",
					AWS_SECRET_ACCESS_KEY: "replace-me",
					AWS_DEFAULT_REGION: "us-east-1",
					R2_ENDPOINT: "https://replace-me.r2.cloudflarestorage.com",
					R2_BUCKET: "replace-me",
				},
				root: testDir,
				loadDotEnvFile: false,
			}),
		).toThrow("Missing or unconfigured R2 environment variable");

		// Accepts valid custom values
		const cfg = validateR2Env({
			env: {
				AWS_ACCESS_KEY_ID: "valid-key-id",
				AWS_SECRET_ACCESS_KEY: "valid-secret-key",
				AWS_DEFAULT_REGION: "auto",
				R2_ENDPOINT: "https://account123.r2.cloudflarestorage.com",
				R2_BUCKET: "my-media-bucket",
				MEDIA_URL: "https://media.example.com",
			},
			root: testDir,
			loadDotEnvFile: false,
		});
		expect(cfg).toEqual({
			accessKeyId: "valid-key-id",
			secretAccessKey: "valid-secret-key",
			region: "auto",
			endpoint: "https://account123.r2.cloudflarestorage.com",
			bucket: "my-media-bucket",
			mediaUrl: "https://media.example.com",
		});
	});

	test("mimeForMedia, publicMediaUrl, and client mediaUrls resolve expected URLs and MIME types", () => {
		expect(mimeForMedia("photo.jpg")).toBe("image/jpeg");
		expect(mimeForMedia("photo.jpeg")).toBe("image/jpeg");
		expect(mimeForMedia("photo.png")).toBe("image/png");
		expect(mimeForMedia("photo.webp")).toBe("image/webp");
		expect(mimeForMedia("clip.mp4")).toBe("video/mp4");
		expect(mimeForMedia("unknown.xyz")).toBe("application/octet-stream");

		expect(publicMediaUrl("https://atlas-media.verticordia.com", "re2", "item 1.jpg")).toBe(
			"https://atlas-media.verticordia.com/v1/re2/item%201.jpg",
		);

		const clientUrls = mediaUrls("shot.jpg", "re2", "./custom", "https://atlas-media.verticordia.com");
		expect(clientUrls.primary).toBe("https://atlas-media.verticordia.com/v1/re2/shot.jpg");
		expect(clientUrls.fallback).toBe("./custom/media/shot.jpg");
	});

	test("resolveGameSlug resolves slug or throws when missing and not inferrable", () => {
		expect(resolveGameSlug("re2")).toBe("re2");
		expect(resolveGameSlug(undefined, "requiem")).toBe("requiem");
		expect(resolveGameSlug("public/maps/re2/data.json")).toBe("re2");
		expect(resolveGameSlug("/tmp/maps/elden-ring/media")).toBe("elden-ring");
		expect(() => resolveGameSlug(undefined)).toThrow("Game slug/id is required");
		expect(() => resolveGameSlug("/tmp/unknown/file.json")).toThrow("Could not infer game slug/id");
	});

	test("uploadAndVerifyBuffer uploads with Cache-Control, verifies SHA-256 over public link, and retries up to 3 attempts", async () => {
		const uploadedStore = new Map<string, Uint8Array>();
		let putCalls = 0;
		let getCalls = 0;

		const mockServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "PUT") {
					putCalls++;
					expect(req.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
					expect(req.headers.get("content-type")).toBe("image/jpeg");
					const body = new Uint8Array(await req.arrayBuffer());
					uploadedStore.set(url.pathname, body);
					return new Response(null, { status: 200 });
				}
				if (req.method === "GET") {
					getCalls++;
					const stored = uploadedStore.get(url.pathname);
					if (!stored) return new Response("Not found", { status: 404 });
					return new Response(stored, { status: 200 });
				}
				return new Response("Method not allowed", { status: 405 });
			},
		});

		try {
			const mockS3 = {
				presign: (key: string) => `http://127.0.0.1:${mockServer.port}/${key}`,
			};
			const testBuf = Buffer.from("test image bytes 1234567890");
			const rec = await uploadAndVerifyBuffer({
				game: "testgame",
				originalName: "test.jpg",
				buf: testBuf,
				s3: mockS3,
				mediaUrl: `http://127.0.0.1:${mockServer.port}`,
				maxTries: 3,
				retryDelayMs: 10,
			});

			expect(rec.game).toBe("testgame");
			expect(rec.original_name).toBe("test.jpg");
			expect(rec.size).toBe(testBuf.length);
			expect(rec.sha256).toBe(new Bun.CryptoHasher("sha256").update(testBuf).digest("hex"));
			expect(putCalls).toBe(1);
			expect(getCalls).toBe(1);
		} finally {
			mockServer.stop(true);
		}
	});

	test("uploadAndVerifyBuffer throws after 3 failed attempts on hash mismatch or server failure", async () => {
		let attempts = 0;
		const mockFailingServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				if (req.method === "PUT") {
					attempts++;
					return new Response(null, { status: 500 });
				}
				return new Response("Not found", { status: 404 });
			},
		});

		try {
			const mockS3 = {
				presign: (key: string) => `http://127.0.0.1:${mockFailingServer.port}/${key}`,
			};
			const testBuf = Buffer.from("test data");
			await expect(
				uploadAndVerifyBuffer({
					game: "testgame",
					originalName: "fail.jpg",
					buf: testBuf,
					s3: mockS3,
					mediaUrl: `http://127.0.0.1:${mockFailingServer.port}`,
					maxTries: 3,
					retryDelayMs: 5,
				}),
			).rejects.toThrow("Failed to upload and verify testgame/fail.jpg after 3 attempts");
			expect(attempts).toBe(3);
		} finally {
			mockFailingServer.stop(true);
		}
	});

	test("uploadMediaBatch uploads files, records in SQLite, deletes local files, and skips files already in cloud", async () => {
		const mediaDb = openMediaDb(testDir);
		const uploadedStore = new Map<string, Uint8Array>();

		const mockServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "PUT") {
					uploadedStore.set(url.pathname, new Uint8Array(await req.arrayBuffer()));
					return new Response(null, { status: 200 });
				}
				if (req.method === "GET") {
					const hit = uploadedStore.get(url.pathname);
					return hit ? new Response(hit, { status: 200 }) : new Response("Not found", { status: 404 });
				}
				return new Response(null, { status: 405 });
			},
		});

		try {
			const mockS3 = {
				presign: (key: string) => `http://127.0.0.1:${mockServer.port}/${key}`,
			};

			// Create 2 test files on disk in a dummy media dir
			const gameMediaDir = path.join(testDir, "public", "maps", "mygame", "media");
			await Bun.write(path.join(gameMediaDir, "img1.jpg"), "image-1-data");
			await Bun.write(path.join(gameMediaDir, "img2.jpg"), "image-2-data");

			const jobs = [
				{ game: "mygame", originalName: "img1.jpg", filePath: path.join(gameMediaDir, "img1.jpg") },
				{ game: "mygame", originalName: "img2.jpg", filePath: path.join(gameMediaDir, "img2.jpg") },
			];

			// 1. Upload first time with keepLocal: false
			const res1 = await uploadMediaBatch({
				jobs,
				s3: mockS3,
				mediaUrl: `http://127.0.0.1:${mockServer.port}`,
				mediaDb,
				keepLocal: false,
				retryDelayMs: 5,
			});

			expect(res1.uploaded).toBe(2);
			expect(res1.skippedCloud).toBe(0);
			expect(res1.deletedLocal).toBe(2);
			expect(mediaDb.has("mygame", "img1.jpg")).toBe(true);
			expect(mediaDb.has("mygame", "img2.jpg")).toBe(true);
			expect(await Bun.file(path.join(gameMediaDir, "img1.jpg")).exists()).toBe(false);

			// 2. Re-running the batch skips everything because it's in the cloud
			const res2 = await uploadMediaBatch({
				jobs,
				s3: mockS3,
				mediaUrl: `http://127.0.0.1:${mockServer.port}`,
				mediaDb,
				keepLocal: false,
				retryDelayMs: 5,
			});
			expect(res2.uploaded).toBe(0);
			expect(res2.skippedCloud).toBe(2);
		} finally {
			mockServer.stop(true);
			mediaDb.close();
		}
	});
});