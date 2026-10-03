<script lang="ts">
  // The logger's key, shown exactly once: at registration or after "New key".
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import type { LoggerSetup } from "../lib/types";

  let { open = $bindable(false), setup, name }: { open?: boolean; setup: LoggerSetup | null; name: string } = $props();
  let copied = $state("");

  let block = $derived(setup
    ? `LOGGER_ID  = "${setup.logger_id}"\nSECRET_HEX = "${setup.secret}"\nSERVER     = "${setup.server}"`
    : "");

  async function copy(what: string, text: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    copied = what;
    setTimeout(() => (copied = ""), 1500);
  }
</script>

<Modal bind:open title="Key for {name}" width={600}>
  {#if setup}
    <p class="notice"><strong>Copy this now.</strong> The secret is shown once. If it's lost, make a new key from the logger's page.</p>
    <div class="kv">
      <span class="muted small">Logger ID</span>
      <code>{setup.logger_id}</code>
      <button class="sm ghost" onclick={() => copy("id", setup.logger_id)}><Icon name="copy" size={15} /> {copied === "id" ? "Copied" : "Copy"}</button>
      <span class="muted small">Secret</span>
      <code class="secret">{setup.secret}</code>
      <button class="sm ghost" onclick={() => copy("secret", setup.secret)}><Icon name="copy" size={15} /> {copied === "secret" ? "Copied" : "Copy"}</button>
      <span class="muted small">Server</span>
      <code>{setup.server}</code>
      <span></span>
    </div>
    <div>
      <div class="section-head"><h3>For the firmware</h3>
        <button class="sm" onclick={() => copy("block", block)}><Icon name="copy" size={15} /> {copied === "block" ? "Copied" : "Copy all"}</button></div>
      <pre>{block}</pre>
      <p class="muted small">The signing recipe and an ESP32 example are in <code>docs/LOGGER-PROTOCOL.md</code>. The logger proves it works by fetching <code>{setup.config_url}</code>.</p>
    </div>
  {/if}
  {#snippet footer()}
    <button class="primary" onclick={() => (open = false)}>I've copied it</button>
  {/snippet}
</Modal>

<style>
  .kv { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; }
  code { font: 13px ui-monospace, Menlo, monospace; word-break: break-all; }
  .secret { background: var(--warn-soft); padding: 4px 6px; border-radius: 6px; }
  pre { margin: 8px 0; padding: 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); font: 12.5px/1.5 ui-monospace, Menlo, monospace; overflow-x: auto; }
</style>
