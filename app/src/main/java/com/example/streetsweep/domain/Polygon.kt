package com.example.streetsweep.domain

/** Simple polygon helpers on lat/lng vertices (no holes, implicitly closed). */
object Polygon {
    /** Ray-casting point-in-polygon; works for concave shapes. */
    fun contains(vertices: List<LatLngPoint>, p: LatLngPoint): Boolean {
        if (vertices.size < 3) return false
        var inside = false
        var j = vertices.size - 1
        for (i in vertices.indices) {
            val yi = vertices[i].latitude; val xi = vertices[i].longitude
            val yj = vertices[j].latitude; val xj = vertices[j].longitude
            val crosses = (yi > p.latitude) != (yj > p.latitude)
            if (crosses) {
                val x = (xj - xi) * (p.latitude - yi) / (yj - yi) + xi
                if (p.longitude < x) inside = !inside
            }
            j = i
        }
        return inside
    }

    fun rectangle(b: Bounds): List<LatLngPoint> = listOf(
        LatLngPoint(b.north, b.west), LatLngPoint(b.north, b.east),
        LatLngPoint(b.south, b.east), LatLngPoint(b.south, b.west),
    )
}
