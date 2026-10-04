package net.streetsweep.data.db

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The move onto the v2 server. This is the one that carries a phone's whole history
 * across: every drive and its points must survive, each with an id of its own and
 * waiting to go up; places likewise; and streets excluded or marked complete must wait
 * in legacy_marks for their segments rather than vanish with v1's street tables.
 */
@RunWith(AndroidJUnit4::class)
class Migration16To17Test {
    private companion object {
        const val DB = "migration-16-17.db"
        val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    }

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        AppDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    @Test
    fun history_survives_and_waits_to_go_up() {
        helper.createDatabase(DB, 16).use { old ->
            for (id in 1..2) {
                old.execSQL("INSERT INTO sessions (id, startedAt, endedAt, `trigger`, pointCount, distanceMeters, snappedRawCount, newSegments, newMeters, pausedMs) VALUES ($id, ${id * 1000}, ${id * 1000 + 500}, 'MANUAL', 2, 30.0, 2, 1, 30.0, 0)")
                old.execSQL("INSERT INTO points (sessionId, latitude, longitude, accuracyMeters, speedMps, bearing, timestamp) VALUES ($id, 30.0, -97.0, 5, 10, 0, ${id * 1000})")
                old.execSQL("INSERT INTO points (sessionId, latitude, longitude, accuracyMeters, speedMps, bearing, timestamp) VALUES ($id, 30.001, -97.0, 5, 10, 0, ${id * 1000 + 100})")
            }
            old.execSQL("INSERT INTO pois (latitude, longitude, accuracyMeters, timestamp, note, sessionId, name, photoPath, photoSyncedAt, updatedAt) VALUES (30.0, -97.0, 5, 1, 'deep', 1, 'Pothole', NULL, 5, 1)")
            old.execSQL("INSERT INTO street_exclusions (wayId, reason, note, excludedAt, active, updatedAt, sent) VALUES (11, 'GATED', NULL, 1, 1, 1, 1)")
            old.execSQL("INSERT INTO street_exclusions (wayId, reason, note, excludedAt, active, updatedAt, sent) VALUES (12, 'OTHER', 'n', 1, 0, 1, 1)")
            old.execSQL("INSERT INTO street_completions (wayId, marked, updatedAt, sent) VALUES (13, 1, 1, 1)")
            old.execSQL("INSERT INTO osm_ways (id, name, highway, lengthMeters, shape, minLat, minLng, maxLat, maxLng, cLat, cLng, loadedAt, minDoneFraction) VALUES (11, 'A', 'residential', 10, '30,-97;30.0001,-97', 30, -97, 30.0001, -97, 30, -97, 1, 0.8)")
            old.execSQL("INSERT INTO areas (name, level, polygon, south, west, north, east, createdAt, chunksTotal, chunksDone, onDemand, hidden, morePieces) VALUES ('Old', 0, '30,-97;30.1,-97;30.1,-96.9', 30, -97, 30.1, -96.9, 1, 0, 0, 0, 0, '')")
        }

        val db = helper.runMigrationsAndValidate(DB, 17, true, AppDatabase.MIGRATION_16_17)

        db.query("SELECT driveUuid, uploadedAt FROM sessions ORDER BY id").use { c ->
            val ids = ArrayList<String>()
            while (c.moveToNext()) {
                ids += c.getString(0)
                assertTrue("every drive waits to go up", c.isNull(1))
            }
            assertEquals(2, ids.size)
            ids.forEach { assertTrue("a real v4 uuid: $it", UUID.matches(it)) }
            assertNotEquals("each drive its own id", ids[0], ids[1])
        }
        db.query("SELECT count(*) FROM points").use { c -> c.moveToFirst(); assertEquals("no point lost", 4, c.getInt(0)) }
        db.query("SELECT uuid, mine, dirty, photoSyncedAt FROM pois").use { c ->
            c.moveToFirst()
            assertTrue(UUID.matches(c.getString(0)))
            assertEquals(1, c.getInt(1))
            assertEquals("waits to go up", 1, c.getInt(2))
            assertEquals("its photo goes up again, to v2", 0, c.getLong(3))
        }
        db.query("SELECT wayId, kind FROM legacy_marks ORDER BY wayId").use { c ->
            val rows = ArrayList<Pair<Long, String>>()
            while (c.moveToNext()) rows += c.getLong(0) to c.getString(1)
            assertEquals("the active exclusion and the completion; not the cleared exclusion",
                listOf(11L to "excluded", 13L to "complete"), rows)
        }
        db.query("SELECT note FROM legacy_marks WHERE wayId = 11").use { c -> c.moveToFirst(); assertEquals("the reason stands in for a missing note", "GATED", c.getString(0)) }
        for (t in listOf("osm_ways", "areas", "street_exclusions", "street_completions")) {
            db.query("SELECT count(*) FROM $t").use { c -> c.moveToFirst(); assertEquals("v1's $t is cleared for v2's", 0, c.getInt(0)) }
        }
    }
}
