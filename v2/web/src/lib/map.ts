// The map: basemaps from the server's tile cache, streets as vector tiles from PostGIS.
import {
  Map as MlMap, NavigationControl, ScaleControl, GeolocateControl, Popup, setWorkerUrl,
  type MapLayerMouseEvent, type StyleSpecification,
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
    },
    layers: [
      { id: "base-osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.35 } },
      { id: "base-sat", type: "raster", source: "sat", layout: { visibility: "none" } },
      { id: "base-ref", type: "raster", source: "ref", layout: { visibility: "none" } },
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
  private hovered: number | null = null;
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
    this.map.on("click", "streets", (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as { highway: string; name?: string; length_m: number };
      this.onStreetClick?.({ id: f.id as number, name: p.name ?? null, highway: p.highway, length_m: p.length_m }, [e.lngLat.lng, e.lngLat.lat]);
    });
  }

  private clearHover() {
    if (this.hovered !== null) this.map.setFeatureState({ source: "streets", sourceLayer: "streets", id: this.hovered }, { hover: false });
    this.hovered = null;
    this.map.getCanvas().style.cursor = "";
  }

  setBase(base: Base) {
    const show = (id: string, on: boolean) => this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    const go = () => {
      show("base-osm", base === "map");
      show("base-sat", base !== "map");
      show("base-ref", base === "hybrid");
    };
    if (this.map.isStyleLoaded()) go();
    else this.map.once("style.load", go);
  }

  showPopup(at: [number, number], html: string) {
    this.popup?.remove();
    this.popup = new Popup({ closeButton: true, maxWidth: "260px", offset: 8 }).setLngLat(at).setHTML(html).addTo(this.map);
  }

  fitBounds(b: [number, number, number, number]) {
    this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 0 });
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
