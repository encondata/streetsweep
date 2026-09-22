package com.example.streetsweep.car.map

import com.example.streetsweep.domain.LatLngPoint
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.tan

/** A point in "world pixels": the Web Mercator plane at a given zoom, 256·2^zoom pixels square. */
data class WorldPoint(val x: Double, val y: Double)

/** Web Mercator projection, the same one Google Maps tiles and the Static Maps API use. */
object WebMercator {
    const val TILE_SIZE = 256.0
    private const val MAX_LAT = 85.05112878

    fun worldSize(zoom: Double): Double = TILE_SIZE * 2.0.pow(zoom)

    fun project(point: LatLngPoint, zoom: Double): WorldPoint {
        val size = worldSize(zoom)
        val lat = point.latitude.coerceIn(-MAX_LAT, MAX_LAT)
        val x = (point.longitude + 180.0) / 360.0 * size
        val latRad = Math.toRadians(lat)
        val y = (1.0 - ln(tan(latRad) + 1.0 / Math.cos(latRad)) / PI) / 2.0 * size
        return WorldPoint(x, y)
    }

    fun unproject(point: WorldPoint, zoom: Double): LatLngPoint {
        val size = worldSize(zoom)
        val lng = point.x / size * 360.0 - 180.0
        val n = PI - 2.0 * PI * point.y / size
        val lat = Math.toDegrees(atan(0.5 * (exp(n) - exp(-n))))
        return LatLngPoint(lat, lng)
    }
}
