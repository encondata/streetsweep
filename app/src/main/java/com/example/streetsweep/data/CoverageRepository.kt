package com.example.streetsweep.data

import androidx.room.withTransaction
import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.db.AreaStatsRow
import com.example.streetsweep.data.db.AreaWay
import com.example.streetsweep.data.db.CoverageArea
import com.example.streetsweep.data.db.DrivenEdge
import com.example.streetsweep.data.db.OsmWay
import com.example.streetsweep.data.db.StreetChunk
import com.example.streetsweep.data.db.StreetExclusion
import com.example.streetsweep.data.db.WayCoverageRow
import com.example.streetsweep.data.db.WeeklyMetersRow
import com.example.streetsweep.data.osm.MatchedEdge
import com.example.streetsweep.data.osm.ImportedArea
import com.example.streetsweep.data.osm.OsmStreet
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.domain.AreaLevel
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.RoadShape
import com.example.streetsweep.domain.ExclusionReason
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.GraphWay
import com.example.streetsweep.domain.RoadGraph
import com.example.streetsweep.domain.RoutePlan
import com.example.streetsweep.domain.RoutePlanner
import com.example.streetsweep.domain.LatLngPoint
import com.example.streetsweep.domain.Polygon
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import java.util.Locale
import kotlin.math.roundToInt

/** One street with how much of it has been driven. */
data class StreetStatus(
    val wayId: Long,
    val name: String?,
    val highway: String,
    val lengthMeters: Double,
    val shape: List<LatLngPoint>,
    val fraction: Double,
    val excluded: Boolean = false,
    /** Usually [DONE_THRESHOLD]; less for a street a car cannot finish. See RoadShape. */
    val doneFraction: Double = DONE_THRESHOLD,
) {
    val isDone: Boolean get() = !excluded && fraction >= doneFraction
    val isPartial: Boolean get() = !excluded && fraction > PARTIAL_THRESHOLD && fraction < doneFraction
    val isUndriven: Boolean get() = !excluded && fraction <= PARTIAL_THRESHOLD
    val label: String get() = name ?: "Unnamed ${highway.replace('_', ' ')}"

    companion object {
        /** GPS and matching slop means a fully driven street rarely scores exactly 1.0. */
        const val DONE_THRESHOLD = 0.8
        const val PARTIAL_THRESHOLD = 0.02

        fun fromRow(r: WayCoverageRow) = StreetStatus(
            wayId = r.id, name = r.name, highway = r.highway, lengthMeters = r.lengthMeters,
            shape = ShapeText.decode(r.shape),
            fraction = if (r.lengthMeters <= 0) 0.0 else (r.drivenMeters / r.lengthMeters).coerceIn(0.0, 1.0),
            excluded = r.excluded,
            doneFraction = r.minDoneFraction,
        )
    }
}

data class AreaStats(
    /** Counts and lengths are over countable streets only; [excluded] are left out of them. */
    val total: Int,
    val done: Int,
    val partial: Int,
    val metersTotal: Double,
    val metersDriven: Double,
    val excluded: Int,
) {
    val percent: Int get() = if (metersTotal <= 0) 0 else (metersDriven / metersTotal * 100).roundToInt()
    val remaining: Int get() = (total - done).coerceAtLeast(0)

    companion object {
        val EMPTY = AreaStats(0, 0, 0, 0.0, 0.0, 0)
        fun fromRow(r: AreaStatsRow) = AreaStats(
            total = r.total, done = r.done ?: 0, partial = r.partial ?: 0,
            metersTotal = r.meters ?: 0.0, metersDriven = r.drivenMeters ?: 0.0,
            excluded = r.excluded ?: 0,
        )
    }
}

/** The closest street that still needs driving, with where to aim for it. */
data class NearestStreet(
    val street: StreetStatus,
    /** The point on that street closest to where you are. */
    val point: LatLngPoint,
    val distanceMeters: Double,
    val bearingDegrees: Double,
) {
    val compass: String get() = Geo.compassPoint(bearingDegrees)
}

/** Where a planned route wants you next, and how far through it you are. */
data class RouteTarget(
    val street: NearestStreet,
    /** 1-based, so it reads as "3 of 128". */
    val position: Int,
    val total: Int,
)

data class AreaWithStats(val area: CoverageArea, val stats: AreaStats) {
    val name get() = area.name
    val level get() = area.areaLevel
    val bounds get() = area.bounds
    val vertices: List<LatLngPoint> = area.vertices
    fun contains(p: LatLngPoint) = bounds.contains(p) && Polygon.contains(vertices, p)
}

data class Recorded(val segments: Int, val meters: Double)

/** A proposed "everything past this gate is private" selection, awaiting confirmation. */
data class GateSelection(
    val startStreet: StreetStatus,
    val streets: List<StreetStatus>,
    val totalMeters: Double,
) {
    val count: Int get() = streets.size
}

/** Why a gate selection could not be made. */
enum class GateProblem { NO_ROAD, NO_STREETS_LOADED, TOO_DENSE, NOT_GATED }

/** A road leaving your position that the gate could be on, named so the driver can recognise it. */
data class GateBranch(
    val side: RoadGraph.Side,
    val wayId: Long,
    val label: String,
    val gatePoint: LatLngPoint,
    val bearingDegrees: Double,
    val preview: List<LatLngPoint>,
)

class GateException(val problem: GateProblem) : Exception(problem.name)

@OptIn(ExperimentalCoroutinesApi::class)
class CoverageRepository(private val db: AppDatabase) {
    private val dao get() = db.coverageDao()

    // ---- areas ----
    fun observeAreas(): Flow<List<CoverageArea>> = dao.observeAreas()
    suspend fun getAreas(): List<CoverageArea> = dao.getAreas()

    /** Areas whose streets have never finished downloading, including ones that failed. */
    suspend fun unfinishedAreaIds(): List<Long> =
        dao.getAreas().filter { it.streetsLoadedAt == null }.map { it.id }
    suspend fun getArea(id: Long): CoverageArea? = dao.getArea(id)

    fun observeStats(areaId: Long): Flow<AreaStats> = dao.observeStatsFor(areaId).map { AreaStats.fromRow(it) }

    /** Every area with its live numbers, largest level first. */
    fun observeAreasWithStats(): Flow<List<AreaWithStats>> = dao.observeAreas().flatMapLatest { areas ->
        if (areas.isEmpty()) flowOf(emptyList())
        else combine(areas.map { a -> observeStats(a.id).map { AreaWithStats(a, it) } }) { it.toList() }
    }

    /** One-shot read of every area with its numbers, for a push. */
    suspend fun areasWithStatsNow(): List<AreaWithStats> = observeAreasWithStats().first()

    suspend fun createArea(name: String, level: AreaLevel, parentId: Long?, polygon: List<LatLngPoint>): CoverageArea {
        require(polygon.size >= 3) { "An area needs at least three points" }
        val b = Bounds.of(polygon)!!
        val area = CoverageArea(
            name = name.trim().ifEmpty { level.label }, level = level.ordinal, parentId = parentId,
            polygon = ShapeText.encode(polygon),
            south = b.south, west = b.west, north = b.north, east = b.east,
            createdAt = System.currentTimeMillis(),
        )
        val created = area.copy(id = dao.insertArea(area))
        refreshMembership(created)
        return created
    }

    /**
     * Brings in areas drawn elsewhere. Larger levels are created first so a neighbourhood can
     * name the city it belongs to, and each one is matched against a parent already in the
     * database or one created earlier in this same import.
     */
    suspend fun importAreas(imported: List<ImportedArea>): List<CoverageArea> {
        val created = ArrayList<CoverageArea>()
        val byName = HashMap<String, Long>()
        dao.getAreas().forEach { byName[it.name.lowercase()] = it.id }
        for (area in imported.sortedByDescending { it.level.ordinal }) {
            if (area.polygon.size < 3) continue
            val parentId = area.parent?.lowercase()?.let { byName[it] }
            val made = createArea(area.name, area.level, parentId, area.polygon)
            byName[made.name.lowercase()] = made.id
            created += made
        }
        return created
    }

    /** What a pull did to one area that the phone already had. */
    enum class WebSync { UNCHANGED, UPDATED, KEPT_LOCAL }

    /**
     * Brings one area into line with the portal's copy.
     *
     * The portal is where outlines are drawn and refined, so its outline wins — with one
     * exception. If this phone has redrawn the area since it last received it, that redraw
     * is somebody's deliberate work and a sync must not throw it away; the phone's outline
     * is kept and the caller is told, so it can say so.
     *
     * [pulledOutline] is what makes the difference visible. An area that has never been
     * pulled under this rule has none, and is treated as unedited: that is how the
     * outlines that had already drifted — April Sound at 26 corners here against 269 on
     * the web — get brought back into line the first time.
     */
    suspend fun syncFromWeb(mine: CoverageArea, incoming: ImportedArea, parentId: Long?): WebSync {
        if (incoming.polygon.size < 3) return WebSync.UNCHANGED
        val webOutline = ShapeText.encode(incoming.polygon)
        val redrawnHere = mine.pulledOutline != null && mine.polygon != mine.pulledOutline
        val outlineDiffers = mine.polygon != webOutline
        val levelDiffers = mine.level != incoming.level.ordinal
        val parentDiffers = parentId != null && mine.parentId != parentId

        if (outlineDiffers && redrawnHere) return WebSync.KEPT_LOCAL
        if (!outlineDiffers && !levelDiffers && !parentDiffers) {
            // Already identical; remember that it is, so a later redraw here is noticed.
            if (mine.pulledOutline != webOutline) dao.updateArea(mine.copy(pulledOutline = webOutline))
            return WebSync.UNCHANGED
        }

        val b = Bounds.of(incoming.polygon)!!
        val updated = mine.copy(
            polygon = webOutline, pulledOutline = webOutline,
            south = b.south, west = b.west, north = b.north, east = b.east,
            level = incoming.level.ordinal,
            parentId = parentId ?: mine.parentId,
        )
        dao.updateArea(updated)
        if (outlineDiffers) refreshMembership(updated)
        return WebSync.UPDATED
    }

    /** Stamps freshly imported areas as having come from the portal. */
    suspend fun markPulled(ids: List<Long>) {
        for (id in ids) {
            val a = dao.getArea(id) ?: continue
            dao.updateArea(a.copy(pulledOutline = a.polygon))
        }
    }

    /** Replaces an area's outline and recomputes which streets it contains. */
    suspend fun updatePolygon(id: Long, polygon: List<LatLngPoint>) {
        require(polygon.size >= 3)
        val area = dao.getArea(id) ?: return
        val b = Bounds.of(polygon)!!
        val updated = area.copy(polygon = ShapeText.encode(polygon), south = b.south, west = b.west, north = b.north, east = b.east)
        dao.updateArea(updated)
        refreshMembership(updated)
    }

    suspend fun deleteArea(id: Long) = db.withTransaction {
        dao.orphanChildren(id)
        dao.clearMembership(id)
        dao.deleteArea(id)
    }

    /** Point-in-polygon test of every loaded street centroid inside the area's box. */
    suspend fun refreshMembership(area: CoverageArea) {
        val poly = area.vertices
        val b = area.bounds
        val inside = dao.getCentroidsIn(b.south, b.west, b.north, b.east)
            .filter { Polygon.contains(poly, LatLngPoint(it.cLat, it.cLng)) }
            .map { AreaWay(area.id, it.id) }
        db.withTransaction {
            dao.clearMembership(area.id)
            if (inside.isNotEmpty()) dao.insertMembership(inside)
        }
    }

    private suspend fun refreshMembershipTouching(b: Bounds) {
        dao.getAreasIntersecting(b.south, b.west, b.north, b.east).forEach { refreshMembership(it) }
    }

    // ---- exclusions ----

    /** Marks streets as not counting toward coverage. */
    suspend fun exclude(wayIds: List<Long>, reason: ExclusionReason, note: String? = null) {
        if (wayIds.isEmpty()) return
        val now = System.currentTimeMillis()
        dao.insertExclusions(wayIds.distinct().map { StreetExclusion(it, reason.name, note, now) })
    }

    suspend fun include(wayIds: List<Long>) {
        if (wayIds.isEmpty()) return
        dao.removeExclusions(wayIds.distinct())
    }

    suspend fun exclusionOf(wayId: Long): StreetExclusion? = dao.getExclusion(wayId)

    fun observeExclusionCount(): Flow<Int> = dao.observeExclusionCount()

    /** Street ids whose midpoint falls inside [polygon] — the gated-community selection. */
    suspend fun wayIdsInPolygon(polygon: List<LatLngPoint>): List<Long> {
        if (polygon.size < 3) return emptyList()
        val b = Bounds.of(polygon)!!
        return dao.getCentroidsIn(b.south, b.west, b.north, b.east)
            .filter { Polygon.contains(polygon, LatLngPoint(it.cLat, it.cLng)) }
            .map { it.id }
    }

    /** Excludes everything inside a drawn shape. Returns how many streets were affected. */
    suspend fun excludeInPolygon(polygon: List<LatLngPoint>, reason: ExclusionReason, note: String? = null): Int {
        val ids = wayIdsInPolygon(polygon)
        exclude(ids, reason, note)
        return ids.size
    }

    private suspend fun localGraph(from: LatLngPoint): List<StreetStatus> {
        val box = Geo.boxAround(from, GATE_SEARCH_METERS)
        val rows = dao.getWaysInBox(box.south, box.west, box.north, box.east, GATE_WAY_LIMIT)
        if (rows.isEmpty()) throw GateException(GateProblem.NO_STREETS_LOADED)
        // A truncated graph could look bounded when it is not, so refuse rather than risk it.
        if (rows.size >= GATE_WAY_LIMIT) throw GateException(GateProblem.TOO_DENSE)
        return rows.map { StreetStatus.fromRow(it) }.filter { it.shape.size >= 2 }
    }

    /** The roads leaving your position, so the driver can point at the one the gate is on. */
    suspend fun gateBranches(from: LatLngPoint, headingDegrees: Double): Result<List<GateBranch>> = runCatching {
        val streets = localGraph(from)
        val byId = streets.associateBy { it.wayId }
        val graph = streets.map { GraphWay(it.wayId, it.shape, it.lengthMeters) }
        // Parked on the road, a tight radius picks exactly the junction you are at. Sitting a
        // little off it — a gate set back from the kerb, or a poor fix — needs a wider look,
        // so widen only when the tight search found next to nothing.
        var found = RoadGraph.branchesAt(graph, from, headingDegrees, RoadGraph.BRANCH_RADIUS_METERS)
        if (found.size < 2) {
            found = RoadGraph.branchesAt(graph, from, headingDegrees, RoadGraph.WIDE_BRANCH_RADIUS_METERS)
        }
        val branches = found.map { b ->
            GateBranch(
                side = b.side,
                wayId = b.wayId,
                label = byId[b.wayId]?.label ?: "Unnamed road",
                gatePoint = b.gatePoint,
                bearingDegrees = b.bearingDegrees,
                preview = b.preview,
            )
        }
        if (branches.isEmpty()) throw GateException(GateProblem.NO_ROAD)
        branches
    }

    /** Everything beyond the gate, once the driver has said which road it is on. */
    suspend fun gateFrom(branch: GateBranch): Result<GateSelection> = runCatching {
        val streets = localGraph(branch.gatePoint)
        val start = streets.firstOrNull { it.wayId == branch.wayId } ?: throw GateException(GateProblem.NO_ROAD)
        val result = RoadGraph.beyondGate(
            ways = streets.map { GraphWay(it.wayId, it.shape, it.lengthMeters) },
            startWayId = branch.wayId,
            gatePoint = branch.gatePoint,
            headingDegrees = branch.bearingDegrees,
        )
        if (result.reachedCap || result.isEmpty) throw GateException(GateProblem.NOT_GATED)
        val ids = result.wayIds.toSet()
        GateSelection(start, streets.filter { it.wayId in ids }, result.totalMeters)
    }

    /** Applies a confirmed gate selection. Returns the ids so the caller can offer an undo. */
    suspend fun applyGate(selection: GateSelection): List<Long> {
        val ids = selection.streets.map { it.wayId }
        exclude(ids, ExclusionReason.GATED, "Beyond the gate on ${selection.startStreet.label}")
        return ids
    }

    // ---- street list and guidance ----

    fun observeAreaStreets(areaId: Long, limit: Int = AREA_STREET_LIMIT): Flow<List<StreetStatus>> =
        dao.observeAreaStreets(areaId, limit).map { rows -> rows.map { StreetStatus.fromRow(it) } }

    /**
     * The closest street that still needs driving. Searches outward in rings so a dense
     * neighbourhood costs one small query, and restricts to [areaId] when given so guidance
     * does not send you out of the area you are sweeping.
     */
    suspend fun nearestUndriven(from: LatLngPoint, areaId: Long?): NearestStreet? {
        for (radius in SEARCH_RADII_METERS) {
            val b = Geo.boxAround(from, radius)
            val rows = if (areaId == null) {
                dao.undrivenNear(b.south, b.west, b.north, b.east, StreetStatus.DONE_THRESHOLD, CANDIDATE_LIMIT)
            } else {
                dao.undrivenNearInArea(areaId, b.south, b.west, b.north, b.east, StreetStatus.DONE_THRESHOLD, CANDIDATE_LIMIT)
            }
            var best: NearestStreet? = null
            for (row in rows) {
                val street = StreetStatus.fromRow(row)
                if (street.shape.size < 2) continue
                val d = Geo.distanceToPolylineMeters(from, street.shape)
                if (best == null || d < best.distanceMeters) {
                    val closest = Geo.closestPointOnPolyline(from, street.shape) ?: continue
                    best = NearestStreet(street, closest, d, Geo.bearingDegrees(from, closest))
                }
            }
            if (best != null) return best
        }
        return null
    }

    /**
     * An order to drive everything still owing in [areaId], starting from [from].
     *
     * Every street in the area goes into the graph, driven or not: a street you have
     * already done is still a road you can use to reach one you have not. Only the ones
     * still owing are required.
     */
    suspend fun planRoute(from: LatLngPoint, areaId: Long): RoutePlan = withContext(Dispatchers.Default) {
        val rows = dao.getAreaStreets(areaId, PLAN_STREET_LIMIT).map { StreetStatus.fromRow(it) }
        val ways = rows.filter { it.shape.size >= 2 }
            .map { GraphWay(it.wayId, it.shape, it.lengthMeters) }
        val required = rows.filter { it.shape.size >= 2 && !it.excluded && !it.isDone }
            .map { it.wayId }
            .toSet()
        RoutePlanner.plan(ways, required, from)
    }

    /**
     * The next street on [plan] that is still owing, and how far from [from] it is.
     *
     * Walks the plan rather than trusting a counter, so a street driven out of order --
     * or one you happened to cover on a different trip -- is simply skipped.
     */
    suspend fun nextOnRoute(plan: RoutePlan, from: LatLngPoint): RouteTarget? {
        val ordered = plan.legs.filter { it.required }.map { it.wayId }.distinct()
        if (ordered.isEmpty()) return null
        val byId = ordered.chunked(WAY_LOOKUP_CHUNK)
            .flatMap { dao.coverageForWays(it) }
            .associateBy { it.id }
        for ((index, wayId) in ordered.withIndex()) {
            val row = byId[wayId] ?: continue
            val street = StreetStatus.fromRow(row)
            if (street.excluded || street.isDone || street.shape.size < 2) continue
            val closest = Geo.closestPointOnPolyline(from, street.shape) ?: continue
            return RouteTarget(
                street = NearestStreet(
                    street = street,
                    point = closest,
                    distanceMeters = Geo.distanceToPolylineMeters(from, street.shape),
                    bearingDegrees = Geo.bearingDegrees(from, closest),
                ),
                position = index + 1,
                total = ordered.size,
            )
        }
        return null
    }

    suspend fun setProgress(id: Long, total: Int, done: Int, error: String? = null, loadedAt: Long? = null) =
        dao.setProgress(id, total, done, error, loadedAt)

    // ---- street network ----
    suspend fun getChunk(key: String): StreetChunk? = dao.getChunk(key)

    suspend fun storeChunk(key: String, streets: List<OsmStreet>) = db.withTransaction {
        val now = System.currentTimeMillis()
        dao.insertWays(
            streets.map { s ->
                val b = Bounds.of(s.shape)!!
                val c = b.center
                OsmWay(
                    id = s.id, name = s.name, highway = s.highway, lengthMeters = s.lengthMeters,
                    shape = ShapeText.encode(s.shape),
                    minLat = b.south, minLng = b.west, maxLat = b.north, maxLng = b.east,
                    cLat = c.latitude, cLng = c.longitude, loadedAt = now,
                    // Read off the shape at import, so the coverage queries never have
                    // to decode a polyline to decide whether a street can be finished.
                    minDoneFraction = RoadShape.doneFractionFor(s.lengthMeters, s.shape),
                )
            },
        )
        dao.upsertChunk(StreetChunk(key = key, loadedAt = now, wayCount = streets.size))
    }.also {
        Bounds.of(streets.flatMap { s -> listOf(s.shape.first(), s.shape.last()) })?.let { refreshMembershipTouching(it) }
    }

    fun observeWayCount(): Flow<Int> = dao.observeWayCount()

    fun observeStreetsInView(b: Bounds, limit: Int): Flow<List<StreetStatus>> =
        dao.observeWaysInView(b.south, b.west, b.north, b.east, limit).map { rows -> rows.map { StreetStatus.fromRow(it) } }

    // ---- driven edges ----
    fun observeEdgesInView(b: Bounds, limit: Int): Flow<List<DrivenEdge>> =
        dao.observeEdgesInView(b.south, b.west, b.north, b.east, limit)

    fun observeDrivenEdgeCount(): Flow<Int> = dao.observeDrivenEdgeCount()

    suspend fun getAllDrivenEdges(): List<DrivenEdge> = dao.getAllDrivenEdges()

    fun observeWeeklyAreaProgress(areaId: Long): Flow<List<WeeklyMetersRow>> = dao.observeWeeklyAreaProgress(areaId)

    /** Records matched edges as driven. Returns what was new. */
    suspend fun recordDrivenEdges(edges: List<MatchedEdge>, sessionId: Long?): Recorded {
        val now = System.currentTimeMillis()
        val rows = edges.filter { it.wayId > 0 && it.shape.size >= 2 }.map { e ->
            val b = Bounds.of(e.shape)!!
            DrivenEdge(
                key = edgeKey(e.wayId, e.shape.first(), e.shape.last()),
                wayId = e.wayId,
                name = e.names.firstOrNull(),
                roadClass = e.roadClass,
                lengthMeters = e.lengthMeters,
                shape = ShapeText.encode(e.shape),
                minLat = b.south, minLng = b.west, maxLat = b.north, maxLng = b.east,
                sessionId = sessionId,
                drivenAt = now,
            )
        }.distinctBy { it.key }
        if (rows.isEmpty()) return Recorded(0, 0.0)
        val ids = dao.insertDrivenEdges(rows)
        var n = 0
        var m = 0.0
        ids.forEachIndexed { i, id -> if (id != -1L) { n++; m += rows[i].lengthMeters } }
        return Recorded(n, m)
    }

    companion object {
        const val AREA_STREET_LIMIT = 5_000
        const val GATE_SEARCH_METERS = 3_000.0
        const val GATE_WAY_LIMIT = 6_000
        const val GATE_ON_ROAD_METERS = 60.0
        private const val CANDIDATE_LIMIT = 400
        /** Plenty for a neighbourhood or a small city; a metro would be planned area by area. */
        private const val PLAN_STREET_LIMIT = 6_000
        /** SQLite caps how many values one IN clause can hold. */
        private const val WAY_LOOKUP_CHUNK = 900
        private val SEARCH_RADII_METERS = listOf(1_200.0, 4_000.0, 12_000.0)

        /** Direction-independent identity for a segment: way id plus its two end points (≈1 m rounding). */
        fun edgeKey(wayId: Long, a: LatLngPoint, b: LatLngPoint): String {
            val ka = String.format(Locale.US, "%.5f,%.5f", a.latitude, a.longitude)
            val kb = String.format(Locale.US, "%.5f,%.5f", b.latitude, b.longitude)
            return if (ka <= kb) "$wayId|$ka|$kb" else "$wayId|$kb|$ka"
        }

        /** The smallest-level area whose outline contains the point, if any. */
        fun deepestContaining(areas: List<AreaWithStats>, p: LatLngPoint): AreaWithStats? =
            areas.filter { it.contains(p) }.minByOrNull { it.area.level }
    }
}
