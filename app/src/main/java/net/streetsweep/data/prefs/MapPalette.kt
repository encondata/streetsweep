package net.streetsweep.data.prefs

import org.json.JSONObject

/**
 * The colours streets and finished areas are drawn in, chosen on the web (Preferences)
 * and brought down at each sync, so the phone and car screen look like the web map.
 * Colours are ARGB ints with the chosen opacity folded in.
 */
data class MapPalette(
    val driven: Int,
    val undriven: Int,
    /** Fill for an area with every street done, or null when shading is switched off. */
    val completeFill: Int?,
    /** Left-out (gated) streets are drawn candy-striped: bands of this and white. */
    val excluded: Int = DEFAULT_STRIPE,
) {
    fun encode(): String = "$driven,$undriven,${completeFill ?: ""},$excluded"

    companion object {
        /** The web's defaults: Classic green and blue, finished areas a faint bright green. */
        val DEFAULT = MapPalette(argb("#16a34a", 1.0), argb("#1a6fd4", 0.9), argb("#39ff14", 0.1))

        /** Candy-cane red, the web's default for left-out streets. */
        val DEFAULT_STRIPE = argb("#dc2626", 1.0)

        /** The web's stripe presets (Preferences → Left-out streets), name to colour. */
        val STRIPE_PRESETS = listOf(
            "Candy cane red" to "#dc2626", "Traffic orange" to "#ea580c", "Purple" to "#7c3aed",
            "Pink" to "#db2777", "Black" to "#111827", "Gold" to "#ca8a04",
        )

        fun decode(s: String): MapPalette? = runCatching {
            val p = s.split(",")
            MapPalette(p[0].toInt(), p[1].toInt(), p.getOrNull(2)?.takeIf { it.isNotEmpty() }?.toInt(),
                p.getOrNull(3)?.takeIf { it.isNotEmpty() }?.toInt() ?: DEFAULT_STRIPE)
        }.getOrNull()

        /** From sync's user.preferences: map_colors, shade_complete, complete_fill, excluded_color (null = default). */
        fun fromServer(prefs: JSONObject): MapPalette {
            fun pick(o: JSONObject?, fallback: Int): Int {
                val c = o?.optString("color")?.takeIf { it.matches(Regex("#[0-9a-fA-F]{6}")) } ?: return fallback
                return argb(c, o.optDouble("opacity", 1.0))
            }
            val colors = prefs.optJSONObject("map_colors")
            return MapPalette(
                driven = pick(colors?.optJSONObject("driven"), DEFAULT.driven),
                undriven = pick(colors?.optJSONObject("undriven"), DEFAULT.undriven),
                completeFill = if (!prefs.optBoolean("shade_complete", true)) null
                    else pick(prefs.optJSONObject("complete_fill"), DEFAULT.completeFill!!),
                excluded = prefs.optString("excluded_color").takeIf { it.matches(Regex("#[0-9a-fA-F]{6}")) }
                    ?.let { argb(it, 1.0) } ?: DEFAULT_STRIPE,
            )
        }

        fun argb(hex: String, opacity: Double): Int {
            val rgb = hex.removePrefix("#").toLong(16).toInt() and 0xFFFFFF
            val a = (opacity.coerceIn(0.0, 1.0) * 255).toInt()
            return (a shl 24) or rgb
        }
    }
}
