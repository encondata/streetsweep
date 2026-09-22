package com.example.streetsweep.data.osm

import android.util.Log
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.TrackRepository
import com.example.streetsweep.domain.LatLngPoint
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Matches a session's raw GPS points to OpenStreetMap roads, incrementally.
 *
 * Each session keeps a watermark of how many raw points have been matched. New points are sent
 * with a few already-matched points prepended so the geometry joins up; edges are de-duplicated
 * by [CoverageRepository.edgeKey], so the overlap costs nothing. Batches are capped so a long
 * drive is several modest requests to the public server.
 */
class RoadMatcher(
    private val client: RoadMatchClient,
    private val tracks: TrackRepository,
    private val coverage: CoverageRepository,
) {
    sealed interface Result {
        data class Matched(val newEdges: Int, val newMeters: Double, val shapePoints: Int) : Result
        data object NothingNew : Result
        data object NotEnoughPoints : Result
        data class Failed(val message: String) : Result
    }

    private val mutex = Mutex()

    suspend fun matchSession(sessionId: Long): Result = mutex.withLock {
        val session = tracks.getSession(sessionId) ?: return Result.Failed("Session not found")
        val raw = tracks.getPoints(sessionId)
        val watermark = session.snappedRawCount.coerceIn(0, raw.size)
        if (raw.size <= watermark) return Result.NothingNew
        if (raw.size < 2) return Result.NotEnoughPoints

        val overlap = minOf(OVERLAP_POINTS, watermark)
        val input = raw.subList(watermark - overlap, raw.size).map { LatLngPoint(it.latitude, it.longitude) }
        return try {
            var newEdges = 0
            var newMeters = 0.0
            val shape = ArrayList<LatLngPoint>()
            var start = 0
            var first = true
            while (start < input.size) {
                val end = minOf(start + BATCH_SIZE, input.size)
                val batch = input.subList(start, end)
                if (batch.size >= 2) {
                    val result = client.match(batch)
                    val rec = coverage.recordDrivenEdges(result.edges, sessionId)
                    newEdges += rec.segments
                    newMeters += rec.meters
                    val skip = if (first) overlap else BATCH_OVERLAP
                    shape += newShapeAfter(result, skip)
                }
                if (end >= input.size) break
                start = end - BATCH_OVERLAP
                first = false
            }
            tracks.appendSnappedPoints(sessionId, shape, newWatermark = raw.size)
            if (newEdges > 0) tracks.addCoverageStats(sessionId, newEdges, newMeters)
            Result.Matched(newEdges, newMeters, shape.size)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Road matching failed for session $sessionId", e)
            Result.Failed(e.message ?: "Road matching failed")
        }
    }

    companion object {
        private const val TAG = "RoadMatcher"
        const val BATCH_SIZE = 100
        const val BATCH_OVERLAP = 5
        const val OVERLAP_POINTS = 5

        /**
         * The part of the matched shape that belongs to input points at index >= [skipInputs]:
         * from the start of the edge the first such (matched) input landed on.
         */
        fun newShapeAfter(result: MatchResult, skipInputs: Int): List<LatLngPoint> {
            if (skipInputs <= 0 || result.edges.isEmpty()) return result.shape
            val edgeIndex = result.matchedEdgeIndex.drop(skipInputs).firstNotNullOfOrNull { it } ?: return emptyList()
            val edge = result.edges.getOrNull(edgeIndex) ?: return emptyList()
            val firstPoint = edge.shape.firstOrNull() ?: return emptyList()
            val at = result.shape.indexOf(firstPoint)
            return if (at < 0) result.shape else result.shape.subList(at, result.shape.size)
        }
    }
}
