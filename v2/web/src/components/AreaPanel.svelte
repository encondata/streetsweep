<script lang="ts">
  // The panel beside the map: a team's areas, finding public ones to follow, an area's
  // details, and drawing. The map stays put; this tells it what to show.
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { api, ApiError, errorText } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { defaultTeam } from "../lib/settings";
  import { OutlineDraw, ringsOf, type Ring } from "../lib/draw.svelte";
  import { formValues } from "../lib/forms";
  import { miles, percent } from "../lib/format";
  import type { MapController } from "../lib/map";
  import { AREA_COLORS, LEVEL_LABEL, type Area } from "../lib/types";
  import { assignAreaColors } from "../lib/areaColors";
  import { areaFeatures } from "../lib/teamAreas";
  import { nest, tree, type Node } from "../lib/areaTree";
  import { ui } from "../lib/ui.svelte";
  import { decodePolyline } from "../lib/polyline";

  let { ctl, panelWidth = 360, onteam, shown = true, onshow, onhide, onmissing, onarea }: {
    ctl: MapController; panelWidth?: number; onteam?: (teamId: string) => void;
    /** "Highlight what's left" in this area, for this team. */
    onmissing?: (area: Area, teamId: string) => void;
    /** The area open in the panel changed (null: back to the list). */
    onarea?: (id: string | null) => void;
    /** Hidden, the panel keeps working (team, areas on the map); it's just out of the way. */
    shown?: boolean; onshow?: () => void; onhide?: () => void;
  } = $props();

  type Mode = "list" | "detail" | "draw";
  let mode = $state<Mode>("list");
  let teams = $derived(session.me!.teams);
  let teamId = $state(defaultTeam("streetsweep.areasTeam"));
  let areas = $state<Area[]>([]);
  let canEdit = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let q = $state("");
  let results = $state<Area[]>([]);
  let searching = $state(false);
  // Addresses: looked up only when asked (Enter), as the geocoder's rules require.
  type Address = { label: string; lon: number; lat: number; bbox: [number, number, number, number] | null; kind: string | null };
  let addresses = $state<Address[] | null>(null);
  let lookingUp = $state(false);

  let area = $state<Area | null>(null);
  $effect(() => {
    const id = area?.id ?? null;
    if (mode === "detail") onarea?.(id);
  });
  let areaCanEdit = $state(false);
  let editing = $state(false);
  let form = $state({ name: "", notes: "", level: "neighborhood" as DrawnLevel });
  type DrawnLevel = "neighborhood" | "section" | "custom";
  const drawnLevel = (l: string): DrawnLevel => (l === "section" || l === "custom" ? l : "neighborhood");

  let draw = $state<OutlineDraw | null>(null);
  let redrawing = $state<Area | null>(null);


  let team = $derived(teams.find((t) => t.id === teamId));
  // Colours are automatic: no area shares one with an area it touches.
  let colors = $derived(assignAreaColors(areas));
  const colorOf = (a: Area) => colors.get(a.id) ?? AREA_COLORS[0];

  const followedHere = (a: Area) => areas.some((x) => x.id === a.id);

  // ---- the list: nested by kind, kept to what's in view ----
  let parentOf = $derived(nest(areas));
  let view = $state<[number, number, number, number] | null>(null);
  let showAll = $state(false);
  let collapsed = $state<Set<string>>(new Set());
  let listed = $derived(tree(areas, parentOf, showAll ? null : view));
  const readView = () => {
    const b = ctl.map.getBounds();
    view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  };
  onMount(() => {
    ctl.ready().then(readView);
    ctl.map.on("moveend", readView);
    return () => ctl.map.off("moveend", readView);
  });
  function toggle(id: string) {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    collapsed = next;
  }

  // ---- the team's areas ----
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadAreas() {
    clearTimeout(pollTimer);
    try {
      const r = await api<{ areas: Area[]; can_edit: boolean }>(`/api/teams/${teamId}/areas`);
      areas = r.areas;
      canEdit = r.can_edit;
      ctl.setTeamAreas(areaFeatures(r.areas));
      // Street lists being built: check back until they're done.
      if (r.areas.some((a) => a.build_status === "queued" || a.build_status === "building")) pollTimer = setTimeout(refresh, 4000);
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }
  /** Coverage or areas changed elsewhere (a street marked on the map). */
  export async function refresh() {
    await loadAreas();
    if (area && mode === "detail") await open(area.id, false);
  }
  $effect(() => {
    const t = teamId;
    try { localStorage.setItem("streetsweep.areasTeam", t); } catch { /* fine */ }
    untrack(() => {
      onteam?.(t);
      loading = true;
      back();
      loadAreas();
    });
  });
  onDestroy(() => {
    clearTimeout(pollTimer);
    clearTimeout(searchTimer);
    draw?.stop();
  });

  // ---- search ----
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const term = q.trim();
    clearTimeout(searchTimer);
    addresses = null; // a new search: old address results no longer apply
    if (term.length < 2) {
      results = [];
      return;
    }
    searchTimer = setTimeout(async () => {
      searching = true;
      try {
        results = (await api<{ areas: Area[] }>(`/api/areas/search?q=${encodeURIComponent(term)}`)).areas;
      } catch (e) {
        error = errorText(e);
      } finally {
        searching = false;
      }
    }, 250);
  });

  async function findAddress() {
    const term = q.trim();
    if (term.length < 3 || lookingUp) return;
    lookingUp = true;
    error = null;
    try {
      addresses = (await api<{ results: Address[] }>(`/api/geocode?q=${encodeURIComponent(term)}`)).results;
      // One clear answer: go straight there.
      if (addresses.length === 1) goTo(addresses[0]);
    } catch (e) {
      error = errorText(e);
    } finally {
      lookingUp = false;
    }
  }

  function goTo(a: Address) {
    ctl.showSearchResult(a.lon, a.lat, a.bbox, { left: panelWidth });
  }

  /** "123 Main Street, Austin, Travis County, Texas, 78701, United States" → first two parts, then the rest. */
  const addressHead = (l: string) => l.split(", ").slice(0, 2).join(", ");
  const addressTail = (l: string) => l.split(", ").slice(2).filter((p) => p !== "United States").join(", ");

  // ---- one area ----
  export async function open(id: string, move = true) {
    error = null;
    // Asked for an area (a click on the map): come back into view to show it.
    onshow?.();
    try {
      const r = await api<{ area: Area; can_edit: boolean }>(`/api/areas/${id}`);
      area = r.area;
      areaCanEdit = r.can_edit;
      editing = false;
      mode = "detail";
      const inTeam = areas.some((a) => a.id === id);
      ctl.setSelectedArea(inTeam ? id : null);
      ctl.setPreview(inTeam ? null : r.area.geometry ?? null);
      if (move) ctl.fitBounds(r.area.bbox, { left: panelWidth, animate: true });
    } catch (e) {
      error = errorText(e);
    }
  }

  function back() {
    mode = "list";
    area = null;
    editing = false;
    ctl.setSelectedArea(null);
    ctl.setPreview(null);
  }

  async function act(fn: () => Promise<unknown>, after?: () => Promise<void> | void) {
    busy = true;
    error = null;
    try {
      await fn();
      await after?.();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  // Shows as followed as soon as the server says yes; the list (with progress) catches up.
  // "Already follows" counts as done (a first click that went through).
  const follow = () => act(async () => {
    const a = area!;
    try {
      await api(`/api/teams/${teamId}/follows`, { body: { area_id: a.id } });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
    if (!areas.some((x) => x.id === a.id)) {
      areas = [...areas, a];
      ctl.setTeamAreas(areaFeatures(areas));
      ctl.setPreview(null);
      ctl.setSelectedArea(a.id);
    }
  }, async () => {
    await loadAreas();
    if (area) await open(area.id, false);
  });
  const unfollow = () => {
    if (!confirm(`Stop following ${area!.name}? Its drives stay; it just leaves this team's list.`)) return;
    act(() => api(`/api/teams/${teamId}/follows/${area!.id}`, { method: "DELETE" }), async () => {
      await loadAreas();
      await open(area!.id, false);
    });
  };

  function startEdit() {
    form = { name: area!.name, notes: area!.notes ?? "", level: drawnLevel(area!.level) };
    editing = true;
  }
  function saveEdit(el: HTMLFormElement) {
    const f = formValues(el);
    form.name = f.name ?? form.name;
    form.notes = f.notes ?? form.notes;
    act(() => api(`/api/areas/${area!.id}`, { method: "PATCH", body: { name: form.name.trim(), notes: form.notes.trim() || null, level: form.level } }),
      async () => {
        editing = false;
        await loadAreas();
        await open(area!.id, false);
      });
  }
  function remove() {
    if (!confirm(`Delete ${area!.name}? This can't be undone.`)) return;
    act(() => api(`/api/areas/${area!.id}`, { method: "DELETE" }), async () => {
      back();
      await loadAreas();
    });
  }

  // ---- drafts ----
  // The outline being drawn is kept in this browser as it changes, so a crash, a flat
  // battery or a closed tab loses nothing: the Areas page offers it back next time.
  type Draft = { team: string; areaId: string | null; name: string; level: DrawnLevel; rings: Ring[]; at: number };
  const DRAFT_KEY = "streetsweep.areaDraft";
  let draft = $state<Draft | null>(readDraft());
  /** Something drawn or changed since this drawing began (worth keeping, worth asking before dropping). */
  let dirty = $state(false);
  let draftTimer: ReturnType<typeof setTimeout> | undefined;

  function readDraft(): Draft | null {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
      return d && Array.isArray(d.rings) && typeof d.team === "string" ? d : null;
    } catch { return null; }
  }
  function writeDraft(d: Draft | null) {
    draft = d;
    try {
      if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* private window: no keeping, but drawing still works */ }
  }
  /** Keep the drawing a moment after it last changed (drags and typing settle first). */
  function keepDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftNow, 500);
  }
  function saveDraftNow() {
    clearTimeout(draftTimer);
    if (!draw || !dirty) return;
    const rings = draw.rings();
    writeDraft(rings.length || form.name.trim()
      ? { team: teamId, areaId: redrawing?.id ?? null, name: form.name, level: form.level, rings, at: Date.now() }
      : null);
  }
  // The name and kind are part of it too.
  $effect(() => {
    void form.name; void form.level;
    if (untrack(() => mode === "draw" && dirty)) keepDraft();
  });

  async function resumeDraft() {
    const d = draft;
    if (!d) return;
    if (d.team !== teamId && teams.some((t) => t.id === d.team)) {
      teamId = d.team;
      await tick();
      await loadAreas();
    }
    const existing = d.areaId ? areas.find((a) => a.id === d.areaId) ?? null : null;
    startDraw(existing, d);
  }
  function discardDraft() {
    if (!confirm("Discard the unsaved drawing? This can't be undone.")) return;
    writeDraft(null);
  }
  const draftAge = (at: number) => {
    const mins = Math.round((Date.now() - at) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  // Leaving with unsaved changes: the browser asks (the draft is kept either way).
  onMount(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (mode !== "draw" || !dirty) return;
      saveDraftNow();
      e.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  });

  // ---- shorelines: snapped to while drawing, and the water trimmed off ----
  let drawNote = $state<string | null>(null);
  let trimming = $state(false);
  let shoreTimer: ReturnType<typeof setTimeout> | undefined;
  let shoreAbort: AbortController | null = null;
  async function loadShores() {
    if (!draw) return;
    const b = ctl.map.getBounds();
    shoreAbort?.abort();
    shoreAbort = new AbortController();
    try {
      const r = await api<{ lines: Ring[] }>(
        `/api/water/shores?bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(",")}`,
        { signal: shoreAbort.signal });
      draw?.setShores(r.lines);
    } catch { /* no snapping to water, that's all */ }
  }
  const onMoveEnd = () => { clearTimeout(shoreTimer); shoreTimer = setTimeout(() => { loadShores(); loadSnapLines(); }, 250); };

  // ---- Existing areas of the same kind: shown while drawing, and snapped to ----
  let showOthers = $state(readOthers());
  function readOthers() {
    try { return localStorage.getItem("streetsweep.drawOthers") !== "off"; } catch { return true; }
  }
  function setOthers(on: boolean) {
    showOthers = on;
    try { localStorage.setItem("streetsweep.drawOthers", on ? "on" : "off"); } catch { /* fine */ }
  }
  /** Neighbourhoods and custom areas go together; sections with sections. */
  const kindOf = (level: string) => (level === "section" ? "section" : "neighborhood");
  const sameKind = (a: string, b: string) => kindOf(a) === kindOf(b);
  let others = $derived(mode === "draw" && showOthers
    ? areas.filter((a) => a.geometry && a.id !== redrawing?.id && a.source === "drawn" && sameKind(a.level, form.level))
    : []);
  $effect(() => {
    const list = others;
    untrack(() => {
      draw?.setNeighbours(list.flatMap((a) => ringsOf(a.geometry!)));
      ctl.setDrawReference(list.map((a) => ({ type: "Feature", properties: { color: colorOf(a) }, geometry: a.geometry! })));
    });
  });

  // ---- Snap: streets and boundary lines in view, when it's on ----
  let snap = $state(readSnap());
  let streetsTooFar = $state(false);
  let snapAbort: AbortController | null = null;
  function readSnap() {
    try { return localStorage.getItem("streetsweep.drawSnap") === "on"; } catch { return false; }
  }
  function setSnap(on: boolean) {
    snap = on;
    try { localStorage.setItem("streetsweep.drawSnap", on ? "on" : "off"); } catch { /* fine */ }
    if (draw) draw.snapping = on;
    if (on) loadSnapLines();
    else ctl.setSnapLines([]);
  }
  async function loadSnapLines() {
    if (!draw || !snap) return;
    const b = ctl.map.getBounds();
    const w = b.getWest(), so = b.getSouth(), e = b.getEast(), n = b.getNorth();
    const bbox = [w, so, e, n].map((x) => x.toFixed(5)).join(",");
    snapAbort?.abort();
    snapAbort = new AbortController();
    const signal = snapAbort.signal;
    streetsTooFar = e - w > 0.2 || n - so > 0.2;
    const [lines, segs] = await Promise.all([
      api<{ lines: Ring[] }>(`/api/areas/lines?bbox=${bbox}`, { signal }).catch(() => null),
      streetsTooFar ? Promise.resolve(null) : api<{ segments: unknown[][] }>(`/api/segments?bbox=${bbox}`, { signal }).catch(() => null),
    ]);
    if (signal.aborted || !draw) return;
    const streets = segs ? segs.segments.map((row) => decodePolyline(String(row[row.length - 1]))).filter((r) => r.length >= 2) : null;
    draw.setSnapLines(streets, lines?.lines ?? null);
    if (lines && snap) ctl.setSnapLines(lines.lines);
  }

  /** Tidy: round the streets inside, 10 m out or halfway to the next street (server). Undoable. */
  async function tidy() {
    const geometry = draw?.geometry();
    if (!draw || !geometry) { drawNote = "Draw a rough outline round the streets first, then tidy it."; return; }
    trimming = true;
    drawNote = null;
    error = null;
    try {
      const r = await api<{ geometry: GeoJSON.MultiPolygon; pieces: number }>("/api/areas/tidy", { body: { geometry } });
      draw.replaceAll(ringsOf(r.geometry));
      drawNote = `Tidied round ${r.pieces} street piece${r.pieces === 1 ? "" : "s"}: 10 m out, or halfway to the next street. Undo puts your drawing back.`;
    } catch (e) {
      error = errorText(e);
    } finally {
      trimming = false;
    }
  }

  // Drawing takes the bottom of the screen: the nav bar steps aside.
  $effect(() => {
    ui.drawing = mode === "draw";
  });
  onDestroy(() => { ui.drawing = false; });

  // Keys while drawing: undo, redo, delete the selected piece, Escape stops a piece.
  function onKey(e: KeyboardEvent) {
    if (mode !== "draw" || !draw) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) draw.redo(); else draw.undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); draw.redo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && draw.selected) { e.preventDefault(); draw.deleteSelected(); }
    else if (e.key === "Escape" && draw.drawing) draw.cancelPiece();
  }

  async function trimWater() {
    const geometry = draw?.geometry();
    if (!draw || !geometry) { drawNote = "Draw the outline first, running it out into the water; then trim to the shoreline."; return; }
    trimming = true;
    drawNote = null;
    error = null;
    try {
      const r = await api<{ geometry: GeoJSON.MultiPolygon | null; removed_m2: number; note?: string }>("/api/water/trim", { body: { geometry } });
      if (!r.geometry) { drawNote = r.note ?? "Nothing to trim."; return; }
      draw.replaceAll(ringsOf(r.geometry));
      const acres = r.removed_m2 / 4046.86;
      drawNote = `Trimmed ${acres < 10 ? acres.toFixed(1) : Math.round(acres).toLocaleString()} acres of water. Undo puts it back.`;
    } catch (e) {
      error = errorText(e);
    } finally {
      trimming = false;
    }
  }

  // ---- drawing ----
  async function startDraw(existing: Area | null, from: Draft | null = null) {
    if (!from && draft && !confirm(`You have an unsaved drawing${draft.name ? ` (${draft.name})` : ""}. Start a new one and discard it?`)) return;
    redrawing = existing;
    form = from
      ? { name: from.name, notes: existing?.notes ?? "", level: from.level }
      : existing
        ? { name: existing.name, notes: existing.notes ?? "", level: drawnLevel(existing.level) }
        : { name: "", notes: "", level: "neighborhood" };
    // Which existing areas to snap to is kept up to date by the "Areas" toggle (see `others`).
    const neighbours: Ring[] = [];
    // Opened the page and went straight to drawing: the map has to be ready first.
    await ctl.ready();
    ctl.busy = true;
    ctl.showAreas(false);
    ctl.setPreview(null);
    dirty = !!from;
    if (!from) writeDraft(null);
    draw = new OutlineDraw(ctl.map, neighbours, () => { dirty = true; keepDraft(); });
    draw.snapping = snap;
    const rings = from ? from.rings : existing?.geometry ? ringsOf(existing.geometry) : [];
    if (rings.length) {
      draw.load(rings);
      const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
      if (from) ctl.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { left: panelWidth, animate: true });
    } else draw.addPiece();
    mode = "draw";
    drawNote = null;
    ctl.map.on("moveend", onMoveEnd);
    loadShores();
    loadSnapLines();
  }

  function endDraw() {
    clearTimeout(draftTimer);
    clearTimeout(shoreTimer);
    shoreAbort?.abort();
    ctl.map.off("moveend", onMoveEnd);
    snapAbort?.abort();
    ctl.setSnapLines([]);
    ctl.setDrawReference([]);
    dirty = false;
    draw?.stop();
    draw = null;
    ctl.busy = false;
    ctl.showAreas(true);
  }

  function cancelDraw() {
    if (dirty && !confirm("Discard this drawing? Your changes won't be kept.")) return;
    writeDraft(null);
    const was = redrawing;
    endDraw();
    redrawing = null;
    if (was) open(was.id, false);
    else back();
  }

  async function saveDraw(el: HTMLFormElement) {
    const f = formValues(el);
    form.name = f.name ?? form.name;
    const geometry = draw?.geometry();
    if (!geometry) {
      error = "Draw the outline first: click each corner, then the first corner again to close it.";
      return;
    }
    if (!form.name.trim()) {
      error = "Give the area a name.";
      return;
    }
    busy = true;
    error = null;
    try {
      let id: string;
      if (redrawing) {
        await api(`/api/areas/${redrawing.id}`, { method: "PATCH", body: { geometry, name: form.name.trim(), level: form.level } });
        id = redrawing.id;
      } else {
        id = (await api<{ id: string }>(`/api/teams/${teamId}/areas`, { body: { name: form.name.trim(), level: form.level, geometry } })).id;
      }
      writeDraft(null);
      endDraw();
      redrawing = null;
      await loadAreas();
      await open(id, false);
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  // ---- words ----
  /** The team's progress in an area it follows or drew (the list carries it). */
  const progressOf = (id: string) => {
    const a = areas.find((x) => x.id === id);
    return a && a.build_status === "built" && a.total_m ? a : null;
  };
  const share = (a: Area) => Math.min(100, ((a.driven_m ?? 0) / a.total_m!) * 100);
  /** Small areas in acres, bigger ones in square miles (everything else here is in miles). */
  function size(km2: number) {
    const sqmi = km2 * 0.386102;
    if (sqmi < 1) return `${Math.max(1, Math.round(sqmi * 640)).toLocaleString()} acres`;
    return `${sqmi < 10 ? sqmi.toFixed(1) : Math.round(sqmi).toLocaleString()} sq mi`;
  }
  const ownerOf = (a: Area) => (teams.find((t) => t.id === a.team_id)?.kind === "personal" ? "yours" : `drawn by ${a.team_name ?? "a team"}`);
  function status(a: Area): string {
    if (a.build_status === "queued") return "Waiting to list its streets";
    if (a.build_status === "building") return "Listing its streets…";
    if (a.build_status === "failed") return "Couldn't list its streets";
    if (a.build_status === "built") return `${miles(a.street_m)} of streets`;
    return a.km2 ? size(a.km2) : "";
  }
  const kind = (a: Area) => `${LEVEL_LABEL[a.level]}${a.parent_name ? ` in ${a.parent_name}` : ""}`;
</script>

{#snippet row(a: Area)}
  <button class="item" onclick={() => open(a.id)}>
    <span class="swatch" style:background={colorOf(a)}></span>
    <span class="grow">
      <strong>{a.name}</strong>
      <span class="muted small">{a.source === "drawn" ? LEVEL_LABEL[a.level] : kind(a)} · {status(a)}</span>
      {#if progressOf(a.id)}
        <span class="bar" title="{miles(a.driven_m)} of {miles(a.total_m)} swept"><span style:width="{share(a)}%" style:background={colorOf(a)}></span></span>
      {/if}
    </span>
    {#if progressOf(a.id)}<span class="pct">{percent(a.driven_m ?? 0, a.total_m!)}</span>{/if}
    {#if a.build_status === "queued" || a.build_status === "building"}<span class="spin" aria-label="Working"></span>{/if}
  </button>
{/snippet}

{#snippet branch(nodes: Node[], depth: number)}
  {#each nodes as n (n.area.id)}
    <div class="node" style:padding-left="{depth * 16}px">
      {#if n.children.length}
        <button class="fold" class:shut={collapsed.has(n.area.id)} onclick={() => toggle(n.area.id)}
          aria-label="{collapsed.has(n.area.id) ? 'Open' : 'Close'} {n.area.name}" aria-expanded={!collapsed.has(n.area.id)}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      {:else}
        <span class="fold-space"></span>
      {/if}
      {@render row(n.area)}
    </div>
    {#if n.children.length && !collapsed.has(n.area.id)}{@render branch(n.children, depth + 1)}{/if}
  {/each}
{/snippet}

<aside class="panel" class:hidden={!shown && mode !== "draw"} style:width="{panelWidth}px">
  {#if mode === "list"}
    <header>
      <label class="team">
        <span class="muted small">Areas for</span>
        <select bind:value={teamId} aria-label="Team">
          {#each teams as t (t.id)}<option value={t.id}>{t.kind === "personal" ? "Just me" : t.name}</option>{/each}
        </select>
      </label>
      {#if canEdit}<button class="sm primary" onclick={() => startDraw(null)}><Icon name="plus" size={16} /> Draw</button>{/if}
      {#if onhide}<button class="sm ghost icon" onclick={onhide} aria-label="Hide areas" title="Hide areas">✕</button>{/if}
    </header>

    <form class="search" role="search" onsubmit={(e) => { e.preventDefault(); findAddress(); }}>
      <Icon name="search" size={17} />
      <input type="search" placeholder="County, city or address" bind:value={q} aria-label="Find a county, city or address" />
    </form>

    {#if error}<p class="notice error">{error}</p>{/if}

    {#if draft}
      <div class="draft">
        <div class="grow">
          <strong>Unsaved drawing{draft.name.trim() ? `: ${draft.name.trim()}` : ""}</strong>
          <span class="muted small">{draft.areaId ? "Redrawing an area" : "A new area"} · {draft.rings.length} piece{draft.rings.length === 1 ? "" : "s"} · kept {draftAge(draft.at)}</span>
        </div>
        <div class="row-btns">
          <button class="sm primary" onclick={resumeDraft}>Resume</button>
          <button class="sm ghost" onclick={discardDraft}>Discard</button>
        </div>
      </div>
    {/if}

    {#if q.trim().length >= 2}
      <div class="list">
        {#each results as a (a.id)}
          <button class="item" onclick={() => open(a.id)}>
            <span class="swatch outline"></span>
            <span class="grow"><strong>{a.name}</strong><span class="muted small">{kind(a)}</span></span>
            {#if a.followed_by?.includes(teamId)}<span class="badge green">Following</span>{/if}
          </button>
        {:else}
          {#if searching}<p class="muted small pad">Searching…</p>{/if}
        {/each}
        {#if addresses === null}
          {#if q.trim().length >= 3}
            <button class="item addr-ask" disabled={lookingUp} onclick={findAddress}>
              <Icon name="pin" size={16} />
              <span class="grow"><strong>{lookingUp ? "Looking up…" : `Find “${q.trim()}” as an address`}</strong><span class="muted small">or press Enter</span></span>
            </button>
          {/if}
        {:else}
          <p class="muted small pad addr-head">Addresses</p>
          {#each addresses as a (a.label + a.lat)}
            <button class="item" onclick={() => goTo(a)}>
              <span class="pin"><Icon name="pin" size={16} /></span>
              <span class="grow"><strong>{addressHead(a.label)}</strong><span class="muted small">{addressTail(a.label)}</span></span>
            </button>
          {:else}
            <p class="muted small pad">No address like that in the imported region.</p>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="list">
        {#if listed.roots.length}
          <p class="muted small pad addr-head">{showAll ? "All areas" : "In view"}</p>
          {@render branch(listed.roots, 0)}
          {#if showAll}
            <button class="sm ghost more" onclick={() => (showAll = false)}>Show only areas in view</button>
          {:else if listed.hidden > 0}
            <p class="muted small pad">{listed.hidden} more out of view. <button class="link" onclick={() => (showAll = true)}>Show all</button></p>
          {/if}
        {:else if areas.length}
          <div class="empty muted small">
            <p>None of the team's {areas.length} areas are in view. Move the map, or <button class="link" onclick={() => (showAll = true)}>show them all</button>.</p>
          </div>
        {:else if !loading}
          <div class="empty muted small">
            <p><strong>No areas yet.</strong></p>
            <p>Search for your county or city above and follow it{canEdit ? ", or draw your own neighborhood" : ""}.
              {#if !canEdit} Only {team?.kind === "personal" ? "you" : "this team's admins"} can add areas.{/if}</p>
          </div>
        {/if}
      </div>
    {/if}

  {:else if mode === "detail" && area}
    <header>
      <button class="sm ghost back" onclick={back}><Icon name="back" size={16} /> Areas</button>
      {#if onhide}<button class="sm ghost icon" onclick={onhide} aria-label="Hide areas" title="Hide areas">✕</button>{/if}
    </header>
    {#if error}<p class="notice error">{error}</p>{/if}
    <div class="detail">
      <div class="title">
        <span class="swatch big" class:outline={!followedHere(area) && area.source !== "drawn"} style:background={followedHere(area) || area.source === "drawn" ? colorOf(area) : "none"}></span>
        <div>
          <h2>{area.name}</h2>
          <p class="muted small">{area.source === "drawn" ? `${LEVEL_LABEL[area.level]}${area.parent_name ? ` in ${area.parent_name}` : ""} · ${ownerOf(area)}` : kind(area)}</p>
        </div>
      </div>

      <div class="facts">
        <div><span class="muted small">Street length</span><strong>{area.build_status === "built" ? miles(area.street_m) : "—"}</strong></div>
        <div><span class="muted small">Streets</span><strong>{progressOf(area.id)?.total_streets?.toLocaleString() ?? "—"}</strong></div>
        <div><span class="muted small">Size</span><strong>{size(area.km2)}</strong></div>
      </div>

      {#if progressOf(area.id)}
        {@const p = progressOf(area.id)!}
        <div class="progress">
          <div class="progress-head">
            <strong>{percent(p.driven_m ?? 0, p.total_m!)} swept</strong>
            <span class="muted small">{team?.kind === "personal" ? "by you" : `by ${team?.name}`}</span>
          </div>
          <span class="bar big"><span style:width="{share(p)}%" style:background={colorOf(area)}></span></span>
          <span class="muted small">{miles(p.driven_m)} of {miles(p.total_m)} · {(p.driven_streets ?? 0).toLocaleString()} of {(p.total_streets ?? 0).toLocaleString()} streets done{p.started_streets ? `, ${p.started_streets.toLocaleString()} begun` : ""}.
            Streets marked done count; ones left out don't count against you.</span>
          {#if onmissing && (p.driven_m ?? 0) < (p.total_m ?? 0)}
            <div><button class="sm" onclick={() => area && onmissing(area, teamId)}>Highlight what's left</button></div>
          {/if}
        </div>
      {/if}

      {#if area.build_status === "queued" || area.build_status === "building"}
        <p class="notice">{status(area)}. This takes a few seconds for a city and a few minutes for a whole state.</p>
      {:else if area.build_status === "failed"}
        <p class="notice error">Couldn't list its streets{area.build_error ? `: ${area.build_error}` : ""}.</p>
      {:else if area.build_status === "none" && area.source === "osm_boundary"}
        <p class="muted small">Follow it to list its streets and track coverage for {team?.kind === "personal" ? "yourself" : team?.name}.</p>
      {/if}

      {#if area.notes && !editing}<p class="notes">{area.notes}</p>{/if}

      {#if area.source === "osm_boundary"}
        {#if canEdit}
          {#if followedHere(area)}
            <button disabled={busy} onclick={unfollow}>Unfollow</button>
          {:else}
            <button class="primary" disabled={busy} onclick={follow}>Follow for {team?.kind === "personal" ? "me" : team?.name}</button>
          {/if}
        {:else if followedHere(area)}
          <span class="badge green">Followed by this team</span>
        {/if}
        <p class="muted small">From OpenStreetMap. Boundaries refresh with the monthly import.</p>
      {:else if areaCanEdit}
        {#if editing}
          <form class="stack" onsubmit={(e) => { e.preventDefault(); saveEdit(e.currentTarget); }}>
            <label class="field">Name <input type="text" name="name" bind:value={form.name} maxlength="120" autocomplete="off" required /></label>
            <label class="field">Kind
              <select bind:value={form.level}><option value="neighborhood">Neighborhood</option><option value="section">Section of a neighborhood</option><option value="custom">Custom area</option></select></label>
            <label class="field">Notes <textarea name="notes" bind:value={form.notes} maxlength="2000"></textarea></label>
            <div class="row-btns"><button type="button" class="ghost" onclick={() => (editing = false)}>Cancel</button><button type="submit" class="primary" disabled={busy}>Save</button></div>
          </form>
        {:else}
          <div class="row-btns">
            <button disabled={busy} onclick={startEdit}>Edit</button>
            <button disabled={busy} onclick={() => startDraw(area)}>Redraw outline</button>
            <button class="ghost danger" disabled={busy} onclick={remove}>Delete</button>
          </div>
        {/if}
      {/if}
    </div>

  {:else if mode === "draw" && draw}
    <header><h2>{redrawing ? `Redraw ${redrawing.name}` : "Draw an area"}</h2></header>
    {#if error}<p class="notice error">{error}</p>{/if}
    <p class="muted small">
      {#if draw.drawing}Click each corner on the map. Click the first corner again (or double-click) to close the shape.
      {:else}Drag a corner to move it; drag the dot between two corners to add one. Click a corner to delete it. An area can have several pieces.{/if}
    </p>
    {#if snap}
      <p class="muted small">{streetsTooFar
        ? "Snap is on: zoom in closer to snap to streets too. City, county and state lines snap at any zoom."
        : "Snap is on: corners land on intersections, streets and city, county and state lines, as well as neighbouring areas and shorelines."}</p>
    {/if}
    {#if drawNote}<p class="notice">{drawNote}</p>{/if}
    <div class="tool-btns">
      <button class="sm" disabled={trimming || draw.pieces === 0} onclick={tidy}
        title="Wrap the streets inside 10 m out, or halfway to the next street outside">✨ Tidy round the streets</button>
      <span class="muted small">Draw roughly round a neighbourhood, then tidy: the outline wraps the streets inside 10 m out, or halfway to the next street where that's closer, so neighbours meet on one line.</span>
      <button class="sm" disabled={trimming || draw.pieces === 0} onclick={trimWater}
        title="Cut mapped lakes, ponds and rivers out of the outline, keeping the land as drawn">{trimming ? "Working…" : "Trim to shoreline"}</button>
      <span class="muted small">Draw a big shape out into the water, then trim: the land stays as drawn.</span>
    </div>
    <span class="muted small">{draw.pieces} piece{draw.pieces === 1 ? "" : "s"}</span>
    <form class="stack" onsubmit={(e) => { e.preventDefault(); saveDraw(e.currentTarget); }}>
      <label class="field">Name <input type="text" name="name" bind:value={form.name} maxlength="120" autocomplete="off" placeholder="e.g. Old Town" required /></label>
      <label class="field">Kind
        <select bind:value={form.level}><option value="neighborhood">Neighborhood</option><option value="section">Section of a neighborhood</option><option value="custom">Custom area</option></select></label>
      <div class="row-btns"><button type="button" class="ghost" onclick={cancelDraw}>Cancel</button><button type="submit" class="primary" disabled={busy}>Save area</button></div>
      <p class="muted small kept">{dirty ? "Kept on this computer as you draw, until you save or cancel." : " "}</p>
    </form>
  {/if}
</aside>

{#if mode === "draw" && draw}
  <!-- The drawing tools, floating along the bottom of the map (as on the iPad). -->
  <div class="palette" role="toolbar" aria-label="Drawing tools">
    <button class="tool" class:on={draw.drawing} aria-pressed={draw.drawing} onclick={() => draw!.addPiece()} title="Click each corner to add a piece">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 18 9 6l10 4-6 9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><circle cx="5" cy="18" r="2" fill="currentColor" /><circle cx="9" cy="6" r="2" fill="currentColor" /><circle cx="19" cy="10" r="2" fill="currentColor" /><circle cx="13" cy="19" r="2" fill="currentColor" /></svg>
      <span>Corners</span>
    </button>
    <button class="tool" class:on={!draw.drawing} aria-pressed={!draw.drawing} onclick={() => draw!.cancelPiece()} title="Drag corners, add them from the midpoints, click a piece to select it">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 3l12 9-5.5 1.2L15 20l-2.5 1-2.6-6.7L6 18z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>
      <span>Edit</span>
    </button>
    <span class="pdiv" aria-hidden="true"></span>
    <button class="tool others" class:on={showOthers} aria-pressed={showOthers} onclick={() => setOthers(!showOthers)}
      title="Show the team's other {form.level === 'section' ? 'sections' : 'neighbourhoods'} and snap to their edges">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 5h8v7H3zM13 5h8v14h-8zM3 14h8v5H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>
      <span>Areas</span>
    </button>
    <button class="tool snap" class:on={snap} aria-pressed={snap} onclick={() => setSnap(!snap)} title="Snap to streets, intersections and city, county and state lines">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></svg>
      <span>Snap</span>
    </button>
    <button class="icon-btn" disabled={!draw.canUndo} onclick={() => draw!.undo()} title="Undo (⌘Z)" aria-label="Undo">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <button class="icon-btn" disabled={!draw.canRedo} onclick={() => draw!.redo()} title="Redo (⇧⌘Z)" aria-label="Redo">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m15 7 5 5-5 5M20 12H9a5 5 0 0 0 0 10h2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    {#if draw.selected}
      <button class="icon-btn danger" onclick={() => draw!.deleteSelected()} title="Delete the selected piece (Delete)" aria-label="Delete piece">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    {/if}
  </div>
{/if}

<svelte:window onkeydown={onKey} />

<style>
  .panel {
    position: absolute; top: 14px; left: 14px; max-height: calc(100% - 110px); z-index: 2;
    background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
    display: flex; flex-direction: column; gap: 10px; padding: 12px; overflow: auto;
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .hidden { display: none; }
  .icon { width: 30px; padding: 0; flex: none; }
  .team { display: grid; gap: 2px; flex: 1; min-width: 0; }
  .team select { height: 34px; font-weight: 700; }
  .search { position: relative; display: block; color: var(--ink-soft); }
  .search :global(svg) { position: absolute; left: 11px; top: 11px; }
  .search input { padding-left: 34px; }
  .pin { color: #e2721f; display: grid; place-items: center; width: 14px; flex: none; }
  .addr-ask { color: var(--link); }
  .addr-head { padding-bottom: 0; text-transform: uppercase; letter-spacing: .04em; font-size: 11.5px; }
  .list { display: grid; gap: 2px; }
  .node { display: flex; align-items: center; gap: 2px; }
  .node .item { flex: 1; min-width: 0; }
  .fold { width: 22px; height: 30px; padding: 0; border: 0; background: none; flex: none; color: var(--ink-soft); display: grid; place-items: center; }
  .fold svg { transition: transform .15s; }
  .fold.shut svg { transform: rotate(-90deg); }
  .fold-space { width: 22px; flex: none; }
  .link { border: 0; background: none; padding: 0; height: auto; color: var(--link); font: inherit; font-weight: 600; cursor: pointer; }
  .link:hover:not([disabled]) { background: none; text-decoration: underline; }
  .more { justify-self: start; margin: 4px 0 0 6px; }
  .item {
    display: flex; align-items: center; justify-content: flex-start; gap: 10px; text-align: left; height: auto; padding: 9px 10px; white-space: normal;
    border: 0; background: none; border-radius: 10px; width: 100%; font-weight: 400;
  }
  .item:hover:not([disabled]) { background: var(--surface-2); }
  .item .grow { display: grid; gap: 1px; min-width: 0; }
  .item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { width: 14px; height: 14px; border-radius: 4px; flex: none; }
  .swatch.outline { border: 2px dashed #6b7c8f; background: none; }
  .swatch.big { width: 22px; height: 22px; border-radius: 6px; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--green-600); animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { padding: 12px 6px; display: grid; gap: 6px; }
  .pad { padding: 8px 6px; }
  .back { padding-left: 6px; }
  .detail { display: grid; gap: 12px; }
  .title { display: flex; gap: 10px; align-items: flex-start; }
  .title .swatch { margin-top: 3px; }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .facts div { display: grid; gap: 1px; background: var(--surface-2); border-radius: 10px; padding: 8px 10px; }
  .notes { white-space: pre-wrap; font-size: 13.5px; }
  .bar { display: block; height: 5px; border-radius: 99px; background: var(--line); overflow: hidden; margin-top: 4px; }
  .bar > span { display: block; height: 100%; border-radius: 99px; min-width: 2px; }
  .bar.big { height: 9px; margin: 0; }
  .pct { font-size: 12.5px; font-weight: 700; color: var(--ink-soft); flex: none; }
  .progress { display: grid; gap: 6px; }
  .progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .row-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .tool-btns { display: grid; gap: 4px; justify-items: start; }
  .tool-btns span { margin-bottom: 6px; }
  .palette {
    position: absolute; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 3;
    display: flex; align-items: center; gap: 6px; padding: 8px;
    background: rgba(255, 255, 255, .88); backdrop-filter: blur(16px) saturate(1.4); -webkit-backdrop-filter: blur(16px) saturate(1.4);
    border: 1px solid var(--line); border-radius: 22px; box-shadow: 0 8px 28px rgba(13, 27, 40, .18);
  }
  .tool {
    display: grid; justify-items: center; gap: 2px; width: 68px; height: 56px; padding: 0; border: 0; border-radius: 14px;
    background: none; color: var(--ink); font-size: 11px; font-weight: 700;
  }
  .tool:hover:not([disabled]) { background: var(--surface-2); }
  .tool.on { background: var(--green-600); color: #fff; }
  .tool.on:hover:not([disabled]) { background: var(--green-700); }
  .tool.snap.on { background: #f08a24; }
  .tool.others.on { background: #4363d8; }
  .tool.others.on:hover:not([disabled]) { background: #3552c4; }
  .tool.snap.on:hover:not([disabled]) { background: #e07a14; }
  .tool svg { margin-top: 6px; }
  .pdiv { width: 1px; height: 40px; background: var(--line); margin: 0 4px; }
  .icon-btn { width: 52px; height: 56px; padding: 0; border: 0; background: none; border-radius: 14px; color: var(--ink); display: grid; place-items: center; }
  .icon-btn:hover:not([disabled]) { background: var(--surface-2); }
  .icon-btn[disabled] { opacity: .3; }
  .icon-btn.danger { color: var(--danger); }
  .danger { color: var(--danger); }
  .draft {
    display: grid; gap: 8px; padding: 10px 12px; border-radius: 10px;
    background: #fff7e6; border: 1px solid #f5c76b;
  }
  .draft .grow { display: grid; gap: 1px; }
  .kept { margin: 0; }
  :global(.corner-menu) { display: grid; gap: 6px; padding-top: 2px; }
  :global(.corner-menu button) { justify-content: flex-start; }
  @media (max-width: 760px) {
    .panel { top: auto; left: 8px; right: 8px; bottom: 84px; width: auto !important; max-height: 44%; }
  }
</style>
