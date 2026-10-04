package net.streetsweep.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface PoiDao {
    @Insert
    suspend fun insert(poi: Poi): Long

    @Query("SELECT * FROM pois ORDER BY timestamp DESC")
    fun observeAll(): Flow<List<Poi>>

    @Query("SELECT * FROM pois ORDER BY timestamp")
    suspend fun getAll(): List<Poi>

    @Query("SELECT * FROM pois WHERE latitude >= :south AND latitude <= :north AND longitude >= :west AND longitude <= :east LIMIT :limit")
    fun observeInView(south: Double, west: Double, north: Double, east: Double, limit: Int): Flow<List<Poi>>

    @Query("SELECT * FROM pois WHERE id = :id")
    suspend fun get(id: Long): Poi?

    @Query("UPDATE pois SET note = :note, updatedAt = :at, dirty = 1 WHERE id = :id")
    suspend fun setNote(id: Long, note: String?, at: Long)

    @Query("UPDATE pois SET name = :name, note = :note, updatedAt = :at, dirty = 1 WHERE id = :id")
    suspend fun setDetails(id: Long, name: String?, note: String?, at: Long)

    @Query("UPDATE pois SET photoPath = :path, photoSyncedAt = 0, updatedAt = :at, dirty = 1 WHERE id = :id")
    suspend fun setPhoto(id: Long, path: String?, at: Long)

    @Query("UPDATE pois SET teamIds = :teamIds, updatedAt = :at, dirty = 1 WHERE id = :id")
    suspend fun setTeams(id: Long, teamIds: String, at: Long)

    @Query("SELECT * FROM pois WHERE uuid = :uuid")
    suspend fun getByUuid(uuid: String): Poi?

    @androidx.room.Update
    suspend fun update(poi: Poi)

    /** Yours, changed here since the server last had them. */
    @Query("SELECT * FROM pois WHERE mine = 1 AND dirty = 1")
    suspend fun dirtyMine(): List<Poi>

    /** Sent: clean, unless it was edited again meanwhile. */
    @Query("UPDATE pois SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: Long, updatedAt: Long)

    @Query("UPDATE pois SET photoSyncedAt = :at WHERE id = :id")
    suspend fun markPhotoSynced(id: Long, at: Long)

    @Query("SELECT * FROM pois WHERE photoPath IS NOT NULL AND photoSyncedAt = 0")
    suspend fun withUnsentPhotos(): List<Poi>

    @Query("DELETE FROM pois WHERE id = :id")
    suspend fun delete(id: Long)

    @androidx.room.Insert(onConflict = androidx.room.OnConflictStrategy.REPLACE)
    suspend fun addPendingDeletion(d: PendingDeletion)

    @Query("SELECT * FROM pending_deletions")
    suspend fun pendingDeletions(): List<PendingDeletion>

    @Query("DELETE FROM pending_deletions WHERE kind = :kind AND `key` IN (:keys)")
    suspend fun clearPendingDeletions(kind: String, keys: List<String>)
}
