package com.example.streetsweep.ui.home

import android.annotation.SuppressLint
import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.asFlow
import androidx.lifecycle.viewModelScope
import androidx.car.app.connection.CarConnection
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.AreaWithStats
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.NearestStreet
import com.example.streetsweep.data.RouteState
import com.example.streetsweep.data.RouteTarget
import com.example.streetsweep.data.StreetStatus
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.data.osm.StreetDownloadWorker
import com.example.streetsweep.data.prefs.TrackingSettings
import com.example.streetsweep.domain.AreaLevel
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.ChunkGrid
import com.example.streetsweep.domain.ExclusionReason
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.GuidanceMode
import com.example.streetsweep.domain.LatLngPoint
import com.example.streetsweep.domain.Polygon
import com.example.streetsweep.ui.map.RedrawRequest
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.tracking.Permissions
import com.example.streetsweep.tracking.TrackingService
import com.example.streetsweep.tracking.TrackingStateHolder
import com.example.streetsweep.tracking.TrackingStatus
import com.example.streetsweep.tracking.auto.BluetoothDevices
import com.example.streetsweep.tracking.auto.CarConnectionState
import com.example.streetsweep.ui.map.AreaOutline
import com.example.streetsweep.ui.map.DrivenTrack
import com.example.streetsweep.ui.map.DraftEditor
import com.example.streetsweep.ui.map.MapLayers
import com.example.streetsweep.ui.map.PoiMarker
import com.example.streetsweep.ui.map.TargetHighlight
import com.example.streetsweep.ui.common.Format
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.round

data class Viewport(val bounds: Bounds, val zoom: Double)

/** What the outline being drawn will become. */
enum class DrawMode { AREA, EXCLUDE }

@OptIn(ExperimentalCoroutinesApi::class, FlowPreview::class)
class HomeViewModel(private val container: AppContainer, private val context: Context) : ViewModel() {

    val status: StateFlow<TrackingStatus> = TrackingStateHolder.status

    val settings: StateFlow<TrackingSettings> = container.settings.settings
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), TrackingSettings())

    val carConnected: StateFlow<Boolean> = CarConnection(context).type.asFlow()
        .map { CarConnectionState.isConnectedType(it) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    private val _bluetoothTriggerConnected = MutableStateFlow<Boolean?>(null)
    val bluetoothTriggerConnected: StateFlow<Boolean?> = _bluetoothTriggerConnected

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    // ---- viewport-driven data ----
    private val viewport = MutableStateFlow<Viewport?>(null)
    fun onViewport(bounds: Bounds, zoom: Double) { viewport.value = Viewport(bounds, zoom) }
    val currentViewport: Viewport? get() = viewport.value

    private val debouncedViewport = viewport.debounce(200)

    val areas: StateFlow<List<AreaWithStats>> = container.coverageRepository.observeAreasWithStats()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** The smallest area around the centre of the map: what the status card reports on. */
    val focusedArea: StateFlow<AreaWithStats?> = combine(areas, viewport) { list, vp ->
        vp?.let { CoverageRepository.deepestContaining(list, it.bounds.center) }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val streetsInView: StateFlow<List<StreetStatus>> = debouncedViewport.flatMapLatest { vp ->
        if (vp == null || vp.zoom < STREET_ZOOM) flowOf(emptyList())
        else container.coverageRepository.observeStreetsInView(vp.bounds, STREET_LIMIT)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val edgesInView = debouncedViewport.flatMapLatest { vp ->
        if (vp == null || vp.zoom < EDGE_ZOOM) flowOf(emptyList())
        else container.coverageRepository.observeEdgesInView(vp.bounds, EDGE_LIMIT)
            .map { l -> l.map { DrivenTrack(ShapeText.decode(it.shape), it.drivenAt) } }
    }

    private val activeSessionId = status.map { (it as? TrackingStatus.Recording)?.sessionId }

    private val activeRaw = activeSessionId.flatMapLatest { id ->
        if (id == null) flowOf(emptyList()) else container.trackRepository.observePoints(id)
    }.map { pts -> pts.map { LatLngPoint(it.latitude, it.longitude) } }

    private val activeMatched = activeSessionId.flatMapLatest { id ->
        if (id == null) flowOf(emptyList()) else container.trackRepository.observeSnappedPoints(id)
    }.map { pts -> pts.map { LatLngPoint(it.latitude, it.longitude) } }

    /** Outline under construction; empty when not drawing. */
    val draft = MutableStateFlow<List<LatLngPoint>>(emptyList())
    val drawing = MutableStateFlow(false)
    /** Area being redrawn, or null when drawing a new one. */
    var redrawing: RedrawRequest? = null
        private set

    val drawMode = MutableStateFlow(DrawMode.AREA)

    fun startDrawing(mode: DrawMode = DrawMode.AREA, redraw: RedrawRequest? = null) {
        redrawing = redraw
        drawMode.value = if (redraw != null) DrawMode.AREA else mode
        draft.value = redraw?.vertices.orEmpty()
        selectedStreet.value = null
        drawing.value = true
    }

    val selectedVertex = MutableStateFlow<Int?>(null)

    // ---- tapping a street ----

    val selectedStreet = MutableStateFlow<StreetStatus?>(null)

    /** A tap either adds an outline point (while drawing) or picks the street under the finger. */
    fun onMapTap(p: LatLngPoint) {
        if (drawing.value) {
            addDraftPoint(p)
            return
        }
        val vp = viewport.value
        val streets = streetsInView.value
        if (vp == null || streets.isEmpty()) {
            selectedStreet.value = null
            return
        }
        // Tap tolerance of roughly 24 screen pixels, expressed in metres at this zoom.
        val metersPerPixel = 156_543.03392 * cos(Math.toRadians(p.latitude)) / 2.0.pow(vp.zoom)
        val tolerance = (24.0 * metersPerPixel).coerceIn(8.0, 150.0)
        val hit = streets.filter { it.shape.size >= 2 }
            .map { it to Geo.distanceToPolylineMeters(p, it.shape) }
            .minByOrNull { it.second }
        selectedStreet.value = hit?.takeIf { it.second <= tolerance }?.first
    }

    fun clearSelectedStreet() { selectedStreet.value = null }

    fun setSelectedExcluded(excluded: Boolean, reason: ExclusionReason = ExclusionReason.GATED) {
        val s = selectedStreet.value ?: return
        viewModelScope.launch {
            if (excluded) {
                container.coverageRepository.exclude(listOf(s.wayId), reason)
                _message.value = "${s.label} excluded from coverage"
            } else {
                container.coverageRepository.include(listOf(s.wayId))
                _message.value = "${s.label} counts again"
            }
            selectedStreet.value = null
        }
    }

    // ---- excluding everything inside a shape ----

    /** Non-null while the "exclude these streets?" confirmation is up; holds the street count. */
    val pendingExcludeCount = MutableStateFlow<Int?>(null)

    fun prepareExcludeFromDraft() {
        val polygon = draft.value
        if (polygon.size < 3) return
        viewModelScope.launch { pendingExcludeCount.value = container.coverageRepository.wayIdsInPolygon(polygon).size }
    }

    fun cancelExclude() { pendingExcludeCount.value = null }

    fun confirmExcludeFromDraft(reason: ExclusionReason) {
        val polygon = draft.value
        if (polygon.size < 3) return
        viewModelScope.launch {
            val n = container.coverageRepository.excludeInPolygon(polygon, reason)
            _message.value = if (n == 0) "No streets inside that shape" else "Excluded $n streets"
            cancelDrawing()
        }
    }

    fun addDraftPoint(p: LatLngPoint) {
        if (!drawing.value) return
        // A tap on the map with a vertex selected just clears the selection.
        if (selectedVertex.value != null) { selectedVertex.value = null; return }
        draft.value = draft.value + p
    }

    fun undoDraftPoint() { selectedVertex.value = null; draft.value = draft.value.dropLast(1) }
    fun cancelDrawing() {
        drawing.value = false
        draft.value = emptyList()
        selectedVertex.value = null
        redrawing = null
        drawMode.value = DrawMode.AREA
        pendingExcludeCount.value = null
    }

    fun deleteSelectedPoint() {
        val i = selectedVertex.value ?: return
        draft.value = draft.value.filterIndexed { idx, _ -> idx != i }
        selectedVertex.value = null
    }

    /** Direct manipulation of the outline from the map overlay. */
    val draftEditor = object : DraftEditor {
        override val enabled: Boolean get() = drawing.value
        override fun onVertexMoved(index: Int, point: LatLngPoint) {
            val d = draft.value
            if (index in d.indices) draft.value = d.toMutableList().also { it[index] = point }
        }
        override fun onVertexInserted(index: Int, point: LatLngPoint) {
            val d = draft.value.toMutableList()
            d.add(index.coerceIn(0, d.size), point)
            draft.value = d
            selectedVertex.value = null
        }
        override fun onVertexSelected(index: Int?) {
            selectedVertex.value = if (index != null && selectedVertex.value == index) null else index
        }
    }

    /** Uses the current map view as a rectangle outline. */
    fun useViewAsDraft() { viewport.value?.let { draft.value = Polygon.rectangle(it.bounds) } }

    private val poisInView = debouncedViewport.flatMapLatest { vp ->
        if (vp == null || vp.zoom < EDGE_ZOOM) flowOf(emptyList())
        else container.trackRepository.observePoisInView(vp.bounds).map { l ->
            l.map { PoiMarker(it.id, LatLngPoint(it.latitude, it.longitude), it.note ?: Format.time(it.timestamp)) }
        }
    }

    // ---- guidance: nearest street still to drive ----

    /** Best known position: the live fix while recording, otherwise the last known location. */
    private val position = MutableStateFlow<LatLngPoint?>(null)

    fun refreshPosition() {
        viewModelScope.launch { lastKnownLocation()?.let { position.value = it } }
    }

    /** The plan being followed, if any. Shared with the car screen through the container. */
    val route: StateFlow<RouteState.Planned?> = container.route.plan

    private val _planning = MutableStateFlow(false)
    val planning: StateFlow<Boolean> = _planning

    fun setGuidanceMode(mode: GuidanceMode) {
        viewModelScope.launch {
            container.settings.setGuidanceMode(mode)
            if (mode != GuidanceMode.ROUTE) container.route.clear()
            else if (container.route.plan.value == null) planRoute()
        }
    }

    /**
     * Works out an order to drive the focused area in. Wants an area, because "every street
     * with the least backtracking" is only a sensible question inside a boundary.
     */
    fun planRoute() {
        if (_planning.value) return
        viewModelScope.launch {
            val area = focusedArea.value
            if (area == null) {
                _message.value = "Pick an area first — a route needs a boundary to work within"
                return@launch
            }
            val from = position.value ?: lastKnownLocation()
            if (from == null) {
                _message.value = "No position yet, so there is nowhere to start from"
                return@launch
            }
            _planning.value = true
            val plan = runCatching { container.coverageRepository.planRoute(from, area.area.id) }
                .onFailure { _message.value = "Could not work out a route: ${it.message}" }
                .getOrNull()
            _planning.value = false
            if (plan == null) return@launch
            if (plan.isEmpty) {
                container.route.clear()
                _message.value = "Nothing left to drive in ${area.name}"
                return@launch
            }
            container.route.set(area.area.id, area.name, plan)
            _message.value = buildString {
                append("${plan.requiredCount} streets, ")
                append(Geo.formatDistance(plan.totalMeters))
                append(" with ")
                append(Geo.formatDistance(plan.deadheadMeters))
                append(" of backtracking")
                if (plan.unreachable > 0) append(" · ${plan.unreachable} out of reach")
            }
        }
    }

    /** Where the route wants you next, or null when not following one. */
    val routeTarget: StateFlow<RouteTarget?> = combine(
        position.map { p -> p?.let { LatLngPoint(round(it.latitude * 1e4) / 1e4, round(it.longitude * 1e4) / 1e4) } }
            .distinctUntilChanged(),
        route,
        container.coverageRepository.observeDrivenEdgeCount(),
    ) { pos, planned, _ -> pos to planned }
        .debounce(400)
        .mapLatest { (pos, planned) ->
            if (pos == null || planned == null) null
            else container.coverageRepository.nextOnRoute(planned.route, pos)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /**
     * What the map points at: nothing, the closest street still owing, or the next street
     * on the plan. All three end up in the same shape so the map and the card do not care
     * which one they were given.
     */
    val nearest: StateFlow<NearestStreet?> = combine(
        position.map { p -> p?.let { LatLngPoint(round(it.latitude * 1e4) / 1e4, round(it.longitude * 1e4) / 1e4) } }
            .distinctUntilChanged(),
        focusedArea.map { it?.area?.id }.distinctUntilChanged(),
        container.coverageRepository.observeDrivenEdgeCount(),
        container.coverageRepository.observeExclusionCount(),
        settings.map { it.guidanceMode }.distinctUntilChanged(),
    ) { pos, areaId, _, _, mode -> Triple(pos, areaId, mode) }
        .debounce(400)
        .mapLatest { (pos, areaId, mode) ->
            when {
                pos == null || mode == GuidanceMode.OFF -> null
                mode == GuidanceMode.NEAREST -> container.coverageRepository.nearestUndriven(pos, areaId)
                else -> container.route.plan.value
                    ?.let { container.coverageRepository.nextOnRoute(it.route, pos) }?.street
                    ?: container.coverageRepository.nearestUndriven(pos, areaId)
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** Id of the marker just placed, so the snackbar's "Add note" knows what to edit. */
    val lastPoiId = MutableStateFlow<Long?>(null)

    /** Marks the current position. Uses the live fix while recording, otherwise the last known location. */
    fun markPoi() {
        viewModelScope.launch {
            val rec = TrackingStateHolder.status.value as? TrackingStatus.Recording
            val fresh = rec?.lastPoint?.takeIf { rec.lastFixAt != null && System.currentTimeMillis() - rec.lastFixAt!! < 30_000 }
            val (point, accuracy) = if (fresh != null) fresh to 0f else {
                val loc = currentLocation()
                if (loc == null) { _message.value = "No GPS fix yet"; return@launch }
                loc
            }
            val poi = container.trackRepository.addPoi(point.latitude, point.longitude, accuracy, rec?.sessionId)
            lastPoiId.value = poi.id
            _message.value = "Marked ${Format.time(poi.timestamp)}"
        }
    }

    fun setPoiNote(id: Long, note: String) {
        viewModelScope.launch { container.trackRepository.setPoiNote(id, note) }
    }

    val layers: StateFlow<MapLayers> = combine(
        areas, focusedArea, streetsInView, edgesInView, activeRaw, activeMatched,
        draft, poisInView, selectedVertex, selectedStreet, nearest, settings,
    ) { arr ->
        @Suppress("UNCHECKED_CAST")
        val areaList = arr[0] as List<AreaWithStats>
        val focused = arr[1] as AreaWithStats?
        @Suppress("UNCHECKED_CAST")
        MapLayers(
            areas = areaList.map { AreaOutline(it.name, it.vertices, it.bounds, it.stats.percent, it.area.level, focused = it.area.id == focused?.area?.id) },
            streets = arr[2] as List<com.example.streetsweep.data.StreetStatus>,
            drivenEdges = arr[3] as List<DrivenTrack>,
            colourByRecency = (arr[11] as TrackingSettings).colourByRecency,
            activeRaw = arr[4] as List<LatLngPoint>,
            activeMatched = arr[5] as List<LatLngPoint>,
            draft = arr[6] as List<LatLngPoint>,
            pois = arr[7] as List<PoiMarker>,
            draftSelected = arr[8] as Int?,
            selectedWayId = (arr[9] as StreetStatus?)?.wayId,
            target = (arr[10] as NearestStreet?)?.let { n -> TargetHighlight(n.street.shape, n.point, position.value) },
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), MapLayers())

    init {
        viewModelScope.launch {
            status.collect { st -> (st as? TrackingStatus.Recording)?.lastPoint?.let { position.value = it } }
        }
        viewModelScope.launch {
            delay(2_000)
            if (!TrackingStateHolder.isRecording) container.trackRepository.closeOrphanedSessions()
        }
    }

    fun startManual() = TrackingService.start(context, TriggerSource.MANUAL)
    fun pauseTracking() = TrackingService.pause(context)
    fun resumeTracking() = TrackingService.resume(context)
    fun stopTracking() = TrackingService.stop(context)

    /** How many download cells the drafted outline would need; drives the size warning in the dialog. */
    fun cellsForDraft(): Int = Bounds.of(draft.value)?.let { ChunkGrid.cellsFor(it).size } ?: 0

    fun createAreaFromDraft(name: String, level: AreaLevel, parentId: Long?) {
        val polygon = draft.value
        if (polygon.size < 3) return
        viewModelScope.launch {
            val area = container.coverageRepository.createArea(name, level, parentId, polygon)
            StreetDownloadWorker.enqueue(context, area.id)
            _message.value = "Downloading streets for ${area.name}…"
            cancelDrawing()
        }
    }

    fun finishRedraw() {
        val r = redrawing ?: return
        val polygon = draft.value
        if (polygon.size < 3) return
        viewModelScope.launch {
            container.coverageRepository.updatePolygon(r.areaId, polygon)
            StreetDownloadWorker.enqueue(context, r.areaId) // fetch any newly covered cells
            _message.value = "Updated outline of ${r.name}"
            cancelDrawing()
        }
    }

    fun clearMessage() { _message.value = null }

    fun refreshBluetoothTriggerState() {
        viewModelScope.launch {
            val address = settings.value.bluetoothTriggerAddress ?: container.settings.current().bluetoothTriggerAddress
            _bluetoothTriggerConnected.value = when {
                address == null -> null
                !Permissions.hasBluetoothConnect(context) -> null
                else -> BluetoothDevices.isConnected(context, address)
            }
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun currentLocation(): Pair<LatLngPoint, Float>? {
        if (!Permissions.hasLocation(context)) return null
        val loc = runCatching {
            container.fusedLocationClient.getCurrentLocation(
                com.google.android.gms.location.Priority.PRIORITY_HIGH_ACCURACY, null,
            ).await()
        }.getOrNull() ?: runCatching { container.fusedLocationClient.lastLocation.await() }.getOrNull() ?: return null
        return LatLngPoint(loc.latitude, loc.longitude) to (if (loc.hasAccuracy()) loc.accuracy else 0f)
    }

    @SuppressLint("MissingPermission")
    suspend fun lastKnownLocation(): LatLngPoint? {
        if (!Permissions.hasLocation(context)) return null
        return runCatching { container.fusedLocationClient.lastLocation.await() }
            .getOrNull()?.let { LatLngPoint(it.latitude, it.longitude) }
    }

    companion object {
        /** Individual streets appear from neighbourhood zoom; driven segments from city zoom. */
        const val STREET_ZOOM = 14.0
        const val EDGE_ZOOM = 12.0
        const val STREET_LIMIT = 8_000
        const val EDGE_LIMIT = 30_000
    }
}
