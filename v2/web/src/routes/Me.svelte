<script lang="ts">
  // Your page: who you are up top, then Account (picture, name, email, password, sign
  // out), Preferences (how maps look for you) and Settings (how the app behaves).
  import Avatar from "../components/Avatar.svelte";
  import ShadePrefs from "../components/ShadePrefs.svelte";
  import ColorPrefs from "../components/ColorPrefs.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { cropToBlob } from "../lib/image";
  import { formValues } from "../lib/forms";
  import { date } from "../lib/format";
  import { DEFAULT_COLORS, DEFAULT_COMPLETE_FILL, completeFill, myColors, sameFill, samePair, shadeComplete, type MapColors } from "../lib/colors";
  import { mySettings, type AppSettings } from "../lib/settings";
  import type { Me } from "../lib/types";

  type Tab = "account" | "preferences" | "settings";
  const TABS: { key: Tab; label: string }[] = [
    { key: "account", label: "Account" }, { key: "preferences", label: "Preferences" }, { key: "settings", label: "Settings" },
  ];
  let tab = $derived<Tab>((TABS.find((t) => t.key === router.query.get("tab"))?.key) ?? "account");

  let user = $derived(session.me!.user);
  let teams = $derived(session.me!.teams);
  let busy = $state(false);
  let msg = $state<{ text: string; error?: boolean } | null>(null);
  $effect(() => { tab; msg = null; });

  async function run(fn: () => Promise<void>, done: string) {
    busy = true;
    msg = null;
    try {
      await fn();
      msg = { text: done };
    } catch (e) {
      msg = { text: errorText(e), error: true };
    } finally {
      busy = false;
    }
  }

  // ---- account ----
  let name = $state(session.me!.user.display_name);
  let email = $state(session.me!.user.email);
  let current = $state("");
  let next = $state("");
  let again = $state("");
  let mismatch = $derived(again.length > 0 && again !== next);
  let fileInput = $state<HTMLInputElement>();

  const saveProfile = () =>
    run(async () => session.set(await api<Me>("/api/me", { method: "PATCH", body: { displayName: name, email } })), "Saved.");
  const changePassword = () =>
    run(async () => {
      if (next !== again) throw new Error("The two new passwords don't match.");
      await api("/api/me/password", { body: { current, next } });
      current = next = again = "";
    }, "Password changed. Other browsers will need to sign in again.");
  async function pickPicture(file: File | undefined) {
    if (!file) return;
    await run(async () => session.set(await api<Me>("/api/me/avatar", { method: "PUT", raw: await cropToBlob(file, 256, 256) })), "Picture updated.");
    if (fileInput) fileInput.value = "";
  }
  const removePicture = () => run(async () => session.set(await api<Me>("/api/me/avatar", { method: "DELETE" })), "Picture removed.");
  async function signOut() {
    await api("/api/auth/logout", { body: {} }).catch(() => {});
    location.href = "/login";
  }

  // ---- preferences ----
  const clone = (c: MapColors): MapColors => ({ driven: { ...c.driven }, undriven: { ...c.undriven } });
  let colors = $state<MapColors>(clone(myColors()));
  const saveColors = () =>
    run(async () => session.set(await api<Me>("/api/me/preferences", { method: "PATCH", body: { map_colors: colors } })), "Saved. Maps use your colours from now on.");

  // Finished areas: the switch saves straight away; the colour and opacity with Save.
  let fill = $state({ ...completeFill() });
  let fillChanged = $derived(!sameFill(fill, completeFill()));
  const saveFill = () =>
    run(async () => session.set(await api<Me>("/api/me/preferences", { method: "PATCH", body: { complete_fill: fill } })), "Saved.");

  const setShade = (on: boolean) =>
    run(async () => session.set(await api<Me>("/api/me/preferences", { method: "PATCH", body: { shade_complete: on } })),
      on ? "Finished areas are shaded." : "Finished areas look like the rest.");

  // ---- settings ----
  let settings = $state<Required<AppSettings>>({
    start_page: mySettings().start_page ?? "home", base: mySettings().base ?? "map", team_id: mySettings().team_id ?? null,
  });
  let settingsChanged = $derived(
    settings.start_page !== (mySettings().start_page ?? "home") || settings.base !== (mySettings().base ?? "map")
    || settings.team_id !== (mySettings().team_id ?? null),
  );
  const saveSettings = () =>
    run(async () => {
      session.set(await api<Me>("/api/me/preferences", { method: "PATCH", body: { settings } }));
      // This browser follows the new defaults straight away.
      try {
        localStorage.setItem("streetsweep.base", settings.base);
        for (const k of ["streetsweep.areasTeam", "streetsweep.homeTeam"]) localStorage.removeItem(k);
      } catch { /* fine */ }
    }, "Saved.");
</script>

<div class="page">
  <section class="hero card">
    <div class="who">
      <div class="pic">
        <Avatar id={user.id} name={user.display_name} url={user.avatar_url} size={84} />
        <button class="pic-btn" disabled={busy} onclick={() => fileInput?.click()} aria-label={user.avatar_url ? "Change picture" : "Add a picture"} title={user.avatar_url ? "Change picture" : "Add a picture"}>
          <Icon name="camera" size={15} />
        </button>
        <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={(e) => pickPicture(e.currentTarget.files?.[0])} />
      </div>
      <div class="id">
        <h1>{user.display_name}</h1>
        <p class="muted">{user.email}</p>
        <p class="small muted">
          Member since {date(user.created_at)} · {teams.filter((t) => t.kind === "shared").length || "no"} shared {teams.filter((t) => t.kind === "shared").length === 1 ? "team" : "teams"}
          {#if user.is_site_admin} · <span class="badge green">Site admin</span>{/if}
        </p>
      </div>
    </div>
    <nav class="tabs" aria-label="Your page">
      {#each TABS as t (t.key)}<a href="/me?tab={t.key}" class:on={tab === t.key} aria-current={tab === t.key ? "page" : undefined}>{t.label}</a>{/each}
    </nav>
  </section>

  {#if msg}<p class="notice" class:error={msg.error}>{msg.text}</p>{/if}

  {#if tab === "account"}
    <section class="card pad stack">
      <h2>Profile</h2>
      <div class="inline">
        <button disabled={busy} onclick={() => fileInput?.click()}>{user.avatar_url ? "Change picture" : "Add a picture"}</button>
        {#if user.avatar_url}<button class="ghost" disabled={busy} onclick={removePicture}>Remove picture</button>{/if}
      </div>
      <form class="stack" onsubmit={(e) => { e.preventDefault(); const f = formValues(e.currentTarget); name = f.name ?? name; email = f.email ?? email; saveProfile(); }}>
        <label class="field">Name <span class="help">What teammates see on drives and leaderboards.</span>
          <input type="text" name="name" bind:value={name} maxlength="80" autocomplete="name" required /></label>
        <label class="field">Email <input type="email" name="email" bind:value={email} autocomplete="email" required /></label>
        <div><button type="submit" class="primary" disabled={busy}>Save</button></div>
      </form>
    </section>

    <section class="card pad stack">
      <form class="stack" onsubmit={(e) => { e.preventDefault(); const f = formValues(e.currentTarget); current = f.current ?? current; next = f.next ?? next; again = f.again ?? again; changePassword(); }}>
        <h2>Password</h2>
        <label class="field">Current password <input type="password" name="current" bind:value={current} autocomplete="current-password" required /></label>
        <label class="field">New password <span class="help">At least 8 characters.</span>
          <input type="password" name="next" bind:value={next} autocomplete="new-password" minlength="8" required /></label>
        <label class="field">New password again
          <input type="password" name="again" bind:value={again} autocomplete="new-password" minlength="8" required aria-invalid={mismatch} /></label>
        {#if mismatch}<p class="small err">The two new passwords don't match.</p>{/if}
        <div><button type="submit" disabled={busy || mismatch || !again}>Change password</button></div>
      </form>
    </section>

    <section class="card pad stack">
      <h2>Sign out</h2>
      <p class="muted small">Signs this browser out. Phones stay signed in until you sign them out there, or remove them under <a href="/fleet/phones">Fleet → Phones</a>.</p>
      <div><button class="danger" onclick={signOut}>Sign out</button></div>
    </section>

  {:else if tab === "preferences"}
    <section class="card pad stack">
      <div>
        <h2>Street colours</h2>
        <p class="muted small">How driven and not-yet-driven streets look on your maps. Pick a set that reads well where you look most: some stand out better on satellite imagery.</p>
      </div>
      <ColorPrefs bind:value={colors} />
      <div class="btns">
        <button class="ghost" disabled={busy || samePair(colors, DEFAULT_COLORS)} onclick={() => (colors = clone(DEFAULT_COLORS))}>Back to the default</button>
        <button class="primary" disabled={busy || samePair(colors, myColors())} onclick={saveColors}>Save</button>
      </div>
    </section>

    <section class="card pad stack">
      <div class="toggle-row">
        <span class="shade-swatch" style:background={fill.color} style:opacity={Math.max(0.15, fill.opacity * 2.5)} style:border-color={fill.color} aria-hidden="true"></span>
        <div class="grow">
          <h2>Shade finished areas</h2>
          <p class="muted small">An area with every street driven (or marked done) gets a faint fill on the map, so finished ground stands out.</p>
        </div>
        <label class="switch" aria-label="Shade finished areas">
          <input type="checkbox" checked={shadeComplete()} disabled={busy} onchange={(e) => setShade(e.currentTarget.checked)} />
          <span></span>
        </label>
      </div>
      {#if shadeComplete()}
        <ShadePrefs bind:value={fill} />
        <div class="btns">
          <button class="ghost" disabled={busy || sameFill(fill, DEFAULT_COMPLETE_FILL)} onclick={() => (fill = { ...DEFAULT_COMPLETE_FILL })}>Back to the default</button>
          <button class="primary" disabled={busy || !fillChanged} onclick={saveFill}>Save</button>
        </div>
      {/if}
    </section>

  {:else}
    <section class="card pad stack">
      <h2>When you open StreetSweep</h2>
      <label class="field">Start on
        <select bind:value={settings.start_page}>
          <option value="home">Home</option><option value="map">Map</option><option value="drives">Drives</option>
        </select>
      </label>
      <label class="field">Team shown first
        <span class="help">On Home and the map. Switching there is remembered on that browser.</span>
        <select bind:value={settings.team_id}>
          <option value={null}>Just me</option>
          {#each teams.filter((t) => t.kind === "shared") as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
      </label>
      <label class="field">Map style
        <select bind:value={settings.base}>
          <option value="map">Map</option><option value="satellite">Satellite</option><option value="hybrid">Hybrid (satellite with labels)</option>
        </select>
      </label>
      <div class="btns"><button class="primary" disabled={busy || !settingsChanged} onclick={saveSettings}>Save</button></div>
    </section>
  {/if}
</div>

<style>
  .hero { padding: 22px 22px 0; display: grid; gap: 18px; }
  .who { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  .pic { position: relative; flex: none; }
  .pic-btn {
    position: absolute; right: -4px; bottom: -4px; width: 32px; height: 32px; padding: 0; border-radius: 50%;
    background: var(--surface); box-shadow: var(--shadow);
  }
  .id { display: grid; gap: 2px; min-width: 0; }
  .id h1 { margin: 0; }
  .id p { margin: 0; }
  .tabs { margin: 0 -22px; padding: 0 22px; }
  .inline { display: flex; gap: 8px; flex-wrap: wrap; }
  .btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .toggle-row { display: flex; align-items: center; gap: 14px; }
  .toggle-row h2 { margin: 0 0 2px; }
  .toggle-row p { margin: 0; }
  .shade-swatch { width: 34px; height: 34px; border-radius: 8px; border: 2px solid; flex: none; }
  .err { color: var(--danger); margin: 0; }
</style>
