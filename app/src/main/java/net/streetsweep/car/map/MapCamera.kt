package net.streetsweep.car.map

import net.streetsweep.domain.LatLngPoint
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

    /**
     * Which compass direction points up the screen, in degrees. 0 is north-up; set it to
     * the direction of travel for driving-up.
     *
     * Deliberately not part of the projection. The renderer rotates the canvas instead,
     * so every existing world-to-screen calculation stays north-up and correct, and only
     * the two places that read screen coordinates back — taps and panning — have to undo
     * the rotation. Baking it into the projection would have touched every drawing call.
     */
    var bearing: Float = 0f
        set(value) {
            field = ((value % 360f) + 360f) % 360f
        }

    /** Undoes the canvas rotation, turning a touch point into unrotated screen space. */
    fun unrotate(sx: Float, sy: Float): Pair<Float, Float> {
        if (bearing == 0f) return sx to sy
        val r = Math.toRadians(bearing.toDouble())
        val cos = kotlin.math.cos(r)
        val sin = kotlin.math.sin(r)
        val dx = sx - width / 2.0
        val dy = sy - height / 2.0
        // The canvas was rotated by -bearing, so rotate the point back by +bearing.
        return ((dx * cos - dy * sin) + width / 2.0).toFloat() to
            ((dx * sin + dy * cos) + height / 2.0).toFloat()
    }

    /** How much bigger than the viewport the rotated view reaches, worst case. */
    val rotationOverscan: Double get() = if (bearing == 0f) 1.0 else 1.4143

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
        val (ux, uy) = unrotate(sx, sy)
        val c = WebMercator.project(center, zoom)
        return WebMercator.unproject(WorldPoint(c.x + ux - width / 2.0, c.y + uy - height / 2.0), zoom)
    }

    /** Shifts the view by a screen-pixel delta (positive dx moves the map content left). */
    fun pan(dx: Float, dy: Float) {
        // A drag is in rotated screen space; the world is not. Turn the delta back first
        // or dragging a rotated map sends it off at an angle to the finger.
        val r = Math.toRadians(bearing.toDouble())
        val cos = kotlin.math.cos(r)
        val sin = kotlin.math.sin(r)
        val wx = dx * cos - dy * sin
        val wy = dx * sin + dy * cos
        val c = WebMercator.project(center, zoom)
        center = WebMercator.unproject(WorldPoint(c.x + wx, c.y + wy), zoom)
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
