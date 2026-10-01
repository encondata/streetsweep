<script lang="ts">
  import { onDestroy } from "svelte";
  import { store, parentsOf, isOrg } from "../../lib/store.svelte";
  import { ws } from "../../lib/workspace.svelte";
  import { router } from "../../lib/router.svelte";
  import { api } from "../../lib/api";
  import { AreaStreets, statusOf, drivenStatus, type Street } from "../../lib/streets.svelte";
  import { LEVEL_LABEL, LEVEL_COLOR, abc } from "../../lib/levels";
  import { distance, pct, squareMiles, areaSize } from "../../lib/geo";
  import { portal } from "../../lib/portal";
  import Icon from "../../lib/Icon.svelte";
  import type { Area, ExclusionReason, StreetStatus } from "../../lib/types";

  let { area }: { area: Area } = $props();

  const rings = $derived([area.polygon, ...area.morePieces]);
  const org = $derived(isOrg(area));
  const p = $derived(store.progress[area.name]);
  const parents = $derived(parentsOf(area).map((n) => store.byName(n) || { name: n, id: 0 }));
  const inside = $derived(
    store.areas.filter((a) => parentsOf(a).some((n) => n.toLowerCase() === area.name.toLowerCase()))
      .sort((x, y) => abc(x.name, y.name)),
  );

  // ---- streets ----
  // svelte-ignore state_referenced_locally
  const streets = new AreaStreets(area);
  type Mode = "inspect" | "complete" | "gated" | "exclude";
  let mode = $state<Mode>("inspect");
  let reason = $state<ExclusionReason>("NOT_DRIVABLE");
  let picked = $state<{ s: Street; x: number; y: number } | null>(null);
  let shown = $state<Record<StreetStatus, boolean>>({ done: true, partial: true, none: true, marked: true, excluded: true });

  const counts = $derived(streets.counts());

  // The map: this area outlined, the others faint behind it, its streets on top.
  $effect(() => {
    const m = ws.map;
    if (!m) return;
    const styles: Record<number, { id: number; fraction: number | null; focus: boolean; dim: boolean }> = {};
    for (const a of store.areas) styles[a.id] = { id: a.id, fraction: null, focus: a.id === area.id, dim: a.id !== area.id };
    m.setAreas(store.areas, styles);
    m.setPreview(null);
  });
  $effect(() => {
    const m = ws.map;
    if (!m) return;
    m.setStreets(streets.features().filter((f) => shown[f.status]));
  });
  $effect(() => {
    ws.map?.selectStreet(picked?.s.id ?? null);
  });

  // svelte-ignore state_referenced_locally
  ws.map?.fit(rings);
  // svelte-ignore state_referenced_locally
  if (!org) {
    if (streets.whole) streets.load();
    else setTimeout(() => ws.map && streets.load(ws.map.box(), ws.map.map.getZoom()), 700);
  }

  $effect(() => {
    const m = ws.map;
    if (!m) return;
    m.onAreaClick = (id) => { if (id !== area.id) router.go(`/map/area/${id}`); };
    m.onStreetClick = (f, [x, y]) => {
      const s = streets.streets[f.i];
      if (!s) return;
      if (mode === "inspect") picked = { s, x, y };
      else act(s, mode);
    };
    m.onMapClick = () => (picked = null);
    m.onMove = (box, zoom) => { if (!org && !streets.whole) streets.load(box, zoom); };
    return () => { m.onAreaClick = null; m.onStreetClick = null; m.onMapClick = null; m.onMove = null; m.selectStreet(null); };
  });
  onDestroy(() => ws.map?.setStreets([]));

  // ---- acting on a street ----
  const REASONS: [ExclusionReason, string][] = [
    ["NOT_DRIVABLE", "Not drivable"], ["NOT_NEEDED", "Not needed"], ["OTHER", "Other"],
  ];
  const REASON_LABEL: Record<ExclusionReason, string> = {
    GATED: "Gated or private", NOT_DRIVABLE: "Not drivable", NOT_NEEDED: "Not needed", OTHER: "Other",
  };
  const label = (s: Street) => s.name || "Unnamed street";

  /**
   * Toggles: clicking a street already marked complete unmarks it, and the same for gated
   * and excluded, so the tool never needs a separate "undo this one".
   */
  async function act(s: Street, what: Mode | "unmark" | "include", r: ExclusionReason = reason) {
    if (!store.canMark) return ws.say("Your account can look but not mark streets.", { tone: "bad" });
    picked = null;
    try {
      if (what === "complete" || what === "unmark") {
        const on = what === "complete" ? !s.marked : false;
        await api.markComplete([s.id], on);
        streets.update([s.id], (x) => { x.marked = on ? { by: store.me?.name || null, at: Date.now() } : null; });
        ws.say(on ? `${label(s)} marked complete` : `${label(s)} no longer marked`, {
          undo: async () => {
            await api.markComplete([s.id], !on);
            streets.update([s.id], (x) => { x.marked = !on ? { by: store.me?.name || null, at: Date.now() } : null; });
            store.refreshProgress();
          },
        });
      } else {
        const why: ExclusionReason = what === "gated" ? "GATED" : r;
        const on = what === "include" ? false : !(s.excluded && s.excluded.reason === why);
        const before = s.excluded;
        await api.exclude([s.id], on, why);
        streets.update([s.id], (x) => { x.excluded = on ? { reason: why, by: store.me?.name || null, at: Date.now() } : null; });
        ws.say(on ? `${label(s)}: ${REASON_LABEL[why].toLowerCase()}` : `${label(s)} counts again`, {
          undo: async () => {
            if (before) await api.exclude([s.id], true, before.reason);
            else await api.exclude([s.id], false);
            streets.update([s.id], (x) => { x.excluded = before; });
            store.refreshProgress();
          },
        });
      }
      store.refreshProgress();
    } catch (e) {
      ws.say("Not saved: " + (e as Error).message, { tone: "bad" });
    }
  }

  const TOOLS: [Mode, string, string, string][] = [
    ["inspect", "pointer", "Look", "Click a street to see how much of it is driven, and what can be done with it."],
    ["complete", "check", "Complete", "Click streets to mark them complete. Click a marked one to unmark it."],
    ["gated", "gate", "Gated", "Click streets behind a gate or otherwise private; they stop counting. Click again to count one."],
    ["exclude", "ban", "Exclude", "Click streets to exclude them for the reason chosen. Click again to count one."],
  ];
  const toolHint = $derived(TOOLS.find((t) => t[0] === mode)?.[3] || "");

  const STATUS: [StreetStatus, string][] = [
    ["done", "Driven"], ["partial", "Partly driven"], ["none", "Not driven"], ["marked", "Marked complete"], ["excluded", "Excluded"],
  ];

  // ---- the area itself ----
  let menu = $state(false);
  async function remove() {
    menu = false;
    // Taken now: once it is gone from the list, this panel no longer has it.
    const { id, name } = area;
    if (!confirm(`Delete ${name}? Its outline and figures go; the streets driven in it stay driven.`)) return;
    try {
      router.go("/map");
      await store.remove(id);
      ws.say(`${name} deleted`);
    } catch (e) {
      ws.say("Not deleted: " + (e as Error).message, { tone: "bad" });
    }
  }

  let mapEl = $derived(ws.map?.map.getContainer().parentElement);
</script>

<div class="head">
  <button class="ghost sm back" onclick={() => router.go("/map")}><Icon name="back" size={16} /> All areas</button>
  <div class="title">
    <span class="dot big" style:background={area.color || LEVEL_COLOR[area.level]}></span>
    <div class="t">
      <h1>{area.name}</h1>
      <p class="muted">
        {LEVEL_LABEL[area.level]}
        {#if parents.length} · in
          {#each parents as par, k}
            {#if k}, {/if}
            {#if par.id}<a href={"/v2/map/area/" + par.id} onclick={(e) => { e.preventDefault(); router.go(`/map/area/${par.id}`); }}>{par.name}</a>{:else}{par.name}{/if}
          {/each}
        {/if}
      </p>
    </div>
    {#if store.canEditAreas}
      <div class="more">
        <button class="ghost icon" onclick={() => (menu = !menu)} aria-label="Area actions" aria-expanded={menu}>⋯</button>
        {#if menu}
          <div class="menu card">
            <button class="ghost" onclick={() => router.go(`/map/area/${area.id}/edit`)}><Icon name="edit" size={16} /> Edit details</button>
            <button class="ghost" onclick={() => router.go(`/map/area/${area.id}/outline`)}><Icon name="outline" size={16} /> Edit outline</button>
            <button class="ghost danger" onclick={remove}><Icon name="trash" size={16} /> Delete area</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<div class="body scroll">
  {#if org}
    <div class="card note">
      <span class="org">Grouping only</span>
      <p class="muted">{LEVEL_LABEL[area.level]}s organise other areas. Nothing is downloaded or counted for them, and phones do not get them.</p>
    </div>
  {:else}
    <div class="card figures">
      {#if p && p.total}
        <div class="big">
          <span class="num">{pct(p.done, p.total)}%</span>
          <span class="muted">{p.done.toLocaleString()} of {p.total.toLocaleString()} streets{p.pending ? " · recounting…" : ""}</span>
        </div>
        <div class="bar thick"><i style:width={pct(p.done, p.total) + "%"}></i></div>
        <dl>
          <div><dt>Distance driven</dt><dd class="num">{distance(p.metersDriven)} of {distance(p.metersTotal)}</dd></div>
          <div><dt>Partly driven</dt><dd class="num">{p.partial.toLocaleString()}</dd></div>
          <div><dt>Marked complete</dt><dd class="num">{p.marked.toLocaleString()}</dd></div>
          <div><dt>Excluded</dt><dd class="num">{p.excluded.toLocaleString()}</dd></div>
        </dl>
      {:else}
        <p class="muted">Counting this area’s streets… it takes a moment the first time.</p>
      {/if}
    </div>

    <div class="section">
      <div class="sh">
        <h3>Streets on the map</h3>
        {#if streets.loading}<span class="muted small">loading…</span>{/if}
      </div>
      {#if !streets.whole}
        <p class="muted small">A large area: its streets load for the part of the map in view{(ws.map?.map.getZoom() ?? 0) < 12 ? " — zoom in to see them" : ""}.</p>
      {/if}
      {#if streets.error}<p class="bad small">{streets.error}</p>{/if}
      {#if store.canMark}<p class="tool small"><b>{TOOLS.find((t) => t[0] === mode)?.[2]}:</b> {toolHint}</p>{/if}
      <ul class="legend">
        {#each STATUS as [st, name]}
          <li>
            <label>
              <input type="checkbox" bind:checked={shown[st]} />
              <span class="swatch" style:background={`var(--st-${st})`}></span>
              {name}
              <span class="num muted">{counts[st].toLocaleString()}</span>
            </label>
          </li>
        {/each}
      </ul>
    </div>

    <div class="section">
      <p class="muted small">{areaSize(squareMiles(rings))}{rings.length > 1 ? ` in ${rings.length} pieces` : ""}{area.city ? " · " + area.city : ""}</p>
      {#if area.notes}<p class="notes">{area.notes}</p>{/if}
    </div>
  {/if}

  {#if inside.length}
    <div class="section">
      <h3>Areas inside</h3>
      <ul class="inside">
        {#each inside as a}
          {@const q = store.progress[a.name]}
          <li>
            <button class="row" onclick={() => router.go(`/map/area/${a.id}`)}>
              <span class="dot" style:background={a.color || LEVEL_COLOR[a.level]}></span>
              <span class="nm">{a.name} <small class="muted">{LEVEL_LABEL[a.level]}</small></span>
              {#if q && q.total}<span class="num small">{pct(q.done, q.total)}%</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

{#if !org && store.canMark}
  <div class="tools card" use:portal={mapEl}>
    {#each TOOLS as [m, icon, name, hint]}
      <button class="sm" class:on={mode === m} aria-pressed={mode === m} title={hint}
        onclick={() => { mode = m; picked = null; }}>
        <Icon name={icon} size={15} /> {name}
      </button>
    {/each}
    {#if mode === "exclude"}
      <select bind:value={reason} aria-label="Reason">
        {#each REASONS as [r, name]}<option value={r}>{name}</option>{/each}
      </select>
    {/if}
  </div>
{/if}

{#if picked}
  {@const s = picked.s}
  {@const st = statusOf(s)}
  <div class="pop card" use:portal={mapEl} style:left={picked.x + "px"} style:top={picked.y + "px"}>
    <div class="ph">
      <b>{label(s)}</b>
      <button class="ghost icon sm" onclick={() => (picked = null)} aria-label="Close"><Icon name="close" size={14} /></button>
    </div>
    <p class="muted small">
      <span class="swatch" style:background={`var(--st-${st})`}></span>
      {STATUS.find((x) => x[0] === st)?.[1]} · {distance(s.driven)} of {distance(s.length)} driven
    </p>
    {#if s.marked}<p class="small muted">Marked complete{s.marked.by ? " by " + s.marked.by : ""}.</p>{/if}
    {#if s.excluded}<p class="small muted">{REASON_LABEL[s.excluded.reason]}{s.excluded.by ? " — " + s.excluded.by : ""}.</p>{/if}
    {#if store.canMark}
      <div class="acts">
        {#if s.excluded}
          <button class="sm" onclick={() => act(s, "include")}>Count it again</button>
        {:else}
          {#if s.marked}
            <button class="sm" onclick={() => act(s, "unmark")}>Unmark</button>
          {:else if drivenStatus(s) !== "done"}
            <button class="sm primary" onclick={() => act(s, "complete")}><Icon name="check" size={14} /> Mark complete</button>
          {/if}
          <button class="sm" onclick={() => act(s, "gated")}><Icon name="gate" size={14} /> Gated</button>
          <button class="sm" onclick={() => act(s, "exclude", "NOT_DRIVABLE")}>Not drivable</button>
          <button class="sm" onclick={() => act(s, "exclude", "NOT_NEEDED")}>Not needed</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .head { padding: 10px 16px 14px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
  .back { justify-self: start; margin-left: -8px; }
  .title { display: flex; align-items: flex-start; gap: 10px; }
  .dot.big { width: 14px; height: 14px; margin-top: 6px; }
  .t { flex: 1; min-width: 0; }
  .t h1 { overflow-wrap: anywhere; }
  .t p { font-size: 13px; }
  .more { position: relative; }
  .more > button { font-size: 20px; line-height: 1; }
  .menu { position: absolute; right: 0; top: 38px; width: 200px; padding: 6px; display: grid; z-index: 20; }
  .menu button { justify-content: flex-start; }
  .body { flex: 1; padding: 14px 16px 120px; display: grid; gap: 16px; align-content: start; }
  .figures { padding: 14px; display: grid; gap: 10px; }
  .big { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .big .num { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
  .bar.thick { height: 8px; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
  dt { font-size: 11.5px; color: var(--ink-soft); }
  dd { margin: 0; font-weight: 600; }
  .section { display: grid; gap: 8px; }
  .sh { display: flex; align-items: baseline; justify-content: space-between; }
  .small { font-size: 12px; }
  .bad { color: var(--danger); }
  .legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .legend label { display: flex; align-items: center; gap: 8px; padding: 4px 2px; cursor: pointer; }
  .legend .num { margin-left: auto; }
  .swatch { width: 18px; height: 4px; border-radius: 3px; display: inline-block; vertical-align: middle; }
  .note { padding: 14px; display: grid; gap: 8px; justify-items: start; }
  .org { font-size: 11px; font-weight: 600; border: 1px solid var(--line-strong); border-radius: 99px; padding: 1px 8px; }
  .notes { white-space: pre-wrap; }
  .inside { list-style: none; margin: 0; padding: 0; display: grid; }
  .inside .row { width: 100%; justify-content: flex-start; gap: 10px; border: 0; background: transparent; padding: 6px; }
  .inside .row:hover { background: var(--surface-2); }
  .inside .nm { flex: 1; text-align: left; }

  .tools {
    position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 4;
    display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 12px; box-shadow: var(--shadow-2);
    white-space: nowrap;
  }
  .tool { background: var(--surface-2); border-radius: 8px; padding: 8px 10px; }
  .tools button { border-color: transparent; }
  .tools button.on { background: var(--ink); color: var(--surface); }
  .tools select { width: auto; min-height: 28px; padding: 2px 8px; font-size: 12px; }
  .pop {
    position: absolute; z-index: 5; width: 280px; padding: 10px 12px 12px; display: grid; gap: 6px;
    transform: translate(-50%, calc(-100% - 14px)); box-shadow: var(--shadow-2);
  }
  .ph { display: flex; align-items: center; gap: 8px; }
  .ph b { flex: 1; }
  .ph button { width: 26px; min-height: 26px; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
</style>
