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

/** Pushes coverage to the server after a drive, once there is a network to do it over. */
class PortalPushWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val container = applicationContext.appContainer
        val settings = container.settings.current()
        if (!settings.autoPushEnabled || settings.portalUrl.isNullOrBlank()) return Result.success()
        return try {
            val pushed = container.portalSync.push()
            Log.i(TAG, "pushed $pushed")
            // Areas added or reshaped on the web need their streets, same as by hand.
            pushed.pulled.needStreets.forEach {
                com.example.streetsweep.data.osm.StreetDownloadWorker.enqueue(applicationContext, it)
            }
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "push failed, will retry", e)
            Result.retry()
        }
    }

    companion object {
        private const val TAG = "PortalPush"
        private const val UNIQUE = "portal-push"

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<PortalPushWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
