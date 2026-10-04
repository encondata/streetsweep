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
import com.example.streetsweep.data.server.Segments
import com.example.streetsweep.data.server.ServerException
import com.example.streetsweep.domain.ChunkGrid
import com.example.streetsweep.tracking.Notifications
import kotlinx.coroutines.flow.first

/**
 * Brings an area's streets onto the phone, from the server (v2): the whole area as one
 * package when it's a neighbourhood, city or county, or, for anything bigger, 0.1° cells
 * as the phone drives through it and as its map is looked at (see [NearbyStreets]).
 * The phone never asks OpenStreetMap itself.
 *
 * One queue for areas, one for nearby cells, so a long area download never holds up the
 * streets round the car. Nothing here returns failure: on a queue a failed job fails every
 * job behind it, so a problem is written on the area, where it shows, and the queue moves on.
 */
class StreetDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        inputData.getString(KEY_CELLS)?.let { return loadCells(it.split(',').filter { k -> k.isNotBlank() }) }
        val areaId = inputData.getLong(KEY_AREA_ID, -1L)
        if (areaId < 0) return Result.success()
        val container = applicationContext.appContainer
        val repo: CoverageRepository = container.coverageRepository
        val area = repo.getArea(areaId) ?: return Result.success()   // gone since it was queued
        val serverId = area.serverId ?: return Result.success()
        if (area.segmentCount > WHOLE_AREA_SEGMENTS) return onDemand(repo, area.id, area.cells().size)
        if (area.packageVersion == area.builtVersion && area.streetsLoadedAt != null) return Result.success()

        runCatching { setForeground(foregroundInfo(area.name, 0, 1)) }
        repo.setProgress(areaId, 1, 0)
        return try {
            val etag = if (area.packageVersion > 0) "\"$serverId-${area.packageVersion}\"" else null
            val pkg = container.server.areaPackage(serverId, etag)
            pkg.body?.let { body ->
                val segments = Segments.parse(body)
                repo.storeAreaPackage(areaId, segments, body.optInt("version", area.builtVersion))
                container.sync.afterStreetsStored()
            } ?: repo.setProgress(areaId, 1, 1, loadedAt = System.currentTimeMillis())
            Result.success()
        } catch (e: ServerException) {
            when (e.code) {
                "too_big" -> onDemand(repo, area.id, area.cells().size)
                // The server is still listing its streets: try again shortly.
                "not_built" -> { repo.setProgress(areaId, 1, 0, error = "Waiting for the server to list its streets"); Result.retry() }
                else -> giveUpOrRetry(repo, areaId, e)
            }
        } catch (e: Exception) {
            giveUpOrRetry(repo, areaId, e)
        }
    }

    private suspend fun giveUpOrRetry(repo: CoverageRepository, areaId: Long, e: Exception): Result {
        Log.w(TAG, "Area $areaId download failed", e)
        return if (runAttemptCount + 1 < MAX_RUN_ATTEMPTS) {
            repo.setProgress(areaId, 1, 0, error = "Waiting to retry: ${e.message ?: "download failed"}")
            Result.retry()
        } else {
            repo.setProgress(areaId, 1, 0, error = e.message ?: "Download failed")
            Result.success()
        }
    }

    /** Too big to download whole: its streets load as needed. */
    private suspend fun onDemand(repo: CoverageRepository, areaId: Long, cells: Int): Result {
        val area = repo.getArea(areaId) ?: return Result.success()
        val held = repo.freshChunkCount(area.cells().map { it.key }, System.currentTimeMillis() - CHUNK_TTL_MS)
        repo.setOnDemand(areaId, cells, held)
        return Result.success()
    }

    /** The cells near the car or on the map, for on-demand areas. */
    private suspend fun loadCells(keys: List<String>): Result {
        val container = applicationContext.appContainer
        val repo = container.coverageRepository
        val now = System.currentTimeMillis()
        var stored = false
        for (key in keys) {
            val cell = ChunkGrid.cellForKey(key) ?: continue
            val existing = repo.getChunk(key)
            if (existing != null && now - existing.loadedAt <= CHUNK_TTL_MS) continue
            try {
                val b = cell.bounds
                repo.storeCell(key, Segments.parse(container.server.segmentsInBox(b.west, b.south, b.east, b.north)))
                stored = true
            } catch (e: Exception) {
                Log.w(TAG, "nearby cell $key failed: ${e.message}")
                // Asked for again the next time the phone is near it.
            }
        }
        if (stored) container.sync.afterStreetsStored()
        repo.refreshOnDemandCounts(now - CHUNK_TTL_MS)
        return Result.success()
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
        /** Past this an area loads as needed rather than whole (the server's package limit). */
        const val WHOLE_AREA_SEGMENTS = 250_000
        private const val NEARBY_QUEUE = "street-nearby"
        const val KEY_DONE = "done"
        const val KEY_TOTAL = "total"
        const val CHUNK_TTL_MS = 30L * 24 * 60 * 60 * 1000
        private const val MAX_RUN_ATTEMPTS = 8
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
