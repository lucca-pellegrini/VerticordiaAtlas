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
	created: number;
	updated: number;
	map?: string | null;
	cameras?: Record<string, Camera>;
	view?: Record<string, SavedMapView>;
	drawings?: DrawingItem[];
	userCats?: UserCategory[];
	userMarkers?: UserMarker[];
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

export interface UserAccount {
	id: string;
	provider: "google" | "secret";
	email: string | null;
	name: string;
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
	recent: { t: string; cat: string; c: string | null }[];
	userMarkers: number;
	drawings: number;
	presets: number;
}