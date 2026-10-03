<script lang="ts">
  import type { Snippet } from "svelte";
  let { open = $bindable(false), title, width = 460, children, footer }:
    { open?: boolean; title: string; width?: number; children: Snippet; footer?: Snippet } = $props();
  let dialog: HTMLDialogElement;

  $effect(() => {
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} style:max-width="{width}px"
  onclick={(e) => { if (e.target === dialog) open = false; }}>
  {#if open}
    <header>
      <h2>{title}</h2>
      <button class="ghost icon" aria-label="Close" onclick={() => (open = false)}>✕</button>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  {/if}
</dialog>

<style>
  dialog {
    width: calc(100% - 32px); padding: 0; border: 1px solid var(--line); border-radius: 16px;
    background: var(--surface); color: var(--ink); box-shadow: 0 20px 60px rgba(0, 0, 0, .3);
  }
  dialog::backdrop { background: rgba(2, 20, 42, .55); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 6px; }
  .body { padding: 10px 18px 18px; display: grid; gap: 14px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line); background: var(--surface-2); border-radius: 0 0 16px 16px; }
</style>
