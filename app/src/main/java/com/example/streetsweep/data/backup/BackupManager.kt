package com.example.streetsweep.data.backup

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.TrackRepository
import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.domain.LatLngPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Getting your drives out of the app, and back in.
 *
 * The database copy is the real safety net: it holds everything, including which streets are
 * excluded and how far each drive got. GPX and GeoJSON are for looking at the data elsewhere.
 */
class BackupManager(
    private val context: Context,
    private val database: AppDatabase,
    private val tracks: TrackRepository,
    private val coverage: CoverageRepository,
) {
    sealed interface RestoreResult {
        data class Ok(val drives: Int, val areas: Int) : RestoreResult
        data class Rejected(val reason: String) : RestoreResult
    }

    private val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }

    private fun databaseFile(): File = context.getDatabasePath(DB_NAME)

    /** Flushes the write-ahead log so the file on disk is complete, then copies it out. */
    suspend fun writeDatabaseBackup(out: OutputStream): Long = withContext(Dispatchers.IO) {
        database.openHelper.writableDatabase.query("PRAGMA wal_checkpoint(TRUNCATE)").use { it.moveToFirst() }
        databaseFile().inputStream().use { input -> input.copyTo(out) }
        databaseFile().length()
    }

    /**
     * Replaces the live database with a backup. The file is checked before anything is
     * overwritten, and the caller must restart the process afterwards because Room keeps
     * the old file open.
     */
    suspend fun restoreDatabase(input: InputStream): RestoreResult = withContext(Dispatchers.IO) {
        val staging = File(context.cacheDir, "restore-staging.db")
        try {
            staging.outputStream().use { input.copyTo(it) }
            val check = verify(staging) ?: return@withContext RestoreResult.Rejected("Not a StreetSweep backup")

            database.openHelper.writableDatabase.query("PRAGMA wal_checkpoint(TRUNCATE)").use { it.moveToFirst() }
            database.close()
            val live = databaseFile()
            File(live.parentFile, "$DB_NAME-wal").delete()
            File(live.parentFile, "$DB_NAME-shm").delete()
            staging.copyTo(live, overwrite = true)
            check
        } catch (e: Exception) {
            Log.e(TAG, "Restore failed", e)
            RestoreResult.Rejected(e.message ?: "Could not read that file")
        } finally {
            staging.delete()
        }
    }

    /** Opens the candidate read-only and makes sure it looks like our schema. */
    private fun verify(file: File): RestoreResult.Ok? = try {
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            val tables = HashSet<String>()
            db.rawQuery("SELECT name FROM sqlite_master WHERE type='table'", null).use { c ->
                while (c.moveToNext()) tables += c.getString(0)
            }
            if (!tables.containsAll(REQUIRED_TABLES)) {
                null
            } else {
                fun count(t: String) = db.rawQuery("SELECT COUNT(*) FROM $t", null).use { it.moveToFirst(); it.getInt(0) }
                RestoreResult.Ok(drives = count("sessions"), areas = count("areas"))
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "Backup file rejected", e)
        null
    }

    // ---- human-readable exports ----

    /** Every drive as a GPX track, with marked spots as waypoints. */
    suspend fun writeGpx(out: OutputStream) = withContext(Dispatchers.IO) {
        out.writer().use { w ->
            w.write("""<?xml version="1.0" encoding="UTF-8"?>""" + "\n")
            w.write("""<gpx version="1.1" creator="StreetSweep" xmlns="http://www.topografix.com/GPX/1/1">""" + "\n")
            for (poi in tracks.getAllPois()) {
                w.write("""  <wpt lat="${poi.latitude}" lon="${poi.longitude}">""" + "\n")
                w.write("    <time>${iso.format(Date(poi.timestamp))}</time>\n")
                w.write("    <name>${escape(poi.note ?: "Marked spot")}</name>\n")
                w.write("  </wpt>\n")
            }
            for (session in tracks.getAllSessions()) {
                val points = tracks.getPoints(session.id)
                if (points.isEmpty()) continue
                w.write("  <trk>\n")
                w.write("    <name>${escape("Drive " + iso.format(Date(session.startedAt)))}</name>\n")
                w.write("    <type>${escape(session.trigger)}</type>\n")
                w.write("    <trkseg>\n")
                for (p in points) {
                    w.write("""      <trkpt lat="${p.latitude}" lon="${p.longitude}">""" + "\n")
                    w.write("        <time>${iso.format(Date(p.timestamp))}</time>\n")
                    if (p.speedMps > 0) w.write("        <speed>${p.speedMps}</speed>\n")
                    w.write("      </trkpt>\n")
                }
                w.write("    </trkseg>\n  </trk>\n")
            }
            w.write("</gpx>\n")
        }
    }

    /** Coverage as GeoJSON: area outlines, every driven segment, and marked spots. */
    suspend fun writeGeoJson(out: OutputStream) = withContext(Dispatchers.IO) {
        out.writer().use { w ->
            w.write("""{"type":"FeatureCollection","features":[""")
            var first = true
            fun comma() { if (!first) w.write(","); first = false }

            val allAreas = coverage.getAreas()
            val nameById = allAreas.associate { it.id to it.name }
            for (area in allAreas) {
                val ring = ShapeText.decode(area.polygon)
                if (ring.size < 3) continue
                comma()
                // Level and parent go out by name so the file reads the same way the
                // desktop area builder writes one.
                w.write("{\"type\":\"Feature\",\"properties\":{\"kind\":\"area\",\"name\":" + quote(area.name))
                w.write(",\"level\":" + quote(area.areaLevel.name))
                area.parentId?.let { nameById[it] }?.let { w.write(",\"parent\":" + quote(it)) }
                w.write("},")
                w.write(""""geometry":{"type":"Polygon","coordinates":[[""")
                (ring + ring.first()).forEachIndexed { i, p -> if (i > 0) w.write(","); w.write(coord(p)) }
                w.write("]]}}")
            }
            for (edge in coverage.getAllDrivenEdges()) {
                val line = ShapeText.decode(edge.shape)
                if (line.size < 2) continue
                comma()
                w.write("""{"type":"Feature","properties":{"kind":"driven","name":${quote(edge.name ?: "")},"drivenAt":${edge.drivenAt},"wayId":${edge.wayId}},""")
                w.write(""""geometry":{"type":"LineString","coordinates":[""")
                line.forEachIndexed { i, p -> if (i > 0) w.write(","); w.write(coord(p)) }
                w.write("]}}")
            }
            for (poi in tracks.getAllPois()) {
                comma()
                w.write("""{"type":"Feature","properties":{"kind":"poi","note":${quote(poi.note ?: "")},"at":${poi.timestamp}},""")
                w.write(""""geometry":{"type":"Point","coordinates":${coord(LatLngPoint(poi.latitude, poi.longitude))}}}""")
            }
            w.write("]}")
        }
    }

    private fun coord(p: LatLngPoint) = "[${p.longitude},${p.latitude}]"

    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\""

    private fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    companion object {
        private const val TAG = "BackupManager"
        const val DB_NAME = "streetsweep.db"
        private val REQUIRED_TABLES = listOf("sessions", "points", "areas", "osm_ways", "driven_edges")
    }
}
