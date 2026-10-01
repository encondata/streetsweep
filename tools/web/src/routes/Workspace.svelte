<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { MapController, type Base } from "../lib/map";
  import { router } from "../lib/router.svelte";
  import { store } from "../lib/store.svelte";
  import { ws } from "../lib/workspace.svelte";
  import AreasPanel from "./panels/AreasPanel.svelte";
  import AreaPanel from "./panels/AreaPanel.svelte";
  import AreaForm from "./panels/AreaForm.svelte";
  import OutlineEditor from "./panels/OutlineEditor.svelte";
  import NewArea from "./panels/NewArea.svelte";
  import Icon from "../lib/Icon.svelte";

  let container: HTMLDivElement;
  let base = $state<Base>((localStorage.getItem("streetsweep.base") as Base) || "map");
  let collapsed = $state(false);

  onMount(() => {
    const m = new MapController(container);
    (window as unknown as { streetsweep: Record<string, unknown> }).streetsweep.ctl = m;
    m.ready.then(() => {
      m.setBase(base);
      ws.map = m;
    });
    addEventListener("themechange", restyle);
  });
  onDestroy(() => {
    removeEventListener("themechange", restyle);
    ws.map?.remove();
    ws.map = null;
  });
  function restyle() { ws.map?.restyle(); }

  function setBase(b: Base) {
    base = b;
    ws.map?.setBase(b);
    try { localStorage.setItem("streetsweep.base", b); } catch {}
  }

  // /map, /map/new, /map/area/12, /map/area/12/edit, /map/area/12/outline
  const parts = $derived(router.parts);
  const areaId = $derived(parts[1] === "area" ? Number(parts[2]) : null);
  const area = $derived(areaId ? store.byId(areaId) : null);
  const view = $derived(
    parts[1] === "new" ? "new"
    : areaId && parts[3] === "edit" ? "edit"
    : areaId && parts[3] === "outline" ? "outline"
    : areaId ? "area"
    : "list",
  );
</script>

<div class="ws" class:collapsed>
  <aside class="panel">
    {#if !ws.map}
      <div class="pad muted">Loading the map…</div>
    {:else if view === "new"}
      <NewArea />
    {:else if (view === "area" || view === "edit" || view === "outline") && !area}
      <div class="pad">
        <p class="muted">That area is not here any more.</p>
        <button onclick={() => router.go("/map")}>All areas</button>
      </div>
    {:else if view === "edit" && area}
      {#key area.id}<AreaForm {area} />{/key}
    {:else if view === "outline" && area}
      {#key area.id}<OutlineEditor {area} />{/key}
    {:else if view === "area" && area}
      {#key area.id}<AreaPanel {area} />{/key}
    {:else}
      <AreasPanel />
    {/if}
  </aside>

  <section class="mapwrap">
    <div class="map" bind:this={container}></div>
    <button class="collapse card" onclick={() => (collapsed = !collapsed)}
      title={collapsed ? "Show the panel" : "Hide the panel"}>
      <span style:transform={collapsed ? "rotate(180deg)" : ""}><Icon name="back" size={16} /></span>
    </button>
    <div class="bases card" role="group" aria-label="Base map">
      {#each [["map", "Map"], ["satellite", "Satellite"], ["hybrid", "Hybrid"]] as [b, label]}
        <button class="sm" class:on={base === b} aria-pressed={base === b} onclick={() => setBase(b as Base)}>{label}</button>
      {/each}
    </div>
    <div class="toasts">
      {#each ws.toasts as t (t.id)}
        <div class="toast card" class:bad={t.tone === "bad"}>
          <span>{t.text}</span>
          {#if t.undo}
            <button class="sm ghost" onclick={async () => { ws.dismiss(t.id); await t.undo?.(); }}>Undo</button>
          {/if}
          <button class="sm ghost icon" onclick={() => ws.dismiss(t.id)} aria-label="Dismiss"><Icon name="close" size={14} /></button>
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  .ws { display: grid; grid-template-columns: var(--panel) 1fr; height: 100%; transition: grid-template-columns 0.18s; }
  .ws.collapsed { grid-template-columns: 0 1fr; }
  .panel {
    background: var(--surface); border-right: 1px solid var(--line); min-width: 0; overflow: hidden;
    display: flex; flex-direction: column; z-index: 2;
  }
  .pad { padding: 18px; display: grid; gap: 10px; }
  .mapwrap { position: relative; min-width: 0; }
  .map { position: absolute; inset: 0; }
  .collapse {
    position: absolute; left: 10px; top: 10px; width: 30px; height: 30px; min-height: 0; padding: 0; z-index: 3;
  }
  .bases {
    position: absolute; right: 10px; top: 10px; display: flex; padding: 3px; gap: 2px; z-index: 3; border-radius: 10px;
  }
  .bases button { border-color: transparent; background: transparent; }
  .bases button.on { background: var(--ink); color: var(--surface); }
  .toasts {
    position: absolute; left: 50%; bottom: 78px; transform: translateX(-50%);
    display: grid; gap: 8px; z-index: 6; pointer-events: none;
  }
  .toast {
    display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 14px; pointer-events: auto;
    background: var(--navy-900); color: #fff; border-color: transparent; box-shadow: var(--shadow-2);
  }
  .toast.bad { background: var(--danger); }
  .toast button { color: #a6f3a2; }
  .toast button.icon { color: #fff; width: 26px; }
  .toast button:hover { background: rgba(255, 255, 255, 0.12); }
</style>
