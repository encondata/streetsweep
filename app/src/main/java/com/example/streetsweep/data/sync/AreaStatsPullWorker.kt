package com.example.streetsweep.data.sync

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.example.streetsweep.appContainer
import java.util.concurrent.TimeUnit

/**
 * Takes the web's area figures again a little after a push. The server recounts the areas
 * a push touched a few seconds after it, so the figures pulled at the end of the push can
 * still be the ones from before the drive; this picks up the new ones.
 */
class AreaStatsPullWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val sync = applicationContext.appContainer.portalSync
        return try {
            val pending = sync.pullAreaStats()
            // Still being recounted (a big area, or a busy server): look once more, later.
            if (pending && runAttemptCount < MAX_LOOKS) Result.retry() else Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "could not take the web's area figures: ${e.message}")
            if (runAttemptCount < MAX_LOOKS) Result.retry() else Result.success()
        }
    }

    companion object {
        private const val TAG = "AreaStatsPull"
        private const val UNIQUE = "area-stats-pull"
        private const val MAX_LOOKS = 4

        fun enqueue(context: Context, delaySeconds: Long = 30) {
            val request = OneTimeWorkRequestBuilder<AreaStatsPullWorker>()
                .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(androidx.work.BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
