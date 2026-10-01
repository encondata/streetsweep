import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, type GeoJSONStoreFeatures } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import type { Map as MlMap } from "maplibre-gl";
import { boxOf, fromLngLat, toLngLat } from "./geo";
import type { Ring } from "./types";

/** More corners than this and a piece can be selected and deleted, not edited corner by corner. */
export const EDIT_LIMIT = 1500;
const SNAP_PX = 12;

const EDITABLE = "polygon";
const LARGE = "large";

/**
 * Drawing and editing an area's outline on the map: one polygon per piece. Corners drag,
 * the dot between two adds one, and a new corner near another area's outline lands
 * exactly on it, so neighbouring areas share one line rather than two that nearly meet.
 */
export class OutlineDraw {
  private draw: TerraDraw;
  selected = $state<string | null>(null);
  drawing = $state(false);
  pieces = $state(0);

  constructor(private map: MlMap, private neighbours: Ring[], private onChange: () => void) {
    const snapping = { toCoordinate: true, toLine: true, toCustom: (e: { lng: number; lat: number }) => this.snap(e) };
    const style = { fillColor: "#e2721f" as const, fillOpacity: 0.12, outlineColor: "#e2721f" as const, outlineWidth: 2.5 };
    this.draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map }),
      modes: [
        new TerraDrawPolygonMode({ modeName: EDITABLE, snapping, styles: style }),
        new TerraDrawPolygonMode({ modeName: LARGE, styles: { ...style, fillOpacity: 0.08 } }),
        new TerraDrawSelectMode({
          flags: {
            [EDITABLE]: { feature: { draggable: false, coordinates: { draggable: true, midpoints: true, deletable: true, snappable: snapping } } },
            [LARGE]: { feature: { draggable: false } },
          },
          styles: { selectedPolygonColor: "#7c3aed", selectedPolygonOutlineColor: "#7c3aed", selectedPolygonFillOpacity: 0.12 },
        }),
      ],
    });
    this.draw.start();
    this.draw.on("change", () => { this.count(); this.onChange(); });
    this.draw.on("select", (id) => { this.selected = String(id); });
    this.draw.on("deselect", () => { this.selected = null; });
    this.draw.on("finish", (id, ctx) => {
      if (ctx && (ctx as { action?: string }).action === "draw") {
        // A piece finished: back to editing, with the new piece selected.
        this.drawing = false;
        this.draw.setMode("select");
        this.draw.selectFeature(id);
      }
      this.count();
      this.onChange();
    });
    this.draw.setMode("select");
  }

  /** Puts the area's pieces on the map to edit. */
  load(rings: Ring[]) {
    const features: GeoJSONStoreFeatures[] = rings.filter((r) => r.length >= 3).map((r) => ({
      id: crypto.randomUUID(),
      type: "Feature",
      properties: { mode: r.length > EDIT_LIMIT ? LARGE : EDITABLE },
      geometry: { type: "Polygon", coordinates: [toLngLat(r)] },
    }));
    if (features.length) this.draw.addFeatures(features);
    this.count();
  }

  /** Draw a new piece: click for each corner, then on the first corner (or double click) to close. */
  addPiece() {
    this.drawing = true;
    this.draw.setMode(EDITABLE);
  }

  cancelDrawing() {
    this.drawing = false;
    this.draw.setMode("select");
  }

  deleteSelected() {
    if (!this.selected) return;
    this.draw.removeFeatures([this.selected]);
    this.selected = null;
    this.count();
    this.onChange();
  }

  rings(): Ring[] {
    return this.draw.getSnapshot()
      .filter((f) => f.geometry.type === "Polygon" && (f.properties.mode === EDITABLE || f.properties.mode === LARGE))
      .map((f) => fromLngLat((f.geometry.coordinates as number[][][])[0]))
      .filter((r) => r.length >= 3)
      // Biggest first: the main piece is the one older phones are given.
      .sort((a, b) => boxArea(b) - boxArea(a));
  }

  stop() {
    try { this.draw.stop(); } catch { /* the map may be gone already */ }
  }

  private count() {
    this.pieces = this.draw.getSnapshot().filter((f) => f.geometry.type === "Polygon" && f.properties.mode !== undefined).length;
  }

  /** The nearest point on another area's outline, if one is within a few pixels. */
  private snap(e: { lng: number; lat: number }): [number, number] | undefined {
    const at = this.map.project([e.lng, e.lat]);
    const view = this.map.getBounds();
    let best: { d: number; p: [number, number] } | null = null;
    for (const ring of this.neighbours) {
      const b = boxOf([ring]);
      if (b.n < view.getSouth() || b.s > view.getNorth() || b.e < view.getWest() || b.w > view.getEast()) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = this.map.project([ring[i][1], ring[i][0]]);
        const z = ring[(i + 1) % ring.length];
        const c = this.map.project([z[1], z[0]]);
        const dx = c.x - a.x, dy = c.y - a.y, span = dx * dx + dy * dy;
        const t = span ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / span)) : 0;
        // Near a corner, the corner itself: that is what someone aiming at one means.
        const nearA = Math.hypot(at.x - a.x, at.y - a.y) <= SNAP_PX;
        const hx = a.x + dx * t, hy = a.y + dy * t;
        const d = Math.hypot(at.x - hx, at.y - hy);
        if (d > SNAP_PX || (best && d >= best.d)) continue;
        const p: [number, number] = nearA ? [ring[i][1], ring[i][0]]
          : [ring[i][1] + (z[1] - ring[i][1]) * t, ring[i][0] + (z[0] - ring[i][0]) * t];
        best = { d, p };
      }
    }
    return best?.p;
  }
}

function boxArea(r: Ring) {
  const b = boxOf([r]);
  return (b.n - b.s) * (b.e - b.w);
}
