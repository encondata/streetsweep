package com.example.streetsweep.tracking.auto

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.example.streetsweep.appContainer
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.tracking.Notifications
import com.example.streetsweep.tracking.TrackingService
import com.example.streetsweep.tracking.TrackingStateHolder
import kotlinx.coroutines.delay

/**
 * Android Auto projection comes up a few seconds after the USB or Bluetooth event that hints
 * at it. This worker polls the connection state for a short while after such an event and
 * starts (or prompts to start) recording once the car is connected.
 */
class CarConnectionCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val settings = applicationContext.appContainer.settings.current()
        if (settings.mode != TrackingMode.AUTOMATIC || !settings.androidAutoTriggerEnabled) return Result.success()

        repeat(ATTEMPTS) { attempt ->
            if (TrackingStateHolder.isRecording) return Result.success()
            if (CarConnectionState.isConnected(applicationContext)) {
                Log.d(TAG, "Android Auto connected on attempt $attempt")
                if (!TrackingService.start(applicationContext, TriggerSource.ANDROID_AUTO)) {
                    Notifications.showStartPrompt(applicationContext, TriggerSource.ANDROID_AUTO)
                }
                return Result.success()
            }
            delay(INTERVAL_MS)
        }
        return Result.success()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(Notifications.ID_WORKER, Notifications.worker(applicationContext), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(Notifications.ID_WORKER, Notifications.worker(applicationContext))
        }

    companion object {
        private const val TAG = "CarConnectionCheck"
        private const val UNIQUE_NAME = "car-connection-check"
        private const val ATTEMPTS = 9
        private const val INTERVAL_MS = 5_000L

        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<CarConnectionCheckWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_NAME, ExistingWorkPolicy.KEEP, request)
        }
    }
}
