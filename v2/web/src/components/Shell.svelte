<script lang="ts">
  import type { Snippet } from "svelte";
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";

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
  <nav class="side" aria-label="Main">
    <a class="brand" href="/" aria-label="StreetSweep home">
      <img class="mark" src="/login-mark.png" alt="" />
      <img class="word" src="/wordmark.png" srcset="/wordmark@2x.png 2x" alt="StreetSweep" />
    </a>
    <ul>
      {#each nav as item (item.href)}
        <li>
          <a href={item.href} class:on={on(item.href)} aria-current={on(item.href) ? "page" : undefined}>
            <Icon name={item.icon} />
            <span class="label">{item.label}</span>
            {#if item.count}<span class="count">{item.count}</span>{/if}
          </a>
        </li>
      {/each}
    </ul>
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
      <button class="me" class:on={menuOpen} onclick={() => (menuOpen = !menuOpen)} aria-label="Your account" aria-haspopup="menu" aria-expanded={menuOpen}>
        <Avatar id={user.id} name={user.display_name} url={user.avatar_url} size={34} />
        <span class="who">
          <strong class="ellipsis">{user.display_name}</strong>
          <span class="ellipsis">{user.email}</span>
        </span>
      </button>
    </div>
  </nav>

  <main class="content">
    {@render children()}
  </main>
</div>

<svelte:document onclick={onDocClick} onkeydown={(e) => { if (e.key === "Escape") menuOpen = false; }} />

<style>
  .shell { display: grid; grid-template-columns: 236px 1fr; min-height: 100vh; }
  .side {
    position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 6px;
    background: var(--surface); color: var(--ink); padding: 18px 12px; border-right: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 4px 10px 18px; }
  .brand:hover { text-decoration: none; }
  .mark { width: 30px; height: auto; }
  .word { width: 136px; height: auto; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  ul a {
    display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px;
    color: var(--ink-soft); font-weight: 600;
  }
  ul a:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }
  ul a.on { background: var(--accent-soft); color: var(--green-700); box-shadow: inset 3px 0 0 var(--green-600); }
  .label { flex: 1; }
  .me {
    margin-top: auto; height: auto; padding: 10px; border-radius: 12px; justify-content: flex-start; gap: 10px;
    background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); text-align: left; width: 100%;
  }
  .me:hover:not([disabled]) { background: var(--bg); }
  .who { display: grid; min-width: 0; font-size: 12.5px; line-height: 1.3; }
  .who span { color: var(--ink-soft); font-weight: 400; }
  .content { min-width: 0; }
  .me-wrap { position: relative; margin-top: auto; }
  .me-wrap .me { margin-top: 0; }
  .me.on { background: var(--accent-soft); border-color: var(--green-600); }
  .menu {
    position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: 20; display: grid; padding: 6px;
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

  /* Phone: the sidebar becomes a bottom bar; the account button moves into it. */
  @media (max-width: 760px) {
    .shell { grid-template-columns: 1fr; }
    .side {
      position: fixed; inset: auto 0 0 0; height: auto; z-index: 10; flex-direction: row; align-items: center;
      padding: 6px 6px calc(6px + env(safe-area-inset-bottom)); border-right: 0; border-top: 1px solid var(--line);
    }
    .brand, .who { display: none; }
    ul { grid-auto-flow: column; flex: 1; }
    ul a { flex-direction: column; gap: 2px; padding: 6px 4px; font-size: 11px; justify-content: center; position: relative; }
    ul a.on { box-shadow: none; }
    .count { position: absolute; top: 0; right: 18%; }
    .me { margin: 0; width: auto; padding: 4px; background: none; border: 0; }
    .me-wrap { margin: 0; }
    .menu { left: auto; right: 0; width: 230px; bottom: calc(100% + 10px); }
  }
</style>
