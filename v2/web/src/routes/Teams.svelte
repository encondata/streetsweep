<script lang="ts">
  import Avatar from "../components/Avatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { ago } from "../lib/format";
  import { formValues } from "../lib/forms";
  import { ROLE_LABEL, type Role, type TeamDetail } from "../lib/types";

  type Found = { id: string; name: string; member_count: number; my_role: Role | null; requested: boolean };
  type MyRequest = { id: string; status: string; message: string | null; requested_at: string; decided_at: string | null; team_id: string; team_name: string };

  let welcome = $derived(router.query.get("welcome") === "1");
  let teams = $derived(session.me!.teams);
  let shared = $derived(teams.filter((t) => t.kind === "shared"));

  let requests = $state<MyRequest[]>([]);
  let q = $state("");
  let found = $state<Found[]>([]);
  let searching = $state(false);
  let error = $state<string | null>(null);

  let asking = $state<Found | null>(null);
  let askOpen = $state(false);
  let askMessage = $state("");
  let code = $state("");

  let creating = $state(false);
  let newName = $state("");
  let newListed = $state(true);
  let busy = $state(false);

  async function loadRequests() {
    requests = (await api<{ requests: MyRequest[] }>("/api/me/join-requests")).requests;
  }
  loadRequests().catch((e) => (error = errorText(e)));

  // Debounced search; an empty box lists every listed team (up to 50).
  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const term = q;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      searching = true;
      try {
        found = (await api<{ teams: Found[] }>("/api/teams?q=" + encodeURIComponent(term.trim()))).teams;
      } catch (e) {
        error = errorText(e);
      } finally {
        searching = false;
      }
    }, term ? 250 : 0);
    return () => clearTimeout(timer);
  });

  async function sendRequest() {
    if (!asking) return;
    busy = true;
    try {
      await api(`/api/teams/${asking.id}/join-requests`, { body: { message: askMessage.trim() || undefined } });
      found = found.map((f) => (f.id === asking!.id ? { ...f, requested: true } : f));
      askOpen = false;
      askMessage = "";
      await loadRequests();
    } catch (e) {
      error = errorText(e);
      askOpen = false;
    } finally {
      busy = false;
    }
  }

  async function withdraw(r: MyRequest) {
    try {
      await api(`/api/join-requests/${r.id}/withdraw`, { body: {} });
      await loadRequests();
      found = found.map((f) => (f.id === r.team_id ? { ...f, requested: false } : f));
    } catch (e) {
      error = errorText(e);
    }
  }

  async function createTeam() {
    busy = true;
    try {
      const t = await api<TeamDetail>("/api/teams", { body: { name: newName.trim(), listed: newListed } });
      await session.refresh();
      creating = false;
      newName = "";
      router.go(`/teams/${t.team.id}`);
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  function useCode() {
    const c = code.trim().replace(/^.*\/join\//, "").toUpperCase();
    if (c) router.go(`/join/${encodeURIComponent(c)}`);
  }

  const STATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn" };
</script>

<div class="page">
  <div class="page-head">
    <h1>Teams</h1>
    <button class="primary" onclick={() => (creating = true)}><Icon name="plus" size={18} /> New team</button>
  </div>

  {#if welcome}
    <p class="notice">
      <strong>Welcome to StreetSweep.</strong> Find your household or crew below and ask to join. A team admin approves it.
      Or start a new team and invite people with its join link.
    </p>
  {/if}
  {#if error}<p class="notice error">{error}</p>{/if}

  <section class="section">
    <h2>Your teams</h2>
    <div class="card list">
      {#each teams as t (t.id)}
        <a class="row team" href="/teams/{t.id}">
          <Avatar id={t.id} name={t.name} size={40} />
          <div class="grow">
            <strong class="ellipsis">{t.name}</strong>
            <div class="muted small">{t.kind === "personal" ? "Just you. Your own coverage." : ROLE_LABEL[t.role]}</div>
          </div>
          {#if t.kind === "personal"}<span class="badge">Personal</span>{/if}
          {#if t.pending_requests}<span class="badge warn">{t.pending_requests} to approve</span>{/if}
        </a>
      {/each}
    </div>
    {#if !shared.length}
      <p class="muted small">You're not in any shared team yet. Join one below or start your own.</p>
    {/if}
  </section>

  {#if requests.length}
    <section class="section">
      <h2>Your requests</h2>
      <div class="card list">
        {#each requests as r (r.id)}
          <div class="row">
            <div class="grow">
              <strong class="ellipsis">{r.team_name}</strong>
              <div class="muted small">Asked {ago(r.requested_at)}{r.decided_at ? ` · ${STATUS[r.status].toLowerCase()} ${ago(r.decided_at)}` : ""}</div>
            </div>
            <span class="badge" class:warn={r.status === "pending"} class:green={r.status === "approved"}>{STATUS[r.status]}</span>
            {#if r.status === "pending"}<button class="sm ghost" onclick={() => withdraw(r)}>Withdraw</button>{/if}
            {#if r.status === "approved"}<a class="btn sm" href="/teams/{r.team_id}">Open</a>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <section class="section">
    <div class="section-head"><h2>Find a team</h2></div>
    <div class="finders">
      <label class="search">
        <Icon name="search" size={18} />
        <input type="search" placeholder="Search teams by name" bind:value={q} aria-label="Search teams" />
      </label>
      <form class="code" onsubmit={(e) => { e.preventDefault(); useCode(); }}>
        <input type="text" placeholder="Join code or link" bind:value={code} autocomplete="off" aria-label="Join code" />
        <button type="submit" disabled={!code.trim()}>Go</button>
      </form>
    </div>
    <div class="card list">
      {#each found as f (f.id)}
        <div class="row">
          <Avatar id={f.id} name={f.name} size={36} />
          <div class="grow">
            <strong class="ellipsis">{f.name}</strong>
            <div class="muted small">{f.member_count} member{f.member_count === 1 ? "" : "s"}</div>
          </div>
          {#if f.my_role}
            <a class="btn sm" href="/teams/{f.id}">Open</a>
          {:else if f.requested}
            <span class="badge warn">Requested</span>
          {:else}
            <button class="sm" onclick={() => { asking = f; askMessage = ""; askOpen = true; }}>Ask to join</button>
          {/if}
        </div>
      {:else}
        <EmptyState art="empty-teams.png" title={searching ? "Searching…" : q ? "No teams by that name" : "No teams yet"}>
          {#if !searching}Teams that hide from search are joined with their join code instead.{/if}
        </EmptyState>
      {/each}
    </div>
  </section>
</div>

<Modal bind:open={askOpen} title="Ask to join {asking?.name ?? ''}">
  <p class="muted">The team's admins will see your name, email and this note.</p>
  <label class="field">Note <span class="help">Optional. Say who you are, e.g. "Sam, the new driver."</span>
    <textarea bind:value={askMessage} maxlength="500"></textarea>
  </label>
  {#snippet footer()}
    <button class="ghost" onclick={() => (askOpen = false)}>Cancel</button>
    <button class="primary" disabled={busy} onclick={sendRequest}>Send request</button>
  {/snippet}
</Modal>

<Modal bind:open={creating} title="New team">
  <form id="new-team" class="stack" onsubmit={(e) => { e.preventDefault(); newName = formValues(e.currentTarget).name ?? newName; createTeam(); }}>
    <label class="field">Name <input type="text" name="name" bind:value={newName} maxlength="80" autocomplete="off" placeholder="e.g. The Hendersons, Acme Deliveries" required /></label>
    <label class="toggle">
      <span class="switch"><input type="checkbox" bind:checked={newListed} /><span></span></span>
      <span><strong>Show in search</strong><br /><span class="muted small">Off: people can only find it with the join link.</span></span>
    </label>
    <p class="muted small">You'll be the owner. You approve who joins and choose which drive types count.</p>
  </form>
  {#snippet footer()}
    <button class="ghost" onclick={() => (creating = false)}>Cancel</button>
    <button class="primary" type="submit" form="new-team" disabled={busy}>Create team</button>
  {/snippet}
</Modal>

<style>
  a.team { color: inherit; }
  a.team:hover { background: var(--surface-2); text-decoration: none; }
  .finders { display: grid; grid-template-columns: 1fr 260px; gap: 10px; }
  .search { position: relative; display: block; color: var(--ink-soft); }
  .search :global(svg) { position: absolute; left: 12px; top: 11px; }
  .search input { padding-left: 38px; }
  .code { display: flex; gap: 6px; }
  .toggle { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
  @media (max-width: 760px) { .finders { grid-template-columns: 1fr; } }
</style>
