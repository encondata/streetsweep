<script lang="ts">
  import EmptyState from "../../components/EmptyState.svelte";
  import Icon from "../../components/Icon.svelte";
  import { api, errorText } from "../../lib/api";
  import { ago, date } from "../../lib/format";
  import type { Device } from "../../lib/types";

  let devices = $state<Device[] | null>(null);
  let error = $state<string | null>(null);

  const load = () => api<{ devices: Device[] }>("/api/devices").then((r) => (devices = r.devices), (e) => (error = errorText(e)));
  load();

  async function revoke(d: Device) {
    if (!confirm(`Sign ${d.name} out? It will have to sign in again to record drives.`)) return;
    try {
      await api(`/api/devices/${d.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      error = errorText(e);
    }
  }
</script>

<p class="muted">Phones signed in to the StreetSweep app as you. Sign out any you don't recognise or no longer use.</p>
{#if error}<p class="notice error">{error}</p>{/if}

{#if devices}
  <div class="card list">
    {#each devices as d (d.id)}
      <div class="row" class:off={d.revoked_at}>
        <span class="ph"><Icon name="phone" /></span>
        <div class="grow">
          <strong>{d.name}</strong>
          <div class="muted small">
            {d.platform === "ios" ? "iPhone" : d.platform === "android" ? "Android" : "Phone"}{d.app_version ? ` · app ${d.app_version}` : ""}
            · signed in {date(d.created_at)} · {d.revoked_at ? `signed out ${ago(d.revoked_at)}` : `seen ${ago(d.last_seen_at)}`}
          </div>
        </div>
        {#if !d.revoked_at}<button class="sm danger" onclick={() => revoke(d)}>Sign out</button>{/if}
      </div>
    {:else}
      <EmptyState title="No phones yet">Phones show up here once they sign in to the StreetSweep app.</EmptyState>
    {/each}
  </div>
{/if}

<style>
  .ph { width: 40px; height: 40px; border-radius: 10px; background: var(--surface-2); color: var(--ink-soft); display: grid; place-items: center; flex: none; }
  .off { opacity: .55; }
</style>
