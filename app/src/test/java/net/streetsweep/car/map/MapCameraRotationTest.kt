package net.streetsweep.car.map

import net.streetsweep.domain.LatLngPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The rotation lives in the canvas, not the projection, so the only places that can get
 * it wrong are the two that read screen coordinates back: taps and drags. These check
 * both, because a map that pans off at an angle to your finger is worse than one that
 * does not rotate at all.
 */
class MapCameraRotationTest {

    private fun camera(bearing: Float) = MapCamera(
        center = LatLngPoint(30.37, -95.62),
        zoom = 16.0,
        width = 800,
        height = 400,
    ).apply { this.bearing = bearing }

    @Test
    fun `north up leaves screen points untouched`() {
        val cam = camera(0f)
        val (x, y) = cam.unrotate(123f, 45f)
        assertEquals(123f, x, 0.001f)
        assertEquals(45f, y, 0.001f)
    }

    @Test
    fun `a tap maps back to the place it was drawn, at any bearing`() {
        for (b in listOf(0f, 37f, 90f, 180f, 270f, 359f)) {
            val cam = camera(b)
            val here = LatLngPoint(30.3725, -95.6235)
            // Where the renderer would draw it: project north-up, then the canvas turns.
            val (ux, uy) = cam.toScreen(here)
            val r = Math.toRadians(-b.toDouble())
            val dx = ux - cam.width / 2.0
            val dy = uy - cam.height / 2.0
            val sx = (dx * Math.cos(r) - dy * Math.sin(r) + cam.width / 2.0).toFloat()
            val sy = (dx * Math.sin(r) + dy * Math.cos(r) + cam.height / 2.0).toFloat()
            // Tapping that spot must give the point back.
            val got = cam.screenToLatLng(sx, sy)
            assertEquals("lat at $b", here.latitude, got.latitude, 1e-7)
            assertEquals("lng at $b", here.longitude, got.longitude, 1e-7)
        }
    }

    @Test
    fun `dragging follows the finger rather than the compass`() {
        // Facing east: dragging the map down the screen must move the view north,
        // because north is to the left when east is up.
        val cam = camera(90f)
        val before = cam.center
        cam.pan(0f, -60f)                     // content moves up, view moves "forward"
        val after = cam.center
        // Forward is east at this bearing, so longitude should rise and latitude barely move.
        assertTrue("expected an eastward move, got $before -> $after", after.longitude > before.longitude)
        assertTrue("latitude should barely change", abs(after.latitude - before.latitude) < 1e-4)
    }

    @Test
    fun `the same drag covers the same ground whichever way the map faces`() {
        val distances = listOf(0f, 45f, 90f, 200f).map { b ->
            val cam = camera(b)
            val from = cam.center
            cam.pan(80f, 40f)
            val to = cam.center
            hypot(to.latitude - from.latitude, (to.longitude - from.longitude) * 0.86)
        }
        val spread = distances.max() - distances.min()
        assertTrue("rotation changed how far a drag goes: $distances", spread < distances.max() * 0.02)
    }

    @Test
    fun `bearing wraps instead of running away`() {
        val cam = camera(0f)
        cam.bearing = 370f
        assertEquals(10f, cam.bearing, 0.001f)
        cam.bearing = -30f
        assertEquals(330f, cam.bearing, 0.001f)
    }

    @Test
    fun `a turned view asks for more tiles than a straight one`() {
        assertEquals(1.0, camera(0f).rotationOverscan, 0.0001)
        assertTrue(camera(45f).rotationOverscan > 1.41)
    }
}
