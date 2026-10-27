#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// make-screenshots.ts: the screenshots listed in public/manifest.webmanifest, taken from a running site in headless
// Chromium (driven over the DevTools protocol, so no npm dependency).
//
//   bun scripts/make-screenshots.ts [--base http://127.0.0.1:8072] [--out public/screenshots] [--only wide-3,narrow-1] [--no-tui]
//
// Chrome wants every screenshot of one form factor to have the same aspect ratio, between 320 and 3840 px, with the long
// side at most 2.3 times the short side. So there are two sets: "wide" (16:9, desktop) and "narrow" (9:16, phones).
// Both are rendered at a device pixel ratio that keeps them at 2400x1350 and 1080x1920 pixels.
//
// The site must be running at --base (or if no server is running at --base, one is spawned automatically).

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { createScreenshotDashboard, type ScreenshotDashboard } from "./tui/screenshot-dashboard.ts";

type Form = "wide" | "narrow";
type Shot = {
	name: string; // file name without extension, and the order in the manifest
	form: Form;
	path: string; // page to open, relative to --base
	settle?: string; // JS, evaluated until it returns true before the picture is taken
	prepare?: string; // JS run after the page settled (opens a panel, types a search, ...)
	typeText?: string; // text typed into the focused field after `prepare` (real key events, not a value assignment)
	caption?: string; // for the manifest notes only
};

const VIEWPORT: Record<Form, { width: number; height: number; scale: number; mobile: boolean }> = {
	wide: { width: 1600, height: 900, scale: 1.5, mobile: false }, // 2400 x 1350
	narrow: { width: 432, height: 768, scale: 2.5, mobile: true }, // 1080 x 1920
};

// the shots, in the order the manifest lists them. Wide ones show the desktop layout, narrow ones the phone layout.
// a map is ready when the loading states are gone and its throbber (#map::after) has faded out
const MAP_READY = `!document.body.classList.contains('loading-map') && !document.body.classList.contains('loading-side')
  && getComputedStyle(document.getElementById('map'), '::after').opacity === '0'`;
const CARD = `!!document.querySelector('#detail') && !document.getElementById('detail').hidden && ${MAP_READY}`;
const MAP = `document.querySelectorAll('#groups .cat-row').length > 0 && ${MAP_READY}`;
// the first group's three-dot menu, then its "List these markers": the wildcard search over the group's categories
const LIST_LOCATIONS = `(() => { document.querySelector('#groups .group-head .row-menu-btn').click();
  document.querySelector('#row-menu button[data-act="list"]').click(); })()`;
// the sidebar as a phone shows it: opened over the map, search focused
const OPEN_SEARCH = `(() => { document.getElementById('side-toggle').click(); document.getElementById('search').focus(); })()`;
// the same scenes at both form factors: a set of six, one per entry of the manifest's screenshots
const SCENES: {
	name: string;
	path: string;
	settle: string;
	prepare?: string;
	typeText?: string;
	caption: string;
	sidebar?: boolean;
}[] = [
	{
		name: "games",
		path: "/",
		settle: `document.querySelectorAll('#game-list .card').length > 3 && [...document.images].filter(i => i.getBoundingClientRect().top < innerHeight).every(i => i.complete)`,
		caption: "The games: one card for each map",
	},
	{ name: "map", path: "/maps/elden-ring/", settle: MAP, caption: "A map, with its categories and progress" },
	{
		name: "card",
		path: "/maps/re2/?map=claire-a#loc=544507",
		settle: CARD,
		caption: "A marker: its description, its links and its screenshot",
	},
	{
		name: "search",
		path: "/maps/elden-ring/",
		settle: MAP,
		prepare: `document.getElementById('search').focus()`,
		typeText: "wolf",
		caption: "Search: the results replace the list, and the map shows only the matches",
	},
	{
		name: "totk",
		path: "/maps/totk/?loc=281856&map=hyrule",
		settle: CARD,
		caption: "A Korok Seed in Hyrule, its card over the map",
	},
	{
		name: "list",
		path: "/maps/oblivion/",
		settle: `document.querySelector('#groups .group-head .row-menu-btn') && ${MAP_READY}`,
		prepare: LIST_LOCATIONS,
		caption: "List these markers: every category of a group, listed together",
	},
];
const SHOTS: Shot[] = [
	...SCENES.map((sc) => ({
		name: `wide-${SCENES.indexOf(sc) + 1}-${sc.name}`,
		form: "wide" as Form,
		path: sc.path,
		settle: sc.settle,
		prepare: sc.prepare,
		typeText: sc.typeText,
		caption: sc.caption,
	})),
	...SCENES.map((sc) => ({
		name: `narrow-${SCENES.indexOf(sc) + 1}-${sc.name}`,
		form: "narrow" as Form,
		path: sc.path,
		settle: sc.settle,
		// a phone shows the sidebar as a panel over the map: open it first, then the same action as the wide scene
		prepare:
			sc.prepare && sc.typeText
				? OPEN_SEARCH
				: sc.prepare
					? `(() => { document.getElementById('side-toggle').click(); setTimeout(() => { ${sc.prepare} }, 300); })()`
					: undefined,
		typeText: sc.typeText,
		caption: sc.caption,
	})),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(port: number, dashboard: ScreenshotDashboard) {
	const bin = process.env.CHROME || "chromium";
	const profile = `${process.env.TMPDIR || "/tmp"}/atlas-shots-${process.pid}`;
	dashboard.onStep(`Launching headless Chromium process: ${bin}`, "CHROME");
	dashboard.onStep(`Allocated remote debugging port :${port}`, "CHROME");
	const proc = Bun.spawn(
		[
			bin,
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--hide-scrollbars",
			"--enable-unsafe-swiftshader",
			"--use-gl=angle",
			"--use-angle=swiftshader",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	let target: { webSocketDebuggerUrl: string } | undefined;
	for (let i = 0; i < 100 && !target; i++) {
		try {
			target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
				(t: { type: string }) => t.type === "page",
			);
		} catch {}
		if (!target) await sleep(150);
	}
	if (!target) throw new Error(`Chromium did not start (${bin})`);
	dashboard.onStep("Connecting to DevTools Protocol WebSocket", "CDP");
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r));
	dashboard.onStep("DevTools WebSocket handshake established", "CDP");

	let id = 0;
	const pending = new Map<number, (m: any) => void>();
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)!(m);
			pending.delete(m.id);
		}
	});
	const send = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<any>((resolve, reject) => {
			const i = ++id;
			pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
			ws.send(JSON.stringify({ id: i, method, params }));
		});
	const evaluate = async (expression: string) => {
		const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
		return r.result?.value;
	};
	const close = () => {
		try {
			ws.close();
		} catch {}
		proc.kill();
	};
	return { send, evaluate, close };
}

type Cdp = Awaited<ReturnType<typeof launch>>;

async function waitFor(cdp: Cdp, expression: string, what: string, ms = 40000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		try {
			if (await cdp.evaluate(`!!(${expression})`)) return;
		} catch {}
		await sleep(250);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

async function shoot(cdp: Cdp, shot: Shot, base: string, out: string, dashboard: ScreenshotDashboard) {
	const t0 = Date.now();
	dashboard.startShot(shot);

	const v = VIEWPORT[shot.form];
	dashboard.onShotStep(`Setting ${shot.form} viewport: ${v.width}×${v.height} @ ${v.scale}x`);
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: v.width,
		height: v.height,
		deviceScaleFactor: v.scale,
		mobile: v.mobile,
	});

	if (v.mobile) {
		dashboard.onShotStep("Enabling mobile touch emulation (5 touchpoints)");
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	}

	const navUrl = new URL(shot.path, base).href;
	dashboard.onShotStep(`Navigating to ${navUrl}`);
	await cdp.send("Page.navigate", { url: navUrl });

	dashboard.onShotStep("Waiting for document.readyState === 'complete'");
	await waitFor(cdp, 'document.readyState === "complete"', "the page to load");

	if (shot.settle) {
		dashboard.onShotStep("Evaluating content settle condition");
		await waitFor(cdp, shot.settle, `${shot.name}: its content`);
	}

	dashboard.onShotStep("Grace period (6.0s) for tile rasterization & layer fade-in");
	await sleep(6000);

	if (shot.prepare) {
		dashboard.onShotStep("Executing scene prepare script");
		await cdp.evaluate(shot.prepare);
		await sleep(900);
	}

	if (shot.typeText) {
		dashboard.onShotStep(`Dispatching keyboard input: "${shot.typeText}"`);
		await cdp.send("Input.insertText", { text: shot.typeText });
		await sleep(900);
	}

	dashboard.onShotStep("Triggering Page.captureScreenshot (JPEG, q=90)");
	const { data } = await cdp.send("Page.captureScreenshot", {
		format: "jpeg",
		quality: 90,
		captureBeyondViewport: false,
	});

	const filePath = path.join(out, `${shot.name}.jpg`);
	dashboard.onShotStep(`Writing screenshot image -> ${shot.name}.jpg`);
	const buf = Buffer.from(data, "base64");
	await Bun.write(filePath, buf);

	dashboard.finishShot(shot, buf.length, Date.now() - t0);
}

/* ---------- main ---------- */

const { values: v } = parseArgs({
	options: {
		base: { type: "string", default: "http://127.0.0.1:8072" },
		out: { type: "string", default: "public/screenshots" },
		only: { type: "string" },
		"no-tui": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (v.help) {
	console.log(`
Usage: bun scripts/make-screenshots.ts [options]

Options:
  --base <url>     Base URL of the running site (default: http://127.0.0.1:8072)
  --out <dir>      Output directory for screenshots (default: public/screenshots)
  --only <names>   Comma-separated list of screenshot names or prefixes (e.g. wide-1,narrow)
  --no-tui         Disable the interactive terminal UI
  --help, -h       Show this help message
`);
	process.exit(0);
}

const baseArg = v.base!;
const out = v.out!;
const only = v.only
	? v.only
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
	: [];
const shots = SHOTS.filter((s) => !only.length || only.some((o) => s.name.startsWith(o)));
await mkdir(out, { recursive: true });

const dashboard = await createScreenshotDashboard({
	totalShots: shots.length,
	base: baseArg,
	outDir: out,
	noTui: Boolean(v["no-tui"]),
});

let base = baseArg;
let serverProc: ReturnType<typeof Bun.spawn> | null = null;

try {
	// 1. Verify site server connectivity
	dashboard.onStep(`Checking site server reachability at ${base}`, "SERVER");
	let serverReachable = false;
	try {
		const res = await fetch(base);
		if (res.ok || res.status < 500) serverReachable = true;
	} catch {}

	if (!serverReachable) {
		const parsedUrl = new URL(base);
		const serverPort = parsedUrl.port || "8072";
		dashboard.onStep(
			`Server not detected on ${base}; spawning local test instance on port ${serverPort}`,
			"SERVER",
		);
		const tsServer = path.join(import.meta.dir, "../server/server.ts");
		const mjsServer = path.join(import.meta.dir, "../server/server.mjs");
		const serverScript = (await Bun.file(tsServer).exists()) ? tsServer : mjsServer;
		serverProc = Bun.spawn(["bun", serverScript, "--port", serverPort, "--no-tui"], {
			stdout: "ignore",
			stderr: "inherit",
		});
		const cleanup = () => {
			try {
				serverProc?.kill();
			} catch {}
		};
		process.on("SIGINT", () => {
			cleanup();
			dashboard.destroy();
			process.exit(1);
		});
		process.on("SIGTERM", () => {
			cleanup();
			dashboard.destroy();
			process.exit(1);
		});

		let up = false;
		for (let i = 0; i < 50; i++) {
			try {
				const res = await fetch(`${base}/`);
				if (res.ok || res.status < 500) {
					up = true;
					break;
				}
			} catch {}
			await sleep(100);
		}
		if (!up) {
			try {
				serverProc.kill();
			} catch {}
			throw new Error(`Server failed to start on ${base}`);
		}
		dashboard.onStep(`Local test server spawned successfully on ${base}`, "SERVER");
	} else {
		dashboard.onStep(`Existing server detected and responsive on ${base}`, "SERVER");
	}

	// 2. Launch Chromium and attach DevTools
	const port = 9400 + Math.floor(Math.random() * 500);
	const cdp = await launch(port, dashboard);
	try {
		dashboard.onStep("Enabling CDP Page and Runtime domains", "CDP");
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");

		for (const shot of shots) {
			await shoot(cdp, shot, base, out, dashboard);
		}

		await dashboard.finish();
	} finally {
		dashboard.onStep("Closing CDP DevTools session", "CDP");
		cdp.close();
		try {
			serverProc?.kill();
		} catch {}
	}
} catch (err: any) {
	dashboard.destroy();
	try {
		serverProc?.kill();
	} catch {}
	console.error(`\nERROR: ${err.message || err}`);
	process.exit(1);
}