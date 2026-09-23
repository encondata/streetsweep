package com.example.streetsweep.ui.map

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Point
import android.view.MotionEvent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.example.streetsweep.data.StreetStatus
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.LatLngPoint
import org.osmdroid.config.Configuration
import org.osmdroid.events.MapEventsReceiver
import org.osmdroid.events.MapListener
import org.osmdroid.events.ScrollEvent
import org.osmdroid.events.ZoomEvent
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.MapEventsOverlay
import org.osmdroid.views.overlay.Overlay
import java.io.File

/** An area rectangle with its label, drawn at every zoom. */
data class AreaOutline(val name: String, val vertices: List<LatLngPoint>, val bounds: Bounds, val percent: Int, val level: Int, val focused: Boolean = false)

/** Everything the map draws on top of the OpenStreetMap tiles. */
data class MapLayers(
    val areas: List<AreaOutline> = emptyList(),
    /** Streets in view, coloured by status. */
    val streets: List<StreetStatus> = emptyList(),
    /** Every road segment ever driven, with when it was first covered. */
    val drivenEdges: List<DrivenTrack> = emptyList(),
    /** Shade those segments by age instead of a single teal. */
    val colourByRecency: Boolean = false,
    /** Raw GPS of drives that could not be matched (thin grey). */
    val unmatchedDrives: List<List<LatLngPoint>> = emptyList(),
    val activeRaw: List<LatLngPoint> = emptyList(),
    val activeMatched: List<LatLngPoint> = emptyList(),
    /** Outline being drawn by the user, if any. */
    val draft: List<LatLngPoint> = emptyList(),
    val pois: List<PoiMarker> = emptyList(),
    /** Index of the selected draft vertex, if any. */
    val draftSelected: Int? = null,
    /** Street the user tapped, highlighted while its sheet is open. */
    val selectedWayId: Long? = null,
    /** Nearest undriven street, highlighted with a line pointing at it. */
    val target: TargetHighlight? = null,
)

/** The guidance target: the street to head for, where to join it, and where you are now. */
data class TargetHighlight(val shape: List<LatLngPoint>, val point: LatLngPoint, val from: LatLngPoint?)

/** Callbacks for editing the draft outline directly on the map. */
interface DraftEditor {
    val enabled: Boolean
    fun onVertexMoved(index: Int, point: LatLngPoint)
    fun onVertexInserted(index: Int, point: LatLngPoint)
    fun onVertexSelected(index: Int?)
}

/**
 * Touch handling for the outline being drawn: drag a vertex to move it, touch a midpoint handle
 * to insert a vertex there (and keep dragging), tap a vertex to select it. Added last so it sees
 * touches before the map does; it consumes only touches that land on a handle, so panning and
 * pinch-zoom elsewhere keep working.
 */
class DraftEditOverlay(private val layersOverlay: LayersOverlay, private val editor: DraftEditor) : Overlay() {
    private var dragging: Int? = null
    private var moved = false
    private var downX = 0f
    private var downY = 0f
    private val pt = Point()

    private fun hitRadiusPx(mapView: MapView) = 26f * mapView.context.resources.displayMetrics.density

    private fun hitVertex(x: Float, y: Float, mapView: MapView): Int? {
        val r = hitRadiusPx(mapView)
        val proj = mapView.projection
        var best: Int? = null
        var bestD = r * r
        layersOverlay.layers.draft.forEachIndexed { i, p ->
            proj.toPixels(GeoPoint(p.latitude, p.longitude), pt)
            val dx = pt.x - x; val dy = pt.y - y
            val d = dx * dx + dy * dy
            if (d < bestD) { bestD = d; best = i }
        }
        return best
    }

    /** Midpoint handle between vertex i and i+1 (wrapping). Returns the insert index. */
    private fun hitMidpoint(x: Float, y: Float, mapView: MapView): Pair<Int, LatLngPoint>? {
        val draft = layersOverlay.layers.draft
        if (draft.size < 2) return null
        val r = hitRadiusPx(mapView) * 0.8f
        val proj = mapView.projection
        for (i in draft.indices) {
            val a = draft[i]; val b = draft[(i + 1) % draft.size]
            if (draft.size == 2 && i == 1) break
            val mid = LatLngPoint((a.latitude + b.latitude) / 2, (a.longitude + b.longitude) / 2)
            proj.toPixels(GeoPoint(mid.latitude, mid.longitude), pt)
            val dx = pt.x - x; val dy = pt.y - y
            if (dx * dx + dy * dy < r * r) return (i + 1) to mid
        }
        return null
    }

    override fun onTouchEvent(event: MotionEvent, mapView: MapView): Boolean {
        if (!editor.enabled) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x; downY = event.y; moved = false
                hitVertex(event.x, event.y, mapView)?.let { dragging = it; return true }
                hitMidpoint(event.x, event.y, mapView)?.let { (index, mid) ->
                    editor.onVertexInserted(index, mid)
                    dragging = index
                    return true
                }
                return false
            }
            MotionEvent.ACTION_MOVE -> {
                val i = dragging ?: return false
                if (!moved && (Math.abs(event.x - downX) > 8f || Math.abs(event.y - downY) > 8f)) moved = true
                if (moved) {
                    val g = mapView.projection.fromPixels(event.x.toInt(), event.y.toInt())
                    editor.onVertexMoved(i, LatLngPoint(g.latitude, g.longitude))
                    mapView.invalidate()
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val i = dragging ?: return false
                dragging = null
                editor.onVertexSelected(if (moved) null else i)
                mapView.invalidate()
                return true
            }
        }
        return false
    }
}

data class PoiMarker(val id: Long, val point: LatLngPoint, val label: String)

/** A driven segment and when it was first covered. */
data class DrivenTrack(val shape: List<LatLngPoint>, val drivenAt: Long)

object OsmConfig {
    private var configured = false

    /** osmdroid needs a real user agent for the OSM tile servers and a private cache dir. */
    fun ensure(context: Context) {
        if (configured) return
        val cfg = Configuration.getInstance()
        cfg.userAgentValue = "StreetSweep/1.0 (personal street-coverage app)"
        cfg.osmdroidBasePath = File(context.cacheDir, "osmdroid")
        cfg.osmdroidTileCache = File(context.cacheDir, "osmdroid/tiles")
        cfg.tileFileSystemCacheMaxBytes = 200L * 1024 * 1024
        configured = true
    }

    /** Desaturated, lightened tiles so coverage colours are the loudest thing on screen. */
    val subduedFilter: ColorMatrixColorFilter by lazy {
        val m = ColorMatrix().apply { setSaturation(0.25f) }
        val lighten = ColorMatrix(
            floatArrayOf(
                0.85f, 0f, 0f, 0f, 38f,
                0f, 0.85f, 0f, 0f, 40f,
                0f, 0f, 0.85f, 0f, 38f,
                0f, 0f, 0f, 1f, 0f,
            ),
        )
        m.postConcat(lighten)
        ColorMatrixColorFilter(m)
    }
}

/** Single overlay drawing all layers with one Canvas pass; far cheaper than one Polyline overlay per street. */
class LayersOverlay : Overlay() {
    var layers = MapLayers()

    private val undriven = stroke(0xFFA7B3C0.toInt(), 7f)
    private val excluded = stroke(0xFFC8D1DA.toInt(), 5f).apply { pathEffect = DashPathEffect(floatArrayOf(8f, 12f), 0f) }
    private val selectedHalo = stroke(0xFF10314F.toInt(), 20f).apply { alpha = 110 }
    private val targetStroke = stroke(0xFFE76F51.toInt(), 12f)
    private val targetHalo = stroke(0xFFE76F51.toInt(), 22f).apply { alpha = 70 }
    private val targetArrow = stroke(0xFFE76F51.toInt(), 6f).apply { pathEffect = DashPathEffect(floatArrayOf(20f, 14f), 0f) }
    private val partial = stroke(0xFFE9C46A.toInt(), 8f)
    private val done = stroke(0xFF1E8A28.toInt(), 8f)
    private val edge = stroke(0xFF1E8A28.toInt(), 9f)
    // Fresh to stale: teal, sage, dusty blue, grey-violet.
    private val agePaints = listOf(
        stroke(0xFF1E8A28.toInt(), 9f),
        stroke(0xFF4FB04A.toInt(), 9f),
        stroke(0xFF83A98E.toInt(), 9f),
        stroke(0xFF9AA7B4.toInt(), 9f),
    )
    private val edgeHalo = stroke(0x80FFFFFF.toInt(), 15f)
    private val unmatched = stroke(0xFF8E9AA6.toInt(), 4f)
    private val raw = stroke(0xFF616161.toInt(), 4f).apply { pathEffect = DashPathEffect(floatArrayOf(16f, 10f), 0f) }
    private val active = stroke(0xFFF2B84B.toInt(), 12f)
    private val areaStroke = stroke(0xFF10314F.toInt(), 3f).apply { pathEffect = DashPathEffect(floatArrayOf(14f, 10f), 0f) }
    private val areaFocused = stroke(0xFF1E8A28.toInt(), 5f)
    private val areaLabel = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1C1B1F.toInt(); textSize = 30f; isFakeBoldText = true }
    private val areaLabelBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xE6FFFFFF.toInt() }
    private val areaFill = Paint().apply { color = 0x141E8A28 }
    private val draftStroke = stroke(0xFFB3261E.toInt(), 5f)
    private val draftFill = Paint().apply { color = 0x22B3261E }
    private val draftVertex = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB3261E.toInt() }
    private val draftVertexRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); style = Paint.Style.STROKE; strokeWidth = 3f }
    private val draftSelected = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1E8A28.toInt() }
    private val draftMid = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val draftMidRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB3261E.toInt(); style = Paint.Style.STROKE; strokeWidth = 3f }
    private val poiFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB3261E.toInt() }
    private val poiRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); style = Paint.Style.STROKE; strokeWidth = 3f }
    private val poiLabel = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1C1B1F.toInt(); textSize = 26f }
    private val poiLabelBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xE6FFFFFF.toInt() }
    private val dotFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1E8A28.toInt() }
    private val dotRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); style = Paint.Style.STROKE; strokeWidth = 4f }
    private val path = Path()
    private val pt = Point()

    /** 0 = within a week, 3 = older than three months. */
    private fun ageBucket(drivenAt: Long): Int {
        val days = (System.currentTimeMillis() - drivenAt) / 86_400_000.0
        return when {
            days <= 7 -> 0
            days <= 30 -> 1
            days <= 90 -> 2
            else -> 3
        }
    }

    private fun stroke(color: Int, width: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color; style = Paint.Style.STROKE; strokeWidth = width
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }

    override fun draw(canvas: Canvas, mapView: MapView, shadow: Boolean) {
        if (shadow) return
        val proj = mapView.projection
        val l = layers
        val visible = mapView.boundingBox
        fun line(points: List<LatLngPoint>, paint: Paint) {
            if (points.size < 2) return
            path.rewind()
            points.forEachIndexed { i, p ->
                proj.toPixels(GeoPoint(p.latitude, p.longitude), pt)
                if (i == 0) path.moveTo(pt.x.toFloat(), pt.y.toFloat()) else path.lineTo(pt.x.toFloat(), pt.y.toFloat())
            }
            canvas.drawPath(path, paint)
        }
        fun inView(points: List<LatLngPoint>): Boolean = points.any {
            it.latitude in visible.latSouth..visible.latNorth && it.longitude in visible.lonWest..visible.lonEast
        }
        fun polygonPath(points: List<LatLngPoint>): Path {
            path.rewind()
            points.forEachIndexed { i, p ->
                proj.toPixels(GeoPoint(p.latitude, p.longitude), pt)
                if (i == 0) path.moveTo(pt.x.toFloat(), pt.y.toFloat()) else path.lineTo(pt.x.toFloat(), pt.y.toFloat())
            }
            path.close()
            return path
        }
        l.areas.sortedByDescending { it.level }.forEach { a ->
            if (!visible.let { v -> a.bounds.intersects(Bounds(v.latSouth, v.lonWest, v.latNorth, v.lonEast)) }) return@forEach
            if (a.vertices.size >= 3) {
                val poly = polygonPath(a.vertices)
                if (a.focused) canvas.drawPath(poly, areaFill)
                canvas.drawPath(poly, if (a.focused) areaFocused else areaStroke)
            }
            proj.toPixels(GeoPoint(a.bounds.north, a.bounds.west), pt)
            val label = "${a.name} · ${a.percent}%"
            val w = areaLabel.measureText(label)
            val lx = pt.x.toFloat().coerceAtLeast(8f); val ly = pt.y.toFloat().coerceAtLeast(8f)
            canvas.drawRoundRect(lx, ly, lx + w + 20f, ly + 42f, 10f, 10f, areaLabelBg)
            canvas.drawText(label, lx + 10f, ly + 31f, areaLabel)
        }
        l.selectedWayId?.let { id ->
            l.streets.firstOrNull { it.wayId == id }?.let { line(it.shape, selectedHalo) }
        }
        l.streets.forEach { s ->
            if (!inView(s.shape)) return@forEach
            val paint = when {
                s.excluded -> excluded
                s.isDone -> done
                s.isPartial -> partial
                else -> undriven
            }
            line(s.shape, paint)
        }
        l.unmatchedDrives.forEach { if (inView(it)) line(it, unmatched) }
        l.drivenEdges.forEach { if (inView(it.shape)) line(it.shape, edgeHalo) }
        l.drivenEdges.forEach { t ->
            if (!inView(t.shape)) return@forEach
            line(t.shape, if (l.colourByRecency) agePaints[ageBucket(t.drivenAt)] else edge)
        }
        line(l.activeRaw, raw)
        line(l.activeMatched, active)
        l.activeRaw.lastOrNull()?.let { p ->
            proj.toPixels(GeoPoint(p.latitude, p.longitude), pt)
            canvas.drawCircle(pt.x.toFloat(), pt.y.toFloat(), 12f, dotFill)
            canvas.drawCircle(pt.x.toFloat(), pt.y.toFloat(), 12f, dotRing)
        }
        l.target?.let { t ->
            line(t.shape, targetHalo)
            line(t.shape, targetStroke)
            t.from?.let { origin ->
                // Dashed line from where you are to where the street starts: a pointer, not a route.
                line(listOf(origin, t.point), targetArrow)
            }
        }
        l.pois.forEach { m ->
            proj.toPixels(GeoPoint(m.point.latitude, m.point.longitude), pt)
            val x = pt.x.toFloat(); val y = pt.y.toFloat()
            // Pin: stem + head
            canvas.drawLine(x, y, x, y - 26f, poiRing)
            canvas.drawLine(x, y, x, y - 26f, poiFill)
            canvas.drawCircle(x, y - 34f, 12f, poiFill)
            canvas.drawCircle(x, y - 34f, 12f, poiRing)
            if (m.label.isNotEmpty() && mapView.zoomLevelDouble >= 14) {
                val w = poiLabel.measureText(m.label)
                canvas.drawRoundRect(x + 16f, y - 52f, x + 16f + w + 16f, y - 20f, 8f, 8f, poiLabelBg)
                canvas.drawText(m.label, x + 24f, y - 29f, poiLabel)
            }
        }
        if (l.draft.isNotEmpty()) {
            if (l.draft.size >= 3) {
                val poly = polygonPath(l.draft)
                canvas.drawPath(poly, draftFill)
                canvas.drawPath(poly, draftStroke)
            } else if (l.draft.size == 2) {
                line(l.draft, draftStroke)
            }
            // Midpoint handles: touch one to insert a vertex there.
            if (l.draft.size >= 2) {
                val n = l.draft.size
                val edges = if (n == 2) 1 else n
                for (i in 0 until edges) {
                    val a = l.draft[i]; val b = l.draft[(i + 1) % n]
                    proj.toPixels(GeoPoint((a.latitude + b.latitude) / 2, (a.longitude + b.longitude) / 2), pt)
                    canvas.drawCircle(pt.x.toFloat(), pt.y.toFloat(), 9f, draftMid)
                    canvas.drawCircle(pt.x.toFloat(), pt.y.toFloat(), 9f, draftMidRing)
                }
            }
            l.draft.forEachIndexed { i, p ->
                proj.toPixels(GeoPoint(p.latitude, p.longitude), pt)
                val selected = i == l.draftSelected
                canvas.drawCircle(pt.x.toFloat(), pt.y.toFloat(), if (selected) 18f else 14f, if (selected) draftSelected else draftVertex)
                canvas.drawCircle(pt.x.toFloat(), pt.y.toFloat(), if (selected) 18f else 14f, draftVertexRing)
            }
        }
    }
}

/** Handle to drive the map from Compose code. */
class TrackMapController {
    internal var mapView: MapView? = null

    fun animateTo(point: LatLngPoint, zoom: Double? = null) {
        val mv = mapView ?: return
        if (zoom != null) mv.controller.animateTo(GeoPoint(point.latitude, point.longitude), zoom, 600L)
        else mv.controller.animateTo(GeoPoint(point.latitude, point.longitude))
    }

    fun fitBounds(b: Bounds) {
        val mv = mapView ?: return
        mv.post { mv.zoomToBoundingBox(BoundingBox(b.north, b.east, b.south, b.west), true, 60) }
    }

    fun fitTo(points: List<LatLngPoint>) {
        val mv = mapView ?: return
        if (points.isEmpty()) return
        if (points.size == 1) { animateTo(points.first(), 16.0); return }
        val box = BoundingBox.fromGeoPoints(points.map { GeoPoint(it.latitude, it.longitude) })
        mv.post { mv.zoomToBoundingBox(box, true, 80) }
    }

    /** What the user is currently looking at, as south/west/north/east. */
    fun visibleBounds(): DoubleArray? {
        val b = mapView?.boundingBox ?: return null
        return doubleArrayOf(b.latSouth, b.lonWest, b.latNorth, b.lonEast)
    }

    val zoom: Double get() = mapView?.zoomLevelDouble ?: 0.0
}

@SuppressLint("ClickableViewAccessibility")
@Composable
fun TrackMap(
    modifier: Modifier = Modifier,
    layers: MapLayers,
    mapController: TrackMapController,
    myLocation: LatLngPoint? = null,
    onUserGesture: () -> Unit = {},
    onViewportChanged: (Bounds, Double) -> Unit = { _, _ -> },
    onMapTap: (LatLngPoint) -> Unit = {},
    draftEditor: DraftEditor? = null,
) {
    val context = LocalContext.current
    OsmConfig.ensure(context)
    val overlay = remember { LayersOverlay() }
    val lifecycleOwner = LocalLifecycleOwner.current

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> mapController.mapView?.onResume()
                Lifecycle.Event.ON_PAUSE -> mapController.mapView?.onPause()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            mapController.mapView?.onDetach()
            mapController.mapView = null
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            MapView(ctx).apply {
                setTileSource(TileSourceFactory.MAPNIK)
                setMultiTouchControls(true)
                zoomController.setVisibility(org.osmdroid.views.CustomZoomButtonsController.Visibility.NEVER)
                isTilesScaledToDpi = true
                minZoomLevel = 3.0
                maxZoomLevel = 19.5
                overlayManager.tilesOverlay.setColorFilter(OsmConfig.subduedFilter)
                overlays.add(
                    MapEventsOverlay(object : MapEventsReceiver {
                        override fun singleTapConfirmedHelper(p: GeoPoint?): Boolean {
                            p?.let { onMapTap(LatLngPoint(it.latitude, it.longitude)) }
                            return false
                        }
                        override fun longPressHelper(p: GeoPoint?): Boolean = false
                    }),
                )
                overlays.add(overlay)
                if (draftEditor != null) overlays.add(DraftEditOverlay(overlay, draftEditor))
                controller.setZoom(4.0)
                controller.setCenter(GeoPoint(39.5, -98.35))
                setOnTouchListener { _, ev ->
                    if (ev.actionMasked == MotionEvent.ACTION_DOWN) onUserGesture()
                    false
                }
                fun report() {
                    val b = boundingBox
                    onViewportChanged(Bounds(b.latSouth, b.lonWest, b.latNorth, b.lonEast), zoomLevelDouble)
                }
                addMapListener(object : MapListener {
                    override fun onScroll(event: ScrollEvent?): Boolean { report(); return false }
                    override fun onZoom(event: ZoomEvent?): Boolean { report(); return false }
                })
                post { report() }
                mapController.mapView = this
            }
        },
        update = { mv ->
            overlay.layers = layers
            mv.invalidate()
        },
    )
    // myLocation is drawn through layers.activeRaw's last point while recording; when idle
    // the caller passes it as a one-point activeRaw so the dot still shows.
    @Suppress("UNUSED_EXPRESSION") myLocation
}
