<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { store, parentsOf, isOrg } from "../../lib/store.svelte";
  import { ws } from "../../lib/workspace.svelte";
  import { router } from "../../lib/router.svelte";
  import { OutlineDraw, EDIT_LIMIT } from "../../lib/draw.svelte";
  import { squareMiles, areaSize, cellsOf } from "../../lib/geo";
  import Icon from "../../lib/Icon.svelte";
  import type { Area, Ring } from "../../lib/types";

  let { area }: { area: Area } = $props();
  let editor = $state<OutlineDraw | null>(null);
  let rings = $state<Ring[]>([]);
  let dirty = $state(false);
  let saving = $state(false);

  onMount(() => {
    const m = ws.map!;
    // Everything else faint, and out of the way of clicks: the drawing has them now.
    const styles: Record<number, { id: number; fraction: number | null; focus: boolean; dim: boolean }> = {};
    for (const a of store.areas) styles[a.id] = { id: a.id, fraction: null, focus: false, dim: true };
    m.setAreas(store.areas.filter((a) => a.id !== area.id), styles);
    m.setStreets([]);
    m.busy = true;
    const neighbours = store.areas.filter((a) => a.id !== area.id).flatMap((a) => [a.polygon, ...a.morePieces]);
    editor = new OutlineDraw(m.map, neighbours, () => { dirty = true; rings = editor!.rings(); });
    editor.load([area.polygon, ...area.morePieces]);
    rings = editor.rings();
    // Putting the outline on the map is not an edit.
    dirty = false;
    m.fit(rings);
  });
  onDestroy(() => {
    editor?.stop();
    if (ws.map) ws.map.busy = false;
  });

  const corners = $derived(rings.reduce((n, r) => n + r.length, 0));
  const large = $derived(rings.filter((r) => r.length > EDIT_LIMIT).length);

  async function save() {
    if (!rings.length) return ws.say("An area needs at least one piece.", { tone: "bad" });
    saving = true;
    try {
      const parents = parentsOf(area);
      await store.save({
        name: area.name, level: area.level, parentName: parents[0] || null, alsoIn: parents.slice(1),
        city: area.city, notes: area.notes, color: area.color,
        polygon: rings[0], morePieces: rings.slice(1),
      }, area.id);
      ws.say(isOrg(area) ? "Outline saved" : "Outline saved; the area is being recounted.");
      router.go(`/map/area/${area.id}`);
    } catch (e) {
      ws.say("Not saved: " + (e as Error).message, { tone: "bad" });
    } finally {
      saving = false;
    }
  }
  function cancel() {
    if (dirty && !confirm("Leave without saving the outline?")) return;
    router.go(`/map/area/${area.id}`);
  }
</script>

<div class="head">
  <button class="ghost sm back" onclick={cancel}><Icon name="back" size={16} /> {area.name}</button>
  <h2>Edit outline</h2>
</div>

<div class="body scroll">
  <div class="card facts">
    <div><b class="num">{rings.length}</b><span class="muted">{rings.length === 1 ? "piece" : "pieces"}</span></div>
    <div><b class="num">{corners.toLocaleString()}</b><span class="muted">corners</span></div>
    <div><b class="num">{areaSize(squareMiles(rings))}</b><span class="muted">area</span></div>
    <div><b class="num">{cellsOf(rings).length}</b><span class="muted">map cells</span></div>
  </div>

  {#if editor?.drawing}
    <div class="card how">
      <p><b>Drawing a new piece.</b> Click the map for each corner, then click the first corner (or double-click) to close it. Near another area’s edge, a corner lands exactly on it.</p>
      <button onclick={() => editor?.cancelDrawing()}>Stop drawing</button>
    </div>
  {:else}
    <div class="how muted">
      <p>Drag a corner to move it; drag the dot between two corners to add one. Click a piece to select it.</p>
      {#if large}
        <p>{large === 1 ? "One piece is" : `${large} pieces are`} too detailed (over {EDIT_LIMIT.toLocaleString()} corners) to edit corner by corner; it can still be deleted.</p>
      {/if}
    </div>
  {/if}

  <div class="row">
    <button onclick={() => editor?.addPiece()} disabled={editor?.drawing}><Icon name="plus" size={15} /> Add a piece</button>
    <button class="danger" onclick={() => editor?.deleteSelected()} disabled={!editor?.selected || rings.length < 2}>
      <Icon name="trash" size={15} /> Delete selected piece
    </button>
  </div>
</div>

<div class="foot">
  <button onclick={cancel}>Cancel</button>
  <button class="primary" onclick={save} disabled={!dirty || saving || !rings.length}>{saving ? "Saving…" : "Save outline"}</button>
</div>

<style>
  .head { padding: 10px 16px 14px; border-bottom: 1px solid var(--line); display: grid; gap: 6px; }
  .back { justify-self: start; margin-left: -8px; }
  .body { flex: 1; padding: 16px; display: grid; gap: 14px; align-content: start; }
  .facts { display: grid; grid-template-columns: repeat(4, auto); justify-content: space-between; padding: 12px 14px; gap: 6px; }
  .facts div { display: grid; }
  .facts b { font-size: 15px; white-space: nowrap; }
  .facts span { font-size: 11.5px; }
  .how { display: grid; gap: 8px; font-size: 13px; }
  .card.how { padding: 12px; border-color: #e2721f; justify-items: start; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
</style>
