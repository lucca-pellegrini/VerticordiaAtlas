// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Headless-browser check of the risky client changes of the performance roadmap (.plans/performance-roadmap.md).
// Starts the real server on a free port, drives Chromium with Puppeteer, prints a PASS/FAIL line per check with its
// evidence. Reads public/maps/ and never writes to it. Run: bun scripts/verify-browser.ts [--only 1,3] [--json]
// Needs /usr/bin/chromium (the same as tests/e2e-offline.test.ts) and the maps world-of-warcraft and hollow-knight.

import { readFileSync } from "node:fs";

import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer";

const GAME = "world-of-warcraft",
	MAP = "eastern-kingdoms",
	CONTROL_GAME = "hollow-knight",
	CONTROL_MAP = "hallownest";
const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",").map(Number)) : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- servers ---------- */

function freePort(): number {
	const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const p = s.port!;
	s.stop(true);
	return p;
}

// `bun run start` is `bun server/server.ts`; spawned directly so that kill() reaches the server itself
async function startServer(): Promise<{ base: string; proc: ReturnType<typeof Bun.spawn> }> {
	const port = freePort();
	const proc = Bun.spawn(["bun", "server/server.ts", "--no-tui", "--port", String(port)], {
		stdout: "ignore",
		stderr: "inherit",
	});
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 150; i++) {
		try {
			if ((await fetch(`${base}/`)).ok) return { base, proc };
		} catch {}
		await sleep(200);
	}
	proc.kill(9);
	throw new Error("server did not start on " + port);
}

/* ---------- page helpers ---------- */

interface Tracked {
	page: Page;
	errors: string[]; // console errors and page errors
	failed: string[]; // failed requests and HTTP >= 400
	aborted: string[]; // cancelled by the browser
	urls: string[]; // every response URL, in order
	perf: { name: string; ms: number; t: number }[]; // "[perf] name 1.2 ms" debug lines
	tables: any[]; // console.table payloads (perfReport)
}

// the maplibregl global is wrapped so the test can reach the map and count setData() calls
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

async function track(ctx: BrowserContext, opts: { bypassSW?: boolean } = {}): Promise<Tracked> {
	const page = await ctx.newPage();
	await page.setViewport({ width: 1280, height: 800 });
	if (opts.bypassSW) await page.setBypassServiceWorker(true);
	await page.evaluateOnNewDocument(HOOK);
	const t: Tracked = { page, errors: [], failed: [], aborted: [], urls: [], perf: [], tables: [] };
	page.on("console", (m) => {
		if (m.type() === "error") t.errors.push(m.text());
		if (m.type() === "debug") {
			const r = /^\[perf\] (\w+) ([\d.]+) ms$/.exec(m.text());
			if (r) t.perf.push({ name: r[1]!, ms: +r[2]!, t: Date.now() });
		}
		if (m.type() === "table")
			void m
				.args()[0]
				?.jsonValue()
				.then((v) => t.tables.push(v));
	});
	page.on("pageerror", (e: any) => t.errors.push("pageerror: " + (e?.message ?? e)));
	// ERR_ABORTED is the browser cancelling a request itself (a tile the camera moved past): counted apart
	page.on("requestfailed", (r) =>
		(r.failure()?.errorText === "net::ERR_ABORTED" ? t.aborted : t.failed).push(
			`${r.failure()?.errorText} ${r.url()}`,
		),
	);
	page.on("response", (r) => {
		t.urls.push(r.url());
		if (r.status() >= 400) t.failed.push(`HTTP ${r.status()} ${r.url()}`);
	});
	return t;
}

const mapUrl = (base: string, game: string, map: string, extra = "") =>
	`${base}/maps/${game}/?map=${map}&perf=1${extra}`;

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
const shown = async (page: Page) => {
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
};

// installs the setData counter on the marker sources' class; read with setDataCalls()
const countSetData = (page: Page) =>
	page.evaluate(() => {
		const m = (window as any).__map;
		const proto = Object.getPrototypeOf(m.getSource("locs"));
		if (proto.__counted) return;
		proto.__counted = true;
		const orig = proto.setData;
		(window as any).__setData = [];
		proto.setData = function (d: any, ...rest: any[]) {
			(window as any).__setData.push({ source: this.id, features: d?.features?.length ?? null });
			return orig.call(this, d, ...rest);
		};
	});
const setDataCalls = (page: Page): Promise<{ source: string; features: number | null }[]> =>
	page.evaluate(() => (window as any).__setData ?? []);
const resetSetData = (page: Page) => page.evaluate(() => ((window as any).__setData = []));

const the = (urls: string[], re: RegExp) => urls.filter((u) => re.test(u));
const tail = (u: string) => u.replace(/^https?:\/\/[^/]+/, "");

/* ---------- marker choice, from the files on disk ---------- */

// a location with a description that links another location of the same map: the detail card has a link graph
function pickLinked(file: string, kind: "details" | "data"): { id: number; title: string; link: number } {
	const j = JSON.parse(readFileSync(file, "utf8"));
	const rows: [number, string, string][] =
		kind === "details"
			? Object.entries<any>(j.d).map(([id, v]) => [+id, "", v[0] as string])
			: j.locations.map((l: any) => [l.id, l.title, l.description || ""]);
	const ids = new Set(rows.map((r) => r[0]));
	for (const [id, title, desc] of rows) {
		for (const m of desc.matchAll(/\(#loc=(\d+)\)/g))
			if (+m[1]! !== id && ids.has(+m[1]!)) return { id, title, link: +m[1]! };
	}
	throw new Error("no linked description in " + file);
}

/* ---------- checks ---------- */

type Row = { n: number; name: string; pass: boolean; evidence: string };
const rows: Row[] = [];
const notes: string[] = [];
const dataRe = /\/data\.(compact|details)?\.?json$/;

async function run(n: number, name: string, fn: () => Promise<{ pass: boolean; evidence: string }>) {
	if (only && !only.has(n)) return;
	const t0 = Date.now();
	let r: { pass: boolean; evidence: string };
	try {
		r = await fn();
	} catch (e: any) {
		r = { pass: false, evidence: "threw: " + (e?.stack ?? e) };
	}
	rows.push({ n, name, ...r });
	console.log(
		`\n[${r.pass ? "PASS" : "FAIL"}] ${n}. ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${r.evidence}`,
	);
}

const ek = pickLinked(`public/maps/${GAME}/${MAP}/data.details.json`, "details");
const hk = pickLinked(`public/maps/${CONTROL_GAME}/${CONTROL_MAP}/data.json`, "data");

const server = await startServer();
console.log(`server ${server.base}; EK marker ${JSON.stringify(ek)}; control marker ${JSON.stringify(hk)}`);
const browser: Browser = await puppeteer.launch({
	executablePath: "/usr/bin/chromium",
	headless: true,
	args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});
const B = server.base;
let offlineServer: Awaited<ReturnType<typeof startServer>> | null = null;

try {
	// 1 -------------------------------------------------------------------------------------------------------------
	await run(1, "eastern-kingdoms loads clean on the compact path", async () => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx, { bypassSW: true });
		await t.page.goto(mapUrl(B, GAME, MAP), { waitUntil: "domcontentloaded" });
		await ready(t.page);
		await sleep(1500);
		const files = the(t.urls, dataRe).map(tail);
		const marked = the(t.urls, /marked\.umd\.js/).length;
		const tiles = the(t.urls, /\/tiles\//).length;
		const compact = files.some((f) => f.endsWith("data.compact.json")),
			full = the(t.urls, new RegExp(`/${MAP}/data\\.json$`)).length;
		const pass = t.errors.length === 0 && t.failed.length === 0 && compact && full === 0;
		await ctx.close();
		return {
			pass,
			evidence:
				`data requests: ${JSON.stringify(files)}\nfull data.json of this map: ${full}; marked.umd.js: ${marked}; tile responses: ${tiles}\n` +
				`console errors: ${JSON.stringify(t.errors)}\nfailed requests: ${JSON.stringify(t.failed)}\n` +
				"(service worker bypassed; details are fetched lazily, so none expected on a bare load)",
		};
	});

	// 2 -------------------------------------------------------------------------------------------------------------
	const detailCheck = async (
		game: string,
		map: string,
		m: { id: number; title: string; link: number },
		bypass: (p: Page) => Promise<void>,
	) => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx, { bypassSW: true });
		await bypass(t.page);
		await t.page.goto(mapUrl(B, game, map, `&loc=${m.id}`), { waitUntil: "domcontentloaded" });
		await t.page.waitForSelector("body.detail-open #detail:not([hidden]) .d-title", { timeout: 60000 });
		const title = await t.page.$eval("#detail .d-title", (e) => e.textContent?.trim() || "");
		await t.page.waitForSelector("#detail-body .d-desc a[data-loc]", { timeout: 15000 }).catch(() => {});
		const desc = await t.page.$eval("#detail-body .d-desc", (e) => ({
			text: e.textContent?.trim() || "",
			links: e.querySelectorAll("a[data-loc]").length,
		}));
		const hasLink = await t.page.$(`#detail-body a[data-loc="${m.link}"]`);
		let hop = "no link";
		if (hasLink) {
			await hasLink.evaluate((el) => (el as HTMLElement).click());
			const want = String(m.link);
			await t.page.waitForFunction((id) => location.hash === `#loc=${id}`, { timeout: 10000 }, want);
			hop = `clicked link to ${m.link}; hash ${await t.page.evaluate(() => location.hash)}; title now "${await t.page.$eval("#detail .d-title", (e) => e.textContent?.trim())}"`;
		}
		const back = await t.page.$$eval("#detail-body a[data-loc]", (a) => a.length);
		const files = the(t.urls, dataRe).map(tail),
			marked = the(t.urls, /marked\.umd\.js/).length;
		await ctx.close();
		const pass =
			!!title &&
			desc.text.length > 20 &&
			desc.links > 0 &&
			!!hasLink &&
			hop.startsWith("clicked") &&
			t.errors.length === 0 &&
			t.failed.length === 0;
		return {
			pass,
			evidence:
				`  marker ${m.id} "${m.title}"; card title "${title}"; description ${desc.text.length} chars, ${desc.links} internal links in it, ${back} a[data-loc] in card after hop\n` +
				`  ${hop}\n  data requests: ${JSON.stringify(files)}; marked.umd.js requests: ${marked}\n  console errors: ${JSON.stringify(t.errors)}; failed: ${JSON.stringify(t.failed)}; aborted by the browser (tiles): ${t.aborted.length}`,
		};
	};
	await run(
		2,
		"detail card: description, link graph, no error (EK compact, then control without compact)",
		async () => {
			const a = await detailCheck(GAME, MAP, ek, async () => {});
			// control: the map's meta is served without "compact", so the client takes data.json (the fallback path)
			const b = await detailCheck(CONTROL_GAME, CONTROL_MAP, hk, async (p) => {
				await p.setRequestInterception(true);
				p.on("request", async (req) => {
					if (!req.url().endsWith(`/maps/${CONTROL_GAME}/meta.json`)) return void req.continue();
					const meta = await (await fetch(req.url())).json();
					for (const mp of meta.maps) delete mp.compact;
					req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(meta) });
				});
			});
			return {
				pass: a.pass && b.pass,
				evidence: `EK (compact + details):\n${a.evidence}\ncontrol (meta without compact):\n${b.evidence}`,
			};
		},
	);

	// 3 -------------------------------------------------------------------------------------------------------------
	await run(3, "search: one debounced run, Enter immediate, rows, Show more", async () => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx, { bypassSW: true });
		// the card opens first so the descriptions are loaded: otherwise a run repeats once when they arrive, by design
		await t.page.goto(mapUrl(B, GAME, MAP, `&loc=${ek.id}`), { waitUntil: "domcontentloaded" });
		await t.page.waitForSelector("body.detail-open #detail .d-title", { timeout: 60000 });
		await ready(t.page);
		await t.page.click("#detail-close");
		const runs = () => t.perf.filter((p) => p.name === "runSearch").length;
		const resultCount = () => t.page.$$eval("#results li.result", (l) => l.length);

		// a. 4 characters, 40 ms apart
		const r0 = runs();
		await t.page.click("#search");
		const typedAt = Date.now();
		await t.page.keyboard.type("herb", { delay: 40 });
		const typedEnd = Date.now();
		await t.page.waitForFunction(() => document.querySelectorAll("#results li.result").length > 0, {
			timeout: 10000,
		});
		const shownAfter = Date.now() - typedEnd;
		await sleep(800);
		const debounced = runs() - r0;
		const nRows = await resultCount();
		const bar = await t.page.$eval("#results-bar .r-count", (e) => e.textContent);
		const first = await t.page.$eval("#results li.result", (e) => ({
			title: e.querySelector(".r-title")?.textContent,
			sub: e.querySelector(".r-sub")?.textContent,
			ico: !!e.querySelector(".ico-wrap svg, .ico-wrap img, .ico-wrap *"),
		}));
		const more1 = !!(await t.page.$("#results-more-btn"));

		// b. Enter: typed with no delay, Enter at once: one run before the 140 ms timer could have fired
		await t.page.keyboard.press("Escape");
		await sleep(300);
		const r1 = runs();
		await t.page.click("#search");
		await t.page.keyboard.type("gold");
		await t.page.keyboard.press("Enter");
		const enterAt = Date.now();
		await t.page
			.waitForFunction(
				(n) =>
					(document.querySelector("#results-bar .r-count")?.textContent || "").length > 0 &&
					document.querySelectorAll("#results li.result").length > 0,
				{ timeout: 5000 },
				0,
			)
			.catch(() => {});
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
		const wildBar = await t.page.$eval("#results-bar .r-count", (e) => e.textContent);
		const moreBtn = await t.page.$eval("#results-more-btn", (e) => e.textContent).catch(() => null);
		await t.page.click("#results-more-btn");
		const afterMore = await resultCount();
		await ctx.close();

		const pass =
			debounced === 1 &&
			nRows > 0 &&
			nRows <= 50 &&
			!!first.title &&
			!!first.sub &&
			afterEnter === 1 &&
			settledEnter === 1 &&
			wildRows === 50 &&
			!!moreBtn &&
			afterMore === 100 &&
			t.errors.length === 0;
		return {
			pass,
			evidence:
				`a. "herb" typed 40 ms/key: runSearch runs ${debounced} (want 1); rows ${nRows} ("${bar}"); results visible ${shownAfter} ms after the last key (140 ms debounce incl.); ` +
				`Show more present for herb: ${more1}\n   first row: ${JSON.stringify(first)}\n` +
				`b. "gold"+Enter at once: runs ${afterEnter} right after (${enterMs} ms to rows), ${settledEnter} after 600 ms more (want 1, 1)\n` +
				`c. "*": ${wildRows} rows, bar "${wildBar}", button "${moreBtn}", after click ${afterMore} rows (want 50 -> 100)\n` +
				`   console errors: ${JSON.stringify(t.errors)} (typing started ${typedEnd - typedAt} ms long)`,
		};
	});

	// 4 -------------------------------------------------------------------------------------------------------------
	await run(4, "marker toggles: category, hide-found, selected marker stays", async () => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx, { bypassSW: true });
		await t.page.goto(mapUrl(B, GAME, MAP), { waitUntil: "domcontentloaded" });
		await ready(t.page);
		await countSetData(t.page);
		await t.page.evaluate(() => (window as any).__map.once("idle", () => {}));
		await sleep(1500);
		const s0 = await shown(t.page);
		const counts = new Map<number, number>();
		for (const p of s0.vis) counts.set(p.cat, (counts.get(p.cat) || 0) + 1);
		const [cat, catN] = [...counts].sort((a, b) => b[1] - a[1])[0]!;

		// a. category off, then on
		await resetSetData(t.page);
		const tg0 = Date.now();
		await t.page.evaluate((c) => document.getElementById("cat-" + c)!.click(), cat);
		await sleep(700);
		const s1 = await shown(t.page);
		const catAfter = s1.vis.filter((p: any) => p.cat === cat).length;
		const calls = await setDataCalls(t.page);
		await t.page.evaluate((c) => document.getElementById("cat-" + c)!.click(), cat);
		await sleep(700);
		const s2 = await shown(t.page);
		const a = s1.vis.length < s0.vis.length && catAfter === 0 && s2.vis.length === s0.vis.length;

		// b. hide-found: mark a visible marker found, close the card, hide found ones
		const target = s2.vis.find((p: any) => p.cat !== cat) ?? s2.vis[0];
		await t.page.goto(mapUrl(B, GAME, MAP, `&loc=${target.id}`), { waitUntil: "domcontentloaded" });
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
		const foundIn = (set: any[]) => set.filter((p: any) => p.f === 1).length;
		const b =
			beforeHide.vis.some((p: any) => p.id === target.id && p.f === 1) &&
			afterHide.all.some((p: any) => p.id === target.id && p.f === 1) &&
			foundIn(afterHide.vis) === 0;
		await t.page.click("#hide-found"); // off again

		// c. a selected marker stays visible when its category is hidden
		const sel = beforeHide.vis.find((p: any) => p.id !== target.id)!;
		await t.page.goto(mapUrl(B, GAME, MAP, `&loc=${sel.id}`), { waitUntil: "domcontentloaded" });
		await t.page.waitForSelector("body.detail-open #detail .d-title", { timeout: 60000 });
		await ready(t.page);
		await sleep(2500);
		const cBefore = await shown(t.page);
		const sameCat = cBefore.vis.filter((p: any) => p.cat === sel.cat).length;
		await t.page.evaluate((c) => document.getElementById("cat-" + c)!.click(), sel.cat);
		await sleep(800);
		const cAfter = await shown(t.page);
		const keep = cAfter.vis.some((p: any) => p.id === sel.id);
		const catLeft = cAfter.vis.filter((p: any) => p.cat === sel.cat).length;
		const c = (keep && catLeft < sameCat) || (keep && sameCat <= 1);
		await ctx.close();
		return {
			pass: a && b && c && t.errors.length === 0,
			evidence:
				`a. category ${cat}: visible ${s0.vis.length} (${catN} of it) -> ${s1.vis.length} (${catAfter} of it) -> back ${s2.vis.length}; setData calls during the toggle: ${JSON.stringify(calls)}; ${Date.now() - tg0} ms incl. waits\n` +
				`b. hide-found: marker ${target.id} marked found; visible ${beforeHide.vis.length} (${foundIn(beforeHide.vis)} found) -> ${afterHide.vis.length} (${foundIn(afterHide.vis)} found); marker gone: ${!afterHide.vis.some((p: any) => p.id === target.id)}\n` +
				`c. selected ${sel.id} (cat ${sel.cat}); markers of that cat in view ${sameCat} -> ${catLeft} after hiding it; selected still shown: ${keep}\n` +
				`   console errors: ${JSON.stringify(t.errors)}; (the visible sets are from querySourceFeatures with the layers' filters: the viewport's tiles only)`,
		};
	});

	// 5 -------------------------------------------------------------------------------------------------------------
	await run(5, "All maps search on world-of-warcraft", async () => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx, { bypassSW: true });
		await t.page.goto(mapUrl(B, GAME, MAP), { waitUntil: "domcontentloaded" });
		await ready(t.page);
		await sleep(1000);
		const before = t.urls.length;
		await t.page.click('#scope-switch [data-scope="all"]').catch(async () => {
			await t.page.evaluate(() =>
				(document.querySelector('#scope-switch [data-scope="all"]') as HTMLElement)?.click(),
			);
		});
		await t.page.click("#search");
		const t0 = Date.now();
		await t.page.keyboard.type("herb", { delay: 40 });
		await t.page.waitForFunction(
			() => /\d+ results?/.test(document.querySelector("#results-bar .r-count")?.textContent || ""),
			{ timeout: 120000 },
		);
		const firstMs = Date.now() - t0;
		await sleep(500);
		const bar1 = await t.page.$eval("#results-bar .r-count", (e) => e.textContent);
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
		const after = t.urls.length;
		const newData = (a: number, b: number) => the(t.urls.slice(a, b), dataRe).map(tail);
		const first = newData(before, mid),
			second = newData(mid, after);
		const compactN = first.filter((f) => f.endsWith("data.compact.json")).length,
			fullN = first.filter((f) => f.endsWith("/data.json")).length,
			detailsN = first.filter((f) => f.endsWith("data.details.json")).length;
		await ctx.close();
		return {
			pass:
				compactN > 1 &&
				fullN === 0 &&
				second.length === 0 &&
				subs.length > 0 &&
				otherMaps.size > 0 &&
				t.errors.length === 0,
			evidence:
				`first "herb" in All maps: ${firstMs} ms to the count; bar "${bar1}"; rows ${subs.length}, other maps in the rows: ${[...otherMaps].slice(0, 6).join(", ")}\n` +
				`requests during the first All maps search: data.compact.json ${compactN}, data.json (full) ${fullN}, data.details.json ${detailsN}\n` +
				`requests during the second query (herb -> herb): ${second.length} ${JSON.stringify(second)}\nconsole errors: ${JSON.stringify(t.errors)}\n` +
				"(retained memory is not measured here; the client holds the index only: mapData(info, false) keeps nothing)",
		};
	});

	// 6 -------------------------------------------------------------------------------------------------------------
	await run(6, "offline: reload from the Service Worker, detail card with description", async () => {
		offlineServer = await startServer();
		const OB = offlineServer.base;
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx); // service worker on
		const url = `${OB}/maps/${GAME}/?map=${MAP}&loc=${ek.id}`;
		await t.page.goto(url, { waitUntil: "domcontentloaded" });
		await t.page.waitForSelector("body.detail-open #detail .d-desc", { timeout: 60000 });
		await ready(t.page);
		await t.page.evaluate(() => navigator.serviceWorker.ready.then(() => 0));
		// a second visit under the SW's control, so the map files pass through it and are cached
		await t.page.goto(url, { waitUntil: "domcontentloaded" });
		await t.page.waitForSelector("body.detail-open #detail .d-desc", { timeout: 60000 });
		await sleep(3000);
		const controlled = await t.page.evaluate(() => !!navigator.serviceWorker.controller);
		const cached: string[] = await t.page.evaluate(async () => {
			const out: string[] = [];
			for (const n of await caches.keys())
				for (const r of await (await caches.open(n)).keys()) out.push(n + " " + new URL(r.url).pathname);
			return out;
		});
		// the server is gone, and the browser offline as well
		offlineServer.proc.kill(9);
		await sleep(500);
		await t.page.setOfflineMode(true);
		const e0 = t.errors.length,
			f0 = t.failed.length;
		await t.page.reload({ waitUntil: "domcontentloaded" });
		let shell = true,
			card = "";
		try {
			await t.page.waitForSelector("#map canvas", { timeout: 15000 });
			await t.page.waitForSelector("body.detail-open #detail .d-title", { timeout: 20000 });
			await sleep(1500);
			card = await t.page.$eval("#detail-body .d-desc", (e) => e.textContent?.trim() || "");
		} catch (e: any) {
			shell = false;
			card = "failed: " + e.message;
		}
		const title = await t.page.title();
		const newErr = t.errors.slice(e0),
			newFail = t.failed.slice(f0);
		const tileFails = newFail.filter((f) => f.includes("/tiles/")),
			otherFails = newFail.filter((f) => !f.includes("/tiles/"));
		await ctx.close();
		const data = cached.filter((c) => /data\.(compact|details)?\.?json|meta\.json|marked/.test(c));
		return {
			pass: controlled && shell && card.length > 20 && !card.startsWith("failed"),
			evidence:
				`service worker controlled the page: ${controlled}; title offline "${title}"\n` +
				`detail description after offline reload: ${card.length > 60 ? card.slice(0, 60) + "…" : card} (${card.length} chars)\n` +
				`offline reload: ${newErr.length} console errors (${newErr.slice(0, 3).join(" | ")}); failed requests: ${tileFails.length} tiles, ${otherFails.length} others ${JSON.stringify(otherFails.slice(0, 5))}\n` +
				`cache entries of interest: ${JSON.stringify(data)}`,
		};
	});

	// 7 -------------------------------------------------------------------------------------------------------------
	await run(7, "homepage: poster requests, no mass prefetch", async () => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx); // service worker on: a prefetch message would show in its own fetches
		const swUrls: string[] = [];
		browser.on("targetcreated", async (tg) => {
			if (tg.type() !== "service_worker") return;
			try {
				const cdp = await tg.createCDPSession();
				await cdp.send("Network.enable");
				cdp.on("Network.requestWillBeSent", (e: any) => swUrls.push(e.request.url));
			} catch {}
		});
		await t.page.goto(`${B}/`, { waitUntil: "networkidle2" });
		await t.page.waitForSelector(".card", { timeout: 20000 });
		await sleep(5000);
		const cards = await t.page.$$eval(".card-li", (l) => l.length);
		const geo = await t.page.$$eval(".card-li", (l) => {
			const vh = innerHeight;
			return {
				inView: l.filter((e) => e.getBoundingClientRect().top < vh).length,
				within3: l.filter((e) => e.getBoundingClientRect().top < vh * 4).length,
			};
		});
		const isPoster = (u: string) => /\/maps\/[^/]+\/poster[^/]*\.(webp|jpe?g|png|avif)$/.test(u);
		const page = new Set(the(t.urls, /poster/).filter(isPoster));
		const sw = new Set(swUrls.filter(isPoster));
		const loaded = await t.page.$$eval(".card img", (l) => ({
			total: l.length,
			complete: l.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)
				.length,
		}));
		await ctx.close();
		return {
			pass: page.size <= geo.within3 + 2 && sw.size === 0,
			evidence:
				`cards ${cards}; cards with top < 1 viewport ${geo.inView}; < 4 viewports ${geo.within3}\n` +
				`distinct poster URLs fetched by the page after load + 5 s idle (no scrolling): ${page.size}; by the Service Worker itself: ${sw.size}\n` +
				`images: ${loaded.complete} of ${loaded.total} decoded (the rest are lazy)\n` +
				"(only SW targets created after this page opened are observed; the SW was fresh in this new context, so its install was)",
		};
	});

	// 8 -------------------------------------------------------------------------------------------------------------
	await run(8, "perf baseline: ?perf=1, CPU 4x throttled", async () => {
		const ctx = await browser.createBrowserContext();
		const t = await track(ctx, { bypassSW: true });
		const cdp = await t.page.createCDPSession();
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
		await t.page.goto(mapUrl(B, GAME, MAP), { waitUntil: "domcontentloaded" });
		await ready(t.page);
		await sleep(2000);
		// search, Show more, leave, toggle categories, open a result, mark found
		await t.page.click("#search");
		await t.page.keyboard.type("herb", { delay: 60 });
		await t.page.waitForFunction(() => document.querySelectorAll("#results li.result").length > 0, {
			timeout: 30000,
		});
		await sleep(800);
		await t.page.keyboard.press("Escape");
		await sleep(500);
		const s = await shown(t.page);
		const counts = new Map<number, number>();
		for (const p of s.vis) counts.set(p.cat, (counts.get(p.cat) || 0) + 1);
		const cats = [...counts]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map((c) => c[0]);
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
		await sleep(500);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
		const table = t.tables[0] ?? null;
		// the same numbers from the per-call debug lines, as a cross-check of the table
		const by = new Map<string, number[]>();
		for (const p of t.perf) (by.get(p.name) ?? by.set(p.name, []).get(p.name)!).push(p.ms);
		const own = Object.fromEntries(
			[...by].map(([k, v]) => [
				k,
				{
					count: v.length,
					meanMs: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1),
					maxMs: Math.max(...v),
				},
			]),
		);
		await ctx.close();
		const need = ["prepareMap", "runSearch", "refreshMap", "updateSidebar", "saveProfileNow"];
		const pass = !!table && need.every((k) => table[k]);
		return {
			pass,
			evidence:
				`perfReport() table (4x CPU throttle, Chromium headless, software GL, this machine):\n${JSON.stringify(table, null, 1)}\n` +
				`cross-check from the "[perf] name ms" lines: ${JSON.stringify(own)}\nconsole errors: ${JSON.stringify(t.errors)}`,
		};
	});
} finally {
	await browser.close().catch(() => {});
	server.proc.kill(9);
	(offlineServer as typeof server | null)?.proc.kill(9); // the cast: TS does not see the assignment inside run()
}

console.log("\n=== SUMMARY ===");
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.n}. ${r.name}`);
if (notes.length) console.log(notes.join("\n"));
process.exit(rows.every((r) => r.pass) ? 0 : 1);