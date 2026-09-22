package com.example.streetsweep.tracking.auto

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.example.streetsweep.appContainer
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.tracking.Notifications
import com.example.streetsweep.tracking.TrackingService
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import kotlinx.coroutines.runBlocking

/** Whether Google's activity recognition currently thinks we are in a vehicle. */
object VehicleState {
    @Volatile
    var inVehicle: Boolean = false
        internal set
}

/**
 * Third automatic trigger, for cars with neither Bluetooth pairing nor Android Auto: Google Play
 * services reports entering and leaving a vehicle. It is slower to react than a Bluetooth
 * connection, by a minute or so, and is meant as a fallback rather than the main trigger.
 */
object VehicleActivityTrigger {
    private const val TAG = "VehicleActivity"

    fun hasPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED

    private fun pendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, VehicleTransitionReceiver::class.java).setAction(VehicleTransitionReceiver.ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    /** Turns the subscription on or off to match the current settings. */
    @SuppressLint("MissingPermission")
    fun sync(context: Context) {
        val settings = runBlocking { context.appContainer.settings.current() }
        val wanted = settings.mode == TrackingMode.AUTOMATIC && settings.inVehicleTriggerEnabled
        val client = ActivityRecognition.getClient(context)
        if (!wanted || !hasPermission(context)) {
            runCatching { client.removeActivityTransitionUpdates(pendingIntent(context)) }
            return
        }
        val request = ActivityTransitionRequest(
            listOf(
                ActivityTransition.Builder()
                    .setActivityType(DetectedActivity.IN_VEHICLE)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                    .build(),
                ActivityTransition.Builder()
                    .setActivityType(DetectedActivity.IN_VEHICLE)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
                    .build(),
            ),
        )
        runCatching { client.requestActivityTransitionUpdates(request, pendingIntent(context)) }
            .onFailure { Log.w(TAG, "Could not subscribe to vehicle transitions", it) }
    }
}

class VehicleTransitionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return
        val result = ActivityTransitionResult.extractResult(intent) ?: return
        val settings = runBlocking { context.appContainer.settings.current() }
        if (settings.mode != TrackingMode.AUTOMATIC || !settings.inVehicleTriggerEnabled) return

        for (event in result.transitionEvents) {
            if (event.activityType != DetectedActivity.IN_VEHICLE) continue
            when (event.transitionType) {
                ActivityTransition.ACTIVITY_TRANSITION_ENTER -> {
                    VehicleState.inVehicle = true
                    if (!TrackingService.start(context, TriggerSource.IN_VEHICLE)) {
                        Notifications.showStartPrompt(context, TriggerSource.IN_VEHICLE)
                    }
                }
                ActivityTransition.ACTIVITY_TRANSITION_EXIT -> {
                    VehicleState.inVehicle = false
                    TrackingService.notifyTriggerDisconnected(context, TriggerSource.IN_VEHICLE)
                }
            }
        }
    }

    companion object {
        const val ACTION = "com.example.streetsweep.action.VEHICLE_TRANSITION"
    }
}
