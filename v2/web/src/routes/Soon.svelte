<script lang="ts">
  import type { Snippet } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  let { title, stage, art, children }: { title: string; stage?: number; art?: string; children: Snippet } = $props();
</script>

<div class="page">
  <div class="page-head"><h1>{title}</h1></div>
  <div class="card">
    <EmptyState {art} title={stage ? `Coming in stage ${stage}` : title}>{@render children()}</EmptyState>
  </div>
</div>
