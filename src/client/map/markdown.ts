/* ---------- descriptions: markdown (vendor/marked.umd.js). MapGenie location links become local #loc links ---------- */

import { esc } from "../../shared/escape.ts";
import { state } from "./state.ts";

// Any "#loc=<id>" fragment or HTTP(S) URL containing a MapGenie locationIds parameter -> ID, or null.
// Works with "#loc=123", mapgenie.io, standalone MapGenie domains, and relative URLs.
export function mapgenieLocId(href: string): number | null {
	const raw = String(href || "").trim();
	const frag = /^#loc=(\d+)$/i.exec(raw);
	if (frag) return Number(frag[1]);

	let u: URL;
	try {
		u = new URL(raw, "https://mapgenie.io/");
	} catch {
		return null;
	}

	if (!/^https?:$/.test(u.protocol)) return null;

	const hashMatch = /^#loc=(\d+)$/i.exec(u.hash);
	if (hashMatch) return Number(hashMatch[1]);

	const m = /^(\d+)/.exec(u.searchParams.get("locationIds") || "");
	return m ? Number(m[1]) : null;
}

export const isLocalLocHref = (href: string): boolean => /^#loc=\d+$/i.test(String(href || "").trim());

// Does an HTTP(S) URL point to another map of this game (e.g. https://mapgenie.io/witcher-3/maps/skellige)?
export function isCrossMapUrl(href: string, mapSlugs: Iterable<string>, currentSlug?: string | null): boolean {
	let u: URL;
	try {
		u = new URL(String(href || "").trim());
	} catch {
		return false;
	}
	if (!/^https?:$/.test(u.protocol)) return false;
	const slugs = new Set(mapSlugs);
	if (!slugs.size) return false;
	const segs = u.pathname.split("/").filter(Boolean);
	const mapIdx = segs.indexOf("maps");
	const target = mapIdx >= 0 ? segs[mapIdx + 1] : segs.length === 1 ? segs[0] : null;
	return Boolean(target && target !== currentSlug && slugs.has(target));
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
				if (id != null) {
					if (state.byId.has(id)) return `<a href="#loc=${id}" data-loc="${id}">${text}</a>`;
					if (isLocalLocHref(t.href)) return text;
					return `<a href="${esc(t.href)}" data-cross-loc="${id}" class="cross-loc">${text}</a>`;
				}
				const mapSlugs = (state.meta?.maps || []).map((m: any) => m.slug);
				if (isCrossMapUrl(t.href, mapSlugs, state.mapInfo?.slug)) {
					return `<a href="${esc(t.href)}" data-cross-loc="" class="cross-loc">${text}</a>`;
				}
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