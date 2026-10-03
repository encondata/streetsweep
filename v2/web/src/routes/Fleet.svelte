<script lang="ts">
  import Vehicles from "./fleet/Vehicles.svelte";
  import Loggers from "./fleet/Loggers.svelte";
  import Phones from "./fleet/Phones.svelte";

  let { tab }: { tab: string } = $props();
  const TABS = [
    { key: "vehicles", label: "Vehicles" },
    { key: "loggers", label: "Loggers" },
    { key: "phones", label: "Phones" },
  ];
</script>

<div class="page">
  <div class="page-head"><h1>Fleet</h1></div>
  <nav class="tabs">
    {#each TABS as t (t.key)}<a href="/fleet/{t.key}" class:on={tab === t.key}>{t.label}</a>{/each}
  </nav>
  {#if tab === "loggers"}<Loggers />{:else if tab === "phones"}<Phones />{:else}<Vehicles />{/if}
</div>
