<script lang="ts">
  import Shell from "./components/Shell.svelte";
  import Teams from "./routes/Teams.svelte";
  import Team from "./routes/Team.svelte";
  import Join from "./routes/Join.svelte";
  import Admin from "./routes/Admin.svelte";
  import Soon from "./routes/Soon.svelte";
  import { router, match } from "./lib/router.svelte";
  import { session } from "./lib/session.svelte";
  import { errorText } from "./lib/api";

  let failed = $state<string | null>(null);
  session.load().catch((e) => (failed = errorText(e)));

  // Until the map arrives (stage 3), Teams is home.
  $effect(() => {
    if (router.path === "/") router.go("/teams", true);
  });

  let teamParams = $derived(match("/teams/:id", router.path) ?? match("/teams/:id/:tab", router.path));
  let joinParams = $derived(match("/join/:code", router.path));
  let adminParams = $derived(router.path === "/admin" ? { tab: "users" } : match("/admin/:tab", router.path));
</script>

{#if failed}
  <div class="boot"><p>{failed}</p><button onclick={() => location.reload()}>Try again</button></div>
{:else if !session.me}
  <div class="boot"><img src="/login-mark.png" alt="" width="64" /></div>
{:else}
  <Shell>
    {#if router.path === "/teams"}
      <Teams />
    {:else if teamParams}
      {#key teamParams.id}<Team id={teamParams.id} tab={teamParams.tab ?? "members"} />{/key}
    {:else if joinParams}
      {#key joinParams.code}<Join code={joinParams.code} />{/key}
    {:else if adminParams && session.me.user.is_site_admin}
      <Admin tab={adminParams.tab} />
    {:else if router.path === "/map"}
      <Soon title="Map" stage={3} art="empty-areas.png">Areas, streets and your coverage, drawn and built on the server.</Soon>
    {:else if router.path === "/drives"}
      <Soon title="Drives" stage={4} art="empty-drives.png">Every drive from phones and loggers, matched to streets and counted for your teams.</Soon>
    {:else if router.path === "/fleet"}
      <Soon title="Fleet" stage={2} art="empty-vehicles.png">Cars, permanent assignments, check-out and return, phones and GPS loggers.</Soon>
    {:else}
      <Soon title="Not found" art={undefined}>There's nothing at this address. <a href="/teams">Go to Teams</a>.</Soon>
    {/if}
  </Shell>
{/if}

<style>
  .boot { min-height: 100vh; display: grid; place-content: center; justify-items: center; gap: 12px; background: var(--bg); color: var(--ink); }
  .boot img { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .5; } }
</style>
