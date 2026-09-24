package com.example.streetsweep.domain

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot

/**
 * Streets a car cannot finish, however carefully it is driven.
 *
 * A traffic circle is a closed ring you enter from one road and leave by another. You
 * cover an arc of it and no more — going round again to paint in the rest is not driving,
 * it is performance. Left alone, the remaining arc never reaches the 80% that counts as
 * done, so the street stays "not driven" for ever and guidance keeps steering back to a
 * circle that has already been swept.
 *
 * OpenStreetMap does tag these, junction=roundabout, but two things make the tag no use
 * here: the app's Overpass query asks for `out geom` and so never receives tags, and in
 * the neighbourhoods this is being driven in the tag is simply absent. Of 487 ways around
 * Walden, not one carried it. So the shape has to be read instead.
 *
 * Measured against the 165 real April Sound ways in the test fixture, [isTrafficCircle]
 * picks out three and rejects the other ten closed rings for reasons that hold up:
 *
 *   47.8 m, 55.8 m, 55.8 m   circles, radius 7-10 m      -> cannot be finished
 *   137 m, 144 m             radius swings 8 m to 36 m   -> a cul-de-sac with a stem,
 *                                                           which a car does cover
 *   172-1378 m               loop streets                -> ordinary roads, drive them
 */
object RoadShape {

    /** Above this a closed ring is a loop road, not something a car circles once. */
    private const val MAX_PERIMETER_M = 150.0

    /**
     * A circle's corners all sit about the same distance from its middle. A cul-de-sac
     * drawn as one closed way has a stem, so its nearest corner is far closer in than its
     * furthest, and a car really does drive the whole of it.
     */
    private const val MAX_RADIUS_RATIO = 1.6

    /** Metres per degree of latitude; longitude shrinks by the cosine of the latitude. */
    private const val M_PER_DEG = 111_320.0

    /** Closed to within this many degrees, about 1 cm, counts as the same point. */
    private const val CLOSED_EPS = 1e-7

    fun isTrafficCircle(lengthMeters: Double, shape: List<LatLngPoint>): Boolean {
        if (shape.size < 4) return false
        if (lengthMeters <= 0.0 || lengthMeters > MAX_PERIMETER_M) return false

        val first = shape.first()
        val last = shape.last()
        if (abs(first.latitude - last.latitude) > CLOSED_EPS) return false
        if (abs(first.longitude - last.longitude) > CLOSED_EPS) return false

        val midLat = shape.sumOf { it.latitude } / shape.size
        val midLng = shape.sumOf { it.longitude } / shape.size
        val lngScale = M_PER_DEG * cos(Math.toRadians(midLat))

        var nearest = Double.MAX_VALUE
        var furthest = 0.0
        for (p in shape) {
            val r = hypot((p.latitude - midLat) * M_PER_DEG, (p.longitude - midLng) * lngScale)
            if (r < nearest) nearest = r
            if (r > furthest) furthest = r
        }
        if (nearest <= 0.0) return false
        return furthest / nearest <= MAX_RADIUS_RATIO
    }

    /**
     * How much of a street has to be driven before it counts as finished.
     *
     * The usual 80% leaves room for GPS and map-matching slop. A traffic circle gets a
     * quarter: enough that clipping the edge of one on a neighbouring road does not
     * count, far below the arc anyone actually drives through it.
     */
    fun doneFractionFor(lengthMeters: Double, shape: List<LatLngPoint>): Double =
        if (isTrafficCircle(lengthMeters, shape)) CIRCLE_DONE_FRACTION else DEFAULT_DONE_FRACTION

    const val DEFAULT_DONE_FRACTION = 0.8
    const val CIRCLE_DONE_FRACTION = 0.25
}
