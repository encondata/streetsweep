<script lang="ts">
  import { store, parentsOf } from "../../lib/store.svelte";
  import { ws } from "../../lib/workspace.svelte";
  import { router } from "../../lib/router.svelte";
  import Icon from "../../lib/Icon.svelte";
  import DetailsForm, { type Details } from "./DetailsForm.svelte";
  import type { Area } from "../../lib/types";

  let { area }: { area: Area } = $props();
  let saving = $state(false);

  // svelte-ignore state_referenced_locally
  const start: Details = {
    name: area.name, level: area.level, parents: parentsOf(area),
    city: area.city || "", notes: area.notes || "", color: area.color || "",
  };

  async function save(d: Details) {
    saving = true;
    try {
      await store.save({
        name: d.name, level: d.level, parentName: d.parents[0] || null, alsoIn: d.parents.slice(1),
        city: d.city || null, notes: d.notes || null, color: d.color || null,
        polygon: area.polygon, morePieces: area.morePieces,
      }, area.id);
      ws.say("Saved");
      router.go(`/map/area/${area.id}`);
    } catch (e) {
      ws.say("Not saved: " + (e as Error).message, { tone: "bad" });
    } finally {
      saving = false;
    }
  }
</script>

<div class="head">
  <button class="ghost sm back" onclick={() => router.go(`/map/area/${area.id}`)}><Icon name="back" size={16} /> {area.name}</button>
  <h2>Edit details</h2>
</div>
<div class="body scroll">
  <DetailsForm value={start} selfId={area.id} {saving} onsubmit={save} oncancel={() => router.go(`/map/area/${area.id}`)} />
</div>

<style>
  .head { padding: 10px 16px 14px; border-bottom: 1px solid var(--line); display: grid; gap: 6px; }
  .back { justify-self: start; margin-left: -8px; }
  .body { flex: 1; padding: 16px; }
</style>
