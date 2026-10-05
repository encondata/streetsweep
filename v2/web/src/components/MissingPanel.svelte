<script lang="ts">
  // "Highlight what's left" for one area: its streets a team hasn't swept, drawn bright on
  // the map and listed here longest first. Used by the Map page and the Areas page. Often
  // the last 2% is a few feet of street poking inside the outline; this is how to find it.
  import { onMount } from "svelte";
  import { api, errorText } from "../lib/api";
  import { miles } from "../lib/format";
  import type { MapController } from "../lib/map";

  type Missing = { name: string | null; highway: string; meters: number; pieces: number; at: [number, number]; geometry: GeoJSON.Geometry; segment_ids: number[] };

  let { ctl, areaId, areaName, teamId, left = 0, onclose, onmarked }: {
    ctl: MapController; areaId: string; areaName: string; teamId: string;
    /** Room taken by a panel on the left, so zooming keeps the streets clear of it. */
    left?: number;
    onclose: () => void;
    /** Streets were marked from the list: coverage and progress have changed. */
    onmarked?: () => void;
  } = $props();

  // ---- choosing streets: click one, Shift-click a range, Ctrl/⌘-click to add or take one away ----
  let chosen = $state<Set<number>>(new Set());
  let anchor = -1;
  function choose(e: MouseEvent, i: number) {
    const list = streets ?? [];
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      const next = e.metaKey || e.ctrlKey ? new Set(chosen) : new Set<number>();
      for (let k = a; k <= b; k++) next.add(k);
      chosen = next;
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(chosen);
      if (!next.delete(i)) next.add(i);
      chosen = next;
      anchor = i;
    } else {
      chosen = new Set([i]);
      anchor = i;
      ctl.flyTo(list[i].at);
    }
    // Shift-click would also select the page's text: not wanted here.
    getSelection()?.removeAllRanges();
  }
  let picked = $derived([...chosen].sort((a, b) => a - b).map((i) => streets?.[i]).filter((s): s is Missing => !!s));
  // The chosen streets pulse on the map, as when picking streets there.
  $effect(() => {
    const ids = picked.length > 1 ? picked.flatMap((s) => s.segment_ids) : [];
    ctl.setSelectedStreets(ids);
  });
  onMount(() => () => ctl.setSelectedStreets([]));

  // ---- right-click: mark the chosen streets done, or gated (left out, noted "Gated") ----
  let menu = $state<{ x: number; y: number; streets: Missing[] } | null>(null);
  let marking = $state(false);
  let done = $state<string | null>(null);
  function openMenu(e: MouseEvent, i: number) {
    e.preventDefault();
    // On a Mac, Ctrl-click arrives as a right-click (with the main button): it means "add this one".
    if (e.ctrlKey && e.button === 0) { choose(e, i); return; }
    // Right-clicking one of the chosen streets acts on them all; any other, on just that one.
    if (!chosen.has(i)) { chosen = new Set([i]); anchor = i; }
    menu = { x: e.clientX, y: e.clientY, streets: picked };
  }
  async function mark(kind: "complete" | "excluded") {
    const m = menu;
    menu = null;
    if (!m) return;
    marking = true;
    error = null;
    try {
      const r = await api<{ pieces: number; meters: number }>(`/api/teams/${teamId}/marks/bulk`, {
        body: { segment_ids: m.streets.flatMap((s) => s.segment_ids), kind, note: kind === "excluded" ? "Gated" : null },
      });
      const what = m.streets.length === 1 ? label(m.streets[0]) : `${m.streets.length} streets`;
      done = `${kind === "complete" ? "Marked done" : "Marked gated"}: ${what}${r.pieces ? "" : " (already marked)"}.`;
      chosen = new Set();
      anchor = -1;
      onmarked?.();
      await load(false);
    } catch (e) {
      error = errorText(e);
    } finally {
      marking = false;
    }
  }

  let streets = $state<Missing[] | null>(null);
  let truncated = $state(false);
  let error = $state<string | null>(null);
  let total = $derived((streets ?? []).reduce((t, s) => t + s.meters, 0));

  async function load(fit: boolean) {
    try {
      const r = await api<{ streets: Missing[]; truncated: boolean }>(`/api/areas/${areaId}/missing?team=${teamId}`);
      // Asked again after a street was marked, and nothing's left: the highlight has done its job.
      if (!fit && !r.streets.length) return onclose();
      streets = r.streets;
      // The list changed (a street marked here or on the map): start choosing afresh.
      chosen = new Set();
      anchor = -1;
      truncated = r.truncated;
      ctl.setMissing(r.streets, { left, fit });
    } catch (e) {
      error = errorText(e);
    }
  }

  /** A street was marked done or left out: drop it from the highlight, staying where you are. */
  export function refresh() {
    load(false);
  }

  onMount(() => {
    load(true);
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
      {#if streets?.length}<span class="muted small hint">{picked.length > 1 ? `${picked.length} streets chosen · right-click to mark them`
        : done ?? "Right-click a street to mark it done or gated. Shift-click for a range, Ctrl-click (⌘ on a Mac) to pick several."}</span>{/if}
    </div>
    <button class="sm ghost icon" onclick={onclose} aria-label="Stop highlighting" title="Stop highlighting">✕</button>
  </header>
  {#if streets?.length}
    <ul>
      {#each streets as s, i (i)}
        <li>
          <button class="row" class:chosen={chosen.has(i)} disabled={marking} onclick={(e) => choose(e, i)}
            oncontextmenu={(e) => openMenu(e, i)} aria-pressed={chosen.has(i)}>
            <span class="name">{label(s)}</span>
            <span class="muted small">{feet(s.meters)} left</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if menu}
  <!-- A small menu where the street was right-clicked; any other click or Escape closes it. -->
  <div class="ctx-backdrop" role="presentation" onclick={() => (menu = null)} oncontextmenu={(e) => { e.preventDefault(); menu = null; }}></div>
  <div class="ctx" role="menu" aria-label="Mark the chosen streets" style:left="{Math.min(menu.x, innerWidth - 230)}px" style:top="{Math.min(menu.y, innerHeight - 120)}px">
    <p class="ctx-head">{menu.streets.length === 1 ? label(menu.streets[0]) : `${menu.streets.length} streets · ${feet(menu.streets.reduce((t, s) => t + s.meters, 0))}`}</p>
    <button role="menuitem" onclick={() => mark("complete")}>✓ Mark complete</button>
    <button role="menuitem" onclick={() => mark("excluded")}>⛔ Mark gated</button>
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === "Escape") menu = null; }} />

<style>
  .hint { display: block; margin-top: 2px; }
  .row.chosen, .row.chosen:hover:not([disabled]) { background: #fff1e6; box-shadow: inset 3px 0 0 #ff7a00; }
  .row { user-select: none; -webkit-user-select: none; }
  .ctx-backdrop { position: fixed; inset: 0; z-index: 40; }
  .ctx {
    position: fixed; z-index: 41; width: 220px; display: grid; padding: 6px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 28px rgba(13, 27, 40, .2);
  }
  .ctx-head { margin: 2px 8px 6px; font-size: 12px; font-weight: 700; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx button {
    justify-content: flex-start; height: 36px; border: 0; background: none; border-radius: 8px; padding: 0 10px; font-size: 14px; width: 100%;
  }
  .ctx button:hover:not([disabled]) { background: var(--surface-2); }
  .missing {
    position: absolute; right: 14px; bottom: 88px; z-index: 3; width: 300px; max-height: calc(100% - 180px);
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
    .missing { left: 8px; right: 8px; bottom: 84px; width: auto; max-height: 40%; }
  }
</style>
