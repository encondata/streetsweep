package com.example.streetsweep.data

import androidx.room.withTransaction
import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.db.AreaStatsRow
import com.example.streetsweep.data.db.AreaWay
import com.example.streetsweep.data.db.CoverageArea
import com.example.streetsweep.data.db.DrivenEdge
import com.example.streetsweep.data.db.OsmWay
import com.example.streetsweep.data.db.StreetChunk
import com.example.streetsweep.data.db.StreetCompletion
import com.example.streetsweep.data.db.StreetExclusion
import com.example.streetsweep.data.db.WayCoverageRow
import com.example.streetsweep.data.db.WeeklyMetersRow
import com.example.streetsweep.data.server.ServerSegment
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
import kotlinx.coroutines.launch
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
    /** Marked complete by hand; [fraction] is then 1. */
    val completed: Boolean = false,
) {
    val isDone: Boolean get() = !excluded && fraction >= doneFraction
    val isPartial: Boolean get() = !excluded && fraction > PARTIAL_THRESHOLD && fraction < doneFraction
    val isUndriven: Boolean get() = !excluded && fraction <= PARTIAL_THRESHOLD
    /**
     * Driven end to end, near enough. A street past [doneFraction] counts as done but can
     * still have a stretch no trace reached, and is worth marking complete until this.
     */
    val isFull: Boolean get() = completed || fraction >= FULL_THRESHOLD
    val label: String get() = name ?: "Unnamed ${highway.replace('_', ' ')}"

    companion object {
        /** GPS and matching slop means a fully driven street rarely scores exactly 1.0. */
        const val DONE_THRESHOLD = 0.8
        const val PARTIAL_THRESHOLD = 0.02
        const val FULL_THRESHOLD = 0.98

        fun fromRow(r: WayCoverageRow) = StreetStatus(
            wayId = r.id, name = r.name, highway = r.highway, lengthMeters = r.lengthMeters,
            shape = ShapeText.decode(r.shape),
            fraction = if (r.lengthMeters <= 0) 0.0 else (r.drivenMeters / r.lengthMeters).coerceIn(0.0, 1.0),
            excluded = r.excluded,
            doneFraction = r.minDoneFraction,
            completed = r.completed,
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
    /** "server" (the web's count, pulled at sync) or "phone" (worked out here). */
    val source: String = "phone",
    /** When these figures were worked out; 0 if never. */
    val updatedAt: Long = 0,
) {
    val fromServer: Boolean get() = source == "server"
    val percent: Int get() = if (metersTotal <= 0) 0 else (metersDriven / metersTotal * 100).roundToInt()
    val remaining: Int get() = (total - done).coerceAtLeast(0)

    companion object {
        val EMPTY = AreaStats(0, 0, 0, 0.0, 0.0, 0)
        fun fromRow(r: AreaStatsRow) = AreaStats(
            total = r.total, done = r.done ?: 0, partial = r.partial ?: 0,
            metersTotal = r.meters ?: 0.0, metersDriven = r.drivenMeters ?: 0.0,
            excluded = r.excluded ?: 0,
        )

        fun fromCache(c: com.example.streetsweep.data.db.AreaStatsCache) = AreaStats(
            total = c.total, done = c.done, partial = c.partial, metersTotal = c.metersTotal,
            metersDriven = c.metersDriven, excluded = c.excluded, source = c.source, updatedAt = c.updatedAt,
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
    val pieces: List<List<LatLngPoint>> = area.pieces
    fun contains(p: LatLngPoint) = area.contains(p)
}


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
    private val coverageBuilder = WayCoverageBuilder(db)

    init {
        WayCoverageBuilder.listener = { ids -> statsChangedForWays(ids) }
    }

    /** Works out any street coverage a restored or older database arrived without. */
    suspend fun ensureWayCoverage() = coverageBuilder.rebuildIfMissing()

    // ---- areas ----
    fun observeAreas(): Flow<List<CoverageArea>> = dao.observeAreas()
    suspend fun getAreas(): List<CoverageArea> = dao.getAreas()

    /** Areas whose streets have never finished downloading, including ones that failed. */
    suspend fun unfinishedAreaIds(): List<Long> =
        dao.getAreas().filter { it.streetsLoadedAt == null }.map { it.id }
    suspend fun getArea(id: Long): CoverageArea? = dao.getArea(id)

    /**
     * An area's figures, from what is kept (area_stats) — never added up on the spot. For a
     * metro that is a few hundred thousand streets, and every screen showing an area would
     * otherwise redo it every time a driven street was recorded.
     */
    fun observeStats(areaId: Long): Flow<AreaStats> =
        dao.observeCachedStats(areaId).map { it?.let(AreaStats::fromCache) ?: AreaStats.EMPTY }

    // ---- keeping the figures ----

    private val statsScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.IO)
    private val pendingStats = HashSet<Long>()
    private var statsJob: kotlinx.coroutines.Job? = null

    /** Streets changed: the figures of the areas holding them are worked out again, soon. */
    fun statsChangedForWays(wayIds: Collection<Long>) {
        if (wayIds.isEmpty()) return
        statsScope.launch {
            val ids = wayIds.distinct().chunked(WAY_LOOKUP_CHUNK).flatMap { dao.areaIdsForWays(it) }
            statsChanged(ids)
        }
    }

    /** Waits a moment for more changes, then redoes each named area once. */
    fun statsChanged(areaIds: Collection<Long>) {
        if (areaIds.isEmpty()) return
        synchronized(pendingStats) { pendingStats.addAll(areaIds) }
        statsJob?.cancel()
        statsJob = statsScope.launch {
            kotlinx.coroutines.delay(STATS_SETTLE_MS)
            val ids = synchronized(pendingStats) { pendingStats.toList().also { pendingStats.clear() } }
            runCatching { recomputeStats(ids) }
        }
    }

    /**
     * An area's figures, worked out here from the chosen team's coverage (the server's,
     * plus this phone's provisional preview) and marks. The same rule as the server's, so
     * the two agree once the preview is replaced.
     */
    private suspend fun recomputeStats(ids: List<Long>) {
        val now = System.currentTimeMillis()
        val rows = ids.distinct().mapNotNull { id ->
            val r = dao.statsForNow(id)
            com.example.streetsweep.data.db.AreaStatsCache(
                areaId = id, total = r.total, done = r.done ?: 0, partial = r.partial ?: 0,
                excluded = r.excluded ?: 0, metersTotal = r.meters ?: 0.0, metersDriven = r.drivenMeters ?: 0.0,
                source = SOURCE_PHONE, updatedAt = now,
            )
        }
        if (rows.isNotEmpty()) dao.upsertCachedStats(rows)
    }

    /** Areas with no figures kept yet (new, or just upgraded) get them, in the background. */
    suspend fun fillMissingStats() {
        val kept = dao.allCachedStats().map { it.areaId }.toSet()
        val missing = dao.getAreas().map { it.id }.filter { it !in kept }
        if (missing.isNotEmpty()) recomputeStats(missing)
    }

    /** Every area's figures again: after the coverage shown changes wholesale (another team, a recount). */
    suspend fun recomputeAllStats() = recomputeStats(dao.getAreas().map { it.id })

    /**
     * Every area in sight with its live numbers, A to Z. Areas hidden on this phone are
     * left out, so the map, lists, guidance, widget and figures all pass them over.
     */
    fun observeAreasWithStats(): Flow<List<AreaWithStats>> =
        observeWithStats(dao.observeAreas().map { all -> all.filter { !it.hidden } })

    private fun observeWithStats(source: Flow<List<CoverageArea>>): Flow<List<AreaWithStats>> =
        source.flatMapLatest { areas ->
            if (areas.isEmpty()) flowOf(emptyList())
            else combine(areas.map { a -> observeStats(a.id).map { AreaWithStats(a, it) } }) { it.toList() }
        }

    /** The areas hidden on this phone, for the Areas screen to offer back. */
    fun observeHiddenAreas(): Flow<List<CoverageArea>> =
        dao.observeAreas().map { all -> all.filter { it.hidden } }

    suspend fun setHidden(id: Long, hidden: Boolean) = dao.setHidden(id, hidden)

    /** One-shot read of every area with its numbers, hidden ones included, for a push. */
    suspend fun areasWithStatsNow(): List<AreaWithStats> = observeWithStats(dao.observeAreas()).first()

    suspend fun createArea(
        name: String, level: AreaLevel, parentId: Long?, polygon: List<LatLngPoint>,
        morePieces: List<List<LatLngPoint>> = emptyList(),
    ): CoverageArea {
        require(polygon.size >= 3) { "An area needs at least three points" }
        val more = morePieces.filter { it.size >= 3 }
        val b = Bounds.of(polygon + more.flatten())!!
        val area = CoverageArea(
            name = name.trim().ifEmpty { level.label }, level = level.ordinal, parentId = parentId,
            polygon = ShapeText.encode(polygon), morePieces = ShapeText.encodeRings(more),
            south = b.south, west = b.west, north = b.north, east = b.east,
            createdAt = System.currentTimeMillis(),
        )
        val created = area.copy(id = dao.insertArea(area))
        refreshMembership(created)
        return created
    }

    // ---- areas from the server ----

    /**
     * Brings one of the server's areas in (or up to date). The phone keeps its own Long
     * ids, so screens and routes don't change; [CoverageArea.serverId] links the two.
     * [pieces] is null when the outline didn't come with the metadata (an incremental
     * sync): the existing outline stays until the caller fetches the new one.
     * Returns the local area, and whether its outline changed.
     */
    suspend fun upsertServerArea(
        serverId: String, name: String, level: AreaLevel, color: String?, version: Int, builtVersion: Int,
        segmentCount: Int, teamIds: List<String>, pieces: List<List<LatLngPoint>>?, parentServerId: String?,
    ): Pair<CoverageArea, Boolean> {
        val all = dao.getAreas()
        val mine = all.firstOrNull { it.serverId == serverId }
        val parentId = parentServerId?.let { p -> all.firstOrNull { it.serverId == p }?.id }
        val outline = pieces?.takeIf { it.isNotEmpty() }
        val b = outline?.let { Bounds.of(it.flatten()) }
        if (mine == null) {
            if (outline == null || b == null) throw IllegalStateException("New area $name came without an outline")
            val area = CoverageArea(
                name = name, level = level.ordinal, parentId = parentId,
                polygon = ShapeText.encode(outline.first()), morePieces = ShapeText.encodeRings(outline.drop(1)),
                south = b.south, west = b.west, north = b.north, east = b.east,
                createdAt = System.currentTimeMillis(),
                serverId = serverId, version = version, builtVersion = builtVersion, segmentCount = segmentCount,
                teamIds = teamIds.joinToString(","), color = color,
            )
            return area.copy(id = dao.insertArea(area)) to true
        }
        val newOutline = outline != null && (ShapeText.encode(outline.first()) != mine.polygon || ShapeText.encodeRings(outline.drop(1)) != mine.morePieces)
        val updated = mine.copy(
            name = name, level = level.ordinal, parentId = parentId ?: mine.parentId, color = color,
            version = if (outline != null) version else mine.version, builtVersion = builtVersion, segmentCount = segmentCount,
            teamIds = teamIds.joinToString(","),
        ).let { a ->
            if (!newOutline || b == null) a
            else a.copy(polygon = ShapeText.encode(outline!!.first()), morePieces = ShapeText.encodeRings(outline.drop(1)),
                south = b.south, west = b.west, north = b.north, east = b.east)
        }
        if (updated != mine) dao.updateArea(updated)
        return updated to newOutline
    }

    /** Areas none of your teams track any more leave the phone. Returns how many. */
    suspend fun removeServerAreasExcept(serverIds: Set<String>): Int {
        val gone = dao.getAreas().filter { it.serverId == null || it.serverId !in serverIds }
        gone.forEach { deleteArea(it.id) }
        return gone.size
    }

    suspend fun deleteArea(id: Long) = db.withTransaction {
        dao.orphanChildren(id)
        dao.clearMembership(id)
        dao.deleteArea(id)
    }

    /** Point-in-polygon test of every loaded street centroid inside the area's box. */
    suspend fun refreshMembership(area: CoverageArea) {
        val b = area.bounds
        val pieces = area.pieces
        val inside = dao.getCentroidsIn(b.south, b.west, b.north, b.east)
            .filter { c -> LatLngPoint(c.cLat, c.cLng).let { p -> pieces.any { Polygon.contains(it, p) } } }
            .map { AreaWay(area.id, it.id) }
        db.withTransaction {
            dao.clearMembership(area.id)
            if (inside.isNotEmpty()) dao.insertMembership(inside)
        }
        statsChanged(listOf(area.id))
    }

    /**
     * A cell's streets arrived: each area over it gains the ones inside it. Only the new
     * streets are tested — re-testing every street a metro already has, against a county
     * outline of thousands of corners, for each cell loaded during a drive, would be most of
     * the phone's time.
     */
    private suspend fun addMembershipFor(streets: List<ServerSegment>, b: Bounds) {
        val areas = dao.getAreasIntersecting(b.south, b.west, b.north, b.east)
        if (areas.isEmpty() || streets.isEmpty()) return
        val centres = streets.mapNotNull { s -> Bounds.of(s.shape)?.center?.let { s.id to it } }
        val rows = ArrayList<AreaWay>()
        for (area in areas) {
            val pieces = area.pieces
            val box = area.bounds
            for ((id, c) in centres) {
                if (box.contains(c) && pieces.any { Polygon.contains(it, c) }) rows += AreaWay(area.id, id)
            }
        }
        if (rows.isNotEmpty()) dao.insertMembership(rows)
        statsChanged(areas.map { it.id })
    }

    // ---- exclusions ----

    /** Marks streets as not counting toward coverage. */
    suspend fun exclude(wayIds: List<Long>, reason: ExclusionReason, note: String? = null) {
        if (wayIds.isEmpty()) return
        val now = System.currentTimeMillis()
        dao.insertExclusions(wayIds.distinct().map {
            StreetExclusion(it, reason.name, note, now, active = true, updatedAt = now, sent = false)
        })
        statsChangedForWays(wayIds)
    }

    suspend fun include(wayIds: List<Long>) {
        if (wayIds.isEmpty()) return
        val now = System.currentTimeMillis()
        wayIds.distinct().chunked(500).forEach { dao.removeExclusions(it, now) }
        statsChangedForWays(wayIds)
    }

    suspend fun unsentExclusions(): List<StreetExclusion> = dao.unsentExclusions()

    suspend fun markExclusionSent(row: StreetExclusion) = dao.markExclusionSent(row.wayId, row.updatedAt)

    /** Takes the server's exclusions, newer edit winning, as [applyCompletions] does for marks. */
    suspend fun applyExclusions(incoming: List<StreetExclusion>): Int = db.withTransaction {
        if (incoming.isEmpty()) return@withTransaction 0
        val mine = incoming.map { it.wayId }.chunked(500)
            .flatMap { dao.getExclusions(it) }.associateBy { it.wayId }
        val newer = incoming.filter { theirs ->
            val local = mine[theirs.wayId]
            local == null || theirs.updatedAt > local.updatedAt
        }.map { it.copy(sent = true) }
        dao.insertExclusions(newer)
        newer.count { it.active != (mine[it.wayId]?.active ?: false) }
    }

    suspend fun exclusionOf(wayId: Long): StreetExclusion? = dao.getExclusion(wayId)

    /**
     * Marks streets finished (or not) by hand. They count as fully driven from then on, on
     * this phone at once and everywhere else after the next sync.
     */
    suspend fun setCompleted(wayIds: List<Long>, marked: Boolean) {
        if (wayIds.isEmpty()) return
        val now = System.currentTimeMillis()
        dao.upsertCompletions(wayIds.distinct().map { StreetCompletion(it, marked, now, sent = false) })
        statsChangedForWays(wayIds)
    }

    suspend fun unsentCompletions(): List<StreetCompletion> = dao.unsentCompletions()

    suspend fun markCompletionSent(row: StreetCompletion) = dao.markCompletionSent(row.wayId, row.updatedAt)

    /**
     * Takes the server's marks. Whichever edit is newer wins, so a street unmarked here after
     * someone marked it on the web stays unmarked. Returns how many rows changed.
     */
    suspend fun applyCompletions(incoming: List<StreetCompletion>): Int = db.withTransaction {
        if (incoming.isEmpty()) return@withTransaction 0
        val mine = incoming.map { it.wayId }.chunked(500)
            .flatMap { dao.getCompletions(it) }.associateBy { it.wayId }
        val newer = incoming.filter { theirs ->
            val local = mine[theirs.wayId]
            local == null || theirs.updatedAt > local.updatedAt
        }.map { it.copy(sent = true) }
        dao.upsertCompletions(newer)
        newer.count { it.marked != (mine[it.wayId]?.marked ?: false) }
    }

    fun observeExclusionCount(): Flow<Int> = dao.observeExclusionCount()

    /** Street ids whose midpoint falls inside [polygon] — the gated-community selection. */
    suspend fun wayIdsInPolygon(polygon: List<LatLngPoint>): List<Long> {
        if (polygon.size < 3) return emptyList()
        val b = Bounds.of(polygon)!!
        return dao.getCentroidsIn(b.south, b.west, b.north, b.east)
            .filter { Polygon.contains(polygon, LatLngPoint(it.cLat, it.cLng)) }
            .map { it.id }
    }

    /** How many streets (not pieces of street) these are. */
    suspend fun streetCount(ids: List<Long>): Int =
        ids.chunked(WAY_LOOKUP_CHUNK).flatMapTo(HashSet()) { dao.streetKeys(it) }.size

    /** Excludes everything inside a drawn shape. Returns how many streets were affected. */
    suspend fun excludeInPolygon(polygon: List<LatLngPoint>, reason: ExclusionReason, note: String? = null): Int {
        val ids = wayIdsInPolygon(polygon)
        exclude(ids, reason, note)
        return streetCount(ids)
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

    suspend fun freshChunkKeys(keys: List<String>, freshAfter: Long): List<String> =
        keys.chunked(WAY_LOOKUP_CHUNK).flatMap { dao.freshChunkKeys(it, freshAfter) }

    suspend fun freshChunkCount(keys: List<String>, freshAfter: Long): Int =
        keys.chunked(WAY_LOOKUP_CHUNK).sumOf { dao.freshChunkKeys(it, freshAfter).size }

    /** Marks an area as loading its streets as needed, with how many of its cells are here. */
    suspend fun setOnDemand(id: Long, cells: Int, held: Int) =
        dao.setOnDemand(id, true, cells, held, System.currentTimeMillis())

    suspend fun onDemandAreas(): List<CoverageArea> = dao.onDemandAreas()

    /** After nearby cells arrive: each on-demand area's count of cells held. */
    suspend fun refreshOnDemandCounts(freshAfter: Long) {
        for (a in dao.onDemandAreas()) {
            val keys = a.cells().map { it.key }
            dao.setOnDemand(a.id, true, keys.size, freshChunkCount(keys, freshAfter), a.streetsLoadedAt ?: System.currentTimeMillis())
        }
    }

    private fun wayRows(segments: List<ServerSegment>, now: Long): List<OsmWay> = segments.map { s ->
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
            wayId = s.wayId,
        )
    }

    /**
     * An area's package arrived: its segments, and exactly which ones are in it (the
     * server worked that out from the outline, edge streets included).
     */
    suspend fun storeAreaPackage(areaId: Long, segments: List<ServerSegment>, version: Int) {
        val now = System.currentTimeMillis()
        db.withTransaction {
            segments.chunked(500).forEach { dao.insertWays(wayRows(it, now)) }
            dao.clearMembership(areaId)
            segments.chunked(500).forEach { part -> dao.insertMembership(part.map { AreaWay(areaId, it.id, it.insideMeters) }) }
            dao.getArea(areaId)?.let { a ->
                dao.updateArea(a.copy(packageVersion = version, streetsLoadedAt = now, chunksTotal = 1, chunksDone = 1,
                    lastError = null, onDemand = false))
            }
        }
        statsChanged(listOf(areaId))
    }

    /** One map cell's segments, for areas too big to download whole. */
    suspend fun storeCell(key: String, segments: List<ServerSegment>) {
        val now = System.currentTimeMillis()
        db.withTransaction {
            segments.chunked(500).forEach { dao.insertWays(wayRows(it, now)) }
            dao.upsertChunk(StreetChunk(key = key, loadedAt = now, wayCount = segments.size))
        }
        Bounds.of(segments.flatMap { s -> listOf(s.shape.first(), s.shape.last()) })?.let { addMembershipFor(segments, it) }
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

    companion object {
        const val AREA_STREET_LIMIT = 5_000
        const val SOURCE_SERVER = "server"
        const val SOURCE_PHONE = "phone"
        /** Changes are gathered this long before an area's figures are redone. */
        private const val STATS_SETTLE_MS = 3_000L
        const val GATE_SEARCH_METERS = 3_000.0
        const val GATE_WAY_LIMIT = 6_000
        const val GATE_ON_ROAD_METERS = 60.0
        private const val CANDIDATE_LIMIT = 400
        /** Plenty for a neighbourhood or a small city; a metro would be planned area by area. */
        private const val PLAN_STREET_LIMIT = 6_000
        /** SQLite caps how many values one IN clause can hold. */
        private const val WAY_LOOKUP_CHUNK = 900
        private val SEARCH_RADII_METERS = listOf(1_200.0, 4_000.0, 12_000.0)

        /** The smallest-level area whose outline contains the point, if any. */
        fun deepestContaining(areas: List<AreaWithStats>, p: LatLngPoint): AreaWithStats? =
            areas.filter { it.contains(p) }.minByOrNull { it.area.level }
    }
}
