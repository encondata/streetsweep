package com.example.streetsweep.data.sync

import android.util.Log
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.TrackRepository
import com.example.streetsweep.data.osm.AreaGeoJson
import com.example.streetsweep.data.osm.ImportedArea
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.data.prefs.SettingsRepository
import org.json.JSONArray
import org.json.JSONObject

/** What a push actually moved. */
data class PushResult(
    val areas: Int, val edges: Int, val drives: Int, val pois: Int,
    /** What came back down: areas the web added or reshaped since the last sync. */
    val pulled: AreaPull = AreaPull(),
)

/**
 * What a pull of the portal's areas did. [needStreets] is every area whose outline is new
 * or changed, which is exactly the set that needs its streets downloaded again.
 */
data class AreaPull(
    val added: List<Long> = emptyList(),
    val updated: List<Long> = emptyList(),
    val keptLocal: List<String> = emptyList(),
    val unchanged: Int = 0,
) {
    val needStreets: List<Long> get() = added + updated
    val changedAnything: Boolean get() = added.isNotEmpty() || updated.isNotEmpty()

    /** What happened, in a sentence, or null when nothing did. Shared so every screen says it the same way. */
    fun summary(): String? {
        val bits = buildList {
            if (added.isNotEmpty()) add("added ${added.size} ${if (added.size == 1) "area" else "areas"}")
            if (updated.isNotEmpty()) add("reshaped ${updated.size} to match the web")
            if (keptLocal.isNotEmpty()) {
                add("kept your own outline for ${keptLocal.joinToString()} " +
                    "because ${if (keptLocal.size == 1) "it was" else "they were"} redrawn on this phone")
            }
        }
        if (bits.isEmpty()) return null
        // No "downloading…" here: the caller knows whether anything was actually queued.
        return bits.joinToString(", ").replaceFirstChar { it.uppercase() }
    }
}

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
    /**
     * Brings the phone's areas into line with the portal's.
     *
     * This used to add only areas whose name the phone did not have, and never touched one
     * it did. So an outline refined on the web never reached the phone: April Sound stayed
     * at the 26 corners it first arrived with while the web's grew to 269, and the two sides
     * counted 165 streets against 126 for what they both called April Sound.
     *
     * Now the portal's outline, level and parent win for every area both sides have —
     * except where the phone has redrawn it since, which is kept (see
     * [CoverageRepository.syncFromWeb]). An area that exists only on the phone is left
     * alone: nothing here deletes.
     */
    suspend fun pullAreas(): AreaPull {
        val parsed = AreaGeoJson.parse(client.areasGeoJson())
        val onPhone = coverage.getAreas().associateBy { it.name.lowercase() }

        val fresh = ArrayList<ImportedArea>()
        val updated = ArrayList<Long>()
        val kept = ArrayList<String>()
        var same = 0
        // Biggest first, so a neighbourhood's city is already in place to be its parent.
        for (web in parsed.sortedByDescending { it.level.ordinal }) {
            val mine = onPhone[web.name.lowercase()]
            if (mine == null) { fresh += web; continue }
            val parentId = web.parent?.lowercase()?.let { onPhone[it]?.id }
            when (coverage.syncFromWeb(mine, web, parentId)) {
                CoverageRepository.WebSync.UPDATED -> updated += mine.id
                CoverageRepository.WebSync.KEPT_LOCAL -> kept += mine.name
                CoverageRepository.WebSync.UNCHANGED -> same++
            }
        }
        val added = if (fresh.isEmpty()) emptyList() else coverage.importAreas(fresh).map { it.id }
        coverage.markPulled(added)
        return AreaPull(added, updated, kept, same)
    }

    /** Run after every push; AppContainer uses it to take the web's figures again shortly. */
    var afterPush: (() -> Unit)? = null

    /**
     * Every area's figures as the web counts them, kept for the screens to show. Returns
     * whether any were still being recounted, so the caller can look again.
     */
    suspend fun pullAreaStats(): Boolean {
        val body = client.getJson("/api/areas/progress")
        val rows = JSONObject(body).optJSONArray("areas") ?: return false
        val figures = (0 until rows.length()).map { i ->
            val r = rows.getJSONObject(i)
            com.example.streetsweep.data.ServerAreaFigures(
                name = r.optString("name"), total = r.optInt("total"), done = r.optInt("done"),
                partial = r.optInt("partial"), excluded = r.optInt("excluded"),
                metersTotal = r.optDouble("metersTotal", 0.0), metersDriven = r.optDouble("metersDriven", 0.0),
                computedAt = r.optLong("computedAt", System.currentTimeMillis()),
                pending = r.optBoolean("pending", false),
            )
        }
        val applied = coverage.applyServerStats(figures)
        Log.d(TAG, "took the web's figures for $applied areas")
        return figures.any { it.pending }
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

        // Before the areas' totals are worked out, so they already count a street someone
        // marked complete on the web. A server too old to know about marks is no reason to
        // fail the rest of the push.
        runCatching { syncCompletions() }
            .onFailure { Log.w(TAG, "could not sync streets marked complete: ${it.message}") }
        runCatching { syncExclusions() }
            .onFailure { Log.w(TAG, "could not sync excluded streets: ${it.message}") }

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
        val answer = client.sync(head)
        // The web is the record. An area drawn here, or redrawn here since it was last
        // pulled, has just been written there (if this account may edit areas); from now
        // on it is the web's outline, so remember it as pulled and the next pull agrees.
        answer.optJSONObject("areasUploaded")?.let { up ->
            val taken = (jsonNames(up.optJSONArray("created")) + jsonNames(up.optJSONArray("redrawn")))
                .map { it.lowercase() }.toSet()
            val ids = areas.filter { it.name.lowercase() in taken }.map { it.area.id }
            if (ids.isNotEmpty()) {
                coverage.markPulled(ids)
                Log.i(TAG, "sent ${ids.size} areas drawn or redrawn here to the web")
            }
        }

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
        // Last, and not allowed to fail the push: the drives have gone up either way.
        val areaPull = runCatching { pullAreas() }
            .onFailure { Log.w(TAG, "could not take back the portal's areas: ${it.message}") }
            .getOrDefault(AreaPull())
        if (areaPull.changedAnything) {
            Log.i(TAG, "areas from the portal: ${areaPull.added.size} added, ${areaPull.updated.size} reshaped")
        }

        // The web's figures for every area: the record, and the only full count of an area
        // this phone holds only part of. The server recounts a few seconds after a push, so
        // they are taken again shortly as well.
        runCatching { pullAreaStats() }
            .onFailure { Log.w(TAG, "could not take the web's area figures: ${it.message}") }
        afterPush?.invoke()

        settings.setLastPortalPushAt(startedAt)
        return PushResult(areas.size, sent, drives.size, pois.size, areaPull)
    }

    /**
     * Swaps streets marked complete by hand with the server: this phone's edits up, then
     * everyone's down. Each side keeps whichever edit of a street is newer. Returns how many
     * streets changed here.
     */
    suspend fun syncCompletions(): Int {
        val unsent = coverage.unsentCompletions()
        unsent.chunked(EDGE_BATCH).forEach { batch ->
            client.sync(JSONObject().put("completions", JSONArray().apply {
                batch.forEach {
                    put(JSONObject().put("wayId", it.wayId).put("marked", it.marked).put("updatedAt", it.updatedAt))
                }
            }))
            batch.forEach { coverage.markCompletionSent(it) }
        }
        val rows = JSONObject(client.getJson("/api/street-completions")).optJSONArray("completions")
            ?: return 0
        val incoming = (0 until rows.length()).map { i ->
            val r = rows.getJSONObject(i)
            com.example.streetsweep.data.db.StreetCompletion(
                wayId = r.getLong("wayId"), marked = r.getBoolean("marked"),
                updatedAt = r.getLong("updatedAt"), sent = true,
            )
        }
        return coverage.applyCompletions(incoming).also {
            if (unsent.isNotEmpty() || it > 0) Log.d(TAG, "completions: sent ${unsent.size}, took $it")
        }
    }

    /** The same swap for excluded streets: gated, private, not drivable, not needed. */
    suspend fun syncExclusions(): Int {
        val unsent = coverage.unsentExclusions()
        unsent.chunked(EDGE_BATCH).forEach { batch ->
            client.sync(JSONObject().put("exclusions", JSONArray().apply {
                batch.forEach {
                    put(JSONObject().put("wayId", it.wayId).put("excluded", it.active)
                        .put("reason", it.reason).put("note", it.note ?: JSONObject.NULL)
                        .put("updatedAt", it.updatedAt))
                }
            }))
            batch.forEach { coverage.markExclusionSent(it) }
        }
        val rows = JSONObject(client.getJson("/api/street-exclusions")).optJSONArray("exclusions")
            ?: return 0
        val incoming = (0 until rows.length()).map { i ->
            val r = rows.getJSONObject(i)
            val at = r.getLong("updatedAt")
            com.example.streetsweep.data.db.StreetExclusion(
                wayId = r.getLong("wayId"), reason = r.optString("reason", "OTHER"),
                note = r.optString("note").takeIf { it.isNotBlank() && it != "null" },
                excludedAt = at, active = r.getBoolean("excluded"), updatedAt = at, sent = true,
            )
        }
        return coverage.applyExclusions(incoming).also {
            if (unsent.isNotEmpty() || it > 0) Log.d(TAG, "exclusions: sent ${unsent.size}, took $it")
        }
    }

    private fun jsonNames(arr: JSONArray?): List<String> =
        if (arr == null) emptyList() else (0 until arr.length()).map { arr.optString(it) }

    private fun areaJson(a: com.example.streetsweep.data.AreaWithStats, nameById: Map<Long, String>) = JSONObject()
        .put("name", a.name)
        // Redrawn on this phone since the web last sent it: the web takes the new outline.
        .put("redrawn", a.area.pulledOutline != null && a.area.polygon != a.area.pulledOutline)
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
