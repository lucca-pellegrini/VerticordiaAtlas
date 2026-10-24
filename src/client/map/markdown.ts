/* ---------- descriptions: markdown (vendor/marked.umd.js). MapGenie location links become local #loc links ---------- */

import { esc } from "../../shared/escape.ts";
import { state } from "./state.ts";

// Any HTTP(S) URL containing a MapGenie locationIds parameter -> ID, or null.
// Works with mapgenie.io, standalone MapGenie domains, and relative URLs.
export function mapgenieLocId(href: string): number | null {
	let u: URL;
	try {
		u = new URL(href, "https://mapgenie.io/");
	} catch {
		return null;
	}

	if (!/^https?:$/.test(u.protocol)) return null;

	const m = /^(\d+)/.exec(u.searchParams.get("locationIds") || "");
	return m ? Number(m[1]) : null;
}

// every link token in a parsed markdown token tree
export function forEachLink(tokens: any[] | undefined, fn: (t: any) => void): void {
	for (const t of tokens || []) {
		if (t.type === "link") fn(t);
		forEachLink(t.tokens, fn);
		if (t.items) forEachLink(t.items, fn);
	}
}

// location ids of this map that a description links to, in order of appearance (self and unknown ids skipped)
export function internalRefs(src: string | null | undefined, selfId: number): number[] {
	const out: number[] = [];
	if (typeof marked === "undefined") return out;
	forEachLink(marked.lexer(String(src || "")), (t) => {
		const id = mapgenieLocId(t.href);
		if (id != null && id !== selfId && state.byId.has(id) && !out.includes(id)) out.push(id);
	});
	return out;
}

if (typeof marked !== "undefined") {
	marked.use({
		gfm: true,
		breaks: true, // single line breaks stay line breaks, as the descriptions were written
		renderer: {
			// raw HTML in a description is shown as text, never as markup
			html(t: any) {
				return esc(t.text);
			},
			link(this: any, t: any) {
				const text = this.parser.parseInline(t.tokens);
				const id = mapgenieLocId(t.href);
				if (id != null) return state.byId.has(id) ? `<a href="#loc=${id}" data-loc="${id}">${text}</a>` : text;
				if (/^https?:/i.test(t.href))
					return `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
				return text; // mailto:, javascript: and other schemes are not made into links
			},
			image(t: any) {
				// embedded pictures are not shown inline yet: keep the alt text, linked when it is a web address
				const text = esc(t.text || t.href);
				return /^https?:/i.test(t.href)
					? `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
					: text;
			},
		},
	});
}

export function renderMd(src: string | null | undefined): string {
	return typeof marked !== "undefined" ? marked.parse(String(src || "")) : esc(src || "");
}