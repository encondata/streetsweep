<script lang="ts">
  import type { Snippet } from "svelte";
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { ui } from "../lib/ui.svelte";

  let { children }: { children: Snippet } = $props();
  // The account button opens a small menu (your page, settings, preferences, sign out).
  let menuOpen = $state(false);
  let menuBox = $state<HTMLDivElement>();
  $effect(() => {
    router.path; router.query; // any navigation closes it
    menuOpen = false;
  });
  function onDocClick(e: MouseEvent) {
    if (menuOpen && menuBox && !menuBox.contains(e.target as Node)) menuOpen = false;
  }
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
    location.href = "/login";
  }
  let user = $derived(session.me!.user);

  let nav = $derived([
    { href: "/", label: "Home", icon: "home" },
    { href: "/map", label: "Map", icon: "map" },
    { href: "/areas", label: "Areas", icon: "areas" },
    { href: "/drives", label: "Drives", icon: "drives" },
    { href: "/places", label: "Places", icon: "pin" },
    { href: "/fleet", label: "Fleet", icon: "fleet" },
    { href: "/teams", label: "Teams", icon: "teams", count: session.pendingForMe },
    ...(user.is_site_admin ? [{ href: "/admin", label: "Admin", icon: "admin" }] : []),
  ]);
  // Home is only "/" itself (every path starts with "/"); Achievements hangs off Home.
  const on = (href: string) =>
    href === "/" ? router.path === "/" || router.path === "/achievements" : router.path === href || router.path.startsWith(href + "/");
</script>

<div class="shell">
  <main class="content">
    {@render children()}
  </main>

  <!-- Icons only, floating along the bottom (as on the iPad); names show on hover. -->
  <nav class="bar" class:away={ui.drawing} aria-label="Main">
    <ul>
      {#each nav as item (item.href)}
        <li>
          <a href={item.href} class:on={on(item.href)} aria-current={on(item.href) ? "page" : undefined}
            title={item.label} aria-label={item.label}>
            <Icon name={item.icon} size={21} />
            {#if item.count}<span class="count">{item.count}</span>{/if}
          </a>
        </li>
      {/each}
    </ul>
    <span class="divider" aria-hidden="true"></span>
    <div class="me-wrap" bind:this={menuBox}>
      {#if menuOpen}
        <div class="menu" role="menu" aria-label="Your account">
          <a class="menu-head" href="/me" role="menuitem">
            <Avatar id={user.id} name={user.display_name} url={user.avatar_url} size={40} />
            <span class="who-full"><strong class="ellipsis">{user.display_name}</strong><span class="ellipsis small muted">View your page</span></span>
          </a>
          <a href="/me?tab=settings" role="menuitem"><Icon name="gear" size={18} /> Settings</a>
          <a href="/me?tab=preferences" role="menuitem"><Icon name="palette" size={18} /> Preferences</a>
          <button class="signout" role="menuitem" onclick={signOut}><Icon name="out" size={18} /> Sign out</button>
        </div>
      {/if}
      <button class="me" class:on={menuOpen} onclick={() => (menuOpen = !menuOpen)} aria-label="Your account" title={user.display_name}
        aria-haspopup="menu" aria-expanded={menuOpen}>
        <Avatar id={user.id} name={user.display_name} url={user.avatar_url} size={32} />
      </button>
    </div>
  </nav>
</div>

<svelte:document onclick={onDocClick} onkeydown={(e) => { if (e.key === "Escape") menuOpen = false; }} />

<style>
  .shell { min-height: 100vh; min-height: 100dvh; }
  .content { min-width: 0; }
  .bar {
    position: fixed; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom)); z-index: 30;
    transform: translateX(-50%); display: flex; align-items: center; gap: 4px; padding: 6px;
    background: rgba(255, 255, 255, .86); backdrop-filter: blur(16px) saturate(1.4); -webkit-backdrop-filter: blur(16px) saturate(1.4);
    border: 1px solid var(--line); border-radius: 999px; box-shadow: 0 8px 28px rgba(13, 27, 40, .16);
    transition: transform .25s ease, opacity .25s ease;
  }
  .bar.away { transform: translate(-50%, 140%); opacity: 0; pointer-events: none; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; gap: 4px; }
  ul a {
    position: relative; display: grid; place-items: center; width: 54px; height: 46px; border-radius: 14px;
    color: var(--ink-soft);
  }
  ul a:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }
  ul a.on { background: var(--accent-soft); color: var(--green-700); }
  .count { position: absolute; top: 3px; right: 6px; }
  .divider { width: 1px; height: 28px; background: var(--line); margin: 0 4px; }
  .me-wrap { position: relative; }
  .me {
    width: 54px; height: 46px; padding: 0; border: 0; background: none; border-radius: 14px; display: grid; place-items: center;
  }
  .me:hover:not([disabled]), .me.on { background: var(--surface-2); }
  .menu {
    position: absolute; right: 0; bottom: calc(100% + 14px); width: 240px; z-index: 31; display: grid; padding: 6px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 28px rgba(13, 27, 40, .16);
  }
  .menu a, .menu button {
    display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; color: var(--ink);
    font-weight: 600; font-size: 14px; height: auto; border: 0; background: none; justify-content: flex-start; width: 100%;
  }
  .menu a:hover, .menu button:hover:not([disabled]) { background: var(--surface-2); text-decoration: none; }
  .menu-head { border-bottom: 1px solid var(--line); border-radius: 8px 8px 0 0 !important; margin-bottom: 4px; padding-bottom: 10px !important; }
  .who-full { display: grid; min-width: 0; line-height: 1.3; }
  .signout { color: var(--danger) !important; }

  /* Narrow screens: the bar spans the width and the icons share it. */
  @media (max-width: 640px) {
    .bar { left: 8px; right: 8px; transform: none; bottom: calc(8px + env(safe-area-inset-bottom)); }
    .bar.away { transform: translateY(140%); }
    ul { flex: 1; justify-content: space-around; gap: 0; }
    ul a, .me { width: 42px; }
  }
</style>
