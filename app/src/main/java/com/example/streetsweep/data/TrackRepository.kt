package com.example.streetsweep.data

import androidx.room.withTransaction
import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.db.Poi
import com.example.streetsweep.data.db.SessionTotalsRow
import com.example.streetsweep.data.db.WeeklyDrivingRow
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.data.db.SnappedPoint
import com.example.streetsweep.data.db.TrackPoint
import com.example.streetsweep.data.db.TrackSession
import com.example.streetsweep.domain.LatLngPoint
import com.example.streetsweep.domain.TriggerSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine

/** One drawable track: road-snapped geometry when the session has it, raw GPS otherwise. */
data class TrackPolyline(val sessionId: Long, val points: List<LatLngPoint>, val snapped: Boolean, val isOpen: Boolean)

class TrackRepository(private val db: AppDatabase) {
    private val dao get() = db.trackDao()

    fun observeSessions(): Flow<List<TrackSession>> = dao.observeSessions()
    fun observeSession(id: Long): Flow<TrackSession?> = dao.observeSession(id)
    fun observePoints(sessionId: Long): Flow<List<TrackPoint>> = dao.observePoints(sessionId)
    fun observeAllPoints(): Flow<List<TrackPoint>> = dao.observeAllPoints()
    fun observeSnappedPoints(sessionId: Long): Flow<List<SnappedPoint>> = dao.observeSnappedPoints(sessionId)
    fun observeAllSnappedPoints(): Flow<List<SnappedPoint>> = dao.observeAllSnappedPoints()

    /** Every session with at least two points, as a single polyline each. Emits on any change. */
    fun observeCoverage(): Flow<List<TrackPolyline>> = combine(
        dao.observeSessions(),
        dao.observeAllSnappedPoints(),
        dao.observeAllPoints(),
    ) { sessions, snapped, raw ->
        val snappedBySession = snapped.groupBy { it.sessionId }
        val rawBySession = raw.groupBy { it.sessionId }
        sessions.mapNotNull { s ->
            val sp = snappedBySession[s.id]?.map { LatLngPoint(it.latitude, it.longitude) }
            val line = if (sp != null && sp.size >= 2) {
                TrackPolyline(s.id, sp, snapped = true, isOpen = s.isOpen)
            } else {
                val rp = rawBySession[s.id]?.map { LatLngPoint(it.latitude, it.longitude) }.orEmpty()
                if (rp.size >= 2) TrackPolyline(s.id, rp, snapped = false, isOpen = s.isOpen) else null
            }
            line
        }
    }

    fun observeTotals(): Flow<SessionTotalsRow> = dao.observeTotals()

    // ---- points of interest ----
    private val pois get() = db.poiDao()

    suspend fun addPoi(latitude: Double, longitude: Double, accuracyMeters: Float, sessionId: Long?, note: String? = null): Poi {
        val poi = Poi(latitude = latitude, longitude = longitude, accuracyMeters = accuracyMeters, timestamp = System.currentTimeMillis(), note = note, sessionId = sessionId)
        return poi.copy(id = pois.insert(poi))
    }

    fun observePois(): Flow<List<Poi>> = pois.observeAll()
    fun observePoisInView(b: Bounds, limit: Int = 500): Flow<List<Poi>> = pois.observeInView(b.south, b.west, b.north, b.east, limit)
    suspend fun getPoi(id: Long): Poi? = pois.get(id)
    suspend fun setPoiNote(id: Long, note: String?) =
        pois.setNote(id, note?.trim()?.takeIf { it.isNotEmpty() }, System.currentTimeMillis())

    suspend fun setPoiDetails(id: Long, name: String?, note: String?) = pois.setDetails(
        id,
        name?.trim()?.takeIf { it.isNotEmpty() },
        note?.trim()?.takeIf { it.isNotEmpty() },
        System.currentTimeMillis(),
    )

    suspend fun setPoiPhoto(id: Long, path: String?) =
        pois.setPhoto(id, path, System.currentTimeMillis())

    suspend fun poisWithUnsentPhotos(): List<Poi> = pois.withUnsentPhotos()

    suspend fun markPoiPhotoSent(id: Long) = pois.markPhotoSynced(id, System.currentTimeMillis())
    suspend fun deletePoi(id: Long) = pois.delete(id)

    suspend fun addCoverageStats(sessionId: Long, segments: Int, meters: Double) =
        dao.addCoverageStats(sessionId, segments, meters)

    suspend fun getSession(id: Long): TrackSession? = dao.getSession(id)
    suspend fun getOpenSession(): TrackSession? = dao.getOpenSession()
    suspend fun getPoints(sessionId: Long): List<TrackPoint> = dao.getPoints(sessionId)
    suspend fun getAllSessions(): List<TrackSession> = dao.getAllSessions()
    suspend fun getUnmatchedSessions(): List<TrackSession> = dao.getUnmatchedSessions()
    /** Adds a stretch of standing still to a drive, so it is not counted as driving. */
    suspend fun addPausedMs(sessionId: Long, millis: Long) {
        if (millis > 0) dao.addPausedMs(sessionId, millis)
    }

    suspend fun getAllPois(): List<Poi> = pois.getAll()
    fun observeWeeklyDriving(): Flow<List<WeeklyDrivingRow>> = dao.observeWeeklyDriving()

    suspend fun startSession(trigger: TriggerSource, startedAt: Long = System.currentTimeMillis()): TrackSession {
        val session = TrackSession(startedAt = startedAt, trigger = trigger.name)
        val id = dao.insertSession(session)
        return session.copy(id = id)
    }

    /** Appends a stored point and rolls the session totals forward in one transaction. */
    suspend fun addPoint(
        sessionId: Long,
        latitude: Double,
        longitude: Double,
        accuracyMeters: Float,
        speedMps: Float,
        bearing: Float,
        timestamp: Long,
        addedDistanceMeters: Double,
    ) = db.withTransaction {
        dao.insertPoint(
            TrackPoint(
                sessionId = sessionId,
                latitude = latitude,
                longitude = longitude,
                accuracyMeters = accuracyMeters,
                speedMps = speedMps,
                bearing = bearing,
                timestamp = timestamp,
            ),
        )
        dao.getSession(sessionId)?.let { s ->
            dao.updateSession(
                s.copy(
                    pointCount = s.pointCount + 1,
                    distanceMeters = s.distanceMeters + addedDistanceMeters,
                ),
            )
        }
    }

    suspend fun endSession(sessionId: Long, endedAt: Long = System.currentTimeMillis()) {
        dao.getSession(sessionId)?.let { s ->
            if (s.endedAt == null) dao.updateSession(s.copy(endedAt = endedAt))
        }
    }

    /** Closes any session left open by a killed process. Returns the number closed. */
    suspend fun closeOrphanedSessions(): Int {
        var closed = 0
        while (true) {
            val open = dao.getOpenSession() ?: break
            dao.updateSession(open.copy(endedAt = System.currentTimeMillis()))
            closed++
        }
        return closed
    }

    suspend fun deleteSession(sessionId: Long) = db.withTransaction {
        // The streets it drove are measured again once its segments are gone.
        val touched = db.coverageDao().wayIdsDrivenIn(sessionId)
        db.coverageDao().deleteDrivenEdgesForSession(sessionId)
        dao.deleteSession(sessionId)
        com.example.streetsweep.data.WayCoverageBuilder(db).refresh(touched)
    }

    /** Appends road-matched geometry and advances the session's matched watermark atomically. */
    suspend fun appendSnappedPoints(sessionId: Long, points: List<LatLngPoint>, newWatermark: Int) =
        db.withTransaction {
            var seq = dao.maxSnappedSequence(sessionId) + 1
            if (points.isNotEmpty()) {
                dao.insertSnappedPoints(
                    points.map { p ->
                        SnappedPoint(
                            sessionId = sessionId,
                            sequence = seq++,
                            latitude = p.latitude,
                            longitude = p.longitude,
                            placeId = null,
                        )
                    },
                )
            }
            dao.getSession(sessionId)?.let { s -> dao.updateSession(s.copy(snappedRawCount = newWatermark)) }
        }
}
