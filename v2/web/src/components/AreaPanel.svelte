<script lang="ts">
  // The panel beside the map: a team's areas, finding public ones to follow, an area's
  // details, and drawing. The map stays put; this tells it what to show.
  import { onDestroy, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { api, errorText } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { defaultTeam } from "../lib/settings";
  import { OutlineDraw, ringsOf } from "../lib/draw.svelte";
  import { formValues } from "../lib/forms";
  import { miles, percent } from "../lib/format";
  import type { MapController } from "../lib/map";
  import { AREA_COLORS, LEVEL_LABEL, type Area } from "../lib/types";
  import { assignAreaColors } from "../lib/areaColors";

  let { ctl, panelWidth = 360, onteam, shown = true, onshow, onhide }: {
    ctl: MapController; panelWidth?: number; onteam?: (teamId: string) => void;
    /** Hidden, the panel keeps working (team, areas on the map); it's just out of the way. */
    shown?: boolean; onshow?: () => void; onhide?: () => void;
  } = $props();

  type Mode = "list" | "detail" | "draw";
  let mode = $state<Mode>("list");
  let teams = $derived(session.me!.teams);
  let teamId = $state(defaultTeam("streetsweep.areasTeam"));
  let areas = $state<Area[]>([]);
  let canEdit = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let q = $state("");
  let results = $state<Area[]>([]);
  let searching = $state(false);
  // Addresses: looked up only when asked (Enter), as the geocoder's rules require.
  type Address = { label: string; lon: number; lat: number; bbox: [number, number, number, number] | null; kind: string | null };
  let addresses = $state<Address[] | null>(null);
  let lookingUp = $state(false);

  let area = $state<Area | null>(null);
  let areaCanEdit = $state(false);
  let editing = $state(false);
  let form = $state({ name: "", notes: "", level: "neighborhood" as DrawnLevel });
  type DrawnLevel = "neighborhood" | "section" | "custom";
  const drawnLevel = (l: string): DrawnLevel => (l === "section" || l === "custom" ? l : "neighborhood");

  let draw = $state<OutlineDraw | null>(null);
  let redrawing = $state<Area | null>(null);


  let team = $derived(teams.find((t) => t.id === teamId));
  // Colours are automatic: no area shares one with an area it touches.
  let colors = $derived(assignAreaColors(areas));
  const colorOf = (a: Area) => colors.get(a.id) ?? AREA_COLORS[0];
  /** Every street driven or marked done (the ones left out don't count against it). */
  const isComplete = (a: Area) => a.build_status === "built" && !!a.total_m && (a.driven_m ?? 0) >= a.total_m * 0.9999;
  const followedHere = (a: Area) => areas.some((x) => x.id === a.id);

  // ---- the team's areas ----
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadAreas() {
    clearTimeout(pollTimer);
    try {
      const r = await api<{ areas: Area[]; can_edit: boolean }>(`/api/teams/${teamId}/areas`);
      areas = r.areas;
      canEdit = r.can_edit;
      const auto = assignAreaColors(r.areas);
      ctl.setTeamAreas(r.areas.map((a) => ({ type: "Feature", id: a.id, properties: { id: a.id, level: a.level, color: auto.get(a.id), complete: isComplete(a) }, geometry: a.geometry! })));
      // Street lists being built: check back until they're done.
      if (r.areas.some((a) => a.build_status === "queued" || a.build_status === "building")) pollTimer = setTimeout(refresh, 4000);
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }
  /** Coverage or areas changed elsewhere (a street marked on the map). */
  export async function refresh() {
    await loadAreas();
    if (area && mode === "detail") await open(area.id, false);
  }
  $effect(() => {
    const t = teamId;
    try { localStorage.setItem("streetsweep.areasTeam", t); } catch { /* fine */ }
    untrack(() => {
      onteam?.(t);
      loading = true;
      back();
      loadAreas();
    });
  });
  onDestroy(() => {
    clearTimeout(pollTimer);
    clearTimeout(searchTimer);
    draw?.stop();
  });

  // ---- search ----
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const term = q.trim();
    clearTimeout(searchTimer);
    addresses = null; // a new search: old address results no longer apply
    if (term.length < 2) {
      results = [];
      return;
    }
    searchTimer = setTimeout(async () => {
      searching = true;
      try {
        results = (await api<{ areas: Area[] }>(`/api/areas/search?q=${encodeURIComponent(term)}`)).areas;
      } catch (e) {
        error = errorText(e);
      } finally {
        searching = false;
      }
    }, 250);
  });

  async function findAddress() {
    const term = q.trim();
    if (term.length < 3 || lookingUp) return;
    lookingUp = true;
    error = null;
    try {
      addresses = (await api<{ results: Address[] }>(`/api/geocode?q=${encodeURIComponent(term)}`)).results;
      // One clear answer: go straight there.
      if (addresses.length === 1) goTo(addresses[0]);
    } catch (e) {
      error = errorText(e);
    } finally {
      lookingUp = false;
    }
  }

  function goTo(a: Address) {
    ctl.showSearchResult(a.lon, a.lat, a.bbox, { left: panelWidth });
  }

  /** "123 Main Street, Austin, Travis County, Texas, 78701, United States" → first two parts, then the rest. */
  const addressHead = (l: string) => l.split(", ").slice(0, 2).join(", ");
  const addressTail = (l: string) => l.split(", ").slice(2).filter((p) => p !== "United States").join(", ");

  // ---- one area ----
  export async function open(id: string, move = true) {
    error = null;
    // Asked for an area (a click on the map): come back into view to show it.
    onshow?.();
    try {
      const r = await api<{ area: Area; can_edit: boolean }>(`/api/areas/${id}`);
      area = r.area;
      areaCanEdit = r.can_edit;
      editing = false;
      mode = "detail";
      const inTeam = areas.some((a) => a.id === id);
      ctl.setSelectedArea(inTeam ? id : null);
      ctl.setPreview(inTeam ? null : r.area.geometry ?? null);
      if (move) ctl.fitBounds(r.area.bbox, { left: panelWidth, animate: true });
    } catch (e) {
      error = errorText(e);
    }
  }

  function back() {
    mode = "list";
    area = null;
    editing = false;
    ctl.setSelectedArea(null);
    ctl.setPreview(null);
  }

  async function act(fn: () => Promise<unknown>, after?: () => Promise<void> | void) {
    busy = true;
    error = null;
    try {
      await fn();
      await after?.();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  const follow = () => act(() => api(`/api/teams/${teamId}/follows`, { body: { area_id: area!.id } }), async () => {
    await loadAreas();
    await open(area!.id, false);
  });
  const unfollow = () => {
    if (!confirm(`Stop following ${area!.name}? Its drives stay; it just leaves this team's list.`)) return;
    act(() => api(`/api/teams/${teamId}/follows/${area!.id}`, { method: "DELETE" }), async () => {
      await loadAreas();
      await open(area!.id, false);
    });
  };

  function startEdit() {
    form = { name: area!.name, notes: area!.notes ?? "", level: drawnLevel(area!.level) };
    editing = true;
  }
  function saveEdit(el: HTMLFormElement) {
    const f = formValues(el);
    form.name = f.name ?? form.name;
    form.notes = f.notes ?? form.notes;
    act(() => api(`/api/areas/${area!.id}`, { method: "PATCH", body: { name: form.name.trim(), notes: form.notes.trim() || null, level: form.level } }),
      async () => {
        editing = false;
        await loadAreas();
        await open(area!.id, false);
      });
  }
  function remove() {
    if (!confirm(`Delete ${area!.name}? This can't be undone.`)) return;
    act(() => api(`/api/areas/${area!.id}`, { method: "DELETE" }), async () => {
      back();
      await loadAreas();
    });
  }

  // ---- drawing ----
  function startDraw(existing: Area | null) {
    redrawing = existing;
    form = existing
      ? { name: existing.name, notes: existing.notes ?? "", level: drawnLevel(existing.level) }
      : { name: "", notes: "", level: "neighborhood" };
    const neighbours = areas.filter((a) => a.id !== existing?.id && a.geometry).flatMap((a) => ringsOf(a.geometry!));
    ctl.busy = true;
    ctl.showAreas(false);
    ctl.setPreview(null);
    draw = new OutlineDraw(ctl.map, neighbours);
    if (existing?.geometry) draw.load(ringsOf(existing.geometry));
    else draw.addPiece();
    mode = "draw";
  }

  function endDraw() {
    draw?.stop();
    draw = null;
    ctl.busy = false;
    ctl.showAreas(true);
  }

  function cancelDraw() {
    const was = redrawing;
    endDraw();
    redrawing = null;
    if (was) open(was.id, false);
    else back();
  }

  async function saveDraw(el: HTMLFormElement) {
    const f = formValues(el);
    form.name = f.name ?? form.name;
    const geometry = draw?.geometry();
    if (!geometry) {
      error = "Draw the outline first: click each corner, then the first corner again to close it.";
      return;
    }
    if (!form.name.trim()) {
      error = "Give the area a name.";
      return;
    }
    busy = true;
    error = null;
    try {
      let id: string;
      if (redrawing) {
        await api(`/api/areas/${redrawing.id}`, { method: "PATCH", body: { geometry, name: form.name.trim(), level: form.level } });
        id = redrawing.id;
      } else {
        id = (await api<{ id: string }>(`/api/teams/${teamId}/areas`, { body: { name: form.name.trim(), level: form.level, geometry } })).id;
      }
      endDraw();
      redrawing = null;
      await loadAreas();
      await open(id, false);
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  // ---- words ----
  /** The team's progress in an area it follows or drew (the list carries it). */
  const progressOf = (id: string) => {
    const a = areas.find((x) => x.id === id);
    return a && a.build_status === "built" && a.total_m ? a : null;
  };
  const share = (a: Area) => Math.min(100, ((a.driven_m ?? 0) / a.total_m!) * 100);
  /** Small areas in acres, bigger ones in square miles (everything else here is in miles). */
  function size(km2: number) {
    const sqmi = km2 * 0.386102;
    if (sqmi < 1) return `${Math.max(1, Math.round(sqmi * 640)).toLocaleString()} acres`;
    return `${sqmi < 10 ? sqmi.toFixed(1) : Math.round(sqmi).toLocaleString()} sq mi`;
  }
  const ownerOf = (a: Area) => (teams.find((t) => t.id === a.team_id)?.kind === "personal" ? "yours" : `drawn by ${a.team_name ?? "a team"}`);
  function status(a: Area): string {
    if (a.build_status === "queued") return "Waiting to list its streets";
    if (a.build_status === "building") return "Listing its streets…";
    if (a.build_status === "failed") return "Couldn't list its streets";
    if (a.build_status === "built") return `${miles(a.street_m)} of streets`;
    return a.km2 ? size(a.km2) : "";
  }
  const kind = (a: Area) => `${LEVEL_LABEL[a.level]}${a.parent_name ? ` in ${a.parent_name}` : ""}`;
</script>

<aside class="panel" class:hidden={!shown && mode !== "draw"} style:width="{panelWidth}px">
  {#if mode === "list"}
    <header>
      <label class="team">
        <span class="muted small">Areas for</span>
        <select bind:value={teamId} aria-label="Team">
          {#each teams as t (t.id)}<option value={t.id}>{t.kind === "personal" ? "Just me" : t.name}</option>{/each}
        </select>
      </label>
      {#if canEdit}<button class="sm primary" onclick={() => startDraw(null)}><Icon name="plus" size={16} /> Draw</button>{/if}
      {#if onhide}<button class="sm ghost icon" onclick={onhide} aria-label="Hide areas" title="Hide areas">✕</button>{/if}
    </header>

    <form class="search" role="search" onsubmit={(e) => { e.preventDefault(); findAddress(); }}>
      <Icon name="search" size={17} />
      <input type="search" placeholder="County, city or address" bind:value={q} aria-label="Find a county, city or address" />
    </form>

    {#if error}<p class="notice error">{error}</p>{/if}

    {#if q.trim().length >= 2}
      <div class="list">
        {#each results as a (a.id)}
          <button class="item" onclick={() => open(a.id)}>
            <span class="swatch outline"></span>
            <span class="grow"><strong>{a.name}</strong><span class="muted small">{kind(a)}</span></span>
            {#if a.followed_by?.includes(teamId)}<span class="badge green">Following</span>{/if}
          </button>
        {:else}
          {#if searching}<p class="muted small pad">Searching…</p>{/if}
        {/each}
        {#if addresses === null}
          {#if q.trim().length >= 3}
            <button class="item addr-ask" disabled={lookingUp} onclick={findAddress}>
              <Icon name="pin" size={16} />
              <span class="grow"><strong>{lookingUp ? "Looking up…" : `Find “${q.trim()}” as an address`}</strong><span class="muted small">or press Enter</span></span>
            </button>
          {/if}
        {:else}
          <p class="muted small pad addr-head">Addresses</p>
          {#each addresses as a (a.label + a.lat)}
            <button class="item" onclick={() => goTo(a)}>
              <span class="pin"><Icon name="pin" size={16} /></span>
              <span class="grow"><strong>{addressHead(a.label)}</strong><span class="muted small">{addressTail(a.label)}</span></span>
            </button>
          {:else}
            <p class="muted small pad">No address like that in the imported region.</p>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="list">
        {#each areas as a (a.id)}
          <button class="item" onclick={() => open(a.id)}>
            <span class="swatch" style:background={colorOf(a)}></span>
            <span class="grow">
              <strong>{a.name}</strong>
              <span class="muted small">{a.source === "drawn" ? LEVEL_LABEL[a.level] : kind(a)} · {status(a)}</span>
              {#if progressOf(a.id)}
                <span class="bar" title="{miles(a.driven_m)} of {miles(a.total_m)} swept"><span style:width="{share(a)}%" style:background={colorOf(a)}></span></span>
              {/if}
            </span>
            {#if progressOf(a.id)}<span class="pct">{percent(a.driven_m ?? 0, a.total_m!)}</span>{/if}
            {#if a.build_status === "queued" || a.build_status === "building"}<span class="spin" aria-label="Working"></span>{/if}
          </button>
        {:else}
          {#if !loading}
            <div class="empty muted small">
              <p><strong>No areas yet.</strong></p>
              <p>Search for your county or city above and follow it{canEdit ? ", or draw your own neighborhood" : ""}.
                {#if !canEdit} Only {team?.kind === "personal" ? "you" : "this team's admins"} can add areas.{/if}</p>
            </div>
          {/if}
        {/each}
      </div>
    {/if}

  {:else if mode === "detail" && area}
    <header>
      <button class="sm ghost back" onclick={back}><Icon name="back" size={16} /> Areas</button>
      {#if onhide}<button class="sm ghost icon" onclick={onhide} aria-label="Hide areas" title="Hide areas">✕</button>{/if}
    </header>
    {#if error}<p class="notice error">{error}</p>{/if}
    <div class="detail">
      <div class="title">
        <span class="swatch big" class:outline={!followedHere(area) && area.source !== "drawn"} style:background={followedHere(area) || area.source === "drawn" ? colorOf(area) : "none"}></span>
        <div>
          <h2>{area.name}</h2>
          <p class="muted small">{area.source === "drawn" ? `${LEVEL_LABEL[area.level]}${area.parent_name ? ` in ${area.parent_name}` : ""} · ${ownerOf(area)}` : kind(area)}</p>
        </div>
      </div>

      <div class="facts">
        <div><span class="muted small">Streets</span><strong>{area.build_status === "built" ? miles(area.street_m) : "—"}</strong></div>
        <div><span class="muted small">Segments</span><strong>{area.segment_count?.toLocaleString() ?? "—"}</strong></div>
        <div><span class="muted small">Size</span><strong>{size(area.km2)}</strong></div>
      </div>

      {#if progressOf(area.id)}
        {@const p = progressOf(area.id)!}
        <div class="progress">
          <div class="progress-head">
            <strong>{percent(p.driven_m ?? 0, p.total_m!)} swept</strong>
            <span class="muted small">{team?.kind === "personal" ? "by you" : `by ${team?.name}`}</span>
          </div>
          <span class="bar big"><span style:width="{share(p)}%" style:background={colorOf(area)}></span></span>
          <span class="muted small">{miles(p.driven_m)} of {miles(p.total_m)} · {(p.driven_segments ?? 0).toLocaleString()} of {(p.total_segments ?? 0).toLocaleString()} street segments.
            Streets marked done count; ones left out don't count against you.</span>
        </div>
      {/if}

      {#if area.build_status === "queued" || area.build_status === "building"}
        <p class="notice">{status(area)}. This takes a few seconds for a city and a few minutes for a whole state.</p>
      {:else if area.build_status === "failed"}
        <p class="notice error">Couldn't list its streets{area.build_error ? `: ${area.build_error}` : ""}.</p>
      {:else if area.build_status === "none" && area.source === "osm_boundary"}
        <p class="muted small">Follow it to list its streets and track coverage for {team?.kind === "personal" ? "yourself" : team?.name}.</p>
      {/if}

      {#if area.notes && !editing}<p class="notes">{area.notes}</p>{/if}

      {#if area.source === "osm_boundary"}
        {#if canEdit}
          {#if followedHere(area)}
            <button disabled={busy} onclick={unfollow}>Unfollow</button>
          {:else}
            <button class="primary" disabled={busy} onclick={follow}>Follow for {team?.kind === "personal" ? "me" : team?.name}</button>
          {/if}
        {:else if followedHere(area)}
          <span class="badge green">Followed by this team</span>
        {/if}
        <p class="muted small">From OpenStreetMap. Boundaries refresh with the monthly import.</p>
      {:else if areaCanEdit}
        {#if editing}
          <form class="stack" onsubmit={(e) => { e.preventDefault(); saveEdit(e.currentTarget); }}>
            <label class="field">Name <input type="text" name="name" bind:value={form.name} maxlength="120" autocomplete="off" required /></label>
            <label class="field">Kind
              <select bind:value={form.level}><option value="neighborhood">Neighborhood</option><option value="section">Section of a neighborhood</option><option value="custom">Custom area</option></select></label>
            <label class="field">Notes <textarea name="notes" bind:value={form.notes} maxlength="2000"></textarea></label>
            <div class="row-btns"><button type="button" class="ghost" onclick={() => (editing = false)}>Cancel</button><button type="submit" class="primary" disabled={busy}>Save</button></div>
          </form>
        {:else}
          <div class="row-btns">
            <button disabled={busy} onclick={startEdit}>Edit</button>
            <button disabled={busy} onclick={() => startDraw(area)}>Redraw outline</button>
            <button class="ghost danger" disabled={busy} onclick={remove}>Delete</button>
          </div>
        {/if}
      {/if}
    </div>

  {:else if mode === "draw" && draw}
    <header><h2>{redrawing ? `Redraw ${redrawing.name}` : "Draw an area"}</h2></header>
    {#if error}<p class="notice error">{error}</p>{/if}
    <p class="muted small">
      {#if draw.drawing}Click each corner on the map. Click the first corner again (or double-click) to close the shape.
      {:else}Drag a corner to move it; drag the dot between two corners to add one. An area can have several pieces.{/if}
    </p>
    <div class="row-btns">
      {#if draw.drawing}
        <button class="sm" onclick={() => draw!.cancelPiece()}>Stop drawing</button>
      {:else}
        <button class="sm" onclick={() => draw!.addPiece()}><Icon name="plus" size={15} /> Add a piece</button>
        {#if draw.selected}<button class="sm ghost danger" onclick={() => draw!.deleteSelected()}>Delete piece</button>{/if}
      {/if}
      <span class="muted small">{draw.pieces} piece{draw.pieces === 1 ? "" : "s"}</span>
    </div>
    <form class="stack" onsubmit={(e) => { e.preventDefault(); saveDraw(e.currentTarget); }}>
      <label class="field">Name <input type="text" name="name" bind:value={form.name} maxlength="120" autocomplete="off" placeholder="e.g. Old Town" required /></label>
      <label class="field">Kind
        <select bind:value={form.level}><option value="neighborhood">Neighborhood</option><option value="section">Section of a neighborhood</option><option value="custom">Custom area</option></select></label>
      <div class="row-btns"><button type="button" class="ghost" onclick={cancelDraw}>Cancel</button><button type="submit" class="primary" disabled={busy}>Save area</button></div>
    </form>
  {/if}
</aside>

<style>
  .panel {
    position: absolute; top: 14px; left: 14px; max-height: calc(100% - 28px); z-index: 2;
    background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
    display: flex; flex-direction: column; gap: 10px; padding: 12px; overflow: auto;
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .hidden { display: none; }
  .icon { width: 30px; padding: 0; flex: none; }
  .team { display: grid; gap: 2px; flex: 1; min-width: 0; }
  .team select { height: 34px; font-weight: 700; }
  .search { position: relative; display: block; color: var(--ink-soft); }
  .search :global(svg) { position: absolute; left: 11px; top: 11px; }
  .search input { padding-left: 34px; }
  .pin { color: #e2721f; display: grid; place-items: center; width: 14px; flex: none; }
  .addr-ask { color: var(--link); }
  .addr-head { padding-bottom: 0; text-transform: uppercase; letter-spacing: .04em; font-size: 11.5px; }
  .list { display: grid; gap: 2px; }
  .item {
    display: flex; align-items: center; justify-content: flex-start; gap: 10px; text-align: left; height: auto; padding: 9px 10px; white-space: normal;
    border: 0; background: none; border-radius: 10px; width: 100%; font-weight: 400;
  }
  .item:hover:not([disabled]) { background: var(--surface-2); }
  .item .grow { display: grid; gap: 1px; min-width: 0; }
  .item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { width: 14px; height: 14px; border-radius: 4px; flex: none; }
  .swatch.outline { border: 2px dashed #6b7c8f; background: none; }
  .swatch.big { width: 22px; height: 22px; border-radius: 6px; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--green-600); animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { padding: 12px 6px; display: grid; gap: 6px; }
  .pad { padding: 8px 6px; }
  .back { padding-left: 6px; }
  .detail { display: grid; gap: 12px; }
  .title { display: flex; gap: 10px; align-items: flex-start; }
  .title .swatch { margin-top: 3px; }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .facts div { display: grid; gap: 1px; background: var(--surface-2); border-radius: 10px; padding: 8px 10px; }
  .notes { white-space: pre-wrap; font-size: 13.5px; }
  .bar { display: block; height: 5px; border-radius: 99px; background: var(--line); overflow: hidden; margin-top: 4px; }
  .bar > span { display: block; height: 100%; border-radius: 99px; min-width: 2px; }
  .bar.big { height: 9px; margin: 0; }
  .pct { font-size: 12.5px; font-weight: 700; color: var(--ink-soft); flex: none; }
  .progress { display: grid; gap: 6px; }
  .progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .row-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .danger { color: var(--danger); }
  @media (max-width: 760px) {
    .panel { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto !important; max-height: 48%; }
  }
</style>
