package com.example.streetsweep.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.domain.AreaLevel
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.RoadShape
import com.example.streetsweep.domain.LatLngPoint

/** A named place the user wants to sweep: neighbourhood, city or metro, optionally nested. */
@Entity(tableName = "areas", indices = [Index("parentId")])
data class CoverageArea(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    /** [AreaLevel.ordinal] */
    val level: Int,
    val parentId: Long? = null,
    /** Outline vertices ([ShapeText]); the four box fields are its bounding box, kept for fast queries. */
    val polygon: String,
    val south: Double,
    val west: Double,
    val north: Double,
    val east: Double,
    val createdAt: Long,
    val streetsLoadedAt: Long? = null,
    val chunksTotal: Int = 0,
    val chunksDone: Int = 0,
    val lastError: String? = null,
    /**
     * The outline exactly as it last arrived from the portal ([ShapeText]), or null for an
     * area drawn here or brought in before this was kept. It is how a pull tells "the web
     * has a newer outline" from "this was redrawn on the phone since", so a redraw here is
     * never quietly replaced by the next sync.
     */
    val pulledOutline: String? = null,
    /**
     * Too big to download whole (a metro): its streets load as the phone drives through it
     * and as the map is looked at, cell by cell, from the server. See NearbyStreets.
     */
    @ColumnInfo(defaultValue = "0") val onDemand: Boolean = false,
    /**
     * Put out of sight on this phone: off the map, the lists, guidance and the figures.
     * Areas are the web's to delete, so this is what the phone can do instead; the next
     * sync leaves it hidden, and it can be shown again from the Areas screen.
     */
    @ColumnInfo(defaultValue = "0") val hidden: Boolean = false,
    /**
     * Any further pieces of the area, beyond [polygon] ([ShapeText.encodeRings]): a
     * county of islands, a city with an exclave. Empty for an area in one piece. The box
     * fields cover every piece.
     */
    @ColumnInfo(defaultValue = "") val morePieces: String = "",
    /** The area's id on the server. */
    val serverId: String? = null,
    /** The outline's version on the server; a newer one means fetch the outline again. */
    @ColumnInfo(defaultValue = "0") val version: Int = 0,
    /** The server's latest street-list build, and the one whose package is on the phone. */
    @ColumnInfo(defaultValue = "0") val builtVersion: Int = 0,
    @ColumnInfo(defaultValue = "0") val packageVersion: Int = 0,
    @ColumnInfo(defaultValue = "0") val segmentCount: Int = 0,
    /** Your teams that track it (draw or follow it), comma-separated ids. */
    @ColumnInfo(defaultValue = "") val teamIds: String = "",
    /** Its colour on the web, "#rrggbb", if it has one. */
    val color: String? = null,
) {
    val bounds: Bounds get() = Bounds(south, west, north, east)
    /** The main piece. */
    val vertices: List<LatLngPoint> get() = ShapeText.decode(polygon)
    /** Every piece, the main one first. */
    val pieces: List<List<LatLngPoint>> get() = listOf(vertices) + ShapeText.decodeRings(morePieces)

    /** Inside any piece. */
    fun contains(p: LatLngPoint): Boolean =
        bounds.contains(p) && pieces.any { com.example.streetsweep.domain.Polygon.contains(it, p) }

    /** The map cells its pieces cover: each piece's own box, not the sea between them. */
    fun cells(): List<com.example.streetsweep.domain.ChunkGrid.Cell> =
        pieces.mapNotNull { Bounds.of(it) }
            .flatMap { com.example.streetsweep.domain.ChunkGrid.cellsFor(it) }
            .distinctBy { it.key }
    val areaLevel: AreaLevel get() = AreaLevel.fromOrdinal(level)
    val isDownloading: Boolean get() = !onDemand && streetsLoadedAt == null && lastError == null && chunksTotal > 0
}

/**
 * Which streets are in which area. From a package, the server says, with how much of each
 * lies inside ([insideMeters]: an edge street counts only for its inside part, as on the
 * web). From map cells (big areas), by centroid, with no inside length: all of it counts.
 */
@Entity(tableName = "area_ways", primaryKeys = ["areaId", "wayId"], indices = [Index("wayId")])
data class AreaWay(val areaId: Long, val wayId: Long, val insideMeters: Double? = null)

data class WayCentroid(val id: Long, val cLat: Double, val cLng: Double)

/**
 * One street segment from the server (v2): a piece of an OSM way between intersections,
 * with its bounding box and centroid for spatial queries. [id] is the server's segment
 * id (stable across street imports); the table keeps its v1 name, from when a row was a
 * whole way, because every coverage query, guidance and the gate walk read it as "a
 * street", which a segment is.
 */
@Entity(
    tableName = "osm_ways",
    indices = [Index("minLat", "minLng"), Index("cLat", "cLng"), Index("wayId")],
)
data class OsmWay(
    @PrimaryKey val id: Long,
    val name: String?,
    val highway: String,
    val lengthMeters: Double,
    /** [com.example.streetsweep.data.osm.ShapeText] */
    val shape: String,
    val minLat: Double,
    val minLng: Double,
    val maxLat: Double,
    val maxLng: Double,
    val cLat: Double,
    val cLng: Double,
    val loadedAt: Long,
    /**
     * How much of this way has to be driven before it counts as finished. Almost always
     * [RoadShape.DEFAULT_DONE_FRACTION]; a traffic circle gets less, because a car cannot
     * drive all of one. See [RoadShape].
     */
    val minDoneFraction: Double = RoadShape.DEFAULT_DONE_FRACTION,
    /** The OSM way it's a piece of. */
    val wayId: Long? = null,
)

/** A 0.1° grid cell whose streets have been downloaded; shared between areas. */
@Entity(tableName = "street_chunks")
data class StreetChunk(
    @PrimaryKey val key: String,
    val loadedAt: Long,
    val wayCount: Int,
)

/**
 * A road segment between intersections that has been driven at least once.
 * [key] normalises direction so both directions of a two-way street count once.
 */
@Entity(
    tableName = "driven_edges",
    indices = [Index("wayId"), Index("sessionId"), Index("minLat", "minLng")],
)
data class DrivenEdge(
    @PrimaryKey val key: String,
    val wayId: Long,
    val name: String?,
    val roadClass: String,
    val lengthMeters: Double,
    val shape: String,
    val minLat: Double,
    val minLng: Double,
    val maxLat: Double,
    val maxLng: Double,
    /** The drive that first covered it. Deleting that drive removes the edge. */
    val sessionId: Long?,
    val drivenAt: Long,
)

/**
 * A street the user has decided does not count: inside a gated community, private, or simply
 * not worth sweeping. Excluded streets keep their geometry but leave every total.
 *
 * Shared through the server like [StreetCompletion]. Counting a street again keeps the row
 * with [active] false, so that reaches the other devices too; [updatedAt] decides between
 * two edits of the same street.
 */
@Entity(tableName = "street_exclusions")
data class StreetExclusion(
    @PrimaryKey val wayId: Long,
    /** [com.example.streetsweep.domain.ExclusionReason.name] */
    val reason: String,
    val note: String?,
    val excludedAt: Long,
    @ColumnInfo(defaultValue = "1") val active: Boolean = true,
    @ColumnInfo(defaultValue = "0") val updatedAt: Long = excludedAt,
    /** False until the server has this version of the row. */
    @ColumnInfo(defaultValue = "0") val sent: Boolean = false,
)

/**
 * A street someone has said is finished although the GPS trace does not cover enough of
 * it: a cul-de-sac turned in at the mouth, a road the matcher kept losing, a stretch driven
 * with the phone off. It counts as fully driven everywhere.
 *
 * Shared through the server, so a street marked on the web is complete on every phone.
 * Unmarking keeps the row with [marked] false, so that the unmark reaches the other devices
 * instead of the next pull bringing the mark back. [updatedAt] decides between two edits.
 */
@Entity(tableName = "street_completions")
data class StreetCompletion(
    @PrimaryKey val wayId: Long,
    val marked: Boolean,
    val updatedAt: Long,
    /** False until the server has this version of the row. */
    val sent: Boolean = false,
)

/**
 * How much of each street has been driven, with overlapping segments counted once
 * ([com.example.streetsweep.domain.CoveredLength]). Kept up to date whenever a street's
 * segments or shape change ([com.example.streetsweep.data.WayCoverageBuilder]); every
 * coverage figure reads it rather than adding the segments up again.
 */
@Entity(tableName = "way_coverage")
data class WayCoverage(
    @PrimaryKey val wayId: Long,
    val drivenMeters: Double,
)

/**
 * An area's figures, kept rather than worked out each time a screen asks. Adding up every
 * street of a metro on every change during a drive is far too much work for a phone.
 *
 * [source] "server" figures come from the web — the record — at each sync; "phone" ones are
 * worked out here, in the background, for areas the server does not have.
 */
@Entity(tableName = "area_stats")
data class AreaStatsCache(
    @PrimaryKey val areaId: Long,
    val total: Int,
    val done: Int,
    val partial: Int,
    val excluded: Int,
    val metersTotal: Double,
    val metersDriven: Double,
    val source: String,
    val updatedAt: Long,
)

/** Row of the per-way coverage query. */
data class WayCoverageRow(
    val id: Long,
    val name: String?,
    val highway: String,
    val lengthMeters: Double,
    val shape: String,
    val drivenMeters: Double,
    val excluded: Boolean,
    val minDoneFraction: Double = RoadShape.DEFAULT_DONE_FRACTION,
    /** Marked complete by hand ([StreetCompletion]); [drivenMeters] is then the full length. */
    val completed: Boolean = false,
)

/** Aggregate coverage over an area's streets, ignoring excluded ones. */
data class AreaStatsRow(
    val total: Int,
    val meters: Double?,
    val drivenMeters: Double?,
    val done: Int?,
    val partial: Int?,
    val excluded: Int?,
)

data class WeeklyDrivingRow(val week: Long, val drives: Int, val meters: Double?, val newMeters: Double?)

data class WeeklyMetersRow(val week: Long, val meters: Double?)

data class SessionTotalsRow(
    val drives: Int,
    val meters: Double?,
    val durationMs: Long?,
    val newMeters: Double?,
    val newStreets: Int?,
)
