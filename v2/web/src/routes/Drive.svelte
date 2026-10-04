<script lang="ts">
  // One drive: where it went (GPS track over the streets it was matched to), who drove
  // what, which teams it counts for, and fixing any of that.
  import { onMount } from "svelte";
  import Avatar from "../components/Avatar.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { ago, duration, miles, span } from "../lib/format";
  import { MapController, DRIVEN_COLOR, TRACK_COLOR } from "../lib/map";
  import type { DriveDetail, DriveType, PersonRef, Role, Vehicle, VehicleDetail } from "../lib/types";

  let { id }: { id: string } = $props();

  let d = $state<DriveDetail | null>(null);
  let error = $state<string | null>(null);
  let flash = $state<string | null>(null);
  let busy = $state(false);

  let types = $state<DriveType[]>([]);
  let vehicles = $state<Vehicle[]>([]);
  let drivers = $state<(PersonRef & { role: Role })[]>([]);
  let form = $state({ drive_type: "", vehicle_id: "", user_id: "" });

  let box = $state<HTMLDivElement>();
  let ctl: MapController | null = null;
  let me = $derived(session.me!.user);
  let drive = $derived(d?.drive);

  const canDrive = (r: Role | null) => r === "owner" || r === "admin" || r === "driver";

  async function load() {
    try {
      d = await api<DriveDetail>(`/api/drives/${id}`);
      form = { drive_type: d.drive.drive_type_key, vehicle_id: d.drive.vehicle_id ?? "", user_id: d.drive.user_id ?? "" };
      ctl?.setDrive(d.track, d.streets);
    } catch (e) {
      error = errorText(e);
    }
  }

  onMount(() => {
    load().then(() => {
      if (!d?.can_edit) return;
      api<{ drive_types: DriveType[] }>("/api/drive-types").then((r) => (types = r.drive_types.filter((t) => !t.archived_at || t.key === d!.drive.drive_type_key)));
      api<{ vehicles: Vehicle[] }>("/api/vehicles").then((r) => (vehicles = r.vehicles.filter((v) => canDrive(v.my_role) || v.id === d!.drive.vehicle_id)));
    });
    return () => ctl?.destroy();
  });

  // The map, once its box is on the page.
  $effect(() => {
    if (!box || ctl) return;
    ctl = new MapController(box);
    ctl.watchSize(box);
    ctl.showStreets(false);
    if (d) ctl.setDrive(d.track, d.streets);
  });

  // Who could have driven it: the drivers of the chosen vehicle's team.
  $effect(() => {
    const vid = form.vehicle_id;
    if (!d?.can_set_driver || !vid) {
      drivers = [];
      return;
    }
    api<VehicleDetail>(`/api/vehicles/${vid}`).then((r) => (drivers = r.drivers), () => (drivers = []));
  });

  // Still matching: check back.
  $effect(() => {
    if (!drive || (drive.status !== "received" && drive.status !== "matching")) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  });

  let changed = $derived(!!drive && (
    form.drive_type !== drive.drive_type_key || form.vehicle_id !== (drive.vehicle_id ?? "") || form.user_id !== (drive.user_id ?? "")));

  async function act(fn: () => Promise<unknown>, done: string) {
    busy = true;
    error = flash = null;
    try {
      await fn();
      await load();
      flash = done;
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  function save() {
    const body: Record<string, string | null> = {};
    if (form.drive_type !== drive!.drive_type_key) body.drive_type = form.drive_type;
    if (form.vehicle_id !== (drive!.vehicle_id ?? "")) body.vehicle_id = form.vehicle_id || null;
    if (d!.can_set_driver && form.user_id !== (drive!.user_id ?? "")) body.user_id = form.user_id || null;
    act(() => api(`/api/drives/${id}`, { method: "PATCH", body }), "Saved. Team coverage is being recounted.");
  }

  const rematch = () => act(() => api(`/api/drives/${id}/rematch`, { body: {} }), "Matching it again.");

  async function remove() {
    if (!confirm("Delete this drive? Its streets come off every team's coverage. This can't be undone.")) return;
    busy = true;
    try {
      await api(`/api/drives/${id}`, { method: "DELETE" });
      router.go("/drives");
    } catch (e) {
      error = errorText(e);
      busy = false;
    }
  }

  const WHO: Record<string, string> = {
    explicit: "picked on the phone",
    inferred: "worked out from who had the vehicle",
    unknown: "nobody had the vehicle checked out",
    edited: "set by hand",
  };
</script>

<div class="page">
  <a class="back muted" href="/drives"><Icon name="back" size={16} /> Drives</a>

  {#if error}<p class="notice error">{error}</p>{/if}
  {#if flash}<p class="notice">{flash}</p>{/if}

  {#if d && drive}
    <div class="page-head">
      <div>
        <h1>{miles(drive.distance_m)} {drive.drive_type_label.toLowerCase()} drive</h1>
        <p class="muted">{span(drive.started_at, drive.ended_at)} · {duration(drive.started_at, drive.ended_at)}</p>
      </div>
    </div>

    <div class="card mapcard">
      <div class="map" bind:this={box}></div>
      <div class="legend small">
        <span><i style:background={TRACK_COLOR}></i>GPS track</span>
        <span><i style:background={DRIVEN_COLOR}></i>Streets it counted</span>
      </div>
    </div>

    {#if drive.status === "failed"}
      <p class="notice error">Couldn't match this drive to streets{drive.match_error ? `: ${drive.match_error}` : ""}.
        {#if d.can_edit}<button class="sm" disabled={busy} onclick={rematch}>Try again</button>{/if}</p>
    {:else if drive.status !== "matched"}
      <p class="notice">Matching it to streets… this usually takes a few seconds.</p>
    {/if}

    <div class="facts">
      <div class="card"><span class="muted small">Distance</span><strong>{miles(drive.distance_m)}</strong></div>
      <div class="card"><span class="muted small">Time</span><strong>{duration(drive.started_at, drive.ended_at)}</strong></div>
      <div class="card"><span class="muted small">Street segments</span><strong>{drive.segment_count ?? "—"}</strong></div>
      <div class="card"><span class="muted small">GPS fixes</span><strong>{drive.point_count.toLocaleString()}</strong></div>
    </div>

    <section class="card pad stack">
      <h2>Who and what</h2>
      <div class="list bordered">
        <div class="row">
          {#if drive.user_id}<Avatar id={drive.user_id} name={drive.user_name ?? ""} url={drive.user_avatar_url} />{:else}<span class="ico"><Icon name="teams" /></span>{/if}
          <div class="grow">
            <strong>{drive.user_id === me.id ? "You" : drive.user_name ?? "Driver unknown"}</strong>
            <div class="muted small">Driver · {WHO[drive.attribution]}</div>
          </div>
        </div>
        <div class="row">
          <span class="ico"><Icon name="fleet" /></span>
          <div class="grow">
            {#if drive.vehicle_id}<a href="/fleet/vehicles/{drive.vehicle_id}"><strong>{drive.vehicle_name}</strong></a>{:else}<strong>No vehicle</strong>{/if}
            <div class="muted small">Vehicle</div>
          </div>
        </div>
        <div class="row">
          <span class="ico"><Icon name={drive.source === "logger" ? "logger" : "phone"} /></span>
          <div class="grow">
            <strong>{drive.source === "logger" ? drive.logger_name ?? "A logger" : "Phone"}</strong>
            <div class="muted small">Recorded by · uploaded {ago(drive.created_at)}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="card pad stack">
      <div>
        <h2>Counts for</h2>
        <p class="muted small">A drive counts for each team the driver was in at the time, if that team counts {drive.drive_type_label.toLowerCase()} drives. With no known driver, it counts for the team that manages the vehicle.</p>
      </div>
      {#if d.counts_for.length}
        <div class="chips">
          {#each d.counts_for as t (t.id)}<a class="badge green" href="/teams/{t.id}">{t.kind === "personal" ? "You" : t.name}</a>{/each}
        </div>
      {:else}
        <p class="muted">No team. Check the drive type is one your teams count, under each team's settings.</p>
      {/if}
    </section>

    {#if d.can_edit}
      <section class="card pad stack">
        <div>
          <h2>Fix it</h2>
          <p class="muted small">Wrong type or vehicle? Changing it recounts every team it affects.
            {#if d.can_set_driver}As an admin of the vehicle's team (or the logger's owner), you can also say who drove.{/if}</p>
        </div>
        <form class="grid" onsubmit={(e) => { e.preventDefault(); save(); }}>
          <label class="field">Drive type
            <select bind:value={form.drive_type}>
              {#each types as t (t.key)}<option value={t.key}>{t.label}</option>{/each}
            </select>
          </label>
          <label class="field">Vehicle
            <select bind:value={form.vehicle_id}>
              <option value="">No vehicle</option>
              {#each vehicles as v (v.id)}<option value={v.id}>{v.name}{v.team_kind === "shared" ? ` (${v.team_name})` : ""}</option>{/each}
            </select>
          </label>
          {#if d.can_set_driver}
            <label class="field">Driver
              <select bind:value={form.user_id}>
                <option value="">Don't know</option>
                {#each drivers as p (p.user_id)}<option value={p.user_id}>{p.user_id === me.id ? "Me" : p.display_name}</option>{/each}
                {#if drive.user_id && !drivers.some((p) => p.user_id === drive.user_id)}<option value={drive.user_id}>{drive.user_name}</option>{/if}
              </select>
            </label>
          {/if}
          <div class="btns">
            <button type="button" class="ghost danger" disabled={busy} onclick={remove}>Delete drive</button>
            {#if drive.status === "matched"}<button type="button" class="ghost" disabled={busy} onclick={rematch}>Match again</button>{/if}
            <button type="submit" class="primary" disabled={busy || !changed}>Save</button>
          </div>
        </form>
      </section>
    {/if}
  {/if}
</div>

<style>
  .back { display: inline-flex; align-items: center; gap: 4px; }
  .mapcard { overflow: hidden; position: relative; }
  .map { height: 380px; }
  .legend {
    position: absolute; top: 10px; left: 10px; display: flex; gap: 12px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 99px; padding: 5px 12px; box-shadow: var(--shadow);
  }
  .legend span { display: flex; align-items: center; gap: 5px; }
  .legend i { width: 14px; height: 4px; border-radius: 2px; display: block; }
  .facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .facts .card { display: grid; gap: 2px; padding: 12px 14px; }
  .facts strong { font-size: 18px; }
  .ico { width: 40px; height: 40px; border-radius: 50%; background: var(--surface-2); color: var(--ink-soft); display: grid; place-items: center; flex: none; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chips a:hover { text-decoration: none; filter: brightness(.97); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; align-items: end; }
  .btns { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .btns .danger { margin-right: auto; color: var(--danger); }
  .notice .sm { margin-left: 8px; }
  @media (max-width: 760px) {
    .facts { grid-template-columns: repeat(2, 1fr); }
    .map { height: 300px; }
  }
</style>
