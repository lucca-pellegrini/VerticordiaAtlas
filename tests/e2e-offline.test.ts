// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer";

import { spawnServer } from "./spawn-server.ts";
import { hasTileFixtures } from "./tile-fixtures.ts";

let PORT1: number;
let BASE1: string;
const HAS_RE2_TILES = hasTileFixtures("re2", ["claire-a", "claire-b", "leon-a", "leon-b"]);
const HAS_HOLLOW_KNIGHT_TILES = hasTileFixtures("hollow-knight", ["hallownest"]);

let serverProc1: any;
let deadServer: { stop(force?: boolean): unknown } | null = null;
let browser: Browser;

beforeAll(async () => {
	if (!HAS_RE2_TILES && !HAS_HOLLOW_KNIGHT_TILES) return;

	const s = await spawnServer();
	serverProc1 = s.proc;
	PORT1 = s.port;
	BASE1 = s.base;

	browser = await puppeteer.launch({
		executablePath: "/usr/bin/chromium",
		headless: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-web-security"],
	});
}, 30000);

afterAll(async () => {
	try {
		await browser?.close();
	} catch {}
	try {
		serverProc1?.kill(9);
	} catch {}
	try {
		deadServer?.stop(true);
	} catch {}
});

describe("map marker navigation & tile loading e2e", () => {
	test.skipIf(!HAS_HOLLOW_KNIGHT_TILES)(
		"opens hollow-knight map, clicks a marker, and follows linked markers across the map while loading tiles without errors",
		async () => {
			const context = await browser.createBrowserContext();
			const page = await context.newPage();
			await page.setViewport({ width: 1280, height: 800 });

			const consoleErrors: string[] = [];
			page.on("console", (msg) => {
				if (msg.type() === "error") consoleErrors.push(msg.text());
			});
			page.on("pageerror", (err: any) => consoleErrors.push(err?.message ?? String(err)));

			const tileResponses: { url: string; status: number; xTileFrom: string | null }[] = [];
			page.on("response", (res) => {
				if (res.url().includes("/tiles/")) {
					tileResponses.push({
						url: res.url(),
						status: res.status(),
						xTileFrom: res.headers()["x-tile-from"] ?? null,
					});
				}
			});

			// 1. Open Hollow Knight map and wait for initial tiles to settle
			await page.goto(`${BASE1}/maps/hollow-knight/`, { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#map canvas", { timeout: 15000 });
			await page.waitForFunction(() => !document.body.classList.contains("loading-map"), { timeout: 25000 });

			const initialTileCount = tileResponses.length;
			expect(initialTileCount).toBeGreaterThan(0);
			expect(tileResponses.every((t) => t.status === 200)).toBe(true);

			// 2. Click "Mister Mushroom 7" (id 469835) on the MapLibre canvas near the starting camera
			const box = await page.$eval("#map canvas", (el) => {
				const r = el.getBoundingClientRect();
				return { left: r.left, top: r.top, width: r.width, height: r.height };
			});
			const cx = box.left + box.width / 2;
			const cy = box.top + box.height / 2;

			// Mister Mushroom 7 is at (-0.834789, 0.833322), right of start camera (-0.841131, 0.833750) at zoom 13
			let clickedCanvasMarker = false;
			for (const dx of [74, 37, 70, 78, 35, 40]) {
				for (const dy of [-12, -6, -18, 0]) {
					await page.mouse.move(cx + dx, cy + dy);
					const tipText = await page.evaluate(
						() => document.querySelector(".maplibregl-popup.tip")?.textContent || "",
					);
					if (tipText.includes("Mister Mushroom 7")) {
						await page.mouse.click(cx + dx, cy + dy);
						clickedCanvasMarker = true;
						break;
					}
				}
				if (clickedCanvasMarker) break;
			}
			expect(clickedCanvasMarker).toBe(true);

			await page.waitForSelector("body.detail-open #detail:not([hidden]) .d-title", { timeout: 10000 });
			const firstTitle = await page.$eval("#detail .d-title", (el) => el.textContent?.trim() || "");
			expect(firstTitle).toBe("Mister Mushroom 7");

			// 3. Follow link to "Mister Mushroom 6" (469844), then "Mister Mushroom 5" (469843), then "Mister Mushroom 4" (469842)
			const hops = [
				{ id: "469844", title: "Mister Mushroom 6" },
				{ id: "469843", title: "Mister Mushroom 5" },
				{ id: "469842", title: "Mister Mushroom 4" },
			];

			let prevTileCount = tileResponses.length;
			for (const hop of hops) {
				const linkSelector = `#detail-body a[data-loc="${hop.id}"]`;
				await page.waitForSelector(linkSelector, { visible: true, timeout: 10000 });
				await page.$eval(linkSelector, (el) => (el as HTMLElement).click());

				await page.waitForFunction(
					(expectedTitle) => {
						const el = document.querySelector("#detail .d-title");
						return el && el.textContent?.trim() === expectedTitle;
					},
					{ timeout: 10000 },
					hop.title,
				);
				expect(await page.evaluate(() => location.hash)).toBe(`#loc=${hop.id}`);

				// Wait for the camera flyTo animation to request and load tiles for the new region
				await page.waitForFunction(() => !document.body.classList.contains("loading-map"), { timeout: 15000 });
				await new Promise((r) => setTimeout(r, 1200));
				expect(tileResponses.length).toBeGreaterThan(prevTileCount);
				expect(tileResponses.every((t) => t.status === 200)).toBe(true);
				expect(tileResponses.every((t) => ["stored", "cache", "made"].includes(t.xTileFrom || ""))).toBe(true);
				prevTileCount = tileResponses.length;
			}

			// Verify the back button in the detail card is visible after following the link chain
			const backHidden = await page.$eval("#detail-back", (el) => (el as HTMLElement).hidden);
			expect(backHidden).toBe(false);
			expect(consoleErrors).toEqual([]);

			await context.close();
		},
		120000,
	);
});

describe("offline map download & disconnected navigation e2e", () => {
	test.skipIf(!HAS_RE2_TILES)(
		"downloads game with multiple maps, switches maps offline, and persists without server",
		async () => {
			const context = await browser.createBrowserContext();
			const page = await context.newPage();

			const consoleErrors: string[] = [];
			page.on("console", (msg) => {
				if (msg.type() === "error") consoleErrors.push(msg.text());
			});
			page.on("pageerror", (err: any) => consoleErrors.push(err?.message ?? String(err)));

			// 1. Navigate to Resident Evil 2 map page (which has 4 maps: claire-a, claire-b, leon-a, leon-b)
			await page.goto(`${BASE1}/maps/re2/`, { waitUntil: "networkidle2" });
			await page.waitForSelector("#map canvas", { timeout: 10000 });
			await page.waitForSelector("#side-more-btn", { timeout: 5000 });

			// Check deprecation warning: mobile-web-app-capable meta tag exists
			const mobileCapable = await page.$eval('meta[name="mobile-web-app-capable"]', (el) =>
				el.getAttribute("content"),
			);
			expect(mobileCapable).toBe("yes");

			// Check sidebar: side-offline-quick button is gone, only side-offline-btn remains in dropdown
			const quickBtn = await page.$("#side-offline-quick");
			expect(quickBtn).toBeNull();

			// 2. Open more menu and click "Keep game offline"
			await page.click("#side-more-btn");
			await page.waitForSelector("#side-offline-btn", { visible: true });

			const initialBtnText = await page.$eval("#side-offline-btn span", (el) => el.textContent);
			expect(initialBtnText).toBe("Keep game offline");

			await page.evaluate(() => {
				const texts: string[] = ((window as any).__btnTexts = []);
				const progresses: string[] = ((window as any).__btnProgresses = []);
				const moreBusyStates: boolean[] = ((window as any).__moreBusy = []);
				const btn = document.querySelector("#side-offline-btn") as HTMLElement;
				const moreBtn = document.querySelector("#side-more-btn") as HTMLElement;
				new MutationObserver(() => {
					const t = btn.textContent || "";
					if (texts[texts.length - 1] !== t) texts.push(t);
					const p = btn.style.getPropertyValue("--progress");
					if (p && progresses[progresses.length - 1] !== p) progresses.push(p);
				}).observe(btn, {
					childList: true,
					subtree: true,
					characterData: true,
					attributes: true,
					attributeFilter: ["style"],
				});
				if (moreBtn) {
					new MutationObserver(() => {
						moreBusyStates.push(moreBtn.dataset.busy === "1" && !!moreBtn.querySelector(".more-dl-svg"));
					}).observe(moreBtn, {
						childList: true,
						subtree: true,
						attributes: true,
						attributeFilter: ["data-busy"],
					});
				}
			});
			await page.click("#side-offline-btn");

			// Wait for download to finish (shows "Kept offline")
			await page.waitForFunction(
				() => {
					const btn = document.querySelector("#side-offline-btn span");
					return btn && btn.textContent === "Kept offline";
				},
				{ timeout: 240000 },
			);

			// the button said "Preparing map n/4" (with a spinner) while the server worked, and "Downloading 1/4" without % (progress shown via filled background)
			const texts: string[] = await page.evaluate(() => (window as any).__btnTexts);
			const progresses: string[] = await page.evaluate(() => (window as any).__btnProgresses);
			expect(texts.some((t) => /^Preparing map 1\/4/.test(t))).toBe(true);
			expect(texts.some((t) => t === "Downloading 1/4")).toBe(true);
			expect(texts.every((t) => !t.includes("%"))).toBe(true);
			expect(progresses.some((p) => p.endsWith("%") && p !== "0%")).toBe(true);

			// The side-more-btn showed the animated download progress icon with wheel during download and reverted to dots
			const moreBusy: boolean[] = await page.evaluate(() => (window as any).__moreBusy);
			expect(moreBusy.some((b) => b)).toBe(true);
			const finalMoreHasDots = await page.$eval("#side-more-btn", (el) => !!el.querySelector("svg.dots"));
			expect(finalMoreHasDots).toBe(true);

			// Assert no unhandled range errors or call stack errors occurred
			const callStackErrors = consoleErrors.filter((e) => e.includes("Maximum call stack size"));
			expect(callStackErrors).toEqual([]);

			// 3. Verify IndexedDB manifest exists for maps and Cache API has offline tiles
			const idbManifest = await page.evaluate(async () => {
				return new Promise((resolve) => {
					const req = indexedDB.open("offline-map-viewer");
					req.onsuccess = () => {
						const db = req.result;
						const tx = db.transaction("meta", "readonly");
						const store = tx.objectStore("meta");
						const getReq = store.get("offline:re2:leon-b");
						getReq.onsuccess = () => resolve(getReq.result);
						getReq.onerror = () => resolve(null);
					};
					req.onerror = () => resolve(null);
				});
			});
			expect(idbManifest).not.toBeNull();
			const manifestObj = (idbManifest as any).v ?? idbManifest;
			expect(manifestObj.enabled).toBe(true);

			// the files are one pack per map in IndexedDB, not Cache API entries
			const storage = await page.evaluate(async () => {
				const keys: string[] = await new Promise((resolve) => {
					const req = indexedDB.open("va-offline-packs");
					req.onsuccess = () => {
						const r = req.result.transaction("packs", "readonly").objectStore("packs").getAllKeys();
						r.onsuccess = () => resolve(r.result as string[]);
					};
				});
				const cache = await caches.open("va-offline-tiles");
				return { keys, legacyEntries: (await cache.keys()).length };
			});
			expect(storage.keys.sort()).toEqual(["re2/claire-a", "re2/claire-b", "re2/leon-a", "re2/leon-b"]);
			expect(storage.legacyEntries).toBe(0);

			// 4. DISCONNECT: the server is gone and what answers on its port is a proxy's "502 Bad Gateway"
			serverProc1.kill(9);
			await new Promise((r) => setTimeout(r, 300));
			deadServer = Bun.serve({
				port: PORT1,
				hostname: "127.0.0.1",
				fetch: () => new Response("bad gateway", { status: 502 }),
			});
			const tileStatuses: number[] = [];
			page.on("response", (res) => {
				if (res.url().includes("/tiles/")) tileStatuses.push(res.status());
			});

			// 5. SWITCH MAP TO "Leon [B]" WHILE COMPLETELY OFFLINE
			// Click on Leon [B] in map switcher
			// (a narrow sidebar swaps the pills for a drop-down; the pill's own handler is the same either way)
			await page.$eval('#map-switch button[data-map="leon-b"]', (el) => (el as HTMLElement).click());

			// Wait for map switch to settle
			await page.waitForSelector('#map-switch button[data-map="leon-b"][aria-pressed="true"]', {
				timeout: 15000,
			});

			// Verify NO error toasts appeared (such as "Could not load Leon [B].")
			const toasts = await page.evaluate(() => {
				return Array.from(document.querySelectorAll("#toast")).map((t) => t.textContent || "");
			});
			expect(toasts.some((t) => t.includes("Could not load"))).toBe(false);

			// Verify groups and locations rendered for Leon [B]
			await page.waitForSelector("#groups .group", { timeout: 10000 });
			const groupCount = await page.evaluate(() => document.querySelectorAll("#groups .group").length);
			expect(groupCount).toBeGreaterThan(0);

			// the new map's tiles came from the pack: none failed
			await new Promise((r) => setTimeout(r, 2500));
			expect(tileStatuses.length).toBeGreaterThan(0);
			expect(tileStatuses.every((c) => c === 200)).toBe(true);

			// 6. Reload map page while the server is gone
			await page.reload({ waitUntil: "networkidle2" });

			// Verify page loaded from service worker shell + offline cache
			await page.waitForSelector("#map canvas", { timeout: 10000 });
			const pageTitle = await page.title();
			expect(pageTitle).toContain("Resident Evil 2");

			// Search for an item offline
			const searchInput = await page.$("#search-input");
			if (searchInput) {
				await page.type("#search-input", "Gunpowder");
				await new Promise((r) => setTimeout(r, 300));
				const resultsCount = await page.evaluate(() => {
					return document.querySelectorAll("#search-results .s-item").length;
				});
				expect(resultsCount).toBeGreaterThan(0);
			}

			// the home page shows downloaded games as kept offline, and grayed-out warnings for non-downloaded games
			await page.goto(`${BASE1}/`, { waitUntil: "networkidle2" });
			await page.waitForSelector(".card", { timeout: 10000 });
			expect(await page.$("[data-offline-slug]")).toBeNull();

			// 1. re2 (downloaded) has data-offline="downloaded"
			await page.waitForSelector('li.card-li[data-offline="downloaded"] a[data-slug="re2"]', { timeout: 10000 });

			// 2. non-downloaded games have data-offline="unavailable"
			const unavailLi = await page.$('li.card-li[data-offline="unavailable"] a[data-slug="elden-ring"]');
			expect(unavailLi).not.toBeNull();

			// 3. clicking unavailable game brings up the confirmation dialog with warning
			await page.click('li.card-li[data-offline="unavailable"] a[data-slug="elden-ring"]');
			await page.waitForSelector("dialog.home-dialog[open]", { timeout: 5000 });
			const dlgText = await page.$eval("dialog.home-dialog p", (el) => el.textContent || "");
			expect(dlgText).toContain("This game has not been downloaded or cached for offline use");
			expect(dlgText).toContain("page will probably not load at all until you're back online");

			// Click cancel closes dialog and keeps user on home page
			await page.click("dialog.home-dialog .btn-cancel");
			await new Promise((r) => setTimeout(r, 200));
			expect(await page.$("dialog.home-dialog")).toBeNull();
			expect(page.url()).toBe(`${BASE1}/`);
			await page.goto(`${BASE1}/account/`, { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#offline-list .offline-item", { timeout: 10000 });
			const rows: string[] = await page.$$eval("#offline-list .offline-item", (els) =>
				els.map((e) => e.textContent || ""),
			);
			expect(rows.length).toBe(4);
			expect(rows.every((t) => t.includes("Verified") && !t.includes("Missing data"))).toBe(true);

			await context.close();
		},
		600000,
	);
});