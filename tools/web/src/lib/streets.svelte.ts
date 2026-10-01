import { api } from "./api";
import { cellsOf, cellsInBox, type Box } from "./geo";
import type { Area, ExclusionReason, Network, StreetStatus } from "./types";
import type { StreetFeature } from "./map";

/** More cells than this and an area's streets load a screenful at a time. */
export const WHOLE_LIMIT = 6;
/** Below this zoom a screen covers too many cells to load street by street. */
export const VIEW_MIN_ZOOM = 12;

const DONE = 0.8, PARTIAL = 0.02;

export interface Street {
  i: number;
  id: number;
  name: string | null;
  line: [number, number][];
  length: number;
  driven: number;
  marked: { by: string | null; at: number } | null;
  excluded: { reason: ExclusionReason; by: string | null; at: number } | null;
}

/** Done / partial / not driven from the driving alone, before anything said by hand. */
export function drivenStatus(s: Street): StreetStatus {
  const f = s.length > 0 ? s.driven / s.length : 0;
  return f >= DONE ? "done" : f > PARTIAL ? "partial" : "none";
}
export function statusOf(s: Street): StreetStatus {
  return s.excluded ? "excluded" : s.marked ? "marked" : drivenStatus(s);
}

/**
 * One area's streets, as the server counts them. A small area loads whole; a big one
 * (a county, a metro) loads the cells in view as the map moves, and keeps what it has.
 */
export class AreaStreets {
  streets = $state<Street[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  readonly whole: boolean;
  private cells: string[];
  private loaded = new Set<string>();
  private byId = new Map<number, Street>();

  constructor(readonly area: Area) {
    this.cells = cellsOf([area.polygon, ...area.morePieces]);
    this.whole = this.cells.length <= WHOLE_LIMIT;
  }

  /** Small areas: everything. Big ones: the cells of [box] not loaded yet, at [zoom] or closer. */
  async load(box?: Box, zoom?: number) {
    let ask: string[] | undefined;
    if (!this.whole) {
      if (!box || (zoom ?? 0) < VIEW_MIN_ZOOM) return;
      ask = cellsInBox(this.cells, box).filter((k) => !this.loaded.has(k)).slice(0, 12);
      if (!ask.length) return;
    } else if (this.loaded.size) return;
    this.loading = true;
    this.error = null;
    try {
      const net = await api.network(this.area.id, ask);
      this.merge(net);
      (ask || this.cells).forEach((k) => this.loaded.add(k));
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private merge(net: Network) {
    const marked = new Map(net.completed.map((c) => [c.wayId, c]));
    const excluded = new Map(net.excluded.map((x) => [x.wayId, x]));
    const add: Street[] = [];
    net.ids.forEach((id, k) => {
      if (this.byId.has(id)) return;
      const m = marked.get(id), x = excluded.get(id);
      const s: Street = {
        i: this.streets.length + add.length, id, name: net.names[k], line: net.lines[k],
        length: net.lengths?.[k] ?? 0, driven: net.driven?.[k] ?? 0,
        marked: m ? { by: m.by, at: m.updatedAt } : null,
        excluded: x ? { reason: x.reason, by: x.by, at: x.updatedAt } : null,
      };
      this.byId.set(id, s);
      add.push(s);
    });
    if (add.length) this.streets = [...this.streets, ...add];
  }

  features(): StreetFeature[] {
    return this.streets.map((s) => ({ i: s.i, id: s.id, name: s.name, status: statusOf(s), line: s.line }));
  }

  /** After an edit here: change the streets in place, so the map and counts follow. */
  update(ids: number[], change: (s: Street) => void) {
    const set = new Set(ids);
    this.streets = this.streets.map((s) => {
      if (!set.has(s.id)) return s;
      const c = { ...s };
      change(c);
      return c;
    });
  }

  counts() {
    const c: Record<StreetStatus, number> = { done: 0, partial: 0, none: 0, marked: 0, excluded: 0 };
    for (const s of this.streets) c[statusOf(s)]++;
    return c;
  }
}
