// Drawing and editing an area's outline: one polygon per piece. Ported from v1's web app.
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, type GeoJSONStoreFeatures } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { Popup, type Map as MlMap, type MapMouseEvent } from "maplibre-gl";

/** A ring as GeoJSON has it: [lng, lat] pairs, first point not repeated at the end. */
export type Ring = [number, number][];

/** More corners than this and a piece can be selected and deleted, not edited corner by corner. */
const EDIT_LIMIT = 1500;
const SNAP_PX = 12;
/** How close a click has to be to a corner to mean that corner. */
const CORNER_PX = 12;
const MAX_UNDO = 60;
const EDITABLE = "polygon";
const LARGE = "large";

/**
 * Corners drag, the dot between two adds one, and a new corner near another area's
 * outline lands exactly on it, so neighbouring areas share one line rather than two
 * that nearly meet. Clicking a corner offers to delete it (or its whole piece), and
 * every change can be undone.
 */
export class OutlineDraw {
  private draw: TerraDraw;
  selected = $state<string | null>(null);
  drawing = $state(false);
  pieces = $state(0);
  canUndo = $state(false);
  private undoStack: Ring[][] = [];
  /** The outline as of the last finished change: what an undo goes back past. */
  private committed: Ring[] = [];
  private popup: Popup | null = null;
  /** Shorelines in view (open lines, not rings), for corners to snap to. */
  private shores: Ring[] = [];
  private onMapClick = (e: MapMouseEvent) => this.cornerClick(e);

  constructor(private map: MlMap, private neighbours: Ring[], private onChange: () => void = () => {}) {
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
      this.commit();
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
    map.on("click", this.onMapClick);
  }

  /** Put an existing outline's pieces on the map to edit. */
  load(rings: Ring[]) {
    this.put(rings);
    this.committed = this.rings(false);
  }

  private put(rings: Ring[]) {
    const features: GeoJSONStoreFeatures[] = rings.filter((r) => r.length >= 3).map((r) => ({
      id: crypto.randomUUID(),
      type: "Feature",
      properties: { mode: r.length > EDIT_LIMIT ? LARGE : EDITABLE },
      geometry: { type: "Polygon", coordinates: [[...r, r[0]]] },
    }));
    if (features.length) this.draw.addFeatures(features);
    this.count();
  }

  /** Draw a new piece: click for each corner, then the first corner (or double click) to close. */
  addPiece() {
    this.drawing = true;
    this.draw.setMode(EDITABLE);
  }

  cancelPiece() {
    this.drawing = false;
    this.draw.setMode("select");
  }

  deleteSelected() {
    if (this.selected) this.deletePiece(this.selected);
  }

  deletePiece(id: string) {
    this.closePopup();
    if (this.selected === id) this.draw.deselectFeature(id);
    this.draw.removeFeatures([id]);
    this.selected = null;
    this.changed();
  }

  /** Take one corner out of a piece. A triangle has none to spare: delete the piece instead. */
  deleteCorner(id: string, index: number) {
    this.closePopup();
    const f = this.draw.getSnapshot().find((x) => x.id === id);
    if (!f || f.geometry.type !== "Polygon") return;
    const ring = (f.geometry.coordinates as number[][][])[0].slice(0, -1);
    if (ring.length <= 3) return this.deletePiece(id);
    ring.splice(index, 1);
    const reselect = this.selected === id;
    if (reselect) this.draw.deselectFeature(id);
    this.draw.updateFeatureGeometry(id, { type: "Polygon", coordinates: [[...ring, ring[0]]] });
    if (reselect) this.draw.selectFeature(id);
    this.changed();
  }

  setShores(lines: Ring[]) {
    this.shores = lines;
  }

  /** Swap the whole outline for another (trimmed to the shore, say), as one undoable change. */
  replaceAll(rings: Ring[]) {
    this.closePopup();
    if (this.drawing) this.cancelPiece();
    if (this.selected) this.draw.deselectFeature(this.selected);
    this.selected = null;
    const ids = this.draw.getSnapshot().filter((f) => f.geometry.type === "Polygon" && f.properties.mode !== undefined).map((f) => f.id!);
    if (ids.length) this.draw.removeFeatures(ids);
    this.put(rings);
    this.changed();
  }

  /** Back to how the outline was before the last change. */
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.closePopup();
    if (this.drawing) this.cancelPiece();
    const ids = this.draw.getSnapshot().filter((f) => f.geometry.type === "Polygon" && f.properties.mode !== undefined).map((f) => f.id!);
    if (this.selected) this.draw.deselectFeature(this.selected);
    this.selected = null;
    if (ids.length) this.draw.removeFeatures(ids);
    this.put(prev);
    this.committed = prev;
    this.canUndo = this.undoStack.length > 0;
    this.onChange();
  }

  /**
   * Every piece's corners, for keeping a draft. With `inProgress`, the corners clicked so
   * far on a piece still being drawn come too (if there are three yet), so a laptop
   * dying mid-piece loses at most the last couple of clicks.
   */
  rings(inProgress = true): Ring[] {
    const out: Ring[] = [];
    for (const f of this.draw.getSnapshot()) {
      if (f.geometry.type !== "Polygon" || (f.properties.mode !== EDITABLE && f.properties.mode !== LARGE)) continue;
      const pts = (f.geometry.coordinates as number[][][])[0] as [number, number][];
      if (f.properties.currentlyDrawing) {
        if (!inProgress) continue;
        // Being drawn: the clicked corners, then the cursor, then the first corner again.
        const clicked = pts.slice(0, -2);
        if (clicked.length >= 3) out.push(clicked);
      } else if (pts.length >= 4) {
        out.push(pts.slice(0, -1));
      }
    }
    return out;
  }

  /** A change made: remember what it replaced, and tell the panel (which keeps a draft). */
  private changed() {
    this.commit();
    this.count();
    this.onChange();
  }

  private commit() {
    const now = this.rings(false);
    if (JSON.stringify(now) === JSON.stringify(this.committed)) return;
    this.undoStack.push(this.committed);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.committed = now;
    this.canUndo = true;
  }

  /** A click on a corner (not a drag): offer to delete it, or the whole piece. */
  private cornerClick(e: MapMouseEvent) {
    if (this.drawing) return;
    let hit: { id: string; index: number; corners: number; at: [number, number]; d: number } | null = null;
    for (const f of this.draw.getSnapshot()) {
      if (f.geometry.type !== "Polygon" || f.properties.mode !== EDITABLE) continue;
      const ring = (f.geometry.coordinates as number[][][])[0].slice(0, -1) as [number, number][];
      ring.forEach((c, index) => {
        const p = this.map.project(c);
        const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
        if (d <= CORNER_PX && (!hit || d < hit.d)) hit = { id: String(f.id), index, corners: ring.length, at: c, d };
      });
    }
    this.closePopup();
    if (!hit) return;
    const h = hit as { id: string; index: number; corners: number; at: [number, number] };
    const el = document.createElement("div");
    el.className = "corner-menu";
    const corner = document.createElement("button");
    corner.className = "sm";
    corner.textContent = h.corners > 3 ? "Delete this corner" : "Delete this corner (and the triangle)";
    corner.onclick = () => this.deleteCorner(h.id, h.index);
    const piece = document.createElement("button");
    piece.className = "sm ghost danger";
    piece.textContent = "Delete this piece";
    piece.onclick = () => this.deletePiece(h.id);
    el.append(corner, piece);
    this.popup = new Popup({ closeButton: true, offset: 10, maxWidth: "240px" }).setLngLat(h.at).setDOMContent(el).addTo(this.map);
  }

  private closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  /** The outline as GeoJSON, or null with nothing drawn. */
  geometry(): GeoJSON.MultiPolygon | null {
    const polys = this.draw.getSnapshot()
      .filter((f) => f.geometry.type === "Polygon" && (f.properties.mode === EDITABLE || f.properties.mode === LARGE))
      .map((f) => (f.geometry.coordinates as number[][][]).slice(0, 1))
      .filter((p) => p[0].length >= 4);
    return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
  }

  stop() {
    this.closePopup();
    this.map.off("click", this.onMapClick);
    try { this.draw.stop(); } catch { /* the map may be gone already */ }
  }

  private count() {
    this.pieces = this.draw.getSnapshot().filter((f) => f.geometry.type === "Polygon" && f.properties.mode !== undefined).length;
  }

  /** The nearest point on another area's outline or a shoreline, if one is within a few pixels. */
  private snap(e: { lng: number; lat: number }): [number, number] | undefined {
    const at = this.map.project([e.lng, e.lat]);
    const view = this.map.getBounds();
    let best: { d: number; p: [number, number] } | null = null;
    const lines = [...this.neighbours.map((r) => ({ r, closed: true })), ...this.shores.map((r) => ({ r, closed: false }))];
    for (const { r: ring, closed } of lines) {
      let w = Infinity, s = Infinity, east = -Infinity, n = -Infinity;
      for (const [x, y] of ring) { if (x < w) w = x; if (x > east) east = x; if (y < s) s = y; if (y > n) n = y; }
      if (n < view.getSouth() || s > view.getNorth() || east < view.getWest() || w > view.getEast()) continue;
      for (let i = 0; i < (closed ? ring.length : ring.length - 1); i++) {
        const a = this.map.project(ring[i]);
        const z = ring[(i + 1) % ring.length];
        const c = this.map.project(z);
        const dx = c.x - a.x, dy = c.y - a.y, span = dx * dx + dy * dy;
        const t = span ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / span)) : 0;
        // Near a corner, the corner itself: that is what someone aiming at one means.
        const nearA = Math.hypot(at.x - a.x, at.y - a.y) <= SNAP_PX;
        const d = Math.hypot(at.x - (a.x + dx * t), at.y - (a.y + dy * t));
        if (d > SNAP_PX || (best && d >= best.d)) continue;
        const p: [number, number] = nearA ? [ring[i][0], ring[i][1]]
          : [ring[i][0] + (z[0] - ring[i][0]) * t, ring[i][1] + (z[1] - ring[i][1]) * t];
        best = { d, p };
      }
    }
    return best?.p;
  }
}

/** Outer rings of a (Multi)Polygon, without the closing repeat. */
export function ringsOf(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): Ring[] {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.map((p) => p[0].slice(0, -1) as Ring);
}
