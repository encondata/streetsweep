<script lang="ts">
  import { mount, onMount, unmount } from "svelte";
  import AreaPanel from "../components/AreaPanel.svelte";
  import StreetPopup from "../components/StreetPopup.svelte";
  import Modal from "../components/Modal.svelte";
  import Icon from "../components/Icon.svelte";
  import { errorText } from "../lib/api";
  import { syncFrom } from "../lib/forms";
  import type { Place } from "../lib/types";
  import { MapController, STREETS_MIN_ZOOM, EXCLUDED_COLOR, type Base } from "../lib/map";
  import { myColors } from "../lib/colors";
  import { session } from "../lib/session.svelte";
  import { api } from "../lib/api";
  import { date } from "../lib/format";

  type Info = {
    region: string;
    last_import: { id: number; region: string; osm_timestamp: string | null; finished_at: string } | null;
    running: { id: number; step: string; started_at: string } | null;
    bbox: [number, number, number, number] | null;
  };

  let box: HTMLDivElement;
  let ctl = $state<MapController | null>(null);
  let panel = $state<ReturnType<typeof AreaPanel>>();
  const PANEL_W = 360;
  let info = $state<Info | null>(null);
  let zoom = $state(11);
  let base = $state<Base>(readBase());
  // The team chosen in the area panel: streets are coloured by its coverage.
  let coverageTeam = $state<string | null>(null);
  function chooseTeam(id: string) {
    coverageTeam = id;
    ctl?.setCoverageTeam(id);
  }

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

  // ---- places ----
  let places = $state<Place[]>([]);
  let picking = $state(false);
  let adding = $state<[number, number] | null>(null);
  let addOpen = $state(false);
  let placeForm = $state({ name: "", note: "", teams: [] as string[] });
  let placeError = $state<string | null>(null);
  let savingPlace = $state(false);

  async function loadPlaces() {
    try {
      places = (await api<{ places: Place[] }>("/api/places")).places;
      ctl?.setPlaces(places);
    } catch { /* pins just don't show */ }
  }

  function startPick() {
    if (picking) {
      picking = false;
      ctl?.pick(null);
      return;
    }
    picking = true;
    ctl?.pick((at) => {
      picking = false;
      placeForm = { name: "", note: "", teams: [] };
      placeError = null;
      adding = at;
      addOpen = true;
    });
  }

  async function savePlace(el: HTMLFormElement) {
    syncFrom(placeForm, el);
    savingPlace = true;
    placeError = null;
    try {
      const r = await api<{ place: Place }>("/api/places", {
        body: { name: placeForm.name.trim(), note: placeForm.note.trim() || null, lon: adding![0], lat: adding![1], team_ids: placeForm.teams },
      });
      addOpen = false;
      await loadPlaces();
      showPlace(r.place.id, [r.place.lon, r.place.lat]);
    } catch (e) {
      placeError = errorText(e);
    } finally {
      savingPlace = false;
    }
  }

  function showPlace(id: string, at: [number, number]) {
    const p = places.find((x) => x.id === id);
    if (!p) return;
    const photo = p.photos[0] ? `<img class="pthumb" src="/api/places/${p.id}/photos/${p.photos[0].id}" alt="">` : "";
    const who = p.mine ? (p.shared_with.length ? `Shared with ${p.shared_with.map((t) => esc(t.kind === "personal" ? "you" : t.name)).join(", ")}` : "Only you") : `${esc(p.user_name)}'s`;
    ctl!.showPopup(at, `${photo}<strong>${esc(p.name)}</strong><br><span class="muted">${who}</span>${p.note ? `<br>${esc(p.note.slice(0, 140))}` : ""}<br><a href="/places/${p.id}">Open</a>`);
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  const teamLabel = (id: string | null) => {
    const t = session.me!.teams.find((x) => x.id === id);
    return !t ? "" : t.kind === "personal" ? "you" : t.name;
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
    ctl.onAreaClick = (id) => panel?.open(id);
    ctl.onPlaceClick = showPlace;
    loadPlaces();
    // The popup is a live component: it loads the street's coverage and can mark it.
    ctl.onStreetClick = (hit, at) => {
      const el = document.createElement("div");
      const team = ctl!.coverageTeam;
      const comp = mount(StreetPopup, {
        target: el,
        props: { hit, teamId: team, teamLabel: teamLabel(team), onchange: () => { ctl?.refreshCoverage(); panel?.refresh(); } },
      });
      ctl!.showPopupEl(at, el, () => unmount(comp));
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

  {#if ctl}<AreaPanel bind:this={panel} {ctl} panelWidth={PANEL_W} onteam={chooseTeam} />{/if}

  <div class="top">
    <button class="tool" class:on={picking} aria-pressed={picking} onclick={startPick} title="Mark a place on the map">
      <Icon name="pin" size={16} /> {picking ? "Click the spot… (cancel)" : "Add place"}
    </button>
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
    {:else if info?.last_import && coverageTeam}
      <div class="chip quiet legend">
        <span><i style:background={myColors().driven.color}></i>Driven</span>
        <span><i style:background={myColors().undriven.color}></i>Not yet</span>
        <span><i style:background={EXCLUDED_COLOR}></i>Left out</span>
      </div>
    {:else if info?.last_import}
      <div class="chip quiet">{info.region[0].toUpperCase() + info.region.slice(1)} streets · OpenStreetMap data from {date(info.last_import.osm_timestamp ?? info.last_import.finished_at)}</div>
    {/if}
  </div>
</div>

<Modal bind:open={addOpen} title="New place" width={460}>
  <form id="new-place" class="stack" onsubmit={(e) => { e.preventDefault(); savePlace(e.currentTarget); }}>
    {#if placeError}<p class="notice error">{placeError}</p>{/if}
    <label class="field">Name <input type="text" name="name" bind:value={placeForm.name} maxlength="120" required placeholder="e.g. Pothole on Avenue F" /></label>
    <label class="field">Note <textarea name="note" bind:value={placeForm.note} maxlength="2000"></textarea></label>
    <div class="field">Who sees it
      <span class="help">Only you, unless you share it with a team. You can change this later and add photos on its page.</span>
      {#each session.me!.teams.filter((t) => t.kind === "shared") as t (t.id)}
        <label class="check"><input type="checkbox" value={t.id} bind:group={placeForm.teams} /> {t.name}</label>
      {:else}
        <span class="small muted">You're not in any shared teams, so it's just yours.</span>
      {/each}
    </div>
  </form>
  {#snippet footer()}
    <button class="ghost" onclick={() => (addOpen = false)}>Cancel</button>
    <button class="primary" type="submit" form="new-place" disabled={savingPlace}>Save place</button>
  {/snippet}
</Modal>

<style>
  .tool { height: 38px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); gap: 6px; font-size: 13px; }
  .tool.on { background: #fce4ec; border-color: #f48fb1; color: #880e4f; }
  .check { display: flex; align-items: center; gap: 8px; font-weight: 400; }
  .check input { width: auto; height: auto; }
  :global(.pthumb) { display: block; width: 100%; max-height: 140px; object-fit: cover; border-radius: 8px; margin-bottom: 6px; }
  .mapwrap { position: relative; height: 100vh; height: 100dvh; }
  .map { position: absolute; inset: 0; }
  .top { position: absolute; top: 14px; right: 14px; display: flex; gap: 8px; }
  .seg { display: flex; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 3px; box-shadow: var(--shadow); }
  .seg button { height: 30px; border: 0; background: none; padding: 0 12px; font-size: 13px; border-radius: 7px; color: var(--ink-soft); }
  .seg button.on { background: var(--accent-soft); color: var(--green-700); }
  .bottom { position: absolute; left: calc(50% + 187px); transform: translateX(-50%); bottom: 36px; display: flex; justify-content: center; pointer-events: none; max-width: calc(100% - 32px); }
  .chip {
    pointer-events: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 99px; padding: 8px 14px;
    font-size: 13px; box-shadow: var(--shadow); display: flex; align-items: center; gap: 8px; text-align: center;
  }
  .chip.quiet { color: var(--ink-soft); font-size: 12px; padding: 6px 12px; }
  .legend { gap: 12px; }
  .legend span { display: flex; align-items: center; gap: 5px; }
  .legend i { width: 14px; height: 4px; border-radius: 2px; display: block; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green-600); animation: pulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes pulse { 50% { opacity: .3; } }
  :global(.maplibregl-popup-content) { font: 13.5px/1.45 var(--ui); padding: 10px 28px 10px 12px; border-radius: 10px; }
  :global(.maplibregl-popup-content .muted) { color: var(--ink-soft); }
  @media (max-width: 760px) {
    .mapwrap { height: calc(100dvh - 64px - env(safe-area-inset-bottom)); }
    .bottom { bottom: auto; top: 60px; left: 50%; }
  }
</style>
