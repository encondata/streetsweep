package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pinned to the real April Sound network rather than shapes invented to pass.
 *
 * The fixture holds 165 ways as OpenStreetMap has them. Thirteen are closed rings, and
 * only three of those are circles a car cannot finish. The rest are cul-de-sacs with a
 * stem, or loop streets several hundred metres round, and a car does drive all of those —
 * so calling them finished early would hide real work.
 */
class RoadShapeTest {

    private class Way(val id: Long, val lengthMeters: Double, val shape: List<LatLngPoint>)

    private fun load(): List<Way> {
        val text = checkNotNull(javaClass.classLoader?.getResourceAsStream("april-sound-ways.txt")) {
            "april-sound-ways.txt is missing from test resources"
        }.bufferedReader().readText()

        return text.lineSequence().filter { it.isNotBlank() }.map { line ->
            val (id, length, _, shape) = line.split('|', limit = 4)
            val points = shape.split(';').map {
                val comma = it.indexOf(',')
                LatLngPoint(it.substring(0, comma).toDouble(), it.substring(comma + 1).toDouble())
            }
            Way(id.toLong(), length.toDouble(), points)
        }.toList()
    }

    private fun closed(w: Way): Boolean {
        if (w.shape.size < 4) return false
        val a = w.shape.first()
        val b = w.shape.last()
        return kotlin.math.abs(a.latitude - b.latitude) < 1e-7 &&
            kotlin.math.abs(a.longitude - b.longitude) < 1e-7
    }

    @Test
    fun `picks out only the three circles a car cannot finish`() {
        val ways = load()
        assertEquals("fixture changed", 165, ways.size)

        val circles = ways.filter { RoadShape.isTrafficCircle(it.lengthMeters, it.shape) }
            .map { it.id }
            .sorted()

        // 47.8 m, 55.8 m and 55.8 m, each a ring of radius 7-10 m.
        assertEquals(listOf(366506912L, 366506915L, 944277187L), circles)
    }

    @Test
    fun `leaves the other closed rings alone`() {
        val ways = load()
        val rings = ways.filter { closed(it) }
        assertEquals("fixture changed", 13, rings.size)

        // The ten that are not circles are a car's work to drive, whatever their shape.
        val kept = rings.filterNot { RoadShape.isTrafficCircle(it.lengthMeters, it.shape) }
        assertEquals(10, kept.size)
        kept.forEach {
            assertEquals(
                "way ${it.id} (${it.lengthMeters} m) should keep the ordinary threshold",
                RoadShape.DEFAULT_DONE_FRACTION,
                RoadShape.doneFractionFor(it.lengthMeters, it.shape),
                1e-9,
            )
        }
    }

    @Test
    fun `an open street is never a circle, however short`() {
        val ways = load()
        ways.filterNot { closed(it) }.forEach {
            assertFalse(
                "way ${it.id} is not closed and must not be treated as a circle",
                RoadShape.isTrafficCircle(it.lengthMeters, it.shape),
            )
        }
    }

    @Test
    fun `a circle is finished by driving a quarter of it, an ordinary street is not`() {
        val ways = load()
        val circle = ways.first { RoadShape.isTrafficCircle(it.lengthMeters, it.shape) }
        assertEquals(
            RoadShape.CIRCLE_DONE_FRACTION,
            RoadShape.doneFractionFor(circle.lengthMeters, circle.shape),
            1e-9,
        )
        assertTrue(
            "a quarter has to be less than the usual bar or nothing changes",
            RoadShape.CIRCLE_DONE_FRACTION < RoadShape.DEFAULT_DONE_FRACTION,
        )
    }

    @Test
    fun `a perfect ring the size of a loop street is left to be driven`() {
        // 200 m radius, so about 1.26 km round: uniform, closed, and entirely drivable.
        val centreLat = 30.39
        val centreLng = -95.64
        val metresPerDegLat = 111_320.0
        val metresPerDegLng = metresPerDegLat * kotlin.math.cos(Math.toRadians(centreLat))
        val ring = (0..36).map { step ->
            val angle = Math.toRadians(step * 10.0)
            LatLngPoint(
                centreLat + (200.0 * kotlin.math.cos(angle)) / metresPerDegLat,
                centreLng + (200.0 * kotlin.math.sin(angle)) / metresPerDegLng,
            )
        }
        assertFalse(RoadShape.isTrafficCircle(1256.0, ring))
    }
}
