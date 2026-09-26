package com.example.streetsweep.data.osm

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.NetworkType
import java.util.concurrent.TimeUnit
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.example.streetsweep.appContainer
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.domain.ChunkGrid
import com.example.streetsweep.tracking.Notifications
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first

/**
 * Downloads the street network for an area, one 0.1° grid cell at a time, so a metro-sized
 * request becomes a hundred small ones the public Overpass server will actually answer.
 * Cells fetched in the last [CHUNK_TTL_MS] (for any area) are reused. Progress is written to
 * the area row so the UI can show it, and the job resumes where it left off if re-run.
 *
 * Areas download one after another, on a single queue. They used to each get a job of
 * their own, which was fine while areas were added one at a time and fell apart the first
 * time a sync brought down 108 of them: 108 jobs hit the free Overpass server at once, it
 * answered 429 and then stopped accepting connections, and 106 areas failed for good. On
 * one queue, neighbouring areas also reuse the cells the one before them fetched, instead
 * of all asking for the same cell together.
 */
class StreetDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // Nothing here may return failure. On a queue, a failed job fails every job behind
        // it, so one bad area would take every other area's download down with it. A problem
        // with this area is written on the area, where it shows, and the queue moves on.
        inputData.getString(KEY_CELLS)?.let { return loadCells(it.split(',').filter { k -> k.isNotBlank() }) }
        val areaId = inputData.getLong(KEY_AREA_ID, -1L)
        if (areaId < 0) return Result.success()
        val container = applicationContext.appContainer
        val repo: CoverageRepository = container.coverageRepository
        val area = repo.getArea(areaId) ?: return Result.success()   // deleted since it was queued

        val cells = ChunkGrid.cellsFor(area.bounds)
        // A big area, with a server to load from as needed, is not downloaded whole: its
        // streets arrive as the phone drives through it and as its map is looked at.
        if (cells.size > WHOLE_AREA_CELLS && serverSet()) {
            val held = repo.freshChunkCount(cells.map { it.key }, System.currentTimeMillis() - CHUNK_TTL_MS)
            repo.setOnDemand(areaId, cells.size, held)
            return Result.success()
        }
        if (cells.size > MAX_CELLS) {
            repo.setProgress(areaId, cells.size, 0, error = "Area too large (${cells.size} cells; limit $MAX_CELLS). Split it into cities.")
            return Result.success()
        }
        runCatching { setForeground(foregroundInfo(area.name, 0, cells.size)) }
        repo.setProgress(areaId, cells.size, 0)

        var done = 0
        val now = System.currentTimeMillis()
        for (cell in cells) {
            val existing = repo.getChunk(cell.key)
            if (existing == null || now - existing.loadedAt > CHUNK_TTL_MS) {
                try {
                    val streets = fetchWithRetry(cell)
                    repo.storeChunk(cell.key, streets)
                } catch (e: Exception) {
                    Log.w(TAG, "Cell ${cell.key} failed", e)
                    // Almost always the server being busy or unreachable, which passes. Wait and
                    // try this area again, holding the queue behind it — there is no point
                    // asking for the next area from a server that is refusing this one. After a
                    // few runs, give up on it and let the rest through.
                    return if (runAttemptCount + 1 < MAX_RUN_ATTEMPTS) {
                        repo.setProgress(areaId, cells.size, done, error = "Waiting to retry: ${e.message ?: "download failed"}")
                        Result.retry()
                    } else {
                        repo.setProgress(areaId, cells.size, done, error = e.message ?: "Download failed")
                        Result.success()
                    }
                }
                delay(pauseBetweenCells())
            }
            done++
            repo.setProgress(areaId, cells.size, done)
            runCatching { setForeground(foregroundInfo(area.name, done, cells.size)) }
            setProgress(workDataOf(KEY_DONE to done, KEY_TOTAL to cells.size))
        }
        repo.setProgress(areaId, cells.size, done, loadedAt = System.currentTimeMillis())
        return Result.success()
    }

    /**
     * One cell's streets. With a server to ask, from the server — never OpenStreetMap —
     * so each cell is downloaded once, by the server, for every phone and the web map.
     * Only a phone with no server at all goes to OpenStreetMap itself.
     *
     * A server that cannot reach OpenStreetMap is retried like any other failure, not
     * worked around by going there directly: the whole point is that phones do not.
     */
    private suspend fun fetchCell(cell: ChunkGrid.Cell): List<OsmStreet> {
        val container = applicationContext.appContainer
        val s = container.settings.current()
        // Signed in: the server fetches each cell from OpenStreetMap once and every phone
        // shares it. Only a server too old to have the street store sends us to Overpass.
        if (!s.portalUrl.isNullOrBlank() && !s.portalToken.isNullOrBlank()) {
            container.portalClient.streetCell(cell.key)?.let { return OverpassClient.parse(it) }
            Log.w(TAG, "Server has no street store yet; asking OpenStreetMap for ${cell.key}")
        }
        return container.overpass.streetsIn(cell.bounds)
    }

    /**
     * The streets near where the phone is, or of the map on screen, for areas that load on
     * demand. No area progress to write: each on-demand area's count of cells held is
     * brought up to date at the end instead.
     */
    private suspend fun loadCells(keys: List<String>): Result {
        val repo = applicationContext.appContainer.coverageRepository
        val now = System.currentTimeMillis()
        for (key in keys) {
            val cell = ChunkGrid.cellForKey(key) ?: continue
            val existing = repo.getChunk(key)
            if (existing != null && now - existing.loadedAt <= CHUNK_TTL_MS) continue
            try {
                repo.storeChunk(key, fetchWithRetry(cell))
            } catch (e: Exception) {
                Log.w(TAG, "nearby cell $key failed: ${e.message}")
                // Asked for again the next time the phone is near it.
            }
            delay(pauseBetweenCells())
        }
        repo.refreshOnDemandCounts(now - CHUNK_TTL_MS)
        return Result.success()
    }

    private suspend fun serverSet(): Boolean = applicationContext.appContainer.settings.current()
        .let { !it.portalUrl.isNullOrBlank() && !it.portalToken.isNullOrBlank() }

    /** A breath between cells: a long one for OpenStreetMap itself, a short one for our server. */
    private suspend fun pauseBetweenCells(): Long = if (serverSet()) PAUSE_FROM_SERVER_MS else PAUSE_BETWEEN_CELLS_MS

    private suspend fun fetchWithRetry(cell: ChunkGrid.Cell): List<OsmStreet> {
        var last: Exception? = null
        repeat(ATTEMPTS) { attempt ->
            try {
                return fetchCell(cell)
            } catch (e: Exception) {
                last = e
                Log.w(TAG, "Cell ${cell.key} attempt ${attempt + 1} failed: ${e.message}")
                // A 429 is the server asking outright for a minute's quiet; give it that
                // rather than the shorter wait meant for a dropped connection.
                val rateLimited = e.message?.contains("429") == true
                delay(if (rateLimited) RATE_LIMIT_DELAY_MS else RETRY_DELAY_MS * (attempt + 1))
            }
        }
        throw last ?: OverpassException("Download failed")
    }

    private fun foregroundInfo(name: String, done: Int, total: Int): ForegroundInfo {
        val notification = Notifications.download(applicationContext, name, done, total)
        // Android 14+ refuses a foreground service without a declared type.
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(Notifications.ID_DOWNLOAD, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(Notifications.ID_DOWNLOAD, notification)
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo("streets", 0, 0)

    companion object {
        private const val TAG = "StreetDownload"
        const val KEY_AREA_ID = "areaId"
        const val KEY_CELLS = "cells"
        /** Over this many cells, an area on a server loads as needed rather than whole. */
        const val WHOLE_AREA_CELLS = 12
        private const val PAUSE_FROM_SERVER_MS = 250L
        private const val NEARBY_QUEUE = "street-nearby"
        const val KEY_DONE = "done"
        const val KEY_TOTAL = "total"
        const val MAX_CELLS = 400
        const val CHUNK_TTL_MS = 30L * 24 * 60 * 60 * 1000
        private const val PAUSE_BETWEEN_CELLS_MS = 1_500L
        private const val ATTEMPTS = 4
        private const val RETRY_DELAY_MS = 15_000L
        private const val RATE_LIMIT_DELAY_MS = 65_000L
        private const val MAX_RUN_ATTEMPTS = 5
        private const val QUEUE = "street-downloads"

        /** Adds an area to the back of the one download queue. */
        fun enqueue(context: Context, areaId: Long) {
            val request = OneTimeWorkRequestBuilder<StreetDownloadWorker>()
                .setInputData(Data.Builder().putLong(KEY_AREA_ID, areaId).build())
                // Wait for a network rather than failing for the lack of one.
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 2, TimeUnit.MINUTES)
                // The only way to see later which area a queued job is for: WorkInfo shows
                // tags, not input data.
                .addTag(areaTag(areaId))
                .build()
            val wm = WorkManager.getInstance(context)
            // Jobs from before the queue were named per area and ran side by side.
            wm.cancelUniqueWork("streets-$areaId")
            wm.enqueueUniqueWork(QUEUE, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }

        private fun areaTag(id: Long) = "area-$id"

        /**
         * Cells to load now, for on-demand areas: on a queue of their own, so the streets
         * round the car are not stuck behind a long area download.
         */
        fun enqueueCells(context: Context, keys: Collection<String>) {
            if (keys.isEmpty()) return
            val request = OneTimeWorkRequestBuilder<StreetDownloadWorker>()
                .setInputData(Data.Builder().putString(KEY_CELLS, keys.joinToString(",")).build())
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NEARBY_QUEUE, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }

        /**
         * Queues each area not already waiting, and returns how many were added. Checking
         * matters: an area is unfinished for as long as it sits in the queue, so without it
         * every sync during a long download would add the same areas again behind it.
         */
        suspend fun enqueueAll(context: Context, ids: Collection<Long>): Int {
            val wm = WorkManager.getInstance(context)
            val waiting: Set<Long> = runCatching {
                wm.getWorkInfosForUniqueWorkFlow(QUEUE).first()
                    .filter { info -> !info.state.isFinished }
                    .flatMap { info -> info.tags }
                    .filter { tag -> tag.startsWith("area-") }
                    .mapNotNull { tag -> tag.removePrefix("area-").toLongOrNull() }
                    .toSet()
            }.getOrDefault(emptySet())
            var added = 0
            for (id in ids.distinct()) {
                if (id in waiting) continue
                enqueue(context, id)
                added++
            }
            return added
        }
    }
}
