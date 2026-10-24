// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Shared color and theme calculations used across server cards, theme.ts,app, and scripts.

import type { ThemePalette } from "./types.ts";

export function hexToHsl(hex: string): [number, number, number] {
	const clean = String(hex || "#d6453b").replace("#", "");
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
	const mx = Math.max(r, g, b),
		mn = Math.min(r, g, b),
		l = (mx + mn) / 2,
		d = mx - mn;
	if (!d) return [0, 0, l];
	const sat = d / (1 - Math.abs(2 * l - 1));
	const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, sat, l];
}

export function hslToHex(h: number, s: number, l: number): string {
	const k = (n: number) => (n + h / 30) % 12,
		a = s * Math.min(l, 1 - l);
	const f = (n: number) =>
		Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
			.toString(16)
			.padStart(2, "0");
	return "#" + f(0) + f(8) + f(4);
}

export function deriveLightAccentSoft(accent?: string | null): string {
	if (!accent) return "#b03028";
	const [h, s, al] = hexToHsl(accent);
	return hslToHex(h, Math.min(s, 0.78), Math.max(0.26, Math.min(0.4, al - 0.06)));
}

export function deriveLightTheme(theme: ThemePalette = {}): ThemePalette {
	const accent = theme.accent || "#d6453b";
	const [h, s, al] = hexToHsl(accent);
	const tint = (sat: number, l: number) => hslToHex(h, Math.min(sat, s), l);
	return {
		accent,
		"accent-soft": hslToHex(h, Math.min(s, 0.78), Math.max(0.26, Math.min(0.4, al - 0.06))),
		night: tint(0.32, 0.945),
		panel: tint(0.28, 0.982),
		"panel-2": tint(0.26, 0.935),
		line: tint(0.24, 0.855),
	};
}

export function gameThemeColor(theme: ThemePalette = {}, isLight = false): string {
	if (isLight) return deriveLightTheme(theme).night!;
	return theme.night || "#0b0e10";
}

export function gameFavicon(theme: ThemePalette = {}, isLight = false): string {
	const active = isLight ? deriveLightTheme(theme) : theme;
	const pin = active["accent-soft"] || active.accent || "#d6453b";
	const dot = active.night || "#0b0e10";
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='${pin}' d='M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z'/><circle cx='12' cy='10' r='2.8' fill='${dot}'/></svg>`;
	return "data:image/svg+xml," + encodeURIComponent(svg);
}

// the glyph's colour for a category colour: whichever of white or near-black reads better on it (WCAG contrast)
export function glyphInk(hex: string): "#ffffff" | "#14161a" {
	const n = parseInt(String(hex).replace("#", ""), 16);
	const lin = (v: number) => {
		v /= 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
	const white = 1.05 / (L + 0.05),
		dark = (L + 0.05) / 0.06;
	return white >= dark ? "#ffffff" : "#14161a";
}