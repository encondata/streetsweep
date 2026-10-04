<script lang="ts">
  // Every achievement, yours or a shared team's: ladders first (each level as a strip),
  // then badges by kind.
  import AchievementTile from "../components/AchievementTile.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { date } from "../lib/format";
  import { TIER_LABEL, type AchievementSet, type Badge } from "../lib/types";

  let shared = $derived(session.me!.teams.filter((t) => t.kind === "shared"));
  let teamId = $derived(router.query.get("team"));
  let team = $derived(shared.find((t) => t.id === teamId) ?? null);

  let ach = $state<AchievementSet | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const url = team ? `/api/teams/${team.id}/achievements` : "/api/achievements";
    ach = null;
    error = null;
    api<AchievementSet>(url).then((a) => (ach = a), (e) => (error = errorText(e)));
  });

  const CATEGORY: Record<string, string> = {
    areas: "Areas", exploration: "Exploring", drives: "Big drives", special: "Habits", together: "Together", progression: "Progress",
  };
  let groups = $derived.by(() => {
    const out: { key: string; items: Badge[] }[] = [];
    for (const b of ach?.badges ?? []) {
      let g = out.find((x) => x.key === b.category);
      if (!g) out.push((g = { key: b.category, items: [] }));
      g.items.push(b);
    }
    return out;
  });
</script>

<div class="page">
  <div class="page-head">
    <h1>Achievements</h1>
    {#if ach}<span class="badge green">{ach.earned_count} of {ach.total}</span>{/if}
  </div>

  {#if shared.length}
    <nav class="tabs" aria-label="Whose achievements">
      <a href="/achievements" class:on={!team}>Yours</a>
      {#each shared as t (t.id)}<a href="/achievements?team={t.id}" class:on={team?.id === t.id}>{t.name}</a>{/each}
    </nav>
  {/if}

  <p class="muted">
    {#if team}Earned by {team.name} together, from the streets its drivers sweep for it.
    {:else}Earned from your own drives: streets you drove for the first time, your share of each area, and when you drive.{/if}
  </p>

  {#if error}<p class="notice error">{error}</p>{/if}

  {#if ach}
    {#each ach.ladders as l (l.code)}
      <section class="card pad stack">
        <AchievementTile item={l} />
        <div class="steps">
          {#each l.steps as s (s.level)}
            <div class="step" class:got={s.earned} title="{s.name}: {s.need.toLocaleString()} {l.unit}{s.earned_at ? `, ${date(s.earned_at)}` : ''}">
              <img src="/ach-{s.art}.webp" alt="" loading="lazy" onerror={(e) => ((e.currentTarget as HTMLImageElement).src = `/ach-tier_${s.tier}.webp`)} />
              <span class="small"><strong>{s.name}</strong></span>
              <span class="small muted">{s.need.toLocaleString()} {s.need === 1 ? l.unit.replace(/s$/, "") : l.unit} · {TIER_LABEL[s.tier]}</span>
            </div>
          {/each}
        </div>
      </section>
    {/each}

    {#each groups as g (g.key)}
      <section class="section">
        <h2>{CATEGORY[g.key] ?? g.key}</h2>
        <div class="grid">{#each g.items as b (b.code)}<AchievementTile item={b} />{/each}</div>
      </section>
    {/each}
    <p class="small muted">Rarity is out of the {ach.eligible.toLocaleString()} {team ? "teams" : "people"} who have swept any streets.</p>
  {/if}
</div>

<style>
  .steps { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(110px, 1fr); gap: 8px; overflow-x: auto; padding-bottom: 4px; }
  .step { display: grid; justify-items: center; text-align: center; gap: 2px; padding: 8px 6px; border-radius: 10px; background: var(--surface-2); }
  .step img { width: 52px; height: 52px; object-fit: contain; filter: grayscale(1); opacity: .4; }
  .step.got img { filter: none; opacity: 1; }
  .step.got { background: var(--accent-soft); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
</style>
