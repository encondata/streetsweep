<script lang="ts">
  // The vehicle's own photo, else the ChatGPT art for its kind (docs/ASSETS.md), else an icon.
  import Icon from "./Icon.svelte";
  import type { VehicleKind } from "../lib/types";

  let { photo = null, kind, height = 120, round = 12 }:
    { photo?: string | null; kind: VehicleKind; height?: number; round?: number } = $props();

  let photoBroken = $state(false);
  let artBroken = $state(false);
  let art = $derived(kind === "other" ? null : `/vehicle-${kind}.png`);
</script>

<div class="vimg" style:height="{height}px" style:border-radius="{round}px">
  {#if photo && !photoBroken}
    <img class="photo" src={photo} alt="" onerror={() => (photoBroken = true)} />
  {:else if art && !artBroken}
    <img class="art" src={art} alt="" onerror={() => (artBroken = true)} />
  {:else}
    <span class="icon"><Icon name="fleet" size={Math.round(height * 0.4)} /></span>
  {/if}
</div>

<style>
  .vimg { width: 100%; overflow: hidden; background: linear-gradient(160deg, #eef6ee, #e6eef6); display: grid; place-items: center; flex: none; }
  .photo { width: 100%; height: 100%; object-fit: cover; }
  .art { height: 86%; width: auto; max-width: 92%; object-fit: contain; }
  .icon { color: #8fa3b8; display: grid; }
</style>
