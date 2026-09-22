package com.example.streetsweep.domain

/** A street as the connectivity graph sees it. */
data class GraphWay(val id: Long, val shape: List<LatLngPoint>, val lengthMeters: Double)

/**
 * Connectivity over OpenStreetMap ways, used to work out what lies beyond a gate.
 *
 * Ways are joined wherever they share a vertex, which is how OSM models junctions: a side
 * street's end point is literally the same node as a point along the road it meets.
 */
object RoadGraph {

    /**
     * What sits behind a gate.
     *
     * [reachedCap] means the walk kept finding more road than a gated place plausibly has,
     * so the caller should assume the road is public and change nothing.
     */
    data class GateResult(
        val wayIds: List<Long>,
        val totalMeters: Double,
        val reachedCap: Boolean,
    ) {
        val isEmpty: Boolean get() = wayIds.isEmpty()
    }

    /** Vertices within about a metre of each other are the same junction. */
    private fun key(p: LatLngPoint): Long {
        val lat = Math.round(p.latitude * 100_000.0)
        val lng = Math.round(p.longitude * 100_000.0)
        return lat * 10_000_000L + lng
    }

    /**
     * Every way reachable from [gatePoint] heading [headingDegrees] along [startWayId],
     * without passing back through the gate.
     *
     * @param maxWays give up beyond this many streets — the road is evidently not gated.
     * @param maxMeters likewise for total length.
     */
    fun beyondGate(
        ways: List<GraphWay>,
        startWayId: Long,
        gatePoint: LatLngPoint,
        headingDegrees: Double,
        maxWays: Int = DEFAULT_MAX_WAYS,
        maxMeters: Double = DEFAULT_MAX_METERS,
    ): GateResult {
        val startIndex = ways.indexOfFirst { it.id == startWayId }
        if (startIndex < 0) return GateResult(emptyList(), 0.0, false)
        val start = ways[startIndex]
        if (start.shape.size < 2) return GateResult(emptyList(), 0.0, false)

        // The gate splits the street part-way along a segment, not at a vertex: snapping to the
        // nearest vertex would put the junction we came from on the forward side and let the
        // walk leak straight back out onto the public road.
        val segment = (0 until start.shape.size - 1)
            .minBy { Geo.distanceToSegmentMeters(gatePoint, start.shape[it], start.shape[it + 1]) }
        // Which end of that segment we are pointing at decides which side is "beyond".
        val segmentBearing = Geo.bearingDegrees(start.shape[segment], start.shape[segment + 1])
        val towardLast = Geo.angularDifference(headingDegrees, segmentBearing) <= 90.0

        val forward = if (towardLast) start.shape.subList(segment + 1, start.shape.size) else start.shape.subList(0, segment + 1)
        val behindUs = if (towardLast) start.shape.subList(0, segment + 1) else start.shape.subList(segment + 1, start.shape.size)

        val forwardKeys = forward.map { key(it) }.toSet()
        // The way we came in by is a wall: the walk must not slip back out through it.
        val blocked = behindUs.map { key(it) }.toSet() - forwardKeys
        if (forwardKeys.isEmpty()) return GateResult(emptyList(), 0.0, false)

        val vertexToWays = HashMap<Long, MutableList<Int>>()
        ways.forEachIndexed { i, w -> w.shape.forEach { v -> vertexToWays.getOrPut(key(v)) { ArrayList(2) } += i } }

        val visitedWays = LinkedHashSet<Int>()
        visitedWays += startIndex
        var total = start.lengthMeters

        val seenVertices = HashSet<Long>(forwardKeys)
        val queue = ArrayDeque(forwardKeys)
        while (queue.isNotEmpty()) {
            val v = queue.removeFirst()
            for (wi in vertexToWays[v].orEmpty()) {
                if (!visitedWays.add(wi)) continue
                val w = ways[wi]
                total += w.lengthMeters
                if (visitedWays.size > maxWays || total > maxMeters) {
                    return GateResult(emptyList(), total, reachedCap = true)
                }
                for (p in w.shape) {
                    val u = key(p)
                    if (u in blocked || !seenVertices.add(u)) continue
                    queue += u
                }
            }
        }
        return GateResult(visitedWays.map { ways[it].id }, total, reachedCap = false)
    }

    /** Which way a road leaves the spot you are parked at, relative to the way you face. */
    enum class Side(val label: String) { LEFT("Left"), AHEAD("Ahead"), RIGHT("Right") }

    /** One road leaving your position, in one direction. */
    data class Branch(
        val wayId: Long,
        val side: Side,
        /** Where you would join that road. */
        val gatePoint: LatLngPoint,
        /** Which way you would be travelling along it. */
        val bearingDegrees: Double,
        val relativeDegrees: Double,
        /** The first stretch of it, for highlighting on the map. */
        val preview: List<LatLngPoint>,
    )

    /**
     * The roads leaving [from], one per side, so the driver can say which one the gate is on.
     *
     * Every nearby way contributes up to two directions. The one pointing back the way you
     * came is dropped, and for each side only the best-aligned road is offered.
     */
    fun branchesAt(
        ways: List<GraphWay>,
        from: LatLngPoint,
        headingDegrees: Double,
        radiusMeters: Double = BRANCH_RADIUS_METERS,
        previewMeters: Double = BRANCH_PREVIEW_METERS,
    ): List<Branch> {
        val candidates = ArrayList<Branch>()
        for (way in ways) {
            if (way.shape.size < 2) continue
            if (Geo.distanceToPolylineMeters(from, way.shape) > radiusMeters) continue
            val gatePoint = Geo.closestPointOnPolyline(from, way.shape) ?: continue
            val segment = (0 until way.shape.size - 1)
                .minBy { Geo.distanceToSegmentMeters(gatePoint, way.shape[it], way.shape[it + 1]) }
            for (towardLast in listOf(true, false)) {
                val ahead = if (towardLast) {
                    (segment + 1 until way.shape.size).map { way.shape[it] }
                } else {
                    (segment downTo 0).map { way.shape[it] }
                }
                // A vertex right on top of us gives no usable direction.
                val first = ahead.firstOrNull { Geo.distanceMeters(gatePoint, it) > 2.0 } ?: continue
                val bearing = Geo.bearingDegrees(gatePoint, first)
                val relative = Geo.relativeBearing(headingDegrees, bearing)
                val side = when {
                    Math.abs(relative) <= 45.0 -> Side.AHEAD
                    relative < -45.0 && relative >= -135.0 -> Side.LEFT
                    relative > 45.0 && relative <= 135.0 -> Side.RIGHT
                    else -> continue // behind us: that is how we arrived
                }
                val preview = ArrayList<LatLngPoint>()
                preview += gatePoint
                var run = 0.0
                for (p in ahead) {
                    run += Geo.distanceMeters(preview.last(), p)
                    preview += p
                    if (run >= previewMeters) break
                }
                candidates += Branch(way.id, side, gatePoint, bearing, relative, preview)
            }
        }
        val centre = mapOf(Side.LEFT to -90.0, Side.AHEAD to 0.0, Side.RIGHT to 90.0)
        return Side.entries.mapNotNull { side ->
            candidates.filter { it.side == side }.minByOrNull { Math.abs(it.relativeDegrees - centre.getValue(side)) }
        }
    }

    const val BRANCH_RADIUS_METERS = 45.0
    const val WIDE_BRANCH_RADIUS_METERS = 100.0
    const val BRANCH_PREVIEW_METERS = 90.0
    const val DEFAULT_MAX_WAYS = 300
    const val DEFAULT_MAX_METERS = 30_000.0
}
