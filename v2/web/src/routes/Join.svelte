<script lang="ts">
  // /join/:code — where a team's join link lands.
  import Avatar from "../components/Avatar.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { ago } from "../lib/format";
  import type { TeamPreview } from "../lib/types";

  let { code }: { code: string } = $props();
  let preview = $state<TeamPreview | null>(null);
  let error = $state<string | null>(null);
  let message = $state("");
  let busy = $state(false);
  let sent = $state(false);

  api<TeamPreview>(`/api/join/${encodeURIComponent(code)}`)
    .then((p) => {
      if (p.my_role) router.go(`/teams/${p.team.id}`, true); // already in it
      else preview = p;
    })
    .catch((e) => (error = errorText(e)));

  async function ask() {
    busy = true;
    error = null;
    try {
      await api(`/api/teams/${preview!.team.id}/join-requests`, { body: { message: message.trim() || undefined, code } });
      sent = true;
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="page narrow">
  {#if error}
    <p class="notice error">{error}</p>
    <a href="/teams">Back to Teams</a>
  {:else if preview}
    <div class="card pad stack">
      <div class="head">
        <Avatar id={preview.team.id} name={preview.team.name} size={56} />
        <div>
          <p class="muted small">You've been invited to join</p>
          <h1>{preview.team.name}</h1>
          <p class="muted">{preview.team.member_count} member{preview.team.member_count === 1 ? "" : "s"}</p>
        </div>
      </div>
      {#if sent || preview.my_request}
        <p class="notice">
          Request sent{preview.my_request ? ` ${ago(preview.my_request.requested_at)}` : ""}. A team admin will approve it,
          and the team will appear on your Teams page.
        </p>
        <div><a class="btn" href="/teams">Go to Teams</a></div>
      {:else}
        <p class="muted">Joining needs a team admin's approval. They'll see your name, email and the note below.</p>
        <label class="field">Note <span class="help">Optional.</span>
          <textarea bind:value={message} maxlength="500"></textarea></label>
        <div><button class="primary" disabled={busy} onclick={ask}>Ask to join</button></div>
      {/if}
    </div>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .narrow { max-width: 560px; }
  .head { display: flex; gap: 14px; align-items: center; }
</style>
