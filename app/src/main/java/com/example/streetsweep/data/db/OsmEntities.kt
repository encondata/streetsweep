package com.example.streetsweep.data.db

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
) {
    val bounds: Bounds get() = Bounds(south, west, north, east)
    val vertices: List<LatLngPoint> get() = ShapeText.decode(polygon)
    val areaLevel: AreaLevel get() = AreaLevel.fromOrdinal(level)
    val isDownloading: Boolean get() = streetsLoadedAt == null && lastError == null && chunksTotal > 0
}

/** Which streets fall inside which area (by centroid, point-in-polygon). Recomputed on download or redraw. */
@Entity(tableName = "area_ways", primaryKeys = ["areaId", "wayId"], indices = [Index("wayId")])
data class AreaWay(val areaId: Long, val wayId: Long)

data class WayCentroid(val id: Long, val cLat: Double, val cLng: Double)

/** One OSM way, stored once globally with its bounding box and centroid for spatial queries. */
@Entity(
    tableName = "osm_ways",
    indices = [Index("minLat", "minLng"), Index("cLat", "cLng")],
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
 */
@Entity(tableName = "street_exclusions")
data class StreetExclusion(
    @PrimaryKey val wayId: Long,
    /** [com.example.streetsweep.domain.ExclusionReason.name] */
    val reason: String,
    val note: String?,
    val excludedAt: Long,
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
    val newSegments: Int?,
)
