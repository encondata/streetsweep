package net.streetsweep.data.server

import net.streetsweep.data.CoverageRepository
import net.streetsweep.data.TrackRepository
import net.streetsweep.data.db.AppDatabase
import net.streetsweep.data.db.ProvisionalEntity
import net.streetsweep.data.osm.ShapeText
import net.streetsweep.domain.Bounds
import net.streetsweep.domain.Geo
import net.streetsweep.domain.LatLngPoint
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The phone's own quick guess at which streets a drive covered, so they turn green while
 * you drive, signal or not. The server matches the drive properly (Valhalla) once it's
 * uploaded, and its answer replaces this.
 *
 * Purely geometric, on the segments already on the phone: a segment counts when most of
 * it lies close to the track. Cheap enough to run every few fixes, and good enough for a
 * preview; it errs towards not crediting a street rather than crediting a parallel one.
 */
class ProvisionalMatcher(
    private val db: AppDatabase,
    private val track: TrackRepository,
    private val coverage: CoverageRepository,
) {
    private val mutex = Mutex()

    /** Credits whatever the newest fixes of a drive have covered. Safe to call often. */
    suspend fun update(sessionId: Long) = mutex.withLock {
        val session = track.getSession(sessionId) ?: return@withLock
        val points = track.getPoints(sessionId)
        if (points.size < 2) return@withLock
        // snappedRawCount is how far through the drive this has got (v1 used it for
        // Valhalla's progress). Look back a few fixes, so a street straddling two runs
        // is still seen whole.
        val from = (session.snappedRawCount - OVERLAP).coerceAtLeast(0)
        val line = points.subList(from, points.size).map { LatLngPoint(it.latitude, it.longitude) }
        val found = segmentsAlong(line)
        if (found.isNotEmpty()) {
            val at = points.last().timestamp
            db.serverDao().insertProvisional(found.map { ProvisionalEntity(sessionId, it, at) })
            db.serverDao().projectProvisional()
            db.serverDao().projectWayCoverage()
            coverage.statsChangedForWays(found)
        }
        track.setMatchedThrough(sessionId, points.size)
    }

    /** The segments that lie mostly within [NEAR_METERS] of the line. */
    private suspend fun segmentsAlong(line: List<LatLngPoint>): List<Long> {
        val box = Bounds.of(line) ?: return emptyList()
        val pad = NEAR_METERS / 111_000.0
        val candidates = db.coverageDao().getWaysInBox(box.south - pad, box.west - pad, box.north + pad, box.east + pad, CANDIDATE_LIMIT)
        return candidates.filter { w ->
            val shape = ShapeText.decode(w.shape)
            val samples = sample(shape)
            samples.isNotEmpty() && samples.count { Geo.distanceToPolylineMeters(it, line) <= NEAR_METERS } >= samples.size * MIN_SHARE
        }.map { it.id }
    }

    /** Points every [STEP_METERS] along a shape, ends included. */
    private fun sample(shape: List<LatLngPoint>): List<LatLngPoint> {
        if (shape.size < 2) return emptyList()
        val out = ArrayList<LatLngPoint>()
        var next = 0.0 // distance along the shape of the next sample
        var walked = 0.0 // distance along the shape to the start of the current piece
        for (i in 1 until shape.size) {
            val a = shape[i - 1]
            val b = shape[i]
            val len = Geo.distanceMeters(a, b)
            while (len > 0 && next <= walked + len) {
                val t = (next - walked) / len
                out += LatLngPoint(a.latitude + (b.latitude - a.latitude) * t, a.longitude + (b.longitude - a.longitude) * t)
                next += STEP_METERS
            }
            walked += len
        }
        out += shape.last()
        return out
    }

    companion object {
        /** GPS on a phone in a car is good to about this, most of the time. */
        const val NEAR_METERS = 18.0
        /** How much of a segment has to be near the track: the server's own rule is half. */
        const val MIN_SHARE = 0.6
        private const val STEP_METERS = 10.0
        private const val OVERLAP = 5
        private const val CANDIDATE_LIMIT = 3_000
    }
}
