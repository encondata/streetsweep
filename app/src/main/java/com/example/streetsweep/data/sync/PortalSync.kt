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

    /** The key the server gives a marked place, so the phone can address one. */
    private fun poiKey(p: com.example.streetsweep.data.db.Poi): String =
        "%d:%.6f:%.6f".format(java.util.Locale.US, p.timestamp, p.latitude, p.longitude)

    /**
     * Sends any photo the server has not had yet.
     *
     * Runs after the places themselves, because the server will not take a photo for a
     * place it has never heard of.
     */
    suspend fun pushPhotos(): Int {
        var sent = 0
        for (p in tracks.poisWithUnsentPhotos()) {
            val file = p.photoPath?.let { java.io.File(it) } ?: continue
            if (!file.exists()) continue
            runCatching {
                client.putPhoto(poiKey(p), file.readBytes(), "image/jpeg")
                tracks.markPoiPhotoSent(p.id)
                sent++
            }.onFailure { Log.w(TAG, "photo for place ${p.id} did not send: ${it.message}") }
        }
        return sent
    }

    /**
     * Takes back any name or note edited on the portal.
     *
     * The server holds whichever edit is newer, so anything it reports as newer than what
     * is here is an edit made on the web since the last sync.
     */
    suspend fun pullPlaceEdits(): Int {
        val body = runCatching { client.getJson("/api/pois") }.getOrNull() ?: return 0
        val rows = JSONObject(body).optJSONArray("pois") ?: return 0
        val mine = tracks.getAllPois().associateBy { poiKey(it) }
        var changed = 0
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            val local = mine[row.optString("id")] ?: continue
            val theirs = row.optLong("updatedAt")
            if (theirs <= maxOf(local.updatedAt, local.timestamp)) continue
            val name = row.optString("name").takeIf { it.isNotBlank() && it != "null" }
            val note = row.optString("note").takeIf { it.isNotBlank() && it != "null" }
            if (name == local.name && note == local.note) continue
            tracks.setPoiDetails(local.id, name, note)
            changed++
        }
        return changed
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

        // Photos go after the places, because the server will not take one for a place
        // it has not heard of. Taking back edits made on the portal goes last, so a name
        // typed there is not overwritten by the push that just went out.
        val photos = runCatching { pushPhotos() }.getOrDefault(0)
        val pulled = runCatching { pullPlaceEdits() }.getOrDefault(0)
        if (photos > 0 || pulled > 0) Log.d(TAG, "sent $photos photos, took back $pulled edits")

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
        // Standing still at the shops is not driving, so the portal should not count it.
        .put("pausedMs", s.pausedMs)
        .put("trigger", s.trigger)
        .put("pointCount", s.pointCount)
        .put("distanceMeters", s.distanceMeters)
        .put("newSegments", s.newSegments)
        .put("newMeters", s.newMeters)

    private fun poiJson(p: com.example.streetsweep.data.db.Poi) = JSONObject()
        .put("lat", p.latitude)
        .put("lng", p.longitude)
        .put("name", p.name ?: JSONObject.NULL)
        .put("note", p.note ?: JSONObject.NULL)
        .put("at", p.timestamp)
        // The server keeps whichever side edited last, so it needs to know when.
        .put("updatedAt", if (p.updatedAt > 0) p.updatedAt else p.timestamp)

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
