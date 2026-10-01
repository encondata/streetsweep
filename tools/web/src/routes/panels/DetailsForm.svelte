<script lang="ts" module>
  import type { Level } from "../../lib/types";
  export interface Details {
    name: string; level: Level; parents: string[]; city: string; notes: string; color: string;
  }
</script>

<script lang="ts">
  import { store } from "../../lib/store.svelte";
  import { LEVEL_ORDER, LEVEL_LABEL, LEVEL_COLOR, levelRank, abc, ORGANIZATIONAL } from "../../lib/levels";

  let { value, selfId = null, saving = false, submitLabel = "Save", onsubmit, oncancel }: {
    value: Details; selfId?: number | null; saving?: boolean; submitLabel?: string;
    onsubmit: (d: Details) => void; oncancel: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let d = $state<Details>({ ...value, parents: [...value.parents] });
  let find = $state("");

  // The classic site's palette, so a colour chosen there is the same one here.
  const PALETTE: [string, string][] = [
    ["#2f6fb5", "Blue"], ["#1c9fd6", "Sky"], ["#0f9b8e", "Teal"], ["#1e8a28", "Green"], ["#6aa621", "Olive"],
    ["#d9a520", "Amber"], ["#e2721f", "Orange"], ["#d4452f", "Vermilion"], ["#c2344b", "Crimson"], ["#d4459b", "Pink"],
    ["#a855c7", "Purple"], ["#5b5bd6", "Indigo"], ["#8a5a2b", "Brown"], ["#5b7285", "Slate"],
  ];
  // A colour from anywhere else is kept, and offered as it is.
  // svelte-ignore state_referenced_locally
  const SWATCHES: [string, string][] = [["", "By level"], ...PALETTE,
    ...(value.color && !PALETTE.some(([c]) => c.toLowerCase() === value.color.toLowerCase()) ? [[value.color, "Current"] as [string, string]] : [])];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  // Only something bigger can hold it: a neighbourhood in a city, a city in a county.
  const bigger = $derived(
    store.areas.filter((a) => a.id !== selfId && levelRank(a.level) > levelRank(d.level))
      .sort((x, y) => abc(x.name, y.name)),
  );
  const shownParents = $derived(
    bigger.filter((a) => !find.trim() || a.name.toLowerCase().includes(find.trim().toLowerCase()) || isParent(a.name)),
  );
  const isParent = (n: string) => d.parents.some((p) => p.toLowerCase() === n.toLowerCase());
  function toggleParent(n: string) {
    // In the order ticked: the first is the one phones list it under.
    d.parents = isParent(n) ? d.parents.filter((p) => p.toLowerCase() !== n.toLowerCase()) : [...d.parents, n];
  }
  // A level change can leave a parent that is no longer bigger.
  $effect(() => {
    const ok = new Set(bigger.map((a) => a.name.toLowerCase()));
    const keep = d.parents.filter((p) => ok.has(p.toLowerCase()) || !store.byName(p));
    if (keep.length !== d.parents.length) d.parents = keep;
  });

  const clash = $derived(store.areas.some((a) => a.id !== selfId && a.name.trim().toLowerCase() === d.name.trim().toLowerCase()));
  const valid = $derived(d.name.trim().length > 0 && !clash);
  const levels = $derived(LEVEL_ORDER.slice().sort((x, y) => abc(LEVEL_LABEL[x], LEVEL_LABEL[y])));

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (valid && !saving) onsubmit({ ...d, name: d.name.trim(), city: d.city.trim(), notes: d.notes.trim() });
  }
</script>

<form class="form" onsubmit={submit}>
  <label class="field">
    <span>Name</span>
    <input type="text" bind:value={d.name} placeholder="April Sound" required />
    {#if clash}<small class="bad">Another area already has this name. Phones tell areas apart by name.</small>{/if}
  </label>

  <label class="field">
    <span>Level</span>
    <select bind:value={d.level}>
      {#each levels as l}<option value={l}>{LEVEL_LABEL[l]}</option>{/each}
    </select>
    {#if ORGANIZATIONAL.has(d.level)}
      <small class="muted">Groups the areas inside it. Nothing is downloaded or counted for it.</small>
    {/if}
  </label>

  <div class="field">
    <span>Part of</span>
    {#if bigger.length > 8}
      <input type="search" placeholder="Find a bigger area" bind:value={find} />
    {/if}
    <div class="picks">
      {#each shownParents as a}
        <label class="pick">
          <input type="checkbox" checked={isParent(a.name)} onchange={() => toggleParent(a.name)} />
          <span class="dot" style:background={a.color || LEVEL_COLOR[a.level]}></span>
          <span class="nm">{a.name}</span>
          <small class="muted">{LEVEL_LABEL[a.level]}</small>
        </label>
      {:else}
        <p class="muted small">{bigger.length ? "Nothing matches." : "Nothing bigger than this yet."}</p>
      {/each}
    </div>
    <small class="muted">
      {d.parents.length > 1 ? `Shown under each. Phones list it under ${d.parents[0]}, the first ticked.`
        : "Tick more than one if it crosses a boundary, such as a city in two counties."}
    </small>
  </div>

  <label class="field">
    <span>City</span>
    <input type="text" bind:value={d.city} placeholder="Conroe, TX" />
  </label>

  <label class="field">
    <span>Notes</span>
    <textarea bind:value={d.notes} placeholder="Primary neighborhood. West side."></textarea>
  </label>

  <div class="field">
    <span>Color</span>
    <div class="swatches">
      {#each SWATCHES as [c, name]}
        <button type="button" class="sw" class:on={same(d.color, c)} aria-label={name} title={name} aria-pressed={same(d.color, c)}
          style:background={c || LEVEL_COLOR[d.level]} onclick={() => (d.color = c)}>
          {#if !c}<span>A</span>{/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="actions">
    <button type="button" onclick={oncancel}>Cancel</button>
    <button type="submit" class="primary" disabled={!valid || saving}>{saving ? "Saving…" : submitLabel}</button>
  </div>
</form>

<style>
  .form { display: grid; gap: 16px; }
  .field { display: grid; gap: 6px; }
  .field > span { font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .picks {
    max-height: 220px; overflow-y: auto; border: 1px solid var(--line-strong); border-radius: var(--r-sm);
    padding: 4px 10px; display: grid;
  }
  .pick { display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer; }
  .pick .nm { flex: 1; }
  .small { font-size: 12px; }
  small { font-size: 12px; }
  .bad { color: var(--danger); }
  .swatches { display: flex; flex-wrap: wrap; gap: 8px; }
  .sw { width: 28px; height: 28px; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--line-strong); }
  .sw.on { box-shadow: 0 0 0 2px var(--ink); }
  .sw span { color: #fff; font-size: 11px; font-weight: 700; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; position: sticky; bottom: 0; background: var(--surface); padding: 10px 0 4px; border-top: 1px solid var(--line); }
</style>
