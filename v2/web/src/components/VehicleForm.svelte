<script lang="ts">
  // The editable details of a vehicle, shared by "Add vehicle" and the vehicle's page.
  import { VEHICLE_KINDS, type VehicleFormValue } from "../lib/types";

  let { value = $bindable(), shared = true }: { value: VehicleFormValue; shared?: boolean } = $props();
</script>

<div class="grid">
  <label class="field wide">Name <span class="help">What people call it: "Van 3", "Mum's car".</span>
    <input type="text" bind:value={value.name} maxlength="60" required /></label>
  <label class="field">Type
    <select bind:value={value.kind}>{#each VEHICLE_KINDS as k}<option value={k.key}>{k.label}</option>{/each}</select></label>
  <label class="field">Year <input type="number" bind:value={value.year} min="1900" max="2100" placeholder="2022" /></label>
  <label class="field">Make <input type="text" bind:value={value.make} maxlength="40" placeholder="Ford" /></label>
  <label class="field">Model <input type="text" bind:value={value.model} maxlength="40" placeholder="Transit" /></label>
  <label class="field">Colour <input type="text" bind:value={value.color} maxlength="30" placeholder="White" /></label>
  <label class="field">Plate <input type="text" bind:value={value.plate} maxlength="20" /></label>
  {#if shared}
    <label class="field wide">Who can take it out
      <select bind:value={value.checkout_policy}>
        <option value="open">Any driver in the team can check it out</option>
        <option value="admin_only">Only team admins hand it out</option>
      </select>
    </label>
  {/if}
</div>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .wide { grid-column: 1 / -1; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
</style>
