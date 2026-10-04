// The map: basemaps from the server's tile cache, streets as vector tiles from PostGIS.
import {
  Map as MlMap, NavigationControl, ScaleControl, GeolocateControl, Popup, setWorkerUrl,
  type GeoJSONSource, type VectorTileSource, type MapLayerMouseEvent, type MapMouseEvent, type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre looks for its worker beside its own file, which bundling moves: so the worker
// is bundled on its own and MapLibre told where it went.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);

export type Base = "map" | "satellite" | "hybrid";
/** Streets come from the server from this zoom in (a tile further out would hold a city). */
export const STREETS_MIN_ZOOM = 12;

import { DEFAULT_COLORS, EXCLUDED, myColors, type MapColors } from "./colors";
/** Left-out streets go grey whatever colours someone picked for driven and not. */
export const EXCLUDED_COLOR = EXCLUDED;
export const TRACK_COLOR = "#e2721f";
/** Your places; ones shared with you by others are purple. */
export const PLACE_COLOR = "#c2185b";
export const AREA_COLOR = "#1e8a28";
const empty = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });

function style(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: { type: "raster", tiles: ["/api/tiles/osm/{z}/{x}/{y}"], tileSize: 256, maxzoom: 19,
             attribution: "© OpenStreetMap contributors" },
      sat: { type: "raster", tiles: ["/api/tiles/sat/{z}/{x}/{y}"], tileSize: 256, maxzoom: 19,
             attribution: "Imagery © Esri" },
      ref: { type: "raster", tiles: ["/api/tiles/ref/{z}/{x}/{y}"], tileSize: 256, maxzoom: 19 },
      streets: { type: "vector", tiles: [`${location.origin}/api/tiles/streets/{z}/{x}/{y}`],
                 // Each street's segment id is the tile feature's own id (ST_AsMVT's id column).
                 minzoom: STREETS_MIN_ZOOM, maxzoom: 16 },
      boundaries: { type: "vector", tiles: [`${location.origin}/api/tiles/areas/{z}/{x}/{y}`], maxzoom: 14 },
      "team-areas": { type: "geojson", data: empty(), promoteId: "id" },
      preview: { type: "geojson", data: empty() },
      "drive-streets": { type: "geojson", data: empty() },
      "drive-track": { type: "geojson", data: empty() },
      places: { type: "geojson", data: empty(), promoteId: "id" },
    },
    layers: [
      { id: "base-osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.35 } },
      { id: "base-sat", type: "raster", source: "sat", layout: { visibility: "none" } },
      { id: "base-ref", type: "raster", source: "ref", layout: { visibility: "none" } },
      // Public boundaries for context: the state, then counties, then cities as you zoom.
      {
        id: "boundaries", type: "line", source: "boundaries", "source-layer": "areas",
        paint: {
          "line-color": "#6b7c8f", "line-opacity": 0.75, "line-dasharray": [3, 2],
          "line-width": ["match", ["get", "level"], "state", 2, "county", 1.4, 1],
        },
      },
      {
        id: "team-areas-fill", type: "fill", source: "team-areas",
        paint: {
          "fill-color": ["coalesce", ["get", "color"], AREA_COLOR],
          "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.16, 0.06],
        },
      },
      {
        id: "streets-casing", type: "line", source: "streets", "source-layer": "streets",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-opacity": 0.9,
                 "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 7, 19, 14] },
      },
      {
        id: "streets", type: "line", source: "streets", "source-layer": "streets",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          // Set from the person's preferences (setStreetColors); these are the defaults.
          "line-color": streetColor(DEFAULT_COLORS),
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 4, 19, 9],
          "line-opacity": streetOpacity(DEFAULT_COLORS),
        },
      },
      {
        id: "team-areas-line", type: "line", source: "team-areas",
        layout: { "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "color"], AREA_COLOR],
          "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 4, 2.2],
        },
      },
      // One drive, on its own page: the streets it was matched to, under the raw GPS track.
      {
        id: "drive-streets", type: "line", source: "drive-streets", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": DEFAULT_COLORS.driven.color, "line-opacity": 0.55,
                 "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 11, 19, 18] },
      },
      {
        id: "drive-track", type: "line", source: "drive-track", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": TRACK_COLOR, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 3.5, 19, 5] },
      },
      // Places: a dot, pink for yours, purple for ones shared with you (names show on click;
      // the style has no font glyphs for map labels).
      {
        id: "places", type: "circle", source: "places",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 16, 8],
          "circle-color": ["case", ["boolean", ["get", "mine"], false], PLACE_COLOR, "#8e44ad"],
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
        },
      },
      {
        id: "preview-line", type: "line", source: "preview", layout: { "line-join": "round" },
        paint: { "line-color": "#e2721f", "line-width": 3, "line-dasharray": [2, 1.5] },
      },
    ],
  };
}

/** Street colour by coverage state, hovered streets drawn darker. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MapLibre's expression types
function streetColor(c: MapColors): any {
  return ["case", ["boolean", ["feature-state", "hover"], false], "#0d1b28",
    ["match", ["get", "state"], ["done", "complete"], c.driven.color, "excluded", EXCLUDED_COLOR, c.undriven.color]];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function streetOpacity(c: MapColors): any {
  return ["match", ["get", "state"], ["done", "complete"], c.driven.opacity, "excluded", 0.7, c.undriven.opacity];
}

export interface StreetHit {
  id: number;
  name: string | null;
  highway: string;
  length_m: number;
  /** For the coverage team: driven, marked complete, left out, or not yet. */
  state: "done" | "complete" | "excluded" | null;
}

export class MapController {
  map: MlMap;
  onStreetClick: ((s: StreetHit, at: [number, number]) => void) | null = null;
  onAreaClick: ((id: string) => void) | null = null;
  onPlaceClick: ((id: string, at: [number, number]) => void) | null = null;
  /** While set, the next click on the map is a spot being picked (a new place). */
  private picking: ((at: [number, number]) => void) | null = null;
  /** While drawing, clicks belong to the drawing, not to areas and streets. */
  busy = false;
  private hovered: number | null = null;
  private selectedArea: string | null = null;
  private popup: Popup | null = null;
  /** Whose coverage the streets are coloured by. */
  coverageTeam: string | null = null;
  private coverageRev = 0;

  constructor(container: HTMLElement, center: [number, number] = [-97.74, 30.27], zoom = 11) {
    this.map = new MlMap({
      container,
      style: style(),
      center,
      zoom,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    this.map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), "bottom-right");
    this.map.addControl(new ScaleControl({ unit: "imperial" }), "bottom-left");
    // Every map draws streets in the person's own colours.
    this.setStreetColors(myColors());

    this.map.on("mousemove", "streets", (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.id as number | undefined;
      if (id === undefined || id === this.hovered) return;
      this.clearHover();
      this.hovered = id;
      this.map.setFeatureState({ source: "streets", sourceLayer: "streets", id }, { hover: true });
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", "streets", () => this.clearHover());
    this.map.on("mouseenter", "places", () => { if (!this.picking) this.map.getCanvas().style.cursor = "pointer"; });
    this.map.on("mouseleave", "places", () => { if (!this.picking) this.map.getCanvas().style.cursor = ""; });
    // One click handler: a street first (it's on top), then a team area.
    this.map.on("click", (e: MapMouseEvent) => {
      if (this.picking) {
        const done = this.picking;
        this.pick(null);
        done([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      if (this.busy) return;
      const place = this.map.queryRenderedFeatures(e.point, { layers: ["places"] })[0];
      if (place) {
        const [lon, lat] = (place.geometry as GeoJSON.Point).coordinates;
        this.onPlaceClick?.(String(place.properties.id), [lon, lat]);
        return;
      }
      const hits = this.map.queryRenderedFeatures(e.point, { layers: ["streets", "team-areas-fill"] });
      const street = hits.find((f) => f.layer.id === "streets");
      if (street) {
        const p = street.properties as { highway: string; name?: string; length_m: number; state?: StreetHit["state"] };
        this.onStreetClick?.({ id: street.id as number, name: p.name ?? null, highway: p.highway, length_m: p.length_m, state: p.state ?? null },
          [e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      const area = hits.find((f) => f.layer.id === "team-areas-fill");
      if (area) this.onAreaClick?.(String(area.id));
    });
  }

  /** Wait for a click on the map, crosshair cursor meanwhile; null cancels. */
  pick(then: ((at: [number, number]) => void) | null) {
    this.picking = then;
    this.map.getCanvas().style.cursor = then ? "crosshair" : "";
  }

  setPlaces(places: { id: string; name: string; lon: number; lat: number; mine: boolean }[]) {
    this.whenReady(() => (this.map.getSource("places") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: places.map((p) => ({ type: "Feature", properties: { id: p.id, name: p.name, mine: p.mine }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })),
    }));
  }

  showPlaces(on: boolean) {
    this.whenReady(() => {
      for (const id of ["places"]) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    });
  }

  private clearHover() {
    if (this.hovered !== null) this.map.setFeatureState({ source: "streets", sourceLayer: "streets", id: this.hovered }, { hover: false });
    this.hovered = null;
    if (!this.picking) this.map.getCanvas().style.cursor = "";
  }

  /**
   * Run once the style is ready (sources can't be touched before). Not isStyleLoaded():
   * that also waits for every tile in view, and after the one "style.load" event has
   * passed, waiting for it again never ends.
   */
  private styleIn() {
    return Boolean((this.map as unknown as { style?: { _loaded?: boolean } }).style?._loaded);
  }
  private whenReady(fn: () => void) {
    if (this.styleIn()) fn();
    else this.map.once("style.load", fn);
  }

  setTeamAreas(features: GeoJSON.Feature[]) {
    this.whenReady(() => {
      (this.map.getSource("team-areas") as GeoJSONSource).setData({ type: "FeatureCollection", features });
      if (this.selectedArea) this.setSelectedArea(this.selectedArea);
    });
  }

  setSelectedArea(id: string | null) {
    this.whenReady(() => {
      if (this.selectedArea) this.map.setFeatureState({ source: "team-areas", id: this.selectedArea }, { selected: false });
      this.selectedArea = id;
      if (id) this.map.setFeatureState({ source: "team-areas", id }, { selected: true });
    });
  }

  /** A public area being looked at but not followed: a dashed outline. */
  setPreview(geometry: GeoJSON.Geometry | null) {
    this.whenReady(() => {
      (this.map.getSource("preview") as GeoJSONSource).setData(
        geometry ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] } : empty(),
      );
    });
  }

  /** The whole street network: off on a drive's page, so the drive is what you see. */
  showStreets(on: boolean) {
    this.whenReady(() => {
      for (const id of ["streets", "streets-casing"]) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    });
  }

  /** Hide areas while drawing, so the drawing is what you see. */
  showAreas(on: boolean) {
    this.whenReady(() => {
      for (const id of ["team-areas-fill", "team-areas-line", "preview-line"]) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    });
  }

  /** Colour streets by a team's coverage (null: plain streets). */
  setCoverageTeam(teamId: string | null) {
    if (teamId === this.coverageTeam) return;
    this.coverageTeam = teamId;
    this.reloadStreets();
  }

  /** Coverage changed (a mark, a drive landing): fetch the street tiles again. */
  refreshCoverage() {
    this.coverageRev++;
    this.reloadStreets();
  }

  private reloadStreets() {
    const q = this.coverageTeam ? `?team=${this.coverageTeam}&v=${this.coverageRev}` : "";
    this.whenReady(() => (this.map.getSource("streets") as VectorTileSource).setTiles([`${location.origin}/api/tiles/streets/{z}/{x}/{y}${q}`]));
  }

  /** A drive's GPS track and matched streets; framed unless told not to. */
  setDrive(track: GeoJSON.Geometry | null, streets: GeoJSON.Geometry | null) {
    const fc = (g: GeoJSON.Geometry | null): GeoJSON.FeatureCollection =>
      g ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: g }] } : empty();
    this.whenReady(() => {
      (this.map.getSource("drive-track") as GeoJSONSource).setData(fc(track));
      (this.map.getSource("drive-streets") as GeoJSONSource).setData(fc(streets));
    });
    const coords = track?.type === "LineString" ? track.coordinates : [];
    if (coords.length) {
      const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
      this.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }

  /** The person's street colours (Preferences). */
  setStreetColors(c: MapColors) {
    this.whenReady(() => {
      this.map.setPaintProperty("streets", "line-color", streetColor(c));
      this.map.setPaintProperty("streets", "line-opacity", streetOpacity(c));
      this.map.setPaintProperty("drive-streets", "line-color", c.driven.color);
    });
  }

  setBase(base: Base) {
    const show = (id: string, on: boolean) => this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    const go = () => {
      show("base-osm", base === "map");
      show("base-sat", base !== "map");
      show("base-ref", base === "hybrid");
    };
    this.whenReady(go);
  }

  showPopup(at: [number, number], html: string) {
    this.popup?.remove();
    this.popup = new Popup({ closeButton: true, maxWidth: "260px", offset: 8 }).setLngLat(at).setHTML(html).addTo(this.map);
  }

  /** A popup with live content; `onClose` runs when it goes, however it goes. */
  showPopupEl(at: [number, number], el: HTMLElement, onClose?: () => void) {
    this.popup?.remove();
    const p = new Popup({ closeButton: true, maxWidth: "280px", offset: 8 }).setLngLat(at).setDOMContent(el);
    if (onClose) p.on("close", onClose);
    this.popup = p.addTo(this.map);
  }

  fitBounds(b: [number, number, number, number], opts: { left?: number; animate?: boolean } = {}) {
    this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
      padding: { top: 60, bottom: 60, right: 60, left: 60 + (opts.left ?? 0) },
      duration: opts.animate ? 600 : 0, maxZoom: 16,
    });
  }

  /** Keep the canvas sized to its box (sidebars and window changes). */
  watchSize(el: HTMLElement) {
    const ro = new ResizeObserver(() => this.map.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }

  destroy() {
    this.popup?.remove();
    this.map.remove();
  }
}
