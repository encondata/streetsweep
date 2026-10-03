<script lang="ts">
  import type { Snippet } from "svelte";
  // `art` names a slot from docs/ASSETS.md; until the picture exists it simply isn't shown.
  let { art, title, children }: { art?: string; title: string; children?: Snippet } = $props();
  let missing = $state(false);
</script>

<div class="empty">
  {#if art && !missing}
    <img src="/{art}" alt="" onerror={() => (missing = true)} />
  {/if}
  <h3>{title}</h3>
  {#if children}<div class="muted">{@render children()}</div>{/if}
</div>

<style>
  .empty { display: grid; justify-items: center; text-align: center; gap: 8px; padding: 28px 16px; }
  img { width: min(280px, 70%); height: auto; margin-bottom: 6px; }
</style>
