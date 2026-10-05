/// <reference types="geojson" />
// Drawing and editing an area's outline, the way the iPad app does it: one polygon per
// piece, and every tool in the palette along the bottom (nothing pops up on a click).
//
// - Corners: click each corner; a dashed line follows the mouse from the last one. Click
//   the first corner (or double-click, or Enter) to close. Click two points on a shown
//   area's edge (or a boundary line, with Snap on) and the outline follows it between them.
// - Edit: every piece's corners and midpoints show. Drag a corner to move it, a midpoint to
//   add one; click a piece to select it.
// - Eraser: click a corner, or drag across corners, to delete them; click inside a piece to
//   delete it. (Dragging erases rather than moving the map while the Eraser is chosen.)
//
// Corners snap to the areas shown, shorelines, and (with Snap) intersections, streets and
// state, county and city lines. Every change can be undone and redone.
import type { GeoJSONSource, Map as MlMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";

/** A ring as GeoJSON has it: [lng, lat] pairs, first point not repeated at the end. */
export type Ring = [number, number][];
export type Tool = "corners" | "edit" | "eraser";

type Pt = { x: number; y: number };
type Line = { r: Ring; closed: boolean; ends?: boolean };
/** Where a point snapped to, and how far along which line (segment + fraction). */
type Hit = { p: [number, number]; d: number; line: number; pos: number; corner: boolean };
type Piece = { id: string; ring: Ring };

const SNAP_PX = 12;
const HIT_PX = 10;
const MAX_UNDO = 80;
/** More corners than this in all and only the selected piece shows its handles. */
const HANDLE_LIMIT = 1500;
const ORANGE = "#e2721f", PURPLE = "#7c3aed";
const SRC = { pieces: "od-pieces", progress: "od-progress", handles: "od-handles", hover: "od-hover" };

export class OutlineDraw {
  tool = $state<Tool>("edit");
  selected = $state<string | null>(null);
  pieces = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);
  /** Snap: also onto streets (their ends, the intersections, first) and state, county and city lines. */
  snapping = $state(false);
  /** A piece being drawn with the Corners tool (what the panel calls drawing). */
  get drawing() { return this.tool === "corners"; }

  private list: Piece[] = [];
  private progress: Ring = [];
  /** Where each corner of the piece being drawn snapped, for following an edge. */
  private progressHits: (Hit | null)[] = [];
  private hover: { p: [number, number]; snapped: boolean } | null = null;
  private undoStack: Piece[][] = [];
  private redoStack: Piece[][] = [];
  private shores: Ring[] = [];
  private streets: Ring[] = [];
  private boundaries: Ring[] = [];
  private drag: { piece: number; corner: number; moved: boolean; start: Pt } | null = null;
  private erasing = false;
  private erasedThisStroke = false;
  private off: (() => void)[] = [];

  constructor(private map: MlMap, private neighbours: Ring[], private onChange: () => void = () => {}) {
    this.addLayers();
    const on = <E>(type: string, fn: (e: E) => void) => {
      map.on(type as "click", fn as unknown as (e: MapMouseEvent) => void);
      this.off.push(() => map.off(type as "click", fn as unknown as (e: MapMouseEvent) => void));
    };
    on<MapMouseEvent>("mousedown", (e) => this.down(e));
    on<MapTouchEvent>("touchstart", (e) => { if (e.points.length === 1) this.down(e); });
    on<MapMouseEvent>("mousemove", (e) => this.move(e));
    on<MapTouchEvent>("touchmove", (e) => this.move(e));
    on<MapMouseEvent>("mouseup", (e) => this.up(e));
    on<MapTouchEvent>("touchend", (e) => this.up(e));
    on<MapMouseEvent>("click", (e) => this.click(e));
    on<MapMouseEvent>("dblclick", (e) => { if (this.tool === "corners") { e.preventDefault(); this.closeProgress(); } });
    on<MapMouseEvent>("mouseout", () => { this.hover = null; this.render(); });
    on<unknown>("move", () => this.render());
    map.doubleClickZoom.disable();
    this.setCursor();
  }

  // ---- the outline ----

  /** Put an existing outline's pieces on the map to edit. */
  load(rings: Ring[]) {
    this.list = rings.filter((r) => r.length >= 3).map((ring) => ({ id: crypto.randomUUID(), ring }));
    this.selected = null;
    this.changed(false);
  }

  /** Every piece's corners, for keeping a draft (with the piece being drawn, if it has three). */
  rings(inProgress = true): Ring[] {
    const out = this.list.map((p) => p.ring);
    if (inProgress && this.progress.length >= 3) out.push(this.progress);
    return out;
  }

  /** The outline as GeoJSON, or null with nothing drawn. */
  geometry(): GeoJSON.MultiPolygon | null {
    const rings = this.list.map((p) => p.ring).filter((r) => r.length >= 3);
    return rings.length ? { type: "MultiPolygon", coordinates: rings.map((r) => [[...r, r[0]]]) } : null;
  }

  setTool(tool: Tool) {
    if (tool === this.tool) return;
    if (this.tool === "corners") this.closeProgress(false);
    this.tool = tool;
    if (tool !== "edit") this.selected = null;
    this.setCursor();
    this.render();
  }
  /** The panel's names for switching tools. */
  addPiece() { this.setTool("corners"); }
  cancelPiece() {
    this.progress = [];
    this.progressHits = [];
    this.setTool("edit");
  }

  deleteSelected() {
    if (!this.selected) return;
    this.checkpoint();
    this.list = this.list.filter((p) => p.id !== this.selected);
    this.selected = null;
    this.changed();
  }

  /** Swap the whole outline for another (trimmed, tidied), as one undoable change. */
  replaceAll(rings: Ring[]) {
    this.checkpoint();
    this.progress = [];
    this.progressHits = [];
    this.list = rings.filter((r) => r.length >= 3).map((ring) => ({ id: crypto.randomUUID(), ring }));
    this.selected = null;
    if (this.tool === "corners") this.setTool("edit");
    this.changed();
  }

  undo() {
    if (this.progress.length) {
      this.progress.pop();
      this.progressHits.pop();
      this.render();
      return;
    }
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.list);
    this.list = prev;
    if (this.selected && !this.list.some((p) => p.id === this.selected)) this.selected = null;
    this.changed();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next || this.progress.length) return;
    this.undoStack.push(this.list);
    this.list = next;
    this.changed();
  }

  // ---- what corners snap to ----

  /** The existing areas corners snap onto (the panel decides which: same kind, when shown). */
  setNeighbours(rings: Ring[]) { this.neighbours = rings; }
  setShores(lines: Ring[]) { this.shores = lines; }
  /** Streets and boundary lines in view, snapped to while Snap is on. */
  setSnapLines(streets: Ring[] | null, boundaries: Ring[] | null) {
    if (streets) this.streets = streets;
    if (boundaries) this.boundaries = boundaries;
  }

  stop() {
    for (const f of this.off) f();
    this.off = [];
    try {
      this.map.doubleClickZoom.enable();
      this.map.dragPan.enable();
      this.map.getCanvas().style.cursor = "";
      for (const id of ["od-fill", "od-line", "od-progress", "od-handles", "od-hover"]) if (this.map.getLayer(id)) this.map.removeLayer(id);
      for (const id of Object.values(SRC)) if (this.map.getSource(id)) this.map.removeSource(id);
    } catch { /* the map may be gone already */ }
  }

  // ---- input ----

  private pt(e: MapMouseEvent | MapTouchEvent): Pt { return { x: e.point.x, y: e.point.y }; }
  private ll(p: Pt): [number, number] { const c = this.map.unproject([p.x, p.y]); return [c.lng, c.lat]; }
  private px(c: [number, number]): Pt { const p = this.map.project(c); return { x: p.x, y: p.y }; }

  private down(e: MapMouseEvent | MapTouchEvent) {
    if ("button" in e.originalEvent && (e.originalEvent as MouseEvent).button !== 0) return;
    const p = this.pt(e);
    if (this.tool === "edit") {
      const hit = this.nearestCorner(p) ?? this.nearestMidpoint(p);
      if (!hit) return;
      e.preventDefault();
      this.map.dragPan.disable();
      if (hit.mid) {
        this.checkpoint();
        this.list[hit.piece].ring.splice(hit.corner, 0, this.ll(p));
        this.drag = { piece: hit.piece, corner: hit.corner, moved: true, start: p };
      } else {
        this.drag = { piece: hit.piece, corner: hit.corner, moved: false, start: p };
      }
      this.selected = this.list[hit.piece].id;
      this.render();
    } else if (this.tool === "eraser") {
      e.preventDefault();
      this.map.dragPan.disable();
      this.erasing = true;
      this.erasedThisStroke = false;
      this.erase(p);
    }
  }

  private move(e: MapMouseEvent | MapTouchEvent) {
    const p = this.pt(e);
    if (this.drag) {
      const d = this.drag;
      if (!d.moved) {
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < 3) return;
        this.checkpoint();
        d.moved = true;
      }
      const piece = this.list[d.piece];
      piece.ring[d.corner] = this.snap(p, piece.id)?.p ?? this.ll(p);
      this.render();
      return;
    }
    if (this.erasing) { this.erase(p); return; }
    if (this.tool === "corners") {
      const h = this.snap(p, null);
      this.hover = { p: h?.p ?? this.ll(p), snapped: !!h };
      this.render();
    } else if (this.tool === "edit") {
      this.map.getCanvas().style.cursor = this.nearestCorner(p) || this.nearestMidpoint(p) ? "move" : "";
    }
  }

  private up(_e: MapMouseEvent | MapTouchEvent) {
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      this.map.dragPan.enable();
      this.suppressClick = true;
      if (moved) this.changed();
      return;
    }
    if (this.erasing) {
      this.erasing = false;
      this.map.dragPan.enable();
      if (this.erasedThisStroke) this.suppressClick = true;
      this.changed(this.erasedThisStroke);
    }
  }

  private suppressClick = false;

  private click(e: MapMouseEvent) {
    if (this.suppressClick) { this.suppressClick = false; return; }
    const p = this.pt(e);
    if (this.tool === "corners") this.addCorner(p);
    else if (this.tool === "edit") {
      const i = this.pieceAt(p);
      this.selected = i === null ? null : this.list[i].id;
      this.render();
    } else if (this.tool === "eraser") {
      const i = this.pieceAt(p);
      if (i !== null) {
        this.checkpoint();
        this.list.splice(i, 1);
        this.selected = null;
        this.changed();
      }
    }
  }

  // ---- the tools' work ----

  private addCorner(p: Pt) {
    if (this.progress.length >= 3) {
      const first = this.px(this.progress[0]);
      if (Math.hypot(p.x - first.x, p.y - first.y) <= HIT_PX + 4) { this.closeProgress(); return; }
    }
    const hit = this.snap(p, null);
    const c = hit?.p ?? this.ll(p);
    const last = this.progress[this.progress.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) return;
    // On the same line as the last corner: follow it between them.
    const prev = this.progressHits[this.progressHits.length - 1];
    if (prev && hit && prev.line === hit.line && hit.line < this.followable()) {
      for (const q of this.between(this.lines(null)[hit.line], prev.pos, hit.pos)) { this.progress.push(q); this.progressHits.push(null); }
    }
    this.progress.push(c);
    this.progressHits.push(hit);
    this.render();
  }

  /** Close the piece being drawn (three corners at least) and go on to editing it. */
  closeProgress(toEdit = true) {
    if (this.progress.length >= 3) {
      // The last corner and the first on the same line: follow it to close too.
      const a = this.progressHits[this.progressHits.length - 1], b = this.progressHits[0];
      let ring = [...this.progress];
      if (a && b && a.line === b.line && a.line < this.followable()) ring = [...ring, ...this.between(this.lines(null)[a.line], a.pos, b.pos)];
      this.checkpoint();
      const piece = { id: crypto.randomUUID(), ring };
      this.list = [...this.list, piece];
      this.progress = [];
      this.progressHits = [];
      this.changed();
      if (toEdit) {
        this.setTool("edit");
        this.selected = piece.id;
        this.render();
      }
    } else {
      this.progress = [];
      this.progressHits = [];
      this.render();
    }
  }

  private erase(p: Pt) {
    let any = false;
    const next: Piece[] = [];
    for (const piece of this.list) {
      const kept = piece.ring.filter((c) => { const q = this.px(c); return Math.hypot(q.x - p.x, q.y - p.y) > HIT_PX + 4; });
      if (kept.length !== piece.ring.length) any = true;
      if (kept.length >= 3) next.push({ id: piece.id, ring: kept });
    }
    if (!any) return;
    if (!this.erasedThisStroke) { this.checkpoint(); this.erasedThisStroke = true; }
    this.list = next;
    if (this.selected && !next.some((x) => x.id === this.selected)) this.selected = null;
    this.render();
  }

  private nearestCorner(p: Pt): { piece: number; corner: number; mid: false } | null {
    let best: { piece: number; corner: number; d: number } | null = null;
    this.list.forEach((piece, pi) => {
      if (!this.showsHandles(piece)) return;
      piece.ring.forEach((c, ci) => {
        const q = this.px(c), d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d <= HIT_PX && (!best || d < best.d)) best = { piece: pi, corner: ci, d };
      });
    });
    const b = best as { piece: number; corner: number } | null;
    return b ? { piece: b.piece, corner: b.corner, mid: false } : null;
  }

  /** The dot between two corners: dragging it adds a corner there (at `corner`). */
  private nearestMidpoint(p: Pt): { piece: number; corner: number; mid: true } | null {
    let best: { piece: number; corner: number; d: number } | null = null;
    this.list.forEach((piece, pi) => {
      if (!this.showsHandles(piece)) return;
      piece.ring.forEach((c, i) => {
        const a = this.px(c), b = this.px(piece.ring[(i + 1) % piece.ring.length]);
        const d = Math.hypot((a.x + b.x) / 2 - p.x, (a.y + b.y) / 2 - p.y);
        if (d <= HIT_PX - 2 && (!best || d < best.d)) best = { piece: pi, corner: i + 1, d };
      });
    });
    const b = best as { piece: number; corner: number } | null;
    return b ? { piece: b.piece, corner: b.corner, mid: true } : null;
  }

  private pieceAt(p: Pt): number | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i].ring.map((c) => this.px(c));
      let inside = false;
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        if ((r[a].y > p.y) !== (r[b].y > p.y) && p.x < ((r[b].x - r[a].x) * (p.y - r[a].y)) / (r[b].y - r[a].y) + r[a].x) inside = !inside;
      }
      if (inside) return i;
    }
    return null;
  }

  private showsHandles(piece: Piece): boolean {
    const total = this.list.reduce((t, x) => t + x.ring.length, 0);
    return total <= HANDLE_LIMIT || piece.id === this.selected;
  }

  // ---- snapping and following ----

  /** The lines snapped to: those that can be followed come first (areas shown, boundaries). */
  private lines(exclude: string | null): Line[] {
    return [
      ...this.neighbours.map((r) => ({ r, closed: true })),
      ...(this.snapping ? this.boundaries.map((r) => ({ r, closed: false })) : []),
      ...this.shores.map((r) => ({ r, closed: false })),
      ...this.list.filter((p) => p.id !== exclude).map((p) => ({ r: p.ring, closed: true })),
      ...(this.snapping ? this.streets.map((r) => ({ r, closed: false, ends: true })) : []),
    ];
  }
  /** How many of `lines()` an edge is followed along. */
  private followable() { return this.neighbours.length + (this.snapping ? this.boundaries.length : 0); }

  /** The nearest corner within reach (a street's are its two ends); failing that, the nearest point on a line. */
  private snap(at: Pt, exclude: string | null): Hit | null {
    const view = this.map.getBounds();
    let corner: Hit | null = null, best: Hit | null = null;
    this.lines(exclude).forEach(({ r, closed, ends }, li) => {
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
      if (n < view.getSouth() || s > view.getNorth() || e < view.getWest() || w > view.getEast()) return;
      const pts = r.map((c) => this.px(c));
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const toA = Math.hypot(at.x - a.x, at.y - a.y);
        if ((!ends || i === 0 || i === pts.length - 1) && toA <= SNAP_PX && (!corner || toA < corner.d)) {
          corner = { p: [r[i][0], r[i][1]], d: toA, line: li, pos: i, corner: true };
        }
        if (i === pts.length - 1 && !closed) break;
        const j = (i + 1) % pts.length, b = pts[j];
        const dx = b.x - a.x, dy = b.y - a.y, span = dx * dx + dy * dy;
        const t = span ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / span)) : 0;
        const d = Math.hypot(at.x - (a.x + dx * t), at.y - (a.y + dy * t));
        if (d > SNAP_PX || (best && d >= best.d)) continue;
        best = { p: [r[i][0] + (r[j][0] - r[i][0]) * t, r[i][1] + (r[j][1] - r[i][1]) * t], d, line: li, pos: i + t, corner: false };
      }
    });
    return corner ?? best;
  }

  /** The corners of a line between two spots on it, whichever way round is shorter. */
  private between(line: Line, a: number, b: number): Ring {
    const r = line.r, n = r.length;
    const ways: Ring[] = [];
    const hi = b >= a ? b : line.closed ? b + n : null;
    if (hi !== null) { const w: Ring = []; for (let k = Math.floor(a) + 1; k < hi; k++) w.push(r[k % n]); ways.push(w); }
    const lo = b <= a ? b : line.closed ? b - n : null;
    if (lo !== null) { const w: Ring = []; for (let k = Math.ceil(a) - 1; k > lo; k--) w.push(r[((k % n) + n) % n]); ways.push(w); }
    const len = (w: Ring) => w.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - w[i - 1][0], p[1] - w[i - 1][1]) : 0), 0);
    return ways.sort((x, y) => len(x) - len(y))[0] ?? [];
  }

  // ---- undo, change, draw ----

  private checkpoint() {
    this.undoStack.push(this.list.map((p) => ({ id: p.id, ring: [...p.ring] })));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Something changed: redraw, count, and tell the panel (which keeps a draft). */
  private changed(notify = true) {
    this.list = [...this.list];
    this.pieces = this.list.length;
    this.canUndo = this.undoStack.length > 0;
    this.canRedo = this.redoStack.length > 0;
    this.render();
    if (notify) this.onChange();
  }

  private setCursor() {
    this.map.getCanvas().style.cursor = this.tool === "corners" ? "crosshair" : this.tool === "eraser" ? "cell" : "";
  }

  private addLayers() {
    const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
    for (const id of Object.values(SRC)) if (!this.map.getSource(id)) this.map.addSource(id, { type: "geojson", data: empty });
    const color = ["case", ["get", "selected"], PURPLE, ORANGE] as unknown as string;
    this.map.addLayer({ id: "od-fill", type: "fill", source: SRC.pieces, paint: { "fill-color": color, "fill-opacity": 0.13 } });
    this.map.addLayer({ id: "od-line", type: "line", source: SRC.pieces, layout: { "line-join": "round" }, paint: { "line-color": color, "line-width": 2.5 } });
    this.map.addLayer({ id: "od-progress", type: "line", source: SRC.progress, layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": ORANGE, "line-width": 2.5, "line-dasharray": [2, 1.5] } });
    this.map.addLayer({
      id: "od-handles", type: "circle", source: SRC.handles,
      paint: {
        "circle-radius": ["match", ["get", "kind"], "mid", 4, "first", 7, 5.5] as unknown as number,
        "circle-color": ["match", ["get", "kind"], "mid", "#ffffff", color] as unknown as string,
        "circle-stroke-color": ["match", ["get", "kind"], "mid", color, "#ffffff"] as unknown as string,
        "circle-stroke-width": 2,
      },
    });
    this.map.addLayer({
      id: "od-hover", type: "circle", source: SRC.hover,
      paint: { "circle-radius": 6, "circle-color": ["case", ["get", "snapped"], PURPLE, ORANGE] as unknown as string, "circle-opacity": 0.35,
        "circle-stroke-width": 2, "circle-stroke-color": ["case", ["get", "snapped"], PURPLE, ORANGE] as unknown as string },
    });
  }

  private render() {
    const set = (id: string, features: GeoJSON.Feature[]) => (this.map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
    const pt = (c: [number, number], props: Record<string, unknown>): GeoJSON.Feature => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });
    set(SRC.pieces, this.list.map((p) => ({ type: "Feature", properties: { selected: p.id === this.selected },
      geometry: { type: "Polygon", coordinates: [[...p.ring, p.ring[0]]] } })));
    const handles: GeoJSON.Feature[] = [];
    if (this.tool !== "corners") {
      for (const p of this.list) {
        if (!this.showsHandles(p)) continue;
        const sel = p.id === this.selected;
        p.ring.forEach((c, i) => {
          handles.push(pt(c, { kind: "corner", selected: sel }));
          if (this.tool === "edit") {
            const d = p.ring[(i + 1) % p.ring.length];
            handles.push(pt([(c[0] + d[0]) / 2, (c[1] + d[1]) / 2], { kind: "mid", selected: sel }));
          }
        });
      }
    }
    this.progress.forEach((c, i) => handles.push(pt(c, { kind: i === 0 && this.progress.length >= 3 ? "first" : "corner", selected: false })));
    set(SRC.handles, handles);
    const line = this.tool === "corners" && this.hover && this.progress.length ? [...this.progress, this.hover.p] : this.progress;
    set(SRC.progress, line.length >= 2 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } }] : []);
    set(SRC.hover, this.tool === "corners" && this.hover ? [pt(this.hover.p, { snapped: this.hover.snapped })] : []);
  }
}

/** Outer rings of a (Multi)Polygon, without the closing repeat. */
export function ringsOf(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): Ring[] {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.map((p) => p[0].slice(0, -1) as Ring);
}
