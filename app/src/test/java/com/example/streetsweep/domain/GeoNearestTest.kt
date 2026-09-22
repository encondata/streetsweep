package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GeoNearestTest {
    // A 1 km-ish east–west street at 30°N.
    private val a = LatLngPoint(30.0, -97.0)
    private val b = LatLngPoint(30.0, -96.99)
    private val street = listOf(a, b)

    @Test
    fun `perpendicular distance to a segment`() {
        // 0.001 degrees of latitude is about 111 m.
        val p = LatLngPoint(30.001, -96.995)
        assertEquals(111.1, Geo.distanceToSegmentMeters(p, a, b), 1.0)
    }

    @Test
    fun `a point past the end measures to the end point`() {
        val p = LatLngPoint(30.0, -96.98)
        // 0.01 degrees of longitude at 30N is about 964 m.
        val flat = Geo.distanceToSegmentMeters(p, a, b)
        assertEquals(964.0, flat, 5.0)
        // The local flat projection is deliberately approximate; it must stay within
        // 0.3% of the geodesic at this scale, which is far below GPS noise.
        val geodesic = Geo.distanceMeters(p, b)
        assertTrue(Math.abs(flat - geodesic) / geodesic < 0.003)
    }

    @Test
    fun `a point on the line measures zero`() {
        assertEquals(0.0, Geo.distanceToSegmentMeters(LatLngPoint(30.0, -96.995), a, b), 0.5)
    }

    @Test
    fun `polyline distance is the minimum over its segments`() {
        val bend = listOf(a, b, LatLngPoint(30.01, -96.99))
        val p = LatLngPoint(30.005, -96.985)
        val expected = minOf(
            Geo.distanceToSegmentMeters(p, bend[0], bend[1]),
            Geo.distanceToSegmentMeters(p, bend[1], bend[2]),
        )
        assertEquals(expected, Geo.distanceToPolylineMeters(p, bend), 1e-6)
        assertEquals(Double.MAX_VALUE, Geo.distanceToPolylineMeters(p, emptyList()), 0.0)
    }

    @Test
    fun `closest point lands on the perpendicular foot`() {
        val p = LatLngPoint(30.001, -96.995)
        val closest = Geo.closestPointOnPolyline(p, street)!!
        assertEquals(30.0, closest.latitude, 1e-6)
        assertEquals(-96.995, closest.longitude, 1e-4)
    }

    @Test
    fun `closest point clamps to an end`() {
        val closest = Geo.closestPointOnPolyline(LatLngPoint(30.0, -96.9), street)!!
        assertEquals(b.longitude, closest.longitude, 1e-6)
    }

    @Test
    fun `bearings and compass points`() {
        assertEquals(0.0, Geo.bearingDegrees(a, LatLngPoint(31.0, -97.0)), 0.5)
        assertEquals(90.0, Geo.bearingDegrees(a, LatLngPoint(30.0, -96.0)), 0.5)
        assertEquals(180.0, Geo.bearingDegrees(a, LatLngPoint(29.0, -97.0)), 0.5)
        assertEquals("N", Geo.compassPoint(0.0))
        assertEquals("E", Geo.compassPoint(90.0))
        assertEquals("NE", Geo.compassPoint(44.0))
        assertEquals("N", Geo.compassPoint(355.0))
    }

    @Test
    fun `box around a point covers the requested radius`() {
        val box = Geo.boxAround(a, 1_000.0)
        assertTrue(box.contains(a))
        // The edges sit about 1 km away, and a point 2 km off is outside.
        assertEquals(1_000.0, Geo.distanceMeters(a, LatLngPoint(box.north, a.longitude)), 20.0)
        assertEquals(1_000.0, Geo.distanceMeters(a, LatLngPoint(a.latitude, box.east)), 20.0)
        assertTrue(!box.contains(LatLngPoint(30.02, -97.0)))
    }
}
