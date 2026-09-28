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
    /**
     * Time spent paused, so a stop at the shops does not count as driving. Accrued when
     * the drive is resumed or finished, never while it is still standing still.
     */
    val pausedMs: Long = 0,
) {
    val isOpen: Boolean get() = endedAt == null

    /** Wall-clock length of the drive with any pauses taken out. */
    fun drivingMs(now: Long = System.currentTimeMillis()): Long =
        ((endedAt ?: now) - startedAt - pausedMs).coerceAtLeast(0)
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
) {
    /** How the server knows this place: when it was marked, and where, to the micro-degree. */
    val serverKey: String
        get() = "%d:%.6f:%.6f".format(java.util.Locale.US, timestamp, latitude, longitude)
}

/**
 * A drive or marked place deleted on this phone, waiting to tell the server. Without it
 * the server could not tell a deletion from a phone that simply never had the thing.
 */
@Entity(tableName = "pending_deletions", primaryKeys = ["kind", "key"])
data class PendingDeletion(
    /** [KIND_DRIVE], [KIND_EDGE] or [KIND_POI]. */
    val kind: String,
    /**
     * A drive: when it started, as the server keys it. A street segment it earned: the
     * segment's key, since the server cannot tell which drive a segment came from. A
     * place: the server's id for it.
     */
    val key: String,
    val deletedAt: Long,
) {
    companion object {
        const val KIND_DRIVE = "drive"
        const val KIND_EDGE = "edge"
        const val KIND_POI = "poi"
    }
}
