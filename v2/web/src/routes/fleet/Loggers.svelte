<script lang="ts">
  import EmptyState from "../../components/EmptyState.svelte";
  import Icon from "../../components/Icon.svelte";
  import Modal from "../../components/Modal.svelte";
  import SetupModal from "../../components/SetupModal.svelte";
  import { api, errorText } from "../../lib/api";
  import { ago } from "../../lib/format";
  import type { DriveType, Logger, LoggerDetail, LoggerSetup } from "../../lib/types";

  let loggers = $state<Logger[] | null>(null);
  let types = $state<DriveType[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let adding = $state(false);
  let name = $state("");
  let type = $state("personal");

  let setup = $state<LoggerSetup | null>(null);
  let setupName = $state("");
  let setupOpen = $state(false);

  async function load() {
    try {
      [loggers, types] = await Promise.all([
        api<{ loggers: Logger[] }>("/api/loggers").then((r) => r.loggers),
        api<{ drive_types: DriveType[] }>("/api/drive-types").then((r) => r.drive_types.filter((t) => !t.archived_at)),
      ]);
    } catch (e) {
      error = errorText(e);
    }
  }
  load();

  async function register() {
    busy = true;
    error = null;
    try {
      const d = await api<LoggerDetail>("/api/loggers", { body: { name: name.trim(), default_drive_type_key: type } });
      adding = false;
      setup = d.setup!;
      setupName = d.logger.name;
      setupOpen = true;
      name = "";
      await load();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  const volts = (mv: number | null) => (mv ? `${(mv / 1000).toFixed(2)} V` : null);
</script>

<div class="bar">
  <p class="muted">GPS loggers you've built. Each one gets its own key, and its drives are credited to the vehicle it's installed in.</p>
  <button class="primary" onclick={() => { adding = true; type = "personal"; }}><Icon name="plus" size={18} /> Register a logger</button>
</div>

{#if error}<p class="notice error">{error}</p>{/if}

{#if loggers}
  <div class="card list">
    {#each loggers as l (l.id)}
      <a class="row item" href="/fleet/loggers/{l.id}" class:retired={l.revoked_at}>
        <span class="lg"><Icon name="logger" /></span>
        <div class="grow">
          <strong>{l.name}</strong>
          <div class="muted small ellipsis">
            {#if l.revoked_at}Retired {ago(l.revoked_at)}
            {:else if l.installed}In {l.installed.vehicle_name}
            {:else}Not in a vehicle{/if}
            · {l.default_drive_type_label} drives
          </div>
        </div>
        <div class="meta small muted">
          {#if !l.last_seen_at}<span class="badge warn">Never checked in</span>
          {:else}seen {ago(l.last_seen_at)}{#if volts(l.last_battery_mv)} · {volts(l.last_battery_mv)}{/if}{/if}
        </div>
      </a>
    {:else}
      <EmptyState art="empty-loggers.png" title="No loggers yet">
        Built an ESP32 GPS logger? Register it here to get its key, then install it in a vehicle.
      </EmptyState>
    {/each}
  </div>
{/if}

<Modal bind:open={adding} title="Register a logger">
  <form id="new-logger" class="stack" onsubmit={(e) => { e.preventDefault(); register(); }}>
    <label class="field">Name <input type="text" bind:value={name} maxlength="60" placeholder="e.g. Van 1 logger" required /></label>
    <label class="field">Drive type for its drives
      <span class="help">A logger can't ask, so its drives get this type. You can change a drive's type afterwards.</span>
      <select bind:value={type}>{#each types as t (t.key)}<option value={t.key}>{t.label}</option>{/each}</select>
    </label>
    <p class="muted small">Next you'll get its ID and secret key to flash onto the board.</p>
  </form>
  {#snippet footer()}
    <button class="ghost" onclick={() => (adding = false)}>Cancel</button>
    <button class="primary" type="submit" form="new-logger" disabled={busy || !name.trim()}>Register</button>
  {/snippet}
</Modal>

<SetupModal bind:open={setupOpen} {setup} name={setupName} />

<style>
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .item { color: inherit; }
  .item:hover { background: var(--surface-2); text-decoration: none; }
  .retired { opacity: .6; }
  .lg { width: 40px; height: 40px; border-radius: 10px; background: var(--accent-soft); color: var(--green-600); display: grid; place-items: center; flex: none; }
  .meta { text-align: right; white-space: nowrap; }
</style>
