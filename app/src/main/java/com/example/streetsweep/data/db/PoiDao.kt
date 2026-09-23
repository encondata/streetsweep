package com.example.streetsweep.data.db

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

    @Query("UPDATE pois SET note = :note, updatedAt = :at WHERE id = :id")
    suspend fun setNote(id: Long, note: String?, at: Long)

    @Query("UPDATE pois SET name = :name, note = :note, updatedAt = :at WHERE id = :id")
    suspend fun setDetails(id: Long, name: String?, note: String?, at: Long)

    @Query("UPDATE pois SET photoPath = :path, photoSyncedAt = 0, updatedAt = :at WHERE id = :id")
    suspend fun setPhoto(id: Long, path: String?, at: Long)

    @Query("UPDATE pois SET photoSyncedAt = :at WHERE id = :id")
    suspend fun markPhotoSynced(id: Long, at: Long)

    @Query("SELECT * FROM pois WHERE photoPath IS NOT NULL AND photoSyncedAt = 0")
    suspend fun withUnsentPhotos(): List<Poi>

    @Query("DELETE FROM pois WHERE id = :id")
    suspend fun delete(id: Long)
}
