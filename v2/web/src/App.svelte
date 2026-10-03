<script lang="ts">
  // Stage 0 shell: proves the build and the api round trip. The signed-in app
  // (sidebar, map, teams, fleet) replaces this from stage 1.
  type Health = { ok: boolean; postgis?: string; migrations?: number; error?: string };
  let health = $state<Health | null>(null);

  fetch("/api/health")
    .then((r) => r.json())
    .then((h: Health) => (health = h))
    .catch((e) => (health = { ok: false, error: String(e) }));
</script>

<main>
  <img src="/wordmark-light.png" srcset="/wordmark-light@2x.png 2x" alt="StreetSweep" />
  <p class="tag">v2 is under construction.</p>
  <p class="status" class:bad={health && !health.ok}>
    {#if !health}
      Checking the server…
    {:else if health.ok}
      Server ready. PostGIS {health.postgis}, {health.migrations} migration{health.migrations === 1 ? "" : "s"} applied.
    {:else}
      Server problem: {health.error}
    {/if}
  </p>
  <a href="/login">Go to sign in</a>
</main>

<style>
  main { min-height: 100%; display: grid; place-content: center; gap: 12px; text-align: center; padding: 24px; }
  img { width: min(320px, 80vw); margin: 0 auto; }
  .tag { color: var(--ink-soft); margin: 0; }
  .status { margin: 0; color: var(--green-400); }
  .status.bad { color: #ff8a80; }
  a { color: var(--green-400); }
</style>
