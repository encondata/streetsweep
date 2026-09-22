package com.example.streetsweep.data.osm

import com.example.streetsweep.domain.LatLngPoint
import org.junit.Assert.assertEquals
import org.junit.Test

class EncodedPolylineTest {
    @Test
    fun `decodes the Google reference example at precision 5`() {
        val pts = EncodedPolyline.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision = 5)
        assertEquals(3, pts.size)
        assertEquals(38.5, pts[0].latitude, 1e-5)
        assertEquals(-120.2, pts[0].longitude, 1e-5)
        assertEquals(43.252, pts[2].latitude, 1e-5)
        assertEquals(-126.453, pts[2].longitude, 1e-5)
    }

    @Test
    fun `shape text round-trips`() {
        val pts = listOf(LatLngPoint(30.2672, -97.7431), LatLngPoint(30.2683, -97.7431))
        assertEquals(pts, ShapeText.decode(ShapeText.encode(pts)))
        assertEquals(emptyList<LatLngPoint>(), ShapeText.decode(""))
    }
}
