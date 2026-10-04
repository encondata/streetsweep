package com.example.streetsweep.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/*
 * What the phone keeps of the server's record (v2): copies the sync replaces or updates.
 * The server is the golden record; nothing here is the only copy of anything, except
 * changes still waiting to go up (marks with [MarkOp], unsent drives and places).
 */

/** A team you're in. Coverage on the map is one team's at a time (Settings → Team). */
@Entity(tableName = "teams")
data class TeamEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** "personal" or "shared". */
    val kind: String,
    /** owner, admin, driver or viewer. */
    val role: String,
    val sort: Int,
) {
    val isPersonal: Boolean get() = kind == "personal"
    val canDrive: Boolean get() = role != "viewer"
}

/** Personal, Delivery, Commute…: asked for (or defaulted) when a drive starts. */
@Entity(tableName = "drive_types")
data class DriveTypeEntity(
    @PrimaryKey val key: String,
    val label: String,
    val sort: Int,
    /** Which of your teams count this type, as a JSON object {teamId: true|false}. */
    val teamCounts: String,
)

/** A vehicle you may drive. */
@Entity(tableName = "vehicles")
data class VehicleEntity(
    @PrimaryKey val id: String,
    val name: String,
    val kind: String,
    val teamId: String,
    val teamName: String,
    val teamKind: String,
    /** You're one of its permanent drivers. */
    val permanent: Boolean,
    /** Who has it checked out right now, if anyone. */
    val checkoutUserId: String?,
)

/** A street marked for a team: done by hand ("complete") or left out ("excluded"). */
@Entity(tableName = "marks", primaryKeys = ["teamId", "segmentId"])
data class MarkEntity(
    val teamId: String,
    val segmentId: Long,
    val kind: String,
    val note: String?,
)

/**
 * A mark set or cleared on this phone, waiting to reach the server. The latest one per
 * street wins; [kind] null means "unmark".
 */
@Entity(tableName = "mark_ops", primaryKeys = ["teamId", "segmentId"])
data class MarkOp(
    val teamId: String,
    val segmentId: Long,
    val kind: String?,
    val note: String?,
    val at: Long,
)

/** A segment a team has swept, as the server counted it, and when it was first driven. */
@Entity(tableName = "coverage", primaryKeys = ["teamId", "segmentId"], indices = [Index("segmentId")])
data class CoverageEntity(
    val teamId: String,
    val segmentId: Long,
    val drivenAt: Long,
)

/**
 * A segment a drive on this phone seems to have covered, worked out here from the raw
 * track while the server hasn't matched the drive yet. Shown as driven straight away
 * (offline too); dropped once the server's match for that drive arrives.
 */
@Entity(tableName = "provisional", primaryKeys = ["sessionId", "segmentId"], indices = [Index("segmentId")])
data class ProvisionalEntity(
    val sessionId: Long,
    val segmentId: Long,
    val drivenAt: Long,
)

/**
 * A street excluded or marked complete on this phone before v2, keyed by OSM way. Once
 * that way's segments have arrived, each becomes a mark for the personal team and the
 * row goes.
 */
@Entity(tableName = "legacy_marks")
data class LegacyMark(
    @PrimaryKey val wayId: Long,
    /** "complete" or "excluded". */
    val kind: String,
    val note: String?,
)
