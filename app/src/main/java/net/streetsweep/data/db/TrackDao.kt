package net.streetsweep.data.db

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

    /** Finished drives the server doesn't have yet, oldest first. */
    @Query("SELECT * FROM sessions WHERE endedAt IS NOT NULL AND uploadedAt IS NULL ORDER BY startedAt")
    suspend fun pendingUploads(): List<TrackSession>

    @Query("SELECT COUNT(*) FROM sessions WHERE endedAt IS NOT NULL AND uploadedAt IS NULL")
    fun observePendingUploadCount(): Flow<Int>

    @Query("UPDATE sessions SET uploadedAt = :at, serverStatus = :status WHERE id = :id")
    suspend fun markUploaded(id: Long, at: Long, status: String?)

    @Query("SELECT * FROM sessions WHERE driveUuid = :uuid")
    suspend fun getByUuid(uuid: String): TrackSession?

    @Query("UPDATE sessions SET serverStatus = :status WHERE id = :id")
    suspend fun setServerStatus(id: Long, status: String?)

    /** How far through the drive the provisional preview has looked. */
    @Query("UPDATE sessions SET snappedRawCount = :n WHERE id = :id")
    suspend fun setMatchedThrough(id: Long, n: Int)

    @Query("UPDATE sessions SET driveTypeKey = :type, vehicleId = :vehicleId WHERE id = :id")
    suspend fun setDriveDetails(id: Long, type: String?, vehicleId: String?)

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

    /** The server's word on what a matched drive swept first: streets and their length. */
    @Query("UPDATE sessions SET newSegments = :streets, newMeters = :meters WHERE id = :id")
    suspend fun setNewStreets(id: Long, streets: Int, meters: Double)

    @Query(
        """
        SELECT COUNT(*) AS drives, SUM(distanceMeters) AS meters,
               SUM(MAX(COALESCE(endedAt, startedAt) - startedAt - pausedMs, 0)) AS durationMs,
               SUM(newMeters) AS newMeters, SUM(newSegments) AS newStreets
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
