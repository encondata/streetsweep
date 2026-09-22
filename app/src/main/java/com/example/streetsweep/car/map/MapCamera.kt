package com.example.streetsweep.car.map

import com.example.streetsweep.domain.LatLngPoint
import kotlin.math.pow

/**
 * Where the car-screen map is looking: a centre, a continuous zoom and a viewport in pixels.
 * Screen (0,0) is the top-left of the surface; the centre is at (width/2, height/2).
 */
class MapCamera(
    center: LatLngPoint = LatLngPoint(39.5, -98.35),
    zoom: Double = 4.0,
    var width: Int = 1,
    var height: Int = 1,
) {
    var center: LatLngPoint = center
        private set
    var zoom: Double = zoom.coerceIn(MIN_ZOOM, MAX_ZOOM)
        private set

    fun moveTo(center: LatLngPoint, zoom: Double = this.zoom) {
        this.center = center
        this.zoom = zoom.coerceIn(MIN_ZOOM, MAX_ZOOM)
    }

    fun worldToScreen(w: WorldPoint): Pair<Float, Float> {
        val c = WebMercator.project(center, zoom)
        return Pair((w.x - c.x + width / 2.0).toFloat(), (w.y - c.y + height / 2.0).toFloat())
    }

    fun toScreen(p: LatLngPoint): Pair<Float, Float> = worldToScreen(WebMercator.project(p, zoom))

    fun screenToLatLng(sx: Float, sy: Float): LatLngPoint {
        val c = WebMercator.project(center, zoom)
        return WebMercator.unproject(WorldPoint(c.x + sx - width / 2.0, c.y + sy - height / 2.0), zoom)
    }

    /** Shifts the view by a screen-pixel delta (positive dx moves the map content left). */
    fun pan(dx: Float, dy: Float) {
        val c = WebMercator.project(center, zoom)
        center = WebMercator.unproject(WorldPoint(c.x + dx, c.y + dy), zoom)
    }

    /** Multiplies scale by [factor], keeping the geographic point under (focusX, focusY) fixed. */
    fun zoomBy(factor: Double, focusX: Float = width / 2f, focusY: Float = height / 2f) {
        val anchor = screenToLatLng(focusX, focusY)
        val newZoom = (zoom + log2(factor)).coerceIn(MIN_ZOOM, MAX_ZOOM)
        zoom = newZoom
        // Move the centre so the anchor lands back under the focus point.
        val anchorScreen = toScreen(anchor)
        pan(anchorScreen.first - focusX, anchorScreen.second - focusY)
    }

    fun zoomTo(zoom: Double) = moveTo(center, zoom)

    private fun log2(v: Double) = kotlin.math.ln(v) / kotlin.math.ln(2.0)

    companion object {
        const val MIN_ZOOM = 3.0
        const val MAX_ZOOM = 19.0
        fun scaleBetween(fromZoom: Double, toZoom: Double): Double = 2.0.pow(toZoom - fromZoom)
    }
}
