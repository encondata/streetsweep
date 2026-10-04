package com.example.streetsweep.data.server

import android.content.Context
import android.graphics.BitmapFactory
import android.util.Log
import androidx.room.withTransaction
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.TrackRepository
import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.db.CoverageEntity
import com.example.streetsweep.data.db.DriveTypeEntity
import com.example.streetsweep.data.db.MarkEntity
import com.example.streetsweep.data.db.MarkOp
import com.example.streetsweep.data.db.PendingDeletion
import com.example.streetsweep.data.db.Poi
import com.example.streetsweep.data.db.TeamEntity
import com.example.streetsweep.data.db.TrackSession
import com.example.streetsweep.data.db.VehicleEntity
import com.example.streetsweep.data.osm.AreaGeoJson
import com.example.streetsweep.data.osm.StreetDownloadWorker
import com.example.streetsweep.data.prefs.SettingsRepository
import com.example.streetsweep.domain.AreaLevel
import com.example.streetsweep.domain.ExclusionReason
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/** What a sync did, for Settings and the Areas screen to say. */
data class SyncResult(
    val drivesUploaded: Int,
    val drivesWaiting: Int,
    val marksSent: Int,
    val placesSent: Int,
    val areas: Int,
    val full: Boolean,
)

/**
 * Keeps the phone and the v2 server in step (v2/docs/APP-API.md). The server is the
 * record; the phone sends what happened here (drives, marks, places, deletions) and
 * then takes the server's copy of everything else.
 *
 * Coverage is shown for one team at a time ([selectTeam]). Its coverage and marks are
 * projected into the tables every screen already reads (see ServerDao), so the map,
 * figures, street lists, guidance and the gate walk need not know about teams.
 */
class SyncRepository(
    private val context: Context,
    private val db: AppDatabase,
    private val server: ServerClient,
    private val settings: SettingsRepository,
    private val track: TrackRepository,
    private val coverage: CoverageRepository,
) {
    private val mutex = Mutex()
    private val dao get() = db.serverDao()

    /** Everything, both ways. Throws on a network or server problem (the caller retries). */
    suspend fun sync(): SyncResult = mutex.withLock {
        val marks = pushMarks()
        val places = pushPlaces()
        pushDeletions()
        val (uploaded, waiting) = uploadDrives()
        val pulled = pull()
        SyncResult(uploaded, waiting, marks, places, pulled.first, pulled.second)
    }

    /**
     * Shows another team's coverage and marks. Changes made here for the team shown so
     * far are queued for it first, so switching never loses or misfiles a mark.
     */
    suspend fun selectTeam(teamId: String) = mutex.withLock {
        queueLocalMarks()
        settings.setCoverageTeam(teamId)
        reproject()
    }

    /** New streets arrived: they pick up coverage and marks, and v1 marks find their segments. */
    suspend fun afterStreetsStored() = mutex.withLock {
        convertLegacyMarks()
        reproject()
    }

    /** The team whose coverage is shown: the one chosen, else your personal team. */
    suspend fun shownTeamId(): String? {
        val teams = dao.getTeams()
        val chosen = settings.current().coverageTeamId
        return teams.firstOrNull { it.id == chosen }?.id ?: teams.firstOrNull { it.isPersonal }?.id ?: teams.firstOrNull()?.id
    }

    private suspend fun reproject() {
        val team = shownTeamId()
        dao.reproject(team)
        dao.reprojectMarks(team)
        coverage.recomputeAllStats()
    }

    // ---- marks ----

    /**
     * Streets excluded or marked complete here are written straight into the projection
     * (sent = 0); this turns them into queued changes for the team shown.
     */
    private suspend fun queueLocalMarks() {
        val team = shownTeamId() ?: return
        val cov = db.coverageDao()
        for (x in cov.unsentExclusions()) {
            val note = x.note ?: ExclusionReason.fromName(x.reason).takeIf { it != ExclusionReason.OTHER }?.label
            dao.upsertMarkOp(MarkOp(team, x.wayId, if (x.active) "excluded" else null, if (x.active) note else null, x.updatedAt))
            cov.markExclusionSent(x.wayId, x.updatedAt)
        }
        for (c in cov.unsentCompletions()) {
            dao.upsertMarkOp(MarkOp(team, c.wayId, if (c.marked) "complete" else null, null, c.updatedAt))
            cov.markCompletionSent(c.wayId, c.updatedAt)
        }
    }

    private suspend fun pushMarks(): Int {
        queueLocalMarks()
        var sent = 0
        for (op in dao.markOps()) {
            try {
                if (op.kind != null) {
                    server.putMark(op.teamId, op.segmentId, op.kind, op.note)
                    dao.upsertMarks(listOf(MarkEntity(op.teamId, op.segmentId, op.kind, op.note)))
                } else {
                    server.deleteMark(op.teamId, op.segmentId)
                    dao.deleteMark(op.teamId, op.segmentId)
                }
                dao.deleteMarkOp(op.teamId, op.segmentId, op.at)
                sent++
            } catch (e: ServerException) {
                // A viewer can't mark, or the team is gone: the change can never land.
                if (e.status == 403 || e.status == 404) dao.deleteMarkOp(op.teamId, op.segmentId, op.at) else throw e
            }
        }
        return sent
    }

    /** v1 exclusions/completions (by OSM way) become personal-team marks once their segments are here. */
    private suspend fun convertLegacyMarks() {
        val legacy = dao.legacyMarks()
        if (legacy.isEmpty()) return
        val personal = dao.getTeams().firstOrNull { it.isPersonal }?.id ?: return
        val byWay = legacy.associateBy { it.wayId }
        val found = legacy.map { it.wayId }.chunked(500).flatMap { dao.segmentsOfWays(it) }
        if (found.isEmpty()) return
        val now = System.currentTimeMillis()
        db.withTransaction {
            for (sw in found) {
                val m = byWay[sw.wayId] ?: continue
                dao.upsertMarkOp(MarkOp(personal, sw.segmentId, m.kind, m.note, now))
            }
            dao.deleteLegacyMarks(found.map { it.wayId }.distinct())
        }
    }

    // ---- drives ----

    /** Finished drives go up as raw GPS, oldest first, the v1 history included. */
    private suspend fun uploadDrives(): Pair<Int, Int> {
        var uploaded = 0
        val pending = track.pendingUploads()
        for (session in pending) {
            try {
                val status = uploadDrive(session)
                track.markUploaded(session.id, status)
                uploaded++
            } catch (e: ServerException) {
                when {
                    // Too short or no usable fixes: there's nothing for the server to keep.
                    e.code == "too_short" || e.status == 422 -> track.markUploaded(session.id, "too_short")
                    // A vehicle you can't drive any more: let the server work it out instead.
                    e.status == 400 && session.vehicleId != null -> {
                        track.setDriveDetails(session.id, session.driveTypeKey, null)
                        track.markUploaded(session.id, uploadDrive(session.copy(vehicleId = null)))
                        uploaded++
                    }
                    // A drive type the server dropped: its default instead.
                    e.status == 400 && session.driveTypeKey != null -> {
                        track.setDriveDetails(session.id, null, session.vehicleId)
                        track.markUploaded(session.id, uploadDrive(session.copy(driveTypeKey = null)))
                        uploaded++
                    }
                    else -> throw e
                }
            }
        }
        // Rejected ones (too short) are settled too; only what's genuinely left is waiting.
        return uploaded to track.pendingUploads().size
    }

    private suspend fun uploadDrive(session: TrackSession): String? {
        val points = JSONArray()
        for (p in track.getPoints(session.id)) {
            points.put(JSONArray().put(p.timestamp / 1000.0).put(p.latitude).put(p.longitude).put(p.accuracyMeters.toDouble()).put(p.speedMps.toDouble()))
        }
        val body = JSONObject().put("id", session.driveUuid).put("points", points)
        session.driveTypeKey?.let { body.put("drive_type", it) }
        session.vehicleId?.let { body.put("vehicle_id", it) }
        return server.uploadDrive(body).optJSONObject("drive")?.optString("status")
    }

    // ---- places ----

    private suspend fun pushPlaces(): Int {
        var sent = 0
        val pois = db.poiDao()
        for (p in pois.dirtyMine()) {
            val body = JSONObject().put("id", p.uuid).put("name", p.name ?: p.note?.take(60) ?: "Marked spot")
                .put("note", p.note ?: JSONObject.NULL).put("lon", p.longitude).put("lat", p.latitude)
                .put("team_ids", JSONArray(p.teamIds.split(',').filter { it.isNotBlank() }))
            try {
                server.createPlace(body)
                // A retry (or an edit after it first went up) answers "duplicate": send the edit.
                server.updatePlace(p.uuid, JSONObject().put("name", body.get("name")).put("note", body.get("note")).put("team_ids", body.get("team_ids")))
            } catch (e: ServerException) {
                if (e.status == 410) { track.deletePoi(p.id, tellServer = false); continue } // deleted on the web
                if (e.status == 400 && e.message?.contains("teams") == true) {
                    // Shared with a team you've since left: keep it, unshared.
                    server.updatePlace(p.uuid, JSONObject().put("team_ids", JSONArray()))
                } else throw e
            }
            p.photoPath?.takeIf { p.photoSyncedAt == 0L }?.let { path -> uploadPhoto(p, path) }
            pois.markClean(p.id, p.updatedAt)
            sent++
        }
        return sent
    }

    private suspend fun uploadPhoto(p: Poi, path: String) {
        val file = File(path)
        if (!file.exists() || file.length() == 0L) return
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, opts)
        server.uploadPlacePhoto(p.uuid, file.readBytes(), opts.outWidth.coerceAtLeast(1), opts.outHeight.coerceAtLeast(1))
        db.poiDao().markPhotoSynced(p.id, System.currentTimeMillis())
    }

    // ---- deletions ----

    private suspend fun pushDeletions() {
        val pending = track.pendingDeletions()
        for (kind in listOf(PendingDeletion.KIND_DRIVE, PendingDeletion.KIND_POI)) {
            val keys = pending.filter { it.kind == kind }.map { it.key }
            for (k in keys) if (kind == PendingDeletion.KIND_DRIVE) server.deleteDrive(k) else server.deletePlace(k)
            track.clearPendingDeletions(kind, keys)
        }
        // Anything else in there predates v2 and means nothing to it.
        val stale = pending.filter { it.kind != PendingDeletion.KIND_DRIVE && it.kind != PendingDeletion.KIND_POI }
        stale.groupBy { it.kind }.forEach { (kind, rows) -> track.clearPendingDeletions(kind, rows.map { it.key }) }
    }

    // ---- pulling ----

    /** Returns (areas tracked, whether it was a full sync). */
    private suspend fun pull(): Pair<Int, Boolean> {
        val s = settings.current()
        val json = server.sync(s.syncCursor)
        val full = json.optBoolean("full")

        val teams = json.getJSONArray("teams").objects().mapIndexed { i, t ->
            TeamEntity(t.getString("id"), t.getString("name"), t.getString("kind"), t.getString("role"), i)
        }
        val teamIds = teams.map { it.id }
        val types = json.getJSONArray("drive_types").objects().map { t ->
            DriveTypeEntity(t.getString("key"), t.getString("label"), t.optInt("sort"), t.optJSONObject("team_counts")?.toString() ?: "{}")
        }
        val vehicles = json.getJSONArray("vehicles").objects().map { v ->
            VehicleEntity(v.getString("id"), v.getString("name"), v.optString("kind", "car"), v.getString("team_id"),
                v.optString("team_name"), v.optString("team_kind"), v.optBoolean("permanent"),
                v.optJSONObject("checkout")?.optString("user_id")?.takeIf { it.isNotBlank() })
        }
        dao.replaceLists(teams, types, vehicles)

        val areas = pullAreas(json.getJSONArray("areas").objects())

        db.withTransaction {
            dao.deleteMarksOutside(teamIds.ifEmpty { listOf("") })
            dao.upsertMarks(json.getJSONArray("marks").objects().map {
                MarkEntity(it.getString("team_id"), it.getLong("segment_id"), it.getString("kind"), it.optStringOrNull("note"))
            })
            for (u in json.optJSONArray("unmarked").objects()) dao.deleteMark(u.getString("team_id"), u.getLong("segment_id"))

            dao.deleteCoverageOutside(teamIds.ifEmpty { listOf("") })
            val cov = json.getJSONObject("coverage")
            for (team in cov.keys()) {
                val c = cov.getJSONObject(team)
                if (c.optBoolean("reset")) dao.clearCoverage(team)
                val segs = c.getJSONArray("segments")
                val rows = ArrayList<CoverageEntity>(segs.length())
                for (i in 0 until segs.length()) {
                    val pair = segs.getJSONArray(i)
                    rows += CoverageEntity(team, pair.getLong(0), pair.getLong(1) * 1000)
                }
                rows.chunked(1000).forEach { dao.upsertCoverage(it) }
            }
        }

        pullPlaces(json.optJSONArray("place_ids"), json.optJSONArray("places").objects())
        pullDrives(json.optJSONArray("drives").objects())

        convertLegacyMarks()
        reproject()
        settings.setSyncCursor(json.getString("cursor"), System.currentTimeMillis())
        return areas to full
    }

    private suspend fun pullAreas(rows: List<JSONObject>): Int {
        val ids = HashSet<String>()
        // Bigger areas first, so a neighbourhood finds the city it sits in.
        val ordered = rows.sortedBy { LEVEL_ORDER.indexOf(it.optString("level")).let { i -> if (i < 0) 99 else i } }
        for (a in ordered) {
            val id = a.getString("id")
            ids += id
            val existing = coverage.getAreas().firstOrNull { it.serverId == id }
            var geometry = a.optJSONObject("geometry")
            // Outlines come only on a full sync; a newer version here means fetch it.
            if (geometry == null && (existing == null || existing.version != a.optInt("version"))) {
                geometry = runCatching { server.area(id).optJSONObject("geometry") }.getOrNull()
            }
            val pieces = geometry?.let { AreaGeoJson.pieces(it) }
            if (existing == null && pieces.isNullOrEmpty()) continue // try again next sync
            val (area, _) = coverage.upsertServerArea(
                serverId = id, name = a.getString("name"), level = levelOf(a.optString("level")),
                color = a.optStringOrNull("color"), version = a.optInt("version"), builtVersion = a.optInt("built_version"),
                segmentCount = a.optInt("segment_count"), teamIds = ServerClient.ids(a.optJSONArray("team_ids")),
                pieces = pieces, parentServerId = a.optStringOrNull("parent_id"),
            )
            // A newer street list on the server: fetch it (packages are cached per build).
            if (a.optString("build_status") == "built" && (area.packageVersion != area.builtVersion || area.streetsLoadedAt == null)) {
                StreetDownloadWorker.enqueue(context, area.id)
            }
        }
        coverage.removeServerAreasExcept(ids)
        return ids.size
    }

    private suspend fun pullPlaces(visible: JSONArray?, changed: List<JSONObject>) {
        val pois = db.poiDao()
        for (p in changed) {
            val uuid = p.getString("id")
            val local = pois.getByUuid(uuid)
            // Your own unsent edits win until they've gone up.
            if (local != null && local.mine && local.dirty) continue
            val photos = p.optJSONArray("photos").objects().joinToString(",") { it.getString("id") }
            val teams = ServerClient.ids(p.optJSONArray("team_ids")).joinToString(",")
            val updatedAt = parseTime(p.optString("updated_at"))
            if (local == null) {
                pois.insert(
                    Poi(
                        latitude = p.getDouble("lat"), longitude = p.getDouble("lon"), accuracyMeters = 0f,
                        timestamp = parseTime(p.optString("created_at")), note = p.optStringOrNull("note"), sessionId = null,
                        name = p.optStringOrNull("name"), updatedAt = updatedAt, uuid = uuid, mine = p.optBoolean("mine"),
                        ownerName = p.optStringOrNull("user_name"), teamIds = teams, serverPhotos = photos, dirty = false,
                        // Photos on the server count as sent; one taken here is uploaded by pushPlaces.
                        photoSyncedAt = 1,
                    ),
                )
            } else {
                pois.update(local.copy(
                    latitude = p.getDouble("lat"), longitude = p.getDouble("lon"), note = p.optStringOrNull("note"),
                    name = p.optStringOrNull("name"), updatedAt = updatedAt, mine = p.optBoolean("mine"),
                    ownerName = p.optStringOrNull("user_name"), teamIds = teams, serverPhotos = photos, dirty = false,
                ))
            }
        }
        // Places you can no longer see (deleted, or unshared) leave the phone; unsent ones of yours stay.
        if (visible != null) {
            val keep = ServerClient.ids(visible).toSet()
            for (p in pois.getAll()) if (p.uuid !in keep && !(p.mine && p.dirty)) track.deletePoi(p.id, tellServer = false)
        }
    }

    private suspend fun pullDrives(rows: List<JSONObject>) {
        for (d in rows) {
            val session = track.getByUuid(d.getString("id")) ?: continue
            if (d.optBoolean("deleted")) {
                track.deleteSession(session.id, tellServer = false)
                continue
            }
            val status = d.optString("status")
            if (status != session.serverStatus) track.setServerStatus(session.id, status)
            // The server's match is in: the phone's guess for this drive goes.
            if (status == "matched" || status == "failed") dao.clearProvisional(session.id)
        }
    }

    companion object {
        private const val TAG = "Sync"
        private val LEVEL_ORDER = listOf("state", "county", "city", "neighborhood", "custom")

        /** The phone's three levels: a county or state shows as a metro. */
        fun levelOf(level: String): AreaLevel = when (level) {
            "state", "county" -> AreaLevel.METRO
            "city" -> AreaLevel.CITY
            else -> AreaLevel.NEIGHBORHOOD
        }

        fun parseTime(iso: String?): Long = runCatching { Instant.parse(iso).toEpochMilli() }.getOrElse { System.currentTimeMillis() }
    }
}

private fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

private fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
