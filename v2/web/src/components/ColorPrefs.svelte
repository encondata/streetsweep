<script lang="ts">
  // Choosing street colours: ten presets, or a colour and opacity of your own for driven
  // and not-yet-driven, with a live preview over real streets on the map and on
  // satellite. Used by Preferences and by the first-run welcome.
  import { onMount } from "svelte";
  import { PRESETS, samePair, type MapColors } from "../lib/colors";

  let { value = $bindable() }: { value: MapColors } = $props();

  // ---- the preview: real streets on real tiles ----
  const CENTER = { lat: 30.3085, lon: -97.7272 }; // Hyde Park, Austin: a tidy grid
  const Z = 16;
  const W = 300, H = 190;
  type Line = { pts: [number, number][]; driven: boolean };
  let lines = $state<Line[]>([]);
  let tiles = $state<{ x: number; y: number; left: number; top: number }[]>([]);

  const worldX = (lon: number) => ((lon + 180) / 360) * 256 * 2 ** Z;
  const worldY = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** Z;
  };
  const cx = worldX(CENTER.lon), cy = worldY(CENTER.lat);
  const ox = cx - W / 2, oy = cy - H / 2; // world pixel at the preview's top-left

  /** Google encoded polyline, precision 6 (the server's street format). */
  function decode(s: string): [number, number][] {
    const out: [number, number][] = [];
    let i = 0, lat = 0, lon = 0;
    while (i < s.length) {
      for (const which of [0, 1]) {
        let b, shift = 0, result = 0;
        do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d; else lon += d;
      }
      out.push([lon / 1e6, lat / 1e6]);
    }
    return out;
  }

  onMount(async () => {
    const tx0 = Math.floor(ox / 256), ty0 = Math.floor(oy / 256);
    const tx1 = Math.floor((ox + W) / 256), ty1 = Math.floor((oy + H) / 256);
    const t: typeof tiles = [];
    for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) t.push({ x, y, left: x * 256 - ox, top: y * 256 - oy });
    tiles = t;
    // The streets in view, from the server; two in three shown as driven.
    const lonAt = (px: number) => (px / (256 * 2 ** Z)) * 360 - 180;
    const latAt = (py: number) => { const n = Math.PI - (2 * Math.PI * py) / (256 * 2 ** Z); return (180 / Math.PI) * Math.atan(Math.sinh(n)); };
    const bbox = [lonAt(ox), latAt(oy + H), lonAt(ox + W), latAt(oy)].map((n) => n.toFixed(5)).join(",");
    try {
      const r = await fetch(`/api/segments?bbox=${bbox}`).then((x) => x.json());
      lines = (r.segments ?? []).map((row: unknown[]) => ({
        pts: decode(String(row[row.length - 1])).map(([lon, lat]) => [worldX(lon) - ox, worldY(lat) - oy] as [number, number]),
        driven: Number(row[0]) % 3 !== 0,
      }));
    } catch { /* the preview just shows tiles */ }
  });

  const path = (l: Line) => l.pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  function pick(c: MapColors) {
    value = { driven: { ...c.driven }, undriven: { ...c.undriven } };
  }
  let chosenPreset = $derived(PRESETS.find((p) => samePair(p.colors, value))?.key ?? null);
</script>

<div class="prefs">
  <div class="previews">
    {#each [{ layer: "osm", label: "Map" }, { layer: "sat", label: "Satellite" }] as v (v.layer)}
      <figure class="preview">
        <div class="frame" style:width="{W}px" style:height="{H}px">
          {#each tiles as t (t.x + "," + t.y)}
            <img src="/api/tiles/{v.layer}/{Z}/{t.x}/{t.y}" alt="" style:left="{t.left}px" style:top="{t.top}px" />
          {/each}
          <svg width={W} height={H} viewBox="0 0 {W} {H}" aria-hidden="true">
            {#each lines as l, i (i)}
              <path d={path(l)} class="casing" />
              <path d={path(l)} stroke={l.driven ? value.driven.color : value.undriven.color}
                stroke-opacity={l.driven ? value.driven.opacity : value.undriven.opacity} class="street" />
            {/each}
          </svg>
        </div>
        <figcaption class="small muted">{v.label}</figcaption>
      </figure>
    {/each}
  </div>

  <div class="presets" role="radiogroup" aria-label="Colour presets">
    {#each PRESETS as p (p.key)}
      <button type="button" class="preset" class:on={chosenPreset === p.key} role="radio" aria-checked={chosenPreset === p.key} onclick={() => pick(p.colors)}>
        <span class="pair">
          <i style:background={p.colors.driven.color} style:opacity={p.colors.driven.opacity}></i>
          <i style:background={p.colors.undriven.color} style:opacity={p.colors.undriven.opacity}></i>
        </span>
        <span class="txt"><strong>{p.name}</strong><span class="small muted">{p.note}</span></span>
      </button>
    {/each}
  </div>

  <div class="custom">
    {#each [{ key: "driven" as const, label: "Driven streets" }, { key: "undriven" as const, label: "Not driven yet" }] as row (row.key)}
      <div class="row">
        <span class="lbl">{row.label}</span>
        <input type="color" bind:value={value[row.key].color} aria-label="{row.label} colour" />
        <label class="op">
          <span class="small muted">Opacity</span>
          <input type="range" min="0.1" max="1" step="0.05" bind:value={value[row.key].opacity} aria-label="{row.label} opacity" />
          <span class="small">{Math.round(value[row.key].opacity * 100)}%</span>
        </label>
      </div>
    {/each}
  </div>
</div>

<style>
  .prefs { display: grid; gap: 16px; }
  .previews { display: flex; gap: 12px; flex-wrap: wrap; }
  .preview { margin: 0; display: grid; gap: 4px; }
  .frame { position: relative; overflow: hidden; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); max-width: 100%; }
  .frame img { position: absolute; width: 256px; height: 256px; }
  .frame svg { position: absolute; inset: 0; }
  .casing { fill: none; stroke: #fff; stroke-opacity: .85; stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; }
  .street { fill: none; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
  .preset { display: flex; align-items: center; gap: 10px; justify-content: flex-start; height: auto; padding: 8px 10px; text-align: left; white-space: normal; font-weight: 400; }
  .preset.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft); }
  .pair { display: grid; gap: 3px; flex: none; }
  .pair i { display: block; width: 30px; height: 6px; border-radius: 3px; box-shadow: 0 0 0 1px rgba(0,0,0,.12); }
  .txt { display: grid; gap: 1px; min-width: 0; }
  .custom { display: grid; gap: 10px; }
  .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .lbl { width: 130px; font-weight: 600; font-size: 13.5px; }
  input[type="color"] { width: 44px; height: 32px; padding: 2px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--surface); }
  .op { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px; }
  .op input { flex: 1; height: auto; padding: 0; border: 0; }
</style>
