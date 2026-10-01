import { api } from "./api";
import { ORGANIZATIONAL, abc } from "./levels";
import type { Area, AreaDraft, AreaProgress, User } from "./types";

/** Everything the screens share: who is signed in, the areas and the server's figures. */
class Store {
  me = $state<User | null>(null);
  areas = $state<Area[]>([]);
  progress = $state<Record<string, AreaProgress>>({});
  loaded = $state(false);
  error = $state<string | null>(null);

  /** Drivers and administrators mark streets; administrators and area editors draw areas. */
  get canMark() { return this.me?.role === "admin" || this.me?.role === "driver"; }
  get canEditAreas() { return this.me?.role === "admin"; }

  async load() {
    try {
      const [me, areas, progress] = await Promise.all([api.me(), api.areas(), api.progress()]);
      this.me = me;
      this.areas = areas;
      this.setProgress(progress);
      this.loaded = true;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private setProgress(rows: AreaProgress[]) {
    const out: Record<string, AreaProgress> = {};
    for (const r of rows) out[r.name] = r;
    this.progress = out;
  }

  /**
   * The server recounts a moment after a change — it waits for a burst of edits to settle
   * first — so asking at once would only get the old figures. Ask after that, and again
   * while anything is still being counted.
   */
  async refreshProgress(times = 8) {
    let pass = 0;
    const tick = async () => {
      const rows = await api.progress().catch(() => null);
      if (rows) this.setProgress(rows);
      pass++;
      if (pass < times && (!rows || rows.some((r) => r.pending))) setTimeout(tick, 2000);
    };
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(tick, 2200);
  }
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  byId(id: number) { return this.areas.find((a) => a.id === id) || null; }
  byName(name: string) {
    const key = name.toLowerCase();
    return this.areas.find((a) => a.name.toLowerCase() === key) || null;
  }

  async save(draft: AreaDraft, id?: number): Promise<Area> {
    const before = id ? this.byId(id) : null;
    const saved = id ? await api.updateArea(id, draft) : await api.createArea(draft);
    if (before && before.name !== saved.name) {
      // The server moved every area that named it as a parent; take them all again.
      this.areas = await api.areas();
    } else {
      const i = this.areas.findIndex((a) => a.id === saved.id);
      if (i >= 0) this.areas[i] = saved; else this.areas.push(saved);
    }
    this.refreshProgress();
    return saved;
  }

  async remove(id: number) {
    await api.deleteArea(id);
    this.areas = this.areas.filter((a) => a.id !== id);
  }
}

export const store = new Store();

/** Every area this one is part of, by name: its first parent and then the rest. */
export function parentsOf(a: Area): string[] {
  const seen = new Set<string>();
  return [a.parentName, ...(a.alsoIn || [])].filter((n): n is string => {
    if (!n) return false;
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const isOrg = (a: Area) => ORGANIZATIONAL.has(a.level);

export interface TreeNode { area: Area; depth: number; kids: TreeNode[]; under: Area | null }

/**
 * Areas under each area they are part of, A to Z at every level. A city in two counties
 * shows under both; a parent that loops back is left out; an area none of whose parents
 * exists sits at the top.
 */
export function areaTree(areas: Area[]): TreeNode[] {
  const byName = new Map(areas.map((a) => [a.name.toLowerCase(), a]));
  const parents = (a: Area) =>
    parentsOf(a).map((n) => byName.get(n.toLowerCase())).filter((p): p is Area => !!p && p !== a);
  const above = (from: Area, target: Area) => {
    const seen = new Set<number>(), stack = [from];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === target) return true;
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      stack.push(...parents(x));
    }
    return false;
  };
  const kids = new Map<number, Area[]>();
  const roots: Area[] = [];
  for (const a of areas) {
    const under = parents(a).filter((p) => !above(p, a));
    for (const p of under) (kids.get(p.id) || kids.set(p.id, []).get(p.id)!).push(a);
    if (!under.length) roots.push(a);
  }
  const byNameSort = (x: Area, y: Area) => abc(x.name, y.name);
  const build = (a: Area, depth: number, under: Area | null, path: Set<number>): TreeNode => ({
    area: a, depth, under,
    kids: (kids.get(a.id) || []).filter((k) => !path.has(k.id)).sort(byNameSort)
      .map((k) => build(k, depth + 1, a, new Set([...path, a.id]))),
  });
  return roots.sort(byNameSort).map((r) => build(r, 0, null, new Set()));
}
