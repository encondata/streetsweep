package com.example.streetsweep.car.map

import com.example.streetsweep.domain.LatLngPoint
import org.junit.Assert.assertEquals
import org.junit.Test

class WebMercatorTest {
    @Test
    fun `origin projects to the centre of the world`() {
        val p = WebMercator.project(LatLngPoint(0.0, 0.0), 1.0)
        assertEquals(256.0, p.x, 1e-9)
        assertEquals(256.0, p.y, 1e-9)
    }

    @Test
    fun `project and unproject round-trip`() {
        val original = LatLngPoint(30.2672, -97.7431)
        val back = WebMercator.unproject(WebMercator.project(original, 15.0), 15.0)
        assertEquals(original.latitude, back.latitude, 1e-7)
        assertEquals(original.longitude, back.longitude, 1e-7)
    }

    @Test
    fun `doubling zoom doubles world coordinates`() {
        val p = LatLngPoint(45.0, 90.0)
        val a = WebMercator.project(p, 10.0)
        val b = WebMercator.project(p, 11.0)
        assertEquals(a.x * 2, b.x, 1e-6)
        assertEquals(a.y * 2, b.y, 1e-6)
    }
}
