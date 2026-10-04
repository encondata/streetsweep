<script lang="ts">
  // New street miles per week, last twelve weeks: one series, so the title names it and
  // there's no legend. Hover (or focus) a week for its figures; a table carries the same
  // numbers for screen readers.
  import { miles } from "../lib/format";

  let { weeks, title }: { weeks: { week: string; street_m: number; drive_m: number }[]; title: string } = $props();

  // Drawn at the width it's shown, so the text stays its real size on a phone.
  let width = $state(600);
  let W = $derived(Math.max(260, width));
  const H = 160, PAD_L = 34, PAD_B = 22, PAD_T = 10;
  const BAR = 24;
  let hover = $state<number | null>(null);

  let top = $derived(niceMax(Math.max(...weeks.map((w) => w.street_m / 1609.34), 0)));
  let slot = $derived((W - PAD_L) / Math.max(1, weeks.length));
  // Week labels every third week, or every fourth when narrow.
  let every = $derived(W < 420 ? 4 : 3);
  const y = (mi: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - mi / top);
  const label = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  /** A round axis top: 1, 2, 5, 10, 20, 50… miles. */
  function niceMax(v: number) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
  }

  /** A column with a 4px rounded top, square at the baseline. */
  function column(x: number, h: number) {
    const base = H - PAD_B, r = Math.min(4, h / 2);
    if (h <= 0) return "";
    return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + BAR - r} Q${x + BAR},${base - h} ${x + BAR},${base - h + r} V${base} Z`;
  }
</script>

<figure class="chart">
  <figcaption class="small muted">{title}</figcaption>
  <div class="plot" bind:clientWidth={width}>
    <svg viewBox="0 0 {W} {H}" height={H} role="img" aria-label="{title}, last {weeks.length} weeks">
      {#each [0, top / 2, top] as t (t)}
        <line x1={PAD_L} x2={W} y1={y(t)} y2={y(t)} class="grid" />
        <text x={PAD_L - 6} y={y(t) + 4} class="tick" text-anchor="end">{t % 1 ? t.toFixed(1) : t}</text>
      {/each}
      {#each weeks as w, i (w.week)}
        {@const mi = w.street_m / 1609.34}
        {@const x = PAD_L + i * slot + (slot - BAR) / 2}
        <!-- The hit area is the whole slot, so a tiny bar is still easy to point at. -->
        <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={H - PAD_T - PAD_B} class="hit"
          role="presentation" onmouseenter={() => (hover = i)} onmouseleave={() => (hover = null)} />
        <path d={column(x, (H - PAD_T - PAD_B) * (mi / top))} class="bar" class:on={hover === i} />
        {#if (i % every === 0 && weeks.length - 1 - i >= 2) || i === weeks.length - 1}
          <text x={x + BAR / 2} y={H - 6} class="tick" text-anchor="middle">{i === weeks.length - 1 ? "This wk" : label(w.week)}</text>
        {/if}
      {/each}
    </svg>
    {#if hover !== null}
      {@const w = weeks[hover]}
      <div class="tip" style:left="{((PAD_L + hover * slot + slot / 2) / W) * 100}%">
        <strong>Week of {label(w.week)}</strong>
        <span>{miles(w.street_m)} new streets</span>
        <span class="muted">{miles(w.drive_m)} driven</span>
      </div>
    {/if}
  </div>
  <table class="sr">
    <caption>{title}</caption>
    <thead><tr><th>Week of</th><th>New streets</th><th>Driven</th></tr></thead>
    <tbody>{#each weeks as w (w.week)}<tr><td>{label(w.week)}</td><td>{miles(w.street_m)}</td><td>{miles(w.drive_m)}</td></tr>{/each}</tbody>
  </table>
</figure>

<style>
  .chart { margin: 0; display: grid; gap: 6px; min-width: 0; }
  .plot { position: relative; min-width: 0; }
  /* Full width of its box (which is what W measures), so it is never scaled. */
  svg { display: block; overflow: visible; width: 100%; }
  .grid { stroke: var(--line); stroke-width: 1; }
  .tick { font: 11px var(--ui); fill: var(--ink-soft); }
  .bar { fill: #16a34a; }
  .bar.on { fill: #15803d; }
  .hit { fill: transparent; }
  .tip {
    position: absolute; top: -6px; transform: translate(-50%, -100%); pointer-events: none; white-space: nowrap;
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow);
    padding: 6px 10px; font-size: 12.5px; display: grid; gap: 1px;
  }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
