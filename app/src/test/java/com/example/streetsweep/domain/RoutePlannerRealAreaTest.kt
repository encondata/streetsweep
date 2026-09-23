package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The planner against a real neighbourhood rather than a drawn grid.
 *
 * The fixture is April Sound as the app actually holds it: 165 streets from OpenStreetMap,
 * 146 of them still owing a drive at the time it was taken. Synthetic grids say the
 * algorithm is correct; this says it stays sensible on a street network that was not
 * designed to be convenient.
 */
class RoutePlannerRealAreaTest {

    private class Fixture(val ways: List<GraphWay>, val required: Set<Long>)

    private fun load(): Fixture {
        val text = checkNotNull(javaClass.classLoader?.getResourceAsStream("april-sound-ways.txt")) {
            "april-sound-ways.txt is missing from test resources"
        }.bufferedReader().readText()

        val ways = ArrayList<GraphWay>()
        val required = HashSet<Long>()
        for (line in text.lineSequence()) {
            if (line.isBlank()) continue
            val (id, length, need, shape) = line.split('|', limit = 4)
            val points = shape.split(';').map {
                val comma = it.indexOf(',')
                LatLngPoint(it.substring(0, comma).toDouble(), it.substring(comma + 1).toDouble())
            }
            ways.add(GraphWay(id.toLong(), points, length.toDouble()))
            if (need == "1") required.add(id.toLong())
        }
        return Fixture(ways, required)
    }

    private operator fun <T> List<T>.component4(): T = this[3]

    @Test
    fun `plans the whole neighbourhood without losing streets or wandering`() {
        val f = load()
        assertEquals(165, f.ways.size)
        assertEquals(146, f.required.size)

        val start = f.ways.first().shape.first()
        val began = System.currentTimeMillis()
        val plan = RoutePlanner.plan(f.ways, f.required, start)
        val took = System.currentTimeMillis() - began

        println(
            ("April Sound: %d streets, %.1f mi total, %.1f mi backtracking (%.0f%%), " +
                "%d unreachable, %d ms")
                .format(
                    plan.requiredCount,
                    plan.totalMeters / Geo.METERS_PER_MILE,
                    plan.deadheadMeters / Geo.METERS_PER_MILE,
                    plan.deadheadFraction * 100,
                    plan.unreachable,
                    took,
                )
        )


        // Everything reachable is planned, and only what needed driving.
        assertEquals(f.required.size, plan.requiredCount + plan.unreachable)
        val drivenIds = plan.legs.filter { it.required }.map { it.wayId }.toSet()
        assertEquals(plan.requiredCount, drivenIds.size)
        assertTrue("every driven street should be one that needed it", f.required.containsAll(drivenIds))

        // Ways are cut at junctions, so a street arrives as several legs. Each street
        // should still come out driven exactly once end to end: its legs should add up to
        // its own length, not to some multiple of it.
        val lengthById = f.ways.associate { it.id to it.lengthMeters }
        val plannedById = plan.legs.filter { it.required }
            .groupBy { it.wayId }
            .mapValues { (_, legs) -> legs.sumOf { it.lengthMeters } }
        for ((id, planned) in plannedById) {
            val actual = lengthById.getValue(id)
            assertEquals("street $id is driven more than once over", actual, planned, actual * 0.02 + 1.0)
        }

        // A real neighbourhood has dead ends, so some retracing is unavoidable, but a route
        // that spends more time backtracking than driving would not be worth following.
        assertTrue(
            "backtracking was ${(plan.deadheadFraction * 100).toInt()}% of the route",
            plan.deadheadFraction < 0.45,
        )
        assertTrue("the plan should cover the streets that need driving", plan.requiredMeters > 0)

    }

    @Test
    fun `planning again after driving part of it asks for less`() {
        val f = load()
        val start = f.ways.first().shape.first()
        val full = RoutePlanner.plan(f.ways, f.required, start)

        // Pretend the first third of the plan has been driven.
        val done = full.legs.filter { it.required }.take(full.requiredCount / 3).map { it.wayId }.toSet()
        val rest = RoutePlanner.plan(f.ways, f.required - done, start)

        assertEquals(f.required.size - done.size, rest.requiredCount + rest.unreachable)
        assertTrue("what is left should be shorter", rest.requiredMeters < full.requiredMeters)
    }
}
