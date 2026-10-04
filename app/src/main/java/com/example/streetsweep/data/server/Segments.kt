package com.example.streetsweep.data.server

import com.example.streetsweep.data.osm.EncodedPolyline
import com.example.streetsweep.domain.LatLngPoint
import org.json.JSONObject

/** A street segment as the server sends it: a piece of an OSM way between intersections. */
data class ServerSegment(
    val id: Long,
    val wayId: Long,
    val name: String?,
    val highway: String,
    val lengthMeters: Double,
    val shape: List<LatLngPoint>,
    /** In an area package: how much of it lies inside the area. */
    val insideMeters: Double? = null,
)

/**
 * Reads the server's compact street format (an area package or a box):
 * `{ names, highways, segments: [[id, way, name#, highway#, length, inside?, polyline6]] }`.
 */
object Segments {
    fun parse(json: JSONObject): List<ServerSegment> {
        val names = json.optJSONArray("names")
        val highways = json.optJSONArray("highways")
        val rows = json.optJSONArray("segments") ?: return emptyList()
        val out = ArrayList<ServerSegment>(rows.length())
        for (i in 0 until rows.length()) {
            val r = rows.getJSONArray(i)
            // Packages carry the inside length as a sixth field; boxes don't.
            val line = r.getString(r.length() - 1)
            val shape = EncodedPolyline.decode(line, 6)
            if (shape.size < 2) continue
            val nameIdx = r.getInt(2)
            out += ServerSegment(
                id = r.getLong(0),
                wayId = r.getLong(1),
                name = if (nameIdx >= 0 && names != null) names.optString(nameIdx).takeIf { it.isNotBlank() } else null,
                highway = highways?.optString(r.getInt(3)).orEmpty().ifBlank { "residential" },
                lengthMeters = r.getDouble(4),
                shape = shape,
                insideMeters = if (r.length() >= 7) r.getDouble(5) else null,
            )
        }
        return out
    }
}
