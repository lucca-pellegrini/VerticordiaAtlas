// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Headless-browser checks of the map viewer's load, detail card, search, toggles, All-maps search, offline reload,
// homepage posters and a perf baseline. Starts the real server on an ephemeral port and reads public/maps/ (never writes it).
// Needs Chrome and the tracked data of world-of-warcraft and hollow-knight. Missing prerequisites FAIL when CI is set
// and skip with a warning locally, so a green CI run always means the checks ran.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer";

import { spawnServer } from "./spawn-server.ts";
import { hasTileFixtures } from "./tile-fixtures.ts";

const GAME = "world-of-warcraft",
	MAP = "eastern-kingdoms",
	CONTROL_GAME = "hollow-knight",
	CONTROL_MAP = "hallownest";
const EK_DIR = `public/maps/${GAME}/${MAP}`;
const T = 240_000; // per-test timeout: a throttled or cold runner is slow, the checks are not
const CHROME = [
	process.env.CHROME_PATH,
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
];
// tiles are gitignored: a checkout without them gets 404s for tiles, which say nothing about the viewer
const HAS_TILES = hasTileFixtures(GAME, [MAP]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- setup ---------- */

let server: { base: string; proc: ReturnType<typeof Bun.spawn> };
let browser: Browser;
let ek: { id: number; title: string; link: number };
let hk: { id: number; title: string; link: number };
let setupError: string | null = null; // why the tests cannot run; thrown by guard() on CI, a skip otherwise

// `bun run start` is `bun server/server.ts`; spawned directly so that kill() reaches the server itself

// a location with a description that links another location of the same map: the detail card has a link graph
function pickLinked(file: string, kind: "details" | "data"): { id: number; title: string; link: number } {
	const j = JSON.parse(readFileSync(file, "utf8"));
	const rows: [number, string, string][] =
		kind === "details"
			? Object.entries<any>(j.d).map(([id, v]) => [+id, "", v[0] as string])
			: j.locations.map((l: any) => [l.id, l.title, l.description || ""]);
	const ids = new Set(rows.map((r) => r[0]));
	for (const [id, title, desc] of rows)
		for (const m of desc.matchAll(/\(#loc=(\d+)\)/g))
			if (+m[1]! !== id && ids.has(+m[1]!)) return { id, title, link: +m[1]! };
	throw new Error("no linked description in " + file);
}

beforeAll(async () => {
	try {
		const need = [
			`${EK_DIR}/data.compact.json`,
			`${EK_DIR}/data.details.json`,
			`public/maps/${CONTROL_GAME}/${CONTROL_MAP}/data.json`,
		];
		const missing = need.filter((f) => !existsSync(f));
		if (missing.length) throw new Error("browser e2e needs " + missing.join(", "));
		const chrome = CHROME.find((p) => p && existsSync(p));
		if (!chrome) throw new Error("browser e2e needs Chrome: set CHROME_PATH or install chromium");
		ek = pickLinked(`${EK_DIR}/data.details.json`, "details");
		hk = pickLinked(need[2]!, "data");
		server = await spawnServer();
		browser = await puppeteer.launch({
			executablePath: chrome,
			headless: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
		});
	} catch (e: any) {
		setupError = e?.message ?? String(e);
		await afterAllCleanup();
		if (!process.env.CI && process.env.DEBUG) console.warn(`browser e2e skipped locally: ${setupError}`);
	}
}, 120_000);

async function afterAllCleanup() {
	await browser?.close().catch(() => {});
	server?.proc.kill(9);
}
afterAll(afterAllCleanup);

// true: run. false: skip locally. On CI a setup problem fails the test with its reason.
function guard(): boolean {
	if (setupError && process.env.CI) throw new Error("browser e2e cannot run on CI: " + setupError);
	return !setupError;
}

/* ---------- page helpers ---------- */

interface Tracked {
	page: Page;
	errors: string[]; // console errors and page errors
	failed: string[]; // failed requests and HTTP >= 400
	aborted: string[]; // cancelled by the browser
	urls: string[]; // every response URL, in order
	perf: { name: string; ms: number }[]; // "[perf] name 1.2 ms" debug lines
	tables: any[]; // console.table payloads (perfReport)
}

// the maplibregl global is wrapped so the test can reach the map
const HOOK = `
let real;
Object.defineProperty(window, "maplibregl", {
	configurable: true,
	get: () => real,
	set(v) {
		real = v;
		const Orig = v.Map;
		const Wrapped = function (...a) {
			const m = new Orig(...a);
			window.__map = m;
			return m;
		};
		Wrapped.prototype = Orig.prototype;
		v.Map = Wrapped;
	},
});`;

const ignorable = (s: string) => !HAS_TILES && s.includes("/tiles/");

async function track(ctx: BrowserContext, opts: { bypassSW?: boolean } = {}): Promise<Tracked> {
	const page = await ctx.newPage();
	await page.setViewport({ width: 1280, height: 800 });
	if (opts.bypassSW) await page.setBypassServiceWorker(true);
	await page.evaluateOnNewDocument(HOOK);
	const t: Tracked = { page, errors: [], failed: [], aborted: [], urls: [], perf: [], tables: [] };
	page.on("console", (m) => {
		if (m.type() === "error" && !ignorable(m.text() + " " + (m.location().url ?? ""))) t.errors.push(m.text());
		if (m.type() === "debug") {
			const r = /^\[perf\] (\w+) ([\d.]+) ms$/.exec(m.text());
			if (r) t.perf.push({ name: r[1]!, ms: +r[2]! });
		}
		if (m.type() === "table")
			void m
				.args()[0]
				?.jsonValue()
				.then((v) => t.tables.push(v));
	});
	page.on("pageerror", (e: any) => t.errors.push("pageerror: " + (e?.message ?? e)));
	// ERR_ABORTED is the browser cancelling a request itself (a tile the camera moved past): counted apart
	page.on("requestfailed", (r) => {
		const line = `${r.failure()?.errorText} ${r.url()}`;
		if (r.failure()?.errorText === "net::ERR_ABORTED") t.aborted.push(line);
		else if (!ignorable(line)) t.failed.push(line);
	});
	page.on("response", (r) => {
		t.urls.push(r.url());
		if (r.status() >= 400 && !ignorable(r.url())) t.failed.push(`HTTP ${r.status()} ${r.url()}`);
	});
	return t;
}

const mapUrl = (game: string, map: string, extra = "") => `${server.base}/maps/${game}/?map=${map}&perf=1${extra}`;

// map drawn, sidebar built, and the marker source has features
async function ready(page: Page): Promise<void> {
	await page.waitForSelector("#map canvas", { timeout: 20000 });
	await page.waitForFunction(() => !document.body.classList.contains("loading-map"), { timeout: 60000 });
	await page.waitForFunction(
		() => {
			const m = (window as any).__map;
			return (
				m &&
				m.getSource("locs") &&
				(m.querySourceFeatures("locs").length > 0 || m.querySourceFeatures("locs-circles").length > 0)
			);
		},
		{ timeout: 60000 },
	);
}

// what the map shows now: marker ids (both marker layers) that pass the layers' filters, and the unfiltered ids
async function shown(page: Page) {
	// not while the camera moves or tiles load: the sets are of the viewport's tiles
	await page
		.waitForFunction(() => (window as any).__map.loaded() && !(window as any).__map.isMoving(), { timeout: 20000 })
		.catch(() => {});
	await sleep(300);
	return page.evaluate(() => {
		const m = (window as any).__map;
		const ids = (layer: string, filtered: boolean) =>
			m
				.querySourceFeatures(layer, filtered ? { filter: m.getFilter(layer) } : {})
				.map((f: any) => ({ ...f.properties, xy: f.geometry.coordinates }));
		const all = [...ids("locs", false), ...ids("locs-circles", false)];
		const vis = [...ids("locs", true), ...ids("locs-circles", true)];
		const uniq = (a: any[]) => [...new Map(a.map((p) => [p.id, p])).values()];
		return { all: uniq(all), vis: uniq(vis) };
	});
}

const dataRe = /\/data\.(compact|details)?\.?json$/;
const the = (urls: string[], re: RegExp) => urls.filter((u) => re.test(u));
const tail = (u: string) => u.replace(/^https?:\/\/[^/]+/, "");
const topCategory = (vis: any[], n = 1) => {
	const counts = new Map<number, number>();
	for (const p of vis) counts.set(p.cat, (counts.get(p.cat) || 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
};

/* ---------- checks ---------- */

describe("browser e2e (real server, headless Chrome)", () => {
	test(
		"1. eastern-kingdoms loads clean on the compact path",
		async () => {
			if (!guard()) return;
			const ctx = await browser.createBrowserContext();
			const t = await track(ctx, { bypassSW: true });
			await t.page.goto(mapUrl(GAME, MAP), { waitUntil: "domcontentloaded" });
			await ready(t.page);
			await sleep(1500);
			const files = the(t.urls, dataRe).map(tail);
			await ctx.close();
			expect({ errors: t.errors, failed: t.failed }).toEqual({ errors: [], failed: [] });
			// compact only: details are fetched lazily with the first card or search, marked.js only for a description
			expect(files).toEqual([`/maps/${GAME}/${MAP}/data.compact.json`]);
			expect(the(t.urls, new RegExp(`/${MAP}/data\\.json$`))).toEqual([]);
			expect(the(t.urls, /marked\.umd\.js/)).toEqual([]);
		},
		T,
	);

	const detailCheck = async (
		game: string,
		map: string,
		m: { id: number; link: number },
		prep: (p: Page) => Promise<void>,
	) => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx, { bypassSW: true });
		await prep(t.page);
		await t.page.goto(mapUrl(game, map, `&loc=${m.id}`), { waitUntil: "domcontentloaded" });
		await t.page.waitForSelector("body.detail-open #detail:not([hidden]) .d-title", { timeout: 60000 });
		const title = await t.page.$eval("#detail .d-title", (e) => e.textContent?.trim() || "");
		await t.page.waitForSelector("#detail-body .d-desc a[data-loc]", { timeout: 15000 });
		const desc = await t.page.$eval("#detail-body .d-desc", (e) => ({
			text: e.textContent?.trim() || "",
			links: e.querySelectorAll("a[data-loc]").length,
		}));
		await t.page.$eval(`#detail-body a[data-loc="${m.link}"]`, (el) => (el as HTMLElement).click());
		await t.page.waitForFunction((id) => location.hash === `#loc=${id}`, { timeout: 10000 }, String(m.link));
		const files = the(t.urls, dataRe).map(tail);
		await ctx.close();
		expect({ errors: t.errors, failed: t.failed }).toEqual({ errors: [], failed: [] });
		expect(title.length).toBeGreaterThan(0);
		expect(desc.text.length).toBeGreaterThan(20);
		expect(desc.links).toBeGreaterThan(0);
		return files;
	};
	test(
		"2a. detail card: description and link graph hop (compact + details)",
		async () => {
			if (!guard()) return;
			const files = await detailCheck(GAME, MAP, ek, async () => {});
			expect(files).toEqual([`/maps/${GAME}/${MAP}/data.compact.json`, `/maps/${GAME}/${MAP}/data.details.json`]);
		},
		T,
	);
	test(
		"2b. detail card: description and link graph hop (control map without compact: data.json fallback)",
		async () => {
			if (!guard()) return;
			// the map's meta is served without "compact", so the client takes data.json (the fallback path)
			const files = await detailCheck(CONTROL_GAME, CONTROL_MAP, hk, async (p) => {
				await p.setRequestInterception(true);
				p.on("request", async (req) => {
					if (!req.url().endsWith(`/maps/${CONTROL_GAME}/meta.json`)) return void req.continue();
					const meta = await (await fetch(req.url())).json();
					for (const mp of meta.maps) delete mp.compact;
					void req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(meta) });
				});
			});
			expect(files).toEqual([`/maps/${CONTROL_GAME}/${CONTROL_MAP}/data.json`]);
		},
		T,
	);

	test(
		"3. search: one debounced run, Enter immediate, rows, Show more",
		async () => {
			if (!guard()) return;
			const ctx = await browser.createBrowserContext();
			const t = await track(ctx, { bypassSW: true });
			// the card opens first so the descriptions are loaded: otherwise a run repeats once when they arrive
			await t.page.goto(mapUrl(GAME, MAP, `&loc=${ek.id}`), { waitUntil: "domcontentloaded" });
			await t.page.waitForSelector("body.detail-open #detail .d-title", { timeout: 60000 });
			await ready(t.page);
			await t.page.click("#detail-close");
			const runs = () => t.perf.filter((p) => p.name === "runSearch").length;
			const resultCount = () => t.page.$$eval("#results li.result", (l) => l.length);

			// a. 4 characters, 40 ms apart: one run, after the debounce
			const r0 = runs();
			await t.page.click("#search");
			await t.page.keyboard.type("herb", { delay: 40 });
			await t.page.waitForFunction(() => document.querySelectorAll("#results li.result").length > 0, {
				timeout: 10000,
			});
			await sleep(800);
			const debounced = runs() - r0;
			const nRows = await resultCount();
			const first = await t.page.$eval("#results li.result", (e) => ({
				title: e.querySelector(".r-title")?.textContent,
				sub: e.querySelector(".r-sub")?.textContent,
			}));

			// b. Enter: typed with no delay, Enter at once: one run before the 140 ms timer could have fired
			await t.page.keyboard.press("Escape");
			await sleep(300);
			const r1 = runs();
			await t.page.click("#search");
			await t.page.keyboard.type("gold");
			await t.page.keyboard.press("Enter");
			const enterAt = Date.now();
			await t.page.waitForFunction(
				() =>
					(document.querySelector("#results-bar .r-count")?.textContent || "").length > 0 &&
					document.querySelectorAll("#results li.result").length > 0,
				{ timeout: 5000 },
			);
			const enterMs = Date.now() - enterAt;
			const afterEnter = runs() - r1;
			await sleep(600);
			const settledEnter = runs() - r1;

			// c. Show more: the wildcard lists every marker of the map
			await t.page.keyboard.press("Escape");
			await sleep(300);
			await t.page.click("#search");
			await t.page.keyboard.type("*", { delay: 20 });
			await t.page.waitForFunction(() => document.querySelectorAll("#results li.result").length > 0, {
				timeout: 15000,
			});
			const wildRows = await resultCount();
			await t.page.click("#results-more-btn");
			const afterMore = await resultCount();
			await ctx.close();

			if (process.env.DEBUG) console.log(`search: "gold"+Enter rows after ${enterMs} ms; "herb" ${nRows} rows`);
			expect(t.errors).toEqual([]);
			expect(debounced).toBe(1);
			expect(nRows).toBeGreaterThan(0);
			expect(nRows).toBeLessThanOrEqual(50);
			expect(first.title).toBeTruthy();
			expect(first.sub).toBeTruthy();
			expect([afterEnter, settledEnter]).toEqual([1, 1]);
			expect(enterMs).toBeLessThan(2000);
			expect([wildRows, afterMore]).toEqual([50, 100]);
		},
		T,
	);

	test(
		"4. marker toggles: category, hide-found, selected marker stays",
		async () => {
			if (!guard()) return;
			const ctx = await browser.createBrowserContext();
			const t = await track(ctx, { bypassSW: true });
			await t.page.goto(mapUrl(GAME, MAP), { waitUntil: "domcontentloaded" });
			await ready(t.page);
			await sleep(1500);
			const s0 = await shown(t.page);
			const [cat] = topCategory(s0.vis)[0]!;

			// a. category off, then on
			await t.page.evaluate((c) => document.getElementById("cat-" + c)!.click(), cat);
			await sleep(700);
			const s1 = await shown(t.page);
			await t.page.evaluate((c) => document.getElementById("cat-" + c)!.click(), cat);
			await sleep(700);
			const s2 = await shown(t.page);
			expect(s0.vis.length).toBeGreaterThan(0);
			expect(s1.vis.length).toBeLessThan(s0.vis.length);
			expect(s1.vis.filter((p: any) => p.cat === cat).length).toBe(0);
			expect(s2.vis.length).toBe(s0.vis.length);

			// b. hide-found: mark a visible marker found, close the card, hide found ones
			const target = s2.vis.find((p: any) => p.cat !== cat) ?? s2.vis[0];
			await t.page.goto(mapUrl(GAME, MAP, `&loc=${target.id}`), { waitUntil: "domcontentloaded" });
			await t.page.waitForSelector("body.detail-open .found-btn", { timeout: 60000 });
			await t.page.click(".found-btn");
			await sleep(500);
			await t.page.click("#detail-close");
			await ready(t.page);
			// closing the card sends the camera back to where it was: the marker is brought into view again
			await t.page.evaluate((xy) => (window as any).__map.jumpTo({ center: xy, zoom: 14 }), target.xy);
			await sleep(1500);
			const beforeHide = await shown(t.page);
			await t.page.click("#hide-found");
			await sleep(700);
			const afterHide = await shown(t.page);
			await t.page.click("#hide-found"); // off again
			expect(beforeHide.vis.some((p: any) => p.id === target.id && p.f === 1)).toBe(true);
			expect(afterHide.all.some((p: any) => p.id === target.id && p.f === 1)).toBe(true);
			expect(afterHide.vis.filter((p: any) => p.f === 1).length).toBe(0);
			expect(afterHide.vis.some((p: any) => p.id === target.id)).toBe(false);

			// c. a selected marker stays visible when its category is hidden
			const sel = beforeHide.vis.find((p: any) => p.id !== target.id)!;
			await t.page.goto(mapUrl(GAME, MAP, `&loc=${sel.id}`), { waitUntil: "domcontentloaded" });
			await t.page.waitForSelector("body.detail-open #detail .d-title", { timeout: 60000 });
			await ready(t.page);
			await sleep(2500);
			const cBefore = await shown(t.page);
			const sameCat = cBefore.vis.filter((p: any) => p.cat === sel.cat).length;
			await t.page.evaluate((c) => document.getElementById("cat-" + c)!.click(), sel.cat);
			await sleep(800);
			const cAfter = await shown(t.page);
			const catLeft = cAfter.vis.filter((p: any) => p.cat === sel.cat).length;
			await ctx.close();
			expect(cAfter.vis.some((p: any) => p.id === sel.id)).toBe(true);
			expect(catLeft).toBeLessThan(Math.max(sameCat, 2)); // only the selected one is left of its category
			expect(t.errors).toEqual([]);
		},
		T,
	);

	test(
		"5. All maps search on world-of-warcraft fetches compact data only, once",
		async () => {
			if (!guard()) return;
			const ctx = await browser.createBrowserContext();
			const t = await track(ctx, { bypassSW: true });
			await t.page.goto(mapUrl(GAME, MAP), { waitUntil: "domcontentloaded" });
			await ready(t.page);
			await sleep(1000);
			const before = t.urls.length;
			await t.page.$eval('#scope-switch [data-scope="all"]', (el) => (el as HTMLElement).click());
			await t.page.click("#search");
			const t0 = Date.now();
			await t.page.keyboard.type("herb", { delay: 40 });
			await t.page.waitForFunction(
				() => /\d+ results?/.test(document.querySelector("#results-bar .r-count")?.textContent || ""),
				{ timeout: 120000 },
			);
			const firstMs = Date.now() - t0;
			await sleep(500);
			for (let i = 0; i < 6; i++) await t.page.click("#results-more-btn").catch(() => {}); // this map's matches come first
			const subs = await t.page.$$eval("#results li.result .r-sub", (l) => l.map((e) => e.textContent || ""));
			const otherMaps = new Set(subs.map((s) => s.split(" · ")[1]).filter(Boolean));
			const mid = t.urls.length;
			// a second query: nothing may be fetched again
			await t.page.click("#search");
			await t.page.keyboard.press("End");
			await t.page.keyboard.press("Backspace");
			await t.page.keyboard.type("b", { delay: 0 });
			await sleep(1200);
			const newData = (a: number, b: number) => the(t.urls.slice(a, b), dataRe).map(tail);
			const first = newData(before, mid),
				second = newData(mid, t.urls.length);
			await ctx.close();
			const n = (f: string[], end: string) => f.filter((x) => x.endsWith(end)).length;
			if (process.env.DEBUG)
				console.log(`All maps "herb": ${firstMs} ms to the count; compact x${n(first, ".compact.json")}`);
			expect(n(first, ".compact.json")).toBeGreaterThan(1);
			expect(n(first, "/data.json")).toBe(0); // never the full data of every map
			expect(second).toEqual([]);
			expect(subs.length).toBeGreaterThan(0);
			expect(otherMaps.size).toBeGreaterThan(0);
			expect(t.errors).toEqual([]);
		},
		T,
	);

	test(
		"6. offline: reload from the Service Worker serves the shell and the detail card",
		async () => {
			if (!guard()) return;
			const offline = await spawnServer();
			try {
				const ctx = await browser.createBrowserContext();
				const t = await track(ctx); // service worker on
				const url = `${offline.base}/maps/${GAME}/?map=${MAP}&loc=${ek.id}`;
				await t.page.goto(url, { waitUntil: "domcontentloaded" });
				await t.page.waitForSelector("body.detail-open #detail .d-desc", { timeout: 60000 });
				await ready(t.page);
				await t.page.evaluate(() => navigator.serviceWorker.ready.then(() => 0));
				// a second visit under the SW's control, so the map files pass through it and are cached
				await t.page.goto(url, { waitUntil: "domcontentloaded" });
				await t.page.waitForSelector("body.detail-open #detail .d-desc", { timeout: 60000 });
				await sleep(3000);
				const controlled = await t.page.evaluate(() => !!navigator.serviceWorker.controller);
				// the server is gone, and the browser offline as well
				offline.proc.kill(9);
				await sleep(500);
				await t.page.setOfflineMode(true);
				const f0 = t.failed.length,
					e0 = t.errors.length;
				await t.page.reload({ waitUntil: "domcontentloaded" });
				await t.page.waitForSelector("#map canvas", { timeout: 15000 });
				await t.page.waitForSelector("body.detail-open #detail .d-title", { timeout: 20000 });
				await sleep(1500);
				const card = await t.page.$eval("#detail-body .d-desc", (e) => e.textContent?.trim() || "");
				const title = await t.page.title();
				const newFail = t.failed.slice(f0).filter((f) => !f.includes("/tiles/"));
				const newErr = t.errors.slice(e0);
				await ctx.close();
				expect(controlled).toBe(true);
				expect(title.length).toBeGreaterThan(0);
				expect(card.length).toBeGreaterThan(20);
				// the account check (/api/me) is the only thing that may fail offline; no console error besides it
				expect(newFail.filter((f) => !f.includes("/api/"))).toEqual([]);
				expect(
					newErr.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|\/api\//.test(e)),
				).toEqual([]);
			} finally {
				offline.proc.kill(9);
			}
		},
		T,
	);

	test(
		"7. homepage: poster requests bounded by the viewport, no mass prefetch",
		async () => {
			if (!guard()) return;
			const ctx = await browser.createBrowserContext();
			const t = await track(ctx); // service worker on: a prefetch message would show in its own fetches
			const swUrls: string[] = [];
			const onTarget = async (tg: any) => {
				if (tg.type() !== "service_worker") return;
				try {
					const cdp = await tg.createCDPSession();
					await cdp.send("Network.enable");
					cdp.on("Network.requestWillBeSent", (e: any) => swUrls.push(e.request.url));
				} catch {}
			};
			browser.on("targetcreated", onTarget);
			await t.page.goto(`${server.base}/`, { waitUntil: "networkidle2" });
			await t.page.waitForSelector(".card", { timeout: 20000 });
			await sleep(5000);
			browser.off("targetcreated", onTarget);
			const cards = await t.page.$$eval(".card-li", (l) => l.length);
			const within3 = await t.page.$$eval(
				".card-li",
				(l) => l.filter((e) => e.getBoundingClientRect().top < innerHeight * 4).length,
			);
			const isPoster = (u: string) => /\/maps\/[^/]+\/poster[^/]*\.(webp|jpe?g|png|avif)$/.test(u);
			const page = new Set(the(t.urls, /poster/).filter(isPoster));
			const sw = new Set(swUrls.filter(isPoster));
			await ctx.close();
			if (process.env.DEBUG)
				console.log(`homepage: ${cards} cards, ${within3} within 4 viewports, ${page.size} posters fetched`);
			expect(cards).toBeGreaterThan(within3); // otherwise the bound below says nothing
			expect(page.size).toBeLessThanOrEqual(within3 + 2); // lazy: what is near the viewport, not every card
			// the SW's own fetches are the page's requests passing through it: a prefetch would add posters the page never asked for
			expect([...sw].filter((u) => !page.has(u))).toEqual([]);
		},
		T,
	);

	// Mean ms per call at 4x CPU throttle, Chromium headless with software GL, one dev machine (+-15% between runs):
	// prepareMap 380 (1 call), runSearch 590 (max 660), refreshMap 9 (max 49), updateSidebar 5 (max 18),
	// saveProfileNow 70 (max 164). The limits are 3-6x the means (the tiny ones jitter most on a shared runner); a run on
	// a machine busy with other work measured runSearch 1327, saveProfileNow 272, refreshMap 18 and passed. They catch
	// an order-of-magnitude regression, not a drift.
	const LIMITS: Record<string, number> = {
		prepareMap: 1500,
		runSearch: 2400,
		refreshMap: 50,
		updateSidebar: 25,
		saveProfileNow: 350,
	};
	test.serial(
		"8. perf baseline: ?perf=1, CPU 4x throttled",
		async () => {
			if (!guard()) return;
			const ctx = await browser.createBrowserContext();
			const t = await track(ctx, { bypassSW: true });
			const cdp = await t.page.createCDPSession();
			await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
			await t.page.goto(mapUrl(GAME, MAP), { waitUntil: "domcontentloaded" });
			await ready(t.page);
			await sleep(2000);
			// search, leave, toggle categories, search again, open a result, mark found
			await t.page.click("#search");
			await t.page.keyboard.type("herb", { delay: 60 });
			await t.page.waitForFunction(() => document.querySelectorAll("#results li.result").length > 0, {
				timeout: 30000,
			});
			await sleep(800);
			await t.page.keyboard.press("Escape");
			await sleep(500);
			const cats = topCategory((await shown(t.page)).vis, 3).map((c) => c[0]);
			for (let i = 0; i < 2; i++)
				for (const c of cats) {
					await t.page.evaluate((id) => document.getElementById("cat-" + id)!.click(), c);
					await sleep(400);
				}
			await t.page.click("#search");
			await t.page.keyboard.type("gold", { delay: 60 });
			await t.page.waitForFunction(() => document.querySelectorAll("#results li.result").length > 0, {
				timeout: 30000,
			});
			await t.page.keyboard.press("Enter");
			await t.page.waitForSelector("body.detail-open .found-btn", { timeout: 30000 });
			await t.page.click(".found-btn");
			await sleep(3500); // the save debounce
			await t.page.evaluate(() => (window as any).perfReport());
			for (let i = 0; i < 20 && !t.tables.length; i++) await sleep(250);
			await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
			await ctx.close();
			const table = t.tables[0] as Record<string, { count: number; meanMs: number; maxMs: number }>;
			if (process.env.DEBUG)
				console.log("perfReport() at 4x CPU throttle (limit = mean ms):\n" + JSON.stringify(table, null, 1));
			expect(t.errors).toEqual([]);
			expect(Object.keys(table)).toEqual(expect.arrayContaining(Object.keys(LIMITS)));
			expect(table.prepareMap!.count).toBe(1);
			expect(table.runSearch!.count).toBeGreaterThanOrEqual(2);
			for (const [name, limit] of Object.entries(LIMITS))
				expect({ name, meanMs: table[name]!.meanMs <= limit ? "ok" : table[name]!.meanMs, limit }).toEqual({
					name,
					meanMs: "ok",
					limit,
				});
		},
		T,
	);

	test(
		"6. found toggle, toast undo, and Recently found in stats dialog",
		async () => {
			if (!guard()) return;
			const ctx = await browser.createBrowserContext();
			const t = await track(ctx, { bypassSW: true });
			await t.page.goto(mapUrl(GAME, MAP, `&loc=${ek.id}`), { waitUntil: "domcontentloaded" });
			await t.page.waitForSelector("body.detail-open .found-btn", { timeout: 60000 });
			await ready(t.page);

			// Mark found -> toast with Undo appears
			await t.page.click(".found-btn");
			await t.page.waitForSelector("#toast:not([hidden]) .toast-action", { timeout: 5000 });
			expect(await t.page.$eval("#toast", (e) => e.textContent || "")).toContain("Marked as found");
			expect(await t.page.$eval(".found-btn", (e) => e.getAttribute("aria-pressed"))).toBe("true");

			// Click Undo -> reverts found state
			await t.page.click("#toast .toast-action");
			await t.page.waitForFunction(
				() => document.querySelector(".found-btn")?.getAttribute("aria-pressed") === "false",
				{ timeout: 5000 },
			);

			// Mark found again -> open Progress & stats -> verify Recently found lists the marker
			await t.page.click(".found-btn");
			await t.page.waitForSelector("#toast:not([hidden]) .toast-action", { timeout: 5000 });
			await t.page.evaluate(() => document.getElementById("side-stats-btn")?.click());
			await t.page.waitForSelector("dialog.stats-dlg[open] .sd-recent-row", { timeout: 10000 });
			const recentText = await t.page.$eval(".sd-recent", (e) => e.textContent || "");
			expect(recentText.length).toBeGreaterThan(0);

			// Mark not found from Recently found -> Undo restores it
			await t.page.click(".sd-recent-row .sd-unfind");
			await t.page.waitForFunction(() => document.querySelectorAll(".sd-recent-row").length === 0, {
				timeout: 5000,
			});

			await ctx.close();
			expect({ errors: t.errors, failed: t.failed }).toEqual({ errors: [], failed: [] });
		},
		T,
	);

	test(
		"9. guides follow mode: lazy load, 2000-step panel perf, follow/undo, out-of-order tick, route layer & resume card",
		async () => {
			if (!guard()) return;
			const dir = mkdtempSync(path.join(tmpdir(), "va-e2e-guide-"));
			try {
				const hkData = JSON.parse(readFileSync(`public/maps/${CONTROL_GAME}/${CONTROL_MAP}/data.json`, "utf8"));
				const locs: any[] = hkData.locations.slice(0, 4);
				const sections: any[] = [];
				let stepCounter = 0;
				const stepsPerSec = 100;
				for (let s = 0; s < 20; s++) {
					const steps: any[] = [];
					for (let j = 0; j < stepsPerSec; j++) {
						stepCounter++;
						const id = `st-${stepCounter}`;
						if (stepCounter === 1) {
							steps.push({
								id,
								kind: "task",
								title: "Check Starting Marker A",
								notes: "Bound step with consequence and reward.",
								consequence: "Will lock if missed later.",
								reward: "Charm Notch",
								targets: [{ kind: "marker", marker: locs[0].id }],
							});
						} else if (stepCounter === 2) {
							steps.push({
								id,
								kind: "task",
								title: "Manual Step Two",
								place: "Dirtmouth",
								thread: "main",
							});
						} else if (stepCounter === 3) {
							steps.push({
								id,
								kind: "task",
								title: "Out of Order Target C",
								targets: [{ kind: "marker", marker: locs[1].id }],
								only: { mode: ["standard"] },
							});
						} else if (stepCounter === 4) {
							steps.push({
								id,
								kind: "waypoint",
								title: "Scenic Overlook",
								targets: [
									{
										kind: "point",
										point: {
											lat: Number(locs[2].latitude),
											lng: Number(locs[2].longitude),
											map: CONTROL_MAP,
										},
										label: "Overlook",
									},
								],
							});
						} else {
							steps.push({
								id,
								kind: "task",
								title: `Filler Step ${stepCounter}`,
							});
						}
					}
					sections.push({ id: `sec-${s + 1}`, title: `Chapter ${s + 1}`, steps });
				}

				const guideObj = {
					v: 1,
					id: "e2e-2k-route",
					game: CONTROL_GAME,
					title: "2000-Step Hallownest Route",
					author: "E2E Suite",
					variants: [
						{
							id: "mode",
							label: "Mode",
							options: [
								{ id: "standard", label: "Standard" },
								{ id: "speed", label: "Speedrun" },
							],
							default: "standard",
						},
					],
					sections,
					created: 1760000000000,
					updated: 1760000000000,
				};
				const guidePath = path.join(dir, "guide-2k.json");
				writeFileSync(guidePath, JSON.stringify(guideObj));

				const ctx = await browser.createBrowserContext();
				const t = await track(ctx, { bypassSW: true });
				await t.page.goto(mapUrl(CONTROL_GAME, CONTROL_MAP), { waitUntil: "domcontentloaded" });
				await ready(t.page);
				await sleep(600);

				// 1. Before any guide exists, guide-follow.js was NEVER requested
				expect(t.urls.some((u) => u.includes("guide-follow.js"))).toBe(false);
				expect(await t.page.$eval("#guides-section", (el) => (el as HTMLElement).hidden)).toBe(true);

				// 2. Import the 2,000-step fixture through #import-guide-file
				const fileInput = (await t.page.$("input#import-guide-file"))!;
				await fileInput.uploadFile(guidePath);
				await t.page.waitForFunction(() => !document.getElementById("guides-section")?.hasAttribute("hidden"), {
					timeout: 15000,
				});

				// Verify lazy chunk loaded on demand and guide row shows 0/1,999 (1999 tasks + 1 waypoint)
				expect(t.urls.some((u) => u.includes("guide-follow.js"))).toBe(true);
				const rowText = await t.page.$eval("#guides-section .guide-row", (el) => el.textContent || "");
				expect(rowText).toContain("2000-Step Hallownest Route");
				expect(rowText).toContain("0/1,999");

				// 3. Open guide panel with ?perf=1 and verify fast open + virtualized DOM window
				const openT0 = performance.now();
				await t.page.click('#guides-section .guide-row[data-guide-open="e2e-2k-route"]');
				await t.page.waitForSelector("body.guide-open #guide-panel:not([hidden]) .gp-step", { timeout: 10000 });
				const openWallMs = performance.now() - openT0;
				const renderedRows = await t.page.$$eval("#gp-step-list .gp-step", (els) => els.length);
				expect(renderedRows).toBeGreaterThan(10);
				expect(renderedRows).toBeLessThan(250); // virtual windowing skips rendering all 2000 nodes at once!

				// Scroll smoothly partway through the 2,000-step panel and back up
				await t.page.evaluate(() => {
					const sc = document.querySelector("#side .side-scroll") as HTMLElement;
					sc.scrollTop = 25000;
					sc.dispatchEvent(new Event("scroll"));
				});
				await sleep(150);
				const scrolledNums = await t.page.$$eval("#gp-step-list .gp-step-num", (els) =>
					els.map((e) => e.textContent || ""),
				);
				expect(scrolledNums.some((s) => Number(s.slice(1)) > 200)).toBe(true);
				await t.page.evaluate(() => {
					const sc = document.querySelector("#side .side-scroll") as HTMLElement;
					sc.scrollTop = 0;
					sc.dispatchEvent(new Event("scroll"));
				});
				await sleep(150);

				// 4. Open Step 1 card & check MapLibre route window layers exist
				await t.page.waitForSelector('.gp-step[data-step-id="st-1"] [data-gp-open-step]', { timeout: 5000 });
				await t.page.click('.gp-step[data-step-id="st-1"] [data-gp-open-step]');
				await t.page.waitForSelector("body.detail-open .gs-done-btn", { timeout: 5000 });
				await sleep(300);
				const routeStats = await t.page.evaluate(() => {
					const m = (window as any).__map;
					return {
						hasPinLayer: Boolean(m.getLayer("guide-route-pins")),
						hasLineLayer: Boolean(m.getLayer("guide-route-prev") && m.getLayer("guide-route-next")),
						pins: m.querySourceFeatures("guide-route-pins").length,
						lines: m.querySourceFeatures("guide-route-lines").length,
					};
				});
				expect(routeStats.hasPinLayer).toBe(true);
				expect(routeStats.hasLineLayer).toBe(true);
				expect(routeStats.pins).toBeGreaterThan(0);

				// 5. Mark Step 1 as done (binds marker locs[0].id) -> auto-advances to Step 2
				await t.page.click(".gs-done-btn");
				await t.page.waitForSelector("#toast:not([hidden]) .toast-action", { timeout: 5000 });
				await t.page.waitForFunction(
					() =>
						document.querySelector(".gp-nav-cur")?.textContent?.includes("Step 2") &&
						document.querySelector('.gp-step[data-step-id="st-1"]')?.classList.contains("is-done"),
					{ timeout: 5000 },
				);

				// 6. Undo -> reverts BOTH Step 1 and its bound marker locs[0].id, returning cursor to Step 1
				await t.page.click("#toast .toast-action");
				await t.page.waitForFunction(
					() =>
						document.querySelector(".gp-nav-cur")?.textContent?.includes("Step 1") &&
						!document.querySelector('.gp-step[data-step-id="st-1"]')?.classList.contains("is-done"),
					{ timeout: 5000 },
				);

				// 7. Out-of-order marker tick on map for Step 3 (`locs[1].id`): updates Step 3 live, NEVER moves cursor off Step 1
				await t.page.click("#detail-close");
				await t.page.goto(mapUrl(CONTROL_GAME, CONTROL_MAP, `&loc=${locs[1].id}`), {
					waitUntil: "domcontentloaded",
				});
				await t.page.waitForSelector("body.detail-open .d-guide-link", { timeout: 30000 });
				const backlinkText = await t.page.$eval(".d-guide-link", (el) => el.textContent || "");
				expect(backlinkText).toContain("Step 3 in 2000-Step Hallownest Route");
				await t.page.click(".found-btn");
				await sleep(400);
				await t.page.click("#detail-close");
				await t.page.click('#guides-section .guide-row[data-guide-open="e2e-2k-route"]');
				await t.page.waitForSelector("body.guide-open #guide-panel:not([hidden])", { timeout: 5000 });
				const cursorTextAfterOOO = await t.page.$eval(".gp-nav-cur", (el) => el.textContent || "");
				expect(cursorTextAfterOOO).toContain("Step 1 of 2000");

				// 8. Complete Step 1 and advance using "Mark done & next ->" then "]" shortcut
				await t.page.click('.gp-step[data-step-id="st-1"] [data-gp-open-step]');
				await t.page.waitForSelector('.gs-btn[data-gs-act="done-and-next"]', { timeout: 5000 });
				await t.page.click('.gs-btn[data-gs-act="done-and-next"]');
				await t.page.waitForFunction(
					() => document.querySelector("#detail .d-title")?.textContent === "Manual Step Two",
					{ timeout: 5000 },
				);
				// Force saveSession immediately by waiting past 450ms debounce
				await sleep(600);

				// Check perfReport output for follow hot paths
				await t.page.evaluate(() => (window as any).perfReport());
				for (let i = 0; i < 15 && !t.tables.length; i++) await sleep(200);
				const perfTable = t.tables[0] || {};
				if (process.env.DEBUG) {
					console.log("M3 2,000-step guide open wall ms:", Math.round(openWallMs), "perfReport:", perfTable);
				}
				if (perfTable.deriveGuideView) expect(perfTable.deriveGuideView.meanMs).toBeLessThan(150);
				if (perfTable.openGuidePanel) expect(perfTable.openGuidePanel.meanMs).toBeLessThan(500);

				// 9. Navigate to homepage and check Resume card reflects the followed guide!
				await t.page.goto(`${server.base}/`, { waitUntil: "domcontentloaded" });
				await t.page.waitForSelector("#resume:not([hidden]) .resume-guide", { timeout: 20000 });
				const resumeGuideText = await t.page.$eval("#resume .resume-guide", (el) => el.textContent || "");
				expect(resumeGuideText).toContain("2000-Step Hallownest Route");
				expect(resumeGuideText).toContain("2 / 1,999");
				expect(resumeGuideText).toContain("Next: Manual Step Two");

				await ctx.close();
				expect({ errors: t.errors, failed: t.failed }).toEqual({ errors: [], failed: [] });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		T,
	);

	test(
		"10. guides follow mode works offline via Service Worker",
		async () => {
			if (!guard()) return;
			const dir = mkdtempSync(path.join(tmpdir(), "va-e2e-guide-sw-"));
			const offline = await spawnServer();
			try {
				const hkData = JSON.parse(readFileSync(`public/maps/${CONTROL_GAME}/${CONTROL_MAP}/data.json`, "utf8"));
				const firstLoc = hkData.locations[0];
				const guideObj = {
					v: 1,
					id: "offline-guide-sw",
					game: CONTROL_GAME,
					title: "Offline Precache Route",
					sections: [
						{
							id: "sec-1",
							title: "Start",
							steps: [
								{
									id: "st-1",
									kind: "task",
									title: "Offline Step One",
									targets: [{ kind: "marker", marker: firstLoc.id }],
								},
							],
						},
					],
					created: 1760000000000,
					updated: 1760000000000,
				};
				const guidePath = path.join(dir, "offline-guide.json");
				writeFileSync(guidePath, JSON.stringify(guideObj));

				const ctx = await browser.createBrowserContext();
				const t = await track(ctx); // Service Worker enabled
				const url = `${offline.base}/maps/${CONTROL_GAME}/?map=${CONTROL_MAP}`;
				await t.page.goto(url, { waitUntil: "domcontentloaded" });
				await ready(t.page);
				await t.page.evaluate(() => navigator.serviceWorker.ready.then(() => 0));
				// Second visit ensures SW controls the page and caches map data; install already precached guide-follow.js
				await t.page.goto(url, { waitUntil: "domcontentloaded" });
				await ready(t.page);
				await sleep(1000);

				const fileInput = (await t.page.$("input#import-guide-file"))!;
				await fileInput.uploadFile(guidePath);
				await t.page.waitForFunction(() => !document.getElementById("guides-section")?.hasAttribute("hidden"), {
					timeout: 10000,
				});

				// Go completely offline & shut down server
				offline.proc.kill(9);
				await sleep(400);
				await t.page.setOfflineMode(true);
				const f0 = t.failed.length,
					e0 = t.errors.length;

				await t.page.reload({ waitUntil: "domcontentloaded" });
				await ready(t.page);
				await t.page.waitForFunction(() => !document.getElementById("guides-section")?.hasAttribute("hidden"), {
					timeout: 15000,
				});
				await t.page.click('#guides-section .guide-row[data-guide-open="offline-guide-sw"]');
				await t.page.waitForSelector('body.guide-open .gp-step[data-step-id="st-1"]', { timeout: 10000 });
				const offlineStepTitle = await t.page.$eval('.gp-step[data-step-id="st-1"] .gp-step-title', (el) =>
					el.textContent?.trim(),
				);
				const newFail = t.failed.slice(f0).filter((f) => !f.includes("/tiles/") && !f.includes("/api/"));
				const newErr = t.errors
					.slice(e0)
					.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|\/api\//.test(e));
				await ctx.close();
				expect(offlineStepTitle).toBe("Offline Step One");
				expect(newFail).toEqual([]);
				expect(newErr).toEqual([]);
			} finally {
				offline.proc.kill(9);
				rmSync(dir, { recursive: true, force: true });
			}
		},
		T,
	);

	test(
		"11. guide editor reorders a 600-step guide smoothly by touch drag and keyboard Alt+Up/Alt+Down",
		async () => {
			if (!guard()) return;
			const dir = mkdtempSync(path.join(tmpdir(), "va-e2e-guide-600-"));
			try {
				const steps1 = Array.from({ length: 300 }, (_, i) => ({
					id: `st-a-${i}`,
					kind: "task",
					title: `First Half ${i + 1}`,
				}));
				const steps2 = Array.from({ length: 300 }, (_, i) => ({
					id: `st-b-${i}`,
					kind: "task",
					title: `Second Half ${i + 1}`,
				}));
				const gObj = {
					v: 1,
					id: "e2e-600-reorder",
					game: CONTROL_GAME,
					title: "600-Step Reorder Test",
					sections: [
						{ id: "sec-1", title: "Section One", steps: steps1 },
						{ id: "sec-2", title: "Section Two", steps: steps2 },
					],
					created: 1760000000000,
					updated: 1760000000000,
				};
				const guidePath = path.join(dir, "guide-600.json");
				writeFileSync(guidePath, JSON.stringify(gObj));

				const ctx = await browser.createBrowserContext();
				const t = await track(ctx);
				// Phone viewport with touch enabled to verify touch drag reordering early
				await t.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
				await t.page.goto(mapUrl(CONTROL_GAME, CONTROL_MAP, "&perf=1"), { waitUntil: "domcontentloaded" });
				await ready(t.page);

				const fileInput = (await t.page.$("input#import-guide-file"))!;
				await fileInput.uploadFile(guidePath);
				await t.page.waitForFunction(() => !document.getElementById("guides-section")?.hasAttribute("hidden"), {
					timeout: 15000,
				});

				// Open sidebar drawer on mobile & wait for drawer slide-in transition before clicking menu
				await t.page.click("#side-toggle");
				await t.page.waitForFunction(
					() => {
						const el = document.querySelector('[data-guide-menu="e2e-600-reorder"]');
						return !!el && el.getBoundingClientRect().right > 16;
					},
					{ timeout: 5000 },
				);
				await t.page.click('[data-guide-menu="e2e-600-reorder"]');
				await t.page.waitForSelector('#guide-row-menu button[data-gm-act="edit"]', { timeout: 5000 });
				await t.page.click('#guide-row-menu button[data-gm-act="edit"]');
				await t.page.waitForSelector('body.guide-editing .ge-step-row[data-ge-step="st-a-0"]', {
					timeout: 15000,
				});

				// Ensure first rows of sec-1 are scrolled into viewport before touch drag
				await t.page.$eval('.ge-step-row[data-ge-step="st-a-0"]', (el) =>
					el.scrollIntoView({ block: "center" }),
				);
				await sleep(100);

				// 1. Touch drag st-a-0 down below st-a-2
				const dragStartBox = (await t.page.$eval('.ge-step-row[data-ge-step="st-a-0"] .ge-drag', (el) => {
					const r = el.getBoundingClientRect();
					return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
				}))!;
				const dropTargetBox = (await t.page.$eval('.ge-step-row[data-ge-step="st-a-2"]', (el) => {
					const r = el.getBoundingClientRect();
					return { x: r.left + 20, y: r.bottom - 4 };
				}))!;

				expect(dragStartBox.y).toBeGreaterThan(0);
				expect(dropTargetBox.y).toBeLessThan(844);

				await t.page.touchscreen.touchStart(dragStartBox.x, dragStartBox.y);
				await t.page.touchscreen.touchMove(dragStartBox.x, dragStartBox.y + 8);
				await t.page.touchscreen.touchMove(dragStartBox.x, (dragStartBox.y + dropTargetBox.y) / 2);
				await t.page.touchscreen.touchMove(dragStartBox.x, dropTargetBox.y);
				await t.page.touchscreen.touchEnd();

				await t.page.waitForFunction(
					() => {
						const rows = [...document.querySelectorAll('#ge-outline .ge-step-row[data-ge-sec-id="sec-1"]')];
						return (
							rows
								.slice(0, 3)
								.map((r) => (r as HTMLElement).dataset.geStep)
								.join(",") === "st-a-1,st-a-2,st-a-0"
						);
					},
					{ timeout: 5000 },
				);

				// 2. Keyboard Alt+ArrowUp / Alt+ArrowDown on st-a-0
				await t.page.focus('.ge-step-row[data-ge-step="st-a-0"]');
				await t.page.keyboard.down("Alt");
				await t.page.keyboard.press("ArrowUp");
				await t.page.keyboard.up("Alt");

				await t.page.waitForFunction(
					() => {
						const rows = [...document.querySelectorAll('#ge-outline .ge-step-row[data-ge-sec-id="sec-1"]')];
						return (
							rows
								.slice(0, 3)
								.map((r) => (r as HTMLElement).dataset.geStep)
								.join(",") === "st-a-1,st-a-0,st-a-2"
						);
					},
					{ timeout: 5000 },
				);

				await t.page.keyboard.down("Alt");
				await t.page.keyboard.press("ArrowDown");
				await t.page.keyboard.up("Alt");

				await t.page.waitForFunction(
					() => {
						const rows = [...document.querySelectorAll('#ge-outline .ge-step-row[data-ge-sec-id="sec-1"]')];
						return (
							rows
								.slice(0, 3)
								.map((r) => (r as HTMLElement).dataset.geStep)
								.join(",") === "st-a-1,st-a-2,st-a-0"
						);
					},
					{ timeout: 5000 },
				);

				// 3. Verify step text fields keep focus across keystrokes & autosave
				await t.page.click('.ge-step-row[data-ge-step="st-a-0"] [data-ge-select-step]');
				await t.page.waitForSelector('#ge-step-form input[name="title"]', { timeout: 5000 });
				await t.page.waitForFunction(
					() => (document.getElementById("side")?.getBoundingClientRect().right ?? 0) <= 1,
					{ timeout: 5000 },
				);
				await t.page.click('#ge-step-form input[name="title"]', { count: 3 });
				await t.page.keyboard.type("Renamed Step Focus Check", { delay: 15 });
				const titleStillFocused = await t.page.evaluate(
					() => document.activeElement === document.querySelector('#ge-step-form input[name="title"]'),
				);
				expect(titleStillFocused).toBe(true);
				await t.page.click('#ge-step-form textarea[name="notes"]');
				await t.page.keyboard.type("Multi character note", { delay: 15 });
				await sleep(300); // wait past debounced save ("Saving..." -> "Saved") while still focused
				const notesStillFocused = await t.page.evaluate(
					() => document.activeElement === document.querySelector('#ge-step-form textarea[name="notes"]'),
				);
				expect(notesStillFocused).toBe(true);

				await t.page.click('[data-ge-step-act="open-outline"]');
				await t.page.waitForFunction(
					() => {
						const el = document.querySelector('.ge-step-row[data-ge-step="st-a-0"] .ge-step-title');
						return el?.textContent?.trim() === "Renamed Step Focus Check";
					},
					{ timeout: 5000 },
				);

				await t.page.$eval('[data-ge-act="save"]', (el) => el.scrollIntoView({ block: "center" }));
				await sleep(100);
				await t.page.click('[data-ge-act="save"]');
				await sleep(300);
				await ctx.close();
				expect({ errors: t.errors, failed: t.failed }).toEqual({ errors: [], failed: [] });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		T,
	);
});