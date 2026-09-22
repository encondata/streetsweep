package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PaceTest {
    private val now = 2_900L // an arbitrary week number

    @Test
    fun `averages over the window, counting quiet weeks as zero`() {
        val weeks = listOf(now to 4_000.0, now - 1 to 4_000.0)
        // 8 km spread over a four-week window.
        assertEquals(2_000.0, Pace.recentRate(weeks, now)!!, 1e-9)
    }

    @Test
    fun `old bursts do not make an area look busy`() {
        val weeks = listOf(now - 30 to 50_000.0)
        assertEquals(0.0, Pace.recentRate(weeks, now)!!, 1e-9)
    }

    @Test
    fun `no history at all gives no rate`() {
        assertNull(Pace.recentRate(emptyList(), now))
    }

    @Test
    fun `weeks remaining divides what is left by the rate`() {
        assertEquals(5.0, Pace.weeksRemaining(10_000.0, 2_000.0)!!, 1e-9)
        assertEquals(0.0, Pace.weeksRemaining(0.0, 2_000.0)!!, 1e-9)
    }

    @Test
    fun `a stalled area has no estimate`() {
        assertNull(Pace.weeksRemaining(10_000.0, null))
        assertNull(Pace.weeksRemaining(10_000.0, 0.0))
    }
}
