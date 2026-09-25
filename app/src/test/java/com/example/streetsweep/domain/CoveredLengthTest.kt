package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class CoveredLengthTest {
    // A straight east-west street about 1 km long.
    private val street = listOf(LatLngPoint(30.0, -95.0), LatLngPoint(30.0, -94.99))
    private val length = Geo.distanceMeters(street[0], street[1])

    private fun seg(fromFraction: Double, toFraction: Double, offsetDeg: Double = 0.00003) = listOf(
        LatLngPoint(30.0 + offsetDeg, -95.0 + 0.01 * fromFraction),
        LatLngPoint(30.0 + offsetDeg, -95.0 + 0.01 * toFraction),
    )

    @Test
    fun `overlapping segments count once`() {
        // Two drives over the same first half, matched with slightly different end points:
        // summed, they read as 95% of the street.
        val covered = CoveredLength.of(street, listOf(seg(0.0, 0.5), seg(0.05, 0.5)))
        assertEquals(0.5 * length, covered, 5.0)
    }

    @Test
    fun `separate stretches add up`() {
        val covered = CoveredLength.of(street, listOf(seg(0.0, 0.25), seg(0.5, 0.75)))
        assertEquals(0.5 * length, covered, 5.0)
    }

    @Test
    fun `a segment on another street is ignored`() {
        val elsewhere = listOf(LatLngPoint(30.01, -95.0), LatLngPoint(30.01, -94.995))
        assertEquals(0.0, CoveredLength.of(street, listOf(elsewhere)), 0.001)
    }

    @Test
    fun `a turning circle driven in two halves counts all the way round`() {
        // A closed loop about 60 m round, as OpenStreetMap draws a cul-de-sac circle.
        val centre = LatLngPoint(30.0, -95.0)
        val r = 0.00009
        val loop = (0..20).map { i ->
            val a = 2 * Math.PI * i / 20
            LatLngPoint(centre.latitude + r * kotlin.math.sin(a), centre.longitude + r * kotlin.math.cos(a) / kotlin.math.cos(Math.toRadians(30.0)))
        }
        val round = (1 until loop.size).sumOf { Geo.distanceMeters(loop[it - 1], loop[it]) }
        val covered = CoveredLength.of(loop, listOf(loop.subList(0, 11), loop.subList(10, 21)))
        assertEquals(round, covered, 3.0)
    }

    @Test
    fun `a short segment at the start of a loop is not read as the whole loop`() {
        val centre = LatLngPoint(30.0, -95.0)
        val r = 0.00009
        val loop = (0..20).map { i ->
            val a = 2 * Math.PI * i / 20
            LatLngPoint(centre.latitude + r * kotlin.math.sin(a), centre.longitude + r * kotlin.math.cos(a) / kotlin.math.cos(Math.toRadians(30.0)))
        }
        val step = Geo.distanceMeters(loop[0], loop[1])
        assertEquals(2 * step, CoveredLength.of(loop, listOf(loop.subList(0, 3))), 2.0)
    }
}
