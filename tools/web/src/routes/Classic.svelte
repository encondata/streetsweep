<script lang="ts">
  import Icon from "../lib/Icon.svelte";

  /** Screens not rebuilt yet: say so, and open the classic one in its place. */
  let { section }: { section: string } = $props();

  const CLASSIC: Record<string, { title: string; view: string; what: string }> = {
    drives: { title: "Drives", view: "drives", what: "every drive, with its route and what it added" },
    places: { title: "Places", view: "pois", what: "marked places, their notes and photos" },
    insights: { title: "Insights", view: "board", what: "the dashboard, analytics, leaderboard and achievements" },
    people: { title: "People", view: "people", what: "users, vehicles and signed-in phones" },
    settings: { title: "Settings", view: "settings", what: "the server, the street store and your account" },
  };
  const c = $derived(CLASSIC[section]);
</script>

<div class="wrap">
  {#if c}
    <div class="card box">
      <p class="eyebrow">Coming to the new site</p>
      <h1>{c.title}</h1>
      <p class="muted">The classic site still has {c.what}. It opens in the same tab and shares your sign-in.</p>
      <a class="btn primary" href={"/#" + c.view}>Open {c.title} in the classic site <Icon name="external" size={15} /></a>
    </div>
  {:else}
    <div class="card box"><h1>Nothing here</h1></div>
  {/if}
</div>

<style>
  .wrap { height: 100%; display: grid; place-items: center; padding: 24px; }
  .box { max-width: 480px; padding: 28px; display: grid; gap: 10px; justify-items: start; }
</style>
