package net.streetsweep.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/** The phone's copy of the server's record, and the projections the screens read. */
@Dao
interface ServerDao {
    // ---- teams, drive types, vehicles: replaced whole at each sync ----
    @Query("SELECT * FROM teams ORDER BY sort")
    fun observeTeams(): Flow<List<TeamEntity>>

    @Query("SELECT * FROM teams ORDER BY sort")
    suspend fun getTeams(): List<TeamEntity>

    @Query("DELETE FROM teams")
    suspend fun clearTeams()

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTeams(rows: List<TeamEntity>)

    @Query("SELECT * FROM drive_types ORDER BY sort, label")
    fun observeDriveTypes(): Flow<List<DriveTypeEntity>>

    @Query("SELECT * FROM drive_types ORDER BY sort, label")
    suspend fun getDriveTypes(): List<DriveTypeEntity>

    @Query("DELETE FROM drive_types")
    suspend fun clearDriveTypes()

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertDriveTypes(rows: List<DriveTypeEntity>)

    @Query("SELECT * FROM vehicles ORDER BY teamKind = 'personal' DESC, name")
    fun observeVehicles(): Flow<List<VehicleEntity>>

    @Query("SELECT * FROM vehicles ORDER BY teamKind = 'personal' DESC, name")
    suspend fun getVehicles(): List<VehicleEntity>

    @Query("DELETE FROM vehicles")
    suspend fun clearVehicles()

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertVehicles(rows: List<VehicleEntity>)

    @Transaction
    suspend fun replaceLists(teams: List<TeamEntity>, types: List<DriveTypeEntity>, vehicles: List<VehicleEntity>) {
        clearTeams(); insertTeams(teams)
        clearDriveTypes(); insertDriveTypes(types)
        clearVehicles(); insertVehicles(vehicles)
    }

    // ---- marks ----
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMarks(rows: List<MarkEntity>)

    @Query("DELETE FROM marks WHERE teamId = :teamId AND segmentId = :segmentId")
    suspend fun deleteMark(teamId: String, segmentId: Long)

    @Query("DELETE FROM marks WHERE teamId NOT IN (:teamIds)")
    suspend fun deleteMarksOutside(teamIds: List<String>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMarkOp(op: MarkOp)

    @Query("SELECT * FROM mark_ops ORDER BY at")
    suspend fun markOps(): List<MarkOp>

    /** Only if it hasn't been changed again since it was read. */
    @Query("DELETE FROM mark_ops WHERE teamId = :teamId AND segmentId = :segmentId AND at = :at")
    suspend fun deleteMarkOp(teamId: String, segmentId: Long, at: Long)

    // ---- coverage ----
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCoverage(rows: List<CoverageEntity>)

    @Query("DELETE FROM coverage WHERE teamId = :teamId")
    suspend fun clearCoverage(teamId: String)

    @Query("DELETE FROM coverage WHERE teamId NOT IN (:teamIds)")
    suspend fun deleteCoverageOutside(teamIds: List<String>)

    @Query("SELECT COUNT(*) FROM coverage WHERE teamId = :teamId")
    fun observeCoverageCount(teamId: String): Flow<Int>

    // ---- provisional preview ----
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertProvisional(rows: List<ProvisionalEntity>)

    @Query("DELETE FROM provisional WHERE sessionId = :sessionId")
    suspend fun clearProvisional(sessionId: Long)

    @Query("SELECT COUNT(*) FROM provisional WHERE sessionId = :sessionId")
    suspend fun provisionalCount(sessionId: Long): Int

    /** The same, in streets (every piece sharing a name is one), as people count them. */
    @Query("SELECT COUNT(DISTINCT $STREET_KEY) FROM provisional p JOIN osm_ways w ON w.id = p.segmentId WHERE p.sessionId = :sessionId")
    suspend fun provisionalStreetCount(sessionId: Long): Int

    // ---- v1 marks waiting for their segments ----
    @Query("SELECT * FROM legacy_marks")
    suspend fun legacyMarks(): List<LegacyMark>

    @Query("DELETE FROM legacy_marks WHERE wayId IN (:wayIds)")
    suspend fun deleteLegacyMarks(wayIds: List<Long>)

    @Query("SELECT id AS segmentId, wayId FROM osm_ways WHERE wayId IN (:wayIds)")
    suspend fun segmentsOfWays(wayIds: List<Long>): List<SegmentWay>

    // ---- the coverage projection ----
    //
    // Every coverage figure on the phone reads driven_edges/way_coverage. They hold the
    // chosen team's coverage ('seg:<id>') plus this phone's provisional preview
    // ('prov:<drive>:<id>', so deleting a drive takes only its own rows). A segment is
    // driven or not: the server already decided how much counts.

    @Query("DELETE FROM driven_edges")
    suspend fun clearDrivenEdges()

    @Query("DELETE FROM way_coverage")
    suspend fun clearWayCoverage()

    @Query(
        """
        INSERT OR IGNORE INTO driven_edges (`key`, wayId, name, roadClass, lengthMeters, shape, minLat, minLng, maxLat, maxLng, sessionId, drivenAt)
        SELECT 'seg:' || w.id, w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minLat, w.minLng, w.maxLat, w.maxLng, NULL, c.drivenAt
        FROM coverage c JOIN osm_ways w ON w.id = c.segmentId
        WHERE c.teamId = :teamId
        """,
    )
    suspend fun projectCoverage(teamId: String)

    @Query(
        """
        INSERT OR IGNORE INTO driven_edges (`key`, wayId, name, roadClass, lengthMeters, shape, minLat, minLng, maxLat, maxLng, sessionId, drivenAt)
        SELECT 'prov:' || p.sessionId || ':' || w.id, w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minLat, w.minLng, w.maxLat, w.maxLng, p.sessionId, p.drivenAt
        FROM provisional p JOIN osm_ways w ON w.id = p.segmentId
        """,
    )
    suspend fun projectProvisional()

    @Query("INSERT OR REPLACE INTO way_coverage (wayId, drivenMeters) SELECT wayId, MAX(lengthMeters) FROM driven_edges GROUP BY wayId")
    suspend fun projectWayCoverage()

    /** Rebuild the projection from scratch: after a team switch, a reset, or new streets. */
    @Transaction
    suspend fun reproject(teamId: String?) {
        clearDrivenEdges()
        clearWayCoverage()
        if (teamId != null) projectCoverage(teamId)
        projectProvisional()
        projectWayCoverage()
    }

    // ---- the marks projection ----
    //
    // street_exclusions / street_completions are the chosen team's marks, with this
    // phone's unsent changes on top. Rows edited here are written with sent = 0, and the
    // sync turns those into mark_ops for the team.

    @Query("DELETE FROM street_exclusions")
    suspend fun clearExclusions()

    @Query("DELETE FROM street_completions")
    suspend fun clearCompletions()

    @Query(
        """
        INSERT OR REPLACE INTO street_exclusions (wayId, reason, note, excludedAt, active, updatedAt, sent)
        SELECT segmentId, 'OTHER', note, 0, 1, 0, 1 FROM marks WHERE teamId = :teamId AND kind = 'excluded'
        """,
    )
    suspend fun projectExclusions(teamId: String)

    @Query(
        """
        INSERT OR REPLACE INTO street_completions (wayId, marked, updatedAt, sent)
        SELECT segmentId, 1, 0, 1 FROM marks WHERE teamId = :teamId AND kind = 'complete'
        """,
    )
    suspend fun projectCompletions(teamId: String)

    /** Waiting changes win over the server's copy until they've gone up. */
    @Query(
        """
        INSERT OR REPLACE INTO street_exclusions (wayId, reason, note, excludedAt, active, updatedAt, sent)
        SELECT segmentId, 'OTHER', note, at, CASE WHEN kind = 'excluded' THEN 1 ELSE 0 END, at, 1
        FROM mark_ops WHERE teamId = :teamId
        """,
    )
    suspend fun projectPendingExclusions(teamId: String)

    @Query(
        """
        INSERT OR REPLACE INTO street_completions (wayId, marked, updatedAt, sent)
        SELECT segmentId, CASE WHEN kind = 'complete' THEN 1 ELSE 0 END, at, 1
        FROM mark_ops WHERE teamId = :teamId
        """,
    )
    suspend fun projectPendingCompletions(teamId: String)

    @Transaction
    suspend fun reprojectMarks(teamId: String?) {
        clearExclusions()
        clearCompletions()
        if (teamId == null) return
        projectExclusions(teamId)
        projectCompletions(teamId)
        projectPendingExclusions(teamId)
        projectPendingCompletions(teamId)
    }
}

data class SegmentWay(val segmentId: Long, val wayId: Long)
