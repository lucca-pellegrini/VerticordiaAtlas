// icons.ts: the line icons used by the map tools and the marker menus. 24x24, drawn with currentColor.
// `clock` marks the part of an icon that is filled with the background (so it reads on top of the pin head).

export const ICONS: Record<string, string> = {
	pin: '<path d="M12 21s-6.5-6-6.5-11.5a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/>',
	tempPin:
		'<path d="M9.5 19.5s-5-4.4-5-8.3a5 5 0 0 1 10 0c0 3.9-5 8.3-5 8.3z"/><circle cx="9.5" cy="11.2" r="1.7"/>' +
		'<circle class="clock" cx="17.2" cy="6.2" r="3.9"/><path d="M17.2 4.2v2.1l1.4 1.1"/>',
	save: '<path d="M5 4h11l3 3v11a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
	pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
	move: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
	trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
	check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
	open: '<circle cx="12" cy="12" r="8.5"/>',
	x: '<path d="M6 6l12 12M18 6L6 18"/>',
	list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
	share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.4 10.8l7.2-4.4M8.4 13.2l7.2 4.4"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	card: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/>',
	box: '<rect x="4" y="6" width="16" height="12" rx="1" stroke-dasharray="2.5 2"/>',
	ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6" stroke-dasharray="2.5 2"/>',
	free: '<path d="M5 9c1.5-3 5-4 7-2s4-1.5 6 .5 1 6-2 6.5-3-2-5 0-4 2.5-6 1-4.5-.5-3-3.5z" stroke-dasharray="2.5 2"/>',
};

// an icon as markup: the paths of ICONS.name inside a 24x24 svg with the shared styling (class "i")
export const svgIcon = (name: string, extra = ""): string =>
	`<svg class="i${extra ? " " + extra : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;