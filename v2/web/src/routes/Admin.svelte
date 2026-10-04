<script lang="ts">
  // Site administration: every user, every team, and the drive-type list.
  import { untrack } from "svelte";
  import Avatar from "../components/Avatar.svelte";
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import { api, errorText } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { ago, date } from "../lib/format";
  import { formValues } from "../lib/forms";

  let { tab }: { tab: string } = $props();

  type AdminUser = {
    id: string; email: string; display_name: string; avatar_url: string | null; is_site_admin: boolean;
    created_at: string; disabled_at: string | null; last_seen_at: string | null; team_count: number;
  };
  type AdminTeam = { id: string; name: string; listed: boolean; created_at: string; member_count: number; pending_requests: number };
  type DriveType = { key: string; label: string; icon: string | null; sort: number; archived_at: string | null };
  type ImportRun = {
    id: number; region: string; status: "running" | "done" | "failed" | "skipped"; step: string | null;
    osm_timestamp: string | null; file_bytes: number | null; ways: number | null; segments: number | null;
    added: number | null; changed: number | null; retired: number | null; error: string | null;
    started_at: string; finished_at: string | null; requested_by_name: string | null;
  };
  type DeletionRequest = {
    id: string; email: string; display_name: string; user_id: string | null; reason: string | null;
    status: "pending" | "done" | "declined" | "withdrawn"; requested_at: string; decided_at: string | null;
    note: string | null; decided_by_name: string | null;
  };
  type MapData = { source_url: string; region: string; runs: ImportRun[]; totals: { segments: number; meters: number; ways: number } };

  let users = $state<AdminUser[]>([]);
  let teams = $state<AdminTeam[]>([]);
  let types = $state<DriveType[]>([]);
  let mapData = $state<MapData | null>(null);
  let requests = $state<DeletionRequest[]>([]);
  let queued = $state(false);
  let q = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  let resetFor = $state<{ name: string; email: string; password: string } | null>(null);
  let resetOpen = $state(false);

  let newKey = $state("");
  let newLabel = $state("");

  const me = session.me!.user;
  const TABS = [
    { key: "users", label: "Users" }, { key: "teams", label: "Teams" },
    { key: "drive-types", label: "Drive types" }, { key: "map-data", label: "Map data" },
    { key: "deletions", label: "Deletion requests" },
  ];

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    busy = true;
    error = null;
    try {
      return await fn();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  const loadUsers = () => run(async () => (users = (await api<{ users: AdminUser[] }>("/api/admin/users?q=" + encodeURIComponent(q.trim()))).users));
  const loadTeams = () => run(async () => (teams = (await api<{ teams: AdminTeam[] }>("/api/admin/teams")).teams));
  const loadRequests = () => run(async () => (requests = (await api<{ requests: DeletionRequest[] }>("/api/admin/deletion-requests")).requests));
  const loadTypes = () => run(async () => (types = (await api<{ drive_types: DriveType[] }>("/api/drive-types")).drive_types));

  // While an import runs (or one was just asked for), keep the page current.
  let mapTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadMapData() {
    clearTimeout(mapTimer);
    try {
      mapData = await api<MapData>("/api/admin/osm-imports");
      if (mapData.runs[0]?.status === "running") queued = false;
      if (tab === "map-data" && (queued || mapData.runs[0]?.status === "running")) mapTimer = setTimeout(loadMapData, 4000);
    } catch (e) {
      error = errorText(e);
    }
  }
  $effect(() => () => clearTimeout(mapTimer));

  async function startImport() {
    if (!confirm("Download the latest extract and re-import the streets now? Takes a few minutes; the map keeps working meanwhile.")) return;
    const r = await run(() => api<{ queued: boolean }>("/api/admin/osm-imports", { body: { force: true } }));
    if (r) {
      queued = true;
      if (!r.queued) error = "An import is already waiting or running.";
      loadMapData();
    }
  }

  const took = (r: ImportRun) => {
    if (!r.finished_at) return "";
    const s = Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000);
    return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
  };
  const n = (v: number | null) => (v == null ? "—" : v.toLocaleString());

  // Reload when the tab changes, and only then (the search box has its own timer).
  $effect(() => {
    const t = tab;
    untrack(() => (t === "users" ? loadUsers() : t === "teams" ? loadTeams() : t === "map-data" ? loadMapData() : t === "deletions" ? loadRequests() : loadTypes()));
  });

  let timer: ReturnType<typeof setTimeout>;
  function search() {
    clearTimeout(timer);
    timer = setTimeout(loadUsers, 250);
  }

  const updateUser = (u: AdminUser, body: { is_site_admin?: boolean; disabled?: boolean }) =>
    run(async () => {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body });
      await loadUsers();
    });

  async function resetPassword(u: AdminUser) {
    if (!confirm(`Give ${u.display_name} a new password? They'll be signed out everywhere.`)) return;
    const r = await run(() => api<{ password: string }>(`/api/admin/users/${u.id}/reset-password`, { body: {} }));
    if (r) {
      resetFor = { name: u.display_name, email: u.email, password: r.password };
      resetOpen = true;
    }
  }

  const GONE = "Their drives, places, photos, personal vehicles, phones and loggers go with it, and teams they own alone pass to another member. This can't be undone.";

  async function deleteUser(u: AdminUser) {
    if (!confirm(`Delete ${u.display_name} (${u.email}) and all their data? ${GONE}`)) return;
    await run(async () => {
      await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
      await loadUsers();
    });
  }

  async function completeRequest(r: DeletionRequest) {
    if (!confirm(`Delete ${r.display_name} (${r.email}) and all their data? ${GONE} They'll get an email saying it's done.`)) return;
    await run(async () => {
      await api(`/api/admin/deletion-requests/${r.id}/complete`, { body: {} });
      await loadRequests();
    });
  }

  async function declineRequest(r: DeletionRequest) {
    const note = prompt(`Why not delete ${r.display_name}'s account? This goes in the email to them (optional).`);
    if (note === null) return;
    await run(async () => {
      await api(`/api/admin/deletion-requests/${r.id}/decline`, { body: { note } });
      await loadRequests();
    });
  }

  const saveType = (t: DriveType, body: { label?: string; sort?: number; archived?: boolean }) =>
    run(async () => {
      await api(`/api/admin/drive-types/${t.key}`, { method: "PATCH", body });
      await loadTypes();
    });

  const addType = () =>
    run(async () => {
      await api("/api/admin/drive-types", { body: { key: newKey.trim(), label: newLabel.trim() } });
      newKey = newLabel = "";
      await loadTypes();
    });

  // "Night shift" → "night_shift": the key is fixed once made, so suggest it from the label.
  function suggestKey() {
    if (!newKey) newKey = newLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  }
</script>

<div class="page wide">
  <div class="page-head"><h1>Admin</h1></div>

  <nav class="tabs">
    {#each TABS as t (t.key)}<a href="/admin/{t.key}" class:on={tab === t.key}>{t.label}</a>{/each}
  </nav>

  {#if error}<p class="notice error">{error}</p>{/if}

  {#if tab === "users"}
    <label class="search">
      <Icon name="search" size={18} />
      <input type="search" placeholder="Search by name or email" bind:value={q} oninput={search} aria-label="Search users" />
    </label>
    <div class="card scroll">
      <table class="data">
        <thead><tr><th>Person</th><th>Joined</th><th>Last seen</th><th>Teams</th><th>Site admin</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {#each users as u (u.id)}
            <tr class:off={u.disabled_at}>
              <td>
                <div class="who">
                  <Avatar id={u.id} name={u.display_name} url={u.avatar_url} size={30} />
                  <div><strong>{u.display_name}</strong><div class="muted small">{u.email}</div></div>
                </div>
              </td>
              <td class="muted">{date(u.created_at)}</td>
              <td class="muted">{ago(u.last_seen_at)}</td>
              <td>{u.team_count}</td>
              <td>
                <span class="switch"><input type="checkbox" checked={u.is_site_admin} disabled={busy || u.id === me.id}
                  aria-label="Site admin" onchange={(e) => updateUser(u, { is_site_admin: e.currentTarget.checked })} /><span></span></span>
              </td>
              <td>
                <span class="switch"><input type="checkbox" checked={!u.disabled_at} disabled={busy || u.id === me.id}
                  aria-label="Account active" onchange={(e) => updateUser(u, { disabled: !e.currentTarget.checked })} /><span></span></span>
              </td>
              <td class="actions">
                <button class="sm" disabled={busy} onclick={() => resetPassword(u)}>Reset password</button>
                <button class="sm danger" disabled={busy || u.id === me.id} onclick={() => deleteUser(u)}>Delete</button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="7" class="muted">{busy ? "Loading…" : "No one matches."}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>

  {:else if tab === "teams"}
    <div class="card scroll">
      <table class="data">
        <thead><tr><th>Team</th><th>Members</th><th>Waiting</th><th>Search</th><th>Created</th></tr></thead>
        <tbody>
          {#each teams as t (t.id)}
            <tr>
              <td><a href="/teams/{t.id}"><strong>{t.name}</strong></a></td>
              <td>{t.member_count}</td>
              <td>{#if t.pending_requests}<span class="badge warn">{t.pending_requests}</span>{:else}<span class="muted">0</span>{/if}</td>
              <td class="muted">{t.listed ? "Listed" : "Unlisted"}</td>
              <td class="muted">{date(t.created_at)}</td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">{busy ? "Loading…" : "No shared teams yet."}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="muted small">Personal teams aren't listed. Site admins can open any team and act as its admin.</p>

  {:else if tab === "drive-types"}
    <p class="muted">
      The list drivers pick from when a drive starts. Each team chooses which types count for it.
      Retired types disappear from the picker but old drives keep them.
    </p>
    <div class="card scroll">
      <table class="data">
        <thead><tr><th>Label</th><th>Key</th><th>Order</th><th>Icon file</th><th>In use</th></tr></thead>
        <tbody>
          {#each types as t (t.key)}
            <tr class:off={t.archived_at}>
              <td><input type="text" value={t.label} maxlength="40" aria-label="Label"
                onchange={(e) => saveType(t, { label: e.currentTarget.value })} /></td>
              <td class="mono muted">{t.key}</td>
              <td><input class="num" type="number" value={t.sort} aria-label="Order"
                onchange={(e) => saveType(t, { sort: Number(e.currentTarget.value) })} /></td>
              <td class="muted small">{t.icon}</td>
              <td>
                <span class="switch"><input type="checkbox" checked={!t.archived_at} disabled={busy} aria-label="In use"
                  onchange={(e) => saveType(t, { archived: !e.currentTarget.checked })} /><span></span></span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <form class="card pad add" onsubmit={(e) => { e.preventDefault(); const f = formValues(e.currentTarget); newLabel = f.label ?? newLabel; newKey = f.key ?? newKey; addType(); }}>
      <label class="field">New type <input type="text" name="label" bind:value={newLabel} onblur={suggestKey} maxlength="40" autocomplete="off" placeholder="e.g. Rideshare" required /></label>
      <label class="field">Key <span class="help">Lowercase, can't change later.</span>
        <input type="text" name="key" bind:value={newKey} maxlength="32" pattern="[a-z][a-z0-9_]+" autocomplete="off" placeholder="rideshare" required /></label>
      <button type="submit" class="primary" disabled={busy}><Icon name="plus" size={16} /> Add</button>
    </form>
  {/if}
{#if tab === "deletions"}
    <p class="muted">
      People who asked at <a href="/delete-me">/delete-me</a> without signing in, after confirming their email address with a code.
      The privacy policy promises deletion within 30 days.
    </p>
    <div class="card scroll">
      <table class="data">
        <thead><tr><th>Person</th><th>Asked</th><th>Reason</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {#each requests as r (r.id)}
            <tr class:off={r.status !== "pending"}>
              <td><strong>{r.display_name}</strong><div class="muted small">{r.email}</div></td>
              <td class="muted">{date(r.requested_at)}<div class="small">{ago(r.requested_at)}</div></td>
              <td class="small reason">{r.reason ?? ""}</td>
              <td>
                {#if r.status === "pending"}<span class="badge warn">Waiting</span>
                {:else if r.status === "done"}<span class="badge green">Deleted</span>
                {:else}<span class="badge">{r.status === "declined" ? "Declined" : "Withdrawn"}</span>{/if}
                {#if r.decided_at}<div class="muted small">{date(r.decided_at)}{r.decided_by_name ? ` · ${r.decided_by_name}` : ""}</div>{/if}
                {#if r.note}<div class="muted small">{r.note}</div>{/if}
              </td>
              <td class="actions">
                {#if r.status === "pending"}
                  <button class="sm danger" disabled={busy} onclick={() => completeRequest(r)}>Delete account</button>
                  <button class="sm" disabled={busy} onclick={() => declineRequest(r)}>Decline</button>
                {/if}
              </td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">{busy ? "Loading…" : "No requests."}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
{/if}
{#if tab === "map-data"}
    {#if mapData}
      <div class="card pad stack">
        <div class="section-head">
          <div>
            <h2>Streets for {mapData.region[0].toUpperCase() + mapData.region.slice(1)}</h2>
            <p class="muted small">From <code>{mapData.source_url}</code>. Refreshed automatically on the 3rd of each month.</p>
          </div>
          <button class="primary" disabled={busy || queued || mapData.runs[0]?.status === "running"} onclick={startImport}>Import now</button>
        </div>
        <div class="facts">
          <div><span class="muted small">Streets</span><strong>{n(mapData.totals.ways)}</strong></div>
          <div><span class="muted small">Segments</span><strong>{n(mapData.totals.segments)}</strong></div>
          <div><span class="muted small">Length</span><strong>{Math.round(mapData.totals.meters / 1609.34).toLocaleString()} mi</strong></div>
          <div><span class="muted small">OpenStreetMap data from</span><strong>{mapData.runs.find((r) => r.status === "done")?.osm_timestamp ? date(mapData.runs.find((r) => r.status === "done")!.osm_timestamp!) : "—"}</strong></div>
        </div>
      </div>

      <div class="card scroll">
        <table class="data">
          <thead><tr><th>Run</th><th>Status</th><th>Data from</th><th>Segments</th><th>Added · changed · retired</th><th>Took</th></tr></thead>
          <tbody>
            {#if queued && mapData.runs[0]?.status !== "running"}
              <tr><td colspan="6"><span class="badge warn">Waiting</span> <span class="muted">The worker will pick it up in a moment.</span></td></tr>
            {/if}
            {#each mapData.runs as r (r.id)}
              <tr>
                <td class="muted">{ago(r.started_at)}{r.requested_by_name ? ` · ${r.requested_by_name}` : " · scheduled"}</td>
                <td>
                  {#if r.status === "running"}<span class="badge warn">Running</span> <span class="small">{r.step}</span>
                  {:else if r.status === "done"}<span class="badge green">Done</span>
                  {:else if r.status === "skipped"}<span class="badge">Up to date</span>
                  {:else}<span class="badge err">Failed</span> <span class="small muted">{r.error}</span>{/if}
                </td>
                <td class="muted">{r.osm_timestamp ? date(r.osm_timestamp) : "—"}</td>
                <td>{n(r.segments)}</td>
                <td class="muted">{r.status === "done" ? `${n(r.added)} · ${n(r.changed)} · ${n(r.retired)}` : "—"}</td>
                <td class="muted">{took(r)}</td>
              </tr>
            {:else}
              <tr><td colspan="6" class="muted">No imports yet. The worker starts one on its first run.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="muted">Loading…</p>
    {/if}
{/if}

</div>

<Modal bind:open={resetOpen} title="New password">
  {#if resetFor}
    <p>Give this to <strong>{resetFor.name}</strong> ({resetFor.email}). It won't be shown again; they can change it in their account.</p>
    <p class="pw mono">{resetFor.password}</p>
  {/if}
  {#snippet footer()}
    <button onclick={() => navigator.clipboard.writeText(resetFor?.password ?? "")}>Copy</button>
    <button class="primary" onclick={() => (resetOpen = false)}>Done</button>
  {/snippet}
</Modal>

<style>
  .wide { max-width: 1120px; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
  .facts div { display: grid; gap: 2px; }
  .facts strong { font-size: 18px; }
  .badge.err { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
  code { font-size: 12px; word-break: break-all; }
  .scroll { overflow-x: auto; }
  .actions { white-space: nowrap; }
  .actions button + button { margin-left: 6px; }
  .reason { max-width: 320px; white-space: pre-wrap; }
  .who { display: flex; align-items: center; gap: 10px; }
  tr.off td { opacity: .55; }
  .search { position: relative; display: block; color: var(--ink-soft); max-width: 420px; }
  .search :global(svg) { position: absolute; left: 12px; top: 11px; }
  .search input { padding-left: 38px; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .num { width: 80px; }
  td input[type=text] { min-width: 140px; height: 34px; }
  .add { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; }
  .pw { font-size: 22px; letter-spacing: .08em; padding: 14px; text-align: center; background: var(--surface-2); border-radius: var(--r-sm); user-select: all; }
  @media (max-width: 760px) { .add { grid-template-columns: 1fr; } }
</style>
