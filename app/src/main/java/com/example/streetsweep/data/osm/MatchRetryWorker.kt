package com.example.streetsweep.data.osm

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.example.streetsweep.appContainer
import java.util.concurrent.TimeUnit

/**
 * Catches up on drives that could not be matched to streets at the time, usually because the
 * drive finished somewhere without a signal. Runs when the network comes back, and again daily.
 */
class MatchRetryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val container = applicationContext.appContainer
        if (!container.settings.current().snapToRoadsEnabled) return Result.success()
        val pending = container.trackRepository.getUnmatchedSessions()
        if (pending.isEmpty()) return Result.success()

        var failed = false
        for (session in pending) {
            when (val r = container.roadMatcher.matchSession(session.id)) {
                is RoadMatcher.Result.Failed -> {
                    Log.w(TAG, "Session ${session.id} still failing: ${r.message}")
                    failed = true
                }
                else -> Log.i(TAG, "Session ${session.id} caught up: $r")
            }
        }
        return if (failed) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "MatchRetry"
        private const val ONE_SHOT = "match-retry-now"
        private const val PERIODIC = "match-retry-daily"

        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Queued when a drive ends and matching did not finish; fires as soon as there is a network. */
        fun enqueueNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<MatchRetryWorker>().setConstraints(online).build()
            WorkManager.getInstance(context).enqueueUniqueWork(ONE_SHOT, ExistingWorkPolicy.REPLACE, request)
        }

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<MatchRetryWorker>(1, TimeUnit.DAYS)
                .setConstraints(online)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
