package com.example.streetsweep.data.backup

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Names for the files StreetSweep writes out, so a folder of them sorts by date. */
object BackupFiles {
    const val DATABASE_MIME = "application/octet-stream"
    const val GPX_MIME = "application/gpx+xml"
    const val GEOJSON_MIME = "application/geo+json"

    private fun stamp(at: Long = System.currentTimeMillis()) =
        SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).format(Date(at))

    fun database(at: Long = System.currentTimeMillis()) = "streetsweep-backup-${stamp(at)}.db"
    fun gpx(at: Long = System.currentTimeMillis()) = "streetsweep-drives-${stamp(at)}.gpx"
    fun geoJson(at: Long = System.currentTimeMillis()) = "streetsweep-coverage-${stamp(at)}.geojson"

    /** Backups this app made, oldest first, used when trimming a folder. */
    fun isDatabaseBackup(name: String?) = name != null && name.startsWith("streetsweep-backup-") && name.endsWith(".db")
}
