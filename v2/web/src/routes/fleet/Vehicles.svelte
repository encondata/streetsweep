<script lang="ts">
  import EmptyState from "../../components/EmptyState.svelte";
  import Icon from "../../components/Icon.svelte";
  import Modal from "../../components/Modal.svelte";
  import Avatar from "../../components/Avatar.svelte";
  import VehicleImage from "../../components/VehicleImage.svelte";
  import VehicleForm from "../../components/VehicleForm.svelte";
  import { api, errorText } from "../../lib/api";
  import { router } from "../../lib/router.svelte";
  import { session } from "../../lib/session.svelte";
  import { ago } from "../../lib/format";
  import { emptyVehicleForm, formToBody } from "../../lib/vehicleForm";
  import { syncFrom } from "../../lib/forms";
  import { cropToBlob } from "../../lib/image";
  import { vehicleLine, type Vehicle, type VehicleDetail } from "../../lib/types";

  let showArchived = $derived(router.query.get("archived") === "1");
  let vehicles = $state<Vehicle[] | null>(null);
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);

  let adding = $state(false);
  // A photo chosen in the form goes up once the vehicle exists.
  let photo = $state<File | null>(null);
  let photoPreview = $derived(photo ? URL.createObjectURL(photo) : null);
  let form = $state(emptyVehicleForm());
  let teamId = $state("");

  let me = $derived(session.me!.user);
  // You can add vehicles to teams you run; your personal team is always one of them.
  let adminTeams = $derived(session.me!.teams.filter((t) => t.role === "owner" || t.role === "admin"));
  let chosenTeam = $derived(adminTeams.find((t) => t.id === teamId));

  async function load() {
    try {
      vehicles = (await api<{ vehicles: Vehicle[] }>(`/api/vehicles${showArchived ? "?archived=1" : ""}`)).vehicles;
    } catch (e) {
      error = errorText(e);
    }
  }
  $effect(() => {
    showArchived;
    load();
  });

  // Grouped by managing team, personal first (the server already orders them).
  let groups = $derived.by(() => {
    const out: { id: string; name: string; personal: boolean; items: Vehicle[] }[] = [];
    for (const v of vehicles ?? []) {
      let g = out.find((x) => x.id === v.team_id);
      if (!g) out.push((g = { id: v.team_id, name: v.team_kind === "personal" ? "Your own" : v.team_name, personal: v.team_kind === "personal", items: [] }));
      g.items.push(v);
    }
    return out;
  });

  const canDrive = (v: Vehicle) => v.my_role === "owner" || v.my_role === "admin" || v.my_role === "driver";
  const isAdmin = (v: Vehicle) => v.my_role === "owner" || v.my_role === "admin";
  // Checking out is for shared vehicles; your personal car is simply yours.
  const canTake = (v: Vehicle) =>
    v.team_kind === "shared" && !v.archived_at && !v.checkout && canDrive(v) && (v.checkout_policy === "open" || isAdmin(v));
  const canReturn = (v: Vehicle) => !!v.checkout && (v.checkout.user_id === me.id || isAdmin(v));

  async function act(v: Vehicle, what: "checkout" | "return") {
    busy = v.id;
    error = null;
    try {
      const d = await api<VehicleDetail>(`/api/vehicles/${v.id}/${what}`, { body: {} });
      vehicles = vehicles!.map((x) => (x.id === v.id ? { ...d.vehicle, my_role: x.my_role } : x));
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = null;
    }
  }

  function openAdd() {
    form = emptyVehicleForm();
    photo = null;
    teamId = adminTeams.find((t) => t.kind === "personal")?.id ?? adminTeams[0]?.id ?? "";
    adding = true;
  }

  async function add() {
    busy = "add";
    error = null;
    try {
      const body = formToBody(form);
      const d = await api<VehicleDetail>("/api/vehicles", {
        body: { team_id: teamId, ...body, ...(chosenTeam?.kind === "shared" ? {} : { checkout_policy: undefined }) },
      });
      if (photo) {
        // The vehicle is made either way; a photo that won't go up can be added on its page.
        await api(`/api/vehicles/${d.vehicle.id}/photo`, { method: "PUT", raw: await cropToBlob(photo, 960, 540) }).catch(() => {});
      }
      adding = false;
      router.go(`/fleet/vehicles/${d.vehicle.id}`);
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = null;
    }
  }
</script>

<div class="bar">
  <p class="muted">
    {#if showArchived}Archived vehicles. Their history is kept. <a href="/fleet/vehicles">Back to the active ones</a>.
    {:else}Cars belong to the team that manages them. Drivers in that team can take them. <a href="/fleet/vehicles?archived=1">Archived</a>{/if}
  </p>
  {#if !showArchived}<button class="primary" onclick={openAdd}><Icon name="plus" size={18} /> Add vehicle</button>{/if}
</div>

{#if error}<p class="notice error">{error}</p>{/if}

{#if vehicles && !vehicles.length}
  <div class="card">
    <EmptyState art="empty-vehicles.png" title={showArchived ? "Nothing archived" : "No vehicles yet"}>
      {#if !showArchived}Add your own car, or a team's car or van if you run the team.{/if}
    </EmptyState>
  </div>
{/if}

{#each groups as g (g.id)}
  <section class="section">
    <h2>{g.name}</h2>
    <div class="cards">
      {#each g.items as v (v.id)}
        <div class="card vcard">
          <a class="cover" href="/fleet/vehicles/{v.id}" aria-label="Open {v.name}">
            <VehicleImage photo={v.photo_url} kind={v.kind} height={130} round={0} />
          </a>
          <div class="body">
            <a class="name" href="/fleet/vehicles/{v.id}">{v.name}</a>
            <div class="muted small ellipsis">{vehicleLine(v) || " "}</div>
            <div class="status">
              {#if v.archived_at}
                <span class="badge">Archived</span>
              {:else if v.checkout}
                <Avatar id={v.checkout.user_id} name={v.checkout.display_name} url={v.checkout.avatar_url} size={22} />
                <span class="small"><strong>{v.checkout.user_id === me.id ? "You have it" : v.checkout.display_name}</strong>
                  <span class="muted">· out {ago(v.checkout.since)}</span></span>
              {:else if v.team_kind === "personal"}
                <span class="small muted">Your car</span>
              {:else if v.assigned.length}
                <span class="small muted ellipsis">Driven by {v.assigned.map((a) => (a.user_id === me.id ? "you" : a.display_name)).join(", ")}</span>
              {:else}
                <span class="badge green">Available</span>
              {/if}
            </div>
          </div>
          {#if canReturn(v) || canTake(v)}
            <div class="foot">
              {#if canReturn(v)}
                <button class="sm" disabled={busy === v.id} onclick={() => act(v, "return")}>Return</button>
              {:else}
                <button class="sm primary" disabled={busy === v.id} onclick={() => act(v, "checkout")}>Check out</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>
{/each}

<Modal bind:open={adding} title="Add vehicle" width={560}>
  <form id="add-vehicle" class="stack" onsubmit={(e) => { e.preventDefault(); syncFrom(form, e.currentTarget); add(); }}>
    <label class="field">Managed by
      <span class="help">That team's admins look after it. Its drivers can take it.</span>
      <select bind:value={teamId}>
        {#each adminTeams as t (t.id)}<option value={t.id}>{t.kind === "personal" ? "Just me (personal)" : t.name}</option>{/each}
      </select>
    </label>
    <VehicleForm bind:value={form} shared={chosenTeam?.kind === "shared"} />
    <div class="field">Photo
      <span class="help">Optional. Without one, a drawing for its type is shown.</span>
      <div class="photo-pick">
        {#if photoPreview}<img src={photoPreview} alt="" />{/if}
        <label class="btn sm"><Icon name="camera" size={15} /> {photo ? "Choose another" : "Choose a photo"}
          <input type="file" accept="image/*" hidden onchange={(e) => (photo = e.currentTarget.files?.[0] ?? null)} /></label>
        {#if photo}<button type="button" class="sm ghost" onclick={() => (photo = null)}>Remove</button>{/if}
      </div>
    </div>
  </form>
  {#snippet footer()}
    <button class="ghost" onclick={() => (adding = false)}>Cancel</button>
    <button class="primary" type="submit" form="add-vehicle" disabled={busy === "add" || !teamId}>Add vehicle</button>
  {/snippet}
</Modal>

<style>
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .vcard { overflow: hidden; display: flex; flex-direction: column; }
  .cover { display: block; }
  .body { padding: 12px 14px; display: grid; gap: 4px; flex: 1; min-width: 0; }
  .name { color: var(--ink); font-weight: 700; font-size: 15px; }
  .status { display: flex; align-items: center; gap: 6px; margin-top: 4px; min-height: 24px; min-width: 0; }
  .foot { padding: 0 14px 12px; display: flex; justify-content: flex-end; }
  .photo-pick { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .photo-pick img { width: 120px; height: 68px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); }
</style>
