package com.example.streetsweep.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundsTest {
    private val austin = Bounds(30.20, -97.80, 30.35, -97.65)

    @Test
    fun `contains and intersects`() {
        assertTrue(austin.contains(30.2672, -97.7431))
        assertFalse(austin.contains(30.5, -97.7431))
        assertTrue(austin.intersects(Bounds(30.30, -97.70, 30.50, -97.50)))
        assertFalse(austin.intersects(Bounds(30.40, -97.70, 30.50, -97.50)))
    }

    @Test
    fun `bounds of points`() {
        val b = Bounds.of(listOf(LatLngPoint(1.0, 2.0), LatLngPoint(-1.0, 5.0), LatLngPoint(0.5, 3.0)))!!
        assertEquals(Bounds(-1.0, 2.0, 1.0, 5.0), b)
        assertEquals(null, Bounds.of(emptyList()))
    }

    @Test
    fun `area in square miles is sane`() {
        // About 10.4 miles tall and 9 miles wide at 30N.
        assertEquals(93.0, austin.areaSquareMiles, 6.0)
    }

    @Test
    fun `chunk grid covers the box and cells are 0_1 degree`() {
        val cells = ChunkGrid.cellsFor(austin)
        assertEquals(2 * 2, cells.size) // lat 30.2..30.35 -> idx 302,303 ; lng -97.8..-97.65 -> idx -978,-977
        assertTrue(cells.all { it.bounds.intersects(austin) })
        val c = ChunkGrid.Cell(302, -978)
        assertEquals("302_-978", c.key)
        assertEquals(30.2, c.bounds.south, 1e-9)
        assertEquals(-97.8, c.bounds.west, 1e-9)
        assertEquals(30.3, c.bounds.north, 1e-9)
    }

    @Test
    fun `a neighbourhood is a handful of cells, a metro is hundreds`() {
        val neighbourhood = Bounds(30.26, -97.76, 30.29, -97.72)
        val metro = Bounds(29.4, -95.9, 30.3, -94.9) // Houston-ish, 1 x 1 degree
        assertTrue(ChunkGrid.cellsFor(neighbourhood).size <= 4)
        assertEquals(11 * 11, ChunkGrid.cellsFor(metro).size)
    }
}
