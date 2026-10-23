import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { deriveTheme, extractVar, tilesCovering } from "../scripts/add-game.ts";
import { buildClient, verifyAndHashPrecache } from "../scripts/build.ts";
import { createApi } from "../server/api.ts";
import {
	deriveLightTheme,
	esc,
	gameFavicon,
	gameThemeColor,
	hexToHsl,
	hslToHex,
	officialIcon,
	plainText,
	socialTags,
	withHead,
} from "../server/cards.ts";
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
});

describe("build, self-hosted fonts, and service worker precache", () => {
	test("buildClient bundles all targets, verifies every PRECACHE path on disk, and embeds content hash in public/sw.js", async () => {
		await buildClient({ quiet: true });
		const swVersion = await verifyAndHashPrecache();
		expect(swVersion).toMatch(/^v40-[0-9a-f]{8}$/);
		expect(PRECACHE).toContain("fonts/inter-latin-400-normal.woff2");
		expect(PRECACHE).toContain("fonts/instrument-serif-latin-400-normal.woff2");
		expect(PRECACHE).not.toContain("perfect-freehand.mjs");

		const swCode = await readFile(path.join(process.cwd(), "public", "sw.js"), "utf8");
		expect(swCode).toContain(swVersion);
		expect(swCode).not.toContain("fonts.googleapis.com");
	});

	test("HTML pages do not load external Google Fonts and base.css declares @font-face for Inter and Instrument Serif", async () => {
		const htmlPages = [
			"public/index.html",
			"public/map.html",
			"public/signin/index.html",
			"public/about/index.html",
			"public/terms/index.html",
			"public/privacy/index.html",
		];
		for (const rel of htmlPages) {
			const html = await readFile(path.join(process.cwd(), rel), "utf8");
			expect(html).not.toContain("fonts.googleapis.com");
			expect(html).not.toContain("fonts.gstatic.com");
		}
		const baseCss = await readFile(path.join(process.cwd(), "public", "base.css"), "utf8");
		expect(baseCss).toContain('font-family: "Inter"');
		expect(baseCss).toContain('font-family: "Instrument Serif"');
		expect(baseCss).toContain("./fonts/inter-latin-400-normal.woff2");
	});
});

describe("server/api and server/ws integration", () => {
	let tmpDir: string;
	let api: ReturnType<typeof createApi>;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "atlas-test-"));
		api = createApi({ root: tmpDir, googleClientId: "test-google-client-id", publicUrl: "http://127.0.0.1" });
		server = http.createServer(async (req, res) => {
			const url = new URL(req.url || "/", "http://127.0.0.1");
			const handled = await api.handle(req, res, url);
			if (handled === false) {
				res.writeHead(404);
				res.end();
			}
		});
		server.on("upgrade", (req, socket, head) => {
			const url = new URL(req.url || "/", "http://127.0.0.1");
			api.upgrade(req, socket, head, url);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address() as { port: number };
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterEach(async () => {
		server.closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		api.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("secret key creation, normalization, login, sync push/pull/conflict, and WebSocket live notifications", async () => {
		// 1. Config & unauthenticated /api/me
		const cfgRes = await fetch(`${baseUrl}/api/config`);
		expect(await cfgRes.json()).toEqual({ googleClientId: "test-google-client-id" });

		const meAnon = await fetch(`${baseUrl}/api/me`);
		expect(await meAnon.json()).toEqual({ user: null });

		// 2. Create secret key account
		const newRes = await fetch(`${baseUrl}/api/auth/secret/new`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(newRes.status).toBe(200);
		const setCookie = newRes.headers.get("set-cookie") || "";
		const cookie = setCookie.split(";")[0];
		expect(cookie).toStartWith("va_session=");
		const { user, secret } = await newRes.json();
		expect(user.provider).toBe("secret");
		expect(typeof secret).toBe("string");

		// 3. Login with messy secret key (lowercase, spaces, lookalike O/I/L if applicable)
		const loginRes = await fetch(`${baseUrl}/api/auth/secret/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret: secret.toLowerCase().replace(/-/g, " ") }),
		});
		expect(loginRes.status).toBe(200);

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

		ws.close();
	});
});