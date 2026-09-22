package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class GeoTest {
    @Test
    fun `haversine matches a known distance`() {
        // Empire State Building to Statue of Liberty ≈ 8.25 km
        val a = LatLngPoint(40.748817, -73.985428)
        val b = LatLngPoint(40.689247, -74.044502)
        assertEquals(8_250.0, Geo.distanceMeters(a, b), 60.0)
    }

    @Test
    fun `zero distance for identical points`() {
        val p = LatLngPoint(1.0, 2.0)
        assertEquals(0.0, Geo.distanceMeters(p, p), 1e-9)
    }

    @Test
    fun `formats feet below a tenth of a mile and miles above`() {
        assertEquals("100 ft", Geo.formatDistance(Geo.feetToMeters(100.0)))
        assertEquals("1.50 mi", Geo.formatDistance(1.5 * Geo.METERS_PER_MILE))
    }
}
