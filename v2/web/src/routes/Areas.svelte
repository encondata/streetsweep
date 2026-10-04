<script lang="ts">
  // Areas: where a team's areas are found, followed, drawn and managed. The map here shows
  // their outlines over plain streets: no coverage, drive tracks or places (that's the
  // Map page's job), so drawing a boundary isn't cluttered by what's been driven.
  import { onMount } from "svelte";
  import AreaPanel from "../components/AreaPanel.svelte";
  import { MapController, type Base } from "../lib/map";
  import Icon from "../components/Icon.svelte";
  import { router } from "../lib/router.svelte";
  import { mySettings } from "../lib/settings";

  const PANEL_W = 380;
  let box: HTMLDivElement;
  let ctl = $state<MapController | null>(null);
  let panel = $state<ReturnType<typeof AreaPanel>>();
  let base = $state<Base>(readBase());

  // The list tucks away to give the map room; remembered per device. Drawing always shows it.
  let shown = $state(readShown());
  function readShown() {
    try { return localStorage.getItem("streetsweep.areasPanel") !== "hidden"; } catch { return true; }
  }
  function setShown(on: boolean) {
    shown = on;
    try { localStorage.setItem("streetsweep.areasPanel", on ? "shown" : "hidden"); } catch { /* fine */ }
  }

  function readBase(): Base {
    try {
      const b = localStorage.getItem("streetsweep.base");
      if (b === "map" || b === "satellite" || b === "hybrid") return b;
    } catch { /* private window */ }
    return mySettings().base ?? "map";
  }
  function setBase(b: Base) {
    base = b;
    ctl?.setBase(b);
    try { localStorage.setItem("streetsweep.base", b); } catch { /* fine */ }
  }

  function readView(): { center: [number, number]; zoom: number } | null {
    try {
      const v = JSON.parse(localStorage.getItem("streetsweep.view") ?? "null");
      if (Array.isArray(v?.center) && typeof v.zoom === "number") return v;
    } catch { /* none saved */ }
    return null;
  }

  onMount(() => {
    const saved = readView();
    ctl = new MapController(box, saved?.center, saved?.zoom);
    ctl.setBase(base);
    ctl.setPlainStreets();
    ctl.showPlaces(false);
    const unwatch = ctl.watchSize(box);
    ctl.onAreaClick = (id) => panel?.open(id);
    // Street clicks belong to the Map page; here they'd only get in the way of drawing.
    ctl.onStreetClick = null;
    return () => {
      unwatch();
      ctl?.destroy();
      ctl = null;
    };
  });

  // Linked from the map ("Manage in Areas"): open that one.
  let opened = "";
  $effect(() => {
    const id = router.query.get("area");
    if (id && panel && ctl && id !== opened) {
      opened = id;
      panel.open(id);
    }
  });

  const BASES: { key: Base; label: string }[] = [
    { key: "map", label: "Map" }, { key: "satellite", label: "Satellite" }, { key: "hybrid", label: "Hybrid" },
  ];
</script>

<div class="wrap">
  <div class="map" bind:this={box}></div>
  {#if ctl}<AreaPanel bind:this={panel} {ctl} panelWidth={PANEL_W} {shown} onshow={() => setShown(true)} onhide={() => setShown(false)} />{/if}
  <div class="top">
    {#if !shown}
      <button class="tool" onclick={() => setShown(true)} title="Show the areas list"><Icon name="areas" size={16} /> Areas</button>
    {/if}
    <div class="seg" role="group" aria-label="Basemap">
      {#each BASES as b (b.key)}
        <button class:on={base === b.key} aria-pressed={base === b.key} onclick={() => setBase(b.key)}>{b.label}</button>
      {/each}
    </div>
  </div>
</div>

<style>
  .wrap { position: relative; height: 100vh; height: 100dvh; }
  .map { position: absolute; inset: 0; }
  .top { position: absolute; top: 14px; right: 14px; display: flex; gap: 8px; }
  .tool { height: 38px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); gap: 6px; font-size: 13px; }
  .seg { display: flex; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 3px; box-shadow: var(--shadow); }
  .seg button { height: 30px; border: 0; background: none; padding: 0 12px; font-size: 13px; border-radius: 7px; color: var(--ink-soft); }
  .seg button.on { background: var(--accent-soft); color: var(--green-700); }
  @media (max-width: 760px) {
    .wrap { height: calc(100dvh - 64px - env(safe-area-inset-bottom)); }
  }
</style>
