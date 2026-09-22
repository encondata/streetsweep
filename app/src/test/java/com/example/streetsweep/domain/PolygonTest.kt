package com.example.streetsweep.domain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolygonTest {
    // An L-shaped neighbourhood (concave).
    private val l = listOf(
        LatLngPoint(0.0, 0.0), LatLngPoint(0.0, 2.0), LatLngPoint(1.0, 2.0),
        LatLngPoint(1.0, 1.0), LatLngPoint(2.0, 1.0), LatLngPoint(2.0, 0.0),
    )

    @Test
    fun `points inside the L are inside`() {
        assertTrue(Polygon.contains(l, LatLngPoint(0.5, 0.5)))
        assertTrue(Polygon.contains(l, LatLngPoint(0.5, 1.5)))
        assertTrue(Polygon.contains(l, LatLngPoint(1.5, 0.5)))
    }

    @Test
    fun `the notch of the L is outside`() {
        assertFalse(Polygon.contains(l, LatLngPoint(1.5, 1.5)))
        assertFalse(Polygon.contains(l, LatLngPoint(-0.1, 0.5)))
        assertFalse(Polygon.contains(l, LatLngPoint(3.0, 3.0)))
    }

    @Test
    fun `fewer than three vertices contain nothing`() {
        assertFalse(Polygon.contains(l.take(2), LatLngPoint(0.5, 0.5)))
    }

    @Test
    fun `rectangle helper matches bounds containment`() {
        val b = Bounds(30.0, -98.0, 31.0, -97.0)
        val r = Polygon.rectangle(b)
        assertTrue(Polygon.contains(r, LatLngPoint(30.5, -97.5)))
        assertFalse(Polygon.contains(r, LatLngPoint(31.5, -97.5)))
    }
}
