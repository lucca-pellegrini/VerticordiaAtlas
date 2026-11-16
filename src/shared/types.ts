// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Shared domain types across server, client, and CLI scripts.

export interface ThemePalette {
	accent?: string;
	"accent-soft"?: string;
	night?: string;
	panel?: string;
	"panel-2"?: string;
	line?: string;
	[key: string]: string | undefined;
}

export interface Camera {
	lng: number;
	lat: number;
	zoom: number;
}

export interface UserCategory {
	id: number;
	title: string;
	color: string;
	glyph: string | null;
	temp?: boolean;
}

export interface SharedMarkerCategory {
	name: string;
	color: string | null;
	glyph: string | null;
}

export interface UserMarker {
	id: number;
	cat: number | null;
	title: string;
	desc: string;
	lat: number;
	lng: number;
	links: number[];
	map: string;
	created?: number;
	temp?: boolean;
	shared?: SharedMarkerCategory | null;
}

export type DrawingKind = "pen" | "highlighter" | "line" | "arrow" | "path" | "rect" | "ellipse" | "text";
export type DrawingSize = "s" | "m" | "l";

export interface GeoPoint {
	lng: number;
	lat: number;
}

export type DrawingPoint = GeoPoint;

export interface ScreenPoint {
	x: number;
	y: number;
}

export interface DrawingItem {
	id: string;
	kind: DrawingKind;
	color: string;
	size: DrawingSize;
	pts: GeoPoint[];
	circle?: boolean;
	text?: string;
	z?: number;
	map: string;
}

export type TagFilterValue = number | "untagged" | null;

export interface SavedMapView {
	hidden?: number[];
	hideFound?: boolean;
	collapsed?: (number | string)[];
	presetId?: string | null;
	baseline?: number[] | null;
	tag?: TagFilterValue;
	tagStrict?: boolean;
}

export interface Profile {
	key: string;
	id: string;
	game: string;
	name: string;
	tag: TagFilterValue | string;
	tagStrict?: boolean;
	found: number[];
	// Epoch SECONDS (not ms — unlike `created` and `updated` which are ms) mapping marker id to when it was found.
	// `found` is the source of truth; `foundAt` is advisory metadata and may be absent for legacy finds.
	foundAt?: Record<string, number>;
	// Guide progress keyed by guide id (/^[A-Za-z0-9_-]{4,24}$/). Absent when no guides have progress.
	guides?: Record<string, GuideProgress>;
	created: number;
	updated: number;
	map?: string | null;
	cameras?: Record<string, Camera>;
	view?: Record<string, SavedMapView>;
	drawings?: DrawingItem[];
	userCats?: UserCategory[];
	userMarkers?: UserMarker[];
}

export interface Guide {
	v: 1; // format version; reject greater versions with a clear message
	id: string; // short stable id, /^[A-Za-z0-9_-]{4,24}$/
	game: string; // the game's id (/^[A-Za-z0-9._-]{1,80}$/)
	title: string; // plain text, max 120 chars
	description?: string; // markdown, short, max 2,000 chars
	author?: string; // free-text credit, never trusted for identity
	credits?: string; // free-text sources and thanks
	variants?: GuideVariant[];
	sections: GuideSection[];
	created: number; // ms since epoch
	updated: number; // ms since epoch
}

export interface GuideVariant {
	id: string; // /^[a-z0-9-]{1,40}$/
	label: string; // e.g. "Difficulty"
	options: { id: string; label: string }[]; // 2 to 8 options; option id /^[a-z0-9-]{1,40}$/
	default: string; // an option id in `options`
}

export interface GuideSection {
	id: string; // short stable id, /^[A-Za-z0-9_-]{1,40}$/
	title: string; // plain text, max 120 chars
	notes?: string; // markdown, max 5,000 chars
	level?: string; // recommended level, free text such as "50-55"
	gate?: string; // prerequisite note, plain text
	after?: string; // what changes once the section is done, plain text
	optional?: boolean; // every step in an optional section is optional
	steps: GuideStep[];
}

export type StepKind = "task" | "waypoint" | "info";

export interface GuideStep {
	id: string; // short stable id, /^[A-Za-z0-9_-]{1,40}$/
	kind: StepKind; // task: counted and completable; waypoint: navigation only; info: knowledge only
	title: string; // plain text, max 120 chars
	notes?: string; // markdown, max 5,000 chars
	targets?: GuideTarget[];
	place?: string; // human-readable location when there is no point, e.g. an interior, max 120 chars
	samePlace?: boolean; // the place is the previous step's
	reward?: string; // plain text, max 500 chars
	consequence?: string; // plain text, shown prominently, max 1,000 chars
	optional?: boolean;
	missable?: boolean;
	thread?: string; // free-text tag such as a questline, /^.{1,40}$/
	only?: Record<string, string[]>; // variant id -> option ids for which this step is shown
	links?: { url: string; label?: string }[]; // http(s) only, max 5 links, label max 80 chars
	zone?: GuideZone; // milestone M6; accepted and preserved in the validator from M1
}

export type GuideTarget = {
	optional?: boolean; // does not block completion
	label?: string; // overrides the displayed title
	snapshot?: { title: string; cat?: string; lat: number; lng: number; map: string }; // fallback if the marker disappears
} & ({ kind: "marker"; marker: number } | { kind: "point"; point: { lat: number; lng: number; map: string } });

export interface GuideZone {
	map: string;
	region?: number; // a region id from the game's data
	polygon?: { lng: number; lat: number }[]; // an author-drawn area, max 500 points
	avoid?: { marker?: number; polygon?: { lng: number; lat: number }[]; note: string }[]; // max 30 entries
}

// Stored in the profile, one entry per guide id that has been touched.
export interface GuideProgress {
	done?: Record<string, number>; // step id -> epoch seconds (not ms), manual done flags for steps without marker targets
	skipped?: string[]; // step ids (/^[A-Za-z0-9_-]{1,40}$/)
	cursor?: string; // step id; position-like, never a conflict
	variants?: Record<string, string>; // variant id -> chosen option id; view-like, never a conflict
	updated?: number; // ms since epoch
}

export interface Preset {
	id: string;
	name: string;
	hidden: number[];
}

export interface SyncItem {
	key: string;
	value: any;
	base?: number;
	updated_at?: number;
}

export interface SyncPushResult {
	key: string;
	status: "ok" | "conflict";
	updated_at: number;
	same?: boolean;
	value?: any;
}

export interface UserEmailEntry {
	id: string;
	email: string;
	verified: boolean;
	isPrimary: boolean;
	createdAt: number;
}

export interface UserAuthMethods {
	google: boolean;
	password: boolean;
	secretKey: boolean;
}

export interface UserAccount {
	id: string;
	provider: "google" | "secret" | "password";
	email: string | null;
	name: string;
	username?: string | null;
	displayName?: string;
	emails?: UserEmailEntry[];
	methods?: UserAuthMethods;
	createdAt?: number;
	sessions?: number;
	syncedItems?: number;
}

export interface GameStat {
	value: number;
	label: string;
}

export interface GameManifestEntry {
	id: string;
	slug: string;
	title: string;
	description?: string;
	poster?: string;
	posterAlt?: string;
	theme?: ThemePalette;
	stats?: GameStat[];
	tagLabel?: string;
	defaultTag?: number | string | null;
}

export interface TilesetMeta {
	name?: string;
	template: string;
	minzoom?: number;
	maxzoom?: number;
	viewMaxzoom?: number;
	tileSize?: number;
	bounds?: [number, number, number, number];
	// the colour of the empty area around the map ("#rrggbb"): what fills a missing quarter when a tile is stitched
	background?: string;
}

export interface MapMeta {
	id?: number;
	slug: string;
	title: string;
	data: string;
	compact?: string; // data.compact.json beside data.json, when the map has one (see compact-map.ts)
	tilesets: TilesetMeta[];
}

export type IconLayerDef = string | { cp: string; color?: string; ml?: string };

export interface GameIconsMeta {
	font?: string;
	image?: string;
	size?: number;
	glyphs?: Record<string, any>;
}

export interface GameMarkersMeta {
	json: string;
	png: string;
	json2x?: string;
	png2x?: string;
}

export interface GameMeta {
	id: string;
	title: string;
	tagLabel?: string;
	defaultTag?: number | string | null;
	markers?: GameMarkersMeta | null;
	icons?: GameIconsMeta | null;
	maps: MapMeta[];
}

export interface SessionSummary {
	v: 1;
	slug: string;
	updated: number;
	map: string;
	mapTitle: string;
	maps: { slug: string; title: string }[];
	profile: string | null;
	profileId: string | null;
	profiles: { id: string; name: string }[];
	tagLabel: string | null;
	tag: string | null;
	found: number;
	total: number;
	groups: { t: string; c: string; f: number; n: number }[];
	near: { t: string; c: string | null; f: number; n: number }[];
	recent: { t: string; cat: string; c: string | null; at?: number }[];
	session?: { found: number; start: number; end: number };
	guide?: {
		id: string;
		title: string;
		done: number;
		total: number;
		nextStep?: string | null;
	};
	userMarkers: number;
	drawings: number;
	presets: number;
}