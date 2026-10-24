// Shared HTML escaping and number formatting utilities.

export const esc = (s: unknown): string =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

export const fmt = (n: unknown): string => Number(n).toLocaleString();

export const fmtEn = (n: unknown): string => Number(n).toLocaleString("en-US");