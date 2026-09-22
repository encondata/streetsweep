package com.example.streetsweep.data.backup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackupFilesTest {
    // 2026-09-22T12:00:00Z is fixed, but the names use local time, so only check the shape.
    private val at = 1_790_000_000_000L

    @Test
    fun `names carry a sortable timestamp`() {
        val a = BackupFiles.database(at)
        val b = BackupFiles.database(at + 86_400_000L)
        assertTrue(a.startsWith("streetsweep-backup-"))
        assertTrue(a.endsWith(".db"))
        assertTrue("a day later must sort after", b > a)
    }

    @Test
    fun `only our own backups are recognised for trimming`() {
        assertTrue(BackupFiles.isDatabaseBackup(BackupFiles.database(at)))
        assertFalse(BackupFiles.isDatabaseBackup(BackupFiles.gpx(at)))
        assertFalse(BackupFiles.isDatabaseBackup("holiday-photos.db"))
        assertFalse(BackupFiles.isDatabaseBackup(null))
    }

    @Test
    fun `each export kind has its own name and type`() {
        assertTrue(BackupFiles.gpx(at).endsWith(".gpx"))
        assertTrue(BackupFiles.geoJson(at).endsWith(".geojson"))
        assertEquals("application/gpx+xml", BackupFiles.GPX_MIME)
        assertEquals("application/geo+json", BackupFiles.GEOJSON_MIME)
    }
}
