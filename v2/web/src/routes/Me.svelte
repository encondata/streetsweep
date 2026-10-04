<script lang="ts">
  // Your preferences. Account errands (name, email, password, picture) stay in the
  // account window; this is how the app looks and behaves for you.
  import ColorPrefs from "../components/ColorPrefs.svelte";
  import { api, errorText } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { DEFAULT_COLORS, myColors, samePair, type MapColors } from "../lib/colors";
  import type { Me } from "../lib/types";

  const clone = (c: MapColors): MapColors => ({ driven: { ...c.driven }, undriven: { ...c.undriven } });
  let colors = $state<MapColors>(clone(myColors()));
  let busy = $state(false);
  let msg = $state<{ text: string; error?: boolean } | null>(null);
  let changed = $derived(!samePair(colors, myColors()));

  async function save() {
    busy = true;
    msg = null;
    try {
      session.set(await api<Me>("/api/me/preferences", { method: "PATCH", body: { map_colors: colors } }));
      msg = { text: "Saved. Maps use your colours from now on." };
    } catch (e) {
      msg = { text: errorText(e), error: true };
    } finally {
      busy = false;
    }
  }
</script>

<div class="page">
  <div class="page-head">
    <h1>Preferences</h1>
  </div>

  {#if msg}<p class="notice" class:error={msg.error}>{msg.text}</p>{/if}

  <section class="card pad stack">
    <div>
      <h2>Street colours</h2>
      <p class="muted small">How driven and not-yet-driven streets look on your maps. Pick a set that reads well where you look most: some stand out better on satellite imagery.</p>
    </div>
    <ColorPrefs bind:value={colors} />
    <div class="btns">
      <button class="ghost" disabled={busy || samePair(colors, DEFAULT_COLORS)} onclick={() => (colors = clone(DEFAULT_COLORS))}>Back to the default</button>
      <button class="primary" disabled={busy || !changed} onclick={save}>Save</button>
    </div>
  </section>
</div>

<style>
  .btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
</style>
