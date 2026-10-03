<script lang="ts">
  // A picture when there is one, otherwise initials on a colour picked from the id,
  // so the same person is always the same colour.
  let { id, name, url = null, size = 36 }: { id: string; name: string; url?: string | null; size?: number } = $props();

  const COLORS = ["#1e8a28", "#1a6fd4", "#8e44ad", "#d35400", "#16a085", "#c0392b", "#2c3e50", "#b7950b"];
  let initials = $derived(
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?",
  );
  let color = $derived(COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]);
  let broken = $state(false);
</script>

{#if url && !broken}
  <img class="av" src={url} alt="" width={size} height={size} style:width="{size}px" style:height="{size}px" onerror={() => (broken = true)} />
{:else}
  <span class="av" style:width="{size}px" style:height="{size}px" style:background={color} style:font-size="{Math.round(size * 0.4)}px" aria-hidden="true">{initials}</span>
{/if}

<style>
  .av { border-radius: 50%; flex: none; object-fit: cover; display: inline-grid; place-items: center; color: #fff; font-weight: 700; letter-spacing: .02em; }
</style>
