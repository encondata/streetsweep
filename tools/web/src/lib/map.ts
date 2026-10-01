import { Map as MlMap, NavigationControl, ScaleControl, LngLatBounds, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre looks for its worker beside its own file, which bundling moves: so the worker
// is bundled on its own and MapLibre told where it went.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
import type { Area, LatLng, Ring, StreetStatus } from "./types";
import { LEVEL_COLOR } from "./levels";
import { toLngLat, type Box } from "./geo";

export type Base = "map" | "satellite" | "hybrid";

/** One street as the map draws it; `i` indexes the network it came from. */
export interface StreetFeature { i: number; id: number; name: string | null; status: StreetStatus; line: LatLng[] }

export interface AreaStyle { id: number; fraction: number | null; focus: boolean; dim: boolean }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function style(): StyleSpecification {
  return {
    version: 8,
    sources: {
      // The server's own tile cache: each tile is fetched from OpenStreetMap or Esri once.
      osm: { type: "raster", tiles: ["/tiles/osm/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19,
             attribution: "© OpenStreetMap contributors" },
      sat: { type: "raster", tiles: ["/tiles/sat/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 19,
             attribution: "Imagery © Esri" },
      ref: { type: "raster", tiles: ["/tiles/ref/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19 },
    },
    layers: [
      { id: "base-osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.35 } },
      { id: "base-sat", type: "raster", source: "sat", layout: { visibility: "none" } },
      { id: "base-ref", type: "raster", source: "ref", layout: { visibility: "none" } },
    ],
  };
}

const empty = { type: "FeatureCollection" as const, features: [] as GeoJSON.Feature[] };

/**
 * The one map. Screens hand it what to show and tell it what to do with a click; it
 * knows nothing about which screen is open.
 */
export class MapController {
  map: MlMap;
  ready: Promise<void>;
  onAreaClick: ((id: number) => void) | null = null;
  onStreetClick: ((f: StreetFeature, at: [number, number]) => void) | null = null;
  onMapClick: ((at: LatLng) => void) | null = null;
  onMove: ((b: Box, zoom: number) => void) | null = null;
  /** While drawing, clicks belong to the drawing, not to areas and streets. */
  busy = false;

  private streets: StreetFeature[] = [];

  constructor(container: HTMLElement) {
    this.map = new MlMap({
      container,
      style: style(),
      center: [-95.55, 30.35],
      zoom: 9,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    this.map.addControl(new ScaleControl({ unit: "imperial" }), "bottom-left");
    // Ready once the style is: the panels must not wait for every map tile to arrive,
    // some of which the server may still be fetching from OpenStreetMap.
    this.ready = new Promise((resolve) => {
      let done = false;
      // isStyleLoaded() also waits for every tile in view, which is what made the panels
      // hang on a slow one; the style itself having loaded is all the layers need.
      const styleIn = () => Boolean((this.map as unknown as { style?: { _loaded?: boolean } }).style?._loaded);
      const go = () => {
        if (done || !styleIn()) return;
        done = true;
        if (!this.map.getSource("areas")) this.addLayers();
        resolve();
      };
      // Whichever comes first: the event, or seeing it loaded (the event can come and go
      // before anything is listening).
      this.map.on("style.load", go);
      const poll = () => { go(); if (!done) setTimeout(poll, 50); };
      poll();
    });
    // The panel opens and closes beside it, and the first layout can land after the map
    // has measured itself: follow the container's size, whatever changes it.
    this.resizer = new ResizeObserver(() => this.map.resize());
    this.resizer.observe(container);
  }

  private resizer: ResizeObserver;

  remove() {
    this.resizer.disconnect();
    this.map.remove();
  }

  private addLayers() {
    const m = this.map;
    m.addSource("areas", { type: "geojson", data: empty });
    m.addSource("streets", { type: "geojson", data: empty });
    m.addSource("preview", { type: "geojson", data: empty });

    m.addLayer({
      id: "areas-fill", type: "fill", source: "areas",
      paint: {
        "fill-color": ["get", "color"],
        "fill-opacity": ["case", ["get", "focus"], 0.04, ["get", "dim"], 0.02, 0.12],
      },
    });
    m.addLayer({
      id: "areas-line", type: "line", source: "areas",
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["case", ["get", "focus"], 3, 1.6],
        "line-opacity": ["case", ["get", "dim"], 0.35, 0.9],
      },
    });
    m.addLayer({
      id: "streets-casing", type: "line", source: "streets",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 14, 5, 17, 10],
      },
    });
    m.addLayer({
      id: "streets-line", type: "line", source: "streets",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": this.statusColors(),
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.4, 14, 3, 17, 6.5],
      },
    });
    m.addLayer({
      id: "streets-sel", type: "line", source: "streets",
      filter: ["==", ["get", "id"], -1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#7c3aed", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 4, 14, 7, 17, 12], "line-opacity": 0.55 },
    });
    // Wide and invisible: a street is easy to hit without having to land on a hairline.
    m.addLayer({
      id: "streets-hit", type: "line", source: "streets",
      paint: { "line-color": "#000", "line-opacity": 0, "line-width": 18 },
    });
    m.addLayer({
      id: "preview-fill", type: "fill", source: "preview",
      paint: { "fill-color": "#e2721f", "fill-opacity": 0.08 },
    });
    m.addLayer({
      id: "preview-line", type: "line", source: "preview",
      paint: { "line-color": "#e2721f", "line-width": 2.5, "line-dasharray": [3, 2] },
    });

    m.on("click", (e) => this.click(e));
    m.on("mousemove", "streets-hit", () => { if (!this.busy) m.getCanvas().style.cursor = "pointer"; });
    m.on("mouseleave", "streets-hit", () => { m.getCanvas().style.cursor = ""; });
    m.on("moveend", () => this.onMove?.(this.box(), m.getZoom()));
  }

  private statusColors(): any {
    return ["match", ["get", "status"],
      "done", css("--st-done"), "partial", css("--st-partial"), "marked", css("--st-marked"),
      "excluded", css("--st-excluded"), css("--st-none")];
  }

  /** Light and dark have their own status colours; repaint when the theme changes. */
  restyle() {
    if (this.map.getLayer("streets-line")) this.map.setPaintProperty("streets-line", "line-color", this.statusColors());
  }

  private click(e: MapLayerMouseEvent) {
    const at: LatLng = [e.lngLat.lat, e.lngLat.lng];
    if (this.busy) return;
    const hits = this.map.queryRenderedFeatures(e.point, { layers: ["streets-hit"] });
    if (hits.length && this.onStreetClick) {
      const f = this.streets[Number(hits[0].properties.i)];
      if (f) return this.onStreetClick(f, [e.point.x, e.point.y]);
    }
    const areas = this.map.queryRenderedFeatures(e.point, { layers: ["areas-fill"] });
    if (areas.length && this.onAreaClick) {
      // The smallest area under the click: a neighbourhood over the city around it.
      const pick = areas.slice().sort((a, b) => Number(a.properties.size) - Number(b.properties.size))[0];
      return this.onAreaClick(Number(pick.properties.id));
    }
    this.onMapClick?.(at);
  }

  box(): Box {
    const b = this.map.getBounds();
    return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  }

  setBase(base: Base) {
    const v = (on: boolean) => (on ? "visible" : "none");
    this.map.setLayoutProperty("base-osm", "visibility", v(base === "map"));
    this.map.setLayoutProperty("base-sat", "visibility", v(base !== "map"));
    this.map.setLayoutProperty("base-ref", "visibility", v(base === "hybrid"));
  }

  setAreas(areas: Area[], styles: Record<number, AreaStyle>) {
    const features = areas.map((a) => {
      const s = styles[a.id];
      const rings = [a.polygon, ...(a.morePieces || [])].filter((r) => r.length >= 3);
      const b = boxSize(rings);
      return {
        type: "Feature" as const,
        properties: {
          id: a.id, name: a.name, size: b,
          color: a.color || LEVEL_COLOR[a.level],
          focus: !!s?.focus, dim: !!s?.dim,
        },
        geometry: { type: "MultiPolygon" as const, coordinates: rings.map((r) => [toLngLat(r)]) },
      };
    });
    (this.map.getSource("areas") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
  }

  setStreets(streets: StreetFeature[]) {
    this.streets = streets;
    const features = streets.map((s) => ({
      type: "Feature" as const,
      properties: { i: s.i, id: s.id, name: s.name, status: s.status },
      geometry: { type: "LineString" as const, coordinates: s.line.map(([lat, lng]) => [lng, lat]) },
    }));
    (this.map.getSource("streets") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
  }

  selectStreet(id: number | null) {
    if (this.map.getLayer("streets-sel")) this.map.setFilter("streets-sel", ["==", ["get", "id"], id ?? -1]);
  }

  setPreview(rings: Ring[] | null) {
    const data = rings && rings.length
      ? { type: "FeatureCollection" as const, features: [{
          type: "Feature" as const, properties: {},
          geometry: { type: "MultiPolygon" as const, coordinates: rings.map((r) => [toLngLat(r)]) },
        }] }
      : empty;
    (this.map.getSource("preview") as GeoJSONSource | undefined)?.setData(data);
  }

  fit(rings: Ring[], padding = 60) {
    const b = new LngLatBounds();
    for (const r of rings) for (const [lat, lng] of r) b.extend([lng, lat]);
    if (!b.isEmpty()) this.map.fitBounds(b, { padding, maxZoom: 16, duration: 600 });
  }
}

/** A rough size, for picking the smallest of several areas under one click. */
function boxSize(rings: Ring[]): number {
  let s = 90, n = -90, w = 180, e = -180;
  for (const r of rings) for (const [lat, lng] of r) {
    if (lat < s) s = lat; if (lat > n) n = lat; if (lng < w) w = lng; if (lng > e) e = lng;
  }
  return (n - s) * (e - w);
}
