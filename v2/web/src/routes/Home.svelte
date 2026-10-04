<script lang="ts">
  // Home: how you (or one of your teams) are doing. Figures, the last twelve weeks, area
  // progress, recent drives, achievements and, for a shared team, the leaderboards.
  import Avatar from "../components/Avatar.svelte";
  import AchievementTile from "../components/AchievementTile.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import WeekChart from "../components/WeekChart.svelte";
  import { api, errorText } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { duration, miles, percent } from "../lib/format";
  import { assignAreaColors } from "../lib/areaColors";
  import { AREA_COLORS } from "../lib/types";
  import type { AchievementSet, Area, Badge, Board, Drive, Ladder, LeaderRow, Period, Stats } from "../lib/types";

  let teams = $derived(session.me!.teams);
  let me = $derived(session.me!.user);
  let teamId = $state(readTeam());
  let team = $derived(teams.find((t) => t.id === teamId) ?? teams[0]);
  let personal = $derived(team?.kind === "personal");
  let isAdmin = $derived(team?.role === "owner" || team?.role === "admin");

  let stats = $state<Stats | null>(null);
  let areas = $state<Area[]>([]);
  let drives = $state<Drive[] | null>(null);
  let ach = $state<AchievementSet | null>(null);
  let error = $state<string | null>(null);

  let board = $state<Board>("new");
  let period = $state<Period>("week");
  let rows = $state<LeaderRow[] | null>(null);

  function readTeam() {
    try {
      const t = localStorage.getItem("streetsweep.homeTeam");
      if (t && session.me!.teams.some((x) => x.id === t)) return t;
    } catch { /* fine */ }
    return session.me!.teams.find((t) => t.kind === "personal")?.id ?? session.me!.teams[0]?.id ?? "";
  }

  $effect(() => {
    const t = team;
    if (!t) return;
    try { localStorage.setItem("streetsweep.homeTeam", t.id); } catch { /* fine */ }
    stats = null; drives = null; ach = null; areas = []; error = null;
    const own = t.kind === "personal";
    const fail = (e: unknown) => (error = errorText(e));
    api<Stats>(own ? "/api/stats" : `/api/teams/${t.id}/stats`).then((s) => (stats = s), fail);
    api<{ areas: Area[] }>(`/api/teams/${t.id}/areas`).then((r) => (areas = r.areas), fail);
    api<AchievementSet>(own ? "/api/achievements" : `/api/teams/${t.id}/achievements`).then((a) => (ach = a), fail);
    if (own) api<{ drives: Drive[] }>("/api/drives?limit=5").then((r) => (drives = r.drives), fail);
    else if (t.role === "owner" || t.role === "admin") api<{ drives: Drive[] }>(`/api/teams/${t.id}/drives?limit=5`).then((r) => (drives = r.drives), fail);
    else drives = [];
  });

  $effect(() => {
    if (!team || team.kind === "personal") return;
    const url = `/api/teams/${team.id}/leaderboard?board=${board}&period=${period}`;
    rows = null;
    api<{ rows: LeaderRow[] }>(url).then((r) => (rows = r.rows), (e) => (error = errorText(e)));
  });

  // The same automatic colours as the map: neighbours never share one.
  let areaColors = $derived(assignAreaColors(areas));

  // Areas with their streets listed, furthest along first.
  let progressAreas = $derived(
    areas.filter((a) => a.build_status === "built" && a.total_m)
      .map((a) => ({ a, pct: (a.driven_m ?? 0) / a.total_m! }))
      .sort((x, y) => y.pct - x.pct).slice(0, 6),
  );

  // Achievements: the latest earned, then the closest to earning.
  type Item = Badge | Ladder;
  let latest = $derived.by(() => {
    if (!ach) return [] as Item[];
    const all: Item[] = [...ach.ladders.filter((l) => l.level > 0), ...ach.badges.filter((b) => b.earned)];
    return all.sort((x, y) => (y.earned_at ?? "").localeCompare(x.earned_at ?? "")).slice(0, 3);
  });
  let nextUp = $derived.by(() => {
    if (!ach) return [] as Item[];
    const pct = (i: Item) => (i.kind === "ladder" ? (i.next ? i.progress : -1) : i.earned || !i.progress ? -1 : (i.progress.value / i.progress.need) * 100);
    const shown = new Set(latest.map((i) => i.code));
    return ([...ach.ladders, ...ach.badges] as Item[]).filter((i) => !shown.has(i.code) && pct(i) >= 0 && pct(i) < 100)
      .sort((x, y) => pct(y) - pct(x)).slice(0, 3);
  });

  const BOARDS: { key: Board; label: string }[] = [{ key: "new", label: "New streets" }, { key: "miles", label: "Miles" }, { key: "drives", label: "Drives" }];
  const PERIODS: { key: Period; label: string }[] = [{ key: "week", label: "This week" }, { key: "month", label: "This month" }, { key: "all", label: "All time" }];
  function score(r: LeaderRow) {
    if (board === "new") return `${miles(r.value)} · ${r.extra.toLocaleString()} segment${r.extra === 1 ? "" : "s"}`;
    if (board === "miles") return `${miles(r.value)} · ${r.extra} drive${r.extra === 1 ? "" : "s"}`;
    return `${r.value} drive${r.value === 1 ? "" : "s"} · ${miles(r.extra)}`;
  }
  const clock = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
</script>

<div class="page">
  <div class="page-head">
    <h1>{personal ? `Hi, ${me.display_name.split(" ")[0]}` : team?.name}</h1>
    {#if teams.length > 1}
      <select class="switch-team" bind:value={teamId} aria-label="Whose figures">
        {#each teams as t (t.id)}<option value={t.id}>{t.kind === "personal" ? "Just me" : t.name}</option>{/each}
      </select>
    {/if}
  </div>

  {#if error}<p class="notice error">{error}</p>{/if}

  <!-- Figures -->
  <div class="tiles">
    <div class="card tile">
      <span class="muted small">New streets</span>
      <strong>{stats ? miles(stats.total.street_m) : "—"}</strong>
      <span class="small muted">{stats ? `${miles(stats.month.street_m)} this month` : " "}</span>
    </div>
    <div class="card tile">
      <span class="muted small">Street segments</span>
      <strong>{stats ? stats.total.streets.toLocaleString() : "—"}</strong>
      <span class="small muted">{stats ? `${stats.month.streets.toLocaleString()} this month` : " "}</span>
    </div>
    <div class="card tile">
      <span class="muted small">Driven</span>
      <strong>{stats ? miles(stats.total.drive_m) : "—"}</strong>
      <span class="small muted">{stats ? `${miles(stats.month.drive_m)} this month` : " "}</span>
    </div>
    <div class="card tile">
      <span class="muted small">{personal ? "Drives" : "Drivers this month"}</span>
      <strong>{stats ? (personal ? stats.total.drives : `${stats.month_drivers} of ${stats.members}`) : "—"}</strong>
      <span class="small muted">{stats ? (personal ? `${stats.month.drives} this month` : `${stats.total.drives} drives in all`) : " "}</span>
    </div>
  </div>

  {#if stats}
    <section class="card pad">
      <WeekChart weeks={stats.weeks} title="Miles of new street per week" />
    </section>
  {/if}

  <div class="cols">
    <!-- Areas -->
    <section class="card pad stack">
      <div class="section-head"><h2>Areas</h2><a class="small" href="/map">Map</a></div>
      {#if progressAreas.length}
        <div class="areas">
          {#each progressAreas as { a, pct } (a.id)}
            <div class="area">
              <div class="area-head"><span class="ellipsis"><strong>{a.name}</strong></span><span class="pct">{percent(a.driven_m ?? 0, a.total_m!)}</span></div>
              <span class="bar"><span style:width="{Math.min(100, pct * 100)}%" style:background={areaColors.get(a.id) ?? AREA_COLORS[0]}></span></span>
              <span class="small muted">{miles(a.driven_m)} of {miles(a.total_m)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted">No areas yet. On the <a href="/map">map</a>, follow your city or county, or draw a neighborhood{personal ? "" : " (team admins)"}.</p>
      {/if}
    </section>

    <!-- Recent drives -->
    {#if personal || isAdmin}
      <section class="card stack recent">
        <div class="section-head pad-x"><h2>Recent drives</h2><a class="small" href={personal ? "/drives" : `/drives?team=${team.id}`}>All drives</a></div>
        {#if drives?.length}
          <div class="list">
            {#each drives as d (d.id)}
              <a class="drive" href="/drives/{d.id}">
                <span class="src"><Icon name={d.source === "logger" ? "logger" : "phone"} size={16} /></span>
                <span class="grow">
                  <strong>{miles(d.distance_m)}</strong> <span class="muted small">· {duration(d.started_at, d.ended_at)} · {d.drive_type_label}</span>
                  <span class="small muted ellipsis line">{clock(d.started_at)}{!personal ? ` · ${d.user_name ?? "Driver unknown"}` : ""}</span>
                </span>
              </a>
            {/each}
          </div>
        {:else if drives}
          <p class="muted pad-x">No drives yet.</p>
        {/if}
      </section>
    {/if}
  </div>

  <!-- Leaderboard -->
  {#if !personal}
    <section class="card pad stack">
      <div class="section-head wrap">
        <h2>Leaderboard</h2>
        <div class="filters">
          <div class="seg" role="group" aria-label="Board">
            {#each BOARDS as b (b.key)}<button class:on={board === b.key} aria-pressed={board === b.key} onclick={() => (board = b.key)}>{b.label}</button>{/each}
          </div>
          <select bind:value={period} aria-label="Period">
            {#each PERIODS as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
          </select>
        </div>
      </div>
      {#if rows?.length}
        <ol class="board">
          {#each rows as r (r.user_id)}
            <li class:me={r.user_id === me.id}>
              <span class="rank" class:gold={r.rank === 1 && r.value > 0}>{r.rank}</span>
              <Avatar id={r.user_id} name={r.display_name} url={r.avatar_url} size={30} />
              <span class="grow ellipsis"><strong>{r.user_id === me.id ? "You" : r.display_name}</strong></span>
              <span class="small {r.value ? '' : 'muted'}">{r.value ? score(r) : "Nothing yet"}</span>
            </li>
          {/each}
        </ol>
        {#if board === "new"}<p class="small muted">New streets: segments a member was first in the team to sweep.</p>{/if}
      {:else if rows}
        <p class="muted">Nobody to rank yet.</p>
      {/if}
    </section>
  {/if}

  <!-- Achievements -->
  <section class="card pad stack">
    <div class="section-head">
      <h2>{personal ? "Achievements" : "Team achievements"}</h2>
      <a class="small" href={personal ? "/achievements" : `/achievements?team=${team.id}`}>{ach ? `${ach.earned_count} of ${ach.total} · see all` : "See all"}</a>
    </div>
    {#if ach && !latest.length && !nextUp.length}
      <EmptyState title="Nothing yet">Drive some new streets and they start coming.</EmptyState>
    {/if}
    {#if latest.length}
      <h3 class="small muted">Latest</h3>
      <div class="ach">{#each latest as i (i.code)}<AchievementTile item={i} compact />{/each}</div>
    {/if}
    {#if nextUp.length}
      <h3 class="small muted">Closest</h3>
      <div class="ach">{#each nextUp as i (i.code)}<AchievementTile item={i} compact />{/each}</div>
    {/if}
  </section>
</div>

<style>
  .switch-team { width: auto; min-width: 180px; font-weight: 700; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .tile { display: grid; gap: 2px; padding: 14px 16px; }
  .tile strong { font-size: 24px; letter-spacing: -.01em; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  .areas { display: grid; gap: 12px; }
  .area { display: grid; gap: 4px; }
  .area-head { display: flex; justify-content: space-between; gap: 8px; }
  .pct { font-weight: 700; font-size: 13px; }
  .bar { display: block; height: 8px; border-radius: 99px; background: var(--line); overflow: hidden; }
  .bar > span { display: block; height: 100%; border-radius: 99px; min-width: 3px; }
  .recent { padding: 18px 0 6px; }
  .pad-x { padding: 0 18px; }
  .drive { display: flex; gap: 10px; align-items: center; padding: 10px 18px; color: var(--ink); }
  .drive:hover { background: var(--surface-2); text-decoration: none; }
  .drive .line { display: block; }
  .src { width: 30px; height: 30px; border-radius: 9px; background: var(--accent-soft); color: var(--green-700); display: grid; place-items: center; flex: none; }
  .wrap { flex-wrap: wrap; }
  .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .filters select { width: auto; height: 34px; }
  .seg { display: flex; background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
  .seg button { height: 28px; border: 0; background: none; padding: 0 10px; font-size: 13px; border-radius: 7px; color: var(--ink-soft); }
  .seg button.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }
  .board { list-style: none; margin: 0; padding: 0; display: grid; }
  .board li { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-top: 1px solid var(--line); }
  .board li:first-child { border-top: 0; }
  .board li.me { background: var(--accent-soft); border-radius: 8px; }
  .rank { width: 26px; text-align: center; font-weight: 800; color: var(--ink-soft); flex: none; }
  .rank.gold { color: #b7950b; }
  h3 { margin: 0; text-transform: uppercase; letter-spacing: .04em; }
  .ach { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  @media (max-width: 860px) {
    .tiles { grid-template-columns: repeat(2, 1fr); }
    .cols { grid-template-columns: 1fr; }
  }
</style>
