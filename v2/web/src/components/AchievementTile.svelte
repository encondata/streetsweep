<script lang="ts">
  // One achievement: a badge, or a ladder showing the level reached. Unearned ones are
  // greyed, with how far along they are. Art is public/ach-<art>.webp; team badges whose
  // art hasn't been made yet fall back to their tier's medal.
  import { date } from "../lib/format";
  import { TIER_LABEL, type Badge, type Ladder, type Tier } from "../lib/types";

  let { item, compact = false }: { item: Badge | Ladder; compact?: boolean } = $props();

  let step = $derived(item.kind === "ladder" ? item.steps[Math.max(0, item.level - 1)] : null);
  let earned = $derived(item.kind === "ladder" ? item.level > 0 : item.earned);
  let art = $derived(item.kind === "ladder" ? step!.art : item.art);
  let tier = $derived<Tier>(item.kind === "ladder" ? step!.tier : item.tier);
  let name = $derived(item.kind === "ladder" && item.level > 0 ? step!.name : item.name);
  let when = $derived(item.earned_at);
  let fallback = $state(false);

  let progress = $derived.by(() => {
    if (item.kind === "ladder") {
      if (!item.next) return null;
      return { pct: item.progress, text: `${item.value.toLocaleString()} of ${item.next.toLocaleString()} ${item.unit}` };
    }
    if (item.earned || !item.progress) return null;
    return { pct: Math.min(100, (item.progress.value / item.progress.need) * 100), text: `${item.progress.value.toLocaleString()} of ${item.progress.need.toLocaleString()}` };
  });
</script>

<div class="tile" class:earned class:compact>
  <img src={fallback ? `/ach-tier_${tier}.webp` : `/ach-${art}.webp`} alt="" width="64" height="64" loading="lazy"
    onerror={() => { if (!fallback) fallback = true; }} />
  <div class="body">
    <div class="head">
      <strong>{name}</strong>
      {#if item.kind === "ladder"}<span class="lvl">{item.level ? `Level ${item.level} of ${item.top}` : item.name}</span>{/if}
    </div>
    {#if !compact}<p class="small muted">{item.blurb}</p>{/if}
    {#if progress}
      <span class="bar" title={progress.text}><span style:width="{progress.pct}%"></span></span>
      <span class="small muted">{progress.text}</span>
    {:else if earned && when}
      <span class="small muted">{TIER_LABEL[tier]} · {date(when)}{item.kind === "badge" && item.rarity ? ` · ${item.rarity}% have it` : ""}</span>
    {:else if !earned}
      <span class="small muted">{TIER_LABEL[tier]}</span>
    {/if}
  </div>
</div>

<style>
  .tile { display: flex; gap: 12px; align-items: flex-start; padding: 12px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); }
  .tile.compact { padding: 10px; }
  img { width: 64px; height: 64px; flex: none; border-radius: 12px; object-fit: contain; filter: grayscale(1); opacity: .45; }
  .tile.compact img { width: 48px; height: 48px; }
  .earned img { filter: none; opacity: 1; }
  .body { display: grid; gap: 3px; min-width: 0; flex: 1; }
  .head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .lvl { font-size: 11.5px; font-weight: 700; color: var(--green-700); }
  p { margin: 0; }
  .bar { display: block; height: 6px; border-radius: 99px; background: var(--line); overflow: hidden; margin-top: 2px; }
  .bar > span { display: block; height: 100%; background: var(--green-600); border-radius: 99px; min-width: 3px; }
</style>
