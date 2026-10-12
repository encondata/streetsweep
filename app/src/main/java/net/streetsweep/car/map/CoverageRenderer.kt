package net.streetsweep.car.map

import net.streetsweep.data.prefs.MapPalette
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import net.streetsweep.data.AreaWithStats
import net.streetsweep.data.NearestStreet
import net.streetsweep.data.StreetStatus
import net.streetsweep.data.TrackPolyline
import net.streetsweep.domain.Geo
import net.streetsweep.domain.LatLngPoint
import net.streetsweep.domain.MapBase
import net.streetsweep.tracking.TrackingStatus
import kotlin.math.floor
import kotlin.math.roundToInt

/** One candidate road for the gate, highlighted while the driver chooses. */
data class BranchPreview(val side: String, val label: String, val shape: List<LatLngPoint>)

/** Draws the car-screen map: OSM tiles (subdued), area streets, driven segments, the car, and a status line. */
class CoverageRenderer(private val tiles: OsmTiles) {

    class Frame(
        val camera: MapCamera,
        val areas: List<AreaWithStats>,
        val focusedArea: AreaWithStats?,
        val streets: List<StreetStatus>,
        val drivenEdges: List<List<LatLngPoint>>,
        val pois: List<LatLngPoint> = emptyList(),
        val coverage: List<TrackPolyline>,
        val activeSessionId: Long?,
        val activeRaw: List<LatLngPoint>,
        val activeSnapped: List<LatLngPoint>,
        val position: LatLngPoint?,
        val bearing: Float?,
        val status: TrackingStatus,
        val nearest: NearestStreet? = null,
        /** Streets a proposed gate would exclude, drawn in red until the driver decides. */
        val pendingGate: List<List<LatLngPoint>>? = null,
        /** Roads leaving this spot, highlighted while the driver says which the gate is on. */
        val branchPreviews: List<BranchPreview>? = null,
        val visibleArea: Rect?,
        val following: Boolean,
        val base: MapBase = MapBase.MAP,
        /** The car's own day/night state, which Android Auto reports and most cars drive
         *  from their headlights. */
        val night: Boolean = false,
    )

    private val background = Paint().apply { color = 0xFFEDF2F7.toInt() }
    private val tilePlaceholder = Paint().apply { color = 0xFFE0E8F0.toInt() }
    private val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG).apply {
        val m = ColorMatrix().apply { setSaturation(0.25f) }
        m.postConcat(ColorMatrix(floatArrayOf(0.85f, 0f, 0f, 0f, 38f, 0f, 0.85f, 0f, 0f, 40f, 0f, 0f, 0.85f, 0f, 38f, 0f, 0f, 0f, 1f, 0f)))
        colorFilter = ColorMatrixColorFilter(m)
    }

    /**
     * Night, driven by the car rather than by us: Android Auto reports the head
     * unit's day/night state and most cars switch it with the headlights.
     *
     * Not an invert: on these tiles the road is the brightest thing on the map, so
     * inverting turns the roads black and the land nearly black with them — the one
     * line you need to see disappears. The gap is what matters instead. Road white is
     * 255 and the land around it about 240, so pulling everything below 231 to black and
     * multiplying what is left by seven opens those fifteen points into a hundred: dark
     * ground, legible road.
     *
     * Saturation goes first, or the stretch multiplies the land's beige tint sevenfold
     * and the map comes out brown. A few points of blue are added back at the end so it
     * reads as night rather than as a fault.
     */
    private val nightTilePaint = Paint(Paint.FILTER_BITMAP_FLAG).apply {
        val m = ColorMatrix().apply { setSaturation(0f) }
        m.postConcat(
            ColorMatrix(
                floatArrayOf(
                    7f, 0f, 0f, 0f, -1611f,
                    0f, 7f, 0f, 0f, -1607f,
                    0f, 0f, 7f, 0f, -1601f,
                    0f, 0f, 0f, 1f, 0f,
                ),
            ),
        )
        colorFilter = ColorMatrixColorFilter(m)
    }
    /** Imagery as shot, and the same dimmed for night. */
    private val photoPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val nightPhotoPaint = Paint(Paint.FILTER_BITMAP_FLAG).apply {
        colorFilter = ColorMatrixColorFilter(
            ColorMatrix(
                floatArrayOf(
                    0.55f, 0f, 0f, 0f, 0f,
                    0f, 0.55f, 0f, 0f, 0f,
                    0f, 0f, 0.60f, 0f, 4f,
                    0f, 0f, 0f, 1f, 0f,
                ),
            ),
        )
    }
    private val nightBackground = Paint().apply { color = 0xFF0A121B.toInt() }
    private val nightTilePlaceholder = Paint().apply { color = 0xFF111C27.toInt() }

    /** Set from the frame at the top of every draw, so the helpers below can read it. */
    private var nightNow = false

    /** The status card has to turn over too, or it is a white slab in a dark car. */
    private fun applyNight(on: Boolean) {
        if (nightNow == on) return
        nightNow = on
        textPaint.color = if (on) 0xFFE8EEF4.toInt() else 0xFF1C1B1F.toInt()
        subTextPaint.color = if (on) 0xFF9FB0C0.toInt() else 0xFF49454F.toInt()
        pillPaint.color = if (on) 0xF20D1620.toInt() else 0xF2FFFFFF.toInt()
    }
    private val undrivenPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFA7B3C0.toInt(); style = Paint.Style.STROKE; strokeWidth = 7f
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val partialPaint = Paint(undrivenPaint).apply { color = 0xFFE9C46A.toInt(); strokeWidth = 8f }
    // Left out (gated): candy-striped, bands of the person's colour (Preferences) over white.
    private val excludedBase = Paint(undrivenPaint).apply { color = Color.WHITE; strokeWidth = 9f; strokeCap = Paint.Cap.BUTT }
    private val excludedStripe = Paint(excludedBase).apply {
        color = MapPalette.DEFAULT_STRIPE
        pathEffect = android.graphics.DashPathEffect(floatArrayOf(14f, 14f), 0f)
    }
    private val pendingGatePaint = Paint(undrivenPaint).apply { color = 0xFFB3261E.toInt(); strokeWidth = 14f }
    private val pendingGateHalo = Paint(undrivenPaint).apply { color = 0x55B3261E; strokeWidth = 26f }
    private val branchPaint = Paint(undrivenPaint).apply { color = 0xFF6A4C93.toInt(); strokeWidth = 16f }
    private val branchHalo = Paint(undrivenPaint).apply { color = 0x556A4C93; strokeWidth = 30f }
    private val branchLabel = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textSize = 30f; isFakeBoldText = true }
    private val branchLabelBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF6A4C93.toInt() }
    private val targetPaint = Paint(undrivenPaint).apply { color = 0xFFE76F51.toInt(); strokeWidth = 14f }
    private val targetHaloPaint = Paint(undrivenPaint).apply { color = 0x66E76F51; strokeWidth = 26f }
    private val targetArrowPaint = Paint(undrivenPaint).apply {
        color = 0xFFE76F51.toInt(); strokeWidth = 7f
        pathEffect = android.graphics.DashPathEffect(floatArrayOf(24f, 16f), 0f)
    }
    private val donePaint = Paint(undrivenPaint).apply { color = 0xFF1E8A28.toInt(); strokeWidth = 8f }
    private val areaPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF10314F.toInt(); style = Paint.Style.STROKE; strokeWidth = 3f
        pathEffect = android.graphics.DashPathEffect(floatArrayOf(16f, 12f), 0f)
    }
    private val areaFocusedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1E8A28.toInt(); style = Paint.Style.STROKE; strokeWidth = 5f }
    private val coveragePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF1E8A28.toInt(); style = Paint.Style.STROKE; strokeWidth = 9f
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val coverageHalo = Paint(coveragePaint).apply { color = 0x66FFFFFF; strokeWidth = 15f }
    private val completeFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    /** Your street and finished-area colours (the web's Preferences), set by the screen. */
    var palette: MapPalette = MapPalette.DEFAULT
        set(p) {
            field = p
            undrivenPaint.color = p.undriven
            excludedStripe.color = p.excluded
            donePaint.color = p.driven
            coveragePaint.color = p.driven
            p.completeFill?.let { completeFill.color = it }
        }
    private val rawPaint = Paint(coveragePaint).apply { color = 0xFF8090A0.toInt(); strokeWidth = 4f }
    private val activePaint = Paint(coveragePaint).apply { color = 0xFFF2B84B.toInt(); strokeWidth = 11f }
    private val carFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF10314F.toInt() }
    private val poiPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB3261E.toInt(); strokeWidth = 4f }
    private val carRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 4f }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1C1B1F.toInt(); textSize = 34f }
    private val subTextPaint = Paint(textPaint).apply { color = 0xFF49454F.toInt(); textSize = 26f }
    private val pillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xF2FFFFFF.toInt() }
    private val recordingDot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB3261E.toInt() }
    private val path = Path()

    fun draw(canvas: Canvas, f: Frame) {
        val cam = f.camera
        applyNight(f.night)
        canvas.drawRect(
            0f, 0f, cam.width.toFloat(), cam.height.toFloat(),
            if (f.night) nightBackground else background,
        )

        // Everything geographic is drawn into a rotated canvas, so the projection stays
        // north-up and only the canvas turns. The car marker and the status card are put
        // back the right way up afterwards: a heading indicator that rotates with the map
        // never points anywhere, and nobody wants to read sideways.
        val rotated = cam.bearing != 0f
        if (rotated) {
            canvas.save()
            canvas.rotate(-cam.bearing, cam.width / 2f, cam.height / 2f)
        }
        drawTiles(canvas, cam, f.base)
        f.areas.sortedByDescending { it.area.level }.forEach { a ->
            path.rewind()
            // Every piece of an area in parts, as one path.
            a.pieces.filter { it.size >= 3 }.forEach { piece ->
                piece.forEachIndexed { i, p ->
                    val (x, y) = cam.toScreen(p)
                    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                path.close()
            }
            if (path.isEmpty) return@forEach
            if (palette.completeFill != null && a.stats.total > 0 && a.stats.remaining == 0) canvas.drawPath(path, completeFill)
            canvas.drawPath(path, if (a.area.id == f.focusedArea?.area?.id) areaFocusedPaint else areaPaint)
        }
        f.streets.forEach { s ->
            if (s.excluded) {
                drawLine(canvas, cam, s.shape, excludedBase)
                drawLine(canvas, cam, s.shape, excludedStripe)
                return@forEach
            }
            val paint = when {
                s.isDone -> donePaint
                s.isPartial -> partialPaint
                else -> undrivenPaint
            }
            drawLine(canvas, cam, s.shape, paint)
        }
        f.coverage.forEach { line ->
            if (line.sessionId == f.activeSessionId || line.snapped) return@forEach
            drawLine(canvas, cam, line.points, rawPaint)
        }
        f.drivenEdges.forEach { drawLine(canvas, cam, it, coverageHalo) }
        f.drivenEdges.forEach { drawLine(canvas, cam, it, coveragePaint) }
        if (f.activeSessionId != null) {
            drawLine(canvas, cam, f.activeRaw, rawPaint)
            drawLine(canvas, cam, f.activeSnapped, activePaint)
        }
        f.pois.forEach { p ->
            val (x, y) = cam.toScreen(p)
            canvas.drawLine(x, y, x, y - 30f, carRing)
            canvas.drawLine(x, y, x, y - 30f, poiPaint)
            canvas.drawCircle(x, y - 40f, 14f, poiPaint)
            canvas.drawCircle(x, y - 40f, 14f, carRing)
        }
        f.pendingGate?.let { shapes ->
            shapes.forEach { drawLine(canvas, cam, it, pendingGateHalo) }
            shapes.forEach { drawLine(canvas, cam, it, pendingGatePaint) }
        }
        f.branchPreviews?.forEach { b ->
            drawLine(canvas, cam, b.shape, branchHalo)
            drawLine(canvas, cam, b.shape, branchPaint)
            b.shape.lastOrNull()?.let { end ->
                val (x, y) = cam.toScreen(end)
                val text = b.side.take(1)
                canvas.drawCircle(x, y, 22f, branchLabelBg)
                canvas.drawText(text, x - branchLabel.measureText(text) / 2, y + 11f, branchLabel)
            }
        }
        f.nearest?.let { n ->
            if (f.pendingGate != null || f.branchPreviews != null) return@let
            drawLine(canvas, cam, n.street.shape, targetHaloPaint)
            drawLine(canvas, cam, n.street.shape, targetPaint)
            f.position?.let { drawLine(canvas, cam, listOf(it, n.point), targetArrowPaint) }
        }
        if (rotated) canvas.restore()
        // Driving-up means the car is always pointing up the screen, so the marker's own
        // rotation is whatever the map has taken out.
        f.position?.let { drawCar(canvas, cam, it, f.bearing?.minus(cam.bearing)) }
        drawStatus(canvas, f)
    }

    private fun drawTiles(canvas: Canvas, cam: MapCamera, base: MapBase) {
        // Tiles from one zoom level *out*, drawn at ~2x their native size: labels are legible
        // from the driver's seat and the geometry stays aligned with the overlay, which is
        // projected at the camera's true zoom.
        val tz = (cam.zoom.roundToInt() - 1).coerceIn(3, OsmTiles.MAX_ZOOM)
        val scale = MapCamera.scaleBetween(tz.toDouble(), cam.zoom).toFloat() // screen px per tile-zoom world px
        val centerT = WebMercator.project(cam.center, tz.toDouble())
        val tilePx = OsmTiles.TILE_PX.toDouble()
        // A rotated viewport reaches into the corners, so fetch a wider box than the
        // screen: at 45 degrees the diagonal is root two times the side, and without
        // this the turned map has blank wedges at its edges.
        val over = cam.rotationOverscan
        val halfW = cam.width / 2.0 / scale * over
        val halfH = cam.height / 2.0 / scale * over
        val left = centerT.x - halfW
        val top = centerT.y - halfH
        val right = centerT.x + halfW
        val bottom = centerT.y + halfH
        val maxTile = (1 shl tz) - 1
        for (ty in floor(top / tilePx).toInt()..floor(bottom / tilePx).toInt()) {
            for (tx in floor(left / tilePx).toInt()..floor(right / tilePx).toInt()) {
                if (tx < 0 || ty < 0 || tx > maxTile || ty > maxTile) continue
                val sx = ((tx * tilePx - centerT.x) * scale + cam.width / 2.0).toFloat()
                val sy = ((ty * tilePx - centerT.y) * scale + cam.height / 2.0).toFloat()
                val side = (tilePx * scale).toFloat()
                val dest = RectF(sx, sy, sx + side, sy + side)
                val bmp = tiles.get(OsmTiles.Key(tz, tx, ty, base))
                val paint = when {
                    // Imagery is a photograph, not a drawing. The day filter pales it to
                    // mush and the night stretch, which works by pulling apart two nearly
                    // identical whites, has nothing to pull apart. It gets dimmed at
                    // night and otherwise left alone.
                    base == MapBase.SATELLITE -> if (nightNow) nightPhotoPaint else photoPaint
                    nightNow -> nightTilePaint
                    else -> tilePaint
                }
                if (bmp != null) canvas.drawBitmap(bmp, null, dest, paint)
                else canvas.drawRect(dest, if (nightNow) nightTilePlaceholder else tilePlaceholder)
            }
        }
    }

    private fun drawLine(canvas: Canvas, cam: MapCamera, points: List<LatLngPoint>, paint: Paint?) {
        if (paint == null || points.size < 2) return
        path.rewind()
        points.forEachIndexed { i, p ->
            val (x, y) = cam.toScreen(p)
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        canvas.drawPath(path, paint)
    }

    private fun drawCar(canvas: Canvas, cam: MapCamera, pos: LatLngPoint, bearing: Float?) {
        val (x, y) = cam.toScreen(pos)
        canvas.drawCircle(x, y, 16f, carFill)
        canvas.drawCircle(x, y, 16f, carRing)
        if (bearing != null) {
            canvas.save()
            canvas.rotate(bearing, x, y)
            path.rewind()
            path.moveTo(x, y - 34f); path.lineTo(x - 12f, y - 14f); path.lineTo(x + 12f, y - 14f); path.close()
            canvas.drawPath(path, carFill)
            canvas.restore()
        }
    }

    private fun drawStatus(canvas: Canvas, f: Frame) {
        val area = f.visibleArea ?: Rect(0, 0, f.camera.width, f.camera.height)
        val title: String
        val lines = ArrayList<String>()
        when (val s = f.status) {
            TrackingStatus.Idle -> {
                title = "Not recording"
                if (f.coverage.isNotEmpty()) lines += "${f.coverage.size} drives"
            }
            is TrackingStatus.Recording -> {
                title = "Recording · ${Geo.formatDistance(s.distanceMeters)}"
                lines += "${s.pointCount} points" + (if (s.stopScheduledAt != null) " · car disconnected, stopping soon" else "")
            }
        }
        f.focusedArea?.takeIf { !it.area.isDownloading }?.let { a ->
            lines.add(
                0,
                "${a.name}: ${a.stats.done}/${a.stats.total} streets · ${a.stats.percent}%" +
                    (if (a.stats.excluded > 0) " · ${a.stats.excluded} excluded" else ""),
            )
        }
        f.pendingGate?.let { lines += "Gated? ${it.size} streets — confirm or cancel" }
        f.branchPreviews?.let { bs ->
            lines += "Which road is the gate on?"
            bs.forEach { lines += "  ${it.side}: ${it.label}" }
        }
        f.nearest?.takeIf { f.pendingGate == null && f.branchPreviews == null }?.let { n -> lines += "Next: ${n.street.label} · ${Geo.formatDistance(n.distanceMeters)} ${n.compass}" }
        if (!f.following) lines += "Panned — tap recenter"
        if (lines.isEmpty()) lines += "No drives yet"

        val pad = 22f
        val titleBaseline = 46f
        val lineH = 34f
        val widest = (listOf(textPaint.measureText(title)) + lines.map { subTextPaint.measureText(it) }).max()
        val w = widest + pad * 2 + 30f
        val h = titleBaseline + lines.size * lineH + 20f
        val left = area.left + 24f
        val top = area.top + 24f
        canvas.drawRoundRect(left, top, left + w, top + h, 24f, 24f, pillPaint)
        var tx = left + pad
        if (f.status is TrackingStatus.Recording) {
            canvas.drawCircle(left + pad + 10f, top + 36f, 10f, recordingDot)
            tx += 30f
        }
        canvas.drawText(title, tx, top + titleBaseline, textPaint)
        lines.forEachIndexed { i, line ->
            canvas.drawText(line, left + pad, top + titleBaseline + (i + 1) * lineH, subTextPaint)
        }
    }
}
