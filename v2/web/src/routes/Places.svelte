<script lang="ts">
  // Places: yours (private unless you shared them) and ones your teams shared with you.
  import Avatar from "../components/Avatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, errorText } from "../lib/api";
  import { router } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";
  import { ago } from "../lib/format";
  import type { Place } from "../lib/types";

  let shared = $derived(session.me!.teams.filter((t) => t.kind === "shared"));
  let filter = $derived(router.query.get("show") ?? "all");
  let places = $state<Place[] | null>(null);
  let error = $state<string | null>(null);

  api<{ places: Place[] }>("/api/places").then((r) => (places = r.places), (e) => (error = errorText(e)));

  let shown = $derived(
    (places ?? []).filter((p) =>
      filter === "all" ? true : filter === "mine" ? p.mine : p.shared_with.some((t) => t.id === filter)),
  );
</script>

<div class="page">
  <div class="page-head">
    <h1>Places</h1>
    <a class="btn primary" href="/map"><Icon name="pin" size={17} /> Add on the map</a>
  </div>

  <nav class="tabs" aria-label="Which places">
    <a href="/places" class:on={filter === "all"}>All</a>
    <a href="/places?show=mine" class:on={filter === "mine"}>Yours</a>
    {#each shared as t (t.id)}<a href="/places?show={t.id}" class:on={filter === t.id}>{t.name}</a>{/each}
  </nav>

  <p class="muted">Spots worth remembering: a pothole, a gate code, a street that's really a driveway. Yours are private until you share one with a team.</p>

  {#if error}<p class="notice error">{error}</p>{/if}

  {#if places && !shown.length}
    <div class="card">
      <EmptyState art="empty-places.png" title={filter === "all" || filter === "mine" ? "No places yet" : "Nothing shared here yet"}>
        On the map, press <strong>Add place</strong> and click the spot.
      </EmptyState>
    </div>
  {:else if shown.length}
    <div class="grid">
      {#each shown as p (p.id)}
        <a class="card place" href="/places/{p.id}">
          {#if p.photos[0]}
            <img src="/api/places/{p.id}/photos/{p.photos[0].id}" alt="" loading="lazy" />
          {:else}
            <span class="nophoto"><Icon name="pin" size={28} /></span>
          {/if}
          <span class="body">
            <strong class="ellipsis">{p.name}</strong>
            {#if p.note}<span class="small muted note">{p.note}</span>{/if}
            <span class="meta small">
              {#if p.mine}
                {#if p.shared_with.length}<span class="badge green">Shared · {p.shared_with.map((t) => t.name).join(", ")}</span>
                {:else}<span class="badge">Only you</span>{/if}
              {:else}
                <Avatar id={p.user_id} name={p.user_name} url={p.user_avatar_url} size={20} /> <span class="muted">{p.user_name}</span>
              {/if}
              <span class="muted">· {ago(p.created_at)}</span>
            </span>
          </span>
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .btn { display: inline-flex; align-items: center; gap: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
  .place { overflow: hidden; display: flex; flex-direction: column; color: var(--ink); }
  .place:hover { text-decoration: none; box-shadow: 0 2px 4px rgba(13,27,40,.08), 0 8px 24px rgba(13,27,40,.08); }
  .place img, .nophoto { width: 100%; height: 140px; object-fit: cover; display: block; }
  .nophoto { display: grid; place-items: center; background: #fce4ec; color: #c2185b; }
  .body { padding: 12px 14px; display: grid; gap: 4px; min-width: 0; }
  .note { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
</style>
