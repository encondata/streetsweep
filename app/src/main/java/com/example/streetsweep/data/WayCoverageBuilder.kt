package com.example.streetsweep.data

import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.db.DrivenEdge
import com.example.streetsweep.data.db.OsmWay
import com.example.streetsweep.data.db.WayCoverage
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.domain.CoveredLength

/**
 * Keeps [WayCoverage] true to the driven segments: called with the streets whose segments
 * or shape have just changed, it works out each one's driven length again, overlap counted
 * once.
 */
class WayCoverageBuilder(private val db: AppDatabase) {
    private val dao get() = db.coverageDao()

    suspend fun refresh(wayIds: Collection<Long>) {
        if (wayIds.isEmpty()) return
        wayIds.distinct().chunked(CHUNK).forEach { batch ->
            val edges = dao.drivenEdgesOn(batch).groupBy { it.wayId }
            val ways = dao.waysById(batch).associateBy { it.id }
            val rows = batch.mapNotNull { id -> edges[id]?.let { WayCoverage(id, drivenMeters(ways[id], it)) } }
            dao.upsertCoverage(rows)
            val gone = batch.filter { edges[it] == null }
            if (gone.isNotEmpty()) dao.deleteCoverage(gone)
        }
    }

    /** Everything, for a database that has segments but no coverage worked out for them. */
    suspend fun rebuildIfMissing() {
        val driven = dao.allDrivenWayIds()
        if (driven.isNotEmpty() && dao.coverageCount() < driven.size) refresh(driven)
    }

    companion object {
        private const val CHUNK = 400

        /**
         * The street's driven length. Without its shape (streets not downloaded yet) the
         * segments can only be added up, which is what was done before, capped at its length.
         */
        fun drivenMeters(way: OsmWay?, edges: List<DrivenEdge>): Double {
            val shape = way?.let { runCatching { ShapeText.decode(it.shape) }.getOrNull() }
            if (shape == null || shape.size < 2) {
                val sum = edges.sumOf { it.lengthMeters }
                return if (way != null) minOf(sum, way.lengthMeters) else sum
            }
            val segments = edges.mapNotNull { e -> runCatching { ShapeText.decode(e.shape) }.getOrNull() }
            // Never more than the segments add up to, which was the figure before: counting
            // overlap once can only take length away.
            return minOf(CoveredLength.of(shape, segments), edges.sumOf { it.lengthMeters }, way.lengthMeters)
        }
    }
}
