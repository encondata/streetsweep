<script lang="ts">
  import { mount, onMount, unmount, untrack } from "svelte";
  import StreetPopup from "../components/StreetPopup.svelte";
  import MissingPanel from "../components/MissingPanel.svelte";
  import Modal from "../components/Modal.svelte";
  import Icon from "../components/Icon.svelte";
  import { errorText } from "../lib/api";
  import { syncFrom } from "../lib/forms";
  import { LEVEL_LABEL, type AreaLevel, type Place } from "../lib/types";
  import { MapController, STREETS_MIN_ZOOM, EXCLUDED_COLOR, type Base, type StreetHit } from "../lib/map";
  import { myColors } from "../lib/colors";
  import { defaultTeam, mySettings } from "../lib/settings";
  import { areaFeatures, isComplete, loadTeamAreas } from "../lib/teamAreas";
  import type { Area } from "../lib/types";
  import { miles, percent } from "../lib/format";
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

  // Which kinds of area the map draws (the View menu). The hidden ones are remembered, so a
  // level added later starts out shown.
  const LEVELS: AreaLevel[] = ["state", "county", "city", "neighborhood", "section", "custom"];
  let levels = $state<AreaLevel[]>(readLevels());
  let viewOpen = $state(false);
  let viewMenu = $state<HTMLDivElement>();
  function readLevels(): AreaLevel[] {
    try {
      const hidden = JSON.parse(localStorage.getItem("streetsweep.hiddenAreaLevels") ?? "[]");
      if (Array.isArray(hidden)) return LEVELS.filter((l) => !hidden.includes(l));
    } catch { /* none saved */ }
    return [...LEVELS];
  }
  function toggleLevel(l: AreaLevel) {
    levels = levels.includes(l) ? levels.filter((x) => x !== l) : LEVELS.filter((x) => x === l || levels.includes(x));
    ctl?.setAreaLevels(levels);
    try { localStorage.setItem("streetsweep.hiddenAreaLevels", JSON.stringify(LEVELS.filter((x) => !levels.includes(x)))); } catch { /* fine */ }
  }
  function closeView(e: MouseEvent) {
    if (viewOpen && viewMenu && !viewMenu.contains(e.target as Node)) viewOpen = false;
  }

  let info = $state<Info | null>(null);
  let zoom = $state(11);
  let base = $state<Base>(readBase());
  // Whose coverage the streets show, and whose areas are drawn: one of your teams.
  let teams = $derived(session.me!.teams);
  let coverageTeam = $state(defaultTeam("streetsweep.areasTeam"));
  let teamAreas = $state<Area[]>([]);
  async function loadAreas() {
    try {
      teamAreas = (await loadTeamAreas(coverageTeam)).areas;
      ctl?.setTeamAreas(areaFeatures(teamAreas));
    } catch { /* the outlines just don't show */ }
  }
  // Zoomed out, dots where the team has driven (too far out for the streets themselves).
  async function loadCells() {
    const t = coverageTeam;
    try {
      const { cells } = await api<{ cells: [number, number, number, number][] }>(`/api/teams/${t}/coverage-cells`);
      if (t === coverageTeam) ctl?.setCoverageCells(cells);
    } catch { /* no dots, that's all */ }
  }
  $effect(() => {
    const t = coverageTeam;
    if (!ctl) return;
    try { localStorage.setItem("streetsweep.areasTeam", t); } catch { /* fine */ }
    ctl.setCoverageTeam(t);
    loadAreas();
    loadCells();
  });

  // The search box tucks away, like the areas panel did; remembered per device.
  let toolsShown = $state(readToolsShown());
  function readToolsShown() {
    try { return localStorage.getItem("streetsweep.mapTools") !== "hidden"; } catch { return true; }
  }
  function showTools(on: boolean) {
    toolsShown = on;
    try { localStorage.setItem("streetsweep.mapTools", on ? "shown" : "hidden"); } catch { /* fine */ }
  }

  // ---- search: counties, cities, your areas, addresses ----
  let q = $state("");
  let found = $state<Area[]>([]);
  type Address = { label: string; lon: number; lat: number; bbox: [number, number, number, number] | null };
  let addresses = $state<Address[] | null>(null);
  let lookingUp = $state(false);
  let searchError = $state<string | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const term = q.trim();
    clearTimeout(searchTimer);
    addresses = null;
    searchError = null;
    if (term.length < 2) { found = []; return; }
    searchTimer = setTimeout(async () => {
      const mine = teamAreas.filter((a) => a.name.toLowerCase().includes(term.toLowerCase()));
      const pub = await api<{ areas: Area[] }>(`/api/areas/search?q=${encodeURIComponent(term)}`).then((r) => r.areas, () => []);
      found = [...mine, ...pub.filter((p) => !mine.some((m) => m.id === p.id))].slice(0, 8);
    }, 250);
  });
  async function findAddress() {
    const term = q.trim();
    if (term.length < 3 || lookingUp) return;
    lookingUp = true;
    try {
      // Near where you're looking first: the view, widened to at least a city's worth around it.
      let near = "";
      if (ctl) {
        const b = ctl.map.getBounds(), c = b.getCenter();
        const hw = Math.max((b.getEast() - b.getWest()) / 2, 0.25), hh = Math.max((b.getNorth() - b.getSouth()) / 2, 0.2);
        near = `&near=${[c.lng - hw, c.lat - hh, c.lng + hw, c.lat + hh].map((n) => n.toFixed(3)).join(",")}`;
      }
      addresses = (await api<{ results: Address[] }>(`/api/geocode?q=${encodeURIComponent(term)}${near}`)).results;
      if (addresses.length === 1) goToAddress(addresses[0]);
    } catch (e) {
      searchError = errorText(e);
    } finally {
      lookingUp = false;
    }
  }
  function goToAddress(a: Address) {
    ctl?.showSearchResult(a.lon, a.lat, a.bbox);
  }
  async function goToArea(a: Area) {
    const mine = teamAreas.some((t) => t.id === a.id);
    ctl?.fitBounds(a.bbox, { animate: true });
    // Not one of the team's: outline it for now (the team's are drawn already).
    if (!mine) {
      const full = await api<{ area: Area }>(`/api/areas/${a.id}`).then((r) => r.area, () => null);
      ctl?.setPreview(full?.geometry ?? null);
    } else ctl?.setPreview(null);
    q = "";
  }
  const head = (l: string) => l.split(", ").slice(0, 2).join(", ");
  const tail = (l: string) => l.split(", ").slice(2).filter((p) => p !== "United States").join(", ");

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

  /** An area clicked on the map: how far along it is, and where to manage it. */
  function showArea(id: string, at?: [number, number]) {
    // Picking where a stretch ends: only streets answer.
    if (stretchFrom) return;
    // Looking at another area: the highlight of the last one goes.
    if (missingFor && missingFor.id !== id) missingFor = null;
    const a = teamAreas.find((x) => x.id === id);
    if (!a || !ctl) return;
    const where = at ?? [(a.bbox[0] + a.bbox[2]) / 2, (a.bbox[1] + a.bbox[3]) / 2] as [number, number];
    const done = a.build_status === "built" && a.total_m
      ? `${percent(a.driven_m ?? 0, a.total_m)} swept · ${miles(a.driven_m)} of ${miles(a.total_m)}${isComplete(a) ? " · finished" : ""}`
      : "Its streets are being listed";
    const el = document.createElement("div");
    el.innerHTML = `<strong>${esc(a.name)}</strong><br><span class="muted">${esc(LEVEL_LABEL[a.level])}</span><br>${esc(done)}<br>`
      + (a.build_status === "built" && !isComplete(a) ? `<button class="sm popup-btn">Highlight what's left</button><br>` : "")
      + `<a href="/areas?area=${a.id}">Manage in Areas</a>`;
    el.querySelector("button")?.addEventListener("click", () => {
      ctl?.closePopup();
      missingFor = { id: a.id, name: a.name, team: coverageTeam };
    });
    ctl.showPopupEl(where, el);
  }

  // ---- several streets at once: shift-click to pick them, then mark them together ----
  let picked = $state(new Map<number, StreetHit>());
  let pickBusy = $state(false);
  let pickNote = $state<string | null>(null);
  let pickedNames = $derived(new Set([...picked.values()].map((h) => h.name?.toLowerCase() ?? `#${h.id}`)).size);
  let pickedM = $derived([...picked.values()].reduce((t, h) => t + h.length_m, 0));
  function togglePick(hit: StreetHit) {
    const next = new Map(picked);
    if (next.has(hit.id)) next.delete(hit.id);
    else next.set(hit.id, hit);
    picked = next;
    pickNote = null;
    ctl?.closePopup();
    ctl?.setSelectedStreets(next.keys());
  }
  function clearPicked() {
    picked = new Map();
    pickLabel = null;
    ctl?.setSelectedStreets([]);
  }

  // ---- part of a road: "from here to there" ----
  // A street's popup starts it ("Mark part of it…"); the next street clicked is where the
  // stretch ends. The server follows the road between the two (by route number for a
  // highway) and the stretch becomes the selection, to mark like any other.
  let stretchFrom = $state<StreetHit | null>(null);
  let stretchError = $state<string | null>(null);
  let pickLabel = $state<string | null>(null);
  async function stretchTo(hit: StreetHit) {
    const from = stretchFrom!;
    pickBusy = true;
    pickNote = null;
    stretchError = null;
    try {
      const r = await api<{ name: string | null; from: string | null; to: string | null; segments: [number, number][]; meters: number }>(
        `/api/segments/${from.id}/between/${hit.id}`);
      stretchFrom = null;
      picked = new Map(r.segments.map(([id, m]) => [id, { id, name: r.name, highway: "", length_m: m, state: null }]));
      ctl?.setSelectedStreets(picked.keys());
      const ends = r.from && r.to && r.from !== r.to ? ` from ${r.from} to ${r.to}` : "";
      pickLabel = `${r.name ?? "This road"}${ends}`;
    } catch (e) {
      // Still picking: say what was wrong and let them click again.
      stretchError = errorText(e);
    } finally {
      pickBusy = false;
    }
  }
  async function markPicked(kind: "complete" | "excluded" | "clear") {
    if (!picked.size) return;
    pickBusy = true;
    pickNote = null;
    try {
      const r = await api<{ pieces: number; meters: number }>(`/api/teams/${coverageTeam}/marks/bulk`, { body: { segment_ids: [...picked.keys()], kind } });
      const what = kind === "complete" ? "Marked done" : kind === "excluded" ? "Left out" : "Unmarked";
      pickNote = r.pieces ? `${what}: ${miles(r.meters)}.` : kind === "complete" ? "Nothing to mark: those are driven or marked already." : "Nothing changed.";
      setTimeout(() => (pickNote = null), 5000);
      clearPicked();
      ctl?.refreshCoverage();
      loadAreas();
      loadCells();
      missingPanel?.refresh();
    } catch (e) {
      pickNote = errorText(e);
    } finally {
      pickBusy = false;
    }
  }
  // Another team's coverage: a fresh start. Esc lets go of the lot.
  $effect(() => { void coverageTeam; untrack(() => { if (picked.size) clearPicked(); }); });
  onMount(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (stretchFrom) stretchFrom = null;
      else if (picked.size) clearPicked();
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  });

  // "Highlight what's left" in one area, for the team whose coverage is showing.
  let missingFor = $state<{ id: string; name: string; team: string } | null>(null);
  let missingPanel = $state<ReturnType<typeof MissingPanel>>();
  $effect(() => {
    // Another team's coverage means another answer: start again from the popup.
    if (missingFor && missingFor.team !== coverageTeam) missingFor = null;
  });

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
    ctl.setAreaLevels(levels);
    // For poking at from the browser console while debugging.
    (window as unknown as { streetsweep?: object }).streetsweep = { map: ctl.map, ctl };
    const unwatch = ctl.watchSize(box);
    ctl.map.on("zoomend", () => (zoom = ctl!.map.getZoom()));
    zoom = ctl.map.getZoom();
    ctl.onAreaClick = showArea;
    ctl.onPlaceClick = showPlace;
    loadPlaces();
    // The popup is a live component: it loads the street's coverage and can mark it.
    ctl.onStreetShiftClick = (hit) => (stretchFrom ? stretchTo(hit) : togglePick(hit));
    ctl.onStreetClick = (hit, at) => {
      // Picking where a stretch ends: this click is that, not a popup.
      if (stretchFrom) return stretchTo(hit);
      const el = document.createElement("div");
      const team = ctl!.coverageTeam;
      const comp = mount(StreetPopup, {
        target: el,
        props: {
          hit, teamId: team, teamLabel: teamLabel(team),
          onchange: () => { ctl?.refreshCoverage(); loadAreas(); loadCells(); missingPanel?.refresh(); },
          onstretch: () => { ctl?.closePopup(); clearPicked(); stretchFrom = hit; pickNote = null; stretchError = null; },
        },
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

<svelte:window onclick={closeView} />

<div class="mapwrap">
  <div class="map" bind:this={box}></div>

  <!-- Whose coverage, and finding a place: everything else about areas is on the Areas page. -->
  {#if toolsShown}
  <div class="tools">
    <div class="head">
    <label class="team">
      <span class="muted small">Coverage for</span>
      <select bind:value={coverageTeam} aria-label="Whose coverage">
        {#each teams as t (t.id)}<option value={t.id}>{t.kind === "personal" ? "Just me" : t.name}</option>{/each}
      </select>
    </label>
    <button class="sm ghost icon close" onclick={() => showTools(false)} aria-label="Hide search" title="Hide search">✕</button>
    </div>
    <form class="search" role="search" onsubmit={(e) => { e.preventDefault(); findAddress(); }}>
      <Icon name="search" size={16} />
      <input type="search" bind:value={q} placeholder="County, city, area or address" aria-label="Find a county, city, area or address" />
    </form>
    {#if q.trim().length >= 2}
      <div class="results">
        {#each found as a (a.id)}
          <button class="hit" onclick={() => goToArea(a)}>
            <strong>{a.name}</strong><span class="muted small">{LEVEL_LABEL[a.level]}{a.parent_name ? ` in ${a.parent_name}` : ""}</span>
          </button>
        {/each}
        {#if addresses === null}
          {#if q.trim().length >= 3}
            <button class="hit addr" disabled={lookingUp} onclick={findAddress}>
              <strong>{lookingUp ? "Looking up…" : `Find “${q.trim()}” as an address`}</strong><span class="muted small">or press Enter</span>
            </button>
          {/if}
        {:else}
          {#each addresses as a (a.label + a.lat)}
            <button class="hit" onclick={() => goToAddress(a)}><strong>{head(a.label)}</strong><span class="muted small">{tail(a.label)}</span></button>
          {:else}
            <p class="muted small none">No address like that in the imported region.</p>
          {/each}
        {/if}
        {#if searchError}<p class="small none err">{searchError}</p>{/if}
      </div>
    {/if}
  </div>
  {/if}

  <div class="top">
    {#if !toolsShown}
      <button class="tool" onclick={() => showTools(true)} title="Choose whose coverage, and find a place">
        <Icon name="search" size={16} /> Search
      </button>
    {/if}
    <div class="view" bind:this={viewMenu}>
      <button class="tool" class:open={viewOpen} aria-expanded={viewOpen} aria-haspopup="true" onclick={() => (viewOpen = !viewOpen)} title="Choose which kinds of area the map shows">
        <Icon name="layers" size={16} /> View
      </button>
      {#if viewOpen}
        <div class="menu" role="group" aria-label="Areas shown">
          <span class="small muted">Show areas</span>
          {#each LEVELS as l (l)}
            <label class="check"><input type="checkbox" checked={levels.includes(l)} onchange={() => toggleLevel(l)} /> {LEVEL_LABEL[l]}</label>
          {/each}
        </div>
      {/if}
    </div>
    <button class="tool" class:on={picking} aria-pressed={picking} onclick={startPick} title="Mark a place on the map">
      <Icon name="pin" size={16} /> {picking ? "Click the spot… (cancel)" : "Add place"}
    </button>
    <div class="seg" role="group" aria-label="Basemap">
      {#each BASES as b (b.key)}
        <button class:on={base === b.key} aria-pressed={base === b.key} onclick={() => setBase(b.key)}>{b.label}</button>
      {/each}
    </div>
  </div>

  {#if ctl && missingFor}
    {#key missingFor.id + missingFor.team}
      <MissingPanel bind:this={missingPanel} ctl={ctl} areaId={missingFor.id} areaName={missingFor.name} teamId={missingFor.team} onclose={() => (missingFor = null)} />
    {/key}
  {/if}

  <div class="bottom">
    {#if stretchFrom}
      <div class="chip picking" role="status">
        <span class="sel-dot" aria-hidden="true"></span>
        <span>{pickBusy ? "Following the road…" : stretchError ? stretchError : `Click where the stretch of ${stretchFrom.name ?? "this road"} ends`}</span>
        <button class="sm ghost" onclick={() => (stretchFrom = null)}>Cancel</button>
      </div>
    {:else if picked.size}
      <div class="chip picking" role="toolbar" aria-label="Selected streets">
        <span class="sel-dot" aria-hidden="true"></span>
        <span>{#if pickLabel}<strong>{pickLabel}</strong>{:else}<strong>{pickedNames} street{pickedNames === 1 ? "" : "s"}</strong>{/if} · {miles(pickedM)}</span>
        <button class="sm primary" disabled={pickBusy} onclick={() => markPicked("complete")}>Mark done</button>
        <button class="sm" disabled={pickBusy} onclick={() => markPicked("excluded")}>Leave out</button>
        <button class="sm ghost" disabled={pickBusy} onclick={() => markPicked("clear")} title="Take marks off these streets">Unmark</button>
        <button class="sm ghost icon" disabled={pickBusy} onclick={clearPicked} aria-label="Clear the selection" title="Clear the selection (Esc)">✕</button>
      </div>
    {:else if pickNote}
      <div class="chip">{pickNote}</div>
    {:else if info?.running}
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
  .tool.open { background: var(--accent-soft); border-color: var(--green-600); color: var(--green-700); }
  .check { display: flex; align-items: center; gap: 8px; font-weight: 400; }
  .check input { width: auto; height: auto; }
  .view { position: relative; }
  .menu {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 5; min-width: 170px; display: flex; flex-direction: column; gap: 8px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 10px 12px; font-size: 13px;
  }
  :global(.pthumb) { display: block; width: 100%; max-height: 140px; object-fit: cover; border-radius: 8px; margin-bottom: 6px; }
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
  .chip.picking { padding: 6px 6px 6px 14px; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .sel-dot { width: 12px; height: 12px; border-radius: 50%; background: #ff7a00; flex: none; animation: pulse 1.1s ease-in-out infinite; }
  .legend { gap: 12px; }
  .legend span { display: flex; align-items: center; gap: 5px; }
  .legend i { width: 14px; height: 4px; border-radius: 2px; display: block; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green-600); animation: pulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes pulse { 50% { opacity: .3; } }
  :global(.maplibregl-popup-content) { font: 13.5px/1.45 var(--ui); padding: 10px 28px 10px 12px; border-radius: 10px; }
  :global(.maplibregl-popup-content .muted) { color: var(--ink-soft); }
  :global(.maplibregl-popup-content .popup-btn) { margin: 6px 0 4px; height: 30px; font-size: 13px; }
  @media (max-width: 760px) {
    .mapwrap { height: calc(100dvh - 64px - env(safe-area-inset-bottom)); }
    .bottom { bottom: auto; top: 60px; left: 50%; }
  }
  .tools {
    position: absolute; top: 14px; left: 14px; width: 320px; z-index: 2; display: grid; gap: 8px; padding: 10px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
  }
  .head { display: flex; align-items: end; gap: 6px; }
  .team { display: grid; gap: 2px; flex: 1; min-width: 0; }
  .close { flex: none; margin-bottom: 2px; }
  .team select { height: 34px; font-weight: 700; }
  .search { position: relative; color: var(--ink-soft); }
  .search :global(svg) { position: absolute; left: 10px; top: 11px; }
  .search input { padding-left: 32px; height: 38px; }
  .results { display: grid; gap: 2px; max-height: 50vh; overflow: auto; }
  .hit { display: grid; gap: 1px; justify-items: start; justify-content: stretch; width: 100%; text-align: left; height: auto; padding: 7px 8px; border: 0; background: none; border-radius: 8px; font-weight: 400; white-space: normal; }
  .hit:hover:not([disabled]) { background: var(--surface-2); }
  .hit.addr strong { color: var(--link); }
  .none { padding: 6px 8px; margin: 0; }
  .err { color: var(--danger); }
  @media (max-width: 760px) {
    .tools { right: 8px; left: 8px; width: auto; top: 8px; }
  }
</style>
