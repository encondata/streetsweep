package com.example.streetsweep.domain

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor

/** Geographic bounding box. */
data class Bounds(val south: Double, val west: Double, val north: Double, val east: Double) {
    val center: LatLngPoint get() = LatLngPoint((south + north) / 2, (west + east) / 2)

    fun contains(lat: Double, lng: Double): Boolean = lat in south..north && lng in west..east
    fun contains(p: LatLngPoint): Boolean = contains(p.latitude, p.longitude)

    fun intersects(o: Bounds): Boolean = o.north >= south && o.south <= north && o.east >= west && o.west <= east

    /** Approximate area in square miles. */
    val areaSquareMiles: Double
        get() {
            val h = (north - south) * 69.0546
            val w = (east - west) * 69.0546 * cos(Math.toRadians((south + north) / 2))
            return abs(h * w)
        }

    companion object {
        fun of(points: List<LatLngPoint>): Bounds? {
            if (points.isEmpty()) return null
            var s = points[0].latitude; var n = s; var w = points[0].longitude; var e = w
            for (p in points) {
                if (p.latitude < s) s = p.latitude
                if (p.latitude > n) n = p.latitude
                if (p.longitude < w) w = p.longitude
                if (p.longitude > e) e = p.longitude
            }
            return Bounds(s, w, n, e)
        }
    }
}

/**
 * Fixed 0.1° grid used to download and cache the street network in pieces. A cell is about
 * 7 by 5.5 miles at mid latitudes: a few thousand ways, one Overpass request.
 */
object ChunkGrid {
    const val SIZE_DEG = 0.1

    data class Cell(val latIdx: Int, val lngIdx: Int) {
        val key: String get() = "${latIdx}_$lngIdx"
        val bounds: Bounds
            get() = Bounds(latIdx * SIZE_DEG, lngIdx * SIZE_DEG, (latIdx + 1) * SIZE_DEG, (lngIdx + 1) * SIZE_DEG)
    }

    fun cellsFor(b: Bounds): List<Cell> {
        val out = ArrayList<Cell>()
        val lat0 = floor(b.south / SIZE_DEG).toInt()
        val lat1 = floor(b.north / SIZE_DEG).toInt()
        val lng0 = floor(b.west / SIZE_DEG).toInt()
        val lng1 = floor(b.east / SIZE_DEG).toInt()
        for (la in lat0..lat1) for (lo in lng0..lng1) out += Cell(la, lo)
        return out
    }
}

/** Area levels, smallest first. */
enum class AreaLevel(val label: String) {
    NEIGHBORHOOD("Neighborhood"),
    CITY("City"),
    METRO("Metro area");

    companion object {
        fun fromOrdinal(i: Int) = entries.getOrElse(i) { NEIGHBORHOOD }
    }
}
