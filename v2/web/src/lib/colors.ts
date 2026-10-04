// The colours streets are drawn in: each person picks their own (Preferences, and the
// first-run welcome). Driven and not-yet-driven each get a colour and an opacity.
import { session } from "./session.svelte";

export interface StreetColor { color: string; opacity: number }
export interface MapColors { driven: StreetColor; undriven: StreetColor }

export interface Preset { key: string; name: string; note: string; colors: MapColors }

const pair = (driven: string, undriven: string, dOp = 1, uOp = 0.9): MapColors => ({
  driven: { color: driven, opacity: dOp }, undriven: { color: undriven, opacity: uOp },
});

/**
 * Ten pairs, each tried on the street map and on satellite imagery: bright enough to
 * stand off trees and roofs, far enough apart to tell at a glance, and a couple chosen
 * for colour-blind eyes (no red against green).
 */
export const PRESETS: Preset[] = [
  { key: "classic", name: "Classic", note: "Green done, blue to do", colors: pair("#16a34a", "#1a6fd4") },
  { key: "neon", name: "Neon", note: "Best on satellite", colors: pair("#39ff14", "#ff2bd6") },
  { key: "traffic", name: "Traffic light", note: "Green done, red to do", colors: pair("#22c55e", "#ef4444") },
  { key: "colorblind", name: "Colour-blind safe", note: "Blue done, orange to do", colors: pair("#0072b2", "#e69f00") },
  { key: "sunset", name: "Sunset", note: "Amber done, indigo to do", colors: pair("#f59e0b", "#6366f1") },
  { key: "electric", name: "Electric", note: "Cyan done, yellow to do", colors: pair("#00e5ff", "#ffd60a") },
  { key: "lime", name: "Lime and navy", note: "Strong on the plain map", colors: pair("#84cc16", "#1e3a8a") },
  { key: "coral", name: "Teal and coral", note: "Soft but distinct", colors: pair("#14b8a6", "#f43f5e") },
  { key: "ghost", name: "Ghost", note: "Done fades back, to-do stands out", colors: pair("#ffffff", "#ff6b00", 0.55, 1) },
  { key: "mono", name: "Mono", note: "Dark done, grey to do", colors: pair("#111827", "#9ca3af", 1, 0.8) },
];

export const DEFAULT_COLORS: MapColors = PRESETS[0].colors;

/** A finished area's fill, by default: bright green, barely there, so the streets still read. */
export const DEFAULT_COMPLETE_FILL: StreetColor = { color: "#39ff14", opacity: 0.1 };

/** Shade finished areas: on unless you turned it off. */
export const shadeComplete = () => session.me?.user.preferences?.shade_complete !== false;
/** …in your colour and opacity, or the default. */
export const completeFill = (): StreetColor => session.me?.user.preferences?.complete_fill ?? DEFAULT_COMPLETE_FILL;
export const EXCLUDED = "#9aa7b4";

/** Yours, or the default until you've chosen. */
export function myColors(): MapColors {
  const c = (session.me?.user.preferences as { map_colors?: MapColors } | undefined)?.map_colors;
  return c?.driven && c?.undriven ? c : DEFAULT_COLORS;
}

export const samePair = (a: MapColors, b: MapColors) =>
  a.driven.color.toLowerCase() === b.driven.color.toLowerCase() && a.undriven.color.toLowerCase() === b.undriven.color.toLowerCase()
  && a.driven.opacity === b.driven.opacity && a.undriven.opacity === b.undriven.opacity;
