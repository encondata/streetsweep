package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The grid is laid out in plain degrees and the distances checked in metres, so the numbers
 * below are whatever a hundredth of a degree works out to at this latitude -- what matters
 * is the ratios between them, and which streets come in which order.
 */
class RoutePlannerTest {

    private val step = 0.01

    private fun p(x: Int, y: Int) = LatLngPoint(30.0 + y * step, -95.0 + x * step)

    private fun way(id: Long, vararg pts: Pair<Int, Int>): GraphWay {
        val shape = pts.map { p(it.first, it.second) }
        return GraphWay(id, shape, Geo.pathLengthMeters(shape))
    }

    private fun plan(ways: List<GraphWay>, required: Set<Long>, start: LatLngPoint) =
        RoutePlanner.plan(ways, required, start)

    @Test
    fun `a straight run is driven end to end with no backtracking`() {
        val ways = listOf(
            way(1, 0 to 0, 1 to 0),
            way(2, 1 to 0, 2 to 0),
            way(3, 2 to 0, 3 to 0),
        )
        val r = plan(ways, setOf(1, 2, 3), p(0, 0))
        assertEquals(3, r.requiredCount)
        assertEquals(0.0, r.deadheadMeters, 0.001)
        assertEquals(listOf(1L, 2L, 3L), r.legs.map { it.wayId })
    }

    @Test
    fun `each leg faces the way it will be driven`() {
        // Way 2 is stored running right-to-left, but it is met from the left.
        val ways = listOf(way(1, 0 to 0, 1 to 0), way(2, 2 to 0, 1 to 0))
        val r = plan(ways, setOf(1, 2), p(0, 0))
        val second = r.legs.first { it.wayId == 2L }
        assertEquals(p(1, 0), second.shape.first())
        assertEquals(p(2, 0), second.shape.last())
    }

    @Test
    fun `coming back out of a dead end is backtracking, not a second drive`() {
        // A line of three, starting in the middle. The near street is driven out, then
        // retraced to get at the far one, and the middle street is only ever a way through.
        val ways = listOf(
            way(1, 0 to 0, 1 to 0),
            way(2, 1 to 0, 2 to 0),
            way(3, 2 to 0, 3 to 0),
        )
        val r = plan(ways, setOf(1, 3), p(1, 0))
        assertEquals(2, r.requiredCount)
        assertEquals(listOf(1L, 1L, 2L, 3L), r.legs.map { it.wayId })
        assertEquals(listOf(true, false, false, true), r.legs.map { it.required })
        val retrace = ways[0].lengthMeters + ways[1].lengthMeters
        assertEquals(retrace, r.deadheadMeters, 0.001)
    }

    @Test
    fun `a driven street is used as a way through without being counted`() {
        val ways = listOf(
            way(1, 0 to 0, 1 to 0),   // needs driving
            way(2, 1 to 0, 2 to 0),   // already done
            way(3, 2 to 0, 3 to 0),   // needs driving
        )
        val r = plan(ways, setOf(1, 3), p(0, 0))
        assertEquals(2, r.requiredCount)
        assertEquals(listOf(1L, 2L, 3L), r.legs.map { it.wayId })
        assertEquals(way(2, 1 to 0, 2 to 0).lengthMeters, r.deadheadMeters, 0.001)
    }

    @Test
    fun `a comb backtracks only along its spine`() {
        // Three teeth hanging off a spine. Every tooth has to be driven down and back up,
        // and the spine carries you between them.
        val ways = mutableListOf(
            way(10, 0 to 0, 1 to 0),
            way(11, 1 to 0, 2 to 0),
            way(20, 0 to 0, 0 to 1),
            way(21, 1 to 0, 1 to 1),
            way(22, 2 to 0, 2 to 1),
        )
        val r = plan(ways, setOf(20, 21, 22), p(0, 0))
        assertEquals(3, r.requiredCount)
        // Each tooth is driven once out; coming back out of it is the backtracking, plus
        // the spine between teeth. Nothing should be covered three times.
        val perWay = r.legs.groupingBy { it.wayId }.eachCount()
        assertTrue("no street should be covered more than twice: $perWay", perWay.values.all { it <= 2 })
        assertEquals(3, r.legs.count { it.required })
    }

    @Test
    fun `a pocket with no way in is reported rather than silently dropped`() {
        val ways = listOf(
            way(1, 0 to 0, 1 to 0),
            way(9, 50 to 50, 51 to 50),   // nowhere near the rest
        )
        val r = plan(ways, setOf(1, 9), p(0, 0))
        assertEquals(1, r.requiredCount)
        assertEquals(1, r.unreachable)
    }

    @Test
    fun `nothing left to drive gives an empty plan`() {
        val ways = listOf(way(1, 0 to 0, 1 to 0))
        val r = plan(ways, emptySet(), p(0, 0))
        assertTrue(r.isEmpty)
        assertEquals(0.0, r.totalMeters, 0.0)
    }

    @Test
    fun `the plan starts at the street nearest the driver`() {
        val ways = listOf(
            way(1, 0 to 0, 1 to 0),
            way(2, 1 to 0, 2 to 0),
            way(3, 2 to 0, 3 to 0),
        )
        val fromFarEnd = plan(ways, setOf(1, 2, 3), p(3, 0))
        assertEquals(listOf(3L, 2L, 1L), fromFarEnd.legs.map { it.wayId })
        assertEquals(0.0, fromFarEnd.deadheadMeters, 0.001)
    }

    @Test
    fun `backtracking is a fraction of the whole, and a loop needs none`() {
        // A square: drive round it and you are back where you started, having repeated nothing.
        val ways = listOf(
            way(1, 0 to 0, 1 to 0),
            way(2, 1 to 0, 1 to 1),
            way(3, 1 to 1, 0 to 1),
            way(4, 0 to 1, 0 to 0),
        )
        val r = plan(ways, setOf(1, 2, 3, 4), p(0, 0))
        assertEquals(4, r.requiredCount)
        assertEquals(0.0, r.deadheadFraction, 0.001)
    }

    @Test
    fun `more streets than the cap plans the near ones and says it stopped short`() {
        val ways = (0 until 12).map { way(it.toLong(), it to 0, (it + 1) to 0) }
        val r = RoutePlanner.plan(ways, ways.map { it.id }.toSet(), p(0, 0), maxRequired = 5)
        assertTrue(r.truncated)
        assertEquals(5, r.requiredCount)
        assertEquals(7, r.unreachable)
    }
}
