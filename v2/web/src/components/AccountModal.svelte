<script lang="ts">
  // Account errands only: picture, name and email, password, sign out.
  import Modal from "./Modal.svelte";
  import Avatar from "./Avatar.svelte";
  import { api, errorText } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import { cropToBlob } from "../lib/image";
  import { formValues } from "../lib/forms";
  import type { Me } from "../lib/types";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let user = $derived(session.me!.user);

  let name = $state("");
  let email = $state("");
  let current = $state("");
  let next = $state("");
  let msg = $state<{ text: string; error?: boolean } | null>(null);
  let busy = $state(false);
  let fileInput: HTMLInputElement;

  $effect(() => {
    if (open) {
      name = user.display_name;
      email = user.email;
      current = next = "";
      msg = null;
    }
  });

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

  const saveProfile = () =>
    run(async () => session.set(await api<Me>("/api/me", { method: "PATCH", body: { displayName: name, email } })), "Saved.");

  const changePassword = () =>
    run(async () => {
      await api("/api/me/password", { body: { current, next } });
      current = next = "";
    }, "Password changed. Other browsers will need to sign in again.");

  async function pickPicture(file: File | undefined) {
    if (!file) return;
    await run(async () => {
      session.set(await api<Me>("/api/me/avatar", { method: "PUT", raw: await cropToBlob(file, 256, 256) }));
    }, "Picture updated.");
    fileInput.value = "";
  }

  const removePicture = () => run(async () => session.set(await api<Me>("/api/me/avatar", { method: "DELETE" })), "Picture removed.");

  async function signOut() {
    await api("/api/auth/logout", { body: {} }).catch(() => {});
    location.href = "/login";
  }
</script>

<Modal bind:open title="Your account">
  <div class="pic">
    <Avatar id={user.id} name={user.display_name} url={user.avatar_url} size={72} />
    <div class="pic-actions">
      <button class="sm" disabled={busy} onclick={() => fileInput.click()}>{user.avatar_url ? "Change picture" : "Add a picture"}</button>
      {#if user.avatar_url}<button class="sm ghost" disabled={busy} onclick={removePicture}>Remove</button>{/if}
      <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={(e) => pickPicture(e.currentTarget.files?.[0])} />
    </div>
  </div>

  {#if msg}<p class="notice" class:error={msg.error}>{msg.text}</p>{/if}

  <form class="stack" onsubmit={(e) => { e.preventDefault(); const f = formValues(e.currentTarget); name = f.name ?? name; email = f.email ?? email; saveProfile(); }}>
    <label class="field">Name <input type="text" name="name" bind:value={name} maxlength="80" autocomplete="name" required /></label>
    <label class="field">Email <input type="email" name="email" bind:value={email} autocomplete="email" required /></label>
    <div><button type="submit" disabled={busy}>Save</button></div>
  </form>

  <hr />

  <form class="stack" onsubmit={(e) => { e.preventDefault(); const f = formValues(e.currentTarget); current = f.current ?? current; next = f.next ?? next; changePassword(); }}>
    <h3>Change password</h3>
    <label class="field">Current password <input type="password" name="current" bind:value={current} autocomplete="current-password" required /></label>
    <label class="field">New password <span class="help">At least 8 characters.</span>
      <input type="password" name="next" bind:value={next} autocomplete="new-password" minlength="8" required /></label>
    <div><button type="submit" disabled={busy}>Change password</button></div>
  </form>

  {#snippet footer()}
    <button class="danger" onclick={signOut}>Sign out</button>
    <a class="btn ghost prefs" href="/me" onclick={() => (open = false)}>Preferences</a>
  {/snippet}
</Modal>

<style>
  .pic { display: flex; align-items: center; gap: 16px; }
  .pic-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; width: 100%; }
  .prefs { margin-right: auto; order: -1; }
</style>
