package net.streetsweep.data.osm

import net.streetsweep.domain.LatLngPoint

/** Google encoded-polyline decoder. Valhalla uses precision 6, most others 5. */
object EncodedPolyline {
    fun decode(encoded: String, precision: Int = 6): List<LatLngPoint> {
        val factor = Math.pow(10.0, precision.toDouble())
        val out = ArrayList<LatLngPoint>()
        var index = 0
        var lat = 0L
        var lng = 0L
        while (index < encoded.length) {
            var result = 0L
            var shift = 0
            var b: Int
            do {
                b = encoded[index++].code - 63
                result = result or ((b and 0x1f).toLong() shl shift)
                shift += 5
            } while (b >= 0x20)
            lat += if (result and 1L != 0L) (result shr 1).inv() else result shr 1
            result = 0L
            shift = 0
            do {
                b = encoded[index++].code - 63
                result = result or ((b and 0x1f).toLong() shl shift)
                shift += 5
            } while (b >= 0x20)
            lng += if (result and 1L != 0L) (result shr 1).inv() else result shr 1
            out += LatLngPoint(lat / factor, lng / factor)
        }
        return out
    }
}

/** Compact "lat,lon;lat,lon" text form used for shapes stored in the database. */
object ShapeText {
    fun encode(points: List<LatLngPoint>): String =
        points.joinToString(";") { "${it.latitude},${it.longitude}" }

    fun decode(text: String): List<LatLngPoint> =
        if (text.isEmpty()) emptyList()
        else text.split(';').map { pair ->
            val c = pair.indexOf(',')
            LatLngPoint(pair.substring(0, c).toDouble(), pair.substring(c + 1).toDouble())
        }

    /** Several rings, "|" between them: the further pieces of an area in parts. */
    fun encodeRings(rings: List<List<LatLngPoint>>): String = rings.joinToString("|") { encode(it) }

    fun decodeRings(text: String): List<List<LatLngPoint>> =
        if (text.isEmpty()) emptyList() else text.split('|').map { decode(it) }.filter { it.size >= 3 }
}
