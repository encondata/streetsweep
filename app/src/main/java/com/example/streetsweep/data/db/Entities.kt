package com.example.streetsweep.data.db

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "sessions")
data class TrackSession(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val startedAt: Long,
    val endedAt: Long? = null,
    /** [com.example.streetsweep.domain.TriggerSource.name] */
    val trigger: String,
    val pointCount: Int = 0,
    val distanceMeters: Double = 0.0,
    /** How many raw points (in timestamp order) have already been map-matched. */
    val snappedRawCount: Int = 0,
    /** Road segments this drive was the first to cover, and their length. */
    val newSegments: Int = 0,
    val newMeters: Double = 0.0,
) {
    val isOpen: Boolean get() = endedAt == null
}

@Entity(
    tableName = "points",
    foreignKeys = [
        ForeignKey(
            entity = TrackSession::class,
            parentColumns = ["id"],
            childColumns = ["sessionId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("sessionId")],
)
data class TrackPoint(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: Long,
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float,
    val speedMps: Float,
    val bearing: Float,
    val timestamp: Long,
)

@Entity(
    tableName = "snapped_points",
    foreignKeys = [
        ForeignKey(
            entity = TrackSession::class,
            parentColumns = ["id"],
            childColumns = ["sessionId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("sessionId")],
)
data class SnappedPoint(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: Long,
    val sequence: Int,
    val latitude: Double,
    val longitude: Double,
    val placeId: String?,
)

/** A point of interest the user marked while driving. */
@Entity(tableName = "pois", indices = [Index("latitude", "longitude")])
data class Poi(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float,
    val timestamp: Long,
    val note: String?,
    /** Drive that was being recorded at the time, if any (informational, no FK). */
    val sessionId: Long?,
    /** What to call it. The note is for the detail; this is for the list. */
    val name: String? = null,
    /** A photo taken here, as a file in the app's own storage. */
    val photoPath: String? = null,
    /** Set once that photo has reached the server, so it is not sent twice. */
    val photoSyncedAt: Long = 0,
    /**
     * When the name or note last changed, on either side. The server keeps whichever
     * edit is newer, so this is what decides a disagreement.
     */
    val updatedAt: Long = 0,
)
