package com.example.streetsweep.data.sync

import android.util.Log
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.TrackRepository
import com.example.streetsweep.data.osm.AreaGeoJson
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.data.prefs.SettingsRepository
import org.json.JSONArray
import org.json.JSONObject

/** What a push actually moved. */
data class PushResult(val areas: Int, val edges: Int, val drives: Int, val pois: Int)

/**
 * Moves work between the phone and the area builder's server.
 *
 * Pulling brings down outlines drawn on a computer. Pushing sends what the phone has learned:
 * the streets it has driven, each area's completion, the drive log and marked spots. Edges go
 * up in batches and only the ones recorded since the last push, unless a full resend is asked
 * for, so a routine push after a drive is small.
 */
class PortalSync(
    private val client: PortalClient,
    private val tracks: TrackRepository,
    private val coverage: CoverageRepository,
    private val settings: SettingsRepository,
) {
    /** Pulls areas from the server and adds any the phone does not already have. */
    suspend fun pullAreas(): Int {
        val parsed = AreaGeoJson.parse(client.areasGeoJson())
        val existing = coverage.getAreas().map { it.name.lowercase() }.toSet()
        val fresh = parsed.filter { it.name.lowercase() !in existing }
        if (fresh.isEmpty()) return 0
        return coverage.importAreas(fresh).size
    }

    suspend fun push(full: Boolean = false): PushResult {
        val since = if (full) 0L else settings.current().lastPortalPushAt
        val startedAt = System.currentTimeMillis()

        val areas = coverage.areasWithStatsNow()
        // Areas reference their parent by id locally but travel by name, because the server
        // has no idea what our row ids mean.
        val nameById = areas.associate { it.area.id to it.name }
        val drives = tracks.getAllSessions()
        val pois = tracks.getAllPois()

        val head = JSONObject()
            .put("areas", JSONArray().apply { areas.forEach { put(areaJson(it, nameById)) } })
            .put("drives", JSONArray().apply { drives.forEach { put(driveJson(it)) } })
            .put("pois", JSONArray().apply { pois.forEach { put(poiJson(it)) } })
        if (full) head.put("resetEdges", true)
        client.sync(head)

        val edges = coverage.getAllDrivenEdges().filter { it.drivenAt > since }
        var sent = 0
        edges.chunked(EDGE_BATCH).forEach { batch ->
            val body = JSONObject().put("edges", JSONArray().apply { batch.forEach { put(edgeJson(it)) } })
            client.sync(body)
            sent += batch.size
            Log.d(TAG, "pushed $sent of ${edges.size} segments")
        }

        settings.setLastPortalPushAt(startedAt)
        return PushResult(areas.size, sent, drives.size, pois.size)
    }

    private fun areaJson(a: com.example.streetsweep.data.AreaWithStats, nameById: Map<Long, String>) = JSONObject()
        .put("name", a.name)
        .put("level", a.level.name)
        .put("parent", a.area.parentId?.let { nameById[it] } ?: JSONObject.NULL)
        .put("polygon", pointsJson(a.vertices))
        .put(
            "stats",
            JSONObject()
                .put("total", a.stats.total)
                .put("done", a.stats.done)
                .put("partial", a.stats.partial)
                .put("excluded", a.stats.excluded)
                .put("metersTotal", a.stats.metersTotal)
                .put("metersDriven", a.stats.metersDriven),
        )

    private fun driveJson(s: com.example.streetsweep.data.db.TrackSession) = JSONObject()
        .put("startedAt", s.startedAt)
        .put("endedAt", s.endedAt ?: JSONObject.NULL)
        .put("trigger", s.trigger)
        .put("pointCount", s.pointCount)
        .put("distanceMeters", s.distanceMeters)
        .put("newSegments", s.newSegments)
        .put("newMeters", s.newMeters)

    private fun poiJson(p: com.example.streetsweep.data.db.Poi) = JSONObject()
        .put("lat", p.latitude)
        .put("lng", p.longitude)
        .put("note", p.note ?: JSONObject.NULL)
        .put("at", p.timestamp)

    private fun edgeJson(e: com.example.streetsweep.data.db.DrivenEdge) = JSONObject()
        .put("key", e.key)
        .put("wayId", e.wayId)
        .put("name", e.name ?: JSONObject.NULL)
        .put("roadClass", e.roadClass)
        .put("lengthMeters", e.lengthMeters)
        .put("drivenAt", e.drivenAt)
        .put("shape", pointsJson(ShapeText.decode(e.shape)))

    private fun pointsJson(points: List<com.example.streetsweep.domain.LatLngPoint>) = JSONArray().apply {
        points.forEach { put(JSONArray().put(it.latitude).put(it.longitude)) }
    }

    companion object {
        private const val TAG = "PortalSync"
        const val EDGE_BATCH = 400
    }
}
