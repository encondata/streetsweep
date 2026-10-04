<script lang="ts">
  // First sign-in: a short welcome that sets you up. For now one step, your street
  // colours; it's shown once, and Preferences changes them later.
  import Modal from "./Modal.svelte";
  import ColorPrefs from "./ColorPrefs.svelte";
  import { api, errorText } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { myColors, type MapColors } from "../lib/colors";
  import type { Me } from "../lib/types";

  let open = $state(true);
  let colors = $state<MapColors>({ driven: { ...myColors().driven }, undriven: { ...myColors().undriven } });
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function finish(keep: boolean) {
    busy = true;
    error = null;
    try {
      session.set(await api<Me>("/api/me/preferences", { method: "PATCH", body: keep ? { map_colors: colors, onboarded: true } : { onboarded: true } }));
      open = false;
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open title="Welcome to StreetSweep" width={720}>
  <div class="stack">
    <p>Every street you drive is matched and counted. First, pick how streets look on your maps: <strong>driven</strong> and <strong>not driven yet</strong>. You can change this any time under Preferences.</p>
    {#if error}<p class="notice error">{error}</p>{/if}
    <ColorPrefs bind:value={colors} />
  </div>
  {#snippet footer()}
    <button class="ghost" disabled={busy} onclick={() => finish(false)}>Skip for now</button>
    <button class="primary" disabled={busy} onclick={() => finish(true)}>Use these colours</button>
  {/snippet}
</Modal>
