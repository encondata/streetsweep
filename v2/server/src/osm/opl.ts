// Reading osmium's OPL text format and cutting ways into segments. Pure functions, so
// they can be checked without a database or a 700 MB file.

export interface OplWay {
  id: number;
  tags: Record<string, string>;
  refs: number[];
  /** lon, lat pairs, flattened; null when any node had no location. */
  coords: number[] | null;
}

/** OPL escapes anything awkward as %<hex code point>%. */
export function unescapeOpl(s: string): string {
  return s.indexOf("%") < 0 ? s : s.replace(/%([0-9a-fA-F]+)%/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * One way line, as written by `osmium ... -f opl,add_metadata=false`:
 *   w123 Thighway=residential,name=Elm%20%Street Nn1x-97.1y30.2,n2x-97.2y30.3
 * Other object types return null.
 */
export function parseWayLine(line: string): OplWay | null {
  if (line.charCodeAt(0) !== 119 /* w */) return null;
  const fields = line.split(" ");
  const id = Number(fields[0].slice(1));
  const tags: Record<string, string> = {};
  let refs: number[] = [];
  let coords: number[] | null = null;
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i];
    const kind = f.charCodeAt(0);
    if (kind === 84 /* T */) {
      if (f.length > 1) {
        for (const kv of f.slice(1).split(",")) {
          const eq = kv.indexOf("=");
          if (eq > 0) tags[unescapeOpl(kv.slice(0, eq))] = unescapeOpl(kv.slice(eq + 1));
        }
      }
    } else if (kind === 78 /* N */) {
      const parts = f.length > 1 ? f.slice(1).split(",") : [];
      refs = new Array(parts.length);
      coords = new Array(parts.length * 2);
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j];
        const x = p.indexOf("x");
        if (x < 0) {
          refs[j] = Number(p.slice(1));
          coords = null;
          continue;
        }
        const y = p.indexOf("y", x);
        refs[j] = Number(p.slice(1, x));
        if (coords) {
          const lon = Number(p.slice(x + 1, y));
          const lat = Number(p.slice(y + 1));
          // "n123x y" is a node osmium had no location for; Number("") would read it as 0.
          if (y < 0 || y === x + 1 || y === p.length - 1 || !Number.isFinite(lon) || !Number.isFinite(lat)) coords = null;
          else {
            coords[j * 2] = lon;
            coords[j * 2 + 1] = lat;
          }
        }
      }
    }
  }
  if (!Number.isSafeInteger(id)) return null;
  return { id, tags, refs, coords };
}

/**
 * Node ids, sorted, that more than one way (or one way twice) uses: the places streets
 * meet. Built from every ref of every way, so memory is 8 bytes per ref.
 */
export class NodeCounter {
  private buf = new Float64Array(1 << 20);
  private n = 0;

  add(refs: number[]) {
    if (this.n + refs.length > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.n + refs.length) size *= 2;
      const next = new Float64Array(size);
      next.set(this.buf.subarray(0, this.n));
      this.buf = next;
    }
    for (const r of refs) this.buf[this.n++] = r;
  }

  get refs() {
    return this.n;
  }

  /** The shared node ids, sorted. Frees the working buffer. */
  shared(): Float64Array {
    const all = this.buf.subarray(0, this.n).sort();
    let count = 0;
    for (let i = 1; i < all.length; i++) if (all[i] === all[i - 1] && (i < 2 || all[i - 1] !== all[i - 2])) count++;
    const out = new Float64Array(count);
    let k = 0;
    for (let i = 1; i < all.length; i++) if (all[i] === all[i - 1] && (i < 2 || all[i - 1] !== all[i - 2])) out[k++] = all[i];
    this.buf = new Float64Array(0);
    this.n = 0;
    return out;
  }
}

export function has(sorted: Float64Array, v: number): boolean {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const m = sorted[mid];
    if (m === v) return true;
    if (m < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export interface Segment {
  from: number;
  to: number;
  dup: number;
  /** lon, lat pairs, flattened. */
  coords: number[];
}

/** Cut a way at its ends and at every shared node. Pieces with no length are dropped. */
export function splitWay(refs: number[], coords: number[], shared: Float64Array): Segment[] {
  const out: Segment[] = [];
  const last = refs.length - 1;
  const seen = new Map<string, number>();
  let start = 0;
  for (let i = 1; i <= last; i++) {
    if (i !== last && !has(shared, refs[i])) continue;
    const piece = coords.slice(start * 2, i * 2 + 2);
    let moves = false;
    for (let k = 2; k < piece.length; k += 2) {
      if (piece[k] !== piece[0] || piece[k + 1] !== piece[1]) { moves = true; break; }
    }
    if (moves) {
      const key = `${refs[start]}>${refs[i]}`;
      const dup = seen.get(key) ?? 0;
      seen.set(key, dup + 1);
      out.push({ from: refs[start], to: refs[i], dup, coords: piece });
    }
    start = i;
  }
  return out;
}

export function lineEwkt(coords: number[]): string {
  let s = "SRID=4326;LINESTRING(";
  for (let i = 0; i < coords.length; i += 2) s += (i ? "," : "") + coords[i] + " " + coords[i + 1];
  return s + ")";
}

/** A field for COPY ... FROM STDIN (text format). */
export function copyField(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "\\N";
  const s = typeof v === "string" ? v : String(v);
  return s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
