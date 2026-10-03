<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import SetupModal from "../components/SetupModal.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { ago, date, span } from "../lib/format";
  import { formValues } from "../lib/forms";
  import type { DriveType, LoggerDetail, LoggerSetup, Vehicle } from "../lib/types";

  let { id }: { id: string } = $props();

  let d = $state<LoggerDetail | null>(null);
  let vehicles = $state<Vehicle[]>([]);
  let types = $state<DriveType[]>([]);
  let error = $state<string | null>(null);
  let flash = $state<string | null>(null);
  let busy = $state(false);

  let name = $state("");
  let type = $state("");
  let target = $state("");

  let setup = $state<LoggerSetup | null>(null);
  let setupOpen = $state(false);

  let l = $derived(d?.logger);
  // Vehicles you could put it in: ones your teams let you drive.
  let installable = $derived(vehicles.filter((v) => ["owner", "admin", "driver"].includes(v.my_role ?? "") && v.id !== l?.installed?.vehicle_id));

  function apply(next: LoggerDetail) {
    d = next;
    name = next.logger.name;
    type = next.logger.default_drive_type_key;
    if (next.setup) {
      setup = next.setup;
      setupOpen = true;
    }
  }

  Promise.all([
    api<LoggerDetail>(`/api/loggers/${id}`),
    api<{ vehicles: Vehicle[] }>("/api/vehicles"),
    api<{ drive_types: DriveType[] }>("/api/drive-types"),
  ]).then(([ld, vs, ts]) => {
    apply(ld);
    vehicles = vs.vehicles;
    types = ts.drive_types.filter((t) => !t.archived_at || t.key === ld.logger.default_drive_type_key);
  }, (e) => (error = errorText(e)));

  async function act(fn: () => Promise<LoggerDetail>, done?: string) {
    busy = true;
    error = flash = null;
    try {
      apply(await fn());
      if (done) flash = done;
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  const save = () => act(() => api(`/api/loggers/${id}`, { method: "PATCH", body: { name: name.trim(), default_drive_type_key: type } }), "Saved.");
  const install = () => act(() => api(`/api/loggers/${id}/install`, { body: { vehicle_id: target } }), "Installed.").then(() => (target = ""));

  async function uninstall() {
    if (!confirm(`Take ${l!.name} out of ${l!.installed!.vehicle_name}?`)) return;
    await act(() => api(`/api/loggers/${id}/uninstall`, { body: {} }), "Taken out.");
  }
  async function rotate() {
    if (!confirm("Make a new key? The board stops working until you flash the new one.")) return;
    await act(() => api(`/api/loggers/${id}/rotate-key`, { body: {} }));
  }
  async function retire() {
    if (!confirm(`Retire ${l!.name}? It can't check in again. Its past drives stay.`)) return;
    await act(() => api(`/api/loggers/${id}`, { method: "DELETE" }), "Retired.");
  }
</script>

<div class="page">
  <a class="back muted" href="/fleet/loggers"><Icon name="back" size={16} /> Loggers</a>
  {#if error}<p class="notice error">{error}</p>{/if}
  {#if flash}<p class="notice">{flash}</p>{/if}

  {#if d && l}
    <div class="head">
      <span class="lg"><Icon name="logger" size={28} /></span>
      <div class="grow">
        <h1>{l.name}</h1>
        <p class="muted">Registered {date(l.created_at)}{l.revoked_at ? ` · retired ${ago(l.revoked_at)}` : ""}</p>
      </div>
      {#if l.revoked_at}<span class="badge">Retired</span>{:else if !l.last_seen_at}<span class="badge warn">Never checked in</span>{/if}
    </div>

    <section class="card pad">
      <div class="facts">
        <div><span class="muted small">Last check-in</span><strong>{l.last_seen_at ? ago(l.last_seen_at) : "Never"}</strong></div>
        <div><span class="muted small">Battery</span><strong>{l.last_battery_mv ? `${(l.last_battery_mv / 1000).toFixed(2)} V` : "—"}</strong></div>
        <div><span class="muted small">Firmware</span><strong>{l.firmware_version ?? "—"}</strong></div>
        <div><span class="muted small">Hardware</span><strong class="mono">{l.hardware_id ?? "—"}</strong></div>
        <div><span class="muted small">Logger ID</span><strong class="mono small">{l.id}</strong></div>
      </div>
    </section>

    <section class="card pad stack">
      <h2>Vehicle</h2>
      {#if l.installed}
        <div class="inl">
          <p class="grow">In <a href="/fleet/vehicles/{l.installed.vehicle_id}"><strong>{l.installed.vehicle_name}</strong></a>
            <span class="muted">({l.installed.team_name}) since {date(l.installed.since)}</span></p>
          {#if !l.revoked_at}<button disabled={busy} onclick={uninstall}>Take out</button>{/if}
        </div>
      {:else}
        <p class="muted">Not in a vehicle. It keeps logging, but drives can't be credited to a car until it's installed.</p>
      {/if}
      {#if !l.revoked_at}
        {#if installable.length}
          <div class="inl">
            <select bind:value={target} aria-label="Vehicle">
              <option value="">{l.installed ? "Move to…" : "Install in…"}</option>
              {#each installable as v (v.id)}<option value={v.id}>{v.name}{v.team_kind === "shared" ? ` (${v.team_name})` : ""}</option>{/each}
            </select>
            <button class="primary" disabled={busy || !target} onclick={install}>{l.installed ? "Move" : "Install"}</button>
          </div>
        {:else if !l.installed}
          <p class="small muted">No vehicles you can drive yet. <a href="/fleet/vehicles">Add one</a>.</p>
        {/if}
      {/if}
      {#if d.history.length}
        <details class="small muted">
          <summary>Install history</summary>
          <ul>{#each d.history as h (h.id)}<li>{h.vehicle_name}: {span(h.started_at, h.ended_at)}</li>{/each}</ul>
        </details>
      {/if}
    </section>

    {#if !l.revoked_at}
      <form class="card pad stack" onsubmit={(e) => { e.preventDefault(); name = formValues(e.currentTarget).name ?? name; save(); }}>
        <h2>Settings</h2>
        <label class="field">Name <input type="text" name="name" bind:value={name} maxlength="60" autocomplete="off" required /></label>
        <label class="field">Drive type for its drives
          <select bind:value={type}>{#each types as t (t.key)}<option value={t.key}>{t.label}</option>{/each}</select>
        </label>
        <div><button type="submit" disabled={busy}>Save</button></div>
      </form>

      <section class="card pad stack">
        <h2>Key</h2>
        <p class="muted">Lost the secret, or think someone has it? Make a new one and reflash the board. The old one stops working at once.</p>
        <div><button disabled={busy} onclick={rotate}><Icon name="key" size={16} /> New key</button></div>
      </section>

      <section class="card pad stack">
        <h2>Retire</h2>
        <p class="muted">For a board that's broken or gone. It can't check in again; its history stays.</p>
        <div><button class="danger" disabled={busy} onclick={retire}>Retire {l.name}</button></div>
      </section>
    {/if}
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>

<SetupModal bind:open={setupOpen} {setup} name={l?.name ?? ""} />

<style>
  .back { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; width: fit-content; }
  .head { display: flex; align-items: center; gap: 14px; }
  .lg { width: 56px; height: 56px; border-radius: 14px; background: var(--accent-soft); color: var(--green-600); display: grid; place-items: center; flex: none; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
  .facts div { display: grid; gap: 2px; min-width: 0; }
  .facts strong { overflow-wrap: anywhere; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .inl { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .inl select { flex: 1 1 220px; width: auto; }
  details ul { margin: 6px 0 0; padding-left: 18px; }
</style>
