// The map: basemaps from the server's tile cache, streets as vector tiles from PostGIS.
import {
  Map as MlMap, NavigationControl, ScaleControl, GeolocateControl, Popup, setWorkerUrl,
  type GeoJSONSource, type MapLayerMouseEvent, type MapMouseEvent, type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre looks for its worker beside its own file, which bundling moves: so the worker
// is bundled on its own and MapLibre told where it went.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);

export type Base = "map" | "satellite" | "hybrid";
/** Streets come from the server from this zoom in (a tile further out would hold a city). */
export const STREETS_MIN_ZOOM = 12;

const STREET_COLOR = "#1a6fd4";
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
                 minzoom: STREETS_MIN_ZOOM, maxzoom: 16, promoteId: "id" },
      boundaries: { type: "vector", tiles: [`${location.origin}/api/tiles/areas/{z}/{x}/{y}`], maxzoom: 14 },
      "team-areas": { type: "geojson", data: empty(), promoteId: "id" },
      preview: { type: "geojson", data: empty() },
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
          "line-color": ["case", ["boolean", ["feature-state", "hover"], false], "#0d4a99", STREET_COLOR],
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 4, 19, 9],
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
      {
        id: "preview-line", type: "line", source: "preview", layout: { "line-join": "round" },
        paint: { "line-color": "#e2721f", "line-width": 3, "line-dasharray": [2, 1.5] },
      },
    ],
  };
}

export interface StreetHit {
  id: number;
  name: string | null;
  highway: string;
  length_m: number;
}

export class MapController {
  map: MlMap;
  onStreetClick: ((s: StreetHit, at: [number, number]) => void) | null = null;
  onAreaClick: ((id: string) => void) | null = null;
  /** While drawing, clicks belong to the drawing, not to areas and streets. */
  busy = false;
  private hovered: number | null = null;
  private selectedArea: string | null = null;
  private popup: Popup | null = null;

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

    this.map.on("mousemove", "streets", (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.id as number | undefined;
      if (id === undefined || id === this.hovered) return;
      this.clearHover();
      this.hovered = id;
      this.map.setFeatureState({ source: "streets", sourceLayer: "streets", id }, { hover: true });
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", "streets", () => this.clearHover());
    // One click handler: a street first (it's on top), then a team area.
    this.map.on("click", (e: MapMouseEvent) => {
      if (this.busy) return;
      const hits = this.map.queryRenderedFeatures(e.point, { layers: ["streets", "team-areas-fill"] });
      const street = hits.find((f) => f.layer.id === "streets");
      if (street) {
        const p = street.properties as { highway: string; name?: string; length_m: number };
        this.onStreetClick?.({ id: street.id as number, name: p.name ?? null, highway: p.highway, length_m: p.length_m }, [e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      const area = hits.find((f) => f.layer.id === "team-areas-fill");
      if (area) this.onAreaClick?.(String(area.id));
    });
  }

  private clearHover() {
    if (this.hovered !== null) this.map.setFeatureState({ source: "streets", sourceLayer: "streets", id: this.hovered }, { hover: false });
    this.hovered = null;
    this.map.getCanvas().style.cursor = "";
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

  /** Hide areas while drawing, so the drawing is what you see. */
  showAreas(on: boolean) {
    this.whenReady(() => {
      for (const id of ["team-areas-fill", "team-areas-line", "preview-line"]) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
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
