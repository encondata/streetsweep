package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A small gated-community shape:
 *
 *     loopC  (30.004,-97.02) ─────── (30.004,-97.01)
 *       │                                   │ loopD
 *     loopB                                 │
 *       │                                   │
 *     loopA  (30.002,-97.02) ─────── (30.002,-97.01)  ← top of the entry road
 *                                           │ entry
 *     main   (30.000,-97.00) ─── (30.000,-97.01) ─── (30.000,-97.02)
 */
class RoadGraphTest {
    private val junction = LatLngPoint(30.000, -97.010)
    private val entryTop = LatLngPoint(30.002, -97.010)

    private fun way(id: Long, vararg pts: LatLngPoint): GraphWay {
        var len = 0.0
        for (i in 1 until pts.size) len += Geo.distanceMeters(pts[i - 1], pts[i])
        return GraphWay(id, pts.toList(), len)
    }

    private val main = way(1, LatLngPoint(30.000, -97.000), junction, LatLngPoint(30.000, -97.020))
    private val entry = way(2, junction, entryTop)
    private val loopA = way(3, entryTop, LatLngPoint(30.002, -97.020))
    private val loopB = way(4, LatLngPoint(30.002, -97.020), LatLngPoint(30.004, -97.020))
    private val loopC = way(5, LatLngPoint(30.004, -97.020), LatLngPoint(30.004, -97.010))
    private val loopD = way(6, LatLngPoint(30.004, -97.010), entryTop)
    private val network = listOf(main, entry, loopA, loopB, loopC, loopD)

    /** Sitting on the entry road just past the junction, pointing into the community. */
    private val atGate = LatLngPoint(30.0005, -97.010)

    @Test
    fun `facing into the community takes the entry road and the loop, never the public road`() {
        val r = RoadGraph.beyondGate(network, startWayId = 2, gatePoint = atGate, headingDegrees = 0.0)
        assertFalse(r.reachedCap)
        assertEquals(setOf(2L, 3L, 4L, 5L, 6L), r.wayIds.toSet())
        assertFalse("the public road must never be swept up", 1L in r.wayIds)
    }

    @Test
    fun `facing back out gives the public road instead`() {
        val r = RoadGraph.beyondGate(network, startWayId = 2, gatePoint = atGate, headingDegrees = 180.0)
        assertEquals(setOf(1L, 2L), r.wayIds.toSet())
    }

    @Test
    fun `a second way in means the walk escapes and reports the public road`() {
        val backDoor = way(7, LatLngPoint(30.004, -97.020), LatLngPoint(30.000, -97.020))
        val r = RoadGraph.beyondGate(network + backDoor, startWayId = 2, gatePoint = atGate, headingDegrees = 0.0)
        assertTrue("an escape route must show up rather than be hidden", 1L in r.wayIds)
    }

    @Test
    fun `a road that keeps going hits the cap and excludes nothing`() {
        // A chain of 40 streets heading north off the entry road.
        val chain = (0 until 40).map { i ->
            way(100L + i, LatLngPoint(30.002 + i * 0.001, -97.010), LatLngPoint(30.002 + (i + 1) * 0.001, -97.010))
        }
        val r = RoadGraph.beyondGate(
            listOf(main, entry) + chain,
            startWayId = 2, gatePoint = atGate, headingDegrees = 0.0,
            maxWays = 10,
        )
        assertTrue(r.reachedCap)
        assertTrue(r.isEmpty)
    }

    @Test
    fun `length cap also stops the walk`() {
        val r = RoadGraph.beyondGate(network, startWayId = 2, gatePoint = atGate, headingDegrees = 0.0, maxMeters = 100.0)
        assertTrue(r.reachedCap)
        assertTrue(r.isEmpty)
    }

    @Test
    fun `a side street meeting a road part-way along still connects`() {
        // loopB's midpoint is a shared node for this spur.
        val spur = way(8, LatLngPoint(30.004, -97.020), LatLngPoint(30.005, -97.025))
        val r = RoadGraph.beyondGate(network + spur, startWayId = 2, gatePoint = atGate, headingDegrees = 0.0)
        assertTrue(8L in r.wayIds)
    }

    @Test
    fun `an unknown start street yields nothing`() {
        val r = RoadGraph.beyondGate(network, startWayId = 999, gatePoint = atGate, headingDegrees = 0.0)
        assertTrue(r.isEmpty)
        assertFalse(r.reachedCap)
    }

    // ---- which roads leave this spot, and on which side ----

    private fun sides(branches: List<RoadGraph.Branch>) = branches.associate { it.side to it.wayId }

    @Test
    fun `at the junction facing west, the entry road is on the right`() {
        val b = RoadGraph.branchesAt(network, from = junction, headingDegrees = 270.0)
        // Heading west: the public road continues ahead, the community entrance is to the north.
        assertEquals(mapOf(RoadGraph.Side.AHEAD to 1L, RoadGraph.Side.RIGHT to 2L), sides(b))
    }

    @Test
    fun `facing the other way puts the same entrance on the left`() {
        val b = RoadGraph.branchesAt(network, from = junction, headingDegrees = 90.0)
        assertEquals(mapOf(RoadGraph.Side.AHEAD to 1L, RoadGraph.Side.LEFT to 2L), sides(b))
    }

    @Test
    fun `the road behind you is never offered`() {
        val b = RoadGraph.branchesAt(network, from = junction, headingDegrees = 270.0)
        assertTrue(b.all { Math.abs(it.relativeDegrees) <= 135.0 })
        assertEquals(2, b.size)
    }

    @Test
    fun `just inside the entrance, the road you are on is offered both ways`() {
        val justInside = LatLngPoint(30.00027, -97.010) // about 30 m up the entry road
        val b = RoadGraph.branchesAt(network, from = justInside, headingDegrees = 0.0)
        val bySide = sides(b)
        assertEquals(2L, bySide[RoadGraph.Side.AHEAD])
        // The public road is close enough to reach, and runs off to both sides.
        assertEquals(1L, bySide[RoadGraph.Side.LEFT])
        assertEquals(1L, bySide[RoadGraph.Side.RIGHT])
    }

    @Test
    fun `each branch previews the road ahead of it`() {
        val b = RoadGraph.branchesAt(network, from = junction, headingDegrees = 270.0)
        val entryBranch = b.first { it.wayId == 2L }
        assertTrue(entryBranch.preview.size >= 2)
        assertEquals(junction.latitude, entryBranch.preview.first().latitude, 1e-6)
        // It heads north, so the preview climbs in latitude.
        assertTrue(entryBranch.preview.last().latitude > entryBranch.preview.first().latitude)
    }

    @Test
    fun `choosing a branch then walking it finds the community`() {
        val b = RoadGraph.branchesAt(network, from = junction, headingDegrees = 270.0)
        val entryBranch = b.first { it.side == RoadGraph.Side.RIGHT }
        val r = RoadGraph.beyondGate(network, entryBranch.wayId, entryBranch.gatePoint, entryBranch.bearingDegrees)
        assertEquals(setOf(2L, 3L, 4L, 5L, 6L), r.wayIds.toSet())
    }

    @Test
    fun `nothing nearby means no branches`() {
        val faraway = LatLngPoint(31.0, -96.0)
        assertTrue(RoadGraph.branchesAt(network, from = faraway, headingDegrees = 0.0).isEmpty())
    }

    @Test
    fun `a tight radius misses a road you are parked well back from`() {
        // 50 m north of the junction, so the public road is out of the tight radius.
        val setBack = LatLngPoint(30.00045, -97.010)
        val tight = RoadGraph.branchesAt(network, setBack, 0.0, radiusMeters = RoadGraph.BRANCH_RADIUS_METERS)
        val wide = RoadGraph.branchesAt(network, setBack, 0.0, radiusMeters = RoadGraph.WIDE_BRANCH_RADIUS_METERS)
        assertTrue("tight radius sees only the road under us", tight.size < wide.size)
        assertTrue("a wider look reaches the junction", wide.any { it.wayId == 1L })
    }
}
