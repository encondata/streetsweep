package com.example.streetsweep.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface CoverageDao {
    // ---- areas ----
    @Insert
    suspend fun insertArea(area: CoverageArea): Long

    @Update
    suspend fun updateArea(area: CoverageArea)

    @Query("SELECT * FROM areas WHERE id = :id")
    suspend fun getArea(id: Long): CoverageArea?

    @Query("SELECT * FROM areas ORDER BY level DESC, name")
    fun observeAreas(): Flow<List<CoverageArea>>

    @Query("SELECT * FROM areas ORDER BY level DESC, name")
    suspend fun getAreas(): List<CoverageArea>

    @Query("DELETE FROM areas WHERE id = :id")
    suspend fun deleteArea(id: Long)

    @Query("UPDATE areas SET parentId = NULL WHERE parentId = :id")
    suspend fun orphanChildren(id: Long)

    @Query("UPDATE areas SET chunksTotal = :total, chunksDone = :done, lastError = :error, streetsLoadedAt = :loadedAt WHERE id = :id")
    suspend fun setProgress(id: Long, total: Int, done: Int, error: String?, loadedAt: Long?)

    @Query("SELECT * FROM areas WHERE north >= :south AND south <= :north AND east >= :west AND west <= :east")
    suspend fun getAreasIntersecting(south: Double, west: Double, north: Double, east: Double): List<CoverageArea>

    // ---- membership ----
    @Query("SELECT id, cLat, cLng FROM osm_ways WHERE cLat >= :south AND cLat <= :north AND cLng >= :west AND cLng <= :east")
    suspend fun getCentroidsIn(south: Double, west: Double, north: Double, east: Double): List<WayCentroid>

    @Query("DELETE FROM area_ways WHERE areaId = :areaId")
    suspend fun clearMembership(areaId: Long)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertMembership(rows: List<AreaWay>)

    // ---- street network ----
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertWays(ways: List<OsmWay>)

    @Query("SELECT * FROM street_chunks WHERE `key` = :key")
    suspend fun getChunk(key: String): StreetChunk?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertChunk(chunk: StreetChunk)

    @Query("SELECT COUNT(*) FROM osm_ways")
    fun observeWayCount(): Flow<Int>

    /** Streets touching a viewport, with how much of each has been driven. */
    @Query(
        """
        SELECT w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minDoneFraction,
               CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END AS drivenMeters,
               EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id) AS excluded,
               EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) AS completed
        FROM osm_ways w
        WHERE w.maxLat >= :south AND w.minLat <= :north AND w.maxLng >= :west AND w.minLng <= :east
        LIMIT :limit
        """,
    )
    fun observeWaysInView(south: Double, west: Double, north: Double, east: Double, limit: Int): Flow<List<WayCoverageRow>>

    /** Every street of an area, for the street list. */
    @Query(
        """
        SELECT w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minDoneFraction,
               CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END AS drivenMeters,
               EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id) AS excluded,
               EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) AS completed
        FROM area_ways aw
        JOIN osm_ways w ON w.id = aw.wayId
        WHERE aw.areaId = :areaId
        ORDER BY w.name IS NULL, w.name COLLATE NOCASE, w.id
        LIMIT :limit
        """,
    )
    fun observeAreaStreets(areaId: Long, limit: Int): Flow<List<WayCoverageRow>>

    /** The same rows, read once, for planning a route through an area. */
    @Query(
        """
        SELECT w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minDoneFraction,
               CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END AS drivenMeters,
               EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id) AS excluded,
               EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) AS completed
        FROM area_ways aw
        JOIN osm_ways w ON w.id = aw.wayId
        WHERE aw.areaId = :areaId
        LIMIT :limit
        """,
    )
    suspend fun getAreaStreets(areaId: Long, limit: Int): List<WayCoverageRow>

    /** Coverage for a named set of streets, for walking down a planned route. */
    @Query(
        """
        SELECT w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minDoneFraction,
               CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END AS drivenMeters,
               EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id) AS excluded,
               EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) AS completed
        FROM osm_ways w
        WHERE w.id IN (:wayIds)
        """,
    )
    suspend fun coverageForWays(wayIds: List<Long>): List<WayCoverageRow>

    /** Not-yet-driven, not-excluded streets near a point, for "nearest undriven" guidance. */
    @Query(
        """
        SELECT w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minDoneFraction,
               CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END AS drivenMeters,
               0 AS excluded,
               0 AS completed
        FROM osm_ways w
        WHERE w.maxLat >= :south AND w.minLat <= :north AND w.maxLng >= :west AND w.minLng <= :east
          AND NOT EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id)
          AND CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END
              < MIN(:doneFraction, w.minDoneFraction) * w.lengthMeters
        LIMIT :limit
        """,
    )
    suspend fun undrivenNear(south: Double, west: Double, north: Double, east: Double, doneFraction: Double, limit: Int): List<WayCoverageRow>

    /** The same, restricted to one area, so guidance keeps you inside the place you are sweeping. */
    @Query(
        """
        SELECT w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minDoneFraction,
               CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END AS drivenMeters,
               0 AS excluded,
               0 AS completed
        FROM area_ways aw
        JOIN osm_ways w ON w.id = aw.wayId
        WHERE aw.areaId = :areaId
          AND w.maxLat >= :south AND w.minLat <= :north AND w.maxLng >= :west AND w.minLng <= :east
          AND NOT EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id)
          AND CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END
              < MIN(:doneFraction, w.minDoneFraction) * w.lengthMeters
        LIMIT :limit
        """,
    )
    suspend fun undrivenNearInArea(areaId: Long, south: Double, west: Double, north: Double, east: Double, doneFraction: Double, limit: Int): List<WayCoverageRow>

    /** Ways in a box, fetched once (not observed) to build the local connectivity graph. */
    @Query(
        """
        SELECT w.id, w.name, w.highway, w.lengthMeters, w.shape, w.minDoneFraction,
               CASE WHEN EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) THEN w.lengthMeters
                    ELSE COALESCE((SELECT SUM(e.lengthMeters) FROM driven_edges e WHERE e.wayId = w.id), 0) END AS drivenMeters,
               EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id) AS excluded,
               EXISTS(SELECT 1 FROM street_completions c WHERE c.wayId = w.id AND c.marked = 1) AS completed
        FROM osm_ways w
        WHERE w.maxLat >= :south AND w.minLat <= :north AND w.maxLng >= :west AND w.minLng <= :east
        LIMIT :limit
        """,
    )
    suspend fun getWaysInBox(south: Double, west: Double, north: Double, east: Double, limit: Int): List<WayCoverageRow>

    // ---- exclusions ----
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertExclusions(rows: List<StreetExclusion>)

    @Query("DELETE FROM street_exclusions WHERE wayId IN (:wayIds)")
    suspend fun removeExclusions(wayIds: List<Long>)

    @Query("SELECT * FROM street_exclusions WHERE wayId = :wayId")
    suspend fun getExclusion(wayId: Long): StreetExclusion?

    @Query("SELECT COUNT(*) FROM street_exclusions")
    fun observeExclusionCount(): Flow<Int>

    // ---- streets marked complete by hand ----
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCompletions(rows: List<StreetCompletion>)

    @Query("SELECT * FROM street_completions WHERE wayId IN (:wayIds)")
    suspend fun getCompletions(wayIds: List<Long>): List<StreetCompletion>

    @Query("SELECT * FROM street_completions WHERE sent = 0")
    suspend fun unsentCompletions(): List<StreetCompletion>

    /** Marks rows sent only if they have not been edited again since they were read. */
    @Query("UPDATE street_completions SET sent = 1 WHERE wayId = :wayId AND updatedAt = :updatedAt")
    suspend fun markCompletionSent(wayId: Long, updatedAt: Long)

    /** Coverage totals for the streets that belong to an area. */
    @Query(
        """
        SELECT COUNT(*) AS total,
               SUM(w.lengthMeters) AS meters,
               SUM(MIN(w.lengthMeters, (CASE WHEN c.wayId IS NULL THEN COALESCE(d.m, 0) ELSE w.lengthMeters END))) AS drivenMeters,
               SUM(CASE WHEN (CASE WHEN c.wayId IS NULL THEN COALESCE(d.m, 0) ELSE w.lengthMeters END) >= w.minDoneFraction * w.lengthMeters THEN 1 ELSE 0 END) AS done,
               SUM(CASE WHEN (CASE WHEN c.wayId IS NULL THEN COALESCE(d.m, 0) ELSE w.lengthMeters END) > 0.02 * w.lengthMeters AND (CASE WHEN c.wayId IS NULL THEN COALESCE(d.m, 0) ELSE w.lengthMeters END) < w.minDoneFraction * w.lengthMeters THEN 1 ELSE 0 END) AS partial,
               (SELECT COUNT(*) FROM area_ways aw2 JOIN street_exclusions x2 ON x2.wayId = aw2.wayId WHERE aw2.areaId = :areaId) AS excluded
        FROM area_ways aw
        JOIN osm_ways w ON w.id = aw.wayId
        LEFT JOIN (SELECT wayId, SUM(lengthMeters) AS m FROM driven_edges GROUP BY wayId) d ON d.wayId = w.id
        LEFT JOIN street_completions c ON c.wayId = w.id AND c.marked = 1
        WHERE aw.areaId = :areaId AND NOT EXISTS(SELECT 1 FROM street_exclusions x WHERE x.wayId = w.id)
        """,
    )
    fun observeStatsFor(areaId: Long): Flow<AreaStatsRow>

    // ---- driven edges ----
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertDrivenEdges(edges: List<DrivenEdge>): List<Long>

    @Query(
        """
        SELECT * FROM driven_edges
        WHERE maxLat >= :south AND minLat <= :north AND maxLng >= :west AND minLng <= :east
        LIMIT :limit
        """,
    )
    fun observeEdgesInView(south: Double, west: Double, north: Double, east: Double, limit: Int): Flow<List<DrivenEdge>>

    @Query("DELETE FROM driven_edges WHERE sessionId = :sessionId")
    suspend fun deleteDrivenEdgesForSession(sessionId: Long)

    @Query("SELECT COUNT(*) FROM driven_edges")
    fun observeDrivenEdgeCount(): Flow<Int>

    @Query("SELECT * FROM driven_edges ORDER BY drivenAt")
    suspend fun getAllDrivenEdges(): List<DrivenEdge>

    /** New street length credited to an area, week by week, for the progress chart. */
    @Query(
        """
        SELECT (e.drivenAt / 604800000) AS week, SUM(e.lengthMeters) AS meters
        FROM driven_edges e JOIN area_ways aw ON aw.wayId = e.wayId
        WHERE aw.areaId = :areaId GROUP BY week ORDER BY week
        """,
    )
    fun observeWeeklyAreaProgress(areaId: Long): Flow<List<WeeklyMetersRow>>
}
