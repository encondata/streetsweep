<script lang="ts">
  // A street's popup on the map: what it is, whether the chosen team has swept it, and
  // (for the team's drivers) marking it done by hand or leaving it out.
  import { api, errorText } from "../lib/api";
  import { date, miles } from "../lib/format";
  import type { StreetHit } from "../lib/map";
  import type { Segment } from "../lib/types";

  let { hit, teamId, teamLabel, onchange }: {
    hit: StreetHit; teamId: string | null; teamLabel: string; onchange: () => void;
  } = $props();

  const KIND: Record<string, string> = {
    primary: "Main road", secondary: "Secondary road", tertiary: "Minor through road", unclassified: "Minor road",
    residential: "Residential street", living_street: "Living street",
  };

  let seg = $state<Segment | null>(null);
  let canMark = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let note = $state("");
  let noting = $state<"complete" | "excluded" | null>(null);

  async function load() {
    try {
      const r = await api<{ segment: Segment; can_mark: boolean }>(`/api/segments/${hit.id}${teamId ? `?team=${teamId}` : ""}`);
      seg = r.segment;
      canMark = !!teamId && r.can_mark;
    } catch (e) {
      error = errorText(e);
    }
  }
  load();

  async function mark(kind: "complete" | "excluded" | null) {
    busy = true;
    error = null;
    try {
      if (kind) await api(`/api/teams/${teamId}/marks/${hit.id}`, { method: "PUT", body: { kind, note: note.trim() || null } });
      else await api(`/api/teams/${teamId}/marks/${hit.id}`, { method: "DELETE" });
      noting = null;
      note = "";
      await load();
      onchange();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  // The note box takes the typing as soon as it opens.
  const focus = (el: HTMLInputElement) => el.focus();

  let kind = $derived(`${KIND[hit.highway.replace(/_link$/, "")] ?? hit.highway}${hit.highway.endsWith("_link") ? " (ramp)" : ""}`);
  let feet = $derived(Math.round(hit.length_m * 3.28084));
</script>

<div class="pop">
  <strong>{hit.name ?? "Unnamed street"}</strong>
  <div class="muted">{kind} · {feet < 1000 ? `${feet.toLocaleString()} ft` : miles(hit.length_m)}</div>

  {#if teamId}
    <div class="state">
      {#if !seg && !error}
        <span class="muted">Checking…</span>
      {:else if seg}
        {#if seg.mark === "excluded"}
          <span class="pill grey">Left out</span>
          <span class="muted">for {teamLabel}{seg.marked_by ? ` by ${seg.marked_by}` : ""}</span>
        {:else if seg.mark === "complete"}
          <span class="pill green">Done by hand</span>
          <span class="muted">{seg.marked_by ? `${seg.marked_by}, ` : ""}{seg.marked_at ? date(seg.marked_at) : ""}</span>
        {:else if seg.first_driven_at}
          <span class="pill green">Driven</span>
          <span class="muted">first {date(seg.first_driven_at)}{seg.first_driver ? ` by ${seg.first_driver}` : ""}{seg.passes && seg.passes > 1 ? ` · ${seg.passes} times` : ""}</span>
        {:else}
          <span class="pill blue">Not yet</span>
          <span class="muted">for {teamLabel}</span>
        {/if}
      {/if}
    </div>
    {#if seg?.mark_note}<div class="note">“{seg.mark_note}”</div>{/if}
  {/if}

  {#if error}<div class="err">{error}</div>{/if}

  {#if seg && canMark}
    {#if noting}
      <form class="noting" onsubmit={(e) => { e.preventDefault(); mark(noting); }}>
        <input type="text" use:focus bind:value={note} maxlength="500" placeholder={noting === "complete" ? "Note, e.g. walked it" : "Why, e.g. private road"} aria-label="Note" />
        <div class="btns">
          <button type="button" class="sm ghost" onclick={() => (noting = null)}>Cancel</button>
          <button type="submit" class="sm primary" disabled={busy}>{noting === "complete" ? "Mark done" : "Leave out"}</button>
        </div>
      </form>
    {:else if seg.mark}
      <div class="btns"><button class="sm" disabled={busy} onclick={() => mark(null)}>{seg.mark === "complete" ? "Unmark" : "Count it again"}</button></div>
    {:else}
      <div class="btns">
        {#if !seg.first_driven_at}<button class="sm" disabled={busy} onclick={() => (noting = "complete")}>Mark done</button>{/if}
        <button class="sm ghost" disabled={busy} onclick={() => (noting = "excluded")}>Leave out</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .pop { display: grid; gap: 4px; min-width: 200px; }
  .state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; font-size: 12.5px; }
  .pill { font-size: 11.5px; font-weight: 700; padding: 2px 8px; border-radius: 99px; }
  .pill.green { background: #dcfce7; color: #15803d; }
  .pill.grey { background: #eef1f4; color: #4b5866; }
  .pill.blue { background: #e3effc; color: #1a5fb4; }
  .note { font-size: 12.5px; font-style: italic; color: var(--ink-soft); }
  .err { color: var(--danger); font-size: 12.5px; }
  .btns { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; flex-wrap: wrap; }
  .noting { display: grid; gap: 4px; margin-top: 6px; }
  .noting input { height: 32px; font-size: 13px; }
</style>
