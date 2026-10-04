<script lang="ts">
  import Avatar from "../components/Avatar.svelte";
  import Icon from "../components/Icon.svelte";
  import VehicleImage from "../components/VehicleImage.svelte";
  import VehicleForm from "../components/VehicleForm.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { ago, date, span } from "../lib/format";
  import { cropToBlob } from "../lib/image";
  import { syncFrom } from "../lib/forms";
  import { formToBody, vehicleToForm, emptyVehicleForm } from "../lib/vehicleForm";
  import { ROLE_LABEL, vehicleLine, type VehicleDetail } from "../lib/types";

  let { id }: { id: string } = $props();

  let d = $state<VehicleDetail | null>(null);
  let error = $state<string | null>(null);
  let flash = $state<string | null>(null);
  let busy = $state(false);

  let form = $state(emptyVehicleForm());
  let handTo = $state("");
  let addDriver = $state("");
  let moveTo = $state("");
  let note = $state("");
  let fileInput = $state<HTMLInputElement>();

  let me = $derived(session.me!.user);
  let v = $derived(d?.vehicle);
  let shared = $derived(v?.team_kind === "shared");
  // Teams this vehicle could move to: others you run.
  let moveTargets = $derived(session.me!.teams.filter((t) => (t.role === "owner" || t.role === "admin") && t.id !== v?.team_id));
  let others = $derived(d ? d.drivers.filter((p) => p.user_id !== me.id) : []);
  let unassigned = $derived(d ? d.drivers.filter((p) => !d!.vehicle.assigned.some((a) => a.user_id === p.user_id)) : []);
  let mayTake = $derived(!!v && !v.archived_at && !v.checkout && !!d?.can_drive && (v.checkout_policy === "open" || !!d?.can_admin));
  let mayReturn = $derived(!!v?.checkout && (v.checkout.user_id === me.id || !!d?.can_admin));

  function apply(next: VehicleDetail) {
    d = next;
    form = vehicleToForm(next.vehicle);
  }

  api<VehicleDetail>(`/api/vehicles/${id}`).then(apply, (e) => (error = errorText(e)));

  async function act(fn: () => Promise<VehicleDetail>, done?: string) {
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

  const post = (path: string, body: unknown = {}) => api<VehicleDetail>(`/api/vehicles/${id}${path}`, { body });

  const checkOut = () => act(() => post("/checkout", note.trim() ? { note: note.trim() } : {}), "Checked out to you.").then(() => (note = ""));
  const handOut = () => act(() => post("/checkout", { user_id: handTo }), "Handed out.").then(() => (handTo = ""));
  const giveBack = () => act(() => post("/return"), "Returned.");
  const assign = () => act(() => post("/assignments", { user_id: addDriver }), "Added.").then(() => (addDriver = ""));

  async function unassign(aid: string, name: string, self: boolean) {
    if (!confirm(self ? "Stop being a permanent driver of this vehicle?" : `Stop ${name} being a permanent driver?`)) return;
    await act(() => api(`/api/vehicles/${id}/assignments/${aid}`, { method: "DELETE" }));
  }

  const save = () =>
    act(() => api(`/api/vehicles/${id}`, { method: "PATCH", body: { ...formToBody(form), ...(shared ? {} : { checkout_policy: undefined }) } }), "Saved.");

  async function archive(on: boolean) {
    if (on && !confirm(`Archive ${v!.name}? Anyone holding it hands it back, and its loggers come out. Its history stays.`)) return;
    await act(() => api(`/api/vehicles/${id}`, { method: "PATCH", body: { archived: on } }), on ? "Archived." : "Back in use.");
  }

  async function move() {
    const team = moveTargets.find((t) => t.id === moveTo);
    if (!team || !confirm(`Move ${v!.name} to ${team.kind === "personal" ? "your personal vehicles" : team.name}? Anyone not driving for that team lets go of it.`)) return;
    await act(() => post("/move", { team_id: moveTo }), "Moved.");
    moveTo = "";
  }

  async function uninstall(loggerId: string) {
    if (!confirm("Take this logger out of the vehicle?")) return;
    busy = true;
    try {
      await api(`/api/loggers/${loggerId}/uninstall`, { body: {} });
      apply(await api<VehicleDetail>(`/api/vehicles/${id}`));
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    await act(async () => api<VehicleDetail>(`/api/vehicles/${id}/photo`, { method: "PUT", raw: await cropToBlob(file, 960, 540) }), "Photo updated.");
    if (fileInput) fileInput.value = "";
  }
  const removePhoto = () => act(() => api(`/api/vehicles/${id}/photo`, { method: "DELETE" }), "Photo removed.");

</script>

<div class="page">
  <a class="back muted" href="/fleet/vehicles"><Icon name="back" size={16} /> Fleet</a>

  {#if error}<p class="notice error">{error}</p>{/if}
  {#if flash}<p class="notice">{flash}</p>{/if}

  {#if d && v}
    <div class="hero card">
      <div class="pic">
        <VehicleImage photo={v.photo_url} kind={v.kind} height={190} round={0} />
        <!-- The picture is where you change it: admins of the vehicle's team only. -->
        {#if d.can_admin}
          <div class="pic-actions">
            <button class="sm" disabled={busy} onclick={() => fileInput?.click()}><Icon name="camera" size={15} /> {v.photo_url ? "Change photo" : "Add photo"}</button>
            {#if v.photo_url}<button class="sm" disabled={busy} onclick={removePhoto}>Remove</button>{/if}
            <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={(e) => pickPhoto(e.currentTarget.files?.[0])} />
          </div>
        {/if}
      </div>
      <div class="info">
        <div class="title">
          <h1>{v.name}</h1>
          {#if v.archived_at}<span class="badge">Archived</span>{/if}
        </div>
        <p class="muted">{vehicleLine(v) || "No details yet"}</p>
        <p class="small muted">
          Managed by <a href="/teams/{v.team_id}">{v.team_kind === "personal" ? "your personal team" : v.team_name}</a>
          {#if shared} · {v.checkout_policy === "open" ? "any driver can check it out" : "admins hand it out"}{/if}
          {#if v.my_role} · you're {ROLE_LABEL[v.my_role].toLowerCase()}{/if}
        </p>
      </div>
    </div>

    <!-- Right now -->
    <section class="card pad stack">
      <h2>Right now</h2>
      {#if v.archived_at}
        <p class="muted">Archived {ago(v.archived_at)}. Nobody can take it until it's brought back.</p>
      {:else if !shared && !v.checkout}
        <p class="muted">Your own car: drives in it count for you. To share it, move it to a team (household, crew) below.</p>
      {:else if v.checkout}
        <div class="who">
          <Avatar id={v.checkout.user_id} name={v.checkout.display_name} url={v.checkout.avatar_url} size={40} />
          <div class="grow">
            <strong>{v.checkout.user_id === me.id ? "You have it" : `${v.checkout.display_name} has it`}</strong>
            <div class="muted small">Checked out {ago(v.checkout.since)}{v.checkout.note ? ` · “${v.checkout.note}”` : ""}</div>
          </div>
          {#if mayReturn}<button disabled={busy} onclick={giveBack}>{v.checkout.user_id === me.id ? "Return it" : "Mark returned"}</button>{/if}
        </div>
      {:else}
        <p class="muted">
          Not checked out.
          {#if v.assigned.length}Drives in it count for its permanent driver{v.assigned.length > 1 ? "s" : ""}.{/if}
        </p>
        {#if mayTake}
          <div class="inline">
            <input type="text" bind:value={note} maxlength="200" placeholder="Note (optional), e.g. north route" />
            <button class="primary" disabled={busy} onclick={checkOut}>Check out</button>
          </div>
        {:else if d.can_drive && v.checkout_policy === "admin_only"}
          <p class="small muted">A team admin hands this one out.</p>
        {/if}
        {#if d.can_admin && others.length}
          <div class="inline">
            <select bind:value={handTo} aria-label="Hand it to">
              <option value="">Hand it to…</option>
              {#each others as p (p.user_id)}<option value={p.user_id}>{p.display_name}</option>{/each}
            </select>
            <button disabled={busy || !handTo} onclick={handOut}>Check out to them</button>
          </div>
        {/if}
      {/if}
    </section>

    <!-- Permanent drivers -->
    <section class="card pad stack">
      <div>
        <h2>Permanent drivers</h2>
        <p class="muted small">Their car day to day. When nobody has it checked out, a drive in it is credited to its permanent driver if there's only one.</p>
      </div>
      {#if v.assigned.length}
        <div class="list bordered">
          {#each v.assigned as a (a.id)}
            <div class="row">
              <Avatar id={a.user_id} name={a.display_name} url={a.avatar_url} />
              <div class="grow"><strong>{a.user_id === me.id ? "You" : a.display_name}</strong><div class="muted small">since {date(a.since)}</div></div>
              {#if d.can_admin || a.user_id === me.id}
                <button class="sm ghost" disabled={busy} onclick={() => unassign(a.id, a.display_name, a.user_id === me.id)}>Remove</button>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted">None. It's a pool vehicle: whoever checks it out drives it.</p>
      {/if}
      {#if d.can_admin && !v.archived_at && unassigned.length}
        <div class="inline">
          <select bind:value={addDriver} aria-label="Add a permanent driver">
            <option value="">Add a permanent driver…</option>
            {#each unassigned as p (p.user_id)}<option value={p.user_id}>{p.user_id === me.id ? "Me" : p.display_name}</option>{/each}
          </select>
          <button disabled={busy || !addDriver} onclick={assign}>Add</button>
        </div>
      {/if}
    </section>

    <!-- Loggers -->
    <section class="card pad stack">
      <div class="section-head">
        <h2>Loggers</h2>
        <a class="small" href="/fleet/loggers">Your loggers</a>
      </div>
      {#if d.loggers.length}
        <div class="list bordered">
          {#each d.loggers as l (l.id)}
            <div class="row">
              <span class="lg"><Icon name="logger" /></span>
              <div class="grow">
                {#if l.mine}<a href="/fleet/loggers/{l.id}"><strong>{l.name}</strong></a>{:else}<strong>{l.name}</strong>{/if}
                <div class="muted small">{l.owner_name}'s · in since {date(l.installed_at)} · seen {ago(l.last_seen_at)}</div>
              </div>
              {#if l.mine || d.can_admin}<button class="sm ghost" disabled={busy} onclick={() => uninstall(l.id)}>Take out</button>{/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted">No logger in this vehicle. Install one from its page under Fleet → Loggers.</p>
      {/if}
    </section>

    <!-- History -->
    <section class="card stack hist">
      <h2 class="pad-x">History</h2>
      {#if d.history.length}
        <div class="scroll">
          <table class="data">
            <thead><tr><th>Who</th><th>How</th><th>When</th><th>Set by</th><th>Note</th></tr></thead>
            <tbody>
              {#each d.history as h (h.id)}
                <tr>
                  <td><div class="who"><Avatar id={h.user_id} name={h.display_name} url={h.avatar_url} size={24} /> {h.display_name}</div></td>
                  <td>{h.kind === "checkout" ? "Checked out" : "Permanent"}</td>
                  <td class="muted">{span(h.started_at, h.ended_at)}{#if !h.ended_at} <span class="badge green">now</span>{/if}</td>
                  <td class="muted small">{h.assigned_by_name ?? "—"}{h.ended_by_name ? ` · ended by ${h.ended_by_name}` : ""}</td>
                  <td class="muted small">{h.note ?? ""}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="muted pad-x pad-b">Nobody has had it yet.</p>
      {/if}
    </section>

    {#if d.can_admin}
      <form class="card pad stack" onsubmit={(e) => { e.preventDefault(); syncFrom(form, e.currentTarget); save(); }}>
        <h2>Details</h2>
        <VehicleForm bind:value={form} {shared} />
        <div><button type="submit" disabled={busy}>Save</button></div>
      </form>


      {#if moveTargets.length && !v.archived_at}
        <section class="card pad stack">
          <h2>Move to another team</h2>
          <p class="muted small">For example, from your personal vehicles to your household so your partner can drive it too.</p>
          <div class="inline">
            <select bind:value={moveTo} aria-label="Team to move to">
              <option value="">Choose a team…</option>
              {#each moveTargets as t (t.id)}<option value={t.id}>{t.kind === "personal" ? "Just me (personal)" : t.name}</option>{/each}
            </select>
            <button disabled={busy || !moveTo} onclick={move}>Move</button>
          </div>
        </section>
      {/if}

      <section class="card pad stack">
        <h2>{v.archived_at ? "Archived" : "Archive"}</h2>
        {#if v.archived_at}
          <p class="muted">Bring it back into use.</p>
          <div><button disabled={busy} onclick={() => archive(false)}>Unarchive</button></div>
        {:else}
          <p class="muted">Sold it, or it's off the road? Archiving keeps its history and drives.</p>
          <div><button class="danger" disabled={busy} onclick={() => archive(true)}>Archive {v.name}</button></div>
        {/if}
      </section>
    {/if}
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .back { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; width: fit-content; }
  .hero { display: grid; grid-template-columns: 300px 1fr; overflow: hidden; }
  .pic { min-height: 190px; }
  .info { padding: 20px; display: grid; gap: 6px; align-content: center; }
  .title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .who { display: flex; align-items: center; gap: 10px; }
  .inline { display: flex; gap: 8px; flex-wrap: wrap; }
  .inline > input, .inline > select { flex: 1 1 220px; width: auto; }
  .bordered { border: 1px solid var(--line); border-radius: var(--r-sm); }
  .lg { width: 36px; height: 36px; border-radius: 8px; background: var(--surface-2); display: grid; place-items: center; color: var(--ink-soft); }
  .hist { padding: 18px 0 6px; }
  .pad-x { padding: 0 18px; }
  .pad-b { padding-bottom: 12px; }
  .scroll { overflow-x: auto; }
  .hist :global(th:first-child), .hist :global(td:first-child) { padding-left: 18px; }
  @media (max-width: 760px) { .hero { grid-template-columns: 1fr; } }
  .pic { position: relative; }
  .pic-actions { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; }
  .pic-actions button { background: rgba(255, 255, 255, .94); box-shadow: var(--shadow); }
</style>
