package net.streetsweep.data.server

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import net.streetsweep.appContainer
import java.util.concurrent.TimeUnit

/**
 * Runs a sync whenever there's a network: at launch, after every drive, from the Sync
 * button, and every few hours so teammates' coverage reaches the map without a drive.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = applicationContext.appContainer
        if (!container.settings.current().signedIn) return Result.success()
        return try {
            val r = container.sync.sync()
            Log.i(TAG, "synced: $r")
            // A drive just went up: the server matches it in a few seconds, so look again
            // shortly to swap the phone's preview for the real thing.
            if (r.drivesUploaded > 0) enqueueFollowUp(applicationContext)
            Result.success()
        } catch (e: SignedOutException) {
            // The token was revoked (Fleet → Phones on the web): sign in again.
            container.settings.clearServerToken()
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "sync failed: ${e.message}")
            if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()
        }
    }

    companion object {
        private const val TAG = "SyncWorker"
        private const val NOW = "sync"
        private const val PERIODIC = "sync-periodic"
        private const val FOLLOW_UP = "sync-follow-up"
        private const val FOLLOW_UP_SECONDS = 45L
        private const val MAX_ATTEMPTS = 6
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request)
        }

        private fun enqueueFollowUp(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(online)
                .setInitialDelay(FOLLOW_UP_SECONDS, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(FOLLOW_UP, ExistingWorkPolicy.REPLACE, request)
        }

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(6, TimeUnit.HOURS).setConstraints(online).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
