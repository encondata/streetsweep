<script lang="ts">
  import { onMount } from "svelte";
  import { MapController, STREETS_MIN_ZOOM, type Base } from "../lib/map";
  import { api } from "../lib/api";
  import { date } from "../lib/format";

  type Info = {
    region: string;
    last_import: { id: number; region: string; osm_timestamp: string | null; finished_at: string } | null;
    running: { id: number; step: string; started_at: string } | null;
    bbox: [number, number, number, number] | null;
  };

  let box: HTMLDivElement;
  let ctl: MapController | null = null;
  let info = $state<Info | null>(null);
  let zoom = $state(11);
  let base = $state<Base>(readBase());

  function readBase(): Base {
    try {
      const b = localStorage.getItem("streetsweep.base");
      if (b === "map" || b === "satellite" || b === "hybrid") return b;
    } catch { /* private window */ }
    return "map";
  }

  function setBase(b: Base) {
    base = b;
    ctl?.setBase(b);
    try { localStorage.setItem("streetsweep.base", b); } catch { /* fine */ }
  }

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const KIND: Record<string, string> = {
    primary: "Main road", secondary: "Secondary road", tertiary: "Minor through road", unclassified: "Minor road",
    residential: "Residential street", living_street: "Living street",
  };

  // Where the map was left, so it reopens there.
  function readView(): { center: [number, number]; zoom: number } | null {
    try {
      const v = JSON.parse(localStorage.getItem("streetsweep.view") ?? "null");
      if (Array.isArray(v?.center) && typeof v.zoom === "number") return v;
    } catch { /* none saved */ }
    return null;
  }

  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const saved = readView();
    ctl = new MapController(box, saved?.center, saved?.zoom);
    ctl.map.on("moveend", () => {
      const c = ctl!.map.getCenter();
      try { localStorage.setItem("streetsweep.view", JSON.stringify({ center: [c.lng, c.lat], zoom: ctl!.map.getZoom() })); } catch { /* fine */ }
    });
    ctl.setBase(base);
    // For poking at from the browser console while debugging.
    (window as unknown as { streetsweep?: object }).streetsweep = { map: ctl.map, ctl };
    const unwatch = ctl.watchSize(box);
    ctl.map.on("zoomend", () => (zoom = ctl!.map.getZoom()));
    zoom = ctl.map.getZoom();
    ctl.onStreetClick = (s, at) => {
      const kind = KIND[s.highway.replace(/_link$/, "")] ?? s.highway;
      const feet = Math.round(s.length_m * 3.28084);
      ctl!.showPopup(at, `<strong>${esc(s.name ?? "Unnamed street")}</strong><br><span class="muted">${esc(kind)}${s.highway.endsWith("_link") ? " (ramp)" : ""} · ${feet.toLocaleString()} ft</span>`);
    };

    // First visit: open on the imported region. Keep checking while an import runs.
    let placed = !!saved;
    async function poll() {
      try {
        info = await api<Info>("/api/map/info");
        if (!placed && info.bbox) {
          placed = true;
          ctl!.fitBounds(info.bbox);
        }
      } catch { /* the banner just doesn't show */ }
      if (!stopped && info?.running) timer = setTimeout(poll, 8000);
    }
    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
      unwatch();
      ctl?.destroy();
      ctl = null;
    };
  });

  const BASES: { key: Base; label: string }[] = [
    { key: "map", label: "Map" }, { key: "satellite", label: "Satellite" }, { key: "hybrid", label: "Hybrid" },
  ];
</script>

<div class="mapwrap">
  <div class="map" bind:this={box}></div>

  <div class="top">
    <div class="seg" role="group" aria-label="Basemap">
      {#each BASES as b (b.key)}
        <button class:on={base === b.key} aria-pressed={base === b.key} onclick={() => setBase(b.key)}>{b.label}</button>
      {/each}
    </div>
  </div>

  <div class="bottom">
    {#if info?.running}
      <div class="chip busy">
        <span class="dot"></span>
        <span><strong>Importing {info.region} streets</strong> · {info.running.step}</span>
      </div>
    {:else if info && !info.last_import}
      <div class="chip">No streets imported yet. A site admin can start an import from Admin → Map data.</div>
    {:else if zoom < STREETS_MIN_ZOOM}
      <div class="chip">Zoom in to see streets</div>
    {:else if info?.last_import}
      <div class="chip quiet">{info.region[0].toUpperCase() + info.region.slice(1)} streets · OpenStreetMap data from {date(info.last_import.osm_timestamp ?? info.last_import.finished_at)}</div>
    {/if}
  </div>
</div>

<style>
  .mapwrap { position: relative; height: 100vh; height: 100dvh; }
  .map { position: absolute; inset: 0; }
  .top { position: absolute; top: 14px; right: 14px; display: flex; gap: 8px; }
  .seg { display: flex; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 3px; box-shadow: var(--shadow); }
  .seg button { height: 30px; border: 0; background: none; padding: 0 12px; font-size: 13px; border-radius: 7px; color: var(--ink-soft); }
  .seg button.on { background: var(--accent-soft); color: var(--green-700); }
  .bottom { position: absolute; left: 50%; transform: translateX(-50%); bottom: 36px; display: flex; justify-content: center; pointer-events: none; max-width: calc(100% - 32px); }
  .chip {
    pointer-events: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 99px; padding: 8px 14px;
    font-size: 13px; box-shadow: var(--shadow); display: flex; align-items: center; gap: 8px; text-align: center;
  }
  .chip.quiet { color: var(--ink-soft); font-size: 12px; padding: 6px 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green-600); animation: pulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes pulse { 50% { opacity: .3; } }
  :global(.maplibregl-popup-content) { font: 13.5px/1.45 var(--ui); padding: 10px 28px 10px 12px; border-radius: 10px; }
  :global(.maplibregl-popup-content .muted) { color: var(--ink-soft); }
  @media (max-width: 760px) {
    .mapwrap { height: calc(100dvh - 64px - env(safe-area-inset-bottom)); }
    .bottom { bottom: 28px; }
  }
</style>
