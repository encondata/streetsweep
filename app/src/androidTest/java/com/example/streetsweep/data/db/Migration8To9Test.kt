package com.example.streetsweep.data.db

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.streetsweep.domain.RoadShape
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The upgrade that teaches a street how much of it counts as finished.
 *
 * Worth a real test rather than a careful read: the phone this runs on holds months of
 * driving and there is deliberately no destructive fallback, so a migration that throws
 * does not lose the data quietly — it stops the app opening at all.
 *
 * The shapes below are the genuine article, lifted from the April Sound fixture: way
 * 944277187 is a 47.8 m traffic circle, and 21847318 is an ordinary 188 m street.
 */
@RunWith(AndroidJUnit4::class)
class Migration8To9Test {

    private companion object {
        const val DB = "migration-test.db"

        /** Way 944277187 exactly as the fixture has it: a 47.8 m ring. */
        const val CIRCLE_SHAPE =
                "30.363009,-95.6023247;30.3630308,-95.6023264;30.3630519,-95.60232;" +
                    "30.3630702,-95.6023063;30.3630839,-95.6022865;30.3630916,-95.6022628;" +
                    "30.3630922,-95.6022356;30.3630849,-95.6022098;30.3630705,-95.6021884;" +
                    "30.3630508,-95.6021737;30.3630279,-95.6021677;30.3630046,-95.6021709;" +
                    "30.3629836,-95.602183;30.3629674,-95.6022026;30.3629577,-95.6022274;" +
                    "30.3629558,-95.6022526;30.3629607,-95.6022772;30.3629721,-95.6022989;" +
                    "30.3629887,-95.6023152;30.363009,-95.6023247"

        /** Way 21847318: an ordinary 188 m street, open at both ends. */
        const val STREET_SHAPE =
                "30.3630794,-95.6054928;30.3624066,-95.6051024;30.3623935,-95.605047;" +
                    "30.3624167,-95.6049854;30.3624642,-95.604965;30.3627937,-95.6051349;" +
                    "30.363174,-95.605341"
    }

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        AppDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    private fun insertWay(
        db: androidx.sqlite.db.SupportSQLiteDatabase,
        id: Long,
        length: Double,
        shape: String,
    ) {
        val points = shape.split(';').map {
            val comma = it.indexOf(',')
            it.substring(0, comma).toDouble() to it.substring(comma + 1).toDouble()
        }
        val lats = points.map { it.first }
        val lngs = points.map { it.second }
        db.execSQL(
            """
            INSERT INTO osm_ways
              (id, name, highway, lengthMeters, shape, minLat, minLng, maxLat, maxLng, cLat, cLng, loadedAt)
            VALUES ($id, 'Test', 'residential', $length, '$shape',
                    ${lats.min()}, ${lngs.min()}, ${lats.max()}, ${lngs.max()},
                    ${lats.average()}, ${lngs.average()}, 1)
            """.trimIndent(),
        )
    }

    @Test
    fun circles_are_reclassified_and_ordinary_streets_are_left_alone() {
        helper.createDatabase(DB, 8).use { old ->
            insertWay(old, 944277187L, 47.751, CIRCLE_SHAPE)
            insertWay(old, 21847318L, 188.041, STREET_SHAPE)
        }

        val db = helper.runMigrationsAndValidate(DB, 9, true, AppDatabase.MIGRATION_8_9)

        db.query("SELECT id, minDoneFraction FROM osm_ways ORDER BY id").use { c ->
            val found = HashMap<Long, Double>()
            while (c.moveToNext()) found[c.getLong(0)] = c.getDouble(1)

            assertEquals("both ways should survive the upgrade", 2, found.size)
            assertEquals(
                "the traffic circle should need only a quarter",
                RoadShape.CIRCLE_DONE_FRACTION, found[944277187L]!!, 1e-9,
            )
            assertEquals(
                "an ordinary street should keep the usual bar",
                RoadShape.DEFAULT_DONE_FRACTION, found[21847318L]!!, 1e-9,
            )
        }
    }

    /** An unreadable shape must cost that one way its reclassification, and nothing else. */
    @Test
    fun a_broken_shape_does_not_stop_the_upgrade() {
        helper.createDatabase(DB, 8).use { old ->
            insertWay(old, 944277187L, 47.751, CIRCLE_SHAPE)
            old.execSQL(
                """
                INSERT INTO osm_ways
                  (id, name, highway, lengthMeters, shape, minLat, minLng, maxLat, maxLng, cLat, cLng, loadedAt)
                VALUES (999, 'Broken', 'residential', 50.0, 'not a shape at all',
                        30.38, -95.61, 30.3801, -95.6099, 30.38, -95.61, 1)
                """.trimIndent(),
            )
        }

        val db = helper.runMigrationsAndValidate(DB, 9, true, AppDatabase.MIGRATION_8_9)

        db.query("SELECT count(*) FROM osm_ways").use { c ->
            c.moveToFirst()
            assertEquals("nothing should be lost", 2, c.getInt(0))
        }
        db.query("SELECT minDoneFraction FROM osm_ways WHERE id = 944277187").use { c ->
            c.moveToFirst()
            assertEquals(RoadShape.CIRCLE_DONE_FRACTION, c.getDouble(0), 1e-9)
        }
    }
}
