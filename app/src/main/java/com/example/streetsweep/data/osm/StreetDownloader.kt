package com.example.streetsweep.data.osm

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
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

/**
 * Downloads the street network for an area, one 0.1° grid cell at a time, so a metro-sized
 * request becomes a hundred small ones the public Overpass server will actually answer.
 * Cells fetched in the last [CHUNK_TTL_MS] (for any area) are reused. Progress is written to
 * the area row so the UI can show it, and the job resumes where it left off if re-run.
 */
class StreetDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val areaId = inputData.getLong(KEY_AREA_ID, -1L)
        if (areaId < 0) return Result.failure()
        val container = applicationContext.appContainer
        val repo: CoverageRepository = container.coverageRepository
        val area = repo.getArea(areaId) ?: return Result.failure()

        val cells = ChunkGrid.cellsFor(area.bounds)
        if (cells.size > MAX_CELLS) {
            repo.setProgress(areaId, cells.size, 0, error = "Area too large (${cells.size} cells; limit $MAX_CELLS). Split it into cities.")
            return Result.failure()
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
                    repo.setProgress(areaId, cells.size, done, error = e.message ?: "Download failed")
                    return Result.failure()
                }
                delay(PAUSE_BETWEEN_CELLS_MS)
            }
            done++
            repo.setProgress(areaId, cells.size, done)
            runCatching { setForeground(foregroundInfo(area.name, done, cells.size)) }
            setProgress(workDataOf(KEY_DONE to done, KEY_TOTAL to cells.size))
        }
        repo.setProgress(areaId, cells.size, done, loadedAt = System.currentTimeMillis())
        return Result.success()
    }

    private suspend fun fetchWithRetry(cell: ChunkGrid.Cell): List<OsmStreet> {
        var last: Exception? = null
        repeat(ATTEMPTS) { attempt ->
            try {
                return applicationContext.appContainer.overpass.streetsIn(cell.bounds)
            } catch (e: Exception) {
                last = e
                Log.w(TAG, "Cell ${cell.key} attempt ${attempt + 1} failed: ${e.message}")
                delay(RETRY_DELAY_MS * (attempt + 1))
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
        const val KEY_DONE = "done"
        const val KEY_TOTAL = "total"
        const val MAX_CELLS = 400
        const val CHUNK_TTL_MS = 30L * 24 * 60 * 60 * 1000
        private const val PAUSE_BETWEEN_CELLS_MS = 1_500L
        private const val ATTEMPTS = 4
        private const val RETRY_DELAY_MS = 15_000L

        fun enqueue(context: Context, areaId: Long) {
            val request = OneTimeWorkRequestBuilder<StreetDownloadWorker>()
                .setInputData(Data.Builder().putLong(KEY_AREA_ID, areaId).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("streets-$areaId", ExistingWorkPolicy.KEEP, request)
        }
    }
}
