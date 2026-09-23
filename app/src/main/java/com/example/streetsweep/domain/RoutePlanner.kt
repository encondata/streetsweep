package com.example.streetsweep.domain

import java.util.PriorityQueue

/** One street in a plan, turned to face the way you will drive it. */
data class PlannedLeg(
    val wayId: Long,
    val shape: List<LatLngPoint>,
    val lengthMeters: Double,
    /** True when this is a street that still needed driving, false when it is only the way there. */
    val required: Boolean,
)

/**
 * An order to drive a neighbourhood in.
 *
 * [deadheadMeters] is the backtracking: ground covered only to reach the next street that
 * still needs driving. It is what the plan tries to keep small.
 */
data class RoutePlan(
    val legs: List<PlannedLeg>,
    val requiredMeters: Double,
    val deadheadMeters: Double,
    val requiredCount: Int,
    /** Streets the plan could not reach from where you are, usually a disconnected pocket. */
    val unreachable: Int,
    /** True when there was more to plan than [RoutePlanner.DEFAULT_MAX_REQUIRED] allows. */
    val truncated: Boolean,
) {
    val totalMeters: Double get() = requiredMeters + deadheadMeters
    val isEmpty: Boolean get() = legs.isEmpty()

    /** How much of the driving is backtracking, 0..1. Zero would be a perfect round. */
    val deadheadFraction: Double
        get() = if (totalMeters <= 0) 0.0 else deadheadMeters / totalMeters
}

/**
 * Works out an order to drive every street that still needs it, keeping the ground you
 * cover twice as small as it can manage.
 *
 * This is the rural postman problem, which has no efficient exact answer, so this is a
 * heuristic and says so: from where you stand, walk to the nearest street still wanting a
 * drive, drive it, and repeat from the far end. What keeps the backtracking down is that
 * the nearest one is usually a turn off the junction you have just arrived at, so the
 * route chains along the network instead of hopping about it. The result is good, not
 * provably shortest.
 */
object RoutePlanner {

    const val DEFAULT_MAX_REQUIRED = 1_500

    /** Vertices within about a metre of each other are the same junction, as elsewhere. */
    private fun key(p: LatLngPoint): Long {
        val lat = Math.round(p.latitude * 100_000.0)
        val lng = Math.round(p.longitude * 100_000.0)
        return lat * 10_000_000L + lng
    }

    private class Edge(
        val wayId: Long,
        val from: Int,
        val to: Int,
        val shape: List<LatLngPoint>,
        val length: Double,
        var required: Boolean,
    ) {
        var done = false
        fun other(node: Int) = if (node == from) to else from
        /** The shape, read from [node] onwards. */
        fun facing(node: Int) = if (node == from) shape else shape.asReversed()
    }

    /**
     * @param ways every street in the area, driven or not: the driven ones are still roads
     *   you can use to get somewhere.
     * @param requiredIds the streets that actually need driving.
     * @param start where the driver is now.
     */
    fun plan(
        ways: List<GraphWay>,
        requiredIds: Set<Long>,
        start: LatLngPoint,
        maxRequired: Int = DEFAULT_MAX_REQUIRED,
    ): RoutePlan {
        val nodeOf = HashMap<Long, Int>()
        val nodePoint = ArrayList<LatLngPoint>()
        fun node(p: LatLngPoint): Int = nodeOf.getOrPut(key(p)) {
            nodePoint.add(p)
            nodePoint.size - 1
        }

        // OpenStreetMap ways meet at shared vertices, and that vertex is usually partway
        // along one of them rather than at its end: a side street joins a through road in
        // the middle. Joining only first-to-last would leave nearly every street its own
        // island, so each way is cut at the vertices it shares with another.
        val timesSeen = HashMap<Long, Int>()
        for (w in ways) {
            val onceEach = HashSet<Long>()
            for (pt in w.shape) {
                val k = key(pt)
                if (onceEach.add(k)) timesSeen[k] = (timesSeen[k] ?: 0) + 1
            }
        }

        val edges = ArrayList<Edge>()
        for (w in ways) {
            if (w.shape.size < 2) continue
            val required = w.id in requiredIds
            var cut = 0
            for (i in 1 until w.shape.size) {
                val atEnd = i == w.shape.size - 1
                if (!atEnd && (timesSeen[key(w.shape[i])] ?: 0) < 2) continue
                val piece = w.shape.subList(cut, i + 1)
                cut = i
                if (piece.size < 2) continue
                val length = Geo.pathLengthMeters(piece)
                if (length <= 0.0) continue
                edges.add(
                    Edge(
                        wayId = w.id,
                        from = node(piece.first()),
                        to = node(piece.last()),
                        shape = piece.toList(),
                        length = length,
                        required = required,
                    )
                )
            }
        }
        if (edges.isEmpty()) {
            return RoutePlan(emptyList(), 0.0, 0.0, 0, requiredIds.size, false)
        }

        val adjacency = Array(nodePoint.size) { ArrayList<Int>() }
        for ((i, e) in edges.withIndex()) {
            adjacency[e.from].add(i)
            if (e.to != e.from) adjacency[e.to].add(i)
        }

        // More to do than we will plan for: keep the streets nearest the driver, which are
        // the ones the early part of the route would have used anyway.
        var truncated = false
        var wantedWays = edges.filter { it.required }.map { it.wayId }.toMutableSet()
        var dropped = 0
        if (wantedWays.size > maxRequired) {
            truncated = true
            val nearestFirst = wantedWays
                .sortedBy { id ->
                    edges.filter { it.wayId == id }.minOf { Geo.distanceToPolylineMeters(start, it.shape) }
                }
            val keep = nearestFirst.take(maxRequired).toSet()
            dropped = wantedWays.size - keep.size
            edges.forEach { if (it.required && it.wayId !in keep) it.required = false }
            wantedWays = keep.toMutableSet()
        }
        val wantedSegments = edges.count { it.required }

        var current = nearestNode(nodePoint, start)
        val legs = ArrayList<PlannedLeg>()
        val drivenWays = HashSet<Long>()
        var requiredMeters = 0.0
        var deadheadMeters = 0.0
        var driven = 0

        while (driven < wantedSegments) {
            val reached = walkToNextRequired(edges, adjacency, nodePoint.size, current) ?: break
            // Everything on the way there, then the street we came for.
            for (step in reached.path) {
                val e = edges[step.edge]
                val wasRequired = e.required && !e.done
                e.done = true
                if (wasRequired) {
                    driven++
                    drivenWays.add(e.wayId)
                    requiredMeters += e.length
                } else {
                    deadheadMeters += e.length
                }
                legs.add(PlannedLeg(e.wayId, e.facing(step.from), e.length, wasRequired))
            }
            current = reached.endNode
        }

        // A street counts as planned once every piece of it is in the route.
        val unreachable = wantedWays.size - drivenWays.size + dropped
        return RoutePlan(legs, requiredMeters, deadheadMeters, drivenWays.size, unreachable, truncated)
    }

    private fun nearestNode(points: List<LatLngPoint>, to: LatLngPoint): Int {
        var best = 0
        var bestD = Double.MAX_VALUE
        for (i in points.indices) {
            val d = Geo.distanceMeters(to, points[i])
            if (d < bestD) { bestD = d; best = i }
        }
        return best
    }

    private class Step(val edge: Int, val from: Int)
    private class Reached(val path: List<Step>, val endNode: Int)

    /**
     * Cheapest way from [from] to the far side of some street still needing a drive,
     * stopping the moment one is settled rather than exploring the whole area.
     */
    private fun walkToNextRequired(
        edges: List<Edge>,
        adjacency: Array<ArrayList<Int>>,
        nodeCount: Int,
        from: Int,
    ): Reached? {
        val dist = DoubleArray(nodeCount) { Double.MAX_VALUE }
        val viaEdge = IntArray(nodeCount) { -1 }
        val viaNode = IntArray(nodeCount) { -1 }
        dist[from] = 0.0
        val queue = PriorityQueue<IntArray>(compareBy { dist[it[0]] })
        queue.add(intArrayOf(from))
        val settled = BooleanArray(nodeCount)

        while (queue.isNotEmpty()) {
            val node = queue.poll()!![0]
            if (settled[node]) continue
            settled[node] = true

            // Taking a street that still needs driving is the point of the walk, so the
            // moment one leaves this node, stop and take it. Where several leave the same
            // junction, take the one that strands you soonest -- a spur with nothing
            // beyond it has to be driven out and back whenever it is done, so doing it
            // while standing at its mouth is free, whereas leaving it means coming back.
            var chosen = -1
            var chosenOnward = Int.MAX_VALUE
            for (i in adjacency[node]) {
                val e = edges[i]
                if (!e.required || e.done) continue
                val far = e.other(node)
                var onward = 0
                for (j in adjacency[far]) {
                    if (j == i) continue
                    val n = edges[j]
                    if (n.required && !n.done) onward++
                }
                if (onward < chosenOnward) {
                    chosenOnward = onward
                    chosen = i
                }
            }
            if (chosen >= 0) {
                val e = edges[chosen]
                val path = ArrayList<Step>()
                var at = node
                while (at != from) {
                    path.add(Step(viaEdge[at], viaNode[at]))
                    at = viaNode[at]
                }
                path.reverse()
                path.add(Step(chosen, node))
                return Reached(path, e.other(node))
            }

            for (i in adjacency[node]) {
                val e = edges[i]
                val next = e.other(node)
                if (settled[next]) continue
                val d = dist[node] + e.length
                if (d < dist[next]) {
                    dist[next] = d
                    viaEdge[next] = i
                    viaNode[next] = node
                    queue.add(intArrayOf(next))
                }
            }
        }
        return null
    }
}
