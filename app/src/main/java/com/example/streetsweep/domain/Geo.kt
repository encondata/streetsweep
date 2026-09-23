package com.example.streetsweep.domain

import java.util.Locale
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

object Geo {
    const val FEET_PER_METER = 3.280839895
    const val METERS_PER_MILE = 1609.344
    private const val EARTH_RADIUS_METERS = 6_371_008.8

    /** Great-circle distance (haversine). Accurate to well under 1% at street scale. */
    fun distanceMeters(a: LatLngPoint, b: LatLngPoint): Double {
        val lat1 = Math.toRadians(a.latitude)
        val lat2 = Math.toRadians(b.latitude)
        val dLat = lat2 - lat1
        val dLon = Math.toRadians(b.longitude - a.longitude)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * EARTH_RADIUS_METERS * asin(sqrt(h))
    }

    fun feetToMeters(feet: Double): Double = feet / FEET_PER_METER

    fun metersToFeet(meters: Double): Double = meters * FEET_PER_METER

    private const val METERS_PER_DEG_LAT = 111_132.0

    private fun metersPerDegLng(latitude: Double) = 111_320.0 * cos(Math.toRadians(latitude))

    /**
     * Shortest distance from [p] to the segment [a]–[b].
     *
     * Uses a local flat projection centred on [p]; at street scale (metres to a few km) the
     * error against a true geodesic is far below GPS noise, and it is fast enough to run over
     * hundreds of streets on every location update.
     */
    fun distanceToSegmentMeters(p: LatLngPoint, a: LatLngPoint, b: LatLngPoint): Double {
        val mLng = metersPerDegLng(p.latitude)
        val ax = (a.longitude - p.longitude) * mLng
        val ay = (a.latitude - p.latitude) * METERS_PER_DEG_LAT
        val bx = (b.longitude - p.longitude) * mLng
        val by = (b.latitude - p.latitude) * METERS_PER_DEG_LAT
        val dx = bx - ax
        val dy = by - ay
        val len2 = dx * dx + dy * dy
        if (len2 == 0.0) return hypot(ax, ay)
        val t = (-(ax * dx + ay * dy) / len2).coerceIn(0.0, 1.0)
        return hypot(ax + t * dx, ay + t * dy)
    }

    /** Shortest distance from [p] to a polyline, or [Double.MAX_VALUE] for an empty one. */
    /** How long a polyline is, end to end. */
    fun pathLengthMeters(line: List<LatLngPoint>): Double {
        var total = 0.0
        for (i in 0 until line.size - 1) total += distanceMeters(line[i], line[i + 1])
        return total
    }

    fun distanceToPolylineMeters(p: LatLngPoint, line: List<LatLngPoint>): Double {
        if (line.isEmpty()) return Double.MAX_VALUE
        if (line.size == 1) return distanceMeters(p, line[0])
        var best = Double.MAX_VALUE
        for (i in 1 until line.size) {
            val d = distanceToSegmentMeters(p, line[i - 1], line[i])
            if (d < best) best = d
        }
        return best
    }

    /** The point on [line] closest to [p]. */
    fun closestPointOnPolyline(p: LatLngPoint, line: List<LatLngPoint>): LatLngPoint? {
        if (line.isEmpty()) return null
        if (line.size == 1) return line[0]
        var best = Double.MAX_VALUE
        var bestPoint = line[0]
        val mLng = metersPerDegLng(p.latitude)
        for (i in 1 until line.size) {
            val a = line[i - 1]
            val b = line[i]
            val ax = (a.longitude - p.longitude) * mLng
            val ay = (a.latitude - p.latitude) * METERS_PER_DEG_LAT
            val bx = (b.longitude - p.longitude) * mLng
            val by = (b.latitude - p.latitude) * METERS_PER_DEG_LAT
            val dx = bx - ax
            val dy = by - ay
            val len2 = dx * dx + dy * dy
            val t = if (len2 == 0.0) 0.0 else (-(ax * dx + ay * dy) / len2).coerceIn(0.0, 1.0)
            val d = hypot(ax + t * dx, ay + t * dy)
            if (d < best) {
                best = d
                bestPoint = LatLngPoint(a.latitude + (b.latitude - a.latitude) * t, a.longitude + (b.longitude - a.longitude) * t)
            }
        }
        return bestPoint
    }

    /** Initial bearing from [from] to [to] in degrees, 0 = north, increasing clockwise. */
    fun bearingDegrees(from: LatLngPoint, to: LatLngPoint): Double {
        val lat1 = Math.toRadians(from.latitude)
        val lat2 = Math.toRadians(to.latitude)
        val dLon = Math.toRadians(to.longitude - from.longitude)
        val y = sin(dLon) * cos(lat2)
        val x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    /** Smallest angle between two bearings, 0..180. */
    fun angularDifference(a: Double, b: Double): Double =
        Math.abs((((a - b) % 360) + 540) % 360 - 180)

    /** Where [bearing] lies relative to [heading]: -180..180, negative left, positive right. */
    fun relativeBearing(heading: Double, bearing: Double): Double =
        (((bearing - heading) % 360) + 540) % 360 - 180

    private val COMPASS = listOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")

    fun compassPoint(bearing: Double): String =
        COMPASS[((((bearing % 360) + 360) % 360) / 45.0).roundToInt() % 8]

    /** A box roughly [meters] in every direction from [center]. */
    fun boxAround(center: LatLngPoint, meters: Double): Bounds {
        val dLat = meters / METERS_PER_DEG_LAT
        val dLng = meters / metersPerDegLng(center.latitude).coerceAtLeast(1.0)
        return Bounds(center.latitude - dLat, center.longitude - dLng, center.latitude + dLat, center.longitude + dLng)
    }

    /** Short human-readable distance in US units: feet under 0.1 mi, otherwise miles. */
    fun formatDistance(meters: Double): String =
        if (meters < METERS_PER_MILE / 10) {
            "${metersToFeet(meters).roundToInt()} ft"
        } else {
            String.format(Locale.US, "%.2f mi", meters / METERS_PER_MILE)
        }
}
