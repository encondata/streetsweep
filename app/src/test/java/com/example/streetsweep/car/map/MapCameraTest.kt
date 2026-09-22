package com.example.streetsweep.car.map

import com.example.streetsweep.domain.LatLngPoint
import org.junit.Assert.assertEquals
import org.junit.Test

class MapCameraTest {
    private val austin = LatLngPoint(30.2672, -97.7431)

    @Test
    fun `centre maps to the middle of the screen`() {
        val cam = MapCamera(austin, 15.0, 1024, 768)
        val (x, y) = cam.toScreen(austin)
        assertEquals(512f, x, 0.001f)
        assertEquals(384f, y, 0.001f)
    }

    @Test
    fun `pan moves the centre so content shifts by the pixel delta`() {
        val cam = MapCamera(austin, 15.0, 1024, 768)
        cam.pan(100f, -50f)
        val (x, y) = cam.toScreen(austin)
        assertEquals(412f, x, 0.01f)
        assertEquals(434f, y, 0.01f)
    }

    @Test
    fun `zooming about a focus point keeps that point fixed`() {
        val cam = MapCamera(austin, 15.0, 1024, 768)
        val focusGeo = cam.screenToLatLng(200f, 600f)
        cam.zoomBy(2.0, 200f, 600f)
        val (x, y) = cam.toScreen(focusGeo)
        assertEquals(200f, x, 0.05f)
        assertEquals(600f, y, 0.05f)
        assertEquals(16.0, cam.zoom, 1e-9)
    }

    @Test
    fun `zoom is clamped`() {
        val cam = MapCamera(austin, 18.5, 100, 100)
        cam.zoomBy(8.0)
        assertEquals(MapCamera.MAX_ZOOM, cam.zoom, 1e-9)
    }
}
