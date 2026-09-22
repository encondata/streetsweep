package com.example.streetsweep.data.osm

import com.example.streetsweep.domain.AreaLevel
import com.example.streetsweep.domain.LatLngPoint
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** An area read out of a GeoJSON file, before it becomes a row in the database. */
data class ImportedArea(
    val name: String,
    val level: AreaLevel,
    /** Name of another imported area this one sits inside, if any. */
    val parent: String?,
    val polygon: List<LatLngPoint>,
)

class AreaImportException(message: String) : Exception(message)

/**
 * Reads coverage areas out of GeoJSON, so outlines can be drawn on a computer (see
 * `tools/area-builder.html`) and brought over to the phone.
 *
 * Accepts anything with polygon geometry: features written by StreetSweep carry
 * `kind: "area"`, and a plain polygon from any other editor is taken as an area too.
 * Line and point features, which StreetSweep's own coverage export is full of, are skipped.
 */
object AreaGeoJson {

    fun parse(text: String): List<ImportedArea> {
        val root = try {
            JSONObject(text)
        } catch (e: JSONException) {
            throw AreaImportException("That file is not GeoJSON")
        }
        val features = root.optJSONArray("features")
            ?: if (root.optString("type") == "Feature") JSONArray().put(root) else null
            ?: throw AreaImportException("No features in that file")

        val out = ArrayList<ImportedArea>()
        var unnamed = 0
        for (i in 0 until features.length()) {
            val feature = features.optJSONObject(i) ?: continue
            val geometry = feature.optJSONObject("geometry") ?: continue
            val properties = feature.optJSONObject("properties") ?: JSONObject()
            val kind = properties.optString("kind").takeIf { it.isNotEmpty() }
            if (kind != null && kind != "area") continue

            for (ring in rings(geometry)) {
                val points = ring.dropLastIfClosed()
                if (points.size < 3) continue
                val name = properties.optString("name").takeIf { it.isNotBlank() }
                    ?: "Imported area ${++unnamed}"
                out += ImportedArea(
                    name = name,
                    level = level(properties.opt("level")),
                    parent = properties.optString("parent").takeIf { it.isNotBlank() },
                    polygon = points,
                )
            }
        }
        if (out.isEmpty()) throw AreaImportException("No area outlines in that file")
        return out
    }

    /** Outer rings only: a hole in a coverage area has no meaning here. */
    private fun rings(geometry: JSONObject): List<List<LatLngPoint>> = when (geometry.optString("type")) {
        "Polygon" -> listOfNotNull(ring(geometry.optJSONArray("coordinates")?.optJSONArray(0)))
        "MultiPolygon" -> {
            val polygons = geometry.optJSONArray("coordinates")
            (0 until (polygons?.length() ?: 0)).mapNotNull { ring(polygons?.optJSONArray(it)?.optJSONArray(0)) }
        }
        else -> emptyList()
    }

    private fun ring(coordinates: JSONArray?): List<LatLngPoint>? {
        if (coordinates == null) return null
        val points = ArrayList<LatLngPoint>(coordinates.length())
        for (i in 0 until coordinates.length()) {
            val pair = coordinates.optJSONArray(i) ?: continue
            if (pair.length() < 2) continue
            // GeoJSON is longitude first.
            points += LatLngPoint(pair.optDouble(1), pair.optDouble(0))
        }
        return points.takeIf { it.isNotEmpty() }
    }

    /** GeoJSON rings repeat their first point; StreetSweep's polygons do not. */
    private fun List<LatLngPoint>.dropLastIfClosed(): List<LatLngPoint> =
        if (size > 1 && first() == last()) dropLast(1) else this

    /** Accepts a name from the builder, or the ordinal that older exports wrote. */
    private fun level(raw: Any?): AreaLevel = when (raw) {
        is String -> AreaLevel.entries.firstOrNull { it.name.equals(raw, ignoreCase = true) } ?: AreaLevel.NEIGHBORHOOD
        is Number -> AreaLevel.fromOrdinal(raw.toInt())
        else -> AreaLevel.NEIGHBORHOOD
    }
}
