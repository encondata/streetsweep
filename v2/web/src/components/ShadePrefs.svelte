<script lang="ts">
  // Choosing how finished areas are shaded: ten presets, or a colour and opacity of your
  // own, previewed as a finished area over the map and over satellite. Laid out like the
  // street colours (ColorPrefs) so the two read as one set of choices.
  import { FILL_PRESETS, sameFill, type StreetColor } from "../lib/colors";

  let { value = $bindable() }: { value: StreetColor } = $props();

  // ---- the preview: a block of Hyde Park, Austin, shaded as if finished ----
  const CENTER = { lat: 30.3085, lon: -97.7272 };
  const Z = 16;
  const W = 300, H = 190;
  const worldX = (lon: number) => ((lon + 180) / 360) * 256 * 2 ** Z;
  const worldY = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** Z;
  };
  const ox = worldX(CENTER.lon) - W / 2, oy = worldY(CENTER.lat) - H / 2;
  const tiles: { x: number; y: number; left: number; top: number }[] = [];
  for (let x = Math.floor(ox / 256); x <= Math.floor((ox + W) / 256); x++)
    for (let y = Math.floor(oy / 256); y <= Math.floor((oy + H) / 256); y++) tiles.push({ x, y, left: x * 256 - ox, top: y * 256 - oy });
  // An area's outline: part of the view, so the shade shows against unshaded ground.
  const AREA = "M40,30 L230,22 L262,120 L180,168 L52,150 Z";

  let chosen = $derived(FILL_PRESETS.find((p) => sameFill(p.fill, value))?.key ?? null);
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
            <path d={AREA} fill={value.color} fill-opacity={value.opacity} stroke="#16a34a" stroke-width="2.5" stroke-linejoin="round" />
          </svg>
        </div>
        <figcaption class="small muted">{v.label}</figcaption>
      </figure>
    {/each}
  </div>

  <div class="presets" role="radiogroup" aria-label="Shade presets">
    {#each FILL_PRESETS as p (p.key)}
      <button type="button" class="preset" class:on={chosen === p.key} role="radio" aria-checked={chosen === p.key} onclick={() => (value = { ...p.fill })}>
        <span class="swatch"><i style:background={p.fill.color} style:opacity={Math.min(1, p.fill.opacity * 3)}></i></span>
        <span class="txt"><strong>{p.name}</strong><span class="small muted">{p.note}</span></span>
      </button>
    {/each}
  </div>

  <div class="row">
    <span class="lbl">Your own</span>
    <input type="color" bind:value={value.color} aria-label="Finished area colour" />
    <label class="op">
      <span class="small muted">Opacity</span>
      <input type="range" min="0.02" max="1" step="0.02" bind:value={value.opacity} aria-label="Finished area opacity" />
      <span class="small">{Math.round(value.opacity * 100)}%</span>
    </label>
  </div>
</div>

<style>
  .prefs { display: grid; gap: 16px; }
  .previews { display: flex; gap: 12px; flex-wrap: wrap; }
  .preview { margin: 0; display: grid; gap: 4px; }
  .frame { position: relative; overflow: hidden; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); max-width: 100%; }
  .frame img { position: absolute; width: 256px; height: 256px; }
  .frame svg { position: absolute; inset: 0; }
  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
  .preset { display: flex; align-items: center; gap: 10px; justify-content: flex-start; height: auto; padding: 8px 10px; text-align: left; white-space: normal; font-weight: 400; }
  .preset.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft); }
  .swatch { flex: none; width: 30px; height: 22px; border-radius: 5px; overflow: hidden; background: #e8ecef; box-shadow: 0 0 0 1px rgba(0,0,0,.12); }
  .swatch i { display: block; width: 100%; height: 100%; }
  .txt { display: grid; gap: 1px; min-width: 0; }
  .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .lbl { width: 130px; font-weight: 600; font-size: 13.5px; }
  input[type="color"] { width: 44px; height: 32px; padding: 2px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--surface); }
  .op { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px; }
  .op input { flex: 1; height: auto; padding: 0; border: 0; }
</style>
