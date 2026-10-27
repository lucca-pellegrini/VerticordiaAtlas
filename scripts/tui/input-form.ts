// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import {
	BoxRenderable,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core";

import { computeResponsiveBox, RGBA_THEME, THEME } from "./theme.js";

export interface AddGameFormResult {
	url: string;
	slug?: string;
	title?: string;
	posterUrl?: string;
	downloadTiles: boolean;
	allTilesets: boolean;
	downloadMedia: boolean;
	uploadMedia: boolean;
	keepLocal: boolean;
	videos: boolean;
	makeCards: boolean;
}

export async function validatePosterUrl(
	urlStr: string,
): Promise<{ ok: boolean; message: string; width?: number; height?: number }> {
	const trimmed = urlStr.trim();
	if (!trimmed) {
		return { ok: true, message: "Optional (scrapes default from page)" };
	}
	try {
		const u = new URL(trimmed);
		if (!u.protocol.startsWith("http")) {
			return { ok: false, message: "URL must start with http:// or https://" };
		}
		const res = await fetch(u.href, {
			method: "GET",
			headers: { Range: "bytes=0-32767" },
		});
		if (!res.ok && res.status !== 206) {
			return { ok: false, message: `HTTP ${res.status}: ${res.statusText}` };
		}
		const ctype = res.headers.get("content-type") || "";
		if (!ctype.startsWith("image/")) {
			return { ok: false, message: `Not an image (${ctype || "unknown"})` };
		}
		const buf = Buffer.from(await res.arrayBuffer());
		try {
			const sharp = (await import("sharp")).default;
			const meta = await sharp(buf).metadata();
			if (meta.width && meta.height) {
				if (meta.width < 400 || meta.height < 400) {
					return { ok: false, message: `Image too small: ${meta.width}×${meta.height} (min 400×400)` };
				}
				return {
					ok: true,
					message: `✓ Valid ${meta.format?.toUpperCase()} (${meta.width}×${meta.height})`,
					width: meta.width,
					height: meta.height,
				};
			}
		} catch {
			return { ok: true, message: `✓ Valid image header (${ctype.split(";")[0]})` };
		}
		return { ok: true, message: `✓ Valid image header (${ctype.split(";")[0]})` };
	} catch (e: any) {
		return { ok: false, message: `Error: ${e.message || "Failed to reach host"}` };
	}
}

export function promptAddGameTui(defaultUrl = ""): Promise<AddGameFormResult | null> {
	return new Promise(async (resolve) => {
		const renderer = await createCliRenderer({
			exitOnCtrlC: true,
		});

		let { boxW, boxH } = computeResponsiveBox(renderer.width || 80, renderer.height || 26, 110, 36);

		renderer.root.flexDirection = "column";
		renderer.root.alignItems = "center";
		renderer.root.justifyContent = "center";

		const rootBox = new BoxRenderable(renderer, {
			width: boxW,
			height: boxH,
			border: true,
			borderColor: RGBA_THEME.borderFocus,
			flexDirection: "column",
			paddingX: 2,
			paddingY: 1,
			backgroundColor: THEME.bgDark,
		});

		const headerText = new TextRenderable(renderer, {
			content: "VERTICORDIA ATLAS • ADD / SCRAPE GAME MAPS",
			fg: THEME.borderFocus,
		});
		const subText = new TextRenderable(renderer, {
			content: "Enter MapGenie game details. Tab / Shift+Tab to move, Space to toggle, Enter to submit.",
			fg: THEME.textDim,
		});
		rootBox.add(headerText);
		rootBox.add(subText);

		// Form Fields
		const formBox = new BoxRenderable(renderer, {
			flexDirection: "column",
			marginVertical: 1,
			gap: 0,
			flexGrow: 1,
		});

		let currentUrl = defaultUrl;
		let currentSlug = "";
		let currentTitle = "";
		let currentPoster = "";

		// 1. URL
		const urlLabel = new TextRenderable(renderer, { content: "MapGenie URL (required):", fg: THEME.peach });
		const urlInput = new InputRenderable(renderer, {
			placeholder: "https://mapgenie.io/crimson-desert",
			value: defaultUrl,
			width: boxW - 8,
			backgroundColor: THEME.surface,
			focusedBackgroundColor: THEME.surfaceLight,
			textColor: THEME.textBright,
		});
		formBox.add(urlLabel);
		formBox.add(urlInput);

		// 2. Slug
		const slugLabel = new TextRenderable(renderer, {
			content: "Custom Slug / ID (optional, derived from URL):",
			fg: THEME.peach,
		});
		const slugInput = new InputRenderable(renderer, {
			placeholder: "e.g. crimson-desert or totk",
			width: boxW - 8,
			backgroundColor: THEME.surface,
			focusedBackgroundColor: THEME.surfaceLight,
			textColor: THEME.textBright,
		});
		formBox.add(slugLabel);
		formBox.add(slugInput);

		// 3. Title
		const titleLabel = new TextRenderable(renderer, {
			content: "Custom Title (optional, scraped from page):",
			fg: THEME.peach,
		});
		const titleInput = new InputRenderable(renderer, {
			placeholder: "e.g. Crimson Desert",
			width: boxW - 8,
			backgroundColor: THEME.surface,
			focusedBackgroundColor: THEME.surfaceLight,
			textColor: THEME.textBright,
		});
		formBox.add(titleLabel);
		formBox.add(titleInput);

		// 4. Poster URL
		const posterLabel = new TextRenderable(renderer, {
			content: "Poster Image URL (optional, validates headers & dimensions):",
			fg: THEME.peach,
		});
		const posterInput = new InputRenderable(renderer, {
			placeholder: "https://.../poster.jpg",
			width: boxW - 8,
			backgroundColor: THEME.surface,
			focusedBackgroundColor: THEME.surfaceLight,
			textColor: THEME.textBright,
		});
		const posterValidationText = new TextRenderable(renderer, {
			content: "  Optional (scrapes default from page)",
			fg: THEME.textDim,
		});
		formBox.add(posterLabel);
		formBox.add(posterInput);
		formBox.add(posterValidationText);

		// Checkboxes
		const checkOptions = [
			{ key: "downloadTiles", label: "Download map raster tiles", checked: true },
			{ key: "allTilesets", label: "Include all tilesets (e.g. detailed, underground, factions)", checked: true },
			{ key: "downloadMedia", label: "Download & process media assets", checked: true },
			{ key: "uploadMedia", label: "Upload media directly to Cloudflare R2 / S3", checked: false },
			{ key: "keepLocal", label: "Keep local media copies (when uploading to R2)", checked: false },
			{ key: "videos", label: "Include video media items", checked: true },
			{ key: "makeCards", label: "Pre-render OpenGraph preview cards", checked: true },
		];

		const checkRenderables: TextRenderable[] = [];
		for (const opt of checkOptions) {
			const text = new TextRenderable(renderer, {
				content: `  [${opt.checked ? "X" : " "}] ${opt.label}`,
				fg: THEME.text,
			});
			checkRenderables.push(text);
			formBox.add(text);
		}

		rootBox.add(formBox);

		// Footer buttons / hint
		const footerHint = new TextRenderable(renderer, {
			content: " [Enter] Start Scrape & Import     [Esc] Cancel",
			fg: THEME.teal,
		});
		rootBox.add(footerHint);

		renderer.root.add(rootBox);

		// Focus handling
		// Focusable items: 0: url, 1: slug, 2: title, 3: poster, 4..8: checkboxes
		let focusIdx = 0;
		const inputs = [urlInput, slugInput, titleInput, posterInput];

		let isClosed = false;

		function updateFocus() {
			if (isClosed) return;
			for (let i = 0; i < inputs.length; i++) {
				if (i === focusIdx) {
					inputs[i].focus();
				} else {
					inputs[i].blur();
				}
			}

			for (let i = 0; i < checkOptions.length; i++) {
				const isFoc = focusIdx === inputs.length + i;
				const chk = checkOptions[i].checked ? "X" : " ";
				const prefix = isFoc ? "▶ [" : "  [";
				checkRenderables[i].content = `${prefix}${chk}] ${checkOptions[i].label}`;
				checkRenderables[i].fg = isFoc ? THEME.green : THEME.text;
			}
			renderer.requestRender();
		}

		urlInput.focus();
		renderer.requestRender();

		// Realtime poster validation debouncer
		let validateTimer: any = null;
		const handlePosterInput = (val: string) => {
			if (isClosed) return;
			currentPoster = val;
			clearTimeout(validateTimer);
			const trimmed = val.trim();
			if (!trimmed) {
				posterValidationText.content = "  Optional (scrapes default from page)";
				posterValidationText.fg = THEME.textDim;
				renderer.requestRender();
				return;
			}
			posterValidationText.content = "  Validating poster image...";
			posterValidationText.fg = THEME.yellow;
			renderer.requestRender();
			validateTimer = setTimeout(async () => {
				if (isClosed) return;
				const r = await validatePosterUrl(trimmed);
				if (isClosed) return;
				posterValidationText.content = `  ${r.message}`;
				posterValidationText.fg = r.ok ? THEME.green : THEME.red;
				renderer.requestRender();
			}, 400);
		};

		posterInput.on(InputRenderableEvents.INPUT, handlePosterInput);
		posterInput.on(InputRenderableEvents.CHANGE, handlePosterInput);

		// URL updates & auto-derive slug
		const handleUrlInput = (val: string) => {
			if (isClosed) return;
			currentUrl = val;
			if (!currentSlug.trim() && val.trim()) {
				try {
					const u = new URL(val.trim());
					const seg = u.pathname.replace(/\/+$/, "").split("/").pop();
					if (seg) {
						slugInput.placeholder = `derived: ${seg}`;
					}
				} catch {}
			}
		};
		urlInput.on(InputRenderableEvents.INPUT, handleUrlInput);
		urlInput.on(InputRenderableEvents.CHANGE, handleUrlInput);

		slugInput.on(InputRenderableEvents.INPUT, (val) => {
			if (isClosed) return;
			currentSlug = val;
		});
		slugInput.on(InputRenderableEvents.CHANGE, (val) => {
			if (isClosed) return;
			currentSlug = val;
		});

		titleInput.on(InputRenderableEvents.INPUT, (val) => {
			if (isClosed) return;
			currentTitle = val;
		});
		titleInput.on(InputRenderableEvents.CHANGE, (val) => {
			if (isClosed) return;
			currentTitle = val;
		});

		function cleanup(res: AddGameFormResult | null) {
			if (isClosed) return;
			isClosed = true;
			clearTimeout(validateTimer);
			renderer.off("resize", handleResize);
			process.stdout.off("resize", onStdoutResize);
			try {
				urlInput.removeAllListeners();
				slugInput.removeAllListeners();
				titleInput.removeAllListeners();
				posterInput.removeAllListeners();
				renderer.keyInput.removeAllListeners();
			} catch {}
			try {
				renderer.destroy();
			} catch {}
			clearTimeout(validateTimer);
			resolve(res);
		}

		function handleResize(termW: number, termH: number) {
			if (isClosed) return;
			const next = computeResponsiveBox(termW || renderer.width, termH || renderer.height, 110, 36);
			boxW = next.boxW;
			boxH = next.boxH;
			rootBox.width = boxW;
			rootBox.height = boxH;
			const inputW = Math.max(20, boxW - 8);
			urlInput.width = inputW;
			slugInput.width = inputW;
			titleInput.width = inputW;
			posterInput.width = inputW;
			renderer.requestRender();
		}

		renderer.on("resize", handleResize);
		const onStdoutResize = () => handleResize(renderer.width, renderer.height);
		process.stdout.on("resize", onStdoutResize);

		renderer.keyInput.on("keypress", (key: KeyEvent) => {
			if (isClosed) return;

			if (key.name === "escape" || (key.ctrl && key.name === "c")) {
				cleanup(null);
				return;
			}

			if (key.name === "tab") {
				if (key.shift) {
					focusIdx =
						(focusIdx - 1 + inputs.length + checkOptions.length) % (inputs.length + checkOptions.length);
				} else {
					focusIdx = (focusIdx + 1) % (inputs.length + checkOptions.length);
				}
				updateFocus();
				key.preventDefault();
				return;
			}

			if (key.name === "down") {
				focusIdx = (focusIdx + 1) % (inputs.length + checkOptions.length);
				updateFocus();
				key.preventDefault();
				return;
			}

			if (key.name === "up") {
				focusIdx = (focusIdx - 1 + inputs.length + checkOptions.length) % (inputs.length + checkOptions.length);
				updateFocus();
				key.preventDefault();
				return;
			}

			if (key.name === "space" && focusIdx >= inputs.length) {
				const chkIdx = focusIdx - inputs.length;
				checkOptions[chkIdx].checked = !checkOptions[chkIdx].checked;
				updateFocus();
				key.preventDefault();
				return;
			}

			if (key.name === "return") {
				let enteredUrl = currentUrl.trim();
				try {
					if (!enteredUrl) enteredUrl = urlInput.value.trim();
				} catch {}

				if (!enteredUrl) {
					urlLabel.content = "MapGenie URL (REQUIRED - please type or paste a valid URL):";
					urlLabel.fg = THEME.red;
					focusIdx = 0;
					updateFocus();
					return;
				}

				let enteredSlug = currentSlug.trim();
				try {
					if (!enteredSlug) enteredSlug = slugInput.value.trim();
				} catch {}

				let enteredTitle = currentTitle.trim();
				try {
					if (!enteredTitle) enteredTitle = titleInput.value.trim();
				} catch {}

				let enteredPoster = currentPoster.trim();
				try {
					if (!enteredPoster) enteredPoster = posterInput.value.trim();
				} catch {}

				const optMap = new Map<string, boolean>();
				for (const opt of checkOptions) {
					optMap.set(opt.key, opt.checked);
				}

				const result: AddGameFormResult = {
					url: enteredUrl,
					slug: enteredSlug || undefined,
					title: enteredTitle || undefined,
					posterUrl: enteredPoster || undefined,
					downloadTiles: optMap.get("downloadTiles") ?? true,
					allTilesets: optMap.get("allTilesets") ?? true,
					downloadMedia: optMap.get("downloadMedia") ?? true,
					uploadMedia: optMap.get("uploadMedia") ?? false,
					keepLocal: optMap.get("keepLocal") ?? false,
					videos: optMap.get("videos") ?? true,
					makeCards: optMap.get("makeCards") ?? true,
				};
				cleanup(result);
			}
		});
	});
}