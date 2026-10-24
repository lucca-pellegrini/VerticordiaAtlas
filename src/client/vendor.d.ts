// Ambient type declarations for vendored browser globals and modules.

declare namespace maplibregl {
	interface LngLatLike {
		lng: number;
		lat: number;
	}
	interface LngLat {
		lng: number;
		lat: number;
	}
	interface Point {
		x: number;
		y: number;
	}
	interface LngLatBounds {
		contains(lnglat: [number, number] | LngLatLike): boolean;
		getWest(): number;
		getSouth(): number;
		getEast(): number;
		getNorth(): number;
	}
	class Map {
		constructor(options: Record<string, any>);
		on(type: string, listener: (...args: any[]) => void): this;
		on(type: string, layer: string, listener: (...args: any[]) => void): this;
		once(type: string, listener: (...args: any[]) => void): this;
		off(type: string, listener: (...args: any[]) => void): this;
		addControl(control: any, position?: string): this;
		getContainer(): HTMLElement;
		getCanvasContainer(): HTMLElement;
		getCanvas(): HTMLCanvasElement;
		getCenter(): LngLat;
		getZoom(): number;
		getMinZoom(): number;
		getMaxZoom(): number;
		getBounds(): LngLatBounds;
		setMinZoom(minZoom: number | null): this;
		setMaxZoom(maxZoom: number | null): this;
		setMaxBounds(bounds: [[number, number], [number, number]] | [number, number, number, number] | null): this;
		project(lnglat: [number, number] | LngLatLike): Point;
		unproject(point: [number, number] | { x: number; y: number }): LngLat;
		jumpTo(options: { center?: [number, number] | LngLatLike; zoom?: number }): this;
		easeTo(options: Record<string, any>): this;
		flyTo(options: Record<string, any>): this;
		fitBounds(
			bounds: [number, number, number, number] | [[number, number], [number, number]],
			options?: Record<string, any>,
		): this;
		resize(): this;
		triggerRepaint(): void;
		stop(): this;
		isMoving(): boolean;
		areTilesLoaded(): boolean;
		hasImage(id: string): boolean;
		addImage(id: string, image: any, options?: Record<string, any>): this;
		getSource(id: string): any;
		addSource(id: string, source: Record<string, any>): this;
		removeSource(id: string): this;
		getLayer(id: string): any;
		addLayer(layer: Record<string, any>, beforeId?: string): this;
		removeLayer(id: string): this;
		setLayoutProperty(layerId: string, name: string, value: any): this;
		setPaintProperty(layerId: string, name: string, value: any): this;
		setFilter(layerId: string, filter: any): this;
		queryRenderedFeatures(geometry?: any, options?: Record<string, any>): any[];
		dragPan: { enable(): void; disable(): void };
		boxZoom: { enable(): void; disable(): void };
	}
	class NavigationControl {
		constructor(options?: Record<string, any>);
	}
	class AttributionControl {
		constructor(options?: Record<string, any>);
	}
}

declare const marked: {
	use(ext: Record<string, any>): void;
	parse(src: string): string;
	Parser: {
		parse(tokens: any[]): string;
		parseInline(tokens: any[]): string;
	};
};

declare module "../../../public/vendor/perfect-freehand.mjs" {
	export function getStroke(points: number[][], options?: Record<string, any>): number[][];
}