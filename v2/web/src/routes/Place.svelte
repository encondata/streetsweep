<script lang="ts">
  // One place: where it is, its note and photos, and (for whoever marked it) editing,
  // sharing with their teams, and deleting.
  import { onMount } from "svelte";
  import Avatar from "../components/Avatar.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { ago, date } from "../lib/format";
  import { shrinkToBlob } from "../lib/image";
  import { syncFrom } from "../lib/forms";
  import { MapController } from "../lib/map";
  import type { Place } from "../lib/types";

  let { id }: { id: string } = $props();

  let p = $state<Place | null>(null);
  let error = $state<string | null>(null);
  let flash = $state<string | null>(null);
  let busy = $state(false);
  let editing = $state(false);
  let form = $state({ name: "", note: "" });
  let shareTo = $state<string[]>([]);
  let fileInput = $state<HTMLInputElement>();
  let big = $state<string | null>(null);

  let box = $state<HTMLDivElement>();
  let ctl: MapController | null = null;
  let myTeams = $derived(session.me!.teams.filter((t) => t.kind === "shared"));

  function apply(next: Place) {
    p = next;
    shareTo = next.shared_with.map((t) => t.id);
    ctl?.setPlaces([next]);
  }

  onMount(() => {
    api<{ place: Place }>(`/api/places/${id}`).then((r) => apply(r.place), (e) => (error = errorText(e)));
    return () => ctl?.destroy();
  });

  $effect(() => {
    if (!box || ctl || !p) return;
    ctl = new MapController(box, [p.lon, p.lat], 16);
    ctl.watchSize(box);
    ctl.showStreets(false);
    ctl.setPlaces([p]);
  });

  async function act(fn: () => Promise<{ place: Place }>, done?: string) {
    busy = true;
    error = flash = null;
    try {
      apply((await fn()).place);
      if (done) flash = done;
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  function startEdit() {
    form = { name: p!.name, note: p!.note ?? "" };
    editing = true;
  }
  const save = (el: HTMLFormElement) => {
    syncFrom(form, el);
    act(() => api(`/api/places/${id}`, { method: "PATCH", body: { name: form.name.trim(), note: form.note.trim() || null } }), "Saved.")
      .then(() => (editing = false));
  };

  let shareChanged = $derived(!!p && [...shareTo].sort().join() !== p.shared_with.map((t) => t.id).sort().join());
  const saveShares = () => act(() => api(`/api/places/${id}`, { method: "PATCH", body: { team_ids: shareTo } }),
    shareTo.length ? "Sharing updated." : "Only you can see it now.");

  async function addPhotos(files: FileList | null | undefined) {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      await act(async () => {
        const { blob, width, height } = await shrinkToBlob(f, 1600);
        return api(`/api/places/${id}/photos?w=${width}&h=${height}`, { raw: blob });
      });
      if (error) break;
    }
    if (fileInput) fileInput.value = "";
  }
  async function removePhoto(photoId: string) {
    if (!confirm("Remove this photo?")) return;
    await act(() => api(`/api/places/${id}/photos/${photoId}`, { method: "DELETE" }));
  }

  async function remove() {
    if (!confirm(`Delete ${p!.name}? Its photos go too. This can't be undone.`)) return;
    busy = true;
    try {
      await api(`/api/places/${id}`, { method: "DELETE" });
      router.go("/places");
    } catch (e) {
      error = errorText(e);
      busy = false;
    }
  }

  const photoUrl = (photoId: string) => `/api/places/${id}/photos/${photoId}`;
</script>

<div class="page">
  <a class="back muted" href="/places"><Icon name="back" size={16} /> Places</a>

  {#if error}<p class="notice error">{error}</p>{/if}
  {#if flash}<p class="notice">{flash}</p>{/if}

  {#if p}
    <div class="page-head">
      <div>
        <h1>{p.name}</h1>
        <p class="muted small who">
          {#if p.mine}Marked by you {ago(p.created_at)}
          {:else}<Avatar id={p.user_id} name={p.user_name} url={p.user_avatar_url} size={20} /> Marked by {p.user_name}, {date(p.created_at)}{/if}
          · {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
        </p>
      </div>
      {#if p.mine && !editing}<button onclick={startEdit}>Edit</button>{/if}
    </div>

    <div class="card mapcard"><div class="map" bind:this={box}></div></div>

    <section class="card pad stack">
      {#if editing}
        <form class="stack" onsubmit={(e) => { e.preventDefault(); save(e.currentTarget); }}>
          <label class="field">Name <input type="text" name="name" bind:value={form.name} maxlength="120" required /></label>
          <label class="field">Note <textarea name="note" bind:value={form.note} maxlength="2000"></textarea></label>
          <div class="btns"><button type="button" class="ghost" onclick={() => (editing = false)}>Cancel</button><button type="submit" class="primary" disabled={busy}>Save</button></div>
        </form>
      {:else}
        <h2>Note</h2>
        <p class="note {p.note ? '' : 'muted'}">{p.note ?? "No note."}</p>
      {/if}
    </section>

    <section class="card pad stack">
      <div class="section-head">
        <h2>Photos</h2>
        {#if p.mine}
          <label class="btn sm"><Icon name="camera" size={16} /> Add photos
            <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={(e) => addPhotos(e.currentTarget.files)} /></label>
        {/if}
      </div>
      {#if p.photos.length}
        <div class="photos">
          {#each p.photos as f (f.id)}
            <div class="photo">
              <button class="open" onclick={() => (big = f.id)} aria-label="View photo"><img src={photoUrl(f.id)} alt="" loading="lazy" /></button>
              {#if p.mine}<button class="sm ghost danger rm" disabled={busy} onclick={() => removePhoto(f.id)}>Remove</button>{/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted">No photos{p.mine ? " yet. Add some from your phone or computer." : "."}</p>
      {/if}
    </section>

    {#if p.mine}
      <section class="card pad stack">
        <div>
          <h2>Who sees it</h2>
          <p class="muted small">Only you, unless you share it. Members of a team you share it with can see it and its photos, but only you can change it.</p>
        </div>
        {#if myTeams.length}
          <div class="shares">
            {#each myTeams as t (t.id)}
              <label class="check"><input type="checkbox" value={t.id} bind:group={shareTo} /> {t.name}</label>
            {/each}
          </div>
          <div class="btns"><button class="primary" disabled={busy || !shareChanged} onclick={saveShares}><Icon name="share" size={16} /> Save sharing</button></div>
        {:else}
          <p class="muted">You're not in any shared teams, so it's just yours.</p>
        {/if}
      </section>
      <div class="btns"><button class="ghost danger" disabled={busy} onclick={remove}>Delete place</button></div>
    {:else if p.shared_with.length}
      <p class="small muted">Shared with {p.shared_with.map((t) => t.name).join(", ")}.</p>
    {/if}
  {/if}
</div>

{#if big}
  <button class="lightbox" onclick={() => (big = null)} aria-label="Close photo"><img src={photoUrl(big)} alt="" /></button>
{/if}

<style>
  .back { display: inline-flex; align-items: center; gap: 4px; }
  .who { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .mapcard { overflow: hidden; }
  .map { height: 280px; }
  .note { white-space: pre-wrap; margin: 0; }
  .btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .danger { color: var(--danger); }
  .btn { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .photo { display: grid; gap: 4px; }
  .open { padding: 0; border: 0; height: auto; background: none; border-radius: 10px; overflow: hidden; }
  .open img { width: 100%; height: 130px; object-fit: cover; display: block; }
  .rm { justify-self: end; }
  .shares { display: grid; gap: 6px; }
  .check { display: flex; align-items: center; gap: 8px; }
  .check input { width: auto; height: auto; }
  .lightbox { position: fixed; inset: 0; z-index: 50; background: rgba(13, 27, 40, .85); border: 0; border-radius: 0; height: auto; display: grid; place-items: center; padding: 24px; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }
</style>
