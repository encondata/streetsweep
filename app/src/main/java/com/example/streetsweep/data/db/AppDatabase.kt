package com.example.streetsweep.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import android.util.Log
import androidx.sqlite.db.SupportSQLiteDatabase
import com.example.streetsweep.data.osm.ShapeText
import com.example.streetsweep.domain.RoadShape

@Database(
    entities = [
        TrackSession::class, TrackPoint::class, SnappedPoint::class,
        CoverageArea::class, AreaWay::class, OsmWay::class, StreetChunk::class, DrivenEdge::class,
        Poi::class, StreetExclusion::class,
    ],
    version = 9,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun trackDao(): TrackDao
    abstract fun coverageDao(): CoverageDao
    abstract fun poiDao(): PoiDao

    companion object {
        /** v5: points of interest. Must match the exported schema in app/schemas/…/5.json exactly. */
        private val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pois` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`latitude` REAL NOT NULL, `longitude` REAL NOT NULL, `accuracyMeters` REAL NOT NULL, " +
                        "`timestamp` INTEGER NOT NULL, `note` TEXT, `sessionId` INTEGER)",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_pois_latitude_longitude` ON `pois` (`latitude`, `longitude`)")
            }
        }

        /** v6: per-street exclusions (gated communities, private roads, streets not worth sweeping). */
        private val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `street_exclusions` (`wayId` INTEGER NOT NULL, " +
                        "`reason` TEXT NOT NULL, `note` TEXT, `excludedAt` INTEGER NOT NULL, PRIMARY KEY(`wayId`))",
                )
            }
        }

        /** v7: a marked place can be named, photographed, and edited from either side. */
        private val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `name` TEXT")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `photoPath` TEXT")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `photoSyncedAt` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `updatedAt` INTEGER NOT NULL DEFAULT 0")
                // Existing places were last touched when they were marked.
                db.execSQL("UPDATE `pois` SET `updatedAt` = `timestamp`")
            }
        }

        /** v8: a drive can be paused, and the time spent paused is not driving time. */
        private val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `sessions` ADD COLUMN `pausedMs` INTEGER NOT NULL DEFAULT 0")
            }
        }

        /**
         * v9: a street can say how much of it counts as finished.
         *
         * A traffic circle cannot be driven all the way round — you come in one road and
         * leave by another — so it never reached the flat 80% and guidance kept sending
         * people back to circles they had already swept.
         *
         * Existing ways are reclassified in place rather than waiting for a re-download.
         * Only ways whose bounding box is small enough to hold a circle are decoded: a
         * 150 m ring is about 0.0005 degrees across, so the rest are skipped without
         * reading their shape at all.
         */
        @JvmField
        val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE `osm_ways` ADD COLUMN `minDoneFraction` REAL NOT NULL DEFAULT " +
                        RoadShape.DEFAULT_DONE_FRACTION,
                )
                val candidates = db.query(
                    """
                    SELECT id, lengthMeters, shape FROM osm_ways
                     WHERE lengthMeters > 0 AND lengthMeters <= 150
                       AND (maxLat - minLat) < 0.0025 AND (maxLng - minLng) < 0.0025
                    """.trimIndent(),
                )
                val circles = ArrayList<Long>()
                var unreadable = 0
                candidates.use { c ->
                    while (c.moveToNext()) {
                        // One unreadable shape must not stop the migration: failing here
                        // leaves the database half-upgraded and the app unable to open.
                        // A way that cannot be read simply keeps the ordinary threshold.
                        val shape = runCatching { ShapeText.decode(c.getString(2)) }.getOrNull()
                        if (shape == null) { unreadable++; continue }
                        if (RoadShape.isTrafficCircle(c.getDouble(1), shape)) circles += c.getLong(0)
                    }
                }
                // Chunked: SQLite will not take an unbounded list of parameters.
                circles.chunked(500).forEach { batch ->
                    db.execSQL(
                        "UPDATE osm_ways SET minDoneFraction = ${RoadShape.CIRCLE_DONE_FRACTION} " +
                            "WHERE id IN (${batch.joinToString(",")})",
                    )
                }
                Log.i(
                    "AppDatabase",
                    "v9: ${circles.size} traffic circles reclassified" +
                        if (unreadable > 0) ", $unreadable shapes unreadable" else "",
                )
            }
        }

        /** Hand-written migrations, oldest first. Add one for each version bump. */
        val MIGRATIONS: Array<Migration> =
            arrayOf(MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8, MIGRATION_8_9)

        fun build(context: Context): AppDatabase =
            // The phone now holds real drives and areas. Every schema change from version 4 on
            // must ship a Migration (or an @AutoMigration backed by app/schemas); there is
            // deliberately no destructive fallback, so a missing migration fails loudly in
            // development instead of silently wiping the user's data.
            Room.databaseBuilder(context, AppDatabase::class.java, "streetsweep.db")
                .addMigrations(*MIGRATIONS)
                .build()
    }
}
