package net.streetsweep.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import android.util.Log
import androidx.sqlite.db.SupportSQLiteDatabase
import net.streetsweep.data.osm.ShapeText
import net.streetsweep.domain.RoadShape

@Database(
    entities = [
        TrackSession::class, TrackPoint::class, SnappedPoint::class,
        CoverageArea::class, AreaWay::class, OsmWay::class, StreetChunk::class, DrivenEdge::class,
        Poi::class, StreetExclusion::class, StreetCompletion::class, WayCoverage::class, AreaStatsCache::class,
        PendingDeletion::class,
        TeamEntity::class, DriveTypeEntity::class, VehicleEntity::class, MarkEntity::class, MarkOp::class,
        CoverageEntity::class, ProvisionalEntity::class, LegacyMark::class,
    ],
    version = 17,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun trackDao(): TrackDao
    abstract fun coverageDao(): CoverageDao
    abstract fun poiDao(): PoiDao
    abstract fun serverDao(): ServerDao

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

        /**
         * v10: an area remembers the outline the portal last sent for it. Nullable and
         * empty to begin with — nothing here has been pulled under this rule yet — so it
         * is a column added and nothing more.
         */
        @JvmField
        val MIGRATION_9_10 = object : Migration(9, 10) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `areas` ADD COLUMN `pulledOutline` TEXT")
            }
        }

        /** v11: streets marked complete by hand, shared with the server. A new table only. */
        @JvmField
        val MIGRATION_10_11 = object : Migration(10, 11) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `street_completions` (`wayId` INTEGER NOT NULL, " +
                        "`marked` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, `sent` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`wayId`))",
                )
            }
        }

        /**
         * v12: exclusions are shared with the server, so counting a street again keeps its
         * row (inactive) and every row knows when it last changed and whether it went up.
         * Existing exclusions are active, changed when they were made, and not yet sent.
         */
        @JvmField
        val MIGRATION_11_12 = object : Migration(11, 12) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `street_exclusions` ADD COLUMN `active` INTEGER NOT NULL DEFAULT 1")
                db.execSQL("ALTER TABLE `street_exclusions` ADD COLUMN `updatedAt` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `street_exclusions` ADD COLUMN `sent` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("UPDATE `street_exclusions` SET `updatedAt` = `excludedAt`")
            }
        }

        /**
         * v13: each street's driven length, overlap counted once. Filled here from the
         * segments already recorded, so no figure reads zero between the upgrade and the
         * next drive. A street whose shape cannot be read falls back to the old sum.
         */
        @JvmField
        val MIGRATION_12_13 = object : Migration(12, 13) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `way_coverage` (`wayId` INTEGER NOT NULL, " +
                        "`drivenMeters` REAL NOT NULL, PRIMARY KEY(`wayId`))",
                )
                val segments = HashMap<Long, MutableList<List<net.streetsweep.domain.LatLngPoint>>>()
                val sums = HashMap<Long, Double>()
                db.query("SELECT wayId, lengthMeters, shape FROM driven_edges").use { c ->
                    while (c.moveToNext()) {
                        val id = c.getLong(0)
                        sums[id] = (sums[id] ?: 0.0) + c.getDouble(1)
                        runCatching { ShapeText.decode(c.getString(2)) }.getOrNull()
                            ?.let { segments.getOrPut(id) { ArrayList() }.add(it) }
                    }
                }
                for (batch in sums.keys.chunked(400)) {
                    val shapes = HashMap<Long, Pair<Double, String>>()
                    db.query("SELECT id, lengthMeters, shape FROM osm_ways WHERE id IN (${batch.joinToString(",")})").use { c ->
                        while (c.moveToNext()) shapes[c.getLong(0)] = c.getDouble(1) to c.getString(2)
                    }
                    for (id in batch) {
                        val way = shapes[id]
                        val line = way?.let { runCatching { ShapeText.decode(it.second) }.getOrNull() }
                        val meters = if (way == null || line == null || line.size < 2) {
                            if (way != null) minOf(sums[id] ?: 0.0, way.first) else sums[id] ?: 0.0
                        } else {
                            minOf(net.streetsweep.domain.CoveredLength.of(line, segments[id].orEmpty()),
                                sums[id] ?: 0.0, way.first)
                        }
                        db.execSQL("INSERT OR REPLACE INTO way_coverage (wayId, drivenMeters) VALUES (?, ?)", arrayOf<Any>(id, meters))
                    }
                }
            }
        }

        /**
         * v14: areas can load their streets on demand, and every area's figures are kept in
         * area_stats instead of being added up on every change. Both start empty: the
         * figures are filled in the background and from the server at the next sync.
         */
        @JvmField
        val MIGRATION_13_14 = object : Migration(13, 14) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `areas` ADD COLUMN `onDemand` INTEGER NOT NULL DEFAULT 0")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `area_stats` (`areaId` INTEGER NOT NULL, `total` INTEGER NOT NULL, " +
                        "`done` INTEGER NOT NULL, `partial` INTEGER NOT NULL, `excluded` INTEGER NOT NULL, " +
                        "`metersTotal` REAL NOT NULL, `metersDriven` REAL NOT NULL, `source` TEXT NOT NULL, " +
                        "`updatedAt` INTEGER NOT NULL, PRIMARY KEY(`areaId`))",
                )
            }
        }

        /**
         * v15: areas can be hidden on the phone (the web deletes them), and drives and
         * places deleted here wait in pending_deletions until the server has been told.
         */
        val MIGRATION_14_15 = object : Migration(14, 15) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `areas` ADD COLUMN `hidden` INTEGER NOT NULL DEFAULT 0")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_deletions` (`kind` TEXT NOT NULL, `key` TEXT NOT NULL, " +
                        "`deletedAt` INTEGER NOT NULL, PRIMARY KEY(`kind`, `key`))",
                )
            }
        }

        /** v16: an area can come in several pieces (a county of islands). */
        val MIGRATION_15_16 = object : Migration(15, 16) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `areas` ADD COLUMN `morePieces` TEXT NOT NULL DEFAULT ''")
            }
        }

        /** A random (v4) uuid, made in SQL for rows that predate ids made on the phone. */
        private const val NEW_UUID =
            "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || " +
                "substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))"

        /**
         * v17: the phone moves onto the v2 server, which is the record for streets, areas,
         * coverage and marks (see v2/docs/APP-API.md).
         *  - Drives get an id, type, vehicle and upload state. Every drive already here
         *    starts "not uploaded": that is the one-time move of the history to v2, where
         *    the server matches it.
         *  - Places get an id and sharing; all start unsent.
         *  - v1's streets (whole OSM ways), areas, coverage and figures go: v2 sends its
         *    own, keyed by its ids, at the first sync.
         *  - Streets excluded or marked complete wait in legacy_marks (by OSM way) until
         *    v2's segments arrive, then become marks for the personal team.
         */
        val MIGRATION_16_17 = object : Migration(16, 17) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `sessions` ADD COLUMN `driveUuid` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `sessions` ADD COLUMN `driveTypeKey` TEXT")
                db.execSQL("ALTER TABLE `sessions` ADD COLUMN `vehicleId` TEXT")
                db.execSQL("ALTER TABLE `sessions` ADD COLUMN `uploadedAt` INTEGER")
                db.execSQL("ALTER TABLE `sessions` ADD COLUMN `serverStatus` TEXT")
                db.execSQL("UPDATE `sessions` SET `driveUuid` = $NEW_UUID")

                db.execSQL("ALTER TABLE `pois` ADD COLUMN `uuid` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `mine` INTEGER NOT NULL DEFAULT 1")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `ownerName` TEXT")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `teamIds` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `serverPhotos` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `pois` ADD COLUMN `dirty` INTEGER NOT NULL DEFAULT 1")
                db.execSQL("UPDATE `pois` SET `uuid` = $NEW_UUID, `photoSyncedAt` = 0")

                for (col in listOf("`version`", "`builtVersion`", "`packageVersion`", "`segmentCount`")) {
                    db.execSQL("ALTER TABLE `areas` ADD COLUMN $col INTEGER NOT NULL DEFAULT 0")
                }
                db.execSQL("ALTER TABLE `areas` ADD COLUMN `serverId` TEXT")
                db.execSQL("ALTER TABLE `areas` ADD COLUMN `teamIds` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `areas` ADD COLUMN `color` TEXT")
                db.execSQL("ALTER TABLE `osm_ways` ADD COLUMN `wayId` INTEGER")
                db.execSQL("ALTER TABLE `area_ways` ADD COLUMN `insideMeters` REAL")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_osm_ways_wayId` ON `osm_ways` (`wayId`)")

                db.execSQL("CREATE TABLE IF NOT EXISTS `legacy_marks` (`wayId` INTEGER NOT NULL, `kind` TEXT NOT NULL, `note` TEXT, PRIMARY KEY(`wayId`))")
                db.execSQL(
                    "INSERT OR REPLACE INTO `legacy_marks` (`wayId`, `kind`, `note`) " +
                        "SELECT `wayId`, 'excluded', COALESCE(`note`, `reason`) FROM `street_exclusions` WHERE `active` = 1",
                )
                db.execSQL(
                    "INSERT OR IGNORE INTO `legacy_marks` (`wayId`, `kind`, `note`) " +
                        "SELECT `wayId`, 'complete', NULL FROM `street_completions` WHERE `marked` = 1",
                )
                for (t in listOf("street_exclusions", "street_completions", "driven_edges", "way_coverage", "area_ways",
                        "osm_ways", "street_chunks", "area_stats", "areas", "snapped_points", "pending_deletions")) {
                    db.execSQL("DELETE FROM `$t`")
                }

                db.execSQL("CREATE TABLE IF NOT EXISTS `teams` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `kind` TEXT NOT NULL, `role` TEXT NOT NULL, `sort` INTEGER NOT NULL, PRIMARY KEY(`id`))")
                db.execSQL("CREATE TABLE IF NOT EXISTS `drive_types` (`key` TEXT NOT NULL, `label` TEXT NOT NULL, `sort` INTEGER NOT NULL, `teamCounts` TEXT NOT NULL, PRIMARY KEY(`key`))")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `vehicles` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `kind` TEXT NOT NULL, `teamId` TEXT NOT NULL, " +
                        "`teamName` TEXT NOT NULL, `teamKind` TEXT NOT NULL, `permanent` INTEGER NOT NULL, `checkoutUserId` TEXT, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE TABLE IF NOT EXISTS `marks` (`teamId` TEXT NOT NULL, `segmentId` INTEGER NOT NULL, `kind` TEXT NOT NULL, `note` TEXT, PRIMARY KEY(`teamId`, `segmentId`))")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `mark_ops` (`teamId` TEXT NOT NULL, `segmentId` INTEGER NOT NULL, `kind` TEXT, `note` TEXT, " +
                        "`at` INTEGER NOT NULL, PRIMARY KEY(`teamId`, `segmentId`))",
                )
                db.execSQL("CREATE TABLE IF NOT EXISTS `coverage` (`teamId` TEXT NOT NULL, `segmentId` INTEGER NOT NULL, `drivenAt` INTEGER NOT NULL, PRIMARY KEY(`teamId`, `segmentId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_coverage_segmentId` ON `coverage` (`segmentId`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `provisional` (`sessionId` INTEGER NOT NULL, `segmentId` INTEGER NOT NULL, `drivenAt` INTEGER NOT NULL, PRIMARY KEY(`sessionId`, `segmentId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_provisional_segmentId` ON `provisional` (`segmentId`)")
            }
        }

        /** Hand-written migrations, oldest first. Add one for each version bump. */
        val MIGRATIONS: Array<Migration> =
            arrayOf(MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8, MIGRATION_8_9,
                MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13, MIGRATION_13_14,
                MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17)

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
