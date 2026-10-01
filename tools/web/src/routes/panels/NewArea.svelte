<script lang="ts">
  import { onDestroy } from "svelte";
  import { store } from "../../lib/store.svelte";
  import { ws } from "../../lib/workspace.svelte";
  import { router } from "../../lib/router.svelte";
  import { findBoundaries, type Boundary } from "../../lib/boundary";
  import { OutlineDraw } from "../../lib/draw.svelte";
  import { cellsOf, squareMiles, areaSize } from "../../lib/geo";
  import { LEVEL_LABEL, ORGANIZATIONAL } from "../../lib/levels";
  import Icon from "../../lib/Icon.svelte";
  import DetailsForm, { type Details } from "./DetailsForm.svelte";
  import type { Level, Ring } from "../../lib/types";

  /** Step one: where the outline comes from. Step two: what to call it and where it sits. */
  let step = $state<"source" | "details">("source");
  let source = $state<"osm" | "draw">("osm");

  // ---- from OpenStreetMap ----
  let q = $state("");
  let searching = $state(false);
  let results = $state<Boundary[]>([]);
  let searched = $state(false);
  let chosen = $state<Boundary | null>(null);

  async function search(e: SubmitEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    searching = true; searched = false; results = []; chosen = null;
    try {
      results = await findBoundaries(q.trim());
      if (results[0]) preview(results[0]);
    } catch (err) {
      ws.say((err as Error).message, { tone: "bad" });
    } finally {
      searching = false; searched = true;
    }
  }
  function preview(b: Boundary) {
    chosen = b;
    ws.map?.setPreview(b.rings);
    ws.map?.fit(b.rings);
  }

  // ---- drawn by hand ----
  let editor = $state<OutlineDraw | null>(null);
  let drawn = $state<Ring[]>([]);
  function startDrawing() {
    source = "draw";
    ws.map?.setPreview(null);
    if (editor || !ws.map) return;
    ws.map.busy = true;
    editor = new OutlineDraw(ws.map.map, store.areas.flatMap((a) => [a.polygon, ...a.morePieces]),
      () => (drawn = editor!.rings()));
    editor.addPiece();
  }
  function stopDrawing() {
    editor?.stop();
    editor = null;
    drawn = [];
    if (ws.map) ws.map.busy = false;
  }
  onDestroy(() => { stopDrawing(); ws.map?.setPreview(null); });

  $effect(() => {
    const m = ws.map;
    if (!m) return;
    const styles: Record<number, { id: number; fraction: number | null; focus: boolean; dim: boolean }> = {};
    for (const a of store.areas) styles[a.id] = { id: a.id, fraction: null, focus: false, dim: true };
    m.setAreas(store.areas, styles);
    m.setStreets([]);
    m.onAreaClick = null; m.onStreetClick = null;
  });

  const rings = $derived(source === "osm" ? chosen?.rings || [] : drawn);
  const ready = $derived(rings.length > 0 && !(source === "draw" && editor?.drawing));

  // ---- details, then save ----
  let saving = $state(false);
  const start = $derived<Details>({
    name: source === "osm" && chosen ? chosen.name : "",
    level: (source === "osm" && chosen ? chosen.level : "NEIGHBORHOOD") as Level,
    parents: [], city: source === "osm" && chosen?.city ? chosen.city : "", notes: "", color: "",
  });

  async function create(d: Details) {
    saving = true;
    try {
      const area = await store.save({
        name: d.name, level: d.level, parentName: d.parents[0] || null, alsoIn: d.parents.slice(1),
        city: d.city || null, notes: d.notes || null, color: d.color || null,
        polygon: rings[0], morePieces: rings.slice(1),
      });
      stopDrawing();
      ws.say(`${area.name} added` + (ORGANIZATIONAL.has(area.level) ? "" : " — counting its streets"));
      router.go(`/map/area/${area.id}`);
    } catch (e) {
      ws.say("Not added: " + (e as Error).message, { tone: "bad" });
    } finally {
      saving = false;
    }
  }
</script>

<div class="head">
  <button class="ghost sm back" onclick={() => (step === "details" ? (step = "source") : router.go("/map"))}>
    <Icon name="back" size={16} /> {step === "details" ? "Outline" : "All areas"}
  </button>
  <h2>New area</h2>
  <ol class="steps"><li class:on={step === "source"}>Outline</li><li class:on={step === "details"}>Details</li></ol>
</div>

{#if step === "source"}
  <div class="body scroll">
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={source === "osm"} class:on={source === "osm"}
        onclick={() => { stopDrawing(); source = "osm"; if (chosen) preview(chosen); }}>
        <Icon name="globe" size={16} /> Find on OpenStreetMap
      </button>
      <button role="tab" aria-selected={source === "draw"} class:on={source === "draw"} onclick={startDrawing}>
        <Icon name="draw" size={16} /> Draw it
      </button>
    </div>

    {#if source === "osm"}
      <form class="search" onsubmit={search}>
        <input type="search" placeholder="Collin County, Texas" bind:value={q} />
        <button class="primary" disabled={searching || !q.trim()}>{searching ? "Looking…" : "Look up"}</button>
      </form>
      <p class="muted small">Counties, cities and neighborhoods are already drawn in OpenStreetMap. Take the outline instead of tracing it.</p>
      <ul class="results">
        {#each results as b}
          {@const org = ORGANIZATIONAL.has(b.level)}
          <li>
            <button class="res" class:on={chosen === b} onclick={() => preview(b)}>
              <b>{b.name}</b>
              <span class="muted small">{b.full}</span>
              <span class="small">
                {LEVEL_LABEL[b.level]} ·
                {b.rings.length > 1 ? `${b.rings.length} pieces · ` : ""}{b.corners.toLocaleString()} corners ·
                {org ? "groups the areas inside it; no streets are downloaded" : `${cellsOf(b.rings).length} map cells`}
              </span>
              {#if b.tolerance}<span class="muted small">Simplified from {b.original.toLocaleString()} corners, to about {Math.round(b.tolerance * 3.28084).toLocaleString()} ft of the surveyed line.</span>{/if}
            </button>
          </li>
        {:else}
          {#if searched}<li class="muted small">Nothing there with an outline. Counties, cities and neighborhoods have one; a street does not.</li>{/if}
        {/each}
      </ul>
    {:else}
      <div class="card how">
        {#if editor?.drawing}
          <p><b>Click the map for each corner</b>, then click the first corner (or double-click) to close the shape. Near another area’s edge, a corner lands exactly on it.</p>
        {:else if drawn.length}
          <p>{drawn.length === 1 ? "One piece" : `${drawn.length} pieces`} · {areaSize(squareMiles(drawn))}. Drag corners to adjust, or add another piece.</p>
        {/if}
        <div class="row">
          <button onclick={() => editor?.addPiece()} disabled={editor?.drawing}><Icon name="plus" size={15} /> {drawn.length ? "Add a piece" : "Start drawing"}</button>
          {#if editor?.selected && drawn.length > 1}
            <button class="danger" onclick={() => editor?.deleteSelected()}><Icon name="trash" size={15} /> Delete selected</button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
  <div class="foot">
    <button onclick={() => router.go("/map")}>Cancel</button>
    <button class="primary" disabled={!ready} onclick={() => (step = "details")}>Next: details <Icon name="chevron" size={15} /></button>
  </div>
{:else}
  <div class="body scroll">
    <p class="muted small">{rings.length > 1 ? `${rings.length} pieces · ` : ""}{areaSize(squareMiles(rings))}</p>
    {#key start}
      <DetailsForm value={start} {saving} submitLabel="Add area" onsubmit={create} oncancel={() => (step = "source")} />
    {/key}
  </div>
{/if}

<style>
  .head { padding: 10px 16px 12px; border-bottom: 1px solid var(--line); display: grid; gap: 6px; }
  .back { justify-self: start; margin-left: -8px; }
  .steps { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; counter-reset: s; }
  .steps li { counter-increment: s; font-size: 12px; font-weight: 600; color: var(--ink-soft); }
  .steps li::before { content: counter(s) ". "; }
  .steps li + li::before { content: "→ " counter(s) ". "; }
  .steps li.on { color: var(--ink); }
  .body { flex: 1; padding: 16px; display: grid; gap: 12px; align-content: start; }
  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .tabs button.on { border-color: var(--accent); background: var(--accent-soft); }
  .search { display: flex; gap: 8px; }
  .small { font-size: 12px; }
  .results { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .res { display: grid; gap: 2px; justify-items: start; width: 100%; height: auto; padding: 10px 12px; text-align: left; white-space: normal; }
  .res.on { border-color: #e2721f; box-shadow: 0 0 0 2px rgba(226, 114, 31, 0.25); }
  .how { padding: 12px; display: grid; gap: 10px; font-size: 13px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
</style>
