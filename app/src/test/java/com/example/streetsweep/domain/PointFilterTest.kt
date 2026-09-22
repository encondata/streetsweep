package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class PointFilterTest {
    private val filter = PointFilter()
    private val origin = LatLngPoint(30.2672, -97.7431) // Austin, TX

    /** Moves [feet] north of [from]; 1 degree of latitude ≈ 364,000 ft. */
    private fun north(from: LatLngPoint, feet: Double) = from.copy(latitude = from.latitude + feet / 364_000.0)

    @Test
    fun `first point is always stored`() {
        assertEquals(PointFilter.Decision.STORE, filter.evaluate(origin, 5f, lastStored = null))
    }

    @Test
    fun `point 40 ft away is too close`() {
        assertEquals(PointFilter.Decision.TOO_CLOSE, filter.evaluate(north(origin, 40.0), 5f, origin))
    }

    @Test
    fun `point 60 ft away is stored`() {
        assertEquals(PointFilter.Decision.STORE, filter.evaluate(north(origin, 60.0), 5f, origin))
    }

    @Test
    fun `identical point while stopped at a light is too close`() {
        assertEquals(PointFilter.Decision.TOO_CLOSE, filter.evaluate(origin, 5f, origin))
    }

    @Test
    fun `threshold is 50 ft`() {
        assertEquals(15.24, PointFilter.MIN_SPACING_METERS, 0.01)
        assertEquals(PointFilter.Decision.STORE, filter.evaluate(north(origin, 50.5), 5f, origin))
        assertEquals(PointFilter.Decision.TOO_CLOSE, filter.evaluate(north(origin, 49.5), 5f, origin))
    }

    @Test
    fun `inaccurate fix is discarded even when far away`() {
        assertEquals(PointFilter.Decision.INACCURATE, filter.evaluate(north(origin, 500.0), 120f, origin))
    }

    @Test
    fun `unknown accuracy is allowed through`() {
        assertEquals(PointFilter.Decision.STORE, filter.evaluate(north(origin, 60.0), 0f, origin))
    }
}
