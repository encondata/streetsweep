package com.example.streetsweep.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface TrackDao {
    @Insert
    suspend fun insertSession(session: TrackSession): Long

    @Update
    suspend fun updateSession(session: TrackSession)

    @Query("SELECT * FROM sessions WHERE id = :id")
    suspend fun getSession(id: Long): TrackSession?

    @Query("SELECT * FROM sessions WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
    suspend fun getOpenSession(): TrackSession?

    @Query("SELECT * FROM sessions ORDER BY startedAt DESC")
    fun observeSessions(): Flow<List<TrackSession>>

    @Query("SELECT * FROM sessions ORDER BY startedAt")
    suspend fun getAllSessions(): List<TrackSession>

    /** Drives that ended without being fully matched, for the retry job. */
    @Query("SELECT * FROM sessions WHERE endedAt IS NOT NULL AND snappedRawCount < pointCount AND pointCount >= 2 ORDER BY startedAt")
    suspend fun getUnmatchedSessions(): List<TrackSession>

    @Query("SELECT (startedAt / 604800000) AS week, COUNT(*) AS drives, SUM(distanceMeters) AS meters, SUM(newMeters) AS newMeters FROM sessions GROUP BY week ORDER BY week")
    fun observeWeeklyDriving(): Flow<List<WeeklyDrivingRow>>

    @Query("SELECT * FROM sessions WHERE id = :id")
    fun observeSession(id: Long): Flow<TrackSession?>

    @Query("DELETE FROM sessions WHERE id = :id")
    suspend fun deleteSession(id: Long)

    @Query("UPDATE sessions SET pausedMs = pausedMs + :millis WHERE id = :id")
    suspend fun addPausedMs(id: Long, millis: Long)

    @Query("UPDATE sessions SET newSegments = newSegments + :segments, newMeters = newMeters + :meters WHERE id = :id")
    suspend fun addCoverageStats(id: Long, segments: Int, meters: Double)

    @Query(
        """
        SELECT COUNT(*) AS drives, SUM(distanceMeters) AS meters,
               SUM(MAX(COALESCE(endedAt, startedAt) - startedAt - pausedMs, 0)) AS durationMs,
               SUM(newMeters) AS newMeters, SUM(newSegments) AS newSegments
        FROM sessions
        """,
    )
    fun observeTotals(): Flow<SessionTotalsRow>

    @Insert
    suspend fun insertPoint(point: TrackPoint): Long

    @Query("SELECT * FROM points WHERE sessionId = :sessionId ORDER BY timestamp")
    suspend fun getPoints(sessionId: Long): List<TrackPoint>

    @Query("SELECT * FROM points WHERE sessionId = :sessionId ORDER BY timestamp")
    fun observePoints(sessionId: Long): Flow<List<TrackPoint>>

    @Query("SELECT * FROM points ORDER BY sessionId, timestamp")
    fun observeAllPoints(): Flow<List<TrackPoint>>

    @Insert
    suspend fun insertSnappedPoints(points: List<SnappedPoint>)

    @Query("SELECT COALESCE(MAX(sequence), -1) FROM snapped_points WHERE sessionId = :sessionId")
    suspend fun maxSnappedSequence(sessionId: Long): Int

    @Query("SELECT * FROM snapped_points WHERE sessionId = :sessionId ORDER BY sequence")
    fun observeSnappedPoints(sessionId: Long): Flow<List<SnappedPoint>>

    @Query("SELECT * FROM snapped_points ORDER BY sessionId, sequence")
    fun observeAllSnappedPoints(): Flow<List<SnappedPoint>>
}
