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

  let users = $state<AdminUser[]>([]);
  let teams = $state<AdminTeam[]>([]);
  let types = $state<DriveType[]>([]);
  let q = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  let resetFor = $state<{ name: string; email: string; password: string } | null>(null);
  let resetOpen = $state(false);

  let newKey = $state("");
  let newLabel = $state("");

  const me = session.me!.user;
  const TABS = [{ key: "users", label: "Users" }, { key: "teams", label: "Teams" }, { key: "drive-types", label: "Drive types" }];

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
  const loadTypes = () => run(async () => (types = (await api<{ drive_types: DriveType[] }>("/api/drive-types")).drive_types));

  // Reload when the tab changes, and only then (the search box has its own timer).
  $effect(() => {
    const t = tab;
    untrack(() => (t === "users" ? loadUsers() : t === "teams" ? loadTeams() : loadTypes()));
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
              <td><button class="sm" disabled={busy} onclick={() => resetPassword(u)}>Reset password</button></td>
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
  .scroll { overflow-x: auto; }
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
