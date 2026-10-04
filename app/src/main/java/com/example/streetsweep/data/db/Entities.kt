package com.example.streetsweep.data.db

import androidx.room.ColumnInfo
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
    /** The drive's id on the server, made here so a retried upload is the same drive. */
    @ColumnInfo(defaultValue = "") val driveUuid: String = java.util.UUID.randomUUID().toString(),
    /** Personal, Delivery…: the server's drive type key. Null = the server's default. */
    val driveTypeKey: String? = null,
    /** The vehicle it was driven in (server id), or null to let the server work it out. */
    val vehicleId: String? = null,
    /** When the server accepted it; null while it waits to go up. */
    val uploadedAt: Long? = null,
    /** The server's word on it: received, matching, matched or failed. */
    val serverStatus: String? = null,
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
    /** Its id on the server, made here so a retried upload is the same place. */
    @ColumnInfo(defaultValue = "") val uuid: String = java.util.UUID.randomUUID().toString(),
    /** Marked by you; otherwise someone shared it with one of your teams, and it's read-only. */
    @ColumnInfo(defaultValue = "1") val mine: Boolean = true,
    /** Who marked it, for someone else's. */
    val ownerName: String? = null,
    /** Teams it's shared with, comma-separated ids. Empty = only its owner sees it. */
    @ColumnInfo(defaultValue = "") val teamIds: String = "",
    /** Photo ids on the server, comma-separated, to show photos added on the web. */
    @ColumnInfo(defaultValue = "") val serverPhotos: String = "",
    /** Changed here since the server last had it. */
    @ColumnInfo(defaultValue = "1") val dirty: Boolean = true,
)

/**
 * A drive or marked place deleted on this phone, waiting to tell the server. Without it
 * the server could not tell a deletion from a phone that simply never had the thing.
 */
@Entity(tableName = "pending_deletions", primaryKeys = ["kind", "key"])
data class PendingDeletion(
    /** [KIND_DRIVE] or [KIND_POI]. */
    val kind: String,
    /** The drive's or place's id on the server ([TrackSession.driveUuid], [Poi.uuid]). */
    val key: String,
    val deletedAt: Long,
) {
    companion object {
        const val KIND_DRIVE = "drive"
        const val KIND_POI = "poi"
    }
}
