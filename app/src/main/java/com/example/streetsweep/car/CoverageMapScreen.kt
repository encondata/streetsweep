package com.example.streetsweep.car

import android.annotation.SuppressLint
import android.graphics.Rect
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.Surface
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import com.example.streetsweep.R
import com.example.streetsweep.appContainer
import com.example.streetsweep.car.map.CoverageRenderer
import com.example.streetsweep.car.map.MapCamera
import com.example.streetsweep.car.map.OsmTiles
import com.example.streetsweep.data.AreaWithStats
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.GateException
import com.example.streetsweep.data.GateProblem
import com.example.streetsweep.data.GateBranch
import com.example.streetsweep.data.GateSelection
import com.example.streetsweep.data.NearestStreet
import com.example.streetsweep.data.StreetStatus
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.data.TrackPolyline
import com.example.streetsweep.domain.ExclusionReason
import com.example.streetsweep.car.map.BranchPreview
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.RoadGraph
import com.example.streetsweep.domain.LatLngPoint
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.tracking.Permissions
import com.example.streetsweep.tracking.TrackingService
import com.example.streetsweep.tracking.TrackingStateHolder
import com.example.streetsweep.tracking.TrackingStatus
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.Priority
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * The Android Auto screen: a NavigationTemplate whose map surface we paint ourselves with
 * the driven-street coverage, plus Record/Stop, recenter and zoom buttons.
 */
@OptIn(ExperimentalCoroutinesApi::class, FlowPreview::class)
class CoverageMapScreen(carContext: CarContext) : Screen(carContext), DefaultLifecycleObserver {

    private val container = carContext.appContainer
    private val renderThread = HandlerThread("car-map-render").apply { start() }
    private val renderHandler = Handler(renderThread.looper)
    private val lock = Any()

    private var surface: Surface? = null
    private var visibleArea: Rect? = null
    private val camera = MapCamera(zoom = 15.0)

    private val tiles = OsmTiles(carContext, lifecycleScope) { requestRender() }
    private val renderer = CoverageRenderer(tiles)

    // Live state
    private var coverage: List<TrackPolyline> = emptyList()
    private var areas: List<AreaWithStats> = emptyList()
    private var streets: List<StreetStatus> = emptyList()
    private var drivenEdges: List<List<LatLngPoint>> = emptyList()
    private var pois: List<LatLngPoint> = emptyList()
    private var nearest: NearestStreet? = null
    private var guidanceFrom: LatLngPoint? = null
    private var guidanceJob: Job? = null

    /** Roads leaving this spot, while the driver says which one the gate is on. */
    private var gateBranches: List<GateBranch>? = null
    /** Streets proposed as "behind the gate", waiting for the driver to confirm. */
    private var pendingGate: GateSelection? = null
    /** Heading derived from movement, for fixes that carry no bearing of their own. */
    private var movementBearing: Float? = null
    private var headingAnchor: LatLngPoint? = null
    private var gateBusy = false
    private var lastGateIds: List<Long> = emptyList()
    private var undoUntil = 0L
    private val viewBounds = MutableStateFlow<Bounds?>(null)
    private var activeRaw: List<LatLngPoint> = emptyList()
    private var activeSnapped: List<LatLngPoint> = emptyList()
    private var status: TrackingStatus = TrackingStatus.Idle
    private var position: LatLngPoint? = null
    private var bearing: Float? = null
    private var following = true
    private var centeredOnce = false
    private var locationCallback: LocationCallback? = null

    private val surfaceCallback = object : SurfaceCallback {
        override fun onSurfaceAvailable(surfaceContainer: SurfaceContainer) {
            android.util.Log.i(TAG, "surface available ${surfaceContainer.width}x${surfaceContainer.height} valid=${surfaceContainer.surface?.isValid}")
            synchronized(lock) {
                surface = surfaceContainer.surface
                camera.width = surfaceContainer.width.coerceAtLeast(1)
                camera.height = surfaceContainer.height.coerceAtLeast(1)
            }
            requestRender()
        }

        override fun onVisibleAreaChanged(area: Rect) {
            visibleArea = area
            requestRender()
        }

        override fun onStableAreaChanged(stableArea: Rect) = Unit

        override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) {
            android.util.Log.i(TAG, "surface destroyed")
            synchronized(lock) { surface = null }
        }

        override fun onScroll(distanceX: Float, distanceY: Float) {
            following = false
            camera.pan(distanceX, distanceY)
            requestRender()
        }

        override fun onFling(velocityX: Float, velocityY: Float) = Unit

        override fun onScale(focusX: Float, focusY: Float, scaleFactor: Float) {
            following = false
            camera.zoomBy(scaleFactor.toDouble(), focusX, focusY)
            requestRender()
        }
    }

    init {
        lifecycle.addObserver(this)
        carContext.getCarService(AppManager::class.java).setSurfaceCallback(surfaceCallback)

        lifecycleScope.launch {
            container.trackRepository.observeCoverage().collect { coverage = it; requestRender() }
        }
        lifecycleScope.launch {
            container.coverageRepository.observeAreasWithStats().collect { areas = it; requestRender() }
        }
        // A newly matched drive can complete the street we are being sent to.
        lifecycleScope.launch {
            container.coverageRepository.observeDrivenEdgeCount().collect { guidanceFrom = null; updateGuidance() }
        }
        val debounced = viewBounds.debounce(300)
        lifecycleScope.launch {
            debounced.flatMapLatest { b ->
                if (b == null || camera.zoom < STREET_ZOOM) flowOf(emptyList())
                else container.coverageRepository.observeStreetsInView(b, STREET_LIMIT)
            }.collect { streets = it; requestRender() }
        }
        lifecycleScope.launch {
            debounced.flatMapLatest { b ->
                if (b == null || camera.zoom < EDGE_ZOOM) flowOf(emptyList())
                else container.coverageRepository.observeEdgesInView(b, EDGE_LIMIT).map { l -> l.map { ShapeText.decode(it.shape) } }
            }.collect { drivenEdges = it; requestRender() }
        }
        lifecycleScope.launch {
            debounced.flatMapLatest { b ->
                if (b == null) flowOf(emptyList())
                else container.trackRepository.observePoisInView(b).map { l -> l.map { LatLngPoint(it.latitude, it.longitude) } }
            }.collect { pois = it; requestRender() }
        }
        lifecycleScope.launch {
            TrackingStateHolder.status.collect { s ->
                val wasRecording = status is TrackingStatus.Recording
                status = s
                (s as? TrackingStatus.Recording)?.lastPoint?.let { if (position == null) position = it }
                if (wasRecording != (s is TrackingStatus.Recording)) invalidate() // swap Record/Stop
                requestRender()
            }
        }
        val activeId = TrackingStateHolder.status.map { (it as? TrackingStatus.Recording)?.sessionId }
        lifecycleScope.launch {
            activeId.flatMapLatest { id -> if (id == null) flowOf(emptyList()) else container.trackRepository.observePoints(id) }
                .collect { pts -> activeRaw = pts.map { LatLngPoint(it.latitude, it.longitude) }; requestRender() }
        }
        lifecycleScope.launch {
            activeId.flatMapLatest { id -> if (id == null) flowOf(emptyList()) else container.trackRepository.observeSnappedPoints(id) }
                .collect { pts -> activeSnapped = pts.map { LatLngPoint(it.latitude, it.longitude) }; requestRender() }
        }
    }

    override fun onGetTemplate(): Template {
        val mapActions = ActionStrip.Builder()
            .addAction(Action.PAN)
            .addAction(Action.Builder().setIcon(icon(R.drawable.ic_car_recenter)).setOnClickListener { following = true; centerOnCar(); requestRender() }.build())
            .addAction(Action.Builder().setIcon(icon(R.drawable.ic_car_zoom_in)).setOnClickListener { camera.zoomBy(2.0); requestRender() }.build())
            .addAction(Action.Builder().setIcon(icon(R.drawable.ic_car_zoom_out)).setOnClickListener { camera.zoomBy(0.5); requestRender() }.build())
            .build()

        val cancel = Action.Builder()
            .setIcon(icon(R.drawable.ic_car_close))
            .setOnClickListener { clearGate() }
            .build()

        val pending = pendingGate
        val branches = gateBranches
        val actions = when {
            // Step two: one glance, yes or no.
            pending != null -> ActionStrip.Builder()
                .addAction(
                    Action.Builder()
                        .setTitle("Exclude ${pending.count}")
                        .setIcon(icon(R.drawable.ic_car_check))
                        .setOnClickListener { confirmGate() }
                        .build(),
                )
                .addAction(cancel)
                .build()

            // Step one: which of the roads leaving this spot is the gated one?
            branches != null -> ActionStrip.Builder().apply {
                branches.forEach { b ->
                    addAction(
                        Action.Builder()
                            // The arrow says which way; the title says which road, which
                            // matters most when only one direction is on offer.
                            .setTitle(b.label.take(18))
                            .setIcon(
                                icon(
                                    when (b.side) {
                                        RoadGraph.Side.LEFT -> R.drawable.ic_car_arrow_left
                                        RoadGraph.Side.AHEAD -> R.drawable.ic_car_arrow_up
                                        RoadGraph.Side.RIGHT -> R.drawable.ic_car_arrow_right
                                    },
                                ),
                            )
                            .setOnClickListener { chooseBranch(b) }
                            .build(),
                    )
                }
                addAction(cancel)
            }.build()

            else -> {
                val recording = TrackingStateHolder.isRecording
                ActionStrip.Builder()
                    .addAction(
                        Action.Builder()
                            .setTitle(if (recording) "Stop" else "Record")
                            .setIcon(icon(if (recording) R.drawable.ic_car_stop else R.drawable.ic_car_record))
                            .setOnClickListener {
                                if (TrackingStateHolder.isRecording) TrackingService.stop(carContext)
                                else TrackingService.start(carContext, TriggerSource.MANUAL)
                            }
                            .build(),
                    )
                    .addAction(
                        Action.Builder()
                            .setIcon(icon(R.drawable.ic_car_flag))
                            .setOnClickListener { markPoi() }
                            .build(),
                    )
                    .addAction(
                        Action.Builder()
                            .setTitle("Gate")
                            .setIcon(icon(R.drawable.ic_car_gate))
                            .setOnClickListener { proposeGate() }
                            .build(),
                    )
                    .apply {
                        if (System.currentTimeMillis() < undoUntil && lastGateIds.isNotEmpty()) {
                            addAction(
                                Action.Builder()
                                    .setTitle("Undo")
                                    .setIcon(icon(R.drawable.ic_car_undo))
                                    .setOnClickListener { undoGate() }
                                    .build(),
                            )
                        }
                    }
                    .build()
            }
        }

        return NavigationTemplate.Builder()
            .setActionStrip(actions)
            .setMapActionStrip(mapActions)
            .build()
    }

    // ---- "everything past here is gated" ----

    private fun toast(text: String) {
        runCatching { carContext.getCarService(AppManager::class.java).showToast(text, CarToast.LENGTH_LONG) }
    }

    private fun clearGate() {
        gateBranches = null
        pendingGate = null
        invalidate()
        requestRender()
    }

    /** The heading of travel: the fix's own bearing, or failing that how we have been moving. */
    private fun heading(): Float? = bearing ?: movementBearing

    /** Step one: offer the roads leaving this spot so the driver can point at the gated one. */
    private fun proposeGate() {
        val p = position ?: run { toast("No GPS fix yet"); return }
        if (gateBusy) return
        // With no heading we can still offer the real roads; only the left/ahead/right
        // labels lose their meaning, so say so and let the driver pick by name.
        val heading = heading() ?: run {
            toast("Facing unknown — sides are shown as if heading north")
            0f
        }
        gateBusy = true
        lifecycleScope.launch {
            val outcome = container.coverageRepository.gateBranches(p, heading.toDouble())
            gateBusy = false
            outcome.onSuccess { branches ->
                gateBranches = branches
                pendingGate = null
                invalidate()
                requestRender()
            }.onFailure { reportGateProblem(it) }
        }
    }

    /** Step two: work out what lies beyond the gate on the road the driver picked. */
    private fun chooseBranch(branch: GateBranch) {
        if (gateBusy) return
        gateBusy = true
        toast("Following ${branch.label}…")
        lifecycleScope.launch {
            val outcome = container.coverageRepository.gateFrom(branch)
            gateBusy = false
            outcome.onSuccess { selection ->
                gateBranches = null
                pendingGate = selection
                invalidate()
                requestRender()
                toast("${selection.count} streets · ${Geo.formatDistance(selection.totalMeters)}")
            }.onFailure {
                // Stay on the chooser so another direction can be tried.
                reportGateProblem(it)
            }
        }
    }

    private fun reportGateProblem(e: Throwable) {
        toast(
            when ((e as? GateException)?.problem) {
                GateProblem.NO_ROAD -> "No mapped road here"
                GateProblem.NO_STREETS_LOADED -> "No streets downloaded for this spot yet"
                GateProblem.TOO_DENSE -> "Too many roads around here to be sure"
                else -> "That road keeps going. Outline it on the phone instead."
            },
        )
    }

    private fun confirmGate() {
        val selection = pendingGate ?: return
        pendingGate = null
        gateBranches = null
        lifecycleScope.launch {
            lastGateIds = container.coverageRepository.applyGate(selection)
            undoUntil = System.currentTimeMillis() + UNDO_WINDOW_MS
            guidanceFrom = null
            updateGuidance()
            invalidate()
            requestRender()
            toast("Excluded ${lastGateIds.size} streets behind the gate")
            delay(UNDO_WINDOW_MS)
            if (System.currentTimeMillis() >= undoUntil) invalidate()
        }
    }

    private fun undoGate() {
        val ids = lastGateIds
        if (ids.isEmpty()) return
        lastGateIds = emptyList()
        undoUntil = 0L
        lifecycleScope.launch {
            container.coverageRepository.include(ids)
            guidanceFrom = null
            updateGuidance()
            invalidate()
            requestRender()
            toast("Put ${ids.size} streets back")
        }
    }

    private fun icon(res: Int) = CarIcon.Builder(IconCompat.createWithResource(carContext, res)).build()

    // ---- location while the car screen is up --------------------------------------------------

    @SuppressLint("MissingPermission")
    override fun onStart(owner: LifecycleOwner) {
        if (!Permissions.hasLocation(carContext)) return
        lifecycleScope.launch {
            runCatching { container.fusedLocationClient.lastLocation.await() }.getOrNull()?.let {
                position = LatLngPoint(it.latitude, it.longitude)
                centerOnCar()
                updateGuidance()
                requestRender()
            }
        }
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2_000L).build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val l = result.lastLocation ?: return
                val here = LatLngPoint(l.latitude, l.longitude)
                // Some fixes carry no bearing; derive one from how we have actually moved.
                // Only trust a movement-derived heading over a real distance: a stationary
                // phone wanders several metres and would otherwise invent a confident heading.
                headingAnchor?.let { anchor ->
                    if (Geo.distanceMeters(anchor, here) > HEADING_MOVE_METERS) {
                        movementBearing = Geo.bearingDegrees(anchor, here).toFloat()
                        headingAnchor = here
                    }
                } ?: run { headingAnchor = here }
                position = here
                bearing = if (l.hasBearing() && l.speed > 1f) l.bearing else bearing
                if (following) centerOnCar()
                updateGuidance()
                requestRender()
            }
        }
        locationCallback = cb
        runCatching { container.fusedLocationClient.requestLocationUpdates(request, cb, Looper.getMainLooper()) }
    }

    override fun onStop(owner: LifecycleOwner) {
        locationCallback?.let { container.fusedLocationClient.removeLocationUpdates(it) }
        locationCallback = null
    }

    override fun onDestroy(owner: LifecycleOwner) {
        synchronized(lock) { surface = null }
        renderThread.quitSafely()
    }

    /** Recomputes the nearest undriven street once the car has moved far enough to matter. */
    private fun updateGuidance() {
        val p = position ?: return
        val last = guidanceFrom
        if (last != null && Geo.distanceMeters(last, p) < GUIDANCE_MOVE_METERS) return
        if (guidanceJob?.isActive == true) return
        guidanceFrom = p
        guidanceJob = lifecycleScope.launch {
            val areaId = CoverageRepository.deepestContaining(areas, p)?.area?.id
            nearest = container.coverageRepository.nearestUndriven(p, areaId)
            requestRender()
        }
    }

    private fun markPoi() {
        val p = position ?: run { carContext.getCarService(AppManager::class.java).showToast("No GPS fix yet", CarToast.LENGTH_SHORT); return }
        val sessionId = (status as? TrackingStatus.Recording)?.sessionId
        lifecycleScope.launch {
            container.trackRepository.addPoi(p.latitude, p.longitude, 0f, sessionId)
            carContext.getCarService(AppManager::class.java).showToast("Spot marked", CarToast.LENGTH_SHORT)
        }
    }

    private fun centerOnCar() {
        val p = position ?: return
        camera.moveTo(p, if (!centeredOnce) 16.0 else camera.zoom)
        centeredOnce = true
    }

    // ---- rendering ---------------------------------------------------------------------------

    private var renderPending = false
    private var lockFailures = 0

    private fun requestRender() {
        synchronized(lock) {
            if (renderPending) return
            renderPending = true
        }
        renderHandler.post { render() }
    }

    private fun render() {
        synchronized(lock) {
            renderPending = false
            val s = surface
            if (s == null || !s.isValid) return
            // Tell the data flows what is on screen (padded a little so panning doesn't flicker).
            val tl = camera.screenToLatLng(-camera.width * 0.2f, -camera.height * 0.2f)
            val br = camera.screenToLatLng(camera.width * 1.2f, camera.height * 1.2f)
            viewBounds.value = Bounds(br.latitude, tl.longitude, tl.latitude, br.longitude)
            val frame = CoverageRenderer.Frame(
                camera = camera,
                areas = areas,
                focusedArea = position?.let { CoverageRepository.deepestContaining(areas, it) },
                streets = streets,
                drivenEdges = drivenEdges,
                pois = pois,
                coverage = coverage,
                activeSessionId = (status as? TrackingStatus.Recording)?.sessionId,
                activeRaw = activeRaw,
                activeSnapped = activeSnapped,
                position = position,
                bearing = bearing,
                status = status,
                nearest = nearest,
                pendingGate = pendingGate?.streets?.map { it.shape },
                branchPreviews = gateBranches?.map { BranchPreview(it.side.label, it.label, it.preview) },
                visibleArea = visibleArea,
                following = following,
            )
            // The host can hand a restarted app a surface whose producer is still held by the
            // previous process; lockCanvas then throws until the surface is recreated. Retry for
            // a few seconds, then close the car app so the next launch gets a fresh surface.
            val canvas = try {
                s.lockCanvas(null).also { lockFailures = 0 }
            } catch (e: Exception) {
                lockFailures++
                if (lockFailures == 1 || lockFailures % 5 == 0) android.util.Log.w(TAG, "lockCanvas failed ($lockFailures): ${e.message}")
                if (lockFailures >= MAX_LOCK_FAILURES) {
                    android.util.Log.w(TAG, "Surface unusable; finishing car app so it can be relaunched cleanly")
                    lockFailures = 0
                    Handler(Looper.getMainLooper()).post {
                        runCatching { carContext.getCarService(AppManager::class.java).showToast("Map surface lost. Reopen StreetSweep.", CarToast.LENGTH_LONG) }
                        runCatching { carContext.finishCarApp() }
                    }
                } else {
                    renderHandler.postDelayed({ requestRender() }, LOCK_RETRY_MS)
                }
                return
            }
            try {
                renderer.draw(canvas, frame)
            } catch (e: Exception) {
                android.util.Log.e(TAG, "draw failed", e)
            } finally {
                runCatching { s.unlockCanvasAndPost(canvas) }.onFailure { android.util.Log.w(TAG, "unlockCanvasAndPost failed: $it") }
            }
        }
    }

    companion object {
        private const val TAG = "CoverageMapScreen"
        private const val LOCK_RETRY_MS = 500L
        private const val MAX_LOCK_FAILURES = 8
        const val GUIDANCE_MOVE_METERS = 40.0
        const val UNDO_WINDOW_MS = 30_000L
        const val HEADING_MOVE_METERS = 25.0
        const val STREET_ZOOM = 14.0
        const val EDGE_ZOOM = 12.0
        const val STREET_LIMIT = 6_000
        const val EDGE_LIMIT = 20_000
    }
}
