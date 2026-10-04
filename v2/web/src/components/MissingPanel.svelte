<script lang="ts">
  // "Highlight what's left" for one area: its streets a team hasn't swept, drawn bright on
  // the map and listed here longest first. Used by the Map page and the Areas page. Often
  // the last 2% is a few feet of street poking inside the outline; this is how to find it.
  import { onMount } from "svelte";
  import { api, errorText } from "../lib/api";
  import { miles } from "../lib/format";
  import type { MapController } from "../lib/map";

  type Missing = { name: string | null; highway: string; meters: number; pieces: number; at: [number, number]; geometry: GeoJSON.Geometry };

  let { ctl, areaId, areaName, teamId, left = 0, onclose }: {
    ctl: MapController; areaId: string; areaName: string; teamId: string;
    /** Room taken by a panel on the left, so zooming keeps the streets clear of it. */
    left?: number;
    onclose: () => void;
  } = $props();

  let streets = $state<Missing[] | null>(null);
  let truncated = $state(false);
  let error = $state<string | null>(null);
  let total = $derived((streets ?? []).reduce((t, s) => t + s.meters, 0));

  onMount(() => {
    api<{ streets: Missing[]; truncated: boolean }>(`/api/areas/${areaId}/missing?team=${teamId}`)
      .then((r) => {
        streets = r.streets;
        truncated = r.truncated;
        ctl.setMissing(r.streets, { left });
      })
      .catch((e) => (error = errorText(e)));
    return () => ctl.setMissing(null);
  });

  const label = (s: Missing) => s.name ?? `Unnamed ${s.highway.replace(/_/g, " ")}`;
  const feet = (m: number) => (m < 160 ? `${Math.max(1, Math.round(m * 3.28084))} ft` : miles(m));
</script>

<section class="missing" aria-label="What's left in {areaName}">
  <header>
    <span class="key" aria-hidden="true"></span>
    <div class="grow">
      <strong>What's left in {areaName}</strong>
      <span class="muted small">
        {#if error}{error}
        {:else if streets === null}Looking…
        {:else if !streets.length}Nothing: every street is driven, marked done or left out.
        {:else}{streets.length} street{streets.length === 1 ? "" : "s"} · {feet(total)}{truncated ? " (the longest shown)" : ""}{/if}
      </span>
    </div>
    <button class="sm ghost icon" onclick={onclose} aria-label="Stop highlighting" title="Stop highlighting">✕</button>
  </header>
  {#if streets?.length}
    <ul>
      {#each streets as s, i (i)}
        <li>
          <button class="row" onclick={() => ctl.flyTo(s.at)}>
            <span class="name">{label(s)}</span>
            <span class="muted small">{feet(s.meters)} left</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .missing {
    position: absolute; right: 14px; bottom: 14px; z-index: 3; width: 300px; max-height: 45%;
    display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line);
    border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
  }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 12px; border-bottom: 1px solid var(--line); }
  header .grow { display: grid; gap: 1px; min-width: 0; flex: 1; }
  .key { width: 22px; height: 8px; border-radius: 4px; background: #ffd60a; box-shadow: 0 0 0 2px #111827; flex: none; }
  ul { list-style: none; margin: 0; padding: 4px; overflow: auto; }
  .row {
    display: flex; justify-content: space-between; align-items: baseline; gap: 10px; width: 100%;
    height: auto; padding: 7px 8px; border: 0; background: none; border-radius: 8px; font-weight: 400; text-align: left;
  }
  .row:hover { background: var(--surface-2); }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .small { flex: none; }
  @media (max-width: 760px) {
    .missing { left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 40%; }
  }
</style>
