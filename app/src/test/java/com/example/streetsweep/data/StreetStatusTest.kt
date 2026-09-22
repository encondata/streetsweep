package com.example.streetsweep.data

import com.example.streetsweep.data.db.AreaStatsRow
import com.example.streetsweep.data.db.WayCoverageRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreetStatusTest {
    private fun row(length: Double, driven: Double, excluded: Boolean = false, name: String? = "Cove Way") =
        WayCoverageRow(1L, name, "residential", length, "30.0,-97.0;30.001,-97.0", driven, excluded)

    @Test
    fun `fraction drives the three states`() {
        assertTrue(StreetStatus.fromRow(row(100.0, 0.0)).isUndriven)
        assertTrue(StreetStatus.fromRow(row(100.0, 50.0)).isPartial)
        assertTrue(StreetStatus.fromRow(row(100.0, 85.0)).isDone)
    }

    @Test
    fun `an excluded street is in none of the three states`() {
        val s = StreetStatus.fromRow(row(100.0, 85.0, excluded = true))
        assertTrue(s.excluded)
        assertFalse(s.isDone)
        assertFalse(s.isPartial)
        assertFalse(s.isUndriven)
    }

    @Test
    fun `fraction is clamped and survives a zero-length way`() {
        assertEquals(1.0, StreetStatus.fromRow(row(100.0, 250.0)).fraction, 1e-9)
        assertEquals(0.0, StreetStatus.fromRow(row(0.0, 10.0)).fraction, 1e-9)
    }

    @Test
    fun `unnamed streets still get a label`() {
        assertEquals("Cove Way", StreetStatus.fromRow(row(100.0, 0.0)).label)
        assertEquals("Unnamed residential", StreetStatus.fromRow(row(100.0, 0.0, name = null)).label)
    }

    @Test
    fun `area stats ignore nulls and report what is left`() {
        val stats = AreaStats.fromRow(AreaStatsRow(total = 10, meters = 1000.0, drivenMeters = 250.0, done = 2, partial = 3, excluded = 4))
        assertEquals(25, stats.percent)
        assertEquals(8, stats.remaining)
        assertEquals(4, stats.excluded)
        val empty = AreaStats.fromRow(AreaStatsRow(0, null, null, null, null, null))
        assertEquals(0, empty.percent)
        assertEquals(0, empty.excluded)
    }
}
