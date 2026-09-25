package com.example.streetsweep.domain

import kotlin.math.cos

/**
 * How much of a street has been driven, counting each stretch once.
 *
 * Adding up the lengths of a street's driven segments counts a stretch twice whenever two
 * drives were matched with slightly different end points, which happens all the time: a
 * trace that starts or ends mid-block produces a short segment over part of a longer one
 * already recorded. Brookhaven Drive in Walden summed to 97% driven with its spur never
 * touched; laid onto the street, its segments cover 69%.
 *
 * So each segment is projected onto the street's own line, the stretches it covers are
 * merged, and the merged length is what counts.
 */
object CoveredLength {
    /** A point further than this from the street is not on it. */
    const val ON_STREET_METERS = 30.0

    fun of(street: List<LatLngPoint>, segments: List<List<LatLngPoint>>): Double {
        if (street.size < 2 || segments.isEmpty()) return 0.0
        val runs = ArrayList<DoubleArray>()
        for (seg in segments) {
            // Point by point, so a street that loops back on itself (a cul-de-sac circle, a
            // crescent) cannot turn a short segment into a run round the whole loop: each
            // step may only cover about as much street as it covers ground.
            var prev: LatLngPoint? = null
            var prevAt = Double.NaN
            for (p in seg) {
                val hit = along(street, p, prevAt)
                if (hit[1] > ON_STREET_METERS) { prev = null; prevAt = Double.NaN; continue }
                val at = hit[0]
                if (prev != null && !prevAt.isNaN()) {
                    val ground = Geo.distanceMeters(prev, p)
                    if (kotlin.math.abs(at - prevAt) <= ground * 2.0 + 15.0) {
                        runs += doubleArrayOf(minOf(at, prevAt), maxOf(at, prevAt))
                    }
                }
                prev = p
                prevAt = at
            }
        }
        runs.sortBy { it[0] }
        var total = 0.0
        var start = Double.NaN
        var end = Double.NaN
        for (r in runs) {
            if (start.isNaN() || r[0] > end) {
                if (!start.isNaN()) total += end - start
                start = r[0]
                end = r[1]
            } else if (r[1] > end) {
                end = r[1]
            }
        }
        if (!start.isNaN()) total += end - start
        return total
    }

    /**
     * [meters along the street to p's foot, meters p lies off the street]. Where the street
     * passes p more than once about as closely, the place nearest [near] (the previous
     * point's) wins, which keeps a segment on the stretch it is travelling.
     */
    private fun along(line: List<LatLngPoint>, p: LatLngPoint, near: Double): DoubleArray {
        val k = cos(Math.toRadians(p.latitude))
        val offs = DoubleArray(line.size - 1)
        val ats = DoubleArray(line.size - 1)
        var run = 0.0
        var bestOff = Double.MAX_VALUE
        for (i in 1 until line.size) {
            val a = line[i - 1]
            val b = line[i]
            val seg = Geo.distanceMeters(a, b)
            val ax = a.longitude * k
            val ay = a.latitude
            val dx = b.longitude * k - ax
            val dy = b.latitude - ay
            val l2 = dx * dx + dy * dy
            val t = if (l2 == 0.0) 0.0 else (((p.longitude * k - ax) * dx + (p.latitude - ay) * dy) / l2).coerceIn(0.0, 1.0)
            offs[i - 1] = Geo.distanceMeters(LatLngPoint(ay + dy * t, (ax + dx * t) / k), p)
            ats[i - 1] = run + seg * t
            if (offs[i - 1] < bestOff) bestOff = offs[i - 1]
            run += seg
        }
        var pick = -1
        for (i in offs.indices) {
            if (offs[i] > bestOff + TIE_METERS) continue
            if (pick < 0 || (if (near.isNaN()) offs[i] < offs[pick]
                    else kotlin.math.abs(ats[i] - near) < kotlin.math.abs(ats[pick] - near))) pick = i
        }
        return doubleArrayOf(ats[pick], offs[pick])
    }

    /** Two places on the street this close in distance from a point are equally good matches. */
    private const val TIE_METERS = 2.0
}
