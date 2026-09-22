package com.example.streetsweep.data

import com.example.streetsweep.domain.LatLngPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class CoverageRepositoryTest {
    private val a = LatLngPoint(30.26775, -97.74310)
    private val b = LatLngPoint(30.26830, -97.74310)

    @Test
    fun `edge key ignores direction`() {
        assertEquals(CoverageRepository.edgeKey(1L, a, b), CoverageRepository.edgeKey(1L, b, a))
    }

    @Test
    fun `edge key distinguishes ways and end points`() {
        assertNotEquals(CoverageRepository.edgeKey(1L, a, b), CoverageRepository.edgeKey(2L, a, b))
        assertNotEquals(CoverageRepository.edgeKey(1L, a, b), CoverageRepository.edgeKey(1L, a, LatLngPoint(30.2690, -97.7431)))
    }

    @Test
    fun `edge key tolerates sub-metre jitter`() {
        val jittered = LatLngPoint(b.latitude + 0.000004, b.longitude)
        assertEquals(CoverageRepository.edgeKey(1L, a, b), CoverageRepository.edgeKey(1L, a, jittered))
    }

    @Test
    fun `street is done above the threshold and partial below`() {
        fun status(fraction: Double) = StreetStatus(1L, "A St", "residential", 100.0, emptyList(), fraction)
        assertEquals(true, status(0.85).isDone)
        assertEquals(false, status(0.5).isDone)
        assertEquals(true, status(0.5).isPartial)
        assertEquals(false, status(0.0).isPartial)
    }
}

class DeepestAreaTest {
    private fun area(id: Long, level: Int, b: com.example.streetsweep.domain.Bounds) = AreaWithStats(
        com.example.streetsweep.data.db.CoverageArea(
            id = id, name = "a$id", level = level,
            polygon = com.example.streetsweep.data.osm.ShapeText.encode(com.example.streetsweep.domain.Polygon.rectangle(b)),
            south = b.south, west = b.west, north = b.north, east = b.east, createdAt = 0,
        ),
        AreaStats.EMPTY,
    )

    @org.junit.Test
    fun `picks the smallest level area containing the point`() {
        val metro = area(1, 2, com.example.streetsweep.domain.Bounds(29.0, -96.0, 31.0, -94.0))
        val city = area(2, 1, com.example.streetsweep.domain.Bounds(30.0, -95.5, 30.5, -95.0))
        val hood = area(3, 0, com.example.streetsweep.domain.Bounds(30.1, -95.3, 30.2, -95.2))
        val all = listOf(metro, city, hood)
        assertEquals(3L, CoverageRepository.deepestContaining(all, LatLngPoint(30.15, -95.25))?.area?.id)
        assertEquals(2L, CoverageRepository.deepestContaining(all, LatLngPoint(30.4, -95.1))?.area?.id)
        assertEquals(1L, CoverageRepository.deepestContaining(all, LatLngPoint(29.5, -95.9))?.area?.id)
        assertEquals(null, CoverageRepository.deepestContaining(all, LatLngPoint(35.0, -95.0)))
    }
}
