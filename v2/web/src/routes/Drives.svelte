<script lang="ts">
  // Drives: yours (phone uploads, your loggers), or, for a team's admins, everything that
  // counts for the team. Newest first, a page at a time.
  import Avatar from "../components/Avatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { duration, miles } from "../lib/format";
  import type { Drive } from "../lib/types";

  const PAGE = 50;
  let me = $derived(session.me!.user);
  let adminTeams = $derived(session.me!.teams.filter((t) => t.kind === "shared" && (t.role === "owner" || t.role === "admin")));
  let teamId = $derived(router.query.get("team"));
  let team = $derived(adminTeams.find((t) => t.id === teamId) ?? null);

  let drives = $state<Drive[] | null>(null);
  let more = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function load(before?: string) {
    loading = true;
    error = null;
    try {
      const base = team ? `/api/teams/${team.id}/drives` : "/api/drives";
      const page = (await api<{ drives: Drive[] }>(`${base}?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`)).drives;
      drives = before ? [...(drives ?? []), ...page] : page;
      more = page.length === PAGE;
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    team;
    drives = null;
    load();
  });

  // Drives still being matched: look again shortly.
  $effect(() => {
    if (!drives?.some((d) => d.status === "received" || d.status === "matching")) return;
    const t = setTimeout(() => load(), 5000);
    return () => clearTimeout(t);
  });

  // Grouped by day, in local time.
  let days = $derived.by(() => {
    const out: { label: string; items: Drive[] }[] = [];
    for (const d of drives ?? []) {
      const label = dayLabel(d.started_at);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(d);
      else out.push({ label, items: [d] });
    }
    return out;
  });

  function dayLabel(iso: string) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
  }
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const driver = (d: Drive) => (d.user_id === me.id ? "You" : d.user_name ?? "Driver unknown");
</script>

<div class="page">
  <div class="page-head">
    <h1>Drives</h1>
  </div>

  {#if adminTeams.length}
    <nav class="tabs" aria-label="Whose drives">
      <a href="/drives" class:on={!team}>Yours</a>
      {#each adminTeams as t (t.id)}<a href="/drives?team={t.id}" class:on={team?.id === t.id}>{t.name}</a>{/each}
    </nav>
  {/if}

  <p class="muted">
    {#if team}Every drive that counts for {team.name}: its drivers' drives (while they're in the team) and drives in its vehicles. Only the team's admins see this.
    {:else}Drives from your phone and your loggers, matched to streets. Nobody else sees them, except admins of a team whose vehicle you drove.{/if}
  </p>

  {#if error}<p class="notice error">{error}</p>{/if}

  {#if drives && !drives.length}
    <div class="card">
      <EmptyState art="empty-drives.png" title="No drives yet">
        {#if team}When {team.name}'s drivers record drives, or a logger in one of its vehicles uploads, they show up here.
        {:else}Record a drive with the StreetSweep app, or put a logger in your car. Each one is matched to streets and counted for your teams.{/if}
      </EmptyState>
    </div>
  {/if}

  {#each days as day (day.label)}
    <section class="section">
      <h2 class="day">{day.label}</h2>
      <div class="card list">
        {#each day.items as d (d.id)}
          <a class="drive" href="/drives/{d.id}">
            <span class="src" title={d.source === "logger" ? `Logger: ${d.logger_name ?? ""}` : "Phone"}><Icon name={d.source === "logger" ? "logger" : "phone"} size={18} /></span>
            <span class="grow main">
              <span class="line1">
                <strong>{clock(d.started_at)}</strong>
                <span class="muted">· {miles(d.distance_m)} · {duration(d.started_at, d.ended_at)}</span>
                <span class="badge">{d.drive_type_label}</span>
              </span>
              <span class="line2 muted small ellipsis">
                {#if team || d.user_id !== me.id}{driver(d)} · {/if}{d.vehicle_name ?? "No vehicle"}
                {#if d.status === "matched"} · {d.street_count ?? 0} street{d.street_count === 1 ? "" : "s"}{/if}
              </span>
            </span>
            {#if team && d.user_id}<Avatar id={d.user_id} name={d.user_name ?? ""} url={d.user_avatar_url} size={28} />{/if}
            {#if d.status === "failed"}
              <span class="badge danger">Couldn't match</span>
            {:else if d.status !== "matched"}
              <span class="badge warn">Matching…</span>
            {:else if d.attribution === "unknown"}
              <span class="badge warn" title="Nobody had the vehicle checked out">Who drove?</span>
            {/if}
          </a>
        {/each}
      </div>
    </section>
  {/each}

  {#if more}
    <div class="center"><button disabled={loading} onclick={() => load(drives![drives!.length - 1].started_at)}>{loading ? "Loading…" : "Older drives"}</button></div>
  {/if}
</div>

<style>
  .day { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); }
  .drive { display: flex; align-items: center; gap: 12px; padding: 12px 16px; color: var(--ink); }
  .drive:hover { background: var(--surface-2); text-decoration: none; }
  .src { width: 34px; height: 34px; border-radius: 10px; background: var(--accent-soft); color: var(--green-700); display: grid; place-items: center; flex: none; }
  .main { display: grid; gap: 2px; }
  .line1 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .badge.danger { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
  .center { display: flex; justify-content: center; }
</style>
