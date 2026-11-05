// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { RGBA } from "@opentui/core";

export const THEME = {
	bgDark: "#181825",
	surface: "#1e1e2e",
	surfaceLight: "#313244",
	borderFocus: "#89b4fa",
	borderDim: "#45475a",
	text: "#cdd6f4",
	textDim: "#6c7086",
	textBright: "#ffffff",
	green: "#a6e3a1",
	blue: "#89b4fa",
	flashBlue: "#89dceb",
	flashBlueBg: "#1e3a8a",
	yellow: "#f9e2af",
	peach: "#fab387",
	red: "#f38ba8",
	flashRed: "#ff5555",
	flashRedBg: "#450a0a",
	mauve: "#cba6f7",
	teal: "#94e2d5",
};

export const RGBA_THEME = {
	bgDark: RGBA.fromHex(THEME.bgDark),
	surface: RGBA.fromHex(THEME.surface),
	surfaceLight: RGBA.fromHex(THEME.surfaceLight),
	borderFocus: RGBA.fromHex(THEME.borderFocus),
	borderDim: RGBA.fromHex(THEME.borderDim),
	text: RGBA.fromHex(THEME.text),
	textDim: RGBA.fromHex(THEME.textDim),
	textBright: RGBA.fromHex(THEME.textBright),
	green: RGBA.fromHex(THEME.green),
	blue: RGBA.fromHex(THEME.blue),
	flashBlue: RGBA.fromHex(THEME.flashBlue),
	flashBlueBg: RGBA.fromHex(THEME.flashBlueBg),
	yellow: RGBA.fromHex(THEME.yellow),
	peach: RGBA.fromHex(THEME.peach),
	red: RGBA.fromHex(THEME.red),
	flashRed: RGBA.fromHex(THEME.flashRed),
	flashRedBg: RGBA.fromHex(THEME.flashRedBg),
	mauve: RGBA.fromHex(THEME.mauve),
	teal: RGBA.fromHex(THEME.teal),
};

/** Braille spinner frames shared by every animated activity indicator. */
export const THROBBER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Default animation cadence for throbbers. */
export const THROBBER_INTERVAL_MS = 100;

/** Wrap a monotonically increasing tick into a frame index. */
export function throbberTickIndex(tick: number, frameCount: number = THROBBER_FRAMES.length): number {
	if (frameCount <= 0) return 0;
	return ((Math.floor(tick) % frameCount) + frameCount) % frameCount;
}

/** Return the glyph for a given animation tick. */
export function throbberFrame(tick: number, frames: readonly string[] = THROBBER_FRAMES): string {
	if (!frames.length) return "";
	return frames[throbberTickIndex(tick, frames.length)];
}

export interface Throbber {
	/** Current animation tick. */
	readonly tick: number;
	/** Current glyph. */
	readonly frame: string;
	/** Stop the interval. Safe to call more than once. */
	stop(): void;
}

/**
 * Start a lightweight interval that advances a spinner and reports each frame.
 *
 * The callback should only update the renderables it needs and request a render.
 * Call `stop()` from the owning view's `finish()` / `destroy()` lifecycle hook.
 */
export function startThrobber(
	onFrame: (frame: string, tick: number) => void,
	intervalMs = THROBBER_INTERVAL_MS,
	frames: readonly string[] = THROBBER_FRAMES,
): Throbber {
	let tick = 0;
	let stopped = false;
	const timer = setInterval(() => {
		if (stopped) return;
		tick++;
		onFrame(throbberFrame(tick, frames), tick);
	}, intervalMs);

	return {
		get tick() {
			return tick;
		},
		get frame() {
			return throbberFrame(tick, frames);
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
		},
	};
}

export const DENSITY_GLYPHS = [" ", "░", "▒", "▓", "█"] as const;

export function densityGlyph(ratio: number): string {
	if (ratio <= 0) return " ";
	if (ratio <= 0.25) return "░";
	if (ratio <= 0.5) return "▒";
	if (ratio <= 0.75) return "▓";
	return "█";
}

export function fmtTime(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "--:--";
	const s = Math.floor(sec);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m >= 60) {
		const h = Math.floor(m / 60);
		return `${h}:${String(m % 60).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
	}
	return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

export function fmtBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0.0 KB";
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function renderProgressBar(pct: number, width: number, fillChar = "█", emptyChar = "░"): string {
	const clamped = Math.max(0, Math.min(100, pct));
	const filled = Math.max(0, Math.min(width, Math.floor((clamped / 100) * width)));
	const empty = Math.max(0, width - filled);
	return `[${fillChar.repeat(filled)}${emptyChar.repeat(empty)}]`;
}

export function isInteractiveTty(noTuiFlag?: boolean): boolean {
	return Boolean(
		process.stdout.isTTY && !noTuiFlag && !process.env.CI && !process.argv.some((arg) => arg.includes("test")),
	);
}

export function computeResponsiveBox(
	termW: number,
	termH: number,
	maxBoxW = 128,
	maxBoxH = 38,
): { boxW: number; boxH: number } {
	const boxW = Math.max(36, Math.min(termW - 2, maxBoxW));
	const boxH = Math.max(14, Math.min(termH - 2, maxBoxH));
	return { boxW, boxH };
}

export function isCtrlL(key: any): boolean {
	if (!key) return false;
	return Boolean(
		(key.ctrl && (key.name === "l" || key.name === "L")) || key.raw === "\x0c" || key.sequence === "\x0c",
	);
}

export function clearAndRedrawTerminal(renderer?: any): void {
	try {
		process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
	} catch {}
	if (renderer) {
		try {
			if ("forceFullRepaintRequested" in renderer) {
				renderer.forceFullRepaintRequested = true;
			}
			renderer.requestRender?.();
		} catch {}
	}
}