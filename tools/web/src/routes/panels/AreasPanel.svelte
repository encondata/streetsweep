<script lang="ts">
  import { store, areaTree, isOrg, type TreeNode } from "../../lib/store.svelte";
  import { ws } from "../../lib/workspace.svelte";
  import { router } from "../../lib/router.svelte";
  import { LEVEL_LABEL, LEVEL_COLOR } from "../../lib/levels";
  import { pct } from "../../lib/geo";
  import Icon from "../../lib/Icon.svelte";
  import type { Area } from "../../lib/types";

  type Filter = "all" | "going" | "none" | "done";
  let query = $state("");
  let filter = $state<Filter>("all");

  const FOLD_KEY = "streetsweep.v2.folded";
  let folded = $state<Record<number, boolean>>(readFolded());
  function readFolded() { try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}"); } catch { return {}; } }
  function toggle(id: number) {
    folded = { ...folded, [id]: !folded[id] };
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folded)); } catch {}
  }

  function stateOf(a: Area): Filter | "org" {
    if (isOrg(a)) return "org";
    const p = store.progress[a.name];
    if (!p || !p.total || !p.done) return p && p.partial ? "going" : "none";
    return p.done >= p.total ? "done" : "going";
  }
  function matches(a: Area) {
    const q = query.trim().toLowerCase();
    if (q && !a.name.toLowerCase().includes(q) && !LEVEL_LABEL[a.level].toLowerCase().includes(q)) return false;
    return filter === "all" || stateOf(a) === filter;
  }
  const filtering = $derived(query.trim() !== "" || filter !== "all");

  const tree = $derived(areaTree(store.areas));
  // A branch shows if it matches or anything under it does; a filter opens it.
  function visible(n: TreeNode): boolean { return matches(n.area) || n.kids.some(visible); }
  const rows = $derived.by(() => {
    const out: { node: TreeNode; context: boolean; hasKids: boolean }[] = [];
    const walk = (n: TreeNode) => {
      if (!visible(n)) return;
      const kids = n.kids.filter(visible);
      out.push({ node: n, context: filtering && !matches(n.area), hasKids: kids.length > 0 });
      if (filtering || !folded[n.area.id]) kids.forEach(walk);
    };
    tree.forEach(walk);
    return out;
  });

  const counts = $derived.by(() => {
    const c = { all: 0, going: 0, none: 0, done: 0 } as Record<Filter, number>;
    for (const a of store.areas) { const s = stateOf(a); if (s !== "org") { c[s]++; c.all++; } }
    return c;
  });

  // The map shows every area; the one pointed at in the list stands out.
  $effect(() => {
    const m = ws.map;
    if (!m) return;
    const styles: Record<number, { id: number; fraction: number | null; focus: boolean; dim: boolean }> = {};
    for (const a of store.areas) styles[a.id] = { id: a.id, fraction: null, focus: ws.hover === a.id, dim: false };
    m.setAreas(store.areas, styles);
    m.setStreets([]);
    m.setPreview(null);
  });
  $effect(() => {
    const m = ws.map;
    if (!m) return;
    m.onAreaClick = (id) => router.go(`/map/area/${id}`);
    m.onStreetClick = null;
    m.onMapClick = null;
    return () => { m.onAreaClick = null; };
  });
  // Once: the whole set in view.
  let fitted = false;
  $effect(() => {
    if (fitted || !ws.map || !store.areas.length) return;
    fitted = true;
    const leaf = store.areas.filter((a) => !isOrg(a));
    ws.map.fit((leaf.length ? leaf : store.areas).flatMap((a) => [a.polygon, ...a.morePieces]));
  });
</script>

<div class="head">
  <div class="title">
    <h2>Areas <span class="muted num">{store.areas.length}</span></h2>
    {#if store.canEditAreas}
      <button class="primary sm" onclick={() => router.go("/map/new")}><Icon name="plus" size={15} /> New area</button>
    {/if}
  </div>
  <label class="search">
    <Icon name="search" size={16} />
    <input type="search" placeholder="Find an area" bind:value={query} />
  </label>
  <div class="chips" role="group" aria-label="Show">
    {#each [["all", "All"], ["going", "In progress"], ["none", "Not started"], ["done", "Done"]] as [f, label]}
      <button class="chip" aria-pressed={filter === f} onclick={() => (filter = f as Filter)}>
        {label} <span class="num">{counts[f as Filter]}</span>
      </button>
    {/each}
  </div>
</div>

<ul class="tree scroll">
  {#each rows as { node, context, hasKids } (node.area.id + ":" + (node.under?.id ?? 0))}
    {@const a = node.area}
    {@const p = store.progress[a.name]}
    {@const org = isOrg(a)}
    {@const also = node.under ? [a.parentName, ...a.alsoIn].filter((n) => n && n.toLowerCase() !== node.under!.name.toLowerCase()) : []}
    <li class:context style:--depth={node.depth}
      onmouseenter={() => (ws.hover = a.id)} onmouseleave={() => (ws.hover = null)}>
      <button class="fold ghost" class:none={!hasKids} onclick={() => toggle(a.id)}
        aria-label={folded[a.id] ? "Show what is inside" : "Hide what is inside"}>
        <span style:transform={folded[a.id] && !filtering ? "rotate(-90deg)" : ""}><Icon name="down" size={14} /></span>
      </button>
      <button class="row" onclick={() => router.go(`/map/area/${a.id}`)}>
        <span class="dot" style:background={a.color || LEVEL_COLOR[a.level]}></span>
        <span class="name">
          <b>{a.name}</b>
          <small class="muted">{LEVEL_LABEL[a.level]}{also.length ? " · also in " + also.join(", ") : ""}</small>
        </span>
        {#if org}
          <span class="org">Grouping</span>
        {:else if p && p.total}
          <span class="pc num">
            <span class="bar"><i style:width={pct(p.done, p.total) + "%"}></i></span>
            {pct(p.done, p.total)}%
          </span>
        {:else}
          <span class="muted small">counting…</span>
        {/if}
      </button>
    </li>
  {:else}
    <li class="empty muted">{store.areas.length ? "Nothing matches." : "No areas yet."}</li>
  {/each}
</ul>

<style>
  .head { padding: 16px 16px 10px; display: grid; gap: 10px; border-bottom: 1px solid var(--line); }
  .title { display: flex; align-items: center; justify-content: space-between; }
  .search { position: relative; display: block; }
  .search :global(svg) { position: absolute; left: 10px; top: 9px; color: var(--ink-soft); }
  .search input { padding-left: 32px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips .num { opacity: 0.7; }
  .tree { list-style: none; margin: 0; padding: 6px 8px 24px; flex: 1; }
  li { display: flex; align-items: center; padding-left: calc(var(--depth) * 18px); }
  li.context { opacity: 0.55; }
  .fold { width: 24px; min-height: 30px; padding: 0; border: 0; color: var(--ink-soft); flex: none; }
  .fold.none { visibility: hidden; }
  .fold span { display: inline-flex; transition: transform 0.12s; }
  .row {
    flex: 1; min-width: 0; justify-content: flex-start; gap: 10px; min-height: 46px; padding: 6px 8px;
    border: 0; background: transparent; text-align: left; border-radius: 8px;
  }
  .row:hover { background: var(--surface-2); }
  .name { display: grid; min-width: 0; flex: 1; }
  .name b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .name small { font-size: 11.5px; font-weight: 450; overflow: hidden; text-overflow: ellipsis; }
  .pc { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; width: 92px; justify-content: flex-end; }
  .pc .bar { width: 48px; }
  .org { font-size: 11px; font-weight: 600; color: var(--ink-soft); border: 1px solid var(--line-strong); border-radius: 99px; padding: 1px 8px; }
  .small { font-size: 12px; }
  .empty { padding: 20px 12px; }
</style>
