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

import { DEFAULT_COLORS, DEFAULT_COMPLETE_FILL, EXCLUDED, completeFill, myColors, shadeComplete, type MapColors, type StreetColor } from "./colors";
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
      "search-pin": { type: "geojson", data: empty() },
      // While drawing with Snap on: the state, county and city lines it snaps to.
      "snap-lines": { type: "geojson", data: empty() },
      // While drawing: the team's areas of the same kind, to see and snap to.
      "draw-ref": { type: "geojson", data: empty() },
      // An area's streets still to sweep, when asked for ("Highlight what's left").
      "missing": { type: "geojson", data: empty() },
      // Zoomed out, where the team has swept: cells of covered streets, clustered.
      "coverage-cells": {
        type: "geojson", data: empty(), cluster: true, clusterRadius: 45, clusterMaxZoom: STREETS_MIN_ZOOM - 1,
        clusterProperties: { meters: ["+", ["get", "m"]] },
      },
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
        // Set by setShadeComplete: finished areas shaded bright green, or not.
        paint: { "fill-color": areaFill(DEFAULT_COMPLETE_FILL), "fill-opacity": areaFillOpacity(DEFAULT_COMPLETE_FILL) },
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
          "line-opacity": underSelection(streetOpacity(DEFAULT_COLORS)),
        },
      },
      // Streets picked with shift-click: bright orange, pulsing (see setSelectedStreets).
      {
        id: "streets-selected", type: "line", source: "streets", "source-layer": "streets",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ff7a00",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 9, 19, 16],
          "line-opacity": 0,
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
      // Dots for driven ground while zoomed too far out for streets: bigger for more miles.
      {
        id: "coverage-cells", type: "circle", source: "coverage-cells", maxzoom: STREETS_MIN_ZOOM,
        paint: {
          "circle-color": DEFAULT_COLORS.driven.color,
          "circle-opacity": 0.85,
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "meters"], ["get", "m"]],
            0, 5, 5000, 9, 50000, 15, 500000, 24],
        },
      },
      // What's left in an area: dark-cased bright yellow, unlike any street colour, with a
      // dot on each street so a stub of a few feet still shows at area zoom.
      { id: "missing-casing", type: "line", source: "missing", filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#111827", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 12] } },
      { id: "missing-line", type: "line", source: "missing", filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffd60a", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] } },
      { id: "missing-dot", type: "circle", source: "missing", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 7, "circle-color": "#ffd60a", "circle-stroke-color": "#111827", "circle-stroke-width": 2.5 } },
      {
        id: "draw-ref", type: "line", source: "draw-ref", layout: { "line-join": "round" },
        paint: { "line-color": ["coalesce", ["get", "color"], AREA_COLOR], "line-width": 2.5, "line-opacity": 0.9 },
      },
      {
        id: "snap-lines", type: "line", source: "snap-lines",
        paint: { "line-color": "#7c3aed", "line-width": 2, "line-opacity": 0.55, "line-dasharray": [3, 2] },
      },
      // An address found with the search box.
      {
        id: "search-pin", type: "circle", source: "search-pin",
        paint: { "circle-radius": 9, "circle-color": "#e2721f", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
      },
      {
        id: "preview-line", type: "line", source: "preview", layout: { "line-join": "round" },
        paint: { "line-color": "#e2721f", "line-width": 3, "line-dasharray": [2, 1.5] },
      },
    ],
  };
}

/** How faint a highway the team doesn't count is drawn (see migration 0015). */
export const NOT_COUNTED_OPACITY = 0.3;

/** A street picked with shift-click hides under its orange, so the pulse reads clean. */
const underSelection = (opacity: unknown) =>
  ["case", ["boolean", ["feature-state", "selected"], false], 0, opacity] as unknown as number;

/** Street colour by coverage state, hovered streets drawn darker. */
/** A team area's fill: its own colour, or (shading on) bright green once it's finished. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MapLibre's expression types
function areaFill(shade: StreetColor | null): any {
  const own = ["coalesce", ["get", "color"], AREA_COLOR];
  return shade ? ["case", ["boolean", ["get", "complete"], false], shade.color, own] : own;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function areaFillOpacity(shade: StreetColor | null): any {
  const selected = ["boolean", ["feature-state", "selected"], false];
  const normal = ["case", selected, 0.16, 0.06];
  return shade
    ? ["case", ["boolean", ["get", "complete"], false], ["case", selected, Math.min(1, shade.opacity + 0.08), shade.opacity], normal]
    : normal;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MapLibre's expression types
function streetColor(c: MapColors): any {
  return ["case", ["boolean", ["feature-state", "hover"], false], "#0d1b28",
    ["match", ["get", "state"], ["done", "complete"], c.driven.color, "excluded", EXCLUDED_COLOR, c.undriven.color]];
  // ("nc": a highway the team doesn't count, drawn in the to-do colour but faint.)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function streetOpacity(c: MapColors): any {
  return ["match", ["get", "state"], ["done", "complete"], c.driven.opacity, "excluded", 0.7, "nc", NOT_COUNTED_OPACITY, c.undriven.opacity];
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
  onStreetShiftClick: ((s: StreetHit) => void) | null = null;
  private selectedStreets = new Set<number>();
  private pulseFrame = 0;
  onAreaClick: ((id: string, at: [number, number]) => void) | null = null;
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
      // Shift-click picks streets (several at once); the shift-drag box zoom would eat it.
      boxZoom: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    this.map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), "bottom-right");
    this.map.addControl(new ScaleControl({ unit: "imperial" }), "bottom-left");
    // Every map draws streets in the person's own colours, and shades finished areas if they like.
    this.setStreetColors(myColors());
    this.setShadeComplete(shadeComplete() ? completeFill() : null);

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
    this.map.on("mouseenter", "coverage-cells", () => { if (!this.picking) this.map.getCanvas().style.cursor = "pointer"; });
    this.map.on("mouseleave", "coverage-cells", () => { if (!this.picking) this.map.getCanvas().style.cursor = ""; });
    // One click handler: a street first (it's on top), then a team area.
    this.map.on("click", (e: MapMouseEvent) => {
      if (this.picking) {
        const done = this.picking;
        this.pick(null);
        done([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      if (this.busy) return;
      // A dot of driven ground: zoom in on it (a cluster opens up; a single cell shows its streets).
      const cell = this.map.queryRenderedFeatures(e.point, { layers: ["coverage-cells"] })[0];
      if (cell) {
        const [lon, lat] = (cell.geometry as GeoJSON.Point).coordinates;
        const clusterId = cell.properties?.cluster_id;
        if (clusterId != null) {
          (this.map.getSource("coverage-cells") as GeoJSONSource).getClusterExpansionZoom(clusterId)
            .then((z) => this.map.easeTo({ center: [lon, lat], zoom: Math.min(z, STREETS_MIN_ZOOM + 1) }), () => {});
        } else this.map.easeTo({ center: [lon, lat], zoom: STREETS_MIN_ZOOM + 1 });
        return;
      }
      const place = this.map.queryRenderedFeatures(e.point, { layers: ["places"] })[0];
      if (place) {
        const [lon, lat] = (place.geometry as GeoJSON.Point).coordinates;
        this.onPlaceClick?.(String(place.properties.id), [lon, lat]);
        return;
      }
      const hits = this.map.queryRenderedFeatures(e.point, { layers: ["streets", "team-areas-fill"] });
      // Streets are thin: a few pixels either side still count as clicking one.
      const T = 5;
      const street = hits.find((f) => f.layer.id === "streets")
        ?? this.map.queryRenderedFeatures([[e.point.x - T, e.point.y - T], [e.point.x + T, e.point.y + T]], { layers: ["streets"] })[0];
      if (street) {
        const p = street.properties as { highway: string; name?: string; length_m: number; state?: StreetHit["state"] };
        const hit: StreetHit = { id: street.id as number, name: p.name ?? null, highway: p.highway, length_m: p.length_m, state: p.state ?? null };
        // Shift held: add it to (or take it out of) a selection of several, no popup.
        if (e.originalEvent.shiftKey && this.onStreetShiftClick) this.onStreetShiftClick(hit);
        else this.onStreetClick?.(hit, [e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      // Shift is for picking streets: a shift-click that misses one does nothing else.
      if (e.originalEvent.shiftKey && this.onStreetShiftClick) return;
      const area = hits.find((f) => f.layer.id === "team-areas-fill");
      if (area) this.onAreaClick?.(String(area.id), [e.lngLat.lng, e.lngLat.lat]);
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
  /** Resolves once the map's style is in (drawing tools need it before they can start). */
  ready(): Promise<void> {
    return new Promise((ok) => this.whenReady(ok));
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

  /** Only show areas (team areas and public boundaries) of these levels: the map's View menu. */
  setAreaLevels(levels: string[]) {
    this.whenReady(() => {
      const filter = ["in", ["get", "level"], ["literal", levels]] as any;
      for (const id of ["boundaries", "team-areas-fill", "team-areas-line"]) this.map.setFilter(id, filter);
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

  /**
   * Highlight what's left in an area (null clears it): each street's pieces as lines, and
   * a dot on each. Zooms to them, so a lone stub at the edge is brought into view.
   */
  setMissing(streets: { geometry: GeoJSON.Geometry; at: [number, number] }[] | null, opts: { left?: number; fit?: boolean } = {}) {
    this.whenReady(() => {
      const features: GeoJSON.Feature[] = (streets ?? []).flatMap((st) => [
        { type: "Feature", properties: {}, geometry: st.geometry },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: st.at } },
      ]);
      (this.map.getSource("missing") as GeoJSONSource).setData({ type: "FeatureCollection", features });
      if (!streets?.length || opts.fit === false) return;
      const xs = streets.map((st) => st.at[0]), ys = streets.map((st) => st.at[1]);
      const pad = 0.0015;
      this.fitBounds([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad], { left: opts.left, animate: true });
    });
  }

  /** Go to one of what's left. */
  flyTo(at: [number, number], zoom = 17) {
    this.map.flyTo({ center: at, zoom: Math.max(this.map.getZoom(), zoom), duration: 700 });
  }

  /**
   * The streets picked with shift-click: drawn bright orange, pulsing, for as long as
   * there are any. Marked through the tiles' own features, so they stay lit as the map
   * moves and tiles reload.
   */
  setSelectedStreets(ids: Iterable<number>) {
    const next = new Set(ids);
    this.whenReady(() => {
      for (const id of this.selectedStreets) if (!next.has(id)) this.map.setFeatureState({ source: "streets", sourceLayer: "streets", id }, { selected: false });
      for (const id of next) if (!this.selectedStreets.has(id)) this.map.setFeatureState({ source: "streets", sourceLayer: "streets", id }, { selected: true });
      this.selectedStreets = next;
      if (next.size && !this.pulseFrame) this.pulse();
      if (!next.size) {
        cancelAnimationFrame(this.pulseFrame);
        this.pulseFrame = 0;
        this.map.setPaintProperty("streets-selected", "line-opacity", 0);
      }
    });
  }

  private pulse() {
    let last = 0;
    const tick = (t: number) => {
      this.pulseFrame = requestAnimationFrame(tick);
      if (t - last < 50) return; // twenty frames a second is smooth enough for a glow
      last = t;
      // A beat about once a second: brighter and a touch wider, never faint enough for the
      // street's own colour to muddy the orange.
      const beat = 0.5 + 0.5 * Math.sin((t / 1100) * 2 * Math.PI);
      this.map.setPaintProperty("streets-selected", "line-opacity",
        ["case", ["boolean", ["feature-state", "selected"], false], 0.55 + 0.45 * beat, 0]);
      const w = 1 + 0.35 * beat;
      this.map.setPaintProperty("streets-selected", "line-width",
        ["interpolate", ["linear"], ["zoom"], 12, 4 * w, 16, 9 * w, 19, 16 * w]);
    };
    this.pulseFrame = requestAnimationFrame(tick);
  }

  /** Driven ground for the zoomed-out dots: [lon, lat, metres, segments] per cell. */
  setCoverageCells(cells: [number, number, number, number][]) {
    this.whenReady(() => (this.map.getSource("coverage-cells") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: cells.map(([lon, lat, m, n]) => ({ type: "Feature", properties: { m, n }, geometry: { type: "Point", coordinates: [lon, lat] } })),
    }));
  }

  /**
   * Go to an address from the search box and pin it. A place with an outline of its
   * own (a street, a park) is framed; a single address is zoomed to street level.
   */
  showSearchResult(lon: number, lat: number, bbox: [number, number, number, number] | null, opts: { left?: number } = {}) {
    this.whenReady(() => (this.map.getSource("search-pin") as GeoJSONSource).setData({
      type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] } }],
    }));
    const small = bbox && bbox[2] - bbox[0] < 0.05 && bbox[3] - bbox[1] < 0.05 && bbox[2] - bbox[0] > 0.0005;
    if (bbox && small) this.fitBounds(bbox, { left: opts.left, animate: true });
    else this.map.flyTo({ center: [lon, lat], zoom: 17, duration: 800, padding: { left: opts.left ?? 0, top: 0, right: 0, bottom: 0 } });
  }

  clearSearchResult() {
    this.whenReady(() => (this.map.getSource("search-pin") as GeoJSONSource).setData(empty()));
  }

  /** Finished areas in your shade (Preferences), or with null in their own colour like the rest. */
  setShadeComplete(on: StreetColor | null) {
    this.whenReady(() => {
      this.map.setPaintProperty("team-areas-fill", "fill-color", areaFill(on));
      this.map.setPaintProperty("team-areas-fill", "fill-opacity", areaFillOpacity(on));
    });
  }

  /**
   * Streets drawn plain, with no coverage: the Areas page, where you draw outlines against
   * the streets but drive history isn't the point.
   */
  setPlainStreets() {
    this.whenReady(() => {
      this.map.setPaintProperty("streets", "line-color", ["case", ["boolean", ["feature-state", "hover"], false], "#3d4b59", "#8b98a6"]);
      this.map.setPaintProperty("streets", "line-opacity", 0.75);
      for (const id of ["drive-streets", "drive-track", "coverage-cells"]) this.map.setLayoutProperty(id, "visibility", "none");
    });
  }

  /** The person's street colours (Preferences). */
  setStreetColors(c: MapColors) {
    this.whenReady(() => {
      this.map.setPaintProperty("streets", "line-color", streetColor(c));
      this.map.setPaintProperty("streets", "line-opacity", underSelection(streetOpacity(c)));
      this.map.setPaintProperty("drive-streets", "line-color", c.driven.color);
      this.map.setPaintProperty("coverage-cells", "circle-color", c.driven.color);
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

  closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  /** A popup with live content; `onClose` runs when it goes, however it goes. */
  showPopupEl(at: [number, number], el: HTMLElement, onClose?: () => void) {
    this.popup?.remove();
    const p = new Popup({ closeButton: true, maxWidth: "280px", offset: 8 }).setLngLat(at).setDOMContent(el);
    if (onClose) p.on("close", onClose);
    this.popup = p.addTo(this.map);
  }

  /** While drawing: the areas shown to snap to (their own colours, outline only); none to clear. */
  setDrawReference(features: GeoJSON.Feature[]) {
    this.whenReady(() => (this.map.getSource("draw-ref") as GeoJSONSource).setData({ type: "FeatureCollection", features }));
  }

  /** The boundary lines a drawing snaps to, shown dashed; none to clear. */
  setSnapLines(lines: [number, number][][]) {
    this.whenReady(() => (this.map.getSource("snap-lines") as GeoJSONSource).setData(lines.length
      ? { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } }
      : empty()));
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
    cancelAnimationFrame(this.pulseFrame);
    this.popup?.remove();
    this.map.remove();
  }
}
