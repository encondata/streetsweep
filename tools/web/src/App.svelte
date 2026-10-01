<script lang="ts">
  import { onMount } from "svelte";
  import { router, href, link } from "./lib/router.svelte";
  import { store } from "./lib/store.svelte";
  import { api } from "./lib/api";
  import Icon from "./lib/Icon.svelte";
  import Workspace from "./routes/Workspace.svelte";
  import Classic from "./routes/Classic.svelte";

  onMount(() => { store.load(); });

  /** Where things are. Map holds the areas and streets; the rest come over from v1 in turn. */
  const NAV = [
    { to: "/map", icon: "map", label: "Map" },
    { to: "/drives", icon: "drives", label: "Drives" },
    { to: "/places", icon: "places", label: "Places" },
    { to: "/insights", icon: "insights", label: "Insights" },
    { to: "/people", icon: "people", label: "People", admin: true },
    { to: "/settings", icon: "settings", label: "Settings" },
  ];

  const section = $derived(router.parts[0] || "map");

  let theme = $state<string>(document.documentElement.dataset.theme || "");
  function toggleTheme() {
    const dark = theme === "dark" || (!theme && matchMedia("(prefers-color-scheme: dark)").matches);
    theme = dark ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("streetsweep.theme", theme); } catch {}
    dispatchEvent(new Event("themechange"));
  }

  let menu = $state(false);
  async function signOut() {
    await api.logout().catch(() => {});
    location.href = "/login";
  }
</script>

<div class="shell">
  <nav class="rail" aria-label="Main">
    <a class="brand" href={href("/map")} use:link title="StreetSweep">
      <img src="/logo-mark.png" alt="StreetSweep" width="34" height="34" />
    </a>
    {#each NAV as item}
      {#if !item.admin || store.me?.role === "admin"}
        <a class="item" class:on={section === item.to.slice(1)} href={href(item.to)} use:link
          aria-current={section === item.to.slice(1) ? "page" : undefined}>
          <Icon name={item.icon} size={21} />
          <span>{item.label}</span>
        </a>
      {/if}
    {/each}
    <div class="grow"></div>
    <button class="ghost icon" onclick={toggleTheme} title="Light or dark">
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
    <div class="me">
      <button class="avatar" onclick={() => (menu = !menu)} title={store.me?.name || ""} aria-expanded={menu}>
        {(store.me?.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
      </button>
      {#if menu}
        <div class="menu card">
          <div class="who">
            <b>{store.me?.name}</b>
            <span class="muted">{store.me?.email}</span>
          </div>
          <a class="btn ghost" href="/">Open classic site <Icon name="external" size={15} /></a>
          <button class="ghost" onclick={signOut}><Icon name="logout" size={16} /> Sign out</button>
        </div>
      {/if}
    </div>
  </nav>

  <main>
    {#if store.error}
      <div class="fail card">
        <h2>Could not reach the server</h2>
        <p class="muted">{store.error}</p>
        <button onclick={() => { store.error = null; store.load(); }}>Try again</button>
      </div>
    {:else if !store.loaded}
      <div class="loading muted">Loading…</div>
    {:else if section === "map"}
      <Workspace />
    {:else}
      <Classic section={section} />
    {/if}
  </main>
</div>

<style>
  .shell { display: grid; grid-template-columns: var(--rail) 1fr; height: 100%; }
  .rail {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    background: var(--navy-950); padding: 10px 0; z-index: 5;
  }
  .brand { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 10px; }
  .item {
    display: grid; justify-items: center; gap: 2px; width: 56px; padding: 7px 0 6px;
    border-radius: 10px; color: #8ea1b3; text-decoration: none; font-size: 10.5px; font-weight: 550;
  }
  .item:hover { color: #e6edf4; background: rgba(255, 255, 255, 0.06); }
  .item.on { color: #fff; background: rgba(94, 212, 95, 0.16); }
  .item.on :global(svg) { color: #6fe070; }
  .grow { flex: 1; }
  .rail > button.ghost { color: #8ea1b3; }
  .rail > button.ghost:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .me { position: relative; margin-top: 6px; }
  .avatar {
    width: 36px; height: 36px; min-height: 0; padding: 0; border-radius: 50%;
    background: var(--green-600); border: 0; color: #fff; font-size: 12px; font-weight: 700;
  }
  .avatar:hover { background: var(--green-500); }
  .menu {
    position: absolute; left: 46px; bottom: 0; width: 240px; padding: 8px; display: grid; gap: 2px; z-index: 50;
  }
  .menu .who { display: grid; padding: 6px 8px 10px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
  .menu .who span { font-size: 12px; }
  .menu .btn, .menu button { justify-content: flex-start; }
  main { position: relative; min-width: 0; height: 100%; overflow: hidden; }
  .loading { display: grid; place-items: center; height: 100%; }
  .fail { max-width: 420px; margin: 80px auto; padding: 24px; display: grid; gap: 10px; }
</style>
