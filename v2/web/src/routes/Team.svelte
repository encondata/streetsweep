<script lang="ts">
  import Avatar from "../components/Avatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { ago, date } from "../lib/format";
  import { ROLE_HELP, ROLE_LABEL, type Role, type TeamDetail, type TeamPreview, type Member } from "../lib/types";

  let { id, tab }: { id: string; tab: string } = $props();

  let detail = $state<TeamDetail | null>(null);
  let preview = $state<TeamPreview | null>(null);
  let error = $state<string | null>(null);
  let flash = $state<string | null>(null);
  let busy = $state(false);

  // Approving: the role picked per request, driver unless changed.
  let approveAs = $state<Record<string, Role>>({});

  // Drive-type icons not generated yet fall back to a letter.
  let noIcon = $state<Record<string, boolean>>({});

  // Settings form.
  let name = $state("");
  let listed = $state(true);

  // Asking to join (when this is someone else's listed team).
  let askMessage = $state("");

  async function load() {
    try {
      const data = await api<TeamDetail | TeamPreview>(`/api/teams/${id}`);
      if ("members" in data) apply(data);
      else preview = data;
    } catch (e) {
      error = errorText(e);
    }
  }
  load();

  function apply(d: TeamDetail) {
    detail = d;
    preview = null;
    name = d.team.name;
    listed = d.team.listed;
  }

  /** Run a change; the server answers with the updated team, which replaces ours. */
  async function act(fn: () => Promise<TeamDetail | unknown>, done?: string) {
    busy = true;
    error = flash = null;
    try {
      const d = await fn();
      if (d && typeof d === "object" && "members" in d) apply(d as TeamDetail);
      if (done) flash = done;
      await session.refresh();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  let me = $derived(session.me!.user);
  let isOwner = $derived(detail?.my_role === "owner" || me.is_site_admin);
  let personal = $derived(detail?.team.kind === "personal");
  let joinLink = $derived(detail?.team.join_code ? `${location.origin}/join/${detail.team.join_code}` : "");

  let tabs = $derived(detail ? [
    { key: "members", label: "Members", count: 0 },
    ...(detail.can_admin && !personal ? [{ key: "requests", label: "Requests", count: detail.requests.length }] : []),
    { key: "drive-types", label: "Drive types", count: 0 },
    ...(detail.can_admin ? [{ key: "settings", label: "Settings", count: 0 }] : []),
  ] : []);
  let current = $derived(tabs.some((t) => t.key === tab) ? tab : "members");

  function rolesFor(m: Member): Role[] {
    // Admins manage drivers, viewers and other admins; only owners touch owners.
    return isOwner ? ["owner", "admin", "driver", "viewer"] : m.role === "owner" ? ["owner"] : ["admin", "driver", "viewer"];
  }
  const canEdit = (m: Member) => !!detail?.can_admin && !personal && (isOwner || m.role !== "owner");

  const setRole = (m: Member, role: Role) =>
    act(() => api(`/api/teams/${id}/members/${m.user_id}`, { method: "PATCH", body: { role } }), `${m.display_name} is now ${ROLE_LABEL[role].toLowerCase()}.`);

  async function remove(m: Member) {
    if (!confirm(`Remove ${m.display_name} from ${detail!.team.name}? Their past drives still count.`)) return;
    await act(() => api(`/api/teams/${id}/members/${m.user_id}`, { method: "DELETE" }), `${m.display_name} was removed.`);
  }

  async function leave() {
    if (!confirm(`Leave ${detail!.team.name}? Your past drives still count for it; new ones won't.`)) return;
    await act(() => api(`/api/teams/${id}/members/${me.id}`, { method: "DELETE" }));
    if (!error) router.go("/teams");
  }

  const approve = (rid: string, who: string) =>
    act(() => api(`/api/join-requests/${rid}/approve`, { body: { role: approveAs[rid] ?? "driver" } }), `${who} is in.`);
  const decline = (rid: string, who: string) =>
    act(() => api(`/api/join-requests/${rid}/decline`, { body: {} }), `Declined ${who}.`);

  const toggleType = (key: string, counts: boolean) =>
    act(() => api(`/api/teams/${id}/drive-types/${key}`, { method: "PUT", body: { counts } }));

  const saveSettings = () =>
    act(() => api(`/api/teams/${id}`, { method: "PATCH", body: personal ? { name } : { name, listed } }), "Saved.");

  async function newCode() {
    if (!confirm("Make a new join link? The old one stops working.")) return;
    await act(() => api(`/api/teams/${id}/join-code`, { body: {} }), "New join link made.");
  }

  async function copyLink() {
    await navigator.clipboard.writeText(joinLink).then(() => (flash = "Join link copied."), () => (flash = joinLink));
  }

  async function deleteTeam() {
    const typed = prompt(`This deletes ${detail!.team.name} for everyone. Type the team's name to confirm.`);
    if (typed?.trim() !== detail!.team.name) return;
    await act(() => api(`/api/teams/${id}`, { method: "DELETE" }));
    if (!error) router.go("/teams");
  }

  async function ask() {
    await act(() => api(`/api/teams/${id}/join-requests`, { body: { message: askMessage.trim() || undefined } }));
    if (!error) await load();
  }
</script>

<div class="page">
  <a class="back muted" href="/teams"><Icon name="back" size={16} /> Teams</a>

  {#if error}<p class="notice error">{error}</p>{/if}
  {#if flash}<p class="notice">{flash}</p>{/if}

  {#if preview}
    <!-- Someone else's listed team -->
    <div class="card pad stack">
      <div class="head">
        <Avatar id={preview.team.id} name={preview.team.name} size={56} />
        <div>
          <h1>{preview.team.name}</h1>
          <p class="muted">{preview.team.member_count} member{preview.team.member_count === 1 ? "" : "s"}</p>
        </div>
      </div>
      {#if preview.my_request}
        <p class="notice">You asked to join {ago(preview.my_request.requested_at)}. A team admin will approve it.</p>
      {:else}
        <label class="field">Note to the admins <span class="help">Optional.</span>
          <textarea bind:value={askMessage} maxlength="500"></textarea></label>
        <div><button class="primary" disabled={busy} onclick={ask}>Ask to join</button></div>
      {/if}
    </div>
  {:else if detail}
    <div class="head">
      <Avatar id={detail.team.id} name={detail.team.name} size={56} />
      <div class="grow">
        <h1 class="ellipsis">{detail.team.name}</h1>
        <p class="muted">
          {#if personal}Your personal team: coverage from your own drives.
          {:else}{detail.members.length} member{detail.members.length === 1 ? "" : "s"}{detail.my_role ? ` · you're ${ROLE_LABEL[detail.my_role].toLowerCase()}` : " · viewing as site admin"}{/if}
        </p>
      </div>
      {#if !personal}<span class="badge">{detail.team.listed ? "Listed" : "Unlisted"}</span>{/if}
    </div>

    <nav class="tabs">
      {#each tabs as t (t.key)}
        <a href="/teams/{id}/{t.key}" class:on={current === t.key}>{t.label}{#if t.count}<span class="count">{t.count}</span>{/if}</a>
      {/each}
    </nav>

    {#if current === "members"}
      <div class="card list">
        {#each detail.members as m (m.user_id)}
          <div class="row">
            <Avatar id={m.user_id} name={m.display_name} url={m.avatar_url} />
            <div class="grow">
              <strong class="ellipsis">{m.display_name}{m.user_id === me.id ? " (you)" : ""}</strong>
              <div class="muted small ellipsis">{m.email ? `${m.email} · ` : ""}joined {date(m.joined_at)}</div>
            </div>
            {#if canEdit(m)}
              <select class="role" value={m.role} disabled={busy} aria-label="Role for {m.display_name}"
                onchange={(e) => setRole(m, e.currentTarget.value as Role)}>
                {#each rolesFor(m) as r}<option value={r}>{ROLE_LABEL[r]}</option>{/each}
              </select>
              {#if m.user_id !== me.id}<button class="sm ghost" disabled={busy} onclick={() => remove(m)}>Remove</button>{/if}
            {:else}
              <span class="badge" class:green={m.role === "owner" || m.role === "admin"}>{ROLE_LABEL[m.role]}</span>
            {/if}
          </div>
        {/each}
      </div>
      <details class="roles muted small">
        <summary>What the roles mean</summary>
        <ul>{#each Object.entries(ROLE_HELP) as [r, help]}<li><strong>{ROLE_LABEL[r as Role]}:</strong> {help}</li>{/each}</ul>
      </details>
      {#if !personal && detail.my_role}
        <div><button class="danger sm" disabled={busy} onclick={leave}><Icon name="out" size={16} /> Leave team</button></div>
      {/if}

    {:else if current === "requests"}
      <div class="card list">
        {#each detail.requests as r (r.id)}
          <div class="row request">
            <Avatar id={r.user_id} name={r.display_name} url={r.avatar_url} />
            <div class="grow">
              <strong>{r.display_name}</strong> <span class="muted small">{r.email} · {ago(r.requested_at)}</span>
              {#if r.message}<p class="note">“{r.message}”</p>{/if}
            </div>
            <div class="actions">
              <select class="role" value={approveAs[r.id] ?? "driver"} aria-label="Role for {r.display_name}"
                onchange={(e) => (approveAs[r.id] = e.currentTarget.value as Role)}>
                <option value="driver">Driver</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
              <button class="sm primary" disabled={busy} onclick={() => approve(r.id, r.display_name)}><Icon name="check" size={16} /> Approve</button>
              <button class="sm ghost" disabled={busy} onclick={() => decline(r.id, r.display_name)}>Decline</button>
            </div>
          </div>
        {:else}
          <EmptyState art="empty-requests.png" title="No one is waiting">
            Share the join link from Settings, or let people find the team by name{detail.team.listed ? "" : " (switch on “Show in search”)"}.
          </EmptyState>
        {/each}
      </div>

    {:else if current === "drive-types"}
      <p class="muted">
        Drivers choose a type when a drive starts. Drives of the types switched on here count toward
        {personal ? "your personal" : "this team's"} coverage. Switching one off keeps the drives; they just stop counting here.
      </p>
      <div class="card list">
        {#each detail.drive_types as t (t.key)}
          <label class="row type">
            <span class="type-icon">
              {#if t.icon && !noIcon[t.key]}
                <img src="/{t.icon}" alt="" onerror={() => (noIcon[t.key] = true)} />
              {:else}{t.label[0]}{/if}
            </span>
            <span class="grow"><strong>{t.label}</strong></span>
            <span class="switch">
              <input type="checkbox" checked={t.counts} disabled={!detail.can_admin || busy}
                onchange={(e) => toggleType(t.key, e.currentTarget.checked)} aria-label="Count {t.label} drives" />
              <span></span>
            </span>
          </label>
        {/each}
      </div>
      {#if !detail.can_admin}<p class="muted small">Only this team's admins can change these.</p>{/if}

    {:else if current === "settings"}
      <form class="card pad stack" onsubmit={(e) => { e.preventDefault(); saveSettings(); }}>
        <h2>Team</h2>
        <label class="field">Name <input type="text" bind:value={name} maxlength="80" required /></label>
        {#if !personal}
          <label class="toggle">
            <span class="switch"><input type="checkbox" bind:checked={listed} /><span></span></span>
            <span><strong>Show in search</strong><br /><span class="muted small">Off: people can only find the team with the join link.</span></span>
          </label>
        {/if}
        <div><button type="submit" disabled={busy || !name.trim() || (name === detail.team.name && listed === detail.team.listed)}>Save</button></div>
      </form>

      {#if !personal}
        <div class="card pad stack">
          <h2>Join link</h2>
          <p class="muted">Anyone with this link can ask to join. You still approve each request.</p>
          <div class="linkrow">
            <input type="text" readonly value={joinLink} onfocus={(e) => e.currentTarget.select()} aria-label="Join link" />
            <button onclick={copyLink}><Icon name="link" size={16} /> Copy</button>
          </div>
          <p class="muted small">Code: <strong class="mono">{detail.team.join_code}</strong> · <button class="sm ghost" onclick={newCode} disabled={busy}>Make a new link</button></p>
        </div>

        {#if isOwner}
          <div class="card pad stack danger-zone">
            <h2>Delete team</h2>
            <p class="muted">Removes the team for everyone. Members keep their accounts and their personal coverage.</p>
            <div><button class="danger" disabled={busy} onclick={deleteTeam}>Delete {detail.team.name}</button></div>
          </div>
        {/if}
      {/if}
    {/if}
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .back { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; width: fit-content; }
  .head { display: flex; align-items: center; gap: 14px; }
  .role { width: auto; height: 32px; font-size: 13px; }
  .roles summary { cursor: pointer; width: fit-content; }
  .roles ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 3px; }
  .request { align-items: flex-start; flex-wrap: wrap; }
  .note { margin-top: 4px; font-style: italic; }
  .actions { display: flex; gap: 6px; align-items: center; }
  .type { cursor: pointer; }
  .type-icon { width: 32px; height: 32px; border-radius: 8px; background: var(--surface-2); display: grid; place-items: center; font-weight: 700; color: var(--ink-soft); flex: none; }
  .type-icon img { width: 26px; height: 26px; }
  .toggle { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
  .linkrow { display: flex; gap: 8px; }
  .mono { font-family: ui-monospace, Menlo, monospace; letter-spacing: .06em; }
  .danger-zone { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
  @media (max-width: 760px) { .actions { width: 100%; justify-content: flex-end; } }
</style>
